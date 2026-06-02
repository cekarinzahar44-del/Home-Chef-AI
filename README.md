# 👨‍🍳 Шеф-Повар AI

Telegram Mini App, который генерирует персональные кулинарные рецепты с помощью ИИ (**GigaChat** от Сбера). Монетизация — через подписки **PRO** и **VIP** с оплатой по СБП и подтверждением админом.

[![CI](https://github.com/cekarinzahar44-del/home-chef-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/cekarinzahar44-del/home-chef-ai/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-Proprietary-red)

---

## ✨ Возможности

- 🍽 **Генерация рецептов** — по продуктам или по названию блюда, профессиональный формат с КБЖУ.
- 🚫 **Учёт аллергий** — строгий фильтр аллергенов с пост-проверкой и перегенерацией.
- 📅 **Меню на неделю** (VIP) — без повторов, с подбором уровня сложности.
- 🛒 **Список покупок** — автоматически из рецепта или меню недели.
- 💪 **Режимы VIP** — «Семья с детьми» и «Фитнес» (цели, калории).
- 🗣 **Голосовой ввод** — через Yandex SpeechKit.
- ⭐ **История и избранное** — сохранение, рейтинг, повтор блюд.
- 🔔 **Умные уведомления** — ежедневные напоминания и win-back неактивных.
- 💳 **Подписки PRO/VIP** — оплата по СБП, чек подтверждается админом.
- 📊 **Админ-панель** — статистика, выручка, пользователи, платежи, экспорт в Excel.

## 🧱 Технологии

| Слой | Технология |
|------|-----------|
| Backend | Node.js 18+, Express |
| Бот | Telegraf |
| БД | PostgreSQL (`pg`) |
| ИИ | GigaChat (Сбер) |
| Голос | Yandex SpeechKit |
| Frontend | Vanilla JS + Telegram WebApp SDK |
| Экспорт | ExcelJS |
| Планировщик | node-cron |

## 🏗 Архитектура

```
index.js            Точка входа: Express, бот Telegram, БД, cron-задачи
api.js              REST API (/api): рецепты, подписки, платежи, админка
auth.js             Валидация Telegram WebApp initData (HMAC)
gigachat.js         Клиент GigaChat (OAuth-токен с авто-обновлением)
stt.js              Распознавание речи (Yandex SpeechKit)
bot.js              Callback-кнопки бота (approve/reject платежей)
middleware/
  security.js       Security-заголовки и rate-limiting (без зависимостей)
public/             Frontend Mini App (index.html, app.js, style.css) и админка
docs/               Документация, деплой, юридические документы
test/               Юнит-тесты (node:test)
```

Подробнее — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 🚀 Быстрый старт

### Требования
- Node.js ≥ 18
- PostgreSQL ≥ 13
- Бот в [@BotFather](https://t.me/BotFather) и доступ к GigaChat API

### Установка

```bash
git clone https://github.com/cekarinzahar44-del/home-chef-ai.git
cd home-chef-ai
npm install
cp .env.example .env   # заполните переменные окружения
npm start
```

Таблицы БД, миграции и индексы создаются автоматически при первом запуске.

### Переменные окружения
Полный список с описанием — в [.env.example](.env.example). Минимум для запуска:
`BOT_TOKEN`, `ADMIN_ID`, `MINI_APP_URL`, `DATABASE_URL`, `GIGACHAT_CREDENTIALS`.

## 🧪 Разработка

```bash
npm run dev     # запуск с авто-перезагрузкой (node --watch)
npm test        # юнит-тесты
npm run check   # проверка синтаксиса всех модулей
```

## 📦 Деплой

Поддерживается запуск через Docker, PM2 или systemd за reverse-proxy (Nginx) с HTTPS.
Пошаговая инструкция — [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## 🔒 Безопасность

Авторизация всех запросов через подпись Telegram initData, отдельная проверка прав
администратора, rate-limiting и security-заголовки. Известные ограничения и
рекомендации — [docs/SECURITY.md](docs/SECURITY.md).

## ⚖️ Юридические документы

Для легального приёма платежей подготовлены шаблоны (требуют заполнения вашими реквизитами):
- [Публичная оферта](docs/legal/PUBLIC_OFFER.md)
- [Политика конфиденциальности](docs/legal/PRIVACY_POLICY.md)

## 📄 Лицензия

Проприетарное ПО. Все права защищены. См. [LICENSE](LICENSE).
