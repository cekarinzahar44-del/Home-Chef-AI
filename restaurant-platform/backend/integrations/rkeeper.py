import httpx
from typing import Optional, Any
from tenacity import retry, stop_after_attempt, wait_exponential
from core.config import settings
import structlog

logger = structlog.get_logger()


class RKeeperClient:
    def __init__(self):
        self.base_url = settings.RKEEPER_API_URL or ""
        self.api_key = settings.RKEEPER_API_KEY or ""
        self.headers = {"X-API-Key": self.api_key, "Content-Type": "application/json"}

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
    async def _request(self, method: str, endpoint: str, **kwargs) -> Any:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.request(method, f"{self.base_url}/{endpoint}", headers=self.headers, **kwargs)
            resp.raise_for_status()
            return resp.json()

    async def write_off(self, item_id: str, quantity: float, reason: str) -> dict:
        return await self._request("POST", "write-off", json={"itemId": item_id, "quantity": quantity, "reason": reason})

    async def get_menu(self) -> list:
        return await self._request("GET", "menu")

    async def get_sales(self, date_from: str, date_to: str) -> list:
        return await self._request("GET", "sales", params={"from": date_from, "to": date_to})

    async def update_stop_list(self, item_ids: list[str], active: bool) -> dict:
        return await self._request("POST", "stop-list", json={"items": item_ids, "active": active})
