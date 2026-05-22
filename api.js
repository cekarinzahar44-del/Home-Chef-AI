const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { validateTelegramAuth } = require('./auth');
const { callGigaChat } = require('./gigachat');
const { transcribeVoice } = require('./stt');

const router = express.Router();

const FREE_LIMIT = 3;
const PRO_PRICE = 500;
const VIP_PRICE = 800;
const SBP_PHONE = process.env.SBP_PHONE || '+79022231321';
const SBP_RECIPIENT = process.env.SBP_RECIPIENT || 'Ермачкова Алина В.';
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 0;

// ===== Multer =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `receipt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });
const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ===== Auth middleware для пользователей =====
const userAuth = (req, res, next) => {
  const initData = req.header('x-telegram-init-data');
  if (!initData) return res.status(401).json({ error: 'No initData' });
  const user = validateTelegramAuth(initData, process.env.BOT_TOKEN);
  if (!user) return res.status(401).json({ error: 'Invalid initData' });
  req.telegramUser = user;
  next();
};

// ===== Auth middleware для админа =====
const adminAuth = (req, res, next) => {
  const initData = req.header('x-telegram-init-data');
  if (!initData) return res.status(401).json({ error: 'No initData' });
  const user = validateTelegramAuth(initData, process.env.BOT_TOKEN);
  if (!user) return res.status(401).json({ error: 'Invalid initData' });
  if (user.id !== ADMIN_ID) return res.status(403).json({ error: 'Admin only' });
  req.telegramUser = user;
  next();
};
// ============================================
// 🧑 ПОЛЬЗОВАТЕЛЬСКИЕ ЭНДПОИНТЫ
// ============================================

router.use(userAuth); // По умолчанию все роуты требуют авторизацию юзера

// ===== HELPERS =====
function detectRequestType(text) {
  const lower = text.toLowerCase();
  const keywords = [
    'рецепт','приготовь','хочу','сделай','как сделать',
    'борщ','салат','суп','паста','карбонара','омлет','плов',
    'котлеты','торт','десерт','пицца','блины','шашлык','гуляш','рагу','запеканка'
  ];
  if (keywords.some(k => lower.includes(k))) return 'dish';
  if (text.includes(',')) return 'ingredients';
  return 'dish';
}

function buildPrompt(requestType, ingredients, details, planType) {
  const isVIP = planType === 'VIP';
  const system = `Ты элитный ИИ Шеф-Повар. Создавай подробные рецепты.
Структура: 🍽 Название, 📝 Описание, Ингредиенты, Время, 🔥 Метод, 👨‍🍳 Шаги, Советы, 🍷 Напитки.
Каждый шаг: ⏱ время | температура | действия.
${isVIP ? 'Добавь 📊 КБЖУ на порцию.' : ''}
Правила: используй эмодзи для структуры, не используй HTML.`;
  const user = requestType === 'ingredients'
    ? `Блюдо ТОЛЬКО из: ${ingredients}\nДоп: ${details || 'нет'}`
    : `Рецепт: ${ingredients}\nДоп: ${details || 'нет'}`;
  return { system, user };
}

function parseSteps(fullText) {
  if (!fullText) return ['Текст рецепта не получен.'];
  const stepRegex = /(?:Шаг\s*\d+[.:\s-])|(?:^\d+.\s)/gim;
  const parts = fullText.split(stepRegex).filter(p => p.trim().length > 5);
  if (parts.length >= 2) return parts.map(p => p.trim());
  return fullText.split(/\n\s*\n/).filter(p => p.trim().length > 10);
}

