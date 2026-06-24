"""Procurement agent: auto-generates purchase orders based on inventory forecast."""
from datetime import date
from decimal import Decimal
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from .base_agent import BaseAgent, AgentResult
from .inventory_agent import InventoryAgent
from ..models.inventory import PurchaseOrder, PurchaseOrderItem, Supplier, InventoryItem
from ..models.organization import Location


class ProcurementAgent(BaseAgent):
    name = "procurement_agent"
    description = "Автоматическое формирование заказов поставщикам на основе остатков"

    def __init__(self, db: AsyncSession):
        super().__init__()
        self.db = db
        self._inventory_agent = InventoryAgent(db)

    async def run(self, context: dict) -> AgentResult:
        location_id: int = context.get("location_id")
        user_id: int = context.get("user_id")
        days_ahead: int = context.get("days_ahead", 7)
        auto_create: bool = context.get("auto_create", False)

        forecast_result = await self._inventory_agent.run({
            "action": "forecast",
            "location_id": location_id,
            "days": days_ahead,
        })

        if not forecast_result.success:
            return AgentResult(False, None, "Не удалось получить прогноз потребностей")

        items_to_order = forecast_result.data.get("items_to_order", [])
        if not items_to_order:
            return AgentResult(True, {"orders": []}, "Все запасы в норме, закупка не требуется")

        suppliers = await self._get_suppliers(location_id)
        grouped = await self._group_by_supplier(items_to_order, suppliers)

        orders = []
        for supplier_id, order_items in grouped.items():
            total = sum(i.get("total_price", 0) for i in order_items)
            order_data = {
                "supplier_id": supplier_id,
                "items": order_items,
                "total_amount": total,
                "supplier_name": next((s.name for s in suppliers if s.id == supplier_id), "Неизвестен"),
            }
            orders.append(order_data)

            if auto_create and user_id:
                await self._create_purchase_order(location_id, supplier_id, order_items, total, user_id)

        ai_summary = await self._generate_summary(orders, days_ahead)

        return AgentResult(
            success=True,
            data={"orders": orders, "days_ahead": days_ahead, "ai_summary": ai_summary,
                  "auto_created": auto_create},
            message=f"Сформировано {len(orders)} заказов поставщикам на сумму "
                    f"{self._format_currency(sum(o['total_amount'] for o in orders))}",
        )

    async def _get_suppliers(self, location_id: int) -> list[Supplier]:
        loc_result = await self.db.execute(
            select(Location).where(Location.id == location_id)
        )
        loc = loc_result.scalar_one_or_none()
        if not loc:
            return []
        result = await self.db.execute(
            select(Supplier).where(
                Supplier.organization_id == loc.organization_id,
                Supplier.is_active == True,
            )
        )
        return result.scalars().all()

    async def _group_by_supplier(self, items: list, suppliers: list) -> dict:
        default_supplier_id = suppliers[0].id if suppliers else 0
        grouped: dict[int, list] = {}
        for item in items:
            item_with_price = {
                **item,
                "unit_price": 0,
                "total_price": 0,
            }
            grouped.setdefault(default_supplier_id, []).append(item_with_price)
        return grouped

    async def _create_purchase_order(self, location_id: int, supplier_id: int,
                                     items: list, total: Decimal, user_id: int) -> PurchaseOrder:
        order = PurchaseOrder(
            location_id=location_id,
            supplier_id=supplier_id,
            status="pending_approval",
            total_amount=Decimal(str(total)),
            ordered_by=user_id,
        )
        self.db.add(order)
        await self.db.flush()

        for item_data in items:
            inv_result = await self.db.execute(
                select(InventoryItem).where(InventoryItem.id == item_data["item_id"])
            )
            inv_item = inv_result.scalar_one_or_none()
            if inv_item:
                order_item = PurchaseOrderItem(
                    order_id=order.id,
                    inventory_item_id=inv_item.id,
                    quantity=Decimal(str(item_data["recommended_order"])),
                )
                self.db.add(order_item)

        await self.db.commit()
        return order

    async def _generate_summary(self, orders: list, days: int) -> str:
        if not orders:
            return "Закупки не требуются."
        items_list = []
        for order in orders:
            for item in order.get("items", []):
                items_list.append(f"{item['name']}: {item['recommended_order']} {item['unit']}")
        prompt = f"""Составь краткое резюме заказа для менеджера ресторана:
Прогноз на {days} дней. Нужно заказать:
{chr(10).join(items_list[:20])}

Дай 1-2 предложения с приоритетами."""
        return await self._ask_llm(prompt)
