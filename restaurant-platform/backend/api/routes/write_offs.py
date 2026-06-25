from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional
from core.database import get_db
from core.auth import get_current_user
from models.staff import User
from models.inventory import WriteOff
from agents.write_off_agent import WriteOffAgent

router = APIRouter(prefix="/write-offs", tags=["write-offs"])


class WriteOffRequest(BaseModel):
    text: str
    location_id: Optional[int] = None


@router.post("/")
async def create_write_off(
    data: WriteOffRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    agent = WriteOffAgent(db, data.location_id)
    result = await agent.run(raw_text=data.text, user_id=current_user.id)
    return {
        "success": result.success,
        "message": result.message,
        "data": result.data,
        "errors": result.errors,
    }


@router.get("/")
async def list_write_offs(
    location_id: Optional[int] = Query(None),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    stmt = select(WriteOff).order_by(WriteOff.created_at.desc()).limit(limit)
    if location_id:
        stmt = stmt.where(WriteOff.location_id == location_id)
    result = await db.execute(stmt)
    write_offs = result.scalars().all()

    return [
        {
            "id": w.id,
            "item_id": w.item_id,
            "quantity": w.quantity,
            "unit": w.unit,
            "reason": w.reason.value if w.reason else None,
            "raw_input": w.raw_input,
            "ai_parsed": w.ai_parsed,
            "created_at": w.created_at.isoformat(),
        }
        for w in write_offs
    ]


@router.get("/stats")
async def write_off_stats(
    location_id: Optional[int] = Query(None),
    period_days: int = Query(7, ge=1, le=90),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from datetime import datetime, timedelta
    from sqlalchemy import func
    from models.inventory import WriteOffReason, StockMovement

    since = datetime.utcnow() - timedelta(days=period_days)
    stmt = select(WriteOff.reason, func.count(), func.sum(WriteOff.quantity)).where(
        WriteOff.created_at >= since
    ).group_by(WriteOff.reason)
    if location_id:
        stmt = stmt.where(WriteOff.location_id == location_id)

    result = await db.execute(stmt)
    stats = [
        {"reason": row[0].value if row[0] else None, "count": row[1], "total_qty": float(row[2] or 0)}
        for row in result
    ]
    return {"period_days": period_days, "stats": stats}
