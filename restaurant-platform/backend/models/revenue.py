from typing import Optional
from decimal import Decimal
from datetime import date, datetime
from sqlalchemy import String, Integer, Numeric, ForeignKey, Text, Date, DateTime, Enum as SAEnum, JSON
from sqlalchemy.orm import Mapped, mapped_column
import enum
from models.base import Base, TimestampMixin


class RevenueRecord(Base, TimestampMixin):
    __tablename__ = "revenue_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"))
    date: Mapped[date] = mapped_column(Date, nullable=False)
    revenue_gross: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    revenue_net: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    covers: Mapped[int] = mapped_column(Integer, default=0)
    avg_check: Mapped[Optional[Decimal]] = mapped_column(Numeric(10, 2))
    food_cost: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))
    food_cost_percent: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 2))
    labor_cost: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))
    labor_cost_percent: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 2))
    pos_source: Mapped[Optional[str]] = mapped_column(String(20))
    ofd_verified: Mapped[bool] = mapped_column(default=False)
    ofd_revenue: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))
    discrepancy: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))


class PnLReport(Base, TimestampMixin):
    __tablename__ = "pnl_reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    location_id: Mapped[Optional[int]] = mapped_column(ForeignKey("locations.id"))
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"))
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    revenue: Mapped[Decimal] = mapped_column(Numeric(16, 2), default=0)
    cogs: Mapped[Decimal] = mapped_column(Numeric(16, 2), default=0)
    gross_profit: Mapped[Decimal] = mapped_column(Numeric(16, 2), default=0)
    labor_cost: Mapped[Decimal] = mapped_column(Numeric(16, 2), default=0)
    rent: Mapped[Decimal] = mapped_column(Numeric(16, 2), default=0)
    utilities: Mapped[Decimal] = mapped_column(Numeric(16, 2), default=0)
    marketing: Mapped[Decimal] = mapped_column(Numeric(16, 2), default=0)
    other_expenses: Mapped[Decimal] = mapped_column(Numeric(16, 2), default=0)
    ebitda: Mapped[Decimal] = mapped_column(Numeric(16, 2), default=0)
    net_profit: Mapped[Decimal] = mapped_column(Numeric(16, 2), default=0)
    details: Mapped[Optional[dict]] = mapped_column(JSON)
    generated_by_agent: Mapped[bool] = mapped_column(default=False)


class Alert(Base, TimestampMixin):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"))
    location_id: Mapped[Optional[int]] = mapped_column(ForeignKey("locations.id"))
    agent_name: Mapped[str] = mapped_column(String(100))
    severity: Mapped[str] = mapped_column(String(20), default="info")
    title: Mapped[str] = mapped_column(String(255))
    message: Mapped[str] = mapped_column(Text)
    data: Mapped[Optional[dict]] = mapped_column(JSON)
    is_read: Mapped[bool] = mapped_column(default=False)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    resolved_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"))
