from typing import Optional
from sqlalchemy import select, func
from agents.base_agent import BaseAgent, AgentResult
from models.inventory import InventoryItem, WriteOff
from models.organization import Location
import structlog

logger = structlog.get_logger()


class InventoryAgent(BaseAgent):
    async def run(self, action: str = "check_all", **kwargs) -> AgentResult:
        actions = {
            "check_all": self._check_all,
            "stop_list": self._get_stop_list,
            "redistribution": self._suggest_redistribution,
            "forecast": self._forecast_needs,
        }
        handler = actions.get(action)
        if not handler:
            return AgentResult(success=False, message=f"Неизвестное действие: {action}")
        return await handler(**kwargs)

    async def _check_all(self, **kwargs) -> AgentResult:
        stmt = select(InventoryItem)
        if self.location_id:
            stmt = stmt.where(InventoryItem.location_id == self.location_id)
        result = await self.db.execute(stmt)
        items = result.scalars().all()

        low_stock = [i for i in items if i.current_stock <= i.min_stock_level]
        out_of_stock = [i for i in items if i.current_stock == 0]

        return AgentResult(
            success=True,
            message=f"Проверка завершена: {len(items)} позиций, {len(low_stock)} критических",
            data={
                "total": len(items),
                "low_stock": [
                    {"id": i.id, "name": i.name, "current": i.current_stock, "min": i.min_stock_level, "unit": i.unit}
                    for i in low_stock
                ],
                "out_of_stock": [{"id": i.id, "name": i.name} for i in out_of_stock],
            },
        )

    async def _get_stop_list(self, **kwargs) -> AgentResult:
        stmt = select(InventoryItem).where(InventoryItem.current_stock == 0)
        if self.location_id:
            stmt = stmt.where(InventoryItem.location_id == self.location_id)
        result = await self.db.execute(stmt)
        items = result.scalars().all()

        if not items:
            return AgentResult(success=True, message="Стоп-лист пуст", data={"stop_list": []})

        names = ", ".join(i.name for i in items)
        recommendation = await self._ask_llm(
            "Ты — шеф-повар. Дай краткие рекомендации по замене отсутствующих ингредиентов.",
            f"Отсутствуют: {names}",
        )

        return AgentResult(
            success=True,
            message=f"В стоп-листе {len(items)} позиций",
            data={
                "stop_list": [{"id": i.id, "name": i.name, "category": i.category} for i in items],
                "recommendation": recommendation,
            },
        )

    async def _suggest_redistribution(self, **kwargs) -> AgentResult:
        stmt = select(InventoryItem).where(InventoryItem.current_stock > InventoryItem.min_stock_level * 3)
        result = await self.db.execute(stmt)
        surplus_items = result.scalars().all()

        low_stmt = select(InventoryItem).where(InventoryItem.current_stock <= InventoryItem.min_stock_level)
        low_result = await self.db.execute(low_stmt)
        low_items = low_result.scalars().all()

        data = {
            "surplus": [{"name": i.name, "stock": i.current_stock, "min": i.min_stock_level} for i in surplus_items],
            "deficit": [{"name": i.name, "stock": i.current_stock, "min": i.min_stock_level} for i in low_items],
        }

        if surplus_items and low_items:
            prompt = f"Излишки: {[i.name for i in surplus_items]}. Дефицит: {[i.name for i in low_items]}. Предложи перераспределение."
            recommendation = await self._ask_llm("Ты — менеджер склада ресторана.", prompt)
            data["recommendation"] = recommendation

        return AgentResult(success=True, message="Анализ перераспределения выполнен", data=data)

    async def _forecast_needs(self, days: int = 7, **kwargs) -> AgentResult:
        from models.inventory import StockMovement, MovementType
        from sqlalchemy import and_
        from datetime import datetime, timedelta

        since = datetime.utcnow() - timedelta(days=30)
        stmt = (
            select(StockMovement.item_id, func.sum(StockMovement.quantity).label("total"))
            .where(
                and_(
                    StockMovement.movement_type == MovementType.WRITE_OFF,
                    StockMovement.created_at >= since,
                )
            )
            .group_by(StockMovement.item_id)
        )
        result = await self.db.execute(stmt)
        consumption = {row.item_id: abs(row.total) for row in result}

        forecasts = []
        for item_id, total_consumed in consumption.items():
            daily_avg = total_consumed / 30
            needed = daily_avg * days
            item_res = await self.db.execute(select(InventoryItem).where(InventoryItem.id == item_id))
            item = item_res.scalar_one_or_none()
            if item:
                forecasts.append({
                    "id": item.id,
                    "name": item.name,
                    "daily_avg": round(daily_avg, 2),
                    "forecast_needed": round(needed, 2),
                    "current_stock": item.current_stock,
                    "shortfall": max(0, round(needed - item.current_stock, 2)),
                    "unit": item.unit,
                })

        return AgentResult(
            success=True,
            message=f"Прогноз потребностей на {days} дней",
            data={"days": days, "forecasts": sorted(forecasts, key=lambda x: x["shortfall"], reverse=True)},
        )
