"""Staff agent: shift control, SKUD cross-check, redistribution between locations."""
from datetime import date, datetime, timedelta
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from .base_agent import BaseAgent, AgentResult
from ..models.staff import StaffMember, Shift, User
from ..models.organization import Location


class StaffAgent(BaseAgent):
    name = "staff_agent"
    description = "Контроль персонала: смены, СКУД, перераспределение между точками"

    def __init__(self, db: AsyncSession):
        super().__init__()
        self.db = db

    async def run(self, context: dict) -> AgentResult:
        action = context.get("action", "check_shifts")
        organization_id = context.get("organization_id")
        location_id = context.get("location_id")
        check_date_str = context.get("date", str(date.today()))
        check_date = date.fromisoformat(check_date_str)

        if action == "check_shifts":
            return await self._check_shifts(organization_id, location_id, check_date)
        elif action == "redistribution":
            return await self._suggest_redistribution(organization_id, check_date)
        elif action == "discipline_report":
            return await self._discipline_report(organization_id, check_date)
        else:
            return AgentResult(False, None, f"Неизвестное действие: {action}")

    async def _check_shifts(self, org_id: int, loc_id: int, check_date: date) -> AgentResult:
        where_clause = [func.date(Shift.planned_start) == check_date]
        if loc_id:
            where_clause.append(Shift.location_id == loc_id)
        elif org_id:
            loc_ids = await self._get_location_ids(org_id)
            where_clause.append(Shift.location_id.in_(loc_ids))

        result = await self.db.execute(select(Shift).where(*where_clause))
        shifts = result.scalars().all()

        late = [s for s in shifts if s.is_late]
        no_show = [s for s in shifts if not s.actual_start and s.status == "planned"]
        on_time = [s for s in shifts if s.actual_start and not s.is_late]

        alerts = []
        if no_show:
            alerts.append({"severity": "error",
                           "message": f"Не вышли на смену: {len(no_show)} сотрудников"})
        if late:
            alerts.append({"severity": "warning",
                           "message": f"Опоздали на смену: {len(late)} сотрудников"})

        return AgentResult(
            success=True,
            data={
                "date": str(check_date),
                "total_shifts": len(shifts),
                "on_time": len(on_time),
                "late": len(late),
                "no_show": len(no_show),
                "late_shifts": [{"shift_id": s.id, "staff_id": s.staff_member_id,
                                  "planned": str(s.planned_start), "actual": str(s.actual_start)}
                                 for s in late],
                "no_show_shifts": [{"shift_id": s.id, "staff_id": s.staff_member_id,
                                     "planned": str(s.planned_start)} for s in no_show],
            },
            message=f"Смены {check_date}: всего {len(shifts)}, вовремя {len(on_time)}, "
                    f"опоздали {len(late)}, не вышли {len(no_show)}",
            alerts=alerts,
        )

    async def _suggest_redistribution(self, org_id: int, work_date: date) -> AgentResult:
        loc_ids = await self._get_location_ids(org_id)

        shift_counts: dict[int, int] = {}
        for loc_id in loc_ids:
            count_result = await self.db.execute(
                select(func.count(Shift.id)).where(
                    Shift.location_id == loc_id,
                    func.date(Shift.planned_start) == work_date,
                )
            )
            shift_counts[loc_id] = count_result.scalar() or 0

        locations_result = await self.db.execute(
            select(Location).where(Location.id.in_(loc_ids))
        )
        locations = {l.id: l for l in locations_result.scalars().all()}

        suggestions = []
        avg = sum(shift_counts.values()) / len(shift_counts) if shift_counts else 0
        overstaffed = [(lid, cnt) for lid, cnt in shift_counts.items() if cnt > avg * 1.3]
        understaffed = [(lid, cnt) for lid, cnt in shift_counts.items() if cnt < avg * 0.7]

        for (over_id, over_cnt), (under_id, under_cnt) in zip(overstaffed, understaffed):
            transfer = (over_cnt - under_cnt) // 2
            if transfer > 0:
                suggestions.append({
                    "from_location": locations[over_id].name,
                    "from_location_id": over_id,
                    "to_location": locations[under_id].name,
                    "to_location_id": under_id,
                    "staff_count": transfer,
                    "date": str(work_date),
                })

        return AgentResult(
            success=True,
            data={"suggestions": suggestions, "shift_counts": shift_counts},
            message=f"Рекомендовано {len(suggestions)} перераспределений персонала на {work_date}",
        )

    async def _discipline_report(self, org_id: int, report_date: date) -> AgentResult:
        date_from = report_date - timedelta(days=30)
        loc_ids = await self._get_location_ids(org_id)

        result = await self.db.execute(
            select(
                Shift.staff_member_id,
                func.count(Shift.id).label("total"),
                func.sum(
                    func.case((Shift.actual_start.is_(None), 1), else_=0)
                ).label("no_shows"),
            ).where(
                Shift.location_id.in_(loc_ids),
                func.date(Shift.planned_start).between(date_from, report_date),
            ).group_by(Shift.staff_member_id)
        )
        rows = result.all()

        problem_staff = [
            {"staff_id": r.staff_member_id, "total_shifts": r.total,
             "no_shows": int(r.no_shows or 0),
             "no_show_rate": round(float(r.no_shows or 0) / r.total * 100, 1)}
            for r in rows
            if (r.no_shows or 0) / r.total > 0.2
        ]

        prompt = f"""Составь краткий отчёт по дисциплине персонала за 30 дней:
Всего сотрудников: {len(rows)}
Проблемные сотрудники (невыход >20%): {len(problem_staff)}
Самые частые нарушители: {problem_staff[:5]}

Дай 2-3 рекомендации по улучшению дисциплины."""
        ai_commentary = await self._ask_llm(prompt)

        return AgentResult(
            success=True,
            data={"period": f"{date_from} — {report_date}", "total_staff": len(rows),
                  "problem_staff": problem_staff, "ai_commentary": ai_commentary},
            message=f"Отчёт дисциплины: {len(problem_staff)} из {len(rows)} сотрудников с нарушениями",
        )

    async def _get_location_ids(self, org_id: int) -> list[int]:
        result = await self.db.execute(
            select(Location.id).where(Location.organization_id == org_id, Location.is_active == True)
        )
        return [r[0] for r in result.all()]
