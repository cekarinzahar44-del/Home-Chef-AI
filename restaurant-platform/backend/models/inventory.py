from typing import Optional, List
from decimal import Decimal
from datetime import datetime
from sqlalchemy import String, Boolean, Integer, Numeric, ForeignKey, Text, DateTime, Enum as SAEnum, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
import enum
from models.base import Base, TimestampMixin


class InventoryCategory(str, enum.Enum):
    food = "food"
    beverage = "beverage"
    alcohol = "alcohol"
    packaging = "packaging"
    cleaning = "cleaning"
    other = "other"


class WriteOffReason(str, enum.Enum):
    spoilage = "spoilage"
    overproduction = "overproduction"
    breakage = "breakage"
    theft = "theft"
    expiry = "expiry"
    employee_meal = "employee_meal"
    tasting = "tasting"
    other = "other"


class InventoryItem(Base, TimestampMixin):
    __tablename__ = "inventory_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"))
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    sku: Mapped[Optional[str]] = mapped_column(String(100))
    category: Mapped[InventoryCategory] = mapped_column(SAEnum(InventoryCategory), default=InventoryCategory.food)
    unit: Mapped[str] = mapped_column(String(20), default="кг")
    current_stock: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=0)
    min_stock: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=0)
    max_stock: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 3))
    cost_per_unit: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    pos_item_id: Mapped[Optional[str]] = mapped_column(String(100))
    egais_code: Mapped[Optional[str]] = mapped_column(String(50))

    location: Mapped["Location"] = relationship(back_populates="inventory_items")
    write_offs: Mapped[List["WriteOff"]] = relationship(back_populates="inventory_item")
    stock_movements: Mapped[List["StockMovement"]] = relationship(back_populates="inventory_item")

    @property
    def is_low_stock(self) -> bool:
        return self.current_stock <= self.min_stock

    @property
    def stock_value(self) -> Optional[Decimal]:
        if self.cost_per_unit:
            return self.current_stock * self.cost_per_unit
        return None


class WriteOff(Base, TimestampMixin):
    __tablename__ = "write_offs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"))
    inventory_item_id: Mapped[int] = mapped_column(ForeignKey("inventory_items.id"))
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    unit: Mapped[str] = mapped_column(String(20))
    reason: Mapped[WriteOffReason] = mapped_column(SAEnum(WriteOffReason), default=WriteOffReason.spoilage)
    reason_comment: Mapped[Optional[str]] = mapped_column(Text)
    cost_total: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2))
    written_off_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    approved_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"))
    pos_synced: Mapped[bool] = mapped_column(Boolean, default=False)
    pos_sync_id: Mapped[Optional[str]] = mapped_column(String(100))
    raw_input: Mapped[Optional[str]] = mapped_column(Text)
    ai_parsed: Mapped[Optional[dict]] = mapped_column(JSON)

    inventory_item: Mapped["InventoryItem"] = relationship(back_populates="write_offs")


class StockMovement(Base, TimestampMixin):
    __tablename__ = "stock_movements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"))
    inventory_item_id: Mapped[int] = mapped_column(ForeignKey("inventory_items.id"))
    movement_type: Mapped[str] = mapped_column(String(30))
    quantity_change: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    quantity_before: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    quantity_after: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    reference_id: Mapped[Optional[int]] = mapped_column(Integer)
    reference_type: Mapped[Optional[str]] = mapped_column(String(50))
    user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"))

    inventory_item: Mapped["InventoryItem"] = relationship(back_populates="stock_movements")


class PurchaseOrder(Base, TimestampMixin):
    __tablename__ = "purchase_orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"))
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"))
    status: Mapped[str] = mapped_column(String(30), default="draft")
    total_amount: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))
    ordered_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    approved_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"))
    expected_delivery: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    notes: Mapped[Optional[str]] = mapped_column(Text)
    one_c_document_id: Mapped[Optional[str]] = mapped_column(String(100))

    items: Mapped[List["PurchaseOrderItem"]] = relationship(back_populates="order")


class PurchaseOrderItem(Base):
    __tablename__ = "purchase_order_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("purchase_orders.id"))
    inventory_item_id: Mapped[int] = mapped_column(ForeignKey("inventory_items.id"))
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    unit_price: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2))
    total_price: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))

    order: Mapped["PurchaseOrder"] = relationship(back_populates="items")


class Supplier(Base, TimestampMixin):
    __tablename__ = "suppliers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"))
    name: Mapped[str] = mapped_column(String(255))
    inn: Mapped[Optional[str]] = mapped_column(String(12))
    contact_name: Mapped[Optional[str]] = mapped_column(String(255))
    phone: Mapped[Optional[str]] = mapped_column(String(20))
    email: Mapped[Optional[str]] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    rating: Mapped[Optional[Decimal]] = mapped_column(Numeric(3, 2))
    kontur_checked: Mapped[bool] = mapped_column(Boolean, default=False)
    kontur_risk_score: Mapped[Optional[str]] = mapped_column(String(20))
