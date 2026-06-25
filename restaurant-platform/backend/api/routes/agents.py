from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional
from core.database import get_db
from core.auth import get_current_user
from models.staff import User
from agents import (
    InventoryAgent,
    OwnerAgent,
    AuditAgent,
    ProcurementAgent,
    StaffAgent,
    PassengerFlowAgent,
)

router = APIRouter(prefix="/agents", tags=["agents"])


@router.post("/inventory/check")
async def run_inventory_check(
    location_id: Optional[int] = Query(None),
    action: str = Query("check_all"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    agent = InventoryAgent(db, location_id)
    result = await agent.run(action=action)
    return {"success": result.success, "message": result.message, "data": result.data}


@router.post("/owner/dashboard")
async def run_owner_dashboard(
    period_days: int = Query(7, ge=1, le=90),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    agent = OwnerAgent(db)
    result = await agent.run(period_days=period_days)
    return {"success": result.success, "message": result.message, "data": result.data}


@router.post("/audit")
async def run_audit(
    period_days: int = Query(30, ge=1, le=365),
    location_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    agent = AuditAgent(db, location_id)
    result = await agent.run(period_days=period_days, location_id=location_id)
    return {"success": result.success, "message": result.message, "data": result.data}


@router.post("/procurement")
async def run_procurement(
    days_forecast: int = Query(7, ge=1, le=30),
    auto_create: bool = Query(False),
    location_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    agent = ProcurementAgent(db, location_id)
    result = await agent.run(days_forecast=days_forecast, auto_create=auto_create)
    return {"success": result.success, "message": result.message, "data": result.data}


@router.post("/staff")
async def run_staff_agent(
    action: str = Query("check_shifts"),
    location_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    agent = StaffAgent(db, location_id)
    result = await agent.run(action=action)
    return {"success": result.success, "message": result.message, "data": result.data}


@router.post("/passenger-flow")
async def run_passenger_flow(
    location_id: Optional[int] = Query(None),
    forecast_hours: int = Query(24, ge=1, le=72),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    agent = PassengerFlowAgent(db, location_id)
    result = await agent.run(location_id=location_id, forecast_hours=forecast_hours)
    return {"success": result.success, "message": result.message, "data": result.data}
