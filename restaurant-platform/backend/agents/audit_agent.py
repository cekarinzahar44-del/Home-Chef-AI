from datetime import datetime, timedelta
from sqlalchemy import select, func, and_
from agents.base_agent import BaseAgent, AgentResult
from models.revenue import RevenueRecord
from models.inventory import WriteOff, InventoryItem
from models.organization import Location
from integrations.ofd import OFDClient
from integrations.bank import BankClient
from integrations.egais import EGAISClient
import structlog

logger = structlog.get_logger()


class AuditAgent(BaseAgent):
    async def run(self, period_days: int = 30, location_id: int = None, **kwargs) -> AgentResult:
        loc_id = location_id or self.location_id
        since = datetime.utcnow() - timedelta(days=period_days)

        rev_stmt = select(func.sum(RevenueRecord.amount)).where(
            and_(RevenueRecord.date >= since)
        )
        if loc_id:
            rev_stmt = rev_stmt.where(RevenueRecord.location_id == loc_id)
        db_revenue = float((await self.db.execute(rev_stmt)).scalar() or 0)

        ofd_revenue = 0.0
        ofd_status = "skipped"
        try:
            ofd = OFDClient()
            ofd_data = await ofd.get_revenue(since, datetime.utcnow())
            ofd_revenue = ofd_data.get("total", 0.0)
            ofd_status = "ok"
        except Exception as e:
            ofd_status = f"error: {e}"

        revenue_discrepancy = abs(db_revenue - ofd_revenue)
        revenue_ok = revenue_discrepancy < db_revenue * 0.02

        wo_stmt = (
            select(func.count(), func.sum(WriteOff.quantity * InventoryItem.cost_price))
            .join(InventoryItem, WriteOff.item_id == InventoryItem.id)
            .where(WriteOff.created_at >= since)
        )
        if loc_id:
            wo_stmt = wo_stmt.where(WriteOff.location_id == loc_id)
        wo_result = await self.db.execute(wo_stmt)
        wo_count, wo_value = wo_result.one()
        wo_value = float(wo_value or 0)

        egais_balance = {}
        egais_status = "skipped"
        try:
            egais = EGAISClient()
            egais_balance = await egais.get_balance()
            egais_status = "ok"
        except Exception as e:
            egais_status = f"error: {e}"

        risk_score = 0
        findings = []

        if not revenue_ok:
            risk_score += 40
            findings.append(f"Расхождение выручки: БД={db_revenue:.0f}, ОФД={ofd_revenue:.0f}")

        if db_revenue > 0 and wo_value / db_revenue > 0.15:
            risk_score += 30
            findings.append(f"Высокий % списаний: {wo_value/db_revenue*100:.1f}% от выручки")

        if wo_count > 100:
            risk_score += 20
            findings.append(f"Аномально высокое число списаний: {wo_count}")

        if findings:
            audit_analysis = await self._ask_llm(
                "Ты — аудитор ресторанного бизнеса. Сделай краткое заключение по нарушениям.",
                f"Нарушения за {period_days} дней: {'; '.join(findings)}",
            )
        else:
            audit_analysis = "Нарушений не выявлено. Показатели в допустимых пределах."

        return AgentResult(
            success=True,
            message=f"Аудит за {period_days} дней завершён",
            data={
                "period_days": period_days,
                "db_revenue": db_revenue,
                "ofd_revenue": ofd_revenue,
                "ofd_status": ofd_status,
                "revenue_discrepancy": revenue_discrepancy,
                "revenue_ok": revenue_ok,
                "write_offs_count": wo_count,
                "write_offs_value": wo_value,
                "egais_balance": egais_balance,
                "egais_status": egais_status,
                "risk_score": min(risk_score, 100),
                "findings": findings,
                "analysis": audit_analysis,
            },
        )
