"""Bank API integration (DirectBank protocol)."""
import httpx
from typing import Optional
from tenacity import retry, stop_after_attempt, wait_exponential
from ..core.config import settings


class BankClient:
    def __init__(self):
        self.base_url = settings.BANK_API_URL
        self.client_id = settings.BANK_CLIENT_ID
        self.client_secret = settings.BANK_CLIENT_SECRET
        self.account = settings.BANK_ACCOUNT_NUMBER
        self._access_token: Optional[str] = None
        self._client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self):
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=30.0)
        await self._authenticate()
        return self

    async def __aexit__(self, *args):
        if self._client:
            await self._client.aclose()

    async def _authenticate(self):
        resp = await self._client.post("/oauth/token", data={
            "grant_type": "client_credentials",
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "scope": "accounts:read statements:read",
        })
        resp.raise_for_status()
        self._access_token = resp.json()["access_token"]
        self._client.headers.update({"Authorization": f"Bearer {self._access_token}"})

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10))
    async def _request(self, method: str, path: str, **kwargs) -> dict:
        resp = await self._client.request(method, path, **kwargs)
        if resp.status_code == 401:
            await self._authenticate()
            resp = await self._client.request(method, path, **kwargs)
        resp.raise_for_status()
        return resp.json()

    async def get_balance(self) -> dict:
        data = await self._request("GET", f"/accounts/{self.account}/balance")
        return {
            "account": self.account,
            "balance": data.get("balance", 0),
            "currency": data.get("currency", "RUB"),
            "as_of": data.get("asOf"),
        }

    async def get_statement(self, date_from: str, date_to: str) -> list[dict]:
        data = await self._request("GET", f"/accounts/{self.account}/statement", params={
            "from": date_from,
            "to": date_to,
        })
        return data.get("transactions", [])

    async def get_payments(self, date_from: str, date_to: str, counterparty_inn: Optional[str] = None) -> list[dict]:
        transactions = await self.get_statement(date_from, date_to)
        payments = [t for t in transactions if t.get("type") == "debit"]
        if counterparty_inn:
            payments = [p for p in payments if p.get("counterpartyInn") == counterparty_inn]
        return payments

    async def analyze_cashflow(self, date_from: str, date_to: str) -> dict:
        transactions = await self.get_statement(date_from, date_to)
        income = sum(t["amount"] for t in transactions if t.get("type") == "credit")
        expenses = sum(t["amount"] for t in transactions if t.get("type") == "debit")
        return {
            "income": income,
            "expenses": expenses,
            "net": income - expenses,
            "transactions_count": len(transactions),
        }
