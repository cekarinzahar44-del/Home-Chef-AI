// BotHost: отключаем предупреждения о самоподписанных сертификатах
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const { Pool } = require('pg');

// ===== КОНФИГ =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 0;
const PORT = parseInt(process.env.PORT) || 3000;
const MINI_APP_URL = process.env.MINI_APP_URL;

if (!BOT_TOKEN) {
  console.error('❌ Не задан BOT_TOKEN');
  process.exit(1);
}

// Папка для чеков
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ===== БД =====
function createPool() {
  if (process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: false,
      connectionTimeoutMillis: 15000,
      max: 10
    });
  }
  return new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: false,
    max: 10
  });
}

const pool = createPool();
global.pool = pool;
// ===== EXPRESS =====
const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', require('./api'));

app.get('/health', (req, res) => res.send('OK'));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== TELEGRAM =====
const bot = new Telegraf(BOT_TOKEN);

// Глобальные уведомления админу
global.notifyAdmin = async (text, keyboard) => {
  try {
    await bot.telegram.sendMessage(ADMIN_ID, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  } catch (e) {
    console.error('Notify error:', e.message);
  }
};

global.sendPhotoToAdmin = async (filePath, caption, keyboard) => {
  try {
    await bot.telegram.sendPhoto(ADMIN_ID, { source: filePath }, {
      caption,
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  } catch (e) {
    console.error('Photo error:', e.message);
  }
};

// /start
bot.start(async (ctx) => {
  if (ctx.from.id === ADMIN_ID) {
    // Показываем админ-панель
    const { Markup } = require('telegraf');
    try {
      const { rows: stats } = await pool.query(`
        SELECT 
          (SELECT COUNT(*) FROM users) as users,          (SELECT COUNT(*) FROM subscriptions WHERE is_active=TRUE) as subs,
          (SELECT COUNT(*) FROM payments WHERE status='pending') as pending
      `);
      const msg = `👨‍💼 <b>Панель администратора</b>\n\n` +
        `📊 <b>Статистика:</b>\n` +
        `• 👥 Пользователей: ${stats[0].users}\n` +
        `• 💎 Активных подписок: ${stats[0].subs}\n` +
        `• ⏳ Ожидающих оплат: ${stats[0].pending}\n\n` +
        `💳 Одобрение оплат — через кнопки под фото чека в этом чате.`;

      await ctx.reply(msg, {
        parse_mode: 'HTML',
        reply_markup: Markup.keyboard([
          ['📋 Ожидающие оплаты', '📥 Экспорт подписок'],
          ['📊 Статистика', 'ℹ️ Помощь']
        ]).resize()
      });
    } catch (e) {
      ctx.reply('❌ Ошибка: ' + e.message);
    }
    return;
  }

  // Обычный пользователь
  await pool.query(
    `INSERT INTO users (tg_id, username, first_name, free_recipes_used) 
     VALUES ($1,$2,$3,0) ON CONFLICT (tg_id) DO NOTHING`,
    [ctx.from.id, ctx.from.username, ctx.from.first_name]
  );

  await ctx.reply(
    '👨‍🍳 <b>Шеф-Повар AI</b>\n\n' +
    'Создаю уникальные рецепты с помощью ИИ!\n\n' +
    '👇 Открой приложение и начни готовить:',
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '🚀 Открыть Шеф-Повар', web_app: { url: MINI_APP_URL } }
        ]]
      }
    }
  );
});

// ===== ЗАПУСК =====
async function start() {
  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL подключен');  } catch (err) {
    console.error('❌ БД ошибка:', err.message);
    process.exit(1);
  }

  // Таблицы
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
      plan_type VARCHAR(10) DEFAULT 'PRO'
    )`,
    `CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(tg_id),
      amount INTEGER NOT NULL,
      receipt_file_path TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      plan_type VARCHAR(10) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`
  ];
  for (const q of tables) await pool.query(q);

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_users_tg ON users(tg_id)',
    'CREATE INDEX IF NOT EXISTS idx_subs_active ON subscriptions(is_active, expires_at)',
    'CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)'
  ];
  for (const q of indexes) await pool.query(q).catch(() => {});

  // Cron: уведомления об истечении подписок
  cron.schedule('0 10 * * *', async () => {
    try {
      const { rows } = await pool.query(
        `SELECT u.tg_id, s.expires_at, s.plan_type 
         FROM subscriptions s 
         JOIN users u ON s.user_id = u.tg_id 
         WHERE s.is_active = TRUE AND s.expires_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'`      );
      for (const s of rows) {
        const days = Math.ceil((new Date(s.expires_at) - new Date()) / 86400000);
        await bot.telegram.sendMessage(s.tg_id,
          `⏰ <b>Подписка ${s.plan_type} истекает через ${days} д.</b>`,
          { parse_mode: 'HTML' }
        );
      }
      await pool.query(`UPDATE subscriptions SET is_active = FALSE WHERE expires_at < NOW()`);
    } catch (e) { console.error('CRON:', e); }
  }, { timezone: 'Europe/Moscow' });

  // Загрузка модулей
  require('./bot')(bot, pool, ADMIN_ID);
  require('./admin-handlers')(bot, pool, ADMIN_ID);

  // Сервер + бот
  app.listen(PORT, () => console.log(`🌐 Mini App: http://localhost:${PORT}`));
  await bot.launch({ dropPendingUpdates: true });
  const me = await bot.telegram.getMe();
  console.log(`🚀 Бот: @${me.username} | Admin: ${ADMIN_ID}`);

  // Menu Button (слева от поля ввода)
  if (MINI_APP_URL) {
    bot.telegram.setChatMenuButton({
      menu_button: {
        type: 'web_app',
        text: '🍳 Шеф-Повар',
        web_app: { url: MINI_APP_URL }
      }
    }).catch(() => {});
  }

  process.once('SIGINT', () => { bot.stop('SIGINT'); pool.end(); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); pool.end(); });
}

start().catch(err => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
