'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { validateTelegramAuth } = require('../auth');

const BOT_TOKEN = '123456:TEST-BOT-TOKEN';

// Собираем валидный initData по алгоритму Telegram WebApp
function buildInitData(user, { authDate = Math.floor(Date.now() / 1000), token = BOT_TOKEN } = {}) {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(user));
  params.set('auth_date', String(authDate));
  params.set('query_id', 'AAEtest');

  const entries = [];
  for (const [k, v] of params.entries()) entries.push(`${k}=${v}`);
  entries.sort();
  const dataCheckString = entries.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  params.set('hash', hash);
  return params.toString();
}

test('принимает корректно подписанный initData', () => {
  const user = { id: 42, first_name: 'Тест', username: 'tester' };
  const initData = buildInitData(user);
  const result = validateTelegramAuth(initData, BOT_TOKEN);
  assert.ok(result, 'должен вернуть объект пользователя');
  assert.strictEqual(result.id, 42);
  assert.strictEqual(result.username, 'tester');
});

test('отклоняет подделанный hash', () => {
  const user = { id: 42, first_name: 'Тест' };
  let initData = buildInitData(user);
  initData = initData.replace(/hash=[a-f0-9]+/, 'hash=deadbeef');
  assert.strictEqual(validateTelegramAuth(initData, BOT_TOKEN), null);
});

test('отклоняет подпись чужим токеном', () => {
  const user = { id: 7, first_name: 'Чужой' };
  const initData = buildInitData(user, { token: 'другой:ТОКЕН' });
  assert.strictEqual(validateTelegramAuth(initData, BOT_TOKEN), null);
});

test('отклоняет устаревший auth_date (старше 24 часов)', () => {
  const user = { id: 99, first_name: 'Старый' };
  const oldDate = Math.floor(Date.now() / 1000) - 90_000; // ~25 часов назад
  const initData = buildInitData(user, { authDate: oldDate });
  assert.strictEqual(validateTelegramAuth(initData, BOT_TOKEN), null);
});

test('отклоняет initData без hash', () => {
  assert.strictEqual(validateTelegramAuth('user=%7B%7D&auth_date=123', BOT_TOKEN), null);
});

test('не падает на мусорном вводе', () => {
  assert.strictEqual(validateTelegramAuth('', BOT_TOKEN), null);
  assert.strictEqual(validateTelegramAuth('не-валидно', BOT_TOKEN), null);
});
