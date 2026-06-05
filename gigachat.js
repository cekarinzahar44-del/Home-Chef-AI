const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;

// Файл для хранения токена — переживает перезапуск сервера
const TOKEN_FILE = path.join(__dirname, '.giga_token.json');

let _token = null;
let _expiry = 0;
let _refreshTimer = null;
// Состояние последнего вызова ИИ — для мониторинга в админке
let _lastCall = { ok: null, at: null, error: null };

// Загружаем токен с диска при старте
function loadTokenFromDisk() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
    const { token, expiry } = JSON.parse(raw);
    // Берём с диска только если ещё действителен (> 2 мин до истечения)
    if (token && expiry && Date.now() < expiry - 120_000) {
      _token = token;
      _expiry = expiry;
      console.log(`[GigaChat] Токен загружен с диска, истекает: ${new Date(_expiry).toLocaleTimeString()}`);
      scheduleRefresh();
      return true;
    }
  } catch {}
  return false;
}

// Сохраняем токен на диск
function saveTokenToDisk() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: _token, expiry: _expiry }), 'utf8');
  } catch (e) {
    console.warn('[GigaChat] Не удалось сохранить токен на диск:', e.message);
  }
}

// Планируем автообновление за 5 минут до истечения
function scheduleRefresh() {
  if (_refreshTimer) clearTimeout(_refreshTimer);
  const delay = _expiry - Date.now() - 5 * 60 * 1000; // за 5 мин до истечения
  if (delay > 0) {
    _refreshTimer = setTimeout(async () => {
      console.log('[GigaChat] Автообновление токена...');
      try { await fetchNewToken(); }
      catch (e) { console.error('[GigaChat] Ошибка автообновления:', e.message); }
    }, delay);
    console.log(`[GigaChat] Автообновление запланировано через ${Math.round(delay / 60000)} мин`);
  }
}

// Получаем новый токен от API
async function fetchNewToken() {
  const res = await fetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Authorization': `Basic ${GIGA_CREDENTIALS}`,
      'RqUID': crypto.randomUUID()
    },
    body: 'scope=GIGACHAT_API_PERS'
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`GigaChat Auth: ${data.message || JSON.stringify(data)}`);

  _token = data.access_token;
  // expires_at — Unix timestamp в миллисекундах от Сбера
  _expiry = data.expires_at > 1e12
    ? data.expires_at              // уже в мс
    : data.expires_at * 1000;      // в секундах — переводим

  saveTokenToDisk();
  scheduleRefresh();

  const mins = Math.round((_expiry - Date.now()) / 60000);
  console.log(`[GigaChat] Новый токен получен, действует ${mins} мин до ${new Date(_expiry).toLocaleTimeString()}`);
  return _token;
}

// Основная функция — возвращает действующий токен
async function getGigaToken() {
  // Токен ещё действителен (> 1 мин запас)
  if (_token && Date.now() < _expiry - 60_000) return _token;
  return fetchNewToken();
}

// При старте пробуем загрузить с диска
loadTokenFromDisk();


async function callGigaChat(systemPrompt, userPrompt, maxTokens = 2000, temperature = 0.7) {
  // Только Lite — у Pro нет токенов сейчас
  const model = 'GigaChat';

  // Защита от слишком больших промптов (Lite контекст ~8192)
  const totalChars = systemPrompt.length + userPrompt.length;
  if (totalChars > 12000) {
    console.warn(`[GigaChat] Prompt too large (${totalChars} chars), truncating...`);
    if (userPrompt.length > 4000) userPrompt = userPrompt.slice(0, 4000) + '...';
  }

  let lastError = null;

  // До 3 попыток с экспоненциальной задержкой при 500-х
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const token = await getGigaToken();

      const res = await fetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        })
      });

      // 401 — токен протух, обновляем и повторяем
      if (res.status === 401 && attempt === 1) {
        console.warn('[GigaChat] 401 — обновление токена...');
        _token = null; _expiry = 0;
        continue;
      }

      const data = await res.json();

      if (!res.ok) {
        const errMsg = data.message || data.error || JSON.stringify(data);

        // 500-е (серверные) и 429 (rate limit) — пробуем ещё раз
        if ((res.status >= 500 || res.status === 429) && attempt < 3) {
          const delay = attempt * 1500; // 1.5s, 3s
          console.warn(`[GigaChat] ${res.status}: ${errMsg} — попытка ${attempt}/3, жду ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        throw new Error(`GigaChat ${res.status}: ${errMsg}`);
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('GigaChat вернул пустой ответ');
      _lastCall = { ok: true, at: Date.now(), error: null };
      return content;

    } catch (e) {
      lastError = e;
      // Если это сетевая ошибка — тоже повторяем
      if (attempt < 3 && (e.message?.includes('fetch failed') || e.message?.includes('ECONN'))) {
        const delay = attempt * 1500;
        console.warn(`[GigaChat] Network error, попытка ${attempt}/3:`, e.message);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      _lastCall = { ok: false, at: Date.now(), error: e.message };
      throw e;
    }
  }
  throw lastError || new Error('GigaChat недоступен');
}

// Состояние ИИ для мониторинга: валиден ли токен и как прошёл последний вызов
function getGigaChatHealth() {
  return {
    configured: !!GIGA_CREDENTIALS,
    tokenValid: !!_token && Date.now() < _expiry - 60_000,
    tokenExpiresAt: _expiry || null,
    lastCall: _lastCall
  };
}

module.exports = { callGigaChat, getGigaChatHealth };
