"""Base class for all AI agents in the restaurant automation platform."""
from abc import ABC, abstractmethod
from typing import Any, Optional
from anthropic import AsyncAnthropic
from langchain_anthropic import ChatAnthropic
from langgraph.graph import StateGraph, END
from ..core.config import settings
import structlog

logger = structlog.get_logger()


class AgentResult:
    def __init__(self, success: bool, data: Any, message: str = "", alerts: list = None):
        self.success = success
        self.data = data
        self.message = message
        self.alerts = alerts or []

    def to_dict(self) -> dict:
        return {
            "success": self.success,
            "data": self.data,
            "message": self.message,
            "alerts": self.alerts,
        }


class BaseAgent(ABC):
    name: str = "base_agent"
    description: str = ""

    def __init__(self):
        self.llm = ChatAnthropic(
            model=settings.AI_MODEL,
            max_tokens=settings.AI_MAX_TOKENS,
            anthropic_api_key=settings.ANTHROPIC_API_KEY,
        )
        self.logger = structlog.get_logger(agent=self.name)

    @abstractmethod
    async def run(self, context: dict) -> AgentResult:
        """Execute the agent's main task."""
        ...

    async def _ask_llm(self, prompt: str, system: str = "") -> str:
        from langchain_core.messages import HumanMessage, SystemMessage
        messages = []
        if system:
            messages.append(SystemMessage(content=system))
        messages.append(HumanMessage(content=prompt))
        response = await self.llm.ainvoke(messages)
        return response.content

    def _format_currency(self, amount: float) -> str:
        return f"{amount:,.2f} ₽"

    def _format_percent(self, value: float) -> str:
        return f"{value:.1f}%"
