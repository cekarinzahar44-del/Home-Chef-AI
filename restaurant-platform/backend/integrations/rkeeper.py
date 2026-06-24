"""R_keeper XML/REST API integration."""
import httpx
from typing import Optional, Any
from tenacity import retry, stop_after_attempt, wait_exponential
from ..core.config import settings


class RKeeperClient:
    def __init__(self):
        self.base_url = settings.RKEEPER_API_URL
        self.api_key = settings.RKEEPER_API_KEY
        self._client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self):
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"X-API-Key": self.api_key, "Content-Type": "application/json"},
            timeout=30.0,
        )
        return self

    async def __aexit__(self, *args):
        if self._client:
            await self._client.aclose()

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10))
    async def _request(self, method: str, path: str, **kwargs) -> dict:
        response = await self._client.request(method, path, **kwargs)
        response.raise_for_status()
        return response.json()

    async def get_revenue(self, location_id: str, date_from: str, date_to: str) -> dict:
        return await self._request("GET", f"/revenue", params={
            "restaurantCode": location_id,
            "dateFrom": date_from,
            "dateTo": date_to,
        })

    async def get_stop_list(self, location_id: str) -> list[dict]:
        data = await self._request("GET", f"/stoplist/{location_id}")
        return data.get("items", [])

    async def update_stop_list(self, location_id: str, item_id: str, is_stopped: bool) -> dict:
        return await self._request("POST", f"/stoplist/{location_id}/{item_id}", json={"stopped": is_stopped})

    async def get_orders(self, location_id: str, date: str) -> list[dict]:
        data = await self._request("GET", f"/orders", params={"restaurantCode": location_id, "date": date})
        return data.get("orders", [])

    async def write_off(self, location_id: str, item_code: str, quantity: float, reason: str) -> dict:
        return await self._request("POST", f"/writeoffs", json={
            "restaurantCode": location_id,
            "itemCode": item_code,
            "quantity": quantity,
            "reason": reason,
        })

    async def get_menu(self, location_id: str) -> list[dict]:
        data = await self._request("GET", f"/menu/{location_id}")
        return data.get("categories", [])

    async def get_inventory(self, location_id: str) -> list[dict]:
        data = await self._request("GET", f"/inventory/{location_id}")
        return data.get("items", [])

    async def get_staff_activity(self, location_id: str, date: str) -> list[dict]:
        data = await self._request("GET", f"/staff/activity", params={
            "restaurantCode": location_id,
            "date": date,
        })
        return data.get("activity", [])
