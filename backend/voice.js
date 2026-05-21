const gTTS = require('gtts');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Карта сокращений для TTS
const abbrMap = {
    'шт\\b': 'штук',
    'шт\\.\\b': 'штук',
    'г\\b': 'грамм',
    'г\\.\\b': 'грамм',
    'мл\\b': 'миллилитров',
    'мл\\.\\b': 'миллилитров',
    'кг\\b': 'килограмм',
    'кг\\.\\b': 'килограмм',
    'ч\\.л\\.?\\b': 'чайной ложки',
    'ст\\.л\\.?\\b': 'столовой ложки',
    'мин\\b': 'минут',
    'мин\\.\\b': 'минут',
    'сек\\b': 'секунд',
    'сек\\.\\b': 'секунд',
    '°C': 'градусов',
    '°': 'градусов',
    'гр\\b': 'грамм',
    'гр\\.\\b': 'грамм'
};

const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu;

function prepareForTTS(text) {
    if (!text) return '';
    
    let clean = text
        .replace(/<[^>]+>/g, '')           // Удаляем HTML теги
        .replace(emojiRegex, '')            // Удаляем эмодзи
        .replace(/\n+/g, '. ')              // Заменяем переносы на точки
        .replace(/\s+/g, ' ')               // Убираем лишние пробелы
        .replace(/[*/_#]/g, '')             // Удаляем маркдаун
        .trim();
    
    // Заменяем сокращения
    for (const [abbr, full] of Object.entries(abbrMap)) {
        const regex = new RegExp(abbr, 'gi');
        clean = clean.replace(regex, full);
    }
    
    // Ограничиваем длину
    if (clean.length > 4000) {
        clean = clean.substring(0, 4000) + '...';
    }
    
    return clean;
}

async function generateVoice(text, filePath) {
    const ttsText = prepareForTTS(text);
    
    if (!ttsText || ttsText.length < 10) {
        console.warn('⚠️ Текст слишком короткий для TTS');
        return;
    }
    
    console.log(`🔊 Генерация голоса, длина текста: ${ttsText.length} символов`);
    
    return new Promise((resolve, reject) => {
        try {
            const tts = new gTTS(ttsText, 'ru');
            tts.save(filePath, (err) => {
                if (err) {
                    console.error('❌ TTS save error:', err);
                    reject(err);
                } else {
                    console.log(`✅ Голос сохранен: ${filePath}`);
                    resolve();
                }
            });
        } catch (e) {
            console.error('❌ TTS creation error:', e);
            reject(e);
        }
    });
}

async function transcribeVoice(fileBuffer) {
    const apiKey = process.env.YANDEX_API_KEY;
    
    if (!apiKey) {
        console.warn('⚠️ YANDEX_API_KEY не задан в переменных BotHost');
        return 'тестовый режим';
    }
    
    if (!fileBuffer || fileBuffer.length < 100) {
        console.error('❌ Аудио файл поврежден или слишком мал');
        return '';
    }
    
    console.log(`🎤 Распознавание голоса, размер: ${fileBuffer.length} bytes`);
    
    try {
        const response = await fetch('https://stt.api.cloud.yandex.net/speech/v1/stt:recognize', {
            method: 'POST',
            headers: {
                'Authorization': `Api-Key ${apiKey}`,
                'Content-Type': 'audio/ogg;codecs=opus'
            },
            body: fileBuffer
        });
        
        const data = await response.json();
        
        if (data.error_code) {
            console.error('❌ Yandex STT error:', data);
            throw new Error(`${data.error_code}: ${data.error_message || 'Unknown error'}`);
        }
        
        const result = data.result || '';
        console.log(`🎤 Распознано: "${result.substring(0, 100)}${result.length > 100 ? '...' : ''}"`);
        
        return result;
        
    } catch (error) {
        console.error('❌ STT Error:', error.message);
        return '';
    }
}

// Функция для удаления временных файлов
async function cleanupTempFiles(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Удален временный файл: ${filePath}`);
        }
    } catch (error) {
        console.error('❌ Ошибка удаления файла:', error);
    }
}

module.exports = { generateVoice, transcribeVoice, cleanupTempFiles, prepareForTTS };
