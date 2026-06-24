from typing import Optional, List
from sqlalchemy import String, Boolean, Integer, Float, ForeignKey, Text, Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship
import enum
from .base import Base, TimestampMixin


class LocationType(str, enum.Enum):
    restaurant = "restaurant"
    cafe = "cafe"
    coffee_shop = "coffee_shop"
    fast_food = "fast_food"
    bar = "bar"
    kitchen_factory = "kitchen_factory"
    warehouse = "warehouse"


class PosSystem(str, enum.Enum):
    rkeeper = "rkeeper"
    iiko = "iiko"
    both = "both"


class Organization(Base, TimestampMixin):
    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    inn: Mapped[Optional[str]] = mapped_column(String(12))
    kpp: Mapped[Optional[str]] = mapped_column(String(9))
    legal_address: Mapped[Optional[str]] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    locations: Mapped[List["Location"]] = relationship(back_populates="organization")


class Location(Base, TimestampMixin):
    __tablename__ = "locations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"))
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    type: Mapped[LocationType] = mapped_column(SAEnum(LocationType), nullable=False)
    address: Mapped[Optional[str]] = mapped_column(Text)
    city: Mapped[Optional[str]] = mapped_column(String(100))
    airport_code: Mapped[Optional[str]] = mapped_column(String(10))
    pos_system: Mapped[PosSystem] = mapped_column(SAEnum(PosSystem), default=PosSystem.rkeeper)
    pos_location_id: Mapped[Optional[str]] = mapped_column(String(100))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    seats_count: Mapped[Optional[int]] = mapped_column(Integer)
    timezone: Mapped[str] = mapped_column(String(50), default="Europe/Moscow")

    organization: Mapped["Organization"] = relationship(back_populates="locations")
    inventory_items: Mapped[List["InventoryItem"]] = relationship(back_populates="location")
    staff_members: Mapped[List["StaffMember"]] = relationship(back_populates="location")
    equipment_items: Mapped[List["Equipment"]] = relationship(back_populates="location")
