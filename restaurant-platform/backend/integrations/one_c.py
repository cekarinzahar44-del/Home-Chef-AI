import httpx
from typing import Any
from tenacity import retry, stop_after_attempt, wait_exponential
from core.config import settings
import structlog

logger = structlog.get_logger()


class OneCClient:
    def __init__(self):
        self.base_url = settings.ONE_C_URL or ""
        self.auth = (settings.ONE_C_USER or "", settings.ONE_C_PASSWORD or "")

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
    async def _request(self, method: str, resource: str, **kwargs) -> Any:
        async with httpx.AsyncClient(timeout=30, auth=self.auth) as client:
            resp = await client.request(
                method,
                f"{self.base_url}/{resource}",
                headers={"Content-Type": "application/json", "Accept": "application/json"},
                **kwargs,
            )
            resp.raise_for_status()
            return resp.json()

    async def post_write_off(self, item_name: str, quantity: float, unit: str, reason: str) -> dict:
        return await self._request(
            "POST",
            "Document_СписаниеТоваров",
            json={
                "Товар": item_name,
                "Количество": quantity,
                "ЕдиницаИзмерения": unit,
                "Причина": reason,
            },
        )

    async def get_counterparties(self) -> list:
        return await self._request("GET", "Catalog_Контрагенты?$format=json")

    async def get_balance_sheet(self, date: str) -> dict:
        return await self._request("GET", f"AccumulationRegister_ОстаткиТоваров/Balance()?$filter=Period eq datetime'{date}'")
