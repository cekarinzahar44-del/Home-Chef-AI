const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;

// Файл для хранения токена — переживает перезапуск сервера
const TOKEN_FILE = path.join(__dirname, '.giga_token.json');

let _token = null;
let _expiry = 0;
let _refreshTimer = null;

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


async function callGigaChat(systemPrompt, userPrompt, maxTokens = 2000) {
  // Сначала Lite (основной), Pro как запасной
  const models = ['GigaChat', 'GigaChat-Pro'];

  for (const model of models) {
    let attempts = 0;

    while (attempts < 2) {
      attempts++;
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
          temperature: 0.7,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        })
      });

      // Токен протух прямо во время запроса — принудительно обновляем и повторяем
      if (res.status === 401 && attempts === 1) {
        console.warn('[GigaChat] 401 — принудительное обновление токена...');
        _token = null; _expiry = 0;
        continue;
      }

      const data = await res.json();

      if (!res.ok) {
        const errMsg = data.message || data.error || JSON.stringify(data);
        if (model !== models[models.length - 1]) {
          console.warn(`[GigaChat] ${model} failed (${res.status}: ${errMsg}), trying fallback...`);
          break; // выходим из while — пробуем следующую модель
        }
        throw new Error(`GigaChat (${model}): ${errMsg}`);
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('GigaChat вернул пустой ответ');
      return content;
    }
  }
}

module.exports = { callGigaChat };
2
