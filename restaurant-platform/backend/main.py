"""Restaurant Automation Platform — FastAPI application entry point."""
import structlog
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .core.config import settings
from .core.database import init_db
from .api.routes import (
    auth_router, dashboard_router, inventory_router,
    write_offs_router, agents_router,
)

logger = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("startup", app=settings.APP_NAME, env=settings.APP_ENV)
    await init_db()
    yield
    logger.info("shutdown")


app = FastAPI(
    title="Restaurant Automation Platform API",
    description="AI-powered restaurant operations automation",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.FRONTEND_URL, "http://localhost:3000", "http://localhost:19006"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

API_PREFIX = "/api/v1"
app.include_router(auth_router, prefix=API_PREFIX)
app.include_router(dashboard_router, prefix=API_PREFIX)
app.include_router(inventory_router, prefix=API_PREFIX)
app.include_router(write_offs_router, prefix=API_PREFIX)
app.include_router(agents_router, prefix=API_PREFIX)


@app.get("/health")
async def health():
    return {"status": "ok", "app": settings.APP_NAME, "env": settings.APP_ENV}


@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    logger.error("unhandled_exception", error=str(exc), path=str(request.url))
    return JSONResponse(status_code=500, content={"detail": "Внутренняя ошибка сервера"})
