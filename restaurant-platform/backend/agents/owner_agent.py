from datetime import datetime, timedelta
from sqlalchemy import select, func, and_
from agents.base_agent import BaseAgent, AgentResult
from models.revenue import RevenueRecord, Alert, AlertSeverity
from models.inventory import InventoryItem, WriteOff
from models.staff import StaffMember, Shift
from models.organization import Location
import structlog

logger = structlog.get_logger()


class OwnerAgent(BaseAgent):
    async def run(self, period_days: int = 7, **kwargs) -> AgentResult:
        since = datetime.utcnow() - timedelta(days=period_days)

        revenue_stmt = select(func.sum(RevenueRecord.amount)).where(RevenueRecord.date >= since)
        revenue_result = await self.db.execute(revenue_stmt)
        total_revenue = float(revenue_result.scalar() or 0)

        write_off_stmt = select(
            func.sum(WriteOff.quantity * InventoryItem.cost_price)
        ).join(InventoryItem, WriteOff.item_id == InventoryItem.id).where(WriteOff.created_at >= since)
        wo_result = await self.db.execute(write_off_stmt)
        total_write_offs = float(wo_result.scalar() or 0)

        food_cost_pct = (total_write_offs / total_revenue * 100) if total_revenue > 0 else 0

        low_stock_stmt = select(func.count()).select_from(InventoryItem).where(
            InventoryItem.current_stock <= InventoryItem.min_stock_level
        )
        low_stock_count = (await self.db.execute(low_stock_stmt)).scalar() or 0

        shifts_stmt = select(func.count()).select_from(Shift).where(
            and_(Shift.start_time >= since, Shift.is_open == True)
        )
        open_shifts = (await self.db.execute(shifts_stmt)).scalar() or 0

        risks = []
        if food_cost_pct > 35:
            risks.append({"type": "high_food_cost", "value": food_cost_pct, "threshold": 35})
        if total_write_offs > total_revenue * 0.1:
            risks.append({"type": "high_write_offs", "value": total_write_offs, "revenue": total_revenue})
        if low_stock_count > 5:
            risks.append({"type": "low_stock", "count": low_stock_count})

        if risks:
            risk_text = str(risks)
            analysis = await self._ask_llm(
                "Ты — финансовый директор сети ресторанов. Дай краткий анализ рисков и рекомендации.",
                f"Риски за последние {period_days} дней: {risk_text}. Выручка: {total_revenue} руб.",
            )
        else:
            analysis = "Показатели в норме. Особых рисков не выявлено."

        return AgentResult(
            success=True,
            message=f"Дашборд владельца за {period_days} дней",
            data={
                "period_days": period_days,
                "total_revenue": total_revenue,
                "total_write_offs": total_write_offs,
                "food_cost_pct": round(food_cost_pct, 2),
                "low_stock_count": low_stock_count,
                "open_shifts": open_shifts,
                "risks": risks,
                "analysis": analysis,
            },
        )
