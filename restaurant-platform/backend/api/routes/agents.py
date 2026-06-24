"""Unified agent runner endpoint."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Any
from sqlalchemy.ext.asyncio import AsyncSession
from ...core.database import get_db
from ...core.auth import get_current_user
from ...models.staff import User
from ...agents import (
    WriteOffAgent, InventoryAgent, OwnerAgent,
    AuditAgent, ProcurementAgent, StaffAgent, PassengerFlowAgent,
)

router = APIRouter(prefix="/agents", tags=["agents"])

AGENT_MAP = {
    "write_off": WriteOffAgent,
    "inventory": InventoryAgent,
    "owner": OwnerAgent,
    "audit": AuditAgent,
    "procurement": ProcurementAgent,
    "staff": StaffAgent,
    "passenger_flow": PassengerFlowAgent,
}


class AgentRequest(BaseModel):
    agent: str
    context: dict[str, Any] = {}


@router.post("/run")
async def run_agent(
    req: AgentRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    agent_class = AGENT_MAP.get(req.agent)
    if not agent_class:
        return {"success": False, "message": f"Агент '{req.agent}' не найден. "
                f"Доступные: {list(AGENT_MAP.keys())}"}

    context = {**req.context, "user_id": current_user.id, "organization_id": current_user.organization_id}
    agent = agent_class(db)
    result = await agent.run(context)
    return result.to_dict()


@router.get("/list")
async def list_agents(current_user: User = Depends(get_current_user)):
    return [{"name": name, "description": cls(None).description if hasattr(cls, 'description') else ""}
            for name, cls in AGENT_MAP.items()]
