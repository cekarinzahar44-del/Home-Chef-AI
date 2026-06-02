# Changelog

Все значимые изменения проекта документируются в этом файле.
Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.0.0/).

## [Unreleased] — Профессионализация

### Добавлено
- Security-middleware без зависимостей: безопасные HTTP-заголовки и rate-limiting
  (общий по IP + строгий по пользователю на дорогих ИИ-запросах).
- `trust proxy` и лимит размера тела запроса (1 МБ).
- Health-check `/health` с реальной проверкой подключения к БД.
- Обработчик неизвестных `/api`-маршрутов (404) и централизованный error-handler.
- Документация: `README`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`,
  `docs/SECURITY.md`.
- Юридические шаблоны: публичная оферта и политика конфиденциальности.
- Деплой: `Dockerfile`, `.dockerignore`, `ecosystem.config.js` (PM2).
- CI (GitHub Actions): проверка синтаксиса и тесты на Node 18/20.
- Юнит-тесты валидации Telegram initData (`node:test`).
- `.env.example`, `.editorconfig`, `package-lock.json`, метаданные в `package.json`.

### Безопасность
- `.giga_token.json` и `uploads/` явно исключены из git.
- Задокументирован компромисс с TLS для GigaChat и рекомендация по `NODE_EXTRA_CA_CERTS`.

> Дизайн, логика ИИ и способы оплаты намеренно не изменялись.
