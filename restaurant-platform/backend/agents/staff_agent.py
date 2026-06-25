from datetime import datetime, timedelta
from sqlalchemy import select, func, and_
from agents.base_agent import BaseAgent, AgentResult
from models.staff import StaffMember, Shift, User
from models.organization import Location
import structlog

logger = structlog.get_logger()


class StaffAgent(BaseAgent):
    async def run(self, action: str = "check_shifts", **kwargs) -> AgentResult:
        actions = {
            "check_shifts": self._check_shifts,
            "suggest_redistribution": self._suggest_redistribution,
            "discipline_report": self._discipline_report,
        }
        handler = actions.get(action)
        if not handler:
            return AgentResult(success=False, message=f"Неизвестное действие: {action}")
        return await handler(**kwargs)

    async def _check_shifts(self, **kwargs) -> AgentResult:
        now = datetime.utcnow()
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

        stmt = select(Shift).where(
            and_(Shift.start_time >= today_start, Shift.is_open == True)
        )
        if self.location_id:
            stmt = stmt.where(Shift.location_id == self.location_id)
        result = await self.db.execute(stmt)
        open_shifts = result.scalars().all()

        total_stmt = select(func.count()).select_from(StaffMember).where(StaffMember.is_active == True)
        if self.location_id:
            total_stmt = total_stmt.where(StaffMember.location_id == self.location_id)
        total_staff = (await self.db.execute(total_stmt)).scalar() or 0

        return AgentResult(
            success=True,
            message=f"На смене {len(open_shifts)} сотрудников из {total_staff}",
            data={
                "on_shift": len(open_shifts),
                "total_staff": total_staff,
                "shifts": [
                    {"id": s.id, "staff_id": s.staff_member_id, "start": s.start_time.isoformat()}
                    for s in open_shifts
                ],
            },
        )

    async def _suggest_redistribution(self, **kwargs) -> AgentResult:
        stmt = select(Location)
        result = await self.db.execute(stmt)
        locations = result.scalars().all()

        location_data = []
        for loc in locations:
            shifts_stmt = select(func.count()).select_from(Shift).where(
                and_(Shift.location_id == loc.id, Shift.is_open == True)
            )
            on_shift = (await self.db.execute(shifts_stmt)).scalar() or 0
            location_data.append({"id": loc.id, "name": loc.name, "on_shift": on_shift})

        recommendation = await self._ask_llm(
            "Ты — операционный директор ресторанной сети. Предложи перераспределение персонала.",
            f"Текущая расстановка: {location_data}",
        )

        return AgentResult(
            success=True,
            message="Анализ персонала завершён",
            data={"locations": location_data, "recommendation": recommendation},
        )

    async def _discipline_report(self, period_days: int = 30, **kwargs) -> AgentResult:
        since = datetime.utcnow() - timedelta(days=period_days)

        late_stmt = select(func.count()).select_from(Shift).where(
            and_(
                Shift.start_time >= since,
                Shift.actual_start > Shift.start_time,
            )
        )
        if self.location_id:
            late_stmt = late_stmt.where(Shift.location_id == self.location_id)
        late_count = (await self.db.execute(late_stmt)).scalar() or 0

        return AgentResult(
            success=True,
            message=f"Дисциплинарный отчёт за {period_days} дней",
            data={"period_days": period_days, "late_arrivals": late_count},
        )
