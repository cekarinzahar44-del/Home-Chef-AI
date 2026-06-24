"""1C:Enterprise OData REST API integration."""
import httpx
from typing import Optional
from base64 import b64encode
from tenacity import retry, stop_after_attempt, wait_exponential
from ..core.config import settings


class OneCClient:
    def __init__(self):
        self.base_url = settings.ONE_C_URL
        credentials = f"{settings.ONE_C_USER}:{settings.ONE_C_PASSWORD}"
        self._auth_header = f"Basic {b64encode(credentials.encode()).decode()}"
        self._client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self):
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"Authorization": self._auth_header, "Accept": "application/json"},
            timeout=60.0,
        )
        return self

    async def __aexit__(self, *args):
        if self._client:
            await self._client.aclose()

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=2, max=30))
    async def _get(self, entity: str, params: dict = None) -> dict:
        resp = await self._client.get(f"/{entity}", params=params or {})
        resp.raise_for_status()
        return resp.json()

    async def get_write_offs(self, date_from: str, date_to: str) -> list[dict]:
        data = await self._get("Document_СписаниеТоваров", {
            "$filter": f"Date ge datetime'{date_from}T00:00:00' and Date le datetime'{date_to}T23:59:59'",
            "$expand": "СписаниеТоваров_ТЧ_Товары",
            "$format": "json",
        })
        return data.get("value", [])

    async def get_inventory(self, location_id: str) -> list[dict]:
        data = await self._get("InformationRegister_ОстаткиНоменклатуры", {
            "$filter": f"Склад_Key eq guid'{location_id}'",
            "$format": "json",
        })
        return data.get("value", [])

    async def create_write_off(self, document: dict) -> dict:
        resp = await self._client.post("/Document_СписаниеТоваров", json=document)
        resp.raise_for_status()
        return resp.json()

    async def get_suppliers(self) -> list[dict]:
        data = await self._get("Catalog_Контрагенты", {
            "$filter": "IsFolder eq false and DeletionMark eq false",
            "$format": "json",
        })
        return data.get("value", [])

    async def get_purchase_orders(self, date_from: str, date_to: str) -> list[dict]:
        data = await self._get("Document_ЗаказПоставщику", {
            "$filter": f"Date ge datetime'{date_from}T00:00:00' and Date le datetime'{date_to}T23:59:59'",
            "$format": "json",
        })
        return data.get("value", [])

    async def get_payroll(self, period: str) -> list[dict]:
        data = await self._get("Document_НачислениеЗарплаты", {
            "$filter": f"ПериодРегистрации eq datetime'{period}T00:00:00'",
            "$format": "json",
        })
        return data.get("value", [])
