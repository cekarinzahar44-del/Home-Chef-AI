from typing import Optional, List
from decimal import Decimal
from datetime import datetime, date
from sqlalchemy import String, Boolean, Integer, Numeric, ForeignKey, Text, Date, DateTime, Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship
import enum
from .base import Base, TimestampMixin


class UserRole(str, enum.Enum):
    owner = "owner"
    director = "director"
    manager = "manager"
    storekeeper = "storekeeper"
    cook = "cook"
    waiter = "waiter"
    bartender = "bartender"
    cashier = "cashier"
    security = "security"


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"))
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    phone: Mapped[Optional[str]] = mapped_column(String(20))
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[UserRole] = mapped_column(SAEnum(UserRole), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    telegram_id: Mapped[Optional[str]] = mapped_column(String(50))
    avatar_url: Mapped[Optional[str]] = mapped_column(String(500))
    last_login: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class StaffMember(Base, TimestampMixin):
    __tablename__ = "staff_members"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"))
    position: Mapped[str] = mapped_column(String(100))
    salary: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2))
    hire_date: Mapped[Optional[date]] = mapped_column(Date)
    skud_id: Mapped[Optional[str]] = mapped_column(String(50))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    location: Mapped["Location"] = relationship(back_populates="staff_members")
    shifts: Mapped[List["Shift"]] = relationship(back_populates="staff_member")


class Shift(Base, TimestampMixin):
    __tablename__ = "shifts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    staff_member_id: Mapped[int] = mapped_column(ForeignKey("staff_members.id"))
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"))
    planned_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    planned_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    actual_start: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    actual_end: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(30), default="planned")
    skud_entry: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    skud_exit: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    staff_member: Mapped["StaffMember"] = relationship(back_populates="shifts")

    @property
    def hours_worked(self) -> Optional[float]:
        if self.actual_start and self.actual_end:
            delta = self.actual_end - self.actual_start
            return round(delta.total_seconds() / 3600, 2)
        return None

    @property
    def is_late(self) -> bool:
        if self.actual_start and self.planned_start:
            return self.actual_start > self.planned_start
        return False
