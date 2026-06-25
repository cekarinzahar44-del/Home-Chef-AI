from .auth import router as auth_router
from .dashboard import router as dashboard_router
from .inventory import router as inventory_router
from .write_offs import router as write_offs_router
from .agents import router as agents_router

__all__ = ["auth_router", "dashboard_router", "inventory_router", "write_offs_router", "agents_router"]
