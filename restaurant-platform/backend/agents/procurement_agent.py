from datetime import datetime
from sqlalchemy import select
from agents.base_agent import BaseAgent, AgentResult
from agents.inventory_agent import InventoryAgent
from models.inventory import InventoryItem, PurchaseOrder, PurchaseOrderItem, Supplier
from models.organization import Location
import structlog

logger = structlog.get_logger()


class ProcurementAgent(BaseAgent):
    async def run(self, days_forecast: int = 7, auto_create: bool = False, **kwargs) -> AgentResult:
        inv_agent = InventoryAgent(self.db, self.location_id)
        forecast_result = await inv_agent.run(action="forecast", days=days_forecast)

        if not forecast_result.success:
            return AgentResult(success=False, message="Не удалось получить прогноз", errors=forecast_result.errors)

        forecasts = forecast_result.data.get("forecasts", [])
        items_to_order = [f for f in forecasts if f["shortfall"] > 0]

        if not items_to_order:
            return AgentResult(
                success=True,
                message="Запасов достаточно, закупки не требуются",
                data={"orders": [], "forecasts": forecasts},
            )

        by_supplier: dict[int, list] = {}
        for forecast in items_to_order:
            item_res = await self.db.execute(
                select(InventoryItem).where(InventoryItem.id == forecast["id"])
            )
            item = item_res.scalar_one_or_none()
            if item and item.supplier_id:
                by_supplier.setdefault(item.supplier_id, []).append((item, forecast["shortfall"]))

        orders_created = []
        for supplier_id, items in by_supplier.items():
            supplier_res = await self.db.execute(select(Supplier).where(Supplier.id == supplier_id))
            supplier = supplier_res.scalar_one_or_none()

            total_amount = sum(item.cost_price * qty for item, qty in items)

            if auto_create:
                po = PurchaseOrder(
                    location_id=self.location_id,
                    supplier_id=supplier_id,
                    total_amount=total_amount,
                    expected_delivery=datetime.utcnow(),
                )
                self.db.add(po)
                await self.db.flush()

                for item, qty in items:
                    poi = PurchaseOrderItem(
                        order_id=po.id,
                        item_id=item.id,
                        quantity=qty,
                        unit_price=item.cost_price,
                    )
                    self.db.add(poi)

                await self.db.commit()
                orders_created.append({"supplier": supplier.name if supplier else str(supplier_id), "total": total_amount, "order_id": po.id})
            else:
                orders_created.append({
                    "supplier": supplier.name if supplier else str(supplier_id),
                    "total": total_amount,
                    "items": [{"name": item.name, "qty": qty, "unit": item.unit} for item, qty in items],
                })

        recommendation = await self._ask_llm(
            "Ты — менеджер по закупкам ресторана. Дай краткие рекомендации по заказу.",
            f"Нужно закупить: {[f['name'] + ' ' + str(f['shortfall']) + ' ' + f['unit'] for f in items_to_order]}",
        )

        return AgentResult(
            success=True,
            message=f"Сформировано {len(orders_created)} заявок поставщикам",
            data={
                "orders": orders_created,
                "items_to_order": items_to_order,
                "recommendation": recommendation,
                "auto_created": auto_create,
            },
        )
