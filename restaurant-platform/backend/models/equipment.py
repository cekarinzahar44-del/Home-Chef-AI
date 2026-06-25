from typing import Optional
from datetime import date, datetime
from decimal import Decimal
from sqlalchemy import String, Boolean, Integer, Numeric, ForeignKey, Text, Date, DateTime, Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column
import enum
from models.base import Base, TimestampMixin


class EquipmentStatus(str, enum.Enum):
    working = "working"
    maintenance = "maintenance"
    broken = "broken"
    decommissioned = "decommissioned"


class Equipment(Base, TimestampMixin):
    __tablename__ = "equipment"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"))
    name: Mapped[str] = mapped_column(String(255))
    model: Mapped[Optional[str]] = mapped_column(String(255))
    serial_number: Mapped[Optional[str]] = mapped_column(String(100))
    status: Mapped[EquipmentStatus] = mapped_column(SAEnum(EquipmentStatus), default=EquipmentStatus.working)
    purchase_date: Mapped[Optional[date]] = mapped_column(Date)
    warranty_expires: Mapped[Optional[date]] = mapped_column(Date)
    last_maintenance: Mapped[Optional[date]] = mapped_column(Date)
    next_maintenance: Mapped[Optional[date]] = mapped_column(Date)
    maintenance_interval_days: Mapped[int] = mapped_column(Integer, default=90)
    purchase_price: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))
    notes: Mapped[Optional[str]] = mapped_column(Text)
    is_critical: Mapped[bool] = mapped_column(Boolean, default=False)

    location: Mapped["Location"] = relationship(back_populates="equipment_items")

    @property
    def is_maintenance_due(self) -> bool:
        if self.next_maintenance:
            from datetime import date as date_type
            return date_type.today() >= self.next_maintenance
        return False


class MaintenanceRecord(Base, TimestampMixin):
    __tablename__ = "maintenance_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    equipment_id: Mapped[int] = mapped_column(ForeignKey("equipment.id"))
    maintenance_date: Mapped[date] = mapped_column(Date)
    type: Mapped[str] = mapped_column(String(50))
    description: Mapped[Optional[str]] = mapped_column(Text)
    cost: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2))
    performed_by: Mapped[Optional[str]] = mapped_column(String(255))
    next_date: Mapped[Optional[date]] = mapped_column(Date)
