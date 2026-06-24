"""Passenger flow agent: flight schedule integration for airport locations."""
import httpx
from datetime import date, datetime, timedelta
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from .base_agent import BaseAgent, AgentResult
from ..models.revenue import RevenueRecord
from ..models.organization import Location
from ..core.config import settings


class PassengerFlowAgent(BaseAgent):
    name = "passenger_flow_agent"
    description = "Прогноз пассажиропотока и выручки аэропортовых точек на основе расписания рейсов"

    def __init__(self, db: AsyncSession):
        super().__init__()
        self.db = db

    async def run(self, context: dict) -> AgentResult:
        location_id: int = context.get("location_id")
        forecast_date_str: str = context.get("date", str(date.today() + timedelta(days=1)))
        forecast_date = date.fromisoformat(forecast_date_str)

        location = await self._get_location(location_id)
        if not location or not location.airport_code:
            return AgentResult(False, None, "Точка не является аэропортовой или не настроен IATA-код")

        flights = await self._get_flights(location.airport_code, forecast_date)
        historical = await self._get_historical_revenue(location_id, 30)
        forecast = await self._calculate_forecast(flights, historical)
        recommendations = await self._generate_recommendations(flights, forecast, location)

        return AgentResult(
            success=True,
            data={
                "date": str(forecast_date),
                "airport": location.airport_code,
                "flights_count": len(flights),
                "expected_passengers": sum(f.get("seats", 150) for f in flights),
                "revenue_forecast": forecast,
                "peak_hours": self._find_peak_hours(flights),
                "recommendations": recommendations,
            },
            message=f"Прогноз на {forecast_date}: {len(flights)} рейсов, "
                    f"выручка ~{self._format_currency(forecast.get('expected_revenue', 0))}",
        )

    async def _get_flights(self, airport_code: str, flight_date: date) -> list[dict]:
        if not settings.FLIGHT_API_KEY:
            return self._mock_flights(flight_date)
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"{settings.FLIGHT_API_URL}/schedule/",
                    params={
                        "apikey": settings.FLIGHT_API_KEY,
                        "station": airport_code,
                        "date": str(flight_date),
                        "format": "json",
                        "transport_types": "plane",
                    },
                    timeout=15.0,
                )
                resp.raise_for_status()
                data = resp.json()
                return data.get("schedule", {}).get("events", [])
        except Exception as e:
            self.logger.warning("flight_api_error", error=str(e))
            return self._mock_flights(flight_date)

    async def _get_historical_revenue(self, location_id: int, days: int) -> dict:
        date_from = date.today() - timedelta(days=days)
        result = await self.db.execute(
            select(RevenueRecord).where(
                RevenueRecord.location_id == location_id,
                RevenueRecord.date >= date_from,
            ).order_by(RevenueRecord.date)
        )
        records = result.scalars().all()
        if not records:
            return {"avg_daily": 0, "avg_per_cover": 0}
        avg_daily = sum(float(r.revenue_gross) for r in records) / len(records)
        avg_per_cover = sum(float(r.avg_check or 0) for r in records) / len(records)
        return {"avg_daily": avg_daily, "avg_per_cover": avg_per_cover}

    async def _calculate_forecast(self, flights: list, historical: dict) -> dict:
        total_passengers = sum(f.get("seats", 150) for f in flights)
        conversion_rate = 0.12
        expected_covers = int(total_passengers * conversion_rate)
        avg_check = historical.get("avg_per_cover", 800)
        expected_revenue = expected_covers * avg_check
        return {
            "expected_covers": expected_covers,
            "expected_revenue": expected_revenue,
            "conversion_rate": conversion_rate,
            "basis": "historical_avg",
        }

    def _find_peak_hours(self, flights: list) -> list[str]:
        hour_counts: dict[int, int] = {}
        for flight in flights:
            departure = flight.get("departure", {}).get("at", "")
            if departure:
                try:
                    hour = datetime.fromisoformat(departure.replace("Z", "+00:00")).hour
                    hour_counts[hour] = hour_counts.get(hour, 0) + 1
                except ValueError:
                    pass
        peak = sorted(hour_counts.items(), key=lambda x: x[1], reverse=True)[:3]
        return [f"{h:02d}:00-{h+1:02d}:00" for h, _ in sorted(peak)]

    async def _generate_recommendations(self, flights: list, forecast: dict, location: Location) -> str:
        prompt = f"""Ты операционный менеджер аэропортового ресторана.
Завтра {len(flights)} рейсов, ожидается ~{forecast['expected_covers']} гостей.
Прогноз выручки: {self._format_currency(forecast['expected_revenue'])}.
Пиковые часы: {self._find_peak_hours(flights)}.

Дай 3 конкретные рекомендации по подготовке (персонал, заготовки, стоп-лист)."""
        return await self._ask_llm(prompt)

    async def _get_location(self, location_id: int) -> Location:
        result = await self.db.execute(select(Location).where(Location.id == location_id))
        return result.scalar_one_or_none()

    def _mock_flights(self, flight_date: date) -> list[dict]:
        return [
            {"flight": f"SU{100+i}", "seats": 180, "departure": {"at": f"{flight_date}T{6+i*2:02d}:30:00"}}
            for i in range(8)
        ]
