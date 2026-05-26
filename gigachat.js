const crypto = require('crypto');
const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;

let cachedToken = null;
let tokenExpiry = 0;

async function getGigaToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
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
  if (!res.ok) throw new Error(`GigaChat Auth: ${data.message}`);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_at - 30) * 1000;
  return cachedToken;
}

async function callGigaChat(systemPrompt, userPrompt, maxTokens = 3000) {
  const token = await getGigaToken();
  const res = await fetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      model: 'GigaChat-Pro',
      temperature: 0.7,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GigaChat: ${data.message}`);
  return data.choices[0].message.content;
}

module.exports = { callGigaChat };
