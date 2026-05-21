// BotHost: отключаем проверку SSL
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { Pool } = require('pg');
const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const { callGigaChat, getGigaToken } = require('./gigachat');
const { transcribeVoice, generateVoice } = require('./voice');
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// ===== КОНФИГУРАЦИЯ ИЗ ПЕРЕМЕННЫХ BOTHOST =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 0;
const PORT = parseInt(process.env.PORT) || 3000;
const PRO_PRICE = 500;
const VIP_PRICE = 800;
const FREE_LIMIT = 3;
const SBP_PHONE = process.env.SBP_PHONE || '+79022231321';
const SBP_RECIPIENT = process.env.SBP_RECIPIENT || 'Ермачкова Алина В.';
const ENABLE_VOICE = true;

if (!BOT_TOKEN) {
    console.error('❌ ОШИБКА: Не задан BOT_TOKEN в переменных BotHost');
    process.exit(1);
}

// Middleware с правильными CORS настройками
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Telegram-Init-Data'],
    credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

// ===== ПОДКЛЮЧЕНИЕ К БД (БЕЗ SSL для BotHost) =====
let pool;

function createPool() {
    if (process.env.DATABASE_URL) {
        console.log('🗄️ Использую DATABASE_URL');
        return new Pool({
            connectionString: process.env.DATABASE_URL,            ssl: false,
            connectionTimeoutMillis: 15000,
            max: 10
        });
    } else {
        console.log('🗄️ Использую отдельные параметры БД');
        return new Pool({
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT) || 5432,
            database: process.env.DB_NAME || 'chef_bot',
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD || '',
            ssl: false,
            connectionTimeoutMillis: 15000,
            max: 10
        });
    }
}

// ===== ИНИЦИАЛИЗАЦИЯ БД =====
async function initDB() {
    try {
        console.log('🔄 Подключение к БД...');
        pool = createPool();
        
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        console.log('✅ База данных подключена');
        
        // Создаём таблицы
        const tables = [
            `CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                tg_id BIGINT UNIQUE NOT NULL,
                username TEXT,
                first_name TEXT,
                free_recipes_used INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW()
            )`,
            `CREATE TABLE IF NOT EXISTS subscriptions (
                id SERIAL PRIMARY KEY,
                user_id BIGINT REFERENCES users(tg_id) ON DELETE CASCADE,
                starts_at TIMESTAMP DEFAULT NOW(),
                expires_at TIMESTAMP NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                plan_type VARCHAR(10) DEFAULT 'PRO',
                payment_receipt_id TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS payments (                id SERIAL PRIMARY KEY,
                user_id BIGINT REFERENCES users(tg_id),
                amount INTEGER NOT NULL,
                receipt_file_id TEXT,
                status VARCHAR(20) DEFAULT 'pending',
                plan_type VARCHAR(10) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                approved_by BIGINT,
                approved_at TIMESTAMP
            )`
        ];

        for (const q of tables) {
            await pool.query(q);
        }

        // Индексы
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_users_tg_id ON users(tg_id)',
            'CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_subs_active ON subscriptions(is_active, expires_at)',
            'CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)'
        ];
        
        for (const q of indexes) {
            try {
                await pool.query(q);
            } catch(e) {
                console.log('Index warning:', e.message);
            }
        }
        
        console.log('✅ Таблицы готовы');
    } catch (err) {
        console.error('❌ Ошибка подключения к БД:', err.message);
        throw err;
    }
}

// ===== БОТ ДЛЯ УВЕДОМЛЕНИЙ =====
const bot = new Telegraf(BOT_TOKEN);

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====
async function createUser(tgId, username, firstName) {
    await pool.query(
        `INSERT INTO users (tg_id, username, first_name, free_recipes_used) VALUES ($1, $2, $3, 0) ON CONFLICT (tg_id) DO NOTHING`,
        [tgId, username, firstName]
    );
}
async function getUser(tgId) {
    const { rows } = await pool.query(`SELECT * FROM users WHERE tg_id = $1`, [tgId]);
    return rows[0];
}

