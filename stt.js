async function transcribeVoice(audioBuffer) {
  if (!process.env.YANDEX_API_KEY) return 'тестовый режим';

  const res = await fetch('https://stt.api.cloud.yandex.net/speech/v1/stt:recognize', {
    method: 'POST',
    headers: {
      'Authorization': `Api-Key ${process.env.YANDEX_API_KEY}`,
      'Content-Type': 'audio/webm'
    },
    body: audioBuffer
  });
  const data = await res.json();
  if (data.error_code) throw new Error(`${data.error_code}: ${data.error_message}`);
  return data.result || '';
}

module.exports = { transcribeVoice };
