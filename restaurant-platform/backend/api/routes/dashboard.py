from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession
from core.database import get_db
from core.auth import get_current_user, require_role
from models.staff import User, UserRole
from models.revenue import RevenueRecord
from models.inventory import InventoryItem, WriteOff
from models.organization import Location
from agents.owner_agent import OwnerAgent

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary")
async def get_summary(
    period_days: int = Query(7, ge=1, le=90),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    since = datetime.utcnow() - timedelta(days=period_days)

    revenue_stmt = select(func.sum(RevenueRecord.amount)).where(RevenueRecord.date >= since)
    revenue_result = await db.execute(revenue_stmt)
    total_revenue = float(revenue_result.scalar() or 0)

    wo_stmt = select(func.count(), func.sum(WriteOff.quantity)).where(WriteOff.created_at >= since)
    wo_result = await db.execute(wo_stmt)
    wo_count, wo_qty = wo_result.one()

    low_stock_stmt = select(InventoryItem).where(
        InventoryItem.current_stock <= InventoryItem.min_stock_level
    ).limit(10)
    low_stock_result = await db.execute(low_stock_stmt)
    low_stock_items = low_stock_result.scalars().all()

    from models.revenue import Alert
    alerts_stmt = select(Alert).where(Alert.is_resolved == False).order_by(Alert.created_at.desc()).limit(5)
    alerts_result = await db.execute(alerts_stmt)
    alerts = alerts_result.scalars().all()

    return {
        "period_days": period_days,
        "total_revenue": total_revenue,
        "write_offs_count": wo_count or 0,
        "write_offs_qty": float(wo_qty or 0),
        "low_stock_items": [
            {"id": i.id, "name": i.name, "current": i.current_stock, "min": i.min_stock_level, "unit": i.unit}
            for i in low_stock_items
        ],
        "alerts": [
            {"id": a.id, "type": a.alert_type, "message": a.message, "severity": a.severity.value}
            for a in alerts
        ],
    }


@router.get("/kpi")
async def get_kpi(
    period_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    agent = OwnerAgent(db)
    result = await agent.run(period_days=period_days)
    return result.data
