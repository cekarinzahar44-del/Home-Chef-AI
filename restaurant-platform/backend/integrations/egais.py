"""EGAIS (Единая государственная автоматизированная информационная система) integration via UTM."""
import httpx
from typing import Optional
from xml.etree import ElementTree as ET
from ..core.config import settings


class EGAISClient:
    """Communicates with local UTM (Universal Transport Module) for EGAIS."""

    def __init__(self):
        self.utm_url = settings.EGAIS_UTM_URL
        self._client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self):
        self._client = httpx.AsyncClient(base_url=self.utm_url, timeout=30.0)
        return self

    async def __aexit__(self, *args):
        if self._client:
            await self._client.aclose()

    async def get_balance(self) -> list[dict]:
        resp = await self._client.get("/opt/out/QueryRestsАП")
        resp.raise_for_status()
        return self._parse_xml_rests(resp.text)

    async def send_write_off(self, document_xml: str) -> str:
        resp = await self._client.post("/opt/in/ActWriteOff", content=document_xml,
                                       headers={"Content-Type": "application/xml"})
        resp.raise_for_status()
        root = ET.fromstring(resp.text)
        return root.find(".//replyId").text

    async def get_incoming_tickets(self) -> list[dict]:
        resp = await self._client.get("/opt/out/Ticket")
        resp.raise_for_status()
        return self._parse_xml_tickets(resp.text)

    async def get_ttns(self, status: str = "new") -> list[dict]:
        resp = await self._client.get(f"/opt/out/ТТТН", params={"status": status})
        resp.raise_for_status()
        return self._parse_xml_ttns(resp.text)

    async def confirm_ttn(self, wbn_number: str, accept: bool) -> str:
        action = "Accepted" if accept else "Rejected"
        xml = f"""<?xml version="1.0" encoding="UTF-8"?>
        <ns:Documents xmlns:ns="urn:ACRAP" Version="2">
          <ns:Document>
            <ns:AcceptTicket>
              <ns:WBRegId>{wbn_number}</ns:WBRegId>
              <ns:Action>{action}</ns:Action>
            </ns:AcceptTicket>
          </ns:Document>
        </ns:Documents>"""
        resp = await self._client.post("/opt/in/AcceptTicket", content=xml,
                                       headers={"Content-Type": "application/xml"})
        resp.raise_for_status()
        return resp.text

    def _parse_xml_rests(self, xml: str) -> list[dict]:
        try:
            root = ET.fromstring(xml)
            items = []
            for pos in root.findall(".//{*}Position"):
                items.append({
                    "product_code": pos.findtext("{*}ProductCode"),
                    "name": pos.findtext("{*}FullName"),
                    "quantity": float(pos.findtext("{*}Quantity") or 0),
                    "unit": pos.findtext("{*}UnitType"),
                })
            return items
        except ET.ParseError:
            return []

    def _parse_xml_tickets(self, xml: str) -> list[dict]:
        try:
            root = ET.fromstring(xml)
            return [{"id": t.findtext("{*}TicketId"), "status": t.findtext("{*}Result")}
                    for t in root.findall(".//{*}Ticket")]
        except ET.ParseError:
            return []

    def _parse_xml_ttns(self, xml: str) -> list[dict]:
        try:
            root = ET.fromstring(xml)
            return [{"wbn": t.findtext("{*}WBRegId"), "date": t.findtext("{*}Date"),
                     "supplier": t.findtext("{*}Shipper")}
                    for t in root.findall(".//{*}ТТТН")]
        except ET.ParseError:
            return []
