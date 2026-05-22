const express = require('express');
const multer = require('multer');
const path = require('path');
const { validateTelegramAuth } = require('./auth');
const { callGigaChat } = require('./gigachat');
const { transcribeVoice } = require('./stt');

const router = express.Router();

const FREE_LIMIT = 3;
const PRO_PRICE = 500;
const VIP_PRICE = 800;
const SBP_PHONE = process.env.SBP_PHONE || '+79022231321';
const SBP_RECIPIENT = process.env.SBP_RECIPIENT || 'Ермачкова Алина В.';

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `receipt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });
const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Auth middleware
router.use((req, res, next) => {
  const initData = req.header('x-telegram-init-data');
  if (!initData) return res.status(401).json({ error: 'No initData' });
  const user = validateTelegramAuth(initData, process.env.BOT_TOKEN);
  if (!user) return res.status(401).json({ error: 'Invalid initData' });
  req.telegramUser = user;
  next();
});

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

function buildPrompt(requestType, ingredients, details, planType) {  const isVIP = planType === 'VIP';
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
  // Жирные заголовки с эмодзи
  const headings = ['🍽', '📝', '🔥', '👨‍🍳', '🍷', '📊', '⏱', '💡'];
  headings.forEach(emoji => {
    const escaped = emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped}[^\\n]+)`, 'g');
    safe = safe.replace(regex, '<b>$1</b>');
  });
  // Проверка баланса тегов
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
    );    const { rows: [user] } = await global.pool.query(`SELECT * FROM users WHERE tg_id=$1`, [tgId]);
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

    if (!sub && user.free_recipes_used >= FREE_LIMIT) {
      return res.status(403).json({
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
        `UPDATE users SET free_recipes_used = free_recipes_used + 1 WHERE tg_id=$1`,        [tgId]
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
    recipient: SBP_RECIPIENT,
    prices: { PRO: PRO_PRICE, VIP: VIP_PRICE }
  });
});

// ===== UPLOAD RECEIPT =====
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

    if (global.sendPhotoToAdmin) {
      const caption = `🚨 Заявка #${payment.id}\n👤 ${user?.first_name || 'user'} (@${user?.username || '-'})\n💎 ${planType} | 💰 ${amount}₽`;
      const keyboard = {
        inline_keyboard: [
          [{ text: '✅ Одобрить', callback_data: `approve_${payment.id}` }],
          [{ text: '❌ Отклонить', callback_data: `reject_${payment.id}` }]
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

// ===== FULL PROFILE (с историей оплат) =====
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
    );    res.json({
      user,
      subscription: sub || null,
      approvedPayments: parseInt(count) || 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// ===== VIP: DIET CONSULTATION =====
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
    res.status(500).json({ error: e.message });  }
});

module.exports = router;
