# Деплой

Приложение — это один Node.js-процесс, который одновременно поднимает
HTTP-сервер (Express, Mini App + API) и запускает Telegram-бота (long polling).
Перед ботом нужен HTTPS-домен для Mini App.

## 1. Предварительные требования

- Сервер с Node.js ≥ 18 и PostgreSQL ≥ 13
- Домен с валидным TLS-сертификатом (Let's Encrypt)
- Reverse-proxy (Nginx) для HTTPS и проксирования на `PORT`

## 2. Переменные окружения

Скопируйте `.env.example` в `.env` и заполните (см. описания в файле).
БД инициализируется автоматически при первом запуске.

## 3. Вариант A — PM2

```bash
npm ci
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # автозапуск при перезагрузке сервера
```

## 4. Вариант B — Docker

```bash
docker build -t chef-ai .
docker run -d --name chef-ai --env-file .env -p 3000:3000 \
  -v "$(pwd)/uploads:/app/uploads" chef-ai
```

> Том `uploads` монтируется, чтобы чеки оплаты переживали пересоздание контейнера.

## 5. Nginx (пример)

```nginx
server {
    listen 443 ssl;
    server_name chef.example.com;

    ssl_certificate     /etc/letsencrypt/live/chef.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chef.example.com/privkey.pem;

    client_max_body_size 11m;   # чуть больше лимита загрузки чеков (10 МБ)

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Приложение использует `trust proxy`, поэтому реальный IP клиента берётся из
`X-Forwarded-For` — это нужно для корректного rate-limiting.

## 6. Настройка Telegram

1. В [@BotFather](https://t.me/BotFather) задайте URL Mini App (`MINI_APP_URL`).
2. Кнопка меню настраивается автоматически при старте приложения.

## 7. Проверка работоспособности

```bash
curl https://chef.example.com/health
# {"status":"ok","db":"up","uptime":...}
```

## 8. Обновление

```bash
git pull
npm ci
pm2 reload ecosystem.config.js   # или: docker build ... && docker restart chef-ai
```
