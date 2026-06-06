// ВНИМАНИЕ: GigaChat (Сбер) использует сертификаты «Russian Trusted CA»,
// которых нет в стандартном хранилище Node. Отключение проверки TLS — известный
// компромисс ради работы ИИ. Рекомендация для production: установить корневые
// сертификаты Минцифры и передавать их через NODE_EXTRA_CA_CERTS вместо этой строки.
// Подробнее: docs/SECURITY.md
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
// Отображаемые названия тарифов (внутренние коды PRO/VIP не меняем)
const PLAN_NAMES = { FREE: 'Бесплатно', PRO: 'Стандарт', VIP: 'Про' };
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
// ===== ЛЕНТА ПОСЛЕДНИХ ОШИБОК (для мониторинга в админке) =====
global.errorLog = [];
global.recordError = (context, message) => {
  try {
    global.errorLog.unshift({ context, message: String(message).slice(0, 300), at: Date.now() });
    if (global.errorLog.length > 50) global.errorLog.length = 50;
  } catch {}
};
// ===== EXPRESS =====
const { securityHeaders, createRateLimiter } = require('./middleware/security');
const app = express();
// За реверс-прокси (Nginx и т.п.) — чтобы req.ip и rate-limit работали корректно
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
// Защита API от абьюза (важно: ИИ-запросы стоят денег). Лимит щедрый —
// обычные пользователи его не замечают. Отключается через RATE_LIMIT_ENABLED=false.
if (process.env.RATE_LIMIT_ENABLED !== 'false') {
  app.use('/api', createRateLimiter({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 240
  }));
}
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', require('./api'));