function cleanHtml(text) {
  if (!text) return '';
  let safe = text
    .replace(/```html/gi, '').replace(/```/g, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const headings = ['🍽', '📝', '🔥', '👨‍🍳', '🍷', '📊', '⏱', '💡'];
  headings.forEach(emoji => {    const escaped = emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped}[^\\n]+)`, 'g');
    safe = safe.replace(regex, '<b>$1</b>');
  });
  const open = (safe.match(/<b>/g) || []).length;
  const close = (safe.match(/<\/b>/g) || []).length;
  if (open !== close) return safe.replace(/<\/?b>/g, '');
  return safe;
}

// ===== STATUS =====
router.get('/recipe/status', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    const { rows: [user] } = await global.pool.query(`SELECT * FROM users WHERE tg_id=$1`, [tgId]);
    res.json({
      subscription: sub || null,
      freeUsed: user?.free_recipes_used || 0,
      freeLimit: FREE_LIMIT,
      prices: { PRO: PRO_PRICE, VIP: VIP_PRICE }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== GENERATE RECIPE =====
router.post('/recipe/generate', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { ingredients, details } = req.body;
    if (!ingredients) return res.status(400).json({ error: 'No ingredients' });

    await global.pool.query(
      `INSERT INTO users (tg_id, username, first_name, free_recipes_used)
       VALUES ($1,$2,$3,0) ON CONFLICT (tg_id) DO NOTHING`,
      [tgId, req.telegramUser.username, req.telegramUser.first_name]
    );

    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    const { rows: [user] } = await global.pool.query(`SELECT * FROM users WHERE tg_id=$1`, [tgId]);

    if (!sub && user.free_recipes_used >= FREE_LIMIT) {      return res.status(403).json({
        error: 'limit_reached',
        message: 'Лимит исчерпан',
        prices: { PRO: PRO_PRICE, VIP: VIP_PRICE }
      });
    }

    const planType = sub?.plan_type || 'FREE';
    const requestType = detectRequestType(ingredients);
    const prompt = buildPrompt(requestType, ingredients, details, planType);

    let recipe = await callGigaChat(prompt.system, prompt.user);
    recipe = cleanHtml(recipe);
    const steps = parseSteps(recipe);

    if (!sub) {
      await global.pool.query(
        `UPDATE users SET free_recipes_used = free_recipes_used + 1 WHERE tg_id=$1`,
        [tgId]
      );
    }

    res.json({
      title: (recipe.match(/🍽 [^\n]+/) || ['Твой рецепт'])[0],
      fullText: recipe,
      steps,
      total: steps.length
    });
  } catch (e) {
    console.error('Recipe error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== STT =====
router.post('/stt/recognize', uploadAudio.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio' });
    const text = await transcribeVoice(req.file.buffer);
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== PAYMENT INFO =====
router.get('/payment/info', (req, res) => {
  res.json({
    sbpPhone: SBP_PHONE,
    recipient: SBP_RECIPIENT,    prices: { PRO: PRO_PRICE, VIP: VIP_PRICE }
  });
});

// ===== UPLOAD RECEIPT (с улучшенным caption) =====
router.post('/payment/upload', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const tgId = req.telegramUser.id;
    const { planType } = req.body;
    const amount = planType === 'VIP' ? VIP_PRICE : PRO_PRICE;
    const receiptPath = `/uploads/${req.file.filename}`;

    const { rows: [payment] } = await global.pool.query(
      `INSERT INTO payments (user_id, amount, receipt_file_path, status, plan_type)
       VALUES ($1,$2,$3,'pending',$4) RETURNING id`,
      [tgId, amount, receiptPath, planType]
    );

    const { rows: [user] } = await global.pool.query(`SELECT * FROM users WHERE tg_id=$1`, [tgId]);
    
    // Получаем активную подписку если есть
    const { rows: [currentSub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE ORDER BY expires_at DESC LIMIT 1`,
      [tgId]
    );

    // 📸 УЛУЧШЕННЫЙ caption для админа
    if (global.sendPhotoToAdmin) {
      const isNewUser = !currentSub;
      const caption = 
        `🚨 <b>НОВАЯ ЗАЯВКА #${payment.id}</b>\n\n` +
        `👤 <b>Пользователь:</b>\n` +
        `   • Имя: ${user?.first_name || 'unknown'}\n` +
        `   • Username: @${user?.username || '—'}\n` +
        `   • TG ID: <code>${tgId}</code>\n` +
        `   • Регистрация: ${user?.created_at ? new Date(user.created_at).toLocaleDateString('ru-RU') : '—'}\n\n` +
        `💳 <b>Оплата:</b>\n` +
        `   • Тариф: <b>${planType}</b>\n` +
        `   • Сумма: <b>${amount}₽</b>\n` +
        `   • Статус пользователя: ${isNewUser ? '🆕 Новый' : `📅 Текущий: ${currentSub.plan_type} до ${new Date(currentSub.expires_at).toLocaleDateString('ru-RU')}`}\n\n` +
        `📊 <b>Активность:</b>\n` +
        `   • Рецептов создано: ${user?.free_recipes_used || 0}`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: '✅ Одобрить', callback_data: `approve_${payment.id}` },
            { text: '❌ Отклонить', callback_data: `reject_${payment.id}` }
          ],          [
            { text: '👤 Профиль юзера', url: `tg://user?id=${tgId}` }
          ]
        ]
      };
      const fullPath = path.join(__dirname, req.file.path);
      await global.sendPhotoToAdmin(fullPath, caption, keyboard);
    }

    res.json({ paymentId: payment.id, status: 'pending' });
  } catch (e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== PROFILE =====
router.get('/user/profile', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { rows: [user] } = await global.pool.query(`SELECT * FROM users WHERE tg_id=$1`, [tgId]);
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    res.json({ user, subscription: sub || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== FULL PROFILE =====
router.get('/user/fullprofile', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { rows: [user] } = await global.pool.query(`SELECT * FROM users WHERE tg_id=$1`, [tgId]);
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    const { rows: [{count}] } = await global.pool.query(
      `SELECT COUNT(*) FROM payments WHERE user_id=$1 AND status='approved'`,
      [tgId]
    );
    res.json({
      user,
      subscription: sub || null,
      approvedPayments: parseInt(count) || 0
    });
  } catch (e) {    res.status(500).json({ error: e.message });
  }
});

// ===== VIP: WEEK MENU =====
router.post('/vip/weekmenu', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { prefs } = req.body;
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    if (!sub || sub.plan_type !== 'VIP') {
      return res.status(403).json({ error: 'Только для VIP' });
    }
    const system = `Ты диетолог и шеф-повар. Составь подробное меню на 7 дней.
Структура: для каждого дня — завтрак, обед, ужин, перекус. Укажи примерное КБЖУ на день.`;
    const user = `Предпочтения: ${prefs || 'нет'}`;
    const menu = await callGigaChat(system, user);
    res.json({ menu: cleanHtml(menu) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== VIP: DIET =====
router.post('/vip/diet', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { question } = req.body;
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    if (!sub || sub.plan_type !== 'VIP') {
      return res.status(403).json({ error: 'Только для VIP' });
    }
    const system = `Ты профессиональный диетолог с 20-летним опытом.
Отвечай подробно, научно обоснованно, но простым языком. Используй структуру с эмодзи.`;
    const answer = await callGigaChat(system, question);
    res.json({ answer: cleanHtml(answer) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// 👨‍💼 АДМИНСКИЕ ЭНДПОИНТЫ (требуют adminAuth)
// ============================================
// ===== ДЕТАЛЬНАЯ СТАТИСТИКА =====
router.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const { rows: [basic] } = await global.pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours') as users_today,
        (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days') as users_week,
        (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '30 days') as users_month,
        (SELECT COUNT(*) FROM subscriptions WHERE is_active=TRUE) as active_subs,
        (SELECT COUNT(*) FROM subscriptions WHERE is_active=TRUE AND plan_type='PRO') as pro_subs,
        (SELECT COUNT(*) FROM subscriptions WHERE is_active=TRUE AND plan_type='VIP') as vip_subs,
        (SELECT COUNT(*) FROM payments WHERE status='pending') as pending_payments,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status='approved') as total_revenue,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status='approved' AND created_at > NOW() - INTERVAL '30 days') as revenue_month,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status='approved' AND created_at > NOW() - INTERVAL '7 days') as revenue_week,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status='approved' AND created_at > NOW() - INTERVAL '24 hours') as revenue_today
    `);

    // График регистраций за 30 дней
    const { rows: regChart } = await global.pool.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as count
      FROM users 
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `);

    // График выручки за 30 дней
    const { rows: revChart } = await global.pool.query(`
      SELECT 
        DATE(created_at) as date,
        COALESCE(SUM(amount), 0) as revenue,
        COUNT(*) as count
      FROM payments 
      WHERE status='approved' AND created_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `);

    // Истекающие подписки (7 дней)
    const { rows: expiring } = await global.pool.query(`
      SELECT u.first_name, u.username, u.tg_id, s.plan_type, s.expires_at
      FROM subscriptions s
      JOIN users u ON s.user_id = u.tg_id
      WHERE s.is_active = TRUE AND s.expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'
      ORDER BY s.expires_at ASC    `);

    res.json({
      basic,
      regChart,
      revChart,
      expiring,
      prices: { PRO: PRO_PRICE, VIP: VIP_PRICE }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ВСЕ ПЛАТЕЖИ С ФИЛЬТРАМИ =====
router.get('/admin/payments', adminAuth, async (req, res) => {
  try {
    const { status, plan_type, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIdx = 1;

    if (status && status !== 'all') {
      where += ` AND p.status = $${paramIdx++}`;
      params.push(status);
    }
    if (plan_type && plan_type !== 'all') {
      where += ` AND p.plan_type = $${paramIdx++}`;
      params.push(plan_type);
    }

    const { rows: payments } = await global.pool.query(
      `SELECT p.*, u.first_name, u.username, u.tg_id
       FROM payments p
       JOIN users u ON p.user_id = u.tg_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, parseInt(limit), offset]
    );

    const { rows: [{total}] } = await global.pool.query(
      `SELECT COUNT(*) as total FROM payments p ${where}`,
      params
    );

    res.json({
      payments,      total: parseInt(total),
      page: parseInt(page),
      totalPages: Math.ceil(parseInt(total) / parseInt(limit))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ВСЕ ПОЛЬЗОВАТЕЛИ =====
router.get('/admin/users', adminAuth, async (req, res) => {
  try {
    const { search, plan, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIdx = 1;

    if (search) {
      where += ` AND (u.first_name ILIKE $${paramIdx} OR u.username ILIKE $${paramIdx} OR u.tg_id::text LIKE $${paramIdx})`;
      params.push(`%${search}%`);
      paramIdx++;
    }
    if (plan && plan !== 'all') {
      if (plan === 'FREE') {
        where += ` AND s.id IS NULL`;
      } else {
        where += ` AND s.plan_type = $${paramIdx} AND s.is_active = TRUE`;
        params.push(plan);
        paramIdx++;
      }
    }

    const { rows: users } = await global.pool.query(
      `SELECT 
        u.*,
        s.plan_type, s.expires_at, s.is_active,
        (SELECT COUNT(*) FROM payments WHERE user_id = u.tg_id AND status='approved') as total_paid
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.tg_id AND s.is_active = TRUE
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, parseInt(limit), offset]
    );

    const { rows: [{total}] } = await global.pool.query(
      `SELECT COUNT(*) as total FROM users u LEFT JOIN subscriptions s ON s.user_id = u.tg_id AND s.is_active = TRUE ${where}`,
      params    );

    res.json({
      users,
      total: parseInt(total),
      page: parseInt(page),
      totalPages: Math.ceil(parseInt(total) / parseInt(limit))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ДЕТАЛЬНЫЙ ПРОСМОТР ПОЛЬЗОВАТЕЛЯ =====
router.get('/admin/user/:tgId', adminAuth, async (req, res) => {
  try {
    const { tgId } = req.params;
    
    const { rows: [user] } = await global.pool.query(
      `SELECT * FROM users WHERE tg_id = $1`,
      [tgId]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { rows: subs } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC`,
      [tgId]
    );
    const { rows: payments } = await global.pool.query(
      `SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC`,
      [tgId]
    );

    res.json({ user, subscriptions: subs, payments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== РУЧНАЯ СМЕНА ТАРИФА =====
router.post('/admin/user/:tgId/plan', adminAuth, async (req, res) => {
  try {
    const { tgId } = req.params;
    const { planType, days = 30 } = req.body;

    if (!['PRO', 'VIP'].includes(planType)) {
      return res.status(400).json({ error: 'Invalid plan type' });
    }

    const expiresAt = new Date();    expiresAt.setDate(expiresAt.getDate() + parseInt(days));

    await global.pool.query(
      `UPDATE subscriptions SET is_active=FALSE WHERE user_id=$1`,
      [tgId]
    );
    await global.pool.query(
      `INSERT INTO subscriptions (user_id, is_active, expires_at, plan_type) 
       VALUES ($1, TRUE, $2, $3)`,
      [tgId, expiresAt, planType]
    );
    await global.pool.query(
      `UPDATE users SET free_recipes_used=0 WHERE tg_id=$1`,
      [tgId]
    );

    // Уведомляем пользователя
    try {
      const { Telegraf } = require('telegraf');
      const bot = new Telegraf(process.env.BOT_TOKEN);
      await bot.telegram.sendMessage(
        parseInt(tgId),
        `🎉 <b>Администратор выдал вам ${planType}!</b>\n📅 До: ${expiresAt.toLocaleDateString('ru-RU')}`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('Notify user error:', e.message);
    }

    res.json({ success: true, expiresAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== БЛОКИРОВКА ПОЛЬЗОВАТЕЛЯ =====
router.post('/admin/user/:tgId/ban', adminAuth, async (req, res) => {
  try {
    const { tgId } = req.params;
    const { banned = true } = req.body;

    // Добавляем колонку is_banned если её нет (разовая миграция)
    await global.pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_banned') THEN
          ALTER TABLE users ADD COLUMN is_banned BOOLEAN DEFAULT FALSE;
        END IF;
      END $$;
    `);
    await global.pool.query(
      `UPDATE users SET is_banned=$1 WHERE tg_id=$2`,
      [banned, tgId]
    );
    if (banned) {
      await global.pool.query(
        `UPDATE subscriptions SET is_active=FALSE WHERE user_id=$1`,
        [tgId]
      );
    }

    res.json({ success: true, banned });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== РУЧНОЕ ОДОБРЕНИЕ/ОТКЛОНЕНИЕ ПЛАТЕЖА =====
router.post('/admin/payment/:id/approve', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: [payment] } = await global.pool.query(
      `SELECT * FROM payments WHERE id=$1`, [id]
    );
    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await global.pool.query(
      `UPDATE subscriptions SET is_active=FALSE WHERE user_id=$1`,
      [payment.user_id]
    );
    await global.pool.query(
      `INSERT INTO subscriptions (user_id, is_active, expires_at, plan_type) 
       VALUES ($1, TRUE, $2, $3)`,
      [payment.user_id, expiresAt, payment.plan_type]
    );
    await global.pool.query(
      `UPDATE users SET free_recipes_used=0 WHERE tg_id=$1`,
      [payment.user_id]
    );
    await global.pool.query(
      `UPDATE payments SET status='approved' WHERE id=$1`,
      [id]
    );

    res.json({ success: true, expiresAt });
  } catch (e) {    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/payment/:id/reject', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await global.pool.query(
      `UPDATE payments SET status='rejected' WHERE id=$1`,
      [id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ЭКСПОРТ В EXCEL =====
router.get('/admin/export/:type', adminAuth, async (req, res) => {
  try {
    const { type } = req.params; // 'users' | 'payments' | 'subscriptions'
    
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Chef AI Admin';
    workbook.created = new Date();

    if (type === 'users') {
      const { rows } = await global.pool.query(`
        SELECT u.tg_id, u.username, u.first_name, u.free_recipes_used, u.created_at,
               s.plan_type, s.expires_at, s.is_active
        FROM users u
        LEFT JOIN subscriptions s ON s.user_id = u.tg_id AND s.is_active = TRUE
        ORDER BY u.created_at DESC
      `);

      const sheet = workbook.addWorksheet('Пользователи');
      sheet.columns = [
        { header: 'TG ID', key: 'tg_id', width: 15 },
        { header: 'Username', key: 'username', width: 20 },
        { header: 'Имя', key: 'first_name', width: 20 },
        { header: 'Рецептов', key: 'free_recipes_used', width: 12 },
        { header: 'Тариф', key: 'plan_type', width: 10 },
        { header: 'Активен', key: 'is_active', width: 10 },
        { header: 'До', key: 'expires_at', width: 15 },
        { header: 'Регистрация', key: 'created_at', width: 20 }
      ];

      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = {
        type: 'pattern', pattern: 'solid',        fgColor: { argb: 'FF667EEA' }
      };

      rows.forEach(r => {
        sheet.addRow({
          tg_id: r.tg_id,
          username: r.username || '-',
          first_name: r.first_name || '-',
          free_recipes_used: r.free_recipes_used || 0,
          plan_type: r.plan_type || 'FREE',
          is_active: r.is_active ? '✅' : '❌',
          expires_at: r.expires_at ? new Date(r.expires_at).toLocaleDateString('ru-RU') : '-',
          created_at: new Date(r.created_at).toLocaleString('ru-RU')
        });
      });

    } else if (type === 'payments') {
      const { rows } = await global.pool.query(`
        SELECT p.id, p.user_id, u.username, u.first_name, p.amount, p.plan_type, 
               p.status, p.created_at, p.receipt_file_path
        FROM payments p
        JOIN users u ON p.user_id = u.tg_id
        ORDER BY p.created_at DESC
      `);

      const sheet = workbook.addWorksheet('Платежи');
      sheet.columns = [
        { header: 'ID', key: 'id', width: 8 },
        { header: 'TG ID', key: 'user_id', width: 15 },
        { header: 'Username', key: 'username', width: 20 },
        { header: 'Имя', key: 'first_name', width: 20 },
        { header: 'Сумма', key: 'amount', width: 10 },
        { header: 'Тариф', key: 'plan_type', width: 10 },
        { header: 'Статус', key: 'status', width: 12 },
        { header: 'Дата', key: 'created_at', width: 20 },
        { header: 'Чек', key: 'receipt_file_path', width: 40 }
      ];

      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: 'FF667EEA' }
      };

      rows.forEach(r => {
        sheet.addRow({
          id: r.id,
          user_id: r.user_id,
          username: r.username || '-',
          first_name: r.first_name || '-',          amount: r.amount,
          plan_type: r.plan_type,
          status: r.status === 'approved' ? '✅ ' + r.status : 
                  r.status === 'rejected' ? '❌ ' + r.status : '⏳ ' + r.status,
          created_at: new Date(r.created_at).toLocaleString('ru-RU'),
          receipt_file_path: r.receipt_file_path || '-'
        });
      });

    } else if (type === 'subscriptions') {
      const { rows } = await global.pool.query(`
        SELECT s.id, s.user_id, u.username, u.first_name, s.plan_type, 
               s.starts_at, s.expires_at, s.is_active
        FROM subscriptions s
        JOIN users u ON s.user_id = u.tg_id
        ORDER BY s.created_at DESC
      `);

      const sheet = workbook.addWorksheet('Подписки');
      sheet.columns = [
        { header: 'ID', key: 'id', width: 8 },
        { header: 'TG ID', key: 'user_id', width: 15 },
        { header: 'Username', key: 'username', width: 20 },
        { header: 'Имя', key: 'first_name', width: 20 },
        { header: 'Тариф', key: 'plan_type', width: 10 },
        { header: 'Начало', key: 'starts_at', width: 15 },
        { header: 'Конец', key: 'expires_at', width: 15 },
        { header: 'Активна', key: 'is_active', width: 10 }
      ];

      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: 'FF667EEA' }
      };

      rows.forEach(r => {
        sheet.addRow({
          id: r.id,
          user_id: r.user_id,
          username: r.username || '-',
          first_name: r.first_name || '-',
          plan_type: r.plan_type,
          starts_at: new Date(r.starts_at).toLocaleDateString('ru-RU'),
          expires_at: new Date(r.expires_at).toLocaleDateString('ru-RU'),
          is_active: r.is_active ? '✅' : '❌'
        });
      });
    } else {
      return res.status(400).json({ error: 'Invalid export type' });    }

    // Отправляем файл
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=${type}_${new Date().toISOString().split('T')[0]}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Export error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== ОЖИДАЮЩИЕ ОПЛАТЫ (быстрый список) =====
router.get('/admin/pending', adminAuth, async (req, res) => {
  try {
    const { rows } = await global.pool.query(`
      SELECT p.id, u.first_name, u.username, u.tg_id, p.amount, p.plan_type, p.created_at
      FROM payments p
      JOIN users u ON p.user_id = u.tg_id
      WHERE p.status = 'pending'
      ORDER BY p.created_at DESC
      LIMIT 20
    `);
    res.json({ pending: rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
