"""KRO (Audit) agent: automated cross-checks across all financial and operational systems."""
from datetime import date, timedelta
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from .base_agent import BaseAgent, AgentResult
from ..models.revenue import RevenueRecord, Alert
from ..models.inventory import WriteOff
from ..models.staff import Shift
from ..models.organization import Location
from ..integrations.ofd import OFDClient
from ..integrations.bank import BankClient
from ..integrations.egais import EGAISClient


class AuditAgent(BaseAgent):
    name = "audit_agent"
    description = "КРО: автоматические проверки касса vs ОФД, ЕГАИС, подозрительные операции"

    def __init__(self, db: AsyncSession):
        super().__init__()
        self.db = db

    async def run(self, context: dict) -> AgentResult:
        organization_id: int = context.get("organization_id")
        check_date_str: str = context.get("date", str(date.today() - timedelta(days=1)))
        check_date = date.fromisoformat(check_date_str)
        checks = context.get("checks", ["revenue", "write_offs", "staff", "egais"])

        results = {}
        all_alerts = []

        if "revenue" in checks:
            revenue_check = await self._check_revenue_vs_ofd(organization_id, check_date)
            results["revenue_check"] = revenue_check
            all_alerts.extend(revenue_check.get("alerts", []))

        if "write_offs" in checks:
            wo_check = await self._check_write_offs(organization_id, check_date)
            results["write_offs_check"] = wo_check
            all_alerts.extend(wo_check.get("alerts", []))

        if "staff" in checks:
            staff_check = await self._check_staff_discipline(organization_id, check_date)
            results["staff_check"] = staff_check
            all_alerts.extend(staff_check.get("alerts", []))

        if "egais" in checks:
            egais_check = await self._check_egais_balance()
            results["egais_check"] = egais_check
            all_alerts.extend(egais_check.get("alerts", []))

        risk_score = self._calculate_risk_score(all_alerts)

        for alert_data in all_alerts:
            if alert_data.get("severity") in ("error", "warning"):
                alert = Alert(
                    organization_id=organization_id,
                    agent_name=self.name,
                    severity=alert_data["severity"],
                    title=alert_data.get("title", "Аудит"),
                    message=alert_data["message"],
                    data=alert_data.get("data"),
                )
                self.db.add(alert)
        await self.db.commit()

        return AgentResult(
            success=True,
            data={
                "date": check_date_str,
                "risk_score": risk_score,
                "checks": results,
                "total_alerts": len(all_alerts),
            },
            message=f"Аудит за {check_date_str}: риск-рейтинг {risk_score}/100, "
                    f"{len(all_alerts)} нарушений",
            alerts=all_alerts,
        )

    async def _check_revenue_vs_ofd(self, org_id: int, check_date: date) -> dict:
        loc_result = await self.db.execute(
            select(Location).where(Location.organization_id == org_id, Location.is_active == True)
        )
        locations = loc_result.scalars().all()

        alerts = []
        discrepancies = []

        for loc in locations:
            rev_result = await self.db.execute(
                select(RevenueRecord).where(
                    RevenueRecord.location_id == loc.id,
                    RevenueRecord.date == check_date,
                )
            )
            rev_record = rev_result.scalar_one_or_none()
            if not rev_record:
                continue

            try:
                async with OFDClient() as ofd:
                    ofd_data = await ofd.get_revenue_summary(
                        str(check_date), str(check_date)
                    )
                pos_revenue = float(rev_record.revenue_gross)
                ofd_revenue = ofd_data.get("net_revenue", 0)
                diff = abs(pos_revenue - ofd_revenue)
                diff_pct = (diff / pos_revenue * 100) if pos_revenue > 0 else 0

                if diff_pct > 1.0:
                    severity = "error" if diff_pct > 5 else "warning"
                    discrepancy = {
                        "location": loc.name,
                        "pos_revenue": pos_revenue,
                        "ofd_revenue": ofd_revenue,
                        "difference": diff,
                        "difference_pct": round(diff_pct, 2),
                    }
                    discrepancies.append(discrepancy)
                    alerts.append({
                        "severity": severity,
                        "title": f"Расхождение выручки: {loc.name}",
                        "message": f"POS: {self._format_currency(pos_revenue)}, "
                                   f"ОФД: {self._format_currency(ofd_revenue)}, "
                                   f"расхождение {diff_pct:.1f}%",
                        "data": discrepancy,
                    })
            except Exception as e:
                self.logger.warning("ofd_check_failed", location=loc.name, error=str(e))

        return {"discrepancies": discrepancies, "alerts": alerts}

    async def _check_write_offs(self, org_id: int, check_date: date) -> dict:
        loc_result = await self.db.execute(
            select(Location.id).where(Location.organization_id == org_id)
        )
        location_ids = [r[0] for r in loc_result.all()]

        result = await self.db.execute(
            select(
                WriteOff.location_id,
                func.count(WriteOff.id).label("count"),
                func.sum(WriteOff.cost_total).label("total"),
                func.avg(WriteOff.cost_total).label("avg"),
            ).where(
                WriteOff.location_id.in_(location_ids),
                func.date(WriteOff.created_at) == check_date,
            ).group_by(WriteOff.location_id)
        )
        rows = result.all()

        alerts = []
        for row in rows:
            if row.total and float(row.total) > 30000:
                alerts.append({
                    "severity": "warning",
                    "title": "Аномально высокие списания",
                    "message": f"Точка {row.location_id}: списания за день {self._format_currency(float(row.total))} "
                               f"({row.count} операций)",
                    "data": {"location_id": row.location_id, "total": float(row.total), "count": row.count},
                })

        return {
            "by_location": [{"location_id": r.location_id, "count": r.count,
                              "total": float(r.total or 0)} for r in rows],
            "alerts": alerts,
        }

    async def _check_staff_discipline(self, org_id: int, check_date: date) -> dict:
        loc_result = await self.db.execute(
            select(Location.id).where(Location.organization_id == org_id)
        )
        location_ids = [r[0] for r in loc_result.all()]

        result = await self.db.execute(
            select(Shift).where(
                Shift.location_id.in_(location_ids),
                func.date(Shift.planned_start) == check_date,
            )
        )
        shifts = result.scalars().all()

        late_shifts = [s for s in shifts if s.is_late]
        no_show = [s for s in shifts if s.actual_start is None and s.status == "planned"]

        alerts = []
        if len(no_show) > 0:
            alerts.append({
                "severity": "error",
                "title": "Невыходы на смену",
                "message": f"{len(no_show)} сотрудников не вышли на смену {check_date}",
                "data": {"shift_ids": [s.id for s in no_show]},
            })
        if len(late_shifts) > 2:
            alerts.append({
                "severity": "warning",
                "title": "Опоздания на смену",
                "message": f"{len(late_shifts)} опозданий за {check_date}",
            })

        return {
            "total_shifts": len(shifts),
            "late": len(late_shifts),
            "no_show": len(no_show),
            "alerts": alerts,
        }

    async def _check_egais_balance(self) -> dict:
        try:
            async with EGAISClient() as egais:
                balance = await egais.get_balance()
                alerts = []
                zero_balance = [i for i in balance if i.get("quantity", 0) <= 0]
                if zero_balance:
                    alerts.append({
                        "severity": "warning",
                        "title": "ЕГАИС: нулевые остатки",
                        "message": f"{len(zero_balance)} позиций с нулевым остатком в ЕГАИС",
                    })
                return {"balance_items": len(balance), "zero_balance": len(zero_balance), "alerts": alerts}
        except Exception as e:
            self.logger.warning("egais_check_failed", error=str(e))
            return {"error": str(e), "alerts": []}

    def _calculate_risk_score(self, alerts: list) -> int:
        score = 0
        for alert in alerts:
            if alert.get("severity") == "error":
                score += 15
            elif alert.get("severity") == "warning":
                score += 7
        return min(score, 100)
