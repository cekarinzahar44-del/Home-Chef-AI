from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from ...core.database import get_db
from ...core.auth import get_current_user
from ...models.staff import User
from ...agents.owner_agent import OwnerAgent

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary")
async def get_dashboard_summary(
    organization_id: int = Query(...),
    period_days: int = Query(7, ge=1, le=90),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    agent = OwnerAgent(db)
    result = await agent.run({"organization_id": organization_id, "period_days": period_days})
    return result.to_dict()


@router.get("/alerts")
async def get_alerts(
    organization_id: int = Query(...),
    unread_only: bool = Query(True),
    limit: int = Query(50, le=200),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import select
    from ...models.revenue import Alert
    query = select(Alert).where(Alert.organization_id == organization_id)
    if unread_only:
        query = query.where(Alert.is_read == False)
    query = query.order_by(Alert.created_at.desc()).limit(limit)
    result = await db.execute(query)
    alerts = result.scalars().all()
    return [{"id": a.id, "severity": a.severity, "title": a.title, "message": a.message,
             "agent_name": a.agent_name, "is_read": a.is_read, "created_at": str(a.created_at)}
            for a in alerts]


@router.post("/alerts/{alert_id}/read")
async def mark_alert_read(
    alert_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import select
    from ...models.revenue import Alert
    result = await db.execute(select(Alert).where(Alert.id == alert_id))
    alert = result.scalar_one_or_none()
    if alert:
        alert.is_read = True
        await db.commit()
    return {"success": bool(alert)}
