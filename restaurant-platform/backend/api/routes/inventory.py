from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from decimal import Decimal
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ...core.database import get_db
from ...core.auth import get_current_user
from ...models.staff import User
from ...models.inventory import InventoryItem, InventoryCategory
from ...agents.inventory_agent import InventoryAgent

router = APIRouter(prefix="/inventory", tags=["inventory"])


class InventoryItemCreate(BaseModel):
    location_id: int
    name: str
    sku: str = ""
    category: InventoryCategory = InventoryCategory.food
    unit: str = "кг"
    current_stock: float = 0
    min_stock: float = 0
    max_stock: float = None
    cost_per_unit: float = None


class StockUpdateRequest(BaseModel):
    quantity: float
    comment: str = ""


@router.get("/")
async def list_inventory(
    location_id: int = Query(...),
    category: str = Query(None),
    low_stock_only: bool = Query(False),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = select(InventoryItem).where(
        InventoryItem.location_id == location_id,
        InventoryItem.is_active == True,
    )
    if category:
        query = query.where(InventoryItem.category == category)
    if low_stock_only:
        query = query.where(InventoryItem.current_stock <= InventoryItem.min_stock)
    query = query.order_by(InventoryItem.name)

    result = await db.execute(query)
    items = result.scalars().all()
    return [{"id": i.id, "name": i.name, "sku": i.sku, "category": i.category,
             "unit": i.unit, "current_stock": float(i.current_stock),
             "min_stock": float(i.min_stock),
             "max_stock": float(i.max_stock) if i.max_stock else None,
             "cost_per_unit": float(i.cost_per_unit) if i.cost_per_unit else None,
             "stock_value": float(i.stock_value) if i.stock_value else None,
             "is_low_stock": i.is_low_stock} for i in items]


@router.post("/", status_code=201)
async def create_item(
    req: InventoryItemCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    item = InventoryItem(
        location_id=req.location_id,
        name=req.name,
        sku=req.sku or None,
        category=req.category,
        unit=req.unit,
        current_stock=Decimal(str(req.current_stock)),
        min_stock=Decimal(str(req.min_stock)),
        max_stock=Decimal(str(req.max_stock)) if req.max_stock else None,
        cost_per_unit=Decimal(str(req.cost_per_unit)) if req.cost_per_unit else None,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return {"id": item.id, "name": item.name}


@router.get("/stop-list")
async def get_stop_list(
    location_id: int = Query(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    agent = InventoryAgent(db)
    result = await agent.run({"action": "stop_list", "location_id": location_id})
    return result.to_dict()


@router.get("/forecast")
async def get_forecast(
    location_id: int = Query(...),
    days: int = Query(7, ge=1, le=30),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    agent = InventoryAgent(db)
    result = await agent.run({"action": "forecast", "location_id": location_id, "days": days})
    return result.to_dict()


@router.get("/redistribution")
async def get_redistribution(
    organization_id: int = Query(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    agent = InventoryAgent(db)
    result = await agent.run({"action": "redistribution", "organization_id": organization_id})
    return result.to_dict()


@router.put("/{item_id}/stock")
async def update_stock(
    item_id: int,
    req: StockUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from ...models.inventory import StockMovement
    result = await db.execute(select(InventoryItem).where(InventoryItem.id == item_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Товар не найден")

    before = item.current_stock
    item.current_stock = Decimal(str(req.quantity))
    movement = StockMovement(
        location_id=item.location_id, inventory_item_id=item.id,
        movement_type="manual_correction",
        quantity_change=item.current_stock - before,
        quantity_before=before, quantity_after=item.current_stock,
        user_id=current_user.id,
    )
    db.add(movement)
    await db.commit()
    return {"success": True, "new_stock": float(item.current_stock)}
