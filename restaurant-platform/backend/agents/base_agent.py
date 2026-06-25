from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, SystemMessage
from core.config import settings
import structlog

logger = structlog.get_logger()


@dataclass
class AgentResult:
    success: bool
    message: str
    data: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)


class BaseAgent(ABC):
    def __init__(self, db_session, location_id: Optional[int] = None):
        self.db = db_session
        self.location_id = location_id
        self.llm = ChatAnthropic(
            model=settings.AI_MODEL,
            api_key=settings.ANTHROPIC_API_KEY,
            max_tokens=settings.AI_MAX_TOKENS,
        )
        self.logger = structlog.get_logger(agent=self.__class__.__name__)

    @abstractmethod
    async def run(self, **kwargs) -> AgentResult:
        pass

    async def _ask_llm(self, system_prompt: str, user_message: str) -> str:
        try:
            messages = [
                SystemMessage(content=system_prompt),
                HumanMessage(content=user_message),
            ]
            response = await self.llm.ainvoke(messages)
            return response.content
        except Exception as e:
            self.logger.error("LLM call failed", error=str(e))
            raise
