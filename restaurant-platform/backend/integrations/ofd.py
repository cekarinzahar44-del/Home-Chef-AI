import httpx
from typing import Any
from datetime import datetime
from tenacity import retry, stop_after_attempt, wait_exponential
from core.config import settings
import structlog

logger = structlog.get_logger()


class OFDClient:
    def __init__(self):
        self.base_url = settings.OFD_API_URL or ""
        self.api_key = settings.OFD_API_KEY or ""
        self.inn = settings.OFD_INN or ""

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
    async def _request(self, method: str, endpoint: str, **kwargs) -> Any:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.request(
                method,
                f"{self.base_url}/{endpoint}",
                headers={"X-Token": self.api_key, "Content-Type": "application/json"},
                **kwargs,
            )
            resp.raise_for_status()
            return resp.json()

    async def get_revenue(self, date_from: datetime, date_to: datetime) -> dict:
        return await self._request(
            "GET",
            f"kkt/receipts",
            params={
                "inn": self.inn,
                "dateFrom": date_from.strftime("%Y-%m-%dT%H:%M:%S"),
                "dateTo": date_to.strftime("%Y-%m-%dT%H:%M:%S"),
            },
        )

    async def get_receipts(self, date: str) -> list:
        return await self._request("GET", "kkt/receipts", params={"inn": self.inn, "date": date})
