import json
from typing import Optional
from sqlalchemy import select
from agents.base_agent import BaseAgent, AgentResult
from models.inventory import InventoryItem, WriteOff, WriteOffReason, StockMovement, MovementType
from models.organization import Location
from integrations.rkeeper import RKeeperClient
from integrations.iiko import IikoClient
from integrations.one_c import OneCClient
import structlog

logger = structlog.get_logger()

SYSTEM_PROMPT = """
Ты — ИИ-агент для списания продуктов на ресторане.
Из текста на русском языке извлеки:
- item_name: название продукта
- quantity: количество (число)
- unit: единица измерения (кг, г, шт, л, мл и т.д.)
- reason: причина списания (порча/истечение_срока/производство/другое)

Отвечай ТОЛЬКО валидным JSON без markdown:
{"item_name": "...", "quantity": 0.0, "unit": "...", "reason": "..."}
"""


class WriteOffAgent(BaseAgent):
    async def run(self, raw_text: str, user_id: int, **kwargs) -> AgentResult:
        try:
            parsed_json = await self._ask_llm(SYSTEM_PROMPT, raw_text)
            parsed = json.loads(parsed_json)
        except Exception as e:
            return AgentResult(success=False, message="Не удалось распознать команду", errors=[str(e)])

        item_name = parsed.get("item_name", "")
        quantity = float(parsed.get("quantity", 0))
        unit = parsed.get("unit", "шт")
        reason_str = parsed.get("reason", "другое")

        reason_map = {
            "порча": WriteOffReason.SPOILAGE,
            "истечение_срока": WriteOffReason.EXPIRATION,
            "производство": WriteOffReason.PRODUCTION,
            "другое": WriteOffReason.OTHER,
        }
        reason = reason_map.get(reason_str, WriteOffReason.OTHER)

        stmt = select(InventoryItem).where(
            InventoryItem.name.ilike(f"%{item_name}%")
        )
        if self.location_id:
            stmt = stmt.where(InventoryItem.location_id == self.location_id)
        result = await self.db.execute(stmt)
        item = result.scalar_one_or_none()

        if not item:
            return AgentResult(
                success=False,
                message=f"Продукт '{item_name}' не найден на складе",
                errors=["item_not_found"],
            )

        if item.current_stock < quantity:
            return AgentResult(
                success=False,
                message=f"Недостаточно остатка: есть {item.current_stock} {item.unit}, запрошено {quantity}",
                errors=["insufficient_stock"],
            )

        item.current_stock -= quantity

        write_off = WriteOff(
            location_id=self.location_id,
            item_id=item.id,
            quantity=quantity,
            unit=unit,
            reason=reason,
            raw_input=raw_text,
            ai_parsed={"item_name": item_name, "quantity": quantity, "unit": unit, "reason": reason_str},
            created_by=user_id,
        )
        self.db.add(write_off)

        movement = StockMovement(
            item_id=item.id,
            location_id=self.location_id,
            movement_type=MovementType.WRITE_OFF,
            quantity=-quantity,
            reference_id=None,
            created_by=user_id,
        )
        self.db.add(movement)
        await self.db.flush()

        sync_results = await self._sync_to_pos(item, quantity, reason_str)

        await self.db.commit()

        return AgentResult(
            success=True,
            message=f"Списано {quantity} {unit} '{item.name}'",
            data={
                "item_id": item.id,
                "item_name": item.name,
                "quantity": quantity,
                "unit": unit,
                "reason": reason_str,
                "new_stock": item.current_stock,
                "write_off_id": write_off.id,
                "sync": sync_results,
            },
        )

    async def _sync_to_pos(self, item, quantity: float, reason: str) -> dict:
        results = {}
        if self.location_id is None:
            return results

        stmt = select(Location).where(Location.id == self.location_id)
        res = await self.db.execute(stmt)
        location = res.scalar_one_or_none()
        if not location:
            return results

        try:
            rkeeper = RKeeperClient()
            await rkeeper.write_off(item.external_id, quantity, reason)
            results["rkeeper"] = "synced"
        except Exception as e:
            results["rkeeper"] = f"error: {e}"

        try:
            iiko = IikoClient()
            await iiko.write_off(item.external_id, quantity, reason)
            results["iiko"] = "synced"
        except Exception as e:
            results["iiko"] = f"error: {e}"

        try:
            one_c = OneCClient()
            await one_c.post_write_off(item.name, quantity, item.unit, reason)
            results["1c"] = "synced"
        except Exception as e:
            results["1c"] = f"error: {e}"

        return results
