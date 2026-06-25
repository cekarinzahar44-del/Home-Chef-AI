from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional
from core.database import get_db
from core.auth import get_current_user
from models.staff import User
from models.inventory import InventoryItem, WriteOff
from agents.inventory_agent import InventoryAgent

router = APIRouter(prefix="/inventory", tags=["inventory"])


class ItemCreate(BaseModel):
    name: str
    category: str
    unit: str
    current_stock: float = 0
    min_stock_level: float = 0
    cost_price: float = 0
    location_id: Optional[int] = None


@router.get("/")
async def list_items(
    location_id: Optional[int] = Query(None),
    search: Optional[str] = Query(None),
    low_stock_only: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    stmt = select(InventoryItem)
    if location_id:
        stmt = stmt.where(InventoryItem.location_id == location_id)
    if search:
        stmt = stmt.where(InventoryItem.name.ilike(f"%{search}%"))
    if low_stock_only:
        stmt = stmt.where(InventoryItem.current_stock <= InventoryItem.min_stock_level)
    stmt = stmt.order_by(InventoryItem.name)

    result = await db.execute(stmt)
    items = result.scalars().all()
    return [
        {
            "id": i.id, "name": i.name, "category": i.category,
            "unit": i.unit, "current_stock": i.current_stock,
            "min_stock_level": i.min_stock_level, "cost_price": i.cost_price,
            "location_id": i.location_id,
        }
        for i in items
    ]


@router.post("/", status_code=201)
async def create_item(
    data: ItemCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = InventoryItem(**data.model_dump())
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return {"id": item.id, "name": item.name}


@router.get("/stop-list")
async def get_stop_list(
    location_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    agent = InventoryAgent(db, location_id)
    result = await agent.run(action="stop_list")
    return result.data


@router.get("/forecast")
async def get_forecast(
    location_id: Optional[int] = Query(None),
    days: int = Query(7, ge=1, le=30),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    agent = InventoryAgent(db, location_id)
    result = await agent.run(action="forecast", days=days)
    return result.data


@router.get("/movements")
async def get_movements(
    item_id: Optional[int] = Query(None),
    location_id: Optional[int] = Query(None),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from models.inventory import StockMovement
    stmt = select(StockMovement).order_by(StockMovement.created_at.desc()).limit(limit)
    if item_id:
        stmt = stmt.where(StockMovement.item_id == item_id)
    if location_id:
        stmt = stmt.where(StockMovement.location_id == location_id)
    result = await db.execute(stmt)
    movements = result.scalars().all()
    return [
        {"id": m.id, "item_id": m.item_id, "type": m.movement_type.value,
         "quantity": m.quantity, "created_at": m.created_at.isoformat()}
        for m in movements
    ]