// Health-check с реальной проверкой БД — для мониторинга и оркестраторов
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up', uptime: Math.round(process.uptime()) });
  } catch (e) {
    res.status(503).json({ status: 'error', db: 'down' });
  }
});

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
    // Проверяем существование файла
    const fileExists = fs.existsSync(filePath);
    console.log('📤 sendPhotoToAdmin called:', {
      filePath,
      adminId: ADMIN_ID,
      fileExists
    });

    if (!fileExists) {
      console.error('❌ Файл не существует:', filePath);
      // Отправляем текстовое уведомление как fallback
      try {
        await bot.telegram.sendMessage(ADMIN_ID, 
          `⚠️ Файл не найден: ${filePath}\n\n${caption.replace(/<[^>]+>/g, '')}`, 
          { parse_mode: 'HTML', reply_markup: keyboard }
        );
      } catch (e) {
        console.error('❌ Fallback message error:', e.message);
      }
      return;
    }

    // Отправка фото через bot.telegram.sendPhoto
    console.log('📤 Отправка фото через bot.telegram.sendPhoto...');
    const result = await bot.telegram.sendPhoto(
      ADMIN_ID, 
      filePath, // Передаем путь напрямую (не объект {source: ...})
      {
        caption,
        parse_mode: 'HTML',
        reply_markup: keyboard      }
    );
    console.log('✅ Фото отправлено. Message ID:', result.message_id);
  } catch (e) {
    console.error('❌ Photo send error:', e.message);
    console.error('Description:', e.description);
    console.error('Code:', e.code);
    
    // Fallback: отправляем текстом
    try {
      await bot.telegram.sendMessage(ADMIN_ID, 
        `⚠️ Не удалось отправить фото, но заявка есть:\n\n${caption}`, 
        { parse_mode: 'HTML', reply_markup: keyboard }
      );
      console.log('✅ Fallback текст отправлен');
    } catch (fallbackError) {
      console.error('❌ Fallback тоже не сработал:', fallbackError.message);
    }
  }
};
// /start - ОДИНАКОВЫЙ для всех (включая админа)
bot.start(async (ctx) => {
  await pool.query(
    `INSERT INTO users (tg_id, username, first_name, free_recipes_used) VALUES ($1,$2,$3,0) ON CONFLICT (tg_id) DO NOTHING`,
    [ctx.from.id, ctx.from.username, ctx.from.first_name]
  );
  // Кнопки для всех
  const buttons = [
    [{ text: '🚀 Открыть Шеф-Повар', web_app: { url: MINI_APP_URL } }]
  ];
  // Админу добавляем кнопку веб-админки
  if (ctx.from.id === ADMIN_ID && MINI_APP_URL) {
    buttons.push([
      { text: '👨‍💼 Открыть Админку', web_app: { url: `${MINI_APP_URL}/admin.html` } }
    ]);
    await ctx.reply(
      '👨‍💼 <b>Привет, Админ!</b>\n\n' +
      '🍳 Открой Шеф-Повар для теста\n' +
      '📊 Или зайди в веб-админку для управления',
      { 
        parse_mode: 'HTML', 
        reply_markup: { inline_keyboard: buttons } 
      }
    );
    return;
  }
  await ctx.reply(
    '👨‍🍳 <b>Шеф-Повар AI</b>\n\n' +
    'Создаю уникальные рецепты с помощью ИИ!\n\n' +
    '👇 Открой приложение и начни готовить:',    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }
  );
});
// ===== ЗАПУСК =====
async function start() {
  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL подключен');
  } catch (err) {
    console.error('❌ БД ошибка:', err.message);
    process.exit(1);
  }
  // ===== СОЗДАНИЕ ТАБЛИЦ =====
  const tables = [
    `CREATE TABLE IF NOT EXISTS users ( id SERIAL PRIMARY KEY, tg_id BIGINT UNIQUE NOT NULL, username TEXT, first_name TEXT, free_recipes_used INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW() )`,
    `CREATE TABLE IF NOT EXISTS subscriptions ( id SERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(tg_id) ON DELETE CASCADE, starts_at TIMESTAMP DEFAULT NOW(), expires_at TIMESTAMP NOT NULL, is_active BOOLEAN DEFAULT TRUE, plan_type VARCHAR(10) DEFAULT 'PRO' )`,
    `CREATE TABLE IF NOT EXISTS payments ( id SERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(tg_id), amount INTEGER NOT NULL, receipt_file_path TEXT, status VARCHAR(20) DEFAULT 'pending', plan_type VARCHAR(10) NOT NULL, created_at TIMESTAMP DEFAULT NOW() )`
  ];
  for (const q of tables) await pool.query(q);
  console.log('✅ Таблицы созданы/проверены');
  // ===== МИГРАЦИИ =====
  const migrations = [
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='receipt_file_id') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='receipt_file_path') THEN ALTER TABLE payments RENAME COLUMN receipt_file_id TO receipt_file_path; END IF; END $$;`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='receipt_file_path') THEN ALTER TABLE payments ADD COLUMN receipt_file_path TEXT; END IF; END $$;`,
    `ALTER TABLE payments ALTER COLUMN receipt_file_path DROP NOT NULL`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_banned') THEN ALTER TABLE users ADD COLUMN is_banned BOOLEAN DEFAULT FALSE; END IF; END $$;`,
    // Базовые поля онбординга
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='allergies') THEN ALTER TABLE users ADD COLUMN allergies TEXT DEFAULT ''; END IF; END $$;`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='onboarding_done') THEN ALTER TABLE users ADD COLUMN onboarding_done BOOLEAN DEFAULT FALSE; END IF; END $$;`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='free_weekmenu_used') THEN ALTER TABLE users ADD COLUMN free_weekmenu_used BOOLEAN DEFAULT FALSE; END IF; END $$;`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='preferred_portions') THEN ALTER TABLE users ADD COLUMN preferred_portions INTEGER DEFAULT 2; END IF; END $$;`,
    // VIP режимы — семья и фитнес
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='mode') THEN ALTER TABLE users ADD COLUMN mode VARCHAR(20) DEFAULT 'standard'; END IF; END $$;`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='family_kids') THEN ALTER TABLE users ADD COLUMN family_kids TEXT DEFAULT ''; END IF; END $$;`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='disliked_products') THEN ALTER TABLE users ADD COLUMN disliked_products TEXT DEFAULT ''; END IF; END $$;`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='favorite_products') THEN ALTER TABLE users ADD COLUMN favorite_products TEXT DEFAULT ''; END IF; END $$;`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='fitness_goal') THEN ALTER TABLE users ADD COLUMN fitness_goal VARCHAR(20); END IF; END $$;`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='daily_calories') THEN ALTER TABLE users ADD COLUMN daily_calories INTEGER; END IF; END $$;`,
    // Уведомления — для активного бота
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='daily_reminder') THEN ALTER TABLE users ADD COLUMN daily_reminder BOOLEAN DEFAULT TRUE; END IF; END $$;`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='last_recipe_at') THEN ALTER TABLE users ADD COLUMN last_recipe_at TIMESTAMPTZ; END IF; END $$;`,

    // Таблица сохранённых рецептов (история + избранное)
    `CREATE TABLE IF NOT EXISTS recipes (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      title TEXT NOT NULL,
      full_text TEXT NOT NULL,
      is_favorite BOOLEAN DEFAULT FALSE,
      rating SMALLINT,
      cooked_count INTEGER DEFAULT 0,
      tags TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_recipes_user ON recipes(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_recipes_fav ON recipes(user_id, is_favorite) WHERE is_favorite=TRUE`,
    // Личные заметки к рецепту («в этот раз меньше соли») — профиль вкуса
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='recipes' AND column_name='notes') THEN ALTER TABLE recipes ADD COLUMN notes TEXT DEFAULT ''; END IF; END $$;`,

    // История блюд из меню на неделю — чтобы не повторялись
    `CREATE TABLE IF NOT EXISTS weekmenu_dishes (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      dish_name TEXT NOT NULL,
      meal_type VARCHAR(20),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_weekmenu_dishes_user ON weekmenu_dishes(user_id, created_at DESC)`
  ];
  for (const m of migrations) {
    try { await pool.query(m); } catch (e) {}
  }
  // ===== ИНДЕКСЫ =====
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_users_tg ON users(tg_id)',
    'CREATE INDEX IF NOT EXISTS idx_subs_active ON subscriptions(is_active, expires_at)',
    'CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)',
    'CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id)'
  ];  
  for (const q of indexes) await pool.query(q).catch(() => {});
  // ===== CRON: истекающие подписки =====
  cron.schedule('0 10 * * *', async () => {
    try {
      const { rows } = await pool.query(
        `SELECT u.tg_id, s.expires_at, s.plan_type FROM subscriptions s JOIN users u ON s.user_id = u.tg_id WHERE s.is_active = TRUE AND s.expires_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'`
      );
      for (const s of rows) {
        const days = Math.ceil((new Date(s.expires_at) - new Date()) / 86400000);
        await bot.telegram.sendMessage(s.tg_id,
          `⏰ <b>Подписка «${PLAN_NAMES[s.plan_type] || s.plan_type}» истекает через ${days} д.</b>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
      await pool.query(`UPDATE subscriptions SET is_active = FALSE WHERE expires_at < NOW()`);
    } catch (e) { console.error('CRON expiry:', e); }
  }, { timezone: 'Europe/Moscow' });

  // ===== CRON: ежедневное напоминание в 17:00 =====
  const DAILY_PROMPTS = [
    { emoji: '🍝', text: 'Что будем готовить сегодня?' },
    { emoji: '🍲', text: 'Время подумать про ужин!' },
    { emoji: '🥘', text: 'Шеф уже на кухне, ждём только тебя 😊' },
    { emoji: '🍳', text: 'Не знаешь что приготовить? Я подскажу!' },
    { emoji: '🥗', text: 'Что-то быстрое и вкусное на ужин?' }
  ];
  cron.schedule('0 17 * * *', async () => {
    try {
      // Берём только тех у кого включены напоминания и кто заходил последние 14 дней
      const { rows } = await pool.query(
        `SELECT tg_id, first_name FROM users
         WHERE daily_reminder = TRUE
           AND is_banned = FALSE
           AND onboarding_done = TRUE
         LIMIT 5000`
      );
      console.log(`[CRON] Daily reminders: ${rows.length} users`);
      for (const u of rows) {
        const p = DAILY_PROMPTS[Math.floor(Math.random() * DAILY_PROMPTS.length)];
        const name = u.first_name ? `, ${u.first_name}` : '';
        try {
          await bot.telegram.sendMessage(u.tg_id,
            `${p.emoji} <b>Привет${name}!</b>\n${p.text}`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                  { text: '👨‍🍳 Открыть Шеф-Повара', web_app: { url: MINI_APP_URL } }
                ]]
              }
            }
          );
          // Между сообщениями небольшая задержка чтобы не словить rate limit
          await new Promise(r => setTimeout(r, 50));
        } catch (e) {
          // Бот заблокирован пользователем — отключаем напоминания
          if (e.code === 403) {
            await pool.query('UPDATE users SET daily_reminder=FALSE WHERE tg_id=$1', [u.tg_id]).catch(() => {});
          }
        }
      }
    } catch (e) { console.error('CRON daily:', e); }
  }, { timezone: 'Europe/Moscow' });

  // ===== CRON: вернуть тех кто не готовил 5+ дней (раз в неделю в среду 12:00) =====
  cron.schedule('0 12 * * 3', async () => {
    try {
      const { rows } = await pool.query(
        `SELECT tg_id, first_name FROM users
         WHERE daily_reminder = TRUE
           AND is_banned = FALSE
           AND onboarding_done = TRUE
           AND (last_recipe_at IS NULL OR last_recipe_at < NOW() - INTERVAL '5 days')
           AND created_at < NOW() - INTERVAL '7 days'
         LIMIT 2000`
      );
      console.log(`[CRON] Win-back: ${rows.length} users`);
      for (const u of rows) {
        const name = u.first_name ? ` ${u.first_name}` : '';
        try {
          await bot.telegram.sendMessage(u.tg_id,
            `👋 Скучаю по тебе${name}!\n\nДавно не готовили вместе. Может быть что-то простое и вкусное на ужин? 🍽`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                  { text: '🍳 Открыть приложение', web_app: { url: MINI_APP_URL } }
                ]]
              }
            }
          );
          await new Promise(r => setTimeout(r, 50));
        } catch (e) {
          if (e.code === 403) {
            await pool.query('UPDATE users SET daily_reminder=FALSE WHERE tg_id=$1', [u.tg_id]).catch(() => {});
          }
        }
      }
    } catch (e) { console.error('CRON winback:', e); }
  }, { timezone: 'Europe/Moscow' });
  // ===== ЗАГРУЗКА МОДУЛЕЙ (только bot.js для approve/reject) =====
  require('./bot')(bot, pool, ADMIN_ID);
  // admin-handlers НЕ загружаем!
  // ===== ЗАПУСК =====
  app.listen(PORT, () => console.log(`🌐 Mini App: http://localhost:${PORT}`));
  await bot.launch({ dropPendingUpdates: true });
  const me = await bot.telegram.getMe();
  console.log(`🚀 Бот: @${me.username} | Admin: ${ADMIN_ID}`);
  console.log(`🌐 Веб-админка: ${MINI_APP_URL}/admin.html`);
  // Menu Button (для всех пользователей)
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