async function getFreeRecipesUsed(tgId) {
    const u = await getUser(tgId);
    return u?.free_recipes_used || 0;
}

async function incrementFreeRecipes(tgId) {
    await pool.query(`UPDATE users SET free_recipes_used = free_recipes_used + 1 WHERE tg_id = $1`, [tgId]);
}

async function resetFreeRecipes(tgId) {
    await pool.query(`UPDATE users SET free_recipes_used = 0 WHERE tg_id = $1`, [tgId]);
}

async function hasSubscription(tgId) {
    const { rows } = await pool.query(
        `SELECT * FROM subscriptions WHERE user_id = $1 AND is_active = TRUE AND expires_at > NOW() LIMIT 1`,
        [tgId]
    );
    return rows[0];
}

function parseSteps(fullText) {
    if (!fullText) return ['Текст рецепта не получен.'];
    const stepRegex = /(?:Шаг\s*\d+[.:\s-])|(?:^\d+.\s)/gim;
    const parts = fullText.split(stepRegex).filter(p => p.trim().length > 5);
    if (parts.length >= 2) return parts.map(p => p.trim());
    return fullText.split(/\n\s\n/).filter(p => p.trim().length > 10);
}

function cleanHtml(text) {
    if (!text) return '';
    let safe = text
        .replace(/`html/gi, '').replace(/`/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return safe;
}

function detectRequestType(text) {
    const lower = text.toLowerCase();
    const keywords = ['рецепт', 'приготовь', 'хочу', 'сделай', 'как сделать', 'борщ', 'салат', 'суп', 'паста', 'карбонара', 'омлет', 'плов', 'котлеты', 'торт', 'десерт'];
    if (keywords.some(k => lower.includes(k))) return 'dish';    if (text.includes(',')) return 'ingredients';
    return 'dish';
}

function buildPrompt(requestType, ingredients, details, planType) {
    const isVIP = planType === 'VIP';
    const system = `Ты элитный ИИ Шеф-Повар. Создавай подробные рецепты. Структура: 🍽 Название, 📝 Описание, 🥄 Ингредиенты, ⏱ Время, 🔥 Метод, 👨‍🍳 Шаги, ✨ Советы. ${isVIP ? 'Добавь 📊 КБЖУ.' : ''} Правила: используй только эмодзи для структуры.`;
    if (requestType === 'ingredients') {
        return { system, user: `Блюдо ТОЛЬКО из: ${ingredients}\nДоп: ${details || 'нет'}` };
    }
    return { system, user: `Рецепт: ${ingredients}\nДоп: ${details || 'нет'}` };
}

// ===== API ROUTES =====

// Get user status
app.get('/api/user/:tgId', async (req, res) => {
    const { tgId } = req.params;
    try {
        await createUser(tgId, null, null);
        
        const user = await getUser(tgId);
        const subscription = await hasSubscription(tgId);
        
        const hasActiveSub = !!subscription;
        const freeLeft = Math.max(0, FREE_LIMIT - (user?.free_recipes_used || 0));
        
        res.json({
            success: true,
            user: user,
            hasSubscription: hasActiveSub,
            subscription: subscription || null,
            freeRecipesLeft: freeLeft,
            canGenerate: hasActiveSub || freeLeft > 0,
            freeLimit: FREE_LIMIT,
            proPrice: PRO_PRICE,
            vipPrice: VIP_PRICE
        });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Generate recipe
app.post('/api/generate', async (req, res) => {
    const { tgId, query, details, planType } = req.body;
    
    if (!query || !tgId) {
        return res.status(400).json({ success: false, error: 'Missing parameters' });    }

    try {
        await createUser(tgId, null, null);
        
        const subscription = await hasSubscription(tgId);
        const user = await getUser(tgId);
        
        const hasSub = !!subscription;
        const freeUsed = user?.free_recipes_used || 0;
        
        if (!hasSub && freeUsed >= FREE_LIMIT) {
            return res.status(403).json({ 
                success: false, 
                error: 'FREE_LIMIT_REACHED',
                message: 'Лимит бесплатных рецептов исчерпан'
            });
        }
        
        const isVIP = planType === 'VIP' || (subscription?.plan_type === 'VIP');
        const requestType = detectRequestType(query);
        
        const prompt = buildPrompt(requestType, query, details, isVIP ? 'VIP' : 'FREE');
        
        let recipeText = await callGigaChat(prompt.system, prompt.user);
        recipeText = cleanHtml(recipeText);
        
        const steps = parseSteps(recipeText);
        
        // Извлекаем название
        let title = query;
        const titleMatch = recipeText.match(/🍽\s*([^\n]+)/);
        if (titleMatch) title = titleMatch[1].replace(/<\/?b>/g, '');
        
        // Извлекаем описание
        let description = '';
        const descMatch = recipeText.match(/📝\s*([^\n]+(?:\n[^🍽🥄⏱🔥✨]+)*)/);
        if (descMatch) description = descMatch[1].trim();
        
        // Извлекаем ингредиенты
        let ingredients = [];
        const ingredientsMatch = recipeText.match(/🥄\s*([^\n]+(?:\n[^🍽📝⏱🔥✨]+)*)/);
        if (ingredientsMatch) {
            ingredients = ingredientsMatch[1]
                .split('\n')
                .filter(l => l.trim())
                .map(l => l.replace(/^[•\-*\d.]\s*/, '').trim());
        }
        
        // Извлекаем время        let time = '30 минут';
        const timeMatch = recipeText.match(/⏱\s*([^\n]+)/);
        if (timeMatch) time = timeMatch[1].trim();
        
        // Извлекаем советы
        let tips = '';
        const tipsMatch = recipeText.match(/✨\s*([^\n]+(?:\n[^🍽📝🥄⏱🔥]+)*)/);
        if (tipsMatch) tips = tipsMatch[1].trim();
        
        // Извлекаем КБЖУ для VIP
        let nutrition = null;
        if (isVIP) {
            const nutritionMatch = recipeText.match(/📊\s*([^\n]+(?:\n[^🍽📝🥄⏱🔥✨]+)*)/);
            if (nutritionMatch) {
                nutrition = { text: nutritionMatch[1].trim() };
            }
        }
        
        const recipe = {
            title,
            description,
            ingredients,
            time,
            steps: steps.map(s => cleanHtml(s)),
            tips,
            nutrition,
            fullText: recipeText
        };
        
        if (!hasSub) {
            await incrementFreeRecipes(tgId);
        }
        
        res.json({
            success: true,
            recipe,
            isVIP,
            freeLeft: hasSub ? '∞' : FREE_LIMIT - (freeUsed + 1)
        });
        
    } catch (error) {
        console.error('Generation error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create payment
app.post('/api/create-payment', async (req, res) => {
    const { tgId, planType, amount } = req.body;
        try {
        const result = await pool.query(
            `INSERT INTO payments (user_id, amount, status, plan_type) 
             VALUES ($1, $2, 'pending', $3) RETURNING id`,
            [tgId, amount, planType]
        );
        
        res.json({
            success: true,
            paymentId: result.rows[0].id,
            sbpPhone: SBP_PHONE,
            sbpRecipient: SBP_RECIPIENT
        });
    } catch (error) {
        console.error('Payment creation error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Upload receipt
app.post('/api/upload-receipt', upload.single('receipt'), async (req, res) => {
    const { tgId, paymentId, planType, amount } = req.body;
    
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    try {
        const fileId = `receipt_${Date.now()}_${tgId}`;
        
        await pool.query(
            `UPDATE payments SET receipt_file_id = $1, status = 'pending' 
             WHERE id = $2 AND user_id = $3`,
            [fileId, paymentId, tgId]
        );
        
        if (ADMIN_ID) {
            const user = await getUser(tgId);
            const caption = `🚨 Новая оплата #${paymentId}\n👤 ${user?.first_name || user?.username || tgId}\n💎 ${planType} | 💰 ${amount}₽\n📱 ID: ${tgId}`;
            
            const keyboard = {
                inline_keyboard: [
                    [{ text: '✅ Одобрить', callback_data: `approve_${paymentId}` }],
                    [{ text: '❌ Отклонить', callback_data: `reject_${paymentId}` }]
                ]
            };
            
            try {
                await bot.telegram.sendMessage(ADMIN_ID, caption, {
                    reply_markup: keyboard                });
            } catch (e) {
                console.error('Admin notification error:', e);
            }
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Receipt upload error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Voice transcription
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No audio file' });
        }
        
        const text = await transcribeVoice(req.file.buffer);
        res.json({ success: true, text: text || '' });
    } catch (error) {
        console.error('STT error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get user subscriptions
app.get('/api/subscriptions/:tgId', async (req, res) => {
    const { tgId } = req.params;
    try {
        const { rows } = await pool.query(
            `SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY starts_at DESC`,
            [tgId]
        );
        res.json({ success: true, subscriptions: rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get user payments
app.get('/api/payments/:tgId', async (req, res) => {
    const { tgId } = req.params;
    try {
        const { rows } = await pool.query(
            `SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
            [tgId]
        );        res.json({ success: true, payments: rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// WebApp endpoint
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date(),
        bot: BOT_TOKEN ? 'configured' : 'missing',
        admin: ADMIN_ID || 'not set'
    });
});

// ===== CRON ЗАДАЧИ =====
function setupCron() {
    cron.schedule('0 10 * * *', async () => {
        console.log('⏰ [CRON] Проверка подписок...');
        try {
            const { rows } = await pool.query(
                `SELECT u.tg_id, s.expires_at, s.plan_type, u.first_name 
                 FROM subscriptions s 
                 JOIN users u ON s.user_id = u.tg_id 
                 WHERE s.is_active = TRUE AND s.expires_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'`
            );
            
            for (const sub of rows) {
                const days = Math.ceil((new Date(sub.expires_at) - new Date()) / 86400000);
                try {
                    await bot.telegram.sendMessage(sub.tg_id,
                        `⏰ <b>Подписка "${sub.plan_type}" истекает через ${days} ${getDaysWord(days)}</b>\n\n` +
                        `Продлите подписку, чтобы продолжить пользоваться всеми возможностями бота!`,
                        { parse_mode: 'HTML' }
                    );
                } catch (e) {
                    console.error(`Failed to notify user ${sub.tg_id}:`, e.message);
                }
            }
            
            const { rowCount } = await pool.query(
                `UPDATE subscriptions SET is_active = FALSE WHERE expires_at < NOW()`
            );
            if (rowCount > 0) console.log(`✅ Деактивировано ${rowCount} просроченных подписок`);            
        } catch (e) { 
            console.error('CRON error:', e.message); 
        }
    }, { timezone: 'Europe/Moscow' });

    cron.schedule('0 3 */3 * *', async () => {
        console.log('⏰ [CRON] Очистка старых платежей...');
        try {
            const { rowCount } = await pool.query(
                `DELETE FROM payments WHERE status = 'pending' AND created_at < NOW() - INTERVAL '7 days'`
            );
            if (rowCount > 0) console.log(`🗑️ Удалено ${rowCount} старых платежей`);
        } catch (e) {
            console.error('Cleanup error:', e.message);
        }
    }, { timezone: 'Europe/Moscow' });
}

function getDaysWord(days) {
    if (days % 10 === 1 && days % 100 !== 11) return 'день';
    if ([2, 3, 4].includes(days % 10) && ![12, 13, 14].includes(days % 100)) return 'дня';
    return 'дней';
}

// ===== ОБРАБОТЧИКИ БОТА =====
bot.start(async (ctx) => {
    if (ctx.from.id === ADMIN_ID) {
        try {
            const { rows: stats } = await pool.query(
                `SELECT 
                    (SELECT COUNT(*) FROM users) as users, 
                    (SELECT COUNT(*) FROM subscriptions WHERE is_active = TRUE) as subs, 
                    (SELECT COUNT(*) FROM payments WHERE status = 'pending') as pending, 
                    (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'approved') as revenue`
            );
            
            const msg = `👨‍🍳 <b>Панель администратора</b>\n\n` +
                `📊 <b>Статистика:</b>\n` +
                `• Всего пользователей: ${stats[0].users}\n` +
                `• Активных подписок: ${stats[0].subs}\n` +
                `• Ожидающих оплат: ${stats[0].pending}\n` +
                `• Выручка: ${stats[0].revenue}₽`;
            
            await ctx.reply(msg, { 
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        ['📋 Ожидающие оплаты', '📥 Экспорт подписок'],
                        ['📊 Статистика', 'ℹ️ Помощь']                    ],
                    resize_keyboard: true
                }
            });
        } catch (e) {
            ctx.reply('❌ Ошибка: ' + e.message);
        }
        return;
    }

    const webAppUrl = `https://bot-1779392471-6640-zahar0304.bothost.tech`;

    await ctx.reply(
        `👨‍🍳 <b>Добро пожаловать в Шеф-Повар AI!</b>\n\n` +
        `Я помогу тебе приготовить вкусные блюда. Открой меню, чтобы начать!`,
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🍳 Открыть Шеф-Повара', web_app: { url: webAppUrl } }]
                ]
            }
        }
    );
});

// Admin handlers
bot.hears('📋 Ожидающие оплаты', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    try {
        const { rows } = await pool.query(
            `SELECT p.id, u.first_name, u.username, p.amount, p.created_at, p.plan_type 
             FROM payments p 
             JOIN users u ON p.user_id = u.tg_id 
             WHERE p.status = 'pending' 
             ORDER BY p.created_at DESC LIMIT 10`
        );
        
        if (rows.length === 0) {
            return ctx.reply('✅ Нет ожидающих оплат');
        }
        
        let msg = `📋 <b>Ожидающие оплаты (${rows.length}):</b>\n\n`;
        rows.forEach(r => {
            msg += `<b>#${r.id}</b> — ${r.first_name || '?'} (@${r.username || 'нет'})\n`;
            msg += `💎 ${r.plan_type} | 💰 ${r.amount}₽ | ${new Date(r.created_at).toLocaleDateString()}\n\n`;
        });
        ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (e) { 
        ctx.reply('❌ Ошибка: ' + e.message);     }
});

bot.hears('📊 Статистика', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    try {
        const { rows: stats } = await pool.query(
            `SELECT 
                (SELECT COUNT(*) FROM users) as total, 
                (SELECT COUNT(*) FROM subscriptions WHERE is_active = TRUE) as active, 
                (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'approved') as revenue, 
                (SELECT COUNT(*) FROM users WHERE free_recipes_used > 0) as used_free`
        );
        
        const msg = `📊 <b>Детальная статистика:</b>\n\n` +
            `👥 Пользователей: ${stats[0].total}\n` +
            `✨ Активных подписок: ${stats[0].active}\n` +
            `💰 Выручка: ${stats[0].revenue}₽\n` +
            `🎁 Использовали бесплатные рецепты: ${stats[0].used_free}`;
        
        ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (e) { 
        ctx.reply('❌ Ошибка: ' + e.message); 
    }
});

bot.hears('📥 Экспорт подписок', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    try {
        const { rows } = await pool.query(
            `SELECT u.tg_id, u.first_name, u.username, u.created_at, s.plan_type, s.expires_at, s.is_active 
             FROM users u 
             LEFT JOIN subscriptions s ON u.tg_id = s.user_id AND s.is_active = TRUE 
             ORDER BY u.created_at DESC`
        );
        
        let csv = 'ID,Имя,Username,Дата регистрации,План,До,Активна\n';
        rows.forEach(r => {
            csv += `"${r.tg_id}","${r.first_name || ''}","${r.username || ''}","${r.created_at}","${r.plan_type || 'FREE'}","${r.expires_at || ''}","${r.is_active || false}"\n`;
        });
        
        ctx.replyWithDocument({ source: Buffer.from(csv, 'utf-8'), filename: 'subscribers.csv' });
    } catch (e) {
        ctx.reply('❌ Ошибка: ' + e.message);
    }
});

bot.hears('ℹ️ Помощь', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.reply(        `📚 <b>Помощь по боту</b>\n\n` +
        `• Одобрение платежей происходит вручную\n` +
        `• Все данные хранятся в PostgreSQL\n` +
        `• Бот использует GigaChat для генерации рецептов\n` +
        `• Voice input работает через Yandex SpeechKit`,
        { parse_mode: 'HTML' }
    );
});

// Admin actions for payments
bot.action(/^approve_(\d+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.answerCbQuery('🔒 Только для админа', { show_alert: true });
    }
    
    try {
        const paymentId = ctx.match[1];
        const { rows: [payment] } = await pool.query(`SELECT * FROM payments WHERE id = $1`, [paymentId]);
        
        if (!payment) {
            return ctx.answerCbQuery('❌ Платеж не найден', { show_alert: true });
        }
        
        if (payment.status !== 'pending') {
            return ctx.answerCbQuery(`❌ Платеж уже ${payment.status}`, { show_alert: true });
        }
        
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);
        
        await pool.query(`UPDATE subscriptions SET is_active = FALSE WHERE user_id = $1`, [payment.user_id]);
        await pool.query(
            `INSERT INTO subscriptions (user_id, is_active, expires_at, plan_type) 
             VALUES ($1, TRUE, $2, $3)`,
            [payment.user_id, expiresAt, payment.plan_type]
        );
        await pool.query(`UPDATE users SET free_recipes_used = 0 WHERE tg_id = $1`, [payment.user_id]);
        await pool.query(
            `UPDATE payments SET status = 'approved', approved_by = $1, approved_at = NOW() WHERE id = $2`,
            [ADMIN_ID, payment.id]
        );
        
        await ctx.answerCbQuery('✅ Оплата одобрена');
        await ctx.editMessageCaption(`✅ #${payment.id} | ${payment.plan_type} | Одобрено`);
        
        try {
            await ctx.telegram.sendMessage(
                payment.user_id,
                `🎉 <b>${payment.plan_type} подписка активирована!</b>\n\n` +
                `📅 Действует до: ${expiresAt.toLocaleDateString('ru-RU')}\n` +                `🍳 Готовьте с удовольствием!`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {
            console.error('Failed to notify user:', e.message);
        }
        
    } catch(e) { 
        console.error('Approve error:', e);
        await ctx.answerCbQuery('❌ Ошибка', { show_alert: true }); 
    }
});

bot.action(/^reject_(\d+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.answerCbQuery('🔒 Только для админа', { show_alert: true });
    }
    
    try {
        const paymentId = ctx.match[1];
        const { rows: [payment] } = await pool.query(`SELECT * FROM payments WHERE id = $1`, [paymentId]);
        
        if (!payment) {
            return ctx.answerCbQuery('❌ Платеж не найден', { show_alert: true });
        }
        
        await pool.query(`UPDATE payments SET status = 'rejected' WHERE id = $1`, [payment.id]);
        await ctx.answerCbQuery('❌ Оплата отклонена');
        await ctx.editMessageCaption(`❌ #${payment.id} | Отклонено`);
        
        try {
            await ctx.telegram.sendMessage(
                payment.user_id,
                `❌ <b>Оплата отклонена</b>\n\n` +
                `📋 #${payment.id}\n` +
                `Причина: чек не соответствует требованиям\n\n` +
                `Попробуйте оплатить снова и отправить четкий чек.`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {
            console.error('Failed to notify user:', e.message);
        }
        
    } catch(e) { 
        console.error('Reject error:', e);
        await ctx.answerCbQuery('❌ Ошибка', { show_alert: true }); 
    }
});

    // ===== ЗАПУСК (IIFE - самовызывающаяся async функция) =====
(async () => {
    try {
        await initDB();
        setupCron();
        
        // Запускаем сервер
        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📱 WebApp available at https://bot-1779392471-6640-zahar0304.bothost.tech`);
            console.log(`🤖 Bot polling mode active`);
            console.log(`👨‍💼 Admin ID: ${ADMIN_ID}`);
        });

        // Запускаем бота в polling mode (без вебхука)
        await bot.launch();
        console.log('✅ Bot started in polling mode');
    } catch (err) {
        console.error('❌ Fatal error:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();

// Обработка завершения процесса
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = { pool, bot };
