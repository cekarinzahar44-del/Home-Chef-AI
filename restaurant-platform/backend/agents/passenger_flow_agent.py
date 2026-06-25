from datetime import datetime, timedelta
from typing import Optional
from sqlalchemy import select, func, and_
from agents.base_agent import BaseAgent, AgentResult
from models.revenue import RevenueRecord
from models.organization import Location
from core.config import settings
import httpx
import structlog

logger = structlog.get_logger()

FLIGHT_CONVERSION_RATE = 0.12


class PassengerFlowAgent(BaseAgent):
    async def run(self, location_id: int = None, forecast_hours: int = 24, **kwargs) -> AgentResult:
        loc_id = location_id or self.location_id

        flights = await self._get_flights(forecast_hours)
        total_passengers = sum(f.get("passengers", 0) for f in flights)
        expected_visitors = int(total_passengers * FLIGHT_CONVERSION_RATE)

        since = datetime.utcnow() - timedelta(days=7)
        rev_stmt = select(func.avg(RevenueRecord.amount)).where(RevenueRecord.date >= since)
        if loc_id:
            rev_stmt = rev_stmt.where(RevenueRecord.location_id == loc_id)
        avg_revenue_result = await self.db.execute(rev_stmt)
        avg_daily_revenue = float(avg_revenue_result.scalar() or 0)

        forecast_revenue = expected_visitors * (avg_daily_revenue / max(expected_visitors, 1) if expected_visitors else 0)

        recommendation = await self._ask_llm(
            "Ты — операционный менеджер аэропортового ресторана. Дай рекомендации по подготовке.",
            f"Ожидается {expected_visitors} посетителей в ближайшие {forecast_hours} часов. Рейсов: {len(flights)}.",
        )

        return AgentResult(
            success=True,
            message=f"Прогноз потока: {expected_visitors} посетителей",
            data={
                "flights_count": len(flights),
                "total_passengers": total_passengers,
                "expected_visitors": expected_visitors,
                "forecast_revenue": round(forecast_revenue, 2),
                "flights": flights[:10],
                "recommendation": recommendation,
            },
        )

    async def _get_flights(self, hours: int) -> list:
        if not settings.FLIGHT_API_KEY:
            return self._mock_flights()

        try:
            now = datetime.utcnow()
            end = now + timedelta(hours=hours)
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    f"{settings.FLIGHT_API_URL}/search/",
                    params={
                        "apikey": settings.FLIGHT_API_KEY,
                        "from": "s9600213",
                        "date": now.strftime("%Y-%m-%d"),
                        "transport_types": "plane",
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                segments = data.get("segments", [])
                return [
                    {
                        "flight": s.get("thread", {}).get("number", ""),
                        "departure": s.get("departure", ""),
                        "passengers": s.get("thread", {}).get("vehicle_type_name", 180),
                    }
                    for s in segments
                ]
        except Exception as e:
            logger.warning("Flight API failed, using mock", error=str(e))
            return self._mock_flights()

    def _mock_flights(self) -> list:
        return [
            {"flight": "SU-001", "departure": "10:00", "passengers": 180},
            {"flight": "S7-202", "departure": "11:30", "passengers": 160},
            {"flight": "U6-455", "departure": "13:00", "passengers": 200},
            {"flight": "DP-801", "departure": "15:45", "passengers": 140},
        ]
