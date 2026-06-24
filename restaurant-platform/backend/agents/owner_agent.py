"""Owner agent: consolidates KPIs across all locations and surfaces risks."""
from datetime import date, timedelta
from decimal import Decimal
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession
from .base_agent import BaseAgent, AgentResult
from ..models.revenue import RevenueRecord, Alert
from ..models.inventory import InventoryItem, WriteOff
from ..models.staff import Shift
from ..models.organization import Location


class OwnerAgent(BaseAgent):
    name = "owner_agent"
    description = "Сводка ключевых метрик и рисков по всей сети в одном окне"

    def __init__(self, db: AsyncSession):
        super().__init__()
        self.db = db

    async def run(self, context: dict) -> AgentResult:
        organization_id: int = context.get("organization_id")
        period_days: int = context.get("period_days", 7)
        date_to = date.today()
        date_from = date_to - timedelta(days=period_days)

        locations = await self._get_locations(organization_id)
        location_ids = [loc.id for loc in locations]

        revenue_data = await self._get_revenue_summary(location_ids, date_from, date_to)
        inventory_alerts = await self._get_inventory_alerts(location_ids)
        write_off_summary = await self._get_write_off_summary(location_ids, date_from, date_to)
        staff_issues = await self._get_staff_issues(location_ids, date_to)
        unread_alerts = await self._get_unread_alerts(organization_id)

        risks = await self._analyze_risks(revenue_data, inventory_alerts, write_off_summary)

        return AgentResult(
            success=True,
            data={
                "period": {"from": str(date_from), "to": str(date_to)},
                "locations_count": len(locations),
                "revenue": revenue_data,
                "inventory_alerts": inventory_alerts,
                "write_offs": write_off_summary,
                "staff_issues": staff_issues,
                "unread_alerts_count": len(unread_alerts),
                "risks": risks,
                "locations": [{"id": l.id, "name": l.name, "type": l.type} for l in locations],
            },
            message=f"Дашборд за {period_days} дней: {len(locations)} объектов, "
                    f"выручка {self._format_currency(revenue_data.get('total', 0))}",
            alerts=[{"severity": r["severity"], "message": r["message"]} for r in risks],
        )

    async def _get_locations(self, org_id: int) -> list:
        result = await self.db.execute(
            select(Location).where(Location.organization_id == org_id, Location.is_active == True)
        )
        return result.scalars().all()

    async def _get_revenue_summary(self, location_ids: list, date_from: date, date_to: date) -> dict:
        result = await self.db.execute(
            select(
                func.sum(RevenueRecord.revenue_gross).label("total"),
                func.sum(RevenueRecord.covers).label("covers"),
                func.avg(RevenueRecord.avg_check).label("avg_check"),
                func.avg(RevenueRecord.food_cost_percent).label("avg_food_cost"),
                func.count(RevenueRecord.id).label("records"),
            ).where(
                RevenueRecord.location_id.in_(location_ids),
                RevenueRecord.date.between(date_from, date_to),
            )
        )
        row = result.one()
        return {
            "total": float(row.total or 0),
            "covers": int(row.covers or 0),
            "avg_check": float(row.avg_check or 0),
            "avg_food_cost_percent": float(row.avg_food_cost or 0),
        }

    async def _get_inventory_alerts(self, location_ids: list) -> list:
        result = await self.db.execute(
            select(InventoryItem).where(
                InventoryItem.location_id.in_(location_ids),
                InventoryItem.is_active == True,
                InventoryItem.current_stock <= InventoryItem.min_stock,
            )
        )
        items = result.scalars().all()
        return [{"item_id": i.id, "name": i.name, "location_id": i.location_id,
                 "current": float(i.current_stock), "min": float(i.min_stock), "unit": i.unit}
                for i in items]

    async def _get_write_off_summary(self, location_ids: list, date_from: date, date_to: date) -> dict:
        result = await self.db.execute(
            select(
                func.count(WriteOff.id).label("count"),
                func.sum(WriteOff.cost_total).label("total_cost"),
            ).where(
                WriteOff.location_id.in_(location_ids),
                func.date(WriteOff.created_at).between(date_from, date_to),
            )
        )
        row = result.one()
        return {"count": int(row.count or 0), "total_cost": float(row.total_cost or 0)}

    async def _get_staff_issues(self, location_ids: list, check_date: date) -> list:
        result = await self.db.execute(
            select(Shift).where(
                Shift.location_id.in_(location_ids),
                func.date(Shift.planned_start) == check_date,
                Shift.status == "planned",
                Shift.actual_start == None,
            )
        )
        missed = result.scalars().all()
        return [{"shift_id": s.id, "staff_id": s.staff_member_id, "planned": str(s.planned_start)}
                for s in missed]

    async def _get_unread_alerts(self, org_id: int) -> list:
        result = await self.db.execute(
            select(Alert).where(Alert.organization_id == org_id, Alert.is_read == False)
        )
        return result.scalars().all()

    async def _analyze_risks(self, revenue: dict, inventory_alerts: list, write_offs: dict) -> list:
        risks = []
        if inventory_alerts:
            risks.append({"severity": "warning",
                          "message": f"{len(inventory_alerts)} позиций с критически низким остатком"})
        food_cost = revenue.get("avg_food_cost_percent", 0)
        if food_cost > 35:
            risks.append({"severity": "error",
                          "message": f"Food cost превышает норму: {food_cost:.1f}% (норма ≤35%)"})
        if write_offs.get("total_cost", 0) > 50000:
            risks.append({"severity": "warning",
                          "message": f"Высокий объём списаний: {self._format_currency(write_offs['total_cost'])}"})
        return risks
