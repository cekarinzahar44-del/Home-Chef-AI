"""Inventory agent: smart inventory management, stop-lists and redistribution."""
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from .base_agent import BaseAgent, AgentResult
from ..models.inventory import InventoryItem, StockMovement, WriteOff
from ..models.organization import Location


class InventoryAgent(BaseAgent):
    name = "inventory_agent"
    description = "Умная инвентаризация: остатки, стоп-листы, перераспределение между точками"

    def __init__(self, db: AsyncSession):
        super().__init__()
        self.db = db

    async def run(self, context: dict) -> AgentResult:
        action = context.get("action", "check_all")
        location_id = context.get("location_id")
        organization_id = context.get("organization_id")

        if action == "check_all":
            return await self._check_all_inventory(organization_id or location_id, bool(organization_id))
        elif action == "stop_list":
            return await self._generate_stop_list(location_id)
        elif action == "redistribution":
            return await self._suggest_redistribution(organization_id)
        elif action == "forecast":
            return await self._forecast_needs(location_id, context.get("days", 7))
        else:
            return AgentResult(False, None, f"Неизвестное действие: {action}")

    async def _check_all_inventory(self, entity_id: int, is_org: bool) -> AgentResult:
        if is_org:
            loc_result = await self.db.execute(
                select(Location.id).where(Location.organization_id == entity_id, Location.is_active == True)
            )
            location_ids = [r[0] for r in loc_result.all()]
        else:
            location_ids = [entity_id]

        result = await self.db.execute(
            select(InventoryItem).where(
                InventoryItem.location_id.in_(location_ids),
                InventoryItem.is_active == True,
            ).order_by(InventoryItem.location_id, InventoryItem.name)
        )
        items = result.scalars().all()

        low_stock = [i for i in items if i.is_low_stock]
        out_of_stock = [i for i in items if i.current_stock <= 0]

        total_value = sum(float(i.stock_value or 0) for i in items)

        return AgentResult(
            success=True,
            data={
                "items_total": len(items),
                "low_stock_count": len(low_stock),
                "out_of_stock_count": len(out_of_stock),
                "total_value": total_value,
                "low_stock": [self._item_to_dict(i) for i in low_stock],
                "out_of_stock": [self._item_to_dict(i) for i in out_of_stock],
                "all_items": [self._item_to_dict(i) for i in items],
            },
            message=f"Инвентаризация: {len(items)} позиций, {len(low_stock)} с низким остатком, "
                    f"{len(out_of_stock)} отсутствует",
            alerts=[{"severity": "error", "message": f"Нет в наличии: {i.name} (точка {i.location_id})"}
                    for i in out_of_stock],
        )

    async def _generate_stop_list(self, location_id: int) -> AgentResult:
        result = await self.db.execute(
            select(InventoryItem).where(
                InventoryItem.location_id == location_id,
                InventoryItem.is_active == True,
                InventoryItem.current_stock <= 0,
            )
        )
        out_of_stock = result.scalars().all()

        low_result = await self.db.execute(
            select(InventoryItem).where(
                InventoryItem.location_id == location_id,
                InventoryItem.is_active == True,
                InventoryItem.current_stock > 0,
                InventoryItem.current_stock <= InventoryItem.min_stock,
            )
        )
        low_stock = low_result.scalars().all()

        stop_list = [{"id": i.id, "name": i.name, "reason": "out_of_stock"} for i in out_of_stock]
        warning_list = [{"id": i.id, "name": i.name, "remaining": float(i.current_stock),
                         "unit": i.unit, "reason": "low_stock"} for i in low_stock]

        prompt = f"""На основе данных по стоп-листу составь краткую сводку для менеджера:
Позиции отсутствуют ({len(stop_list)}): {[i['name'] for i in stop_list]}
Заканчиваются ({len(warning_list)}): {[f"{i['name']} ({i['remaining']} {i['unit']})" for i in warning_list]}

Дай 2-3 рекомендации что срочно докупить и что временно убрать из меню."""

        ai_recommendation = await self._ask_llm(prompt)

        return AgentResult(
            success=True,
            data={"stop_list": stop_list, "warning_list": warning_list,
                  "ai_recommendation": ai_recommendation},
            message=f"Стоп-лист: {len(stop_list)} позиций отсутствует, {len(warning_list)} заканчивается",
        )

    async def _suggest_redistribution(self, organization_id: int) -> AgentResult:
        loc_result = await self.db.execute(
            select(Location).where(Location.organization_id == organization_id, Location.is_active == True)
        )
        locations = loc_result.scalars().all()
        location_ids = [l.id for l in locations]

        items_result = await self.db.execute(
            select(InventoryItem).where(
                InventoryItem.location_id.in_(location_ids),
                InventoryItem.is_active == True,
            )
        )
        all_items = items_result.scalars().all()

        by_name: dict[str, list] = {}
        for item in all_items:
            by_name.setdefault(item.name, []).append(item)

        suggestions = []
        for name, variants in by_name.items():
            surpluses = [v for v in variants if v.max_stock and v.current_stock > v.max_stock * Decimal("0.8")]
            deficits = [v for v in variants if v.is_low_stock]
            if surpluses and deficits:
                for surplus in surpluses:
                    for deficit in deficits:
                        transfer_qty = min(
                            surplus.current_stock - surplus.max_stock * Decimal("0.5"),
                            deficit.min_stock - deficit.current_stock
                        )
                        if transfer_qty > 0:
                            suggestions.append({
                                "item": name,
                                "from_location_id": surplus.location_id,
                                "to_location_id": deficit.location_id,
                                "quantity": float(transfer_qty),
                                "unit": surplus.unit,
                            })

        return AgentResult(
            success=True,
            data={"suggestions": suggestions},
            message=f"Найдено {len(suggestions)} возможных перераспределений между точками",
        )

    async def _forecast_needs(self, location_id: int, days: int) -> AgentResult:
        date_from = date.today() - timedelta(days=30)
        write_offs_result = await self.db.execute(
            select(
                WriteOff.inventory_item_id,
                func.sum(WriteOff.quantity).label("total_written_off"),
                func.count(WriteOff.id).label("count"),
            ).where(
                WriteOff.location_id == location_id,
                func.date(WriteOff.created_at) >= date_from,
            ).group_by(WriteOff.inventory_item_id)
        )
        consumption_data = {row.inventory_item_id: float(row.total_written_off) / 30
                            for row in write_offs_result.all()}

        items_result = await self.db.execute(
            select(InventoryItem).where(
                InventoryItem.location_id == location_id, InventoryItem.is_active == True
            )
        )
        items = items_result.scalars().all()

        forecast = []
        for item in items:
            daily_consumption = consumption_data.get(item.id, 0)
            days_until_stockout = (float(item.current_stock) / daily_consumption
                                   if daily_consumption > 0 else 999)
            needed = max(0, daily_consumption * days - float(item.current_stock))
            if days_until_stockout < days:
                forecast.append({
                    "item_id": item.id,
                    "name": item.name,
                    "current_stock": float(item.current_stock),
                    "unit": item.unit,
                    "daily_consumption": round(daily_consumption, 3),
                    "days_until_stockout": round(days_until_stockout, 1),
                    "recommended_order": round(needed, 2),
                    "urgency": "critical" if days_until_stockout < 2 else "soon",
                })

        forecast.sort(key=lambda x: x["days_until_stockout"])
        return AgentResult(
            success=True,
            data={"forecast_days": days, "items_to_order": forecast},
            message=f"Прогноз на {days} дней: {len(forecast)} позиций требуют закупки",
        )

    def _item_to_dict(self, item: InventoryItem) -> dict:
        return {
            "id": item.id,
            "location_id": item.location_id,
            "name": item.name,
            "current_stock": float(item.current_stock),
            "min_stock": float(item.min_stock),
            "unit": item.unit,
            "category": item.category,
            "is_low_stock": item.is_low_stock,
            "stock_value": float(item.stock_value) if item.stock_value else None,
        }
