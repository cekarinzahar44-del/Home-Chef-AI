from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from ...core.database import get_db
from ...core.auth import get_current_user
from ...models.staff import User
from ...models.inventory import WriteOff, InventoryItem
from ...agents.write_off_agent import WriteOffAgent

router = APIRouter(prefix="/write-offs", tags=["write-offs"])


class WriteOffRequest(BaseModel):
    text: str
    location_id: int


class ManualWriteOffRequest(BaseModel):
    location_id: int
    inventory_item_id: int
    quantity: float
    reason: str = "spoilage"
    comment: str = ""


@router.post("/")
async def create_write_off(
    req: WriteOffRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Parse natural language write-off command and sync to POS."""
    agent = WriteOffAgent(db)
    result = await agent.run({
        "text": req.text,
        "location_id": req.location_id,
        "user_id": current_user.id,
    })
    return result.to_dict()


@router.post("/manual")
async def manual_write_off(
    req: ManualWriteOffRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Manual structured write-off without AI parsing."""
    from decimal import Decimal
    from ...models.inventory import WriteOffReason, StockMovement

    item_result = await db.execute(select(InventoryItem).where(InventoryItem.id == req.inventory_item_id))
    item = item_result.scalar_one_or_none()
    if not item:
        return {"success": False, "message": "Товар не найден"}

    quantity = Decimal(str(req.quantity))
    if item.current_stock < quantity:
        return {"success": False, "message": f"Недостаточно остатков: {item.current_stock} {item.unit}"}

    write_off = WriteOff(
        location_id=req.location_id,
        inventory_item_id=item.id,
        quantity=quantity,
        unit=item.unit,
        reason=WriteOffReason(req.reason),
        reason_comment=req.comment,
        written_off_by=current_user.id,
        cost_total=quantity * item.cost_per_unit if item.cost_per_unit else None,
    )
    db.add(write_off)
    before = item.current_stock
    item.current_stock -= quantity
    db.add(StockMovement(
        location_id=req.location_id, inventory_item_id=item.id,
        movement_type="write_off", quantity_change=-quantity,
        quantity_before=before, quantity_after=item.current_stock, user_id=current_user.id,
    ))
    await db.commit()
    return {"success": True, "write_off_id": write_off.id, "remaining": float(item.current_stock)}


@router.get("/")
async def list_write_offs(
    location_id: int = Query(...),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, le=200),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(WriteOff).where(WriteOff.location_id == location_id)
        .order_by(WriteOff.created_at.desc()).offset(skip).limit(limit)
    )
    write_offs = result.scalars().all()
    return [{"id": w.id, "quantity": float(w.quantity), "unit": w.unit, "reason": w.reason,
             "cost_total": float(w.cost_total) if w.cost_total else None,
             "pos_synced": w.pos_synced, "created_at": str(w.created_at),
             "raw_input": w.raw_input} for w in write_offs]


@router.get("/stats")
async def write_off_stats(
    location_id: int = Query(...),
    days: int = Query(30, ge=1, le=365),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from datetime import date, timedelta
    date_from = date.today() - timedelta(days=days)
    result = await db.execute(
        select(
            func.count(WriteOff.id).label("count"),
            func.sum(WriteOff.cost_total).label("total_cost"),
            WriteOff.reason,
        ).where(
            WriteOff.location_id == location_id,
            func.date(WriteOff.created_at) >= date_from,
        ).group_by(WriteOff.reason)
    )
    rows = result.all()
    return {
        "period_days": days,
        "by_reason": [{"reason": r.reason, "count": r.count,
                        "total_cost": float(r.total_cost or 0)} for r in rows],
        "total": {"count": sum(r.count for r in rows),
                  "total_cost": sum(float(r.total_cost or 0) for r in rows)},
    }
