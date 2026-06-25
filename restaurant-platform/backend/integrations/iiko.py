import httpx
from typing import Optional, Any
from tenacity import retry, stop_after_attempt, wait_exponential
from core.config import settings
import structlog

logger = structlog.get_logger()


class IikoClient:
    def __init__(self):
        self.base_url = settings.IIKO_API_URL or ""
        self.api_key = settings.IIKO_API_KEY or ""
        self.org_id = settings.IIKO_ORGANIZATION_ID or ""
        self._session_token: Optional[str] = None

    async def _get_token(self) -> str:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{self.base_url}/access_token",
                params={"apiKey": self.api_key},
            )
            resp.raise_for_status()
            data = resp.json()
            self._session_token = data["token"]
            return self._session_token

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
    async def _request(self, method: str, endpoint: str, **kwargs) -> Any:
        if not self._session_token:
            await self._get_token()
        headers = {"Authorization": f"Bearer {self._session_token}"}
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.request(method, f"{self.base_url}/{endpoint}", headers=headers, **kwargs)
            if resp.status_code == 401:
                await self._get_token()
                headers["Authorization"] = f"Bearer {self._session_token}"
                resp = await client.request(method, f"{self.base_url}/{endpoint}", headers=headers, **kwargs)
            resp.raise_for_status()
            return resp.json()

    async def write_off(self, nomenclature_id: str, amount: float, comment: str) -> dict:
        return await self._request(
            "POST",
            f"nomenclature/{self.org_id}/writeoff",
            json={"nomenclatureId": nomenclature_id, "amount": amount, "comment": comment},
        )

    async def get_nomenclature(self) -> dict:
        return await self._request("GET", f"nomenclature/{self.org_id}")

    async def get_olap_report(self, date_from: str, date_to: str) -> dict:
        return await self._request(
            "POST",
            f"olap/revenue/{self.org_id}",
            json={"reportType": "SALES", "buildSummary": True, "dateFrom": date_from, "dateTo": date_to},
        )
