"""OFD (Оператор Фискальных Данных) API integration."""
import httpx
from typing import Optional
from tenacity import retry, stop_after_attempt, wait_exponential
from ..core.config import settings


class OFDClient:
    def __init__(self):
        self.base_url = settings.OFD_API_URL
        self.api_key = settings.OFD_API_KEY
        self.inn = settings.OFD_INN
        self._client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self):
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"X-Token": self.api_key, "Content-Type": "application/json"},
            timeout=30.0,
        )
        return self

    async def __aexit__(self, *args):
        if self._client:
            await self._client.aclose()

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10))
    async def _request(self, method: str, path: str, **kwargs) -> dict:
        resp = await self._client.request(method, path, **kwargs)
        resp.raise_for_status()
        return resp.json()

    async def get_receipts(self, date_from: str, date_to: str, kkt_serial: Optional[str] = None) -> list[dict]:
        params = {"inn": self.inn, "dateFrom": date_from, "dateTo": date_to, "pageSize": 1000}
        if kkt_serial:
            params["kktSerialNumber"] = kkt_serial
        data = await self._request("GET", "/receipts", params=params)
        return data.get("data", [])

    async def get_revenue_summary(self, date_from: str, date_to: str) -> dict:
        """Get aggregated revenue from OFD for cross-check with POS."""
        receipts = await self.get_receipts(date_from, date_to)
        total = sum(r.get("totalSum", 0) for r in receipts if r.get("operationType") == 1)
        refunds = sum(r.get("totalSum", 0) for r in receipts if r.get("operationType") == 2)
        return {
            "total_revenue": total / 100,
            "total_refunds": refunds / 100,
            "net_revenue": (total - refunds) / 100,
            "receipts_count": len([r for r in receipts if r.get("operationType") == 1]),
            "date_from": date_from,
            "date_to": date_to,
        }

    async def get_kkts(self) -> list[dict]:
        data = await self._request("GET", "/kkts", params={"inn": self.inn})
        return data.get("data", [])

    async def check_kkt_status(self, kkt_serial: str) -> dict:
        data = await self._request("GET", f"/kkts/{kkt_serial}/status")
        return data
