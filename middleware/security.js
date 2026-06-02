'use strict';

/**
 * Лёгкие, безопасные middleware без внешних зависимостей.
 *
 * Здесь НЕ затрагивается дизайн, логика ИИ или приёма платежей —
 * только защита сервера от абьюза и базовые security-практики,
 * которые ожидаются от production-приложения с реальными платежами.
 */

// ===== SECURITY HEADERS =====
// Важно: НЕ выставляем X-Frame-Options / CSP frame-ancestors —
// Telegram Mini App открывается во встроенном webview/iframe,
// и жёсткие frame-политики сломали бы приложение.
function securityHeaders(req, res, next) {
  // Запрет угадывания MIME-типа (защита от ряда XSS-векторов)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Не передаём полный URL c initData в сторонние ресурсы
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Отключаем устаревший небезопасный префетч DNS
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  // Минимальная Permissions-Policy — приложению нужен только микрофон (голосовой ввод)
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(self)');
  // Убираем "выдающий" заголовок Express
  res.removeHeader('X-Powered-By');
  next();
}

// ===== IN-MEMORY RATE LIMITER =====
// Простой fixed-window лимитер без зависимостей. Подходит для одного инстанса.
// Для горизонтального масштабирования замените на лимитер на базе Redis.
function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60_000;
  const max = options.max || 120;
  const message = options.message || { error: 'too_many_requests', message: 'Слишком много запросов. Подождите немного.' };
  // keyGenerator позволяет лимитировать по Telegram-пользователю, а не только по IP
  const keyGenerator = options.keyGenerator || ((req) => req.ip || req.connection?.remoteAddress || 'unknown');

  const hits = new Map(); // key -> { count, resetAt }

  // Периодическая очистка устаревших записей, чтобы Map не рос бесконечно
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs);
  if (cleanup.unref) cleanup.unref();

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const key = keyGenerator(req);
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json(message);
    }

    next();
  };
}

module.exports = { securityHeaders, createRateLimiter };
