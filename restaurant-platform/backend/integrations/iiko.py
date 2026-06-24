"""iiko REST API integration (iiko.biz / iikoRMS)."""
import httpx
from typing import Optional
from tenacity import retry, stop_after_attempt, wait_exponential
from ..core.config import settings


class IikoClient:
    def __init__(self):
        self.base_url = settings.IIKO_API_URL
        self.api_key = settings.IIKO_API_KEY
        self.organization_id = settings.IIKO_ORGANIZATION_ID
        self._session_token: Optional[str] = None
        self._client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self):
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=30.0)
        await self._authenticate()
        return self

    async def __aexit__(self, *args):
        if self._client:
            await self._client.aclose()

    async def _authenticate(self):
        resp = await self._client.get("/access_token", params={"apiKey": self.api_key})
        resp.raise_for_status()
        self._session_token = resp.text.strip('"')
        self._client.headers.update({"Authorization": f"Bearer {self._session_token}"})

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10))
    async def _request(self, method: str, path: str, **kwargs) -> Any:
        response = await self._client.request(method, path, **kwargs)
        if response.status_code == 401:
            await self._authenticate()
            response = await self._client.request(method, path, **kwargs)
        response.raise_for_status()
        return response.json()

    async def get_organizations(self) -> list[dict]:
        data = await self._request("POST", "/organizations", json={"organizationIds": []})
        return data.get("organizations", [])

    async def get_revenue(self, org_id: str, date_from: str, date_to: str) -> dict:
        return await self._request("POST", "/reports/olap", json={
            "organizationId": org_id,
            "reportType": "SALES",
            "groupByRowFields": ["OpenDate.Typed"],
            "aggregateFields": ["DishSumInt"],
            "filters": {"OpenDate.Typed": {"filterType": "DateRange", "periodType": "CUSTOM",
                                            "dateFrom": date_from, "dateTo": date_to}},
        })

    async def get_stop_list(self, org_id: str) -> list[dict]:
        data = await self._request("POST", "/stop_lists", json={"organizationIds": [org_id]})
        return data.get("terminalGroupStopLists", [])

    async def write_off(self, org_id: str, store_id: str, item_id: str, amount: float, reason: str) -> dict:
        return await self._request("POST", "/documents/writeoff", json={
            "organizationId": org_id,
            "items": [{"productId": item_id, "storeId": store_id, "amount": amount, "comment": reason}],
        })

    async def get_stores(self, org_id: str) -> list[dict]:
        data = await self._request("POST", "/stores", json={"organizationIds": [org_id]})
        return data.get("stores", [])

    async def get_products(self, org_id: str) -> list[dict]:
        data = await self._request("POST", "/nomenclature", json={"organizationId": org_id})
        return data.get("products", [])

    async def get_inventory_balances(self, org_id: str, store_id: str) -> list[dict]:
        data = await self._request("POST", "/stores/balance", json={
            "organizationId": org_id,
            "storeIds": [store_id],
        })
        return data.get("storeBalances", [])

    async def get_employees(self, org_id: str) -> list[dict]:
        data = await self._request("POST", "/employees", json={"organizationIds": [org_id]})
        return data.get("employees", [])
