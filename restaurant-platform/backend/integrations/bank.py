import httpx
from typing import Any, Optional
from tenacity import retry, stop_after_attempt, wait_exponential
from core.config import settings
import structlog

logger = structlog.get_logger()


class BankClient:
    def __init__(self):
        self.base_url = settings.BANK_API_URL or ""
        self.client_id = settings.BANK_CLIENT_ID or ""
        self.client_secret = settings.BANK_CLIENT_SECRET or ""
        self.account = settings.BANK_ACCOUNT_NUMBER or ""
        self._token: Optional[str] = None

    async def _get_token(self) -> str:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{self.base_url}/oauth/token",
                data={"grant_type": "client_credentials", "client_id": self.client_id, "client_secret": self.client_secret},
            )
            resp.raise_for_status()
            self._token = resp.json()["access_token"]
            return self._token

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
    async def _request(self, method: str, endpoint: str, **kwargs) -> Any:
        if not self._token:
            await self._get_token()
        headers = {"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.request(method, f"{self.base_url}/{endpoint}", headers=headers, **kwargs)
            if resp.status_code == 401:
                await self._get_token()
                headers["Authorization"] = f"Bearer {self._token}"
                resp = await client.request(method, f"{self.base_url}/{endpoint}", headers=headers, **kwargs)
            resp.raise_for_status()
            return resp.json()

    async def get_balance(self) -> dict:
        return await self._request("GET", f"accounts/{self.account}/balance")

    async def get_transactions(self, date_from: str, date_to: str) -> list:
        return await self._request(
            "GET",
            f"accounts/{self.account}/transactions",
            params={"from": date_from, "to": date_to},
        )

    async def create_payment(self, amount: float, recipient: str, purpose: str) -> dict:
        return await self._request(
            "POST",
            "payments",
            json={"amount": amount, "recipient": recipient, "purpose": purpose, "account": self.account},
        )
