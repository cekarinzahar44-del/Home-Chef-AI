"""Write-off agent: parses natural language write-off commands and syncs to POS systems."""
import json
import re
from decimal import Decimal
from typing import Optional
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from .base_agent import BaseAgent, AgentResult
from ..models.inventory import InventoryItem, WriteOff, StockMovement, WriteOffReason
from ..models.organization import Location, PosSystem
from ..integrations.rkeeper import RKeeperClient
from ..integrations.iiko import IikoClient

SYSTEM_PROMPT = """Ты — ассистент для ресторанного учёта. Твоя задача — разбирать команды списания товаров.

Из текста извлеки:
- item_name: название товара (строка)
- quantity: количество (число)
- unit: единица измерения (кг, г, л, мл, шт, порц) — если не указана, выведи из контекста
- reason: причина списания (spoilage/overproduction/breakage/theft/expiry/employee_meal/tasting/other)

Отвечай ТОЛЬКО валидным JSON без пояснений:
{"item_name": "...", "quantity": 1.5, "unit": "кг", "reason": "spoilage"}

Примеры:
- "списать 2 кг помидоров" → {"item_name": "помидоры", "quantity": 2, "unit": "кг", "reason": "spoilage"}
- "1 яблоко испортилось" → {"item_name": "яблоко", "quantity": 1, "unit": "шт", "reason": "spoilage"}
- "разбили бутылку вина" → {"item_name": "вино", "quantity": 1, "unit": "шт", "reason": "breakage"}
- "питание сотрудника 300г говядины" → {"item_name": "говядина", "quantity": 300, "unit": "г", "reason": "employee_meal"}
"""


class WriteOffAgent(BaseAgent):
    name = "write_off_agent"
    description = "Принимает текстовые команды списания и синхронизирует с POS-системой"

    def __init__(self, db: AsyncSession):
        super().__init__()
        self.db = db

    async def run(self, context: dict) -> AgentResult:
        raw_input: str = context.get("text", "")
        location_id: int = context.get("location_id")
        user_id: int = context.get("user_id")

        if not raw_input or not location_id:
            return AgentResult(False, None, "Не указан текст или локация")

        parsed = await self._parse_write_off(raw_input)
        if not parsed:
            return AgentResult(False, None, f"Не удалось распознать команду списания: '{raw_input}'")

        inventory_item = await self._find_inventory_item(location_id, parsed["item_name"])
        if not inventory_item:
            return AgentResult(False, None,
                               f"Товар '{parsed['item_name']}' не найден в системе для данной точки")

        quantity = Decimal(str(parsed["quantity"]))
        if inventory_item.current_stock < quantity:
            return AgentResult(False, None,
                               f"Недостаточно остатков: на складе {inventory_item.current_stock} {inventory_item.unit}, "
                               f"пытаетесь списать {quantity}")

        write_off = WriteOff(
            location_id=location_id,
            inventory_item_id=inventory_item.id,
            quantity=quantity,
            unit=parsed.get("unit", inventory_item.unit),
            reason=WriteOffReason(parsed.get("reason", "spoilage")),
            written_off_by=user_id,
            raw_input=raw_input,
            ai_parsed=parsed,
            cost_total=quantity * inventory_item.cost_per_unit if inventory_item.cost_per_unit else None,
        )
        self.db.add(write_off)

        before = inventory_item.current_stock
        inventory_item.current_stock -= quantity
        movement = StockMovement(
            location_id=location_id,
            inventory_item_id=inventory_item.id,
            movement_type="write_off",
            quantity_change=-quantity,
            quantity_before=before,
            quantity_after=inventory_item.current_stock,
            user_id=user_id,
        )
        self.db.add(movement)
        await self.db.flush()

        sync_result = await self._sync_to_pos(location_id, inventory_item, quantity, parsed)
        write_off.pos_synced = sync_result.get("synced", False)
        write_off.pos_sync_id = sync_result.get("sync_id")

        await self.db.commit()

        alerts = []
        if inventory_item.is_low_stock:
            alerts.append({
                "severity": "warning",
                "message": f"Низкий остаток: {inventory_item.name} — {inventory_item.current_stock} {inventory_item.unit}"
            })

        return AgentResult(
            success=True,
            data={
                "write_off_id": write_off.id,
                "item": inventory_item.name,
                "quantity": float(quantity),
                "unit": write_off.unit,
                "remaining_stock": float(inventory_item.current_stock),
                "pos_synced": write_off.pos_synced,
                "cost_total": float(write_off.cost_total) if write_off.cost_total else None,
            },
            message=f"Списано: {quantity} {write_off.unit} {inventory_item.name}. "
                    f"Остаток: {inventory_item.current_stock} {inventory_item.unit}",
            alerts=alerts,
        )

    async def _parse_write_off(self, text: str) -> Optional[dict]:
        response = await self._ask_llm(text, system=SYSTEM_PROMPT)
        try:
            json_match = re.search(r'\{.*\}', response, re.DOTALL)
            if json_match:
                return json.loads(json_match.group())
        except (json.JSONDecodeError, AttributeError):
            pass
        return None

    async def _find_inventory_item(self, location_id: int, item_name: str) -> Optional[InventoryItem]:
        result = await self.db.execute(
            select(InventoryItem).where(
                InventoryItem.location_id == location_id,
                InventoryItem.is_active == True,
                InventoryItem.name.ilike(f"%{item_name}%"),
            ).limit(1)
        )
        return result.scalar_one_or_none()

    async def _sync_to_pos(self, location_id: int, item: InventoryItem, quantity: Decimal, parsed: dict) -> dict:
        location_result = await self.db.execute(select(Location).where(Location.id == location_id))
        location = location_result.scalar_one_or_none()
        if not location or not item.pos_item_id:
            return {"synced": False, "reason": "no_pos_config"}

        try:
            if location.pos_system in (PosSystem.rkeeper, PosSystem.both):
                async with RKeeperClient() as rk:
                    result = await rk.write_off(
                        location.pos_location_id, item.pos_item_id,
                        float(quantity), parsed.get("reason", "")
                    )
                    return {"synced": True, "sync_id": str(result.get("id", ""))}
            elif location.pos_system == PosSystem.iiko:
                async with IikoClient() as iiko:
                    result = await iiko.write_off(
                        location.pos_location_id, "", item.pos_item_id,
                        float(quantity), parsed.get("reason", "")
                    )
                    return {"synced": True, "sync_id": str(result.get("correlationId", ""))}
        except Exception as e:
            self.logger.warning("pos_sync_failed", error=str(e))
            return {"synced": False, "reason": str(e)}

        return {"synced": False, "reason": "unknown_pos"}
