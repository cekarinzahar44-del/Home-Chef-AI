from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    APP_NAME: str = "Restaurant Automation Platform"
    APP_ENV: str = "development"
    APP_SECRET_KEY: str = "change-me"
    APP_PORT: int = 8000
    FRONTEND_URL: str = "http://localhost:3000"

    DATABASE_URL: str = "postgresql+asyncpg://postgres:password@localhost:5432/restaurant_platform"
    DATABASE_POOL_SIZE: int = 20

    REDIS_URL: str = "redis://localhost:6379/0"

    ANTHROPIC_API_KEY: str = ""
    AI_MODEL: str = "claude-sonnet-4-6"
    AI_MAX_TOKENS: int = 4096

    # POS
    RKEEPER_API_URL: Optional[str] = None
    RKEEPER_API_KEY: Optional[str] = None
    IIKO_API_URL: Optional[str] = None
    IIKO_API_KEY: Optional[str] = None
    IIKO_ORGANIZATION_ID: Optional[str] = None

    # 1C
    ONE_C_URL: Optional[str] = None
    ONE_C_USER: Optional[str] = None
    ONE_C_PASSWORD: Optional[str] = None

    # OFD
    OFD_API_URL: Optional[str] = None
    OFD_API_KEY: Optional[str] = None
    OFD_INN: Optional[str] = None

    # EGAIS
    EGAIS_API_URL: Optional[str] = None
    EGAIS_UTM_URL: Optional[str] = "http://localhost:8080"
    EGAIS_INN: Optional[str] = None

    # Bank
    BANK_API_URL: Optional[str] = None
    BANK_CLIENT_ID: Optional[str] = None
    BANK_CLIENT_SECRET: Optional[str] = None
    BANK_ACCOUNT_NUMBER: Optional[str] = None

    # SKUD
    SKUD_API_URL: Optional[str] = None
    SKUD_API_KEY: Optional[str] = None

    # Flights
    FLIGHT_API_URL: Optional[str] = None
    FLIGHT_API_KEY: Optional[str] = None

    # Kontur
    KONTUR_FOCUS_API_URL: Optional[str] = None
    KONTUR_FOCUS_API_KEY: Optional[str] = None

    # Telegram
    TELEGRAM_BOT_TOKEN: Optional[str] = None
    TELEGRAM_ADMIN_CHAT_ID: Optional[str] = None

    LOG_LEVEL: str = "INFO"
    SENTRY_DSN: Optional[str] = None

    @property
    def is_production(self) -> bool:
        return self.APP_ENV == "production"


settings = Settings()
