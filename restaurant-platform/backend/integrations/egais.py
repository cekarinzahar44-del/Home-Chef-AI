import httpx
from typing import Any
from core.config import settings
import xml.etree.ElementTree as ET
import structlog

logger = structlog.get_logger()

NS = {"ns": "http://fsrar.ru/WEGAIS/WB_DOC_SINGLE_01"}


class EGAISClient:
    def __init__(self):
        self.utm_url = settings.EGAIS_UTM_URL or "http://localhost:8080"
        self.inn = settings.EGAIS_INN or ""
        self.kpp = settings.EGAIS_KPP or ""

    async def get_balance(self) -> dict:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(f"{self.utm_url}/opt/out/rests")
            resp.raise_for_status()
            root = ET.fromstring(resp.text)
            items = []
            for product in root.findall(".//Product"):
                items.append({
                    "name": product.findtext("FullName", ""),
                    "quantity": product.findtext("Quantity", "0"),
                    "alc_volume": product.findtext("AlcVolume", "0"),
                })
            return {"items": items, "count": len(items)}

    async def send_write_off_act(self, products: list[dict]) -> str:
        xml_body = self._build_write_off_xml(products)
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{self.utm_url}/opt/in/ActWriteOff",
                content=xml_body,
                headers={"Content-Type": "application/xml"},
            )
            resp.raise_for_status()
            return resp.text

    def _build_write_off_xml(self, products: list[dict]) -> str:
        items_xml = "".join(
            f"""<Position><Identity>{i+1}</Identity>
<ProductCode>{p.get('code','')}</ProductCode>
<Quantity>{p.get('quantity',0)}</Quantity></Position>"""
            for i, p in enumerate(products)
        )
        return f"""<?xml version="1.0" encoding="utf-8"?>
<ActWriteOff xmlns="http://fsrar.ru/WEGAIS/WB_DOC_SINGLE_01">
  <Header><INN>{self.inn}</INN><KPP>{self.kpp}</KPP></Header>
  <Content>{items_xml}</Content>
</ActWriteOff>"""
