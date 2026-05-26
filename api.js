const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { validateTelegramAuth } = require('./auth');
const { callGigaChat } = require('./gigachat');
const { transcribeVoice } = require('./stt');
const router = express.Router();
// ===== КОНСТАНТЫ =====
const FREE_LIMIT = 3;
const PRO_PRICE = 500;
const VIP_PRICE = 800;
const SBP_PHONE = process.env.SBP_PHONE || '+79022231321';
const SBP_RECIPIENT = process.env.SBP_RECIPIENT || 'Ермачкова Алина В.';
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 0;
// ===== Папка для чеков =====
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// ===== Multer =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `receipt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });
const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// ===== USER AUTH MIDDLEWARE =====
router.use((req, res, next) => {
  const initData = req.header('x-telegram-init-data');
  if (!initData) return res.status(401).json({ error: 'No initData' });
  const user = validateTelegramAuth(initData, process.env.BOT_TOKEN);
  if (!user) return res.status(401).json({ error: 'Invalid initData' });
  req.telegramUser = user;
  next();
});
// ===== ADMIN AUTH MIDDLEWARE =====
const adminAuth = (req, res, next) => {
  if (!ADMIN_ID) return res.status(403).json({ error: 'Admin not configured' });
  if (req.telegramUser?.id !== ADMIN_ID) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
};
// ===== HELPERS =====

// Получить полный профиль пользователя с режимом и предпочтениями
async function getUserPrefs(tgId) {
  try {
    const { rows: [user] } = await global.pool.query(
      `SELECT allergies, preferred_portions, mode, family_kids, disliked_products,
              favorite_products, fitness_goal, daily_calories
       FROM users WHERE tg_id=$1`,
      [tgId]
    );
    return {
      allergies: (user?.allergies || '').trim(),
      portions: user?.preferred_portions || 2,
      mode: user?.mode || 'standard',
      familyKids: (user?.family_kids || '').trim(),
      disliked: (user?.disliked_products || '').trim(),
      favorites: (user?.favorite_products || '').trim(),
      fitnessGoal: user?.fitness_goal || null,
      dailyCalories: user?.daily_calories || null
    };
  } catch {
    return { allergies: '', portions: 2, mode: 'standard', familyKids: '', disliked: '', favorites: '', fitnessGoal: null, dailyCalories: null };
  }
}

// Блок аллергий для промпта
function allergyBlock(allergies) {
  if (!allergies) return '';
  return `\n\n🚫 КРИТИЧНО — АЛЛЕРГИИ ПОЛЬЗОВАТЕЛЯ: ${allergies}.
ЗАПРЕЩЕНО использовать эти продукты в рецепте, даже в малых количествах. Если базовый рецепт обычно содержит эти ингредиенты — замени их безопасными аналогами или выбери другое блюдо.\n`;
}

// Блок режима — семья или фитнес
function modeBlock(prefs) {
  if (prefs.mode === 'family') {
    const kidsPart = prefs.familyKids ? `Дети: ${prefs.familyKids}. ` : '';
    const dislikedPart = prefs.disliked ? `Семья не любит: ${prefs.disliked}. ` : '';
    const favPart = prefs.favorites ? `Особенно любят: ${prefs.favorites}. ` : '';
    return `\n\n👨‍👩‍👧 РЕЖИМ "СЕМЬЯ С ДЕТЬМИ":
${kidsPart}${dislikedPart}${favPart}
Адаптируй рецепт для семейной готовки:
— Блюдо должно нравиться и взрослым, и детям
— Никаких острых специй и сильного алкоголя
— Если есть продукты которые не любят — НЕ используй их
— Если есть любимые — постарайся включить
— Подача в детском варианте: красиво, разнообразно по цветам, можно с забавной формой
— Время приготовления оптимально до 30 минут (родители заняты)\n`;
  }
  if (prefs.mode === 'fitness') {
    const goalNames = {
      gain: 'НАБОР МАССЫ (профицит калорий, много белка)',
      cut: 'СУШКА/ПОХУДЕНИЕ (дефицит калорий, мало углеводов вечером)',
      maintain: 'ПОДДЕРЖАНИЕ ФОРМЫ (сбалансированное питание)'
    };
    const goal = prefs.fitnessGoal ? goalNames[prefs.fitnessGoal] || prefs.fitnessGoal : 'СБАЛАНСИРОВАННОЕ ПИТАНИЕ';
    const cal = prefs.dailyCalories ? `Дневная норма: ${prefs.dailyCalories} ккал. ` : '';
    return `\n\n💪 РЕЖИМ "ФИТНЕС":
Цель: ${goal}. ${cal}
Адаптируй рецепт под спортивное питание:
— Указывай ОБЯЗАТЕЛЬНО точные КБЖУ на порцию
— Используй "чистые" продукты: куриная грудка, индейка, рыба, творог, яйца, овощи, гречка, бурый рис, киноа
— Минимум жареного — лучше варёное, на пару, запечённое
— Полезные жиры: оливковое масло, авокадо, орехи (если нет аллергии)
— Указывай белки/жиры/углеводы в граммах
— Подача: красивая, фитнес-эстетика (источник вдохновения — Instagram-блогеры)\n`;
  }
  return '';
}

// ===== ЕДИНЫЙ ЗАЩИТНЫЙ БЛОК =====
const FOOD_ONLY_GUARD = `
КРИТИЧЕСКОЕ ПРАВИЛО: Ты работаешь ИСКЛЮЧИТЕЛЬНО в сфере еды, кулинарии и напитков. 
Если пользователь спрашивает о чём-либо не связанном с едой, рецептами, кулинарными техниками, продуктами питания или напитками — вежливо откажи и верни разговор к теме еды.
Примеры запрещённых тем: политика, медицина, юриспруденция, финансы, техника, программирование, отношения, история, география и всё остальное не связанное с едой.
Ответ на оффтоп: "Я специализируюсь только на кулинарии 👨‍🍳 Спроси меня о рецептах, ингредиентах или способах приготовления!"
`;

function detectRequestType(text) {
  const lower = text.toLowerCase();
  const keywords = [
    'рецепт', 'приготовь', 'хочу', 'сделай', 'как сделать', 'как приготовить',
    'борщ', 'салат', 'суп', 'паста', 'карбонара', 'омлет', 'плов', 'пюре',
    'котлеты', 'торт', 'десерт', 'пицца', 'блины', 'шашлык', 'гуляш', 'рагу',
    'запеканка', 'каша', 'пирог', 'соус', 'маринад', 'закуска', 'напиток',
    'смузи', 'коктейль', 'чай', 'кофе', 'сок', 'компот', 'варенье', 'джем'
  ];
  if (keywords.some(k => lower.includes(k))) return 'dish';
  if (text.includes(',')) return 'ingredients';
  return 'dish';
}

function buildPrompt(requestType, ingredients, details, planType, prefs = {}) {
  const isVIP = planType === 'VIP';
  const isPRO = planType === 'PRO' || isVIP;
  const allergies = prefs.allergies || '';

  // Режимы доступны только VIP
  const modeText = isVIP ? modeBlock(prefs) : '';

  // === SYSTEM PROMPT с Chain of Thought + Example + Self-validation ===
  const system = `Ты — опытный шеф-повар с 15-летним стажем работы в ресторанах и преподавателем кулинарной школы. Твоя задача — давать **проверенные, рабочие рецепты** уровня профессионального шеф-повара, но адаптированные под домашнюю кухню.

${FOOD_ONLY_GUARD}${allergyBlock(allergies)}${modeText}

═══════════════════════════════
ВНУТРЕННИЙ ПРОЦЕСС МЫШЛЕНИЯ (не пиши пользователю):
1. Определи тип блюда: что это — закуска, основное, десерт, напиток
2. Подбери оптимальную технику приготовления (жарка/варка/запекание/тушение/сувид)
3. Рассчитай точные пропорции исходя из заданного числа порций
4. Подумай: какие 2-3 типичные ошибки делают новички с этим блюдом — упомяни их в советах
5. Проверь время: если получается >60 мин — упрости рецепт без потери качества
6. Убедись что все ингредиенты доступны в обычном супермаркете
═══════════════════════════════

ОБЯЗАТЕЛЬНЫЙ ФОРМАТ ОТВЕТА (повторяй структуру точно):

🍽 [Название блюда] — [одно ёмкое предложение что это и чем вкусно]

📝 О блюде: [2-3 предложения: происхождение / в чём изюминка / почему стоит готовить]

👥 Порций: [N] | ⏱ Подготовка: [X мин] | 🔥 Готовка: [X мин]

🥣 ИНГРЕДИЕНТЫ:
— [продукт] — [точное количество с единицей]
— [продукт] — [количество]
(все продукты с точными граммами/штуками/мл)

🔥 МЕТОД: [одной фразой — жарка / варка / запекание / тушение / комбинированный]
🌡 Температура: [конкретно — например "180°C" или "средний огонь / 5-6 из 9"]

👨‍🍳 ПОШАГОВЫЙ РЕЦЕПТ:
Шаг 1. [Конкретное действие с деталями: что делать, как нарезать/смешать, на каком огне] — [X мин]
Шаг 2. [Действие с критериями готовности: "до золотистой корочки", "до прозрачности лука"] — [X мин]
Шаг 3. [продолжай — минимум 6 шагов, максимум 12]
(каждый шаг = одно конкретное действие + время + критерий «когда готово»)

💡 СОВЕТЫ ШЕФА:
— [техника: например "не перемешивай ризотто слишком часто — потеряешь крахмал"]
— [типичная ошибка и как избежать]
— [возможная замена ингредиента если чего-то нет]

🍷 ПОДАЧА: [как красиво подать на тарелку + с чем сочетается + какой напиток]
${isPRO ? '\n📊 КБЖУ НА ПОРЦИЮ: Калории — X ккал | Белки — Xг | Жиры — Xг | Углеводы — Xг' : ''}

═══════════════════════════════
ПРИМЕР ИДЕАЛЬНОГО РЕЦЕПТА (используй как образец качества):

🍽 Паста Карбонара — итальянская паста с беконом, яйцами и пармезаном в шёлковом соусе без сливок

📝 О блюде: Классическая римская паста, придуманная пастухами в горах. Главный секрет — соус готовится теплом самой пасты, без огня и без сливок. Подаётся горячей, сразу.

👥 Порций: 2 | ⏱ Подготовка: 5 мин | 🔥 Готовка: 15 мин

🥣 ИНГРЕДИЕНТЫ:
— Спагетти — 200 г
— Гуанчиале или бекон — 100 г
— Яичные желтки — 3 шт.
— Пармезан тёртый — 50 г
— Чеснок — 1 зубчик (опционально)
— Чёрный перец свежемолотый — 0,5 ч.л.
— Соль крупная — 1 ст.л. (для воды)

🔥 МЕТОД: Варка пасты + обжарка бекона + эмульсия
🌡 Температура: Средне-сильный огонь (7 из 9)

👨‍🍳 ПОШАГОВЫЙ РЕЦЕПТ:
Шаг 1. Поставь кастрюлю с 2 литрами воды на сильный огонь. Когда закипит — добавь 1 ст.л. соли. Вода должна быть «солёная как море» — это единственный момент когда паста получает вкус. — 8 мин
Шаг 2. Бекон нарежь кубиками 5×5 мм. Чеснок раздави плоской стороной ножа (не режь). Желтки отдели от белков в миску, добавь тёртый пармезан и щедрую щепотку перца. Размешай до пасты. — 4 мин
Шаг 3. Холодную сковороду поставь на средний огонь, выложи бекон (без масла!). Жир должен вытопиться постепенно — это даст вкус. Жарь до золотистости и хруста. — 6 мин
Шаг 4. Опусти спагетти в кипящую воду, варь на 1 минуту меньше чем указано на упаковке (al dente). — 9-10 мин
Шаг 5. За минуту до готовности пасты убери чеснок из сковороды, выключи огонь под беконом. Зачерпни 100 мл крахмалистой воды из-под пасты. — 1 мин
Шаг 6. Достань пасту шумовкой прямо в сковороду к бекону (не сливай!). Влей 2-3 ст.л. крахмалистой воды, быстро перемешай. Снимай с огня. — 30 сек
Шаг 7. Дай сковороде остыть 30 секунд (важно!), затем влей желтковую смесь и быстро перемешивай круговыми движениями. Соус должен стать кремовым и обволакивать пасту. Если слишком густой — добавь чайную ложку воды от пасты. — 1 мин
Шаг 8. Сразу разложи по подогретым тарелкам, сверху ещё пармезан и перец. Подавай немедленно — карбонара ждать не любит. — 30 сек

💡 СОВЕТЫ ШЕФА:
— Главная ошибка — добавлять желтки на горячую сковороду. Получится омлет! Обязательно сними с огня и подожди.
— Никаких сливок в карбонаре. Кремовость даёт только эмульсия желтков с водой от пасты и сыром.
— Если нет гуанчиале — бери панчетту или хороший бекон без жидкого дыма. Колбаса не подойдёт.

🍷 ПОДАЧА: Подавай в глубоких тёплых тарелках, сверху присыпь пармезаном и крупномолотым перцем. Идеально с бокалом сухого белого Frascati или сухим розе. Без салата — карбонара самодостаточна.
${isPRO ? '\n📊 КБЖУ НА ПОРЦИЮ: Калории — 580 ккал | Белки — 28г | Жиры — 24г | Углеводы — 62г\n' : ''}
═══════════════════════════════

КРИТИЧЕСКИЕ ПРАВИЛА КАЧЕСТВА:

1. **Минимум 6 пошаговых шагов** — рецепт из 3 шагов это халтура
2. **Каждый шаг с временем и критерием готовности** ("до золотистой корочки", "пока не выпарится жидкость")
3. **Точные граммы и миллилитры** — не "по вкусу" для основных продуктов
4. **Реалистичное время** — если общее время вышло >60 мин, упрости
5. **Никакого "пока не будет готово"** — пиши конкретно: "до 75°C внутри", "когда нож входит легко"
6. **Объясняй ПОЧЕМУ так, а не иначе** — это уровень шефа, не блогера
7. **Советы должны решать реальные проблемы** — типичные ошибки + замены ингредиентов
8. **Никаких эзотерических продуктов** в базовом рецепте — только то что есть в "Пятёрочке"
9. **НЕ используй HTML теги** (<b>, <i>) и markdown звёздочки (**)
10. **Точно следуй структуре** — все эмодзи-разделители на своих местах

САМОПРОВЕРКА перед ответом:
✓ Минимум 6 шагов? ✓ Все ингредиенты с граммами? ✓ Время каждого шага указано?
✓ Объяснил критерии готовности? ✓ 3 совета шефа добавлены? ✓ КБЖУ для PRO/VIP?`;

  // === USER MESSAGE ===
  const user = requestType === 'ingredients'
    ? `Придумай блюдо и дай полный профессиональный рецепт, используя ТОЛЬКО эти продукты (плюс базовые соль, перец, масло):

ПРОДУКТЫ: ${ingredients}
${details ? `ПОЖЕЛАНИЯ: ${details}` : ''}

Подумай какие техники подойдут лучше всего и составь рецепт высочайшего качества. Не упрощай — это для человека который хочет научиться готовить как шеф.`
    : `Дай полный профессиональный рецепт блюда:

БЛЮДО: ${ingredients}
${details ? `ПОЖЕЛАНИЯ: ${details}` : ''}

Учти все нюансы профессиональной техники, поделись секретами которые отличают ресторанное блюдо от домашнего. Минимум 6 шагов с точными деталями.`;

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
    .replace(/`html/gi, '').replace(/`/g, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/ /g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const headings = ['🍽', '📝', '🔥', '👨‍🍳', '🍷', '📊', '⏱', '💡'];
  headings.forEach(emoji => {
    const escaped = emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped}[^\n]+)`, 'g');
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

    // Создаём пользователя если первый раз
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
    res.json({
      subscription: sub || null,
      freeUsed: user?.free_recipes_used || 0,
      freeLimit: FREE_LIMIT,
      onboardingDone: !!user?.onboarding_done,
      allergies: user?.allergies || '',
      preferredPortions: user?.preferred_portions || 2,
      freeWeekmenuUsed: !!user?.free_weekmenu_used,
      mode: user?.mode || 'standard',
      familyKids: user?.family_kids || '',
      disliked: user?.disliked_products || '',
      favorites: user?.favorite_products || '',
      fitnessGoal: user?.fitness_goal || null,
      dailyCalories: user?.daily_calories || null,
      dailyReminder: user?.daily_reminder !== false,
      prices: { PRO: PRO_PRICE, VIP: VIP_PRICE }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== СОХРАНИТЬ АЛЛЕРГИИ И ЗАВЕРШИТЬ ОНБОРДИНГ =====
router.post('/user/onboarding', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { allergies = '', portions = 2 } = req.body;
    const cleanAllergies = String(allergies).slice(0, 500).trim();
    const cleanPortions = Math.max(1, Math.min(10, parseInt(portions) || 2));
    await global.pool.query(
      `UPDATE users SET allergies=$1, preferred_portions=$2, onboarding_done=TRUE WHERE tg_id=$3`,
      [cleanAllergies, cleanPortions, tgId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ОБНОВИТЬ ТОЛЬКО АЛЛЕРГИИ =====
router.post('/user/allergies', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const allergies = String(req.body.allergies || '').slice(0, 500).trim();
    await global.pool.query(`UPDATE users SET allergies=$1 WHERE tg_id=$2`, [allergies, tgId]);
    res.json({ ok: true, allergies });
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
    const userPrefs = await getUserPrefs(tgId);
    const requestType = detectRequestType(ingredients);
    const prompt = buildPrompt(requestType, ingredients, details, planType, userPrefs);

    let recipe = await callGigaChat(prompt.system, prompt.user);
    recipe = cleanHtml(recipe);
    const steps = parseSteps(recipe);

    if (!sub) {
      // Атомарный инкремент — защита от двойного списания при параллельных запросах
      await global.pool.query(
        `UPDATE users SET free_recipes_used = free_recipes_used + 1 WHERE tg_id=$1`,
        [tgId]
      );
    }

    // Обновляем last_recipe_at — для активного бота
    await global.pool.query(`UPDATE users SET last_recipe_at=NOW() WHERE tg_id=$1`, [tgId]).catch(() => {});

    // Чистый title без HTML
    const titleMatch = recipe.match(/🍽\s*([^\n<]+)/);
    const cleanTitle = titleMatch
      ? titleMatch[1].replace(/<\/?b>/g,'').trim()
      : 'Твой рецепт';
    const title = `🍽 ${cleanTitle}`;

    // Сохраняем рецепт в БД (всем тарифам)
    let recipeId = null;
    try {
      const { rows: [saved] } = await global.pool.query(
        `INSERT INTO recipes (user_id, title, full_text, tags) VALUES ($1, $2, $3, $4) RETURNING id`,
        [tgId, cleanTitle, recipe, userPrefs.mode || 'standard']
      );
      recipeId = saved.id;
    } catch (e) { console.warn('Save recipe failed:', e.message); }

    res.json({
      id: recipeId,
      title,
      fullText: recipe,
      steps,
      total: steps.length
    });
  } catch (e) {
    console.error('Recipe error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== СПИСОК ИСТОРИИ И ИЗБРАННОГО =====
router.get('/recipes/list', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const filter = req.query.filter || 'all'; // all | favorites
    let where = 'user_id=$1';
    if (filter === 'favorites') where += ' AND is_favorite=TRUE';

    const { rows } = await global.pool.query(
      `SELECT id, title, is_favorite, rating, cooked_count, created_at
       FROM recipes WHERE ${where}
       ORDER BY created_at DESC LIMIT 50`,
      [tgId]
    );
    res.json({ recipes: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ПОЛУЧИТЬ ОДИН РЕЦЕПТ =====
router.get('/recipes/:id', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const { rows: [r] } = await global.pool.query(
      `SELECT * FROM recipes WHERE id=$1 AND user_id=$2`,
      [id, tgId]
    );
    if (!r) return res.status(404).json({ error: 'not found' });

    const steps = parseSteps(r.full_text);
    res.json({
      id: r.id,
      title: `🍽 ${r.title}`,
      fullText: r.full_text,
      steps,
      total: steps.length,
      isFavorite: r.is_favorite,
      rating: r.rating,
      cookedCount: r.cooked_count
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ИЗБРАННОЕ — добавить/убрать =====
router.post('/recipes/:id/favorite', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });

    const { rows: [updated] } = await global.pool.query(
      `UPDATE recipes SET is_favorite = NOT is_favorite
       WHERE id=$1 AND user_id=$2
       RETURNING is_favorite`,
      [id, tgId]
    );
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ isFavorite: updated.is_favorite });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== РЕЙТИНГ РЕЦЕПТА =====
router.post('/recipes/:id/rate', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const id = parseInt(req.params.id);
    const rating = parseInt(req.body.rating);
    if (!id || !rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'bad input' });

    await global.pool.query(
      `UPDATE recipes SET rating=$1, cooked_count=cooked_count+1 WHERE id=$2 AND user_id=$3`,
      [rating, id, tgId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== УДАЛИТЬ РЕЦЕПТ =====
router.delete('/recipes/:id', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    await global.pool.query(`DELETE FROM recipes WHERE id=$1 AND user_id=$2`, [id, tgId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== РЕЖИМЫ И НАСТРОЙКИ ПРОФИЛЯ =====
router.post('/user/mode', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { mode, familyKids, disliked, favorites, fitnessGoal, dailyCalories } = req.body;

    // Проверка VIP — режимы только для VIP
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    if (sub?.plan_type !== 'VIP' && mode !== 'standard') {
      return res.status(403).json({ error: 'Режимы доступны только для VIP' });
    }

    const allowed = ['standard', 'family', 'fitness'];
    const safeMode = allowed.includes(mode) ? mode : 'standard';
    const safeKids = String(familyKids || '').slice(0, 300);
    const safeDisliked = String(disliked || '').slice(0, 300);
    const safeFavorites = String(favorites || '').slice(0, 300);
    const safeGoal = ['gain','cut','maintain'].includes(fitnessGoal) ? fitnessGoal : null;
    const safeCal = dailyCalories ? Math.max(800, Math.min(5000, parseInt(dailyCalories) || 2000)) : null;

    await global.pool.query(
      `UPDATE users SET mode=$1, family_kids=$2, disliked_products=$3, favorite_products=$4,
       fitness_goal=$5, daily_calories=$6 WHERE tg_id=$7`,
      [safeMode, safeKids, safeDisliked, safeFavorites, safeGoal, safeCal, tgId]
    );
    res.json({ ok: true, mode: safeMode });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ВКЛ/ВЫКЛ НАПОМИНАНИЯ =====
router.post('/user/reminder', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const enabled = !!req.body.enabled;
    await global.pool.query(`UPDATE users SET daily_reminder=$1 WHERE tg_id=$2`, [enabled, tgId]);
    res.json({ ok: true, enabled });
  } catch (e) {
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
    console.log(`📥 Загрузка чека от ${tgId}:`, req.file.filename);
    const { rows: [payment] } = await global.pool.query(
      `INSERT INTO payments (user_id, amount, receipt_file_path, status, plan_type)
       VALUES ($1,$2,$3,'pending',$4) RETURNING id, created_at`,
      [tgId, amount, receiptPath, planType]
    );
    console.log(`✅ Платёж создан: #${payment.id}`);
    const { rows: [user] } = await global.pool.query(
      `SELECT * FROM users WHERE tg_id=$1`, [tgId]
    );
    const { rows: [currentSub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE LIMIT 1`,
      [tgId]
    );
    if (global.sendPhotoToAdmin) {
      const isNewUser = !currentSub;
      const caption =        `🚨 <b>НОВАЯ ЗАЯВКА #${payment.id}</b>\n\n` +
        `👤 <b>Пользователь:</b>\n` +
        `   • Имя: ${user?.first_name || 'unknown'}\n` +
        `   • Username: @${user?.username || '—'}\n` +
        `   • TG ID: <code>${tgId}</code>\n` +
        `   • Регистрация: ${user?.created_at ? new Date(user.created_at).toLocaleDateString('ru-RU') : '—'}\n\n` +
        `💳 <b>Оплата:</b>\n` +
        `   • Тариф: <b>${planType}</b>\n` +
        `   • Сумма: <b>${amount}₽</b>\n` +
        `   • Статус юзера: ${isNewUser ? '🆕 Новый' : `📅 ${currentSub.plan_type} до ${new Date(currentSub.expires_at).toLocaleDateString('ru-RU')}`}\n\n` +
        `📊 Рецептов создано: ${user?.free_recipes_used || 0}`;
      const keyboard = {
        inline_keyboard: [
          [
            { text: '✅ Одобрить', callback_data: `approve_${payment.id}` },
            { text: '❌ Отклонить', callback_data: `reject_${payment.id}` }
          ],
          [
            { text: '🌐 Веб-админка', web_app: { url: `${process.env.MINI_APP_URL || ''}/admin.html` } }
          ]
        ]
      };
      // 🔥 ИСПРАВЛЕНО: используем абсолютный путь напрямую от multer
      const fullPath = req.file.path;
      console.log('📸 Путь к файлу:', fullPath);
      console.log('📸 Файл существует:', fs.existsSync(fullPath));
      await global.sendPhotoToAdmin(fullPath, caption, keyboard);
      console.log('✅ Чек отправлен админу');
    } else {
      console.error('❌ global.sendPhotoToAdmin не определён!');
    }
    res.json({ paymentId: payment.id, status: 'pending' });
  } catch (e) {
    console.error('❌ Upload error:', e);
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
  }});
// ===== FULL PROFILE =====
router.get('/user/fullprofile', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { rows: [user] } = await global.pool.query(`SELECT * FROM users WHERE tg_id=$1`, [tgId]);
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    const { rows: [{ count }] } = await global.pool.query(
      `SELECT COUNT(*) FROM payments WHERE user_id=$1 AND status='approved'`,
      [tgId]
    );
    res.json({
      user,
      subscription: sub || null,
      approvedPayments: parseInt(count) || 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== WEEK MENU — VIP или первое бесплатное =====
router.post('/vip/weekmenu', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { prefs, level = 'base', portions: reqPortions } = req.body;

    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    const { rows: [user] } = await global.pool.query(`SELECT * FROM users WHERE tg_id=$1`, [tgId]);

    const isVIP = sub?.plan_type === 'VIP';
    const isFreeBonus = !isVIP && !user?.free_weekmenu_used; // первое меню бесплатно

    if (!isVIP && !isFreeBonus) {
      return res.status(403).json({
        error: 'Только для VIP',
        message: 'Ты уже использовал бесплатное меню. Оформи VIP подписку для регулярного использования.'
      });
    }

    const userPrefs = await getUserPrefs(tgId);
    const allergies = userPrefs.allergies;
    const portions = reqPortions || userPrefs.portions || 2;
    // Режимы доступны только VIP
    const modeText = isVIP ? modeBlock(userPrefs) : '';

    const levelInstructions = {
      base: `УРОВЕНЬ: БАЗОВОЕ. Используй только простые доступные продукты: яйца, картофель, макароны, гречка, рис, овсянка, курица, фарш, морковь, лук, капуста, помидоры, огурцы, молоко, кефир, сметана, сыр, хлеб. ЗАПРЕЩЕНО: авокадо, лосось, сёмга, киноа, моцарелла, страчателла, руккола, трюфель, пармезан, спаржа.`,
      pro: `УРОВЕНЬ: ПРОФИ. Разнообразные продукты из обычного супермаркета: любая рыба (минтай, горбуша, треска), свинина, говядина, индейка, свежая зелень, разная паста, бобовые, греческий йогурт, разные сыры.`,
      luxury: `УРОВЕНЬ: ИЗЫСКАННОЕ. Ресторанный уровень: лосось, тунец, страчателла, пармезан, авокадо, спаржа, трюфельное масло, крем-фреш, демиглас. Сложные техники: сувид, фламбе, эмульсии.`
    };

    const days = [
      'ПОНЕДЕЛЬНИК', 'ВТОРНИК', 'СРЕДА',
      'ЧЕТВЕРГ', 'ПЯТНИЦА', 'СУББОТА', 'ВОСКРЕСЕНЬЕ'
    ];

    const systemPrompt = `Ты — шеф-повар и сертифицированный диетолог. Составляешь сбалансированное меню питания для ${portions} человек на ОДИН день.

${FOOD_ONLY_GUARD}${allergyBlock(allergies)}${modeText}
${levelInstructions[level] || levelInstructions.base}

═══════════════════════════════
ПРИНЦИПЫ СБАЛАНСИРОВАННОГО ДНЯ (учитывай при составлении):
1. Завтрак (25-30% дневных калорий): сложные углеводы + белок. Заряжает на полдня.
2. Обед (35-40%): полноценный — белок + углеводы + овощи. Самый сытный.
3. Ужин (20-25%): белок + овощи, минимум углеводов. За 3 часа до сна.
4. Перекус (10-15%): фрукт/йогурт/орехи. Между обедом и ужином.

ПРОЦЕСС МЫШЛЕНИЯ (внутренне, не пиши):
1. Какие продукты ещё не использовались в неделе? Подбери разнообразие
2. Баланс: на завтрак овсянка → на обед мясо → на ужин рыбу/птицу
3. Сезонность: если зима — корнеплоды и тушёные блюда, лето — лёгкие овощные
4. Технологичность: чтобы из одного похода в магазин можно было приготовить всё
═══════════════════════════════

СТРОГИЙ ФОРМАТ ОТВЕТА (повторяй точно для каждого приёма пищи):

🌅 ЗАВТРАК: [Название блюда]
🥣 Ингредиенты на ${portions} чел.:
— [продукт] — [точное количество]
— [продукт] — [количество]
⏱ Время: [X мин]
🌡 Температура: [конкретно — 180°C / средний огонь / и т.д.]
👨‍🍳 Пошаговый рецепт:
1. [Конкретное действие с деталями] — [X мин]
2. [Действие с критерием готовности] — [X мин]
3. [продолжай, минимум 4-5 шагов]
📊 КБЖУ: [X] ккал | Белки [X]г | Жиры [X]г | Углеводы [X]г
💡 Совет: [практичный лайфхак или быстрая замена]

☀️ ОБЕД: [Название]
[полная структура как у завтрака: ингредиенты → время → температура → шаги (5-6 шагов) → КБЖУ → совет]

🌙 УЖИН: [Название]
[полная структура: ингредиенты → шаги (5-6) → КБЖУ → совет]

🍎 ПЕРЕКУС: [Название]
🥣 Ингредиенты: [список с количествами]
👨‍🍳 Приготовление: [3-4 шага]
📊 КБЖУ: [X] ккал | Белки [X]г | Жиры [X]г | Углеводы [X]г

📊 ИТОГО ЗА ДЕНЬ: [X] ккал | Белки [X]г | Жиры [X]г | Углеводы [X]г

═══════════════════════════════
КРИТИЧЕСКИЕ ПРАВИЛА:
1. **Разнообразие**: блюда не повторяются из дня в день
2. **Точные граммы**: для каждого продукта (не "по вкусу")
3. **Каждый шаг с критерием**: "до золотистой корочки", "пока не выпарится"
4. **Сбалансированный КБЖУ**: завтрак — углеводный, ужин — белковый
5. **Реалистичное время**: завтрак до 20 мин, обед/ужин до 45 мин
6. **Никаких HTML тегов и markdown звёздочек**
7. **Минимум 4 шага** в каждом рецепте
8. **Сезонные продукты** — то что есть сейчас в магазине`;

    // Генерируем каждый день отдельным запросом — полный рецепт гарантирован
    const dayResults = [];
    const usedDishes = [];

    for (let i = 0; i < 7; i++) {
      const dayName = days[i];
      const userMsg = `Составь сбалансированное меню на ДЕНЬ ${i + 1} — ${dayName}.

ПОЖЕЛАНИЯ ПОЛЬЗОВАТЕЛЯ: ${prefs || 'сбалансированное питание без особых ограничений'}

УЖЕ ИСПОЛЬЗОВАНО на этой неделе (НЕ повторяй эти блюда): ${usedDishes.length ? usedDishes.join(', ') : 'ничего, это первый день'}

Подумай о балансе: завтрак — углеводный заряд, обед — самый питательный, ужин — белковый и лёгкий. Напиши только контент этого дня без вводных фраз.`;

      const dayText = await callGigaChat(systemPrompt, userMsg, 2500);

      // Небольшая пауза между запросами — избегаем rate limit
      if (i < 6) await new Promise(r => setTimeout(r, 1000));

      // Чистим markdown
      const clean = dayText
        .replace(/\*\*/g, '')
        .replace(/\*/g, '')
        .replace(/^#{1,3}\s*/gm, '')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();

      const dayBlock = `════════════════════════════\nДЕНЬ ${i + 1} — ${dayName}\n════════════════════════════\n\n${clean}`;
      dayResults.push(dayBlock);

      // Запоминаем использованные блюда чтобы не повторять
      const dishes = clean.match(/(?:ЗАВТРАК|ОБЕД|УЖИН|ПЕРЕКУС):\s*([^\n]+)/gi) || [];
      dishes.forEach(d => {
        const name = d.replace(/(?:ЗАВТРАК|ОБЕД|УЖИН|ПЕРЕКУС):\s*/i, '').trim();
        if (name) usedDishes.push(name);
      });
    }

    const menu = dayResults.join('\n\n\n');

    // Если это было бесплатное первое меню — отмечаем что использовано
    if (isFreeBonus) {
      await global.pool.query(
        `UPDATE users SET free_weekmenu_used=TRUE WHERE tg_id=$1`,
        [tgId]
      );
    }

    res.json({ menu, isFreeBonus });

  } catch (e) {
    console.error('Week menu error:', e);
    res.status(500).json({ error: e.message });
  }
});
// ===== СПИСОК ПОКУПОК (доступен всем пользователям бесплатно) =====
router.post('/recipe/shopping-list', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const recipe = String(req.body.recipe || '').trim();

    if (recipe.length < 20) {
      return res.status(400).json({ error: 'Текст рецепта слишком короткий' });
    }

    // Чистим от HTML и эмодзи-разделителей перед отправкой в AI
    const cleanRecipe = recipe
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/[═─]{3,}/g, '')
      .slice(0, 4000);

    const system = `Ты помощник шеф-повара по составлению списка покупок. 
Из текста рецепта извлеки список продуктов которые нужно купить.

ВАЖНО: Верни ТОЛЬКО валидный JSON объект без какого-либо другого текста. Никаких пояснений, markdown, заголовков.

Формат ответа СТРОГО такой:
{"items":[{"name":"спагетти","amount":"200г"},{"name":"яйца","amount":"3 шт"},{"name":"бекон","amount":"150г"}]}

Правила:
- name: только название продукта строчными буквами на русском (без эпитетов вроде "свежий", "качественный")
- amount: точное количество с единицей измерения (г, кг, мл, л, шт, ст.л., ч.л., зубчик, пучок)
- Если одинаковый продукт встречается несколько раз — просуммируй количество
- НЕ включай: вода, соль, чёрный перец, растительное масло (это базовые продукты которые есть у всех)
- Отвечай СТРОГО только JSON объектом — никакого текста до или после`;

    const raw = await callGigaChat(system, `Извлеки продукты для покупки из этого рецепта:\n\n${cleanRecipe}`, 1500);
    console.log('[ShoppingList] raw length:', raw.length, 'preview:', raw.slice(0, 200));

    let items = [];

    // Попытка 1 — найти JSON объект в ответе
    try {
      const jsonMatch = raw.match(/\{[\s\S]*?"items"[\s\S]*?\}\s*$/m) || raw.match(/\{[\s\S]*?"items"[\s\S]*?\}/);
      if (jsonMatch) {
        items = JSON.parse(jsonMatch[0]).items || [];
      }
    } catch {}

    // Попытка 2 — почистить markdown обёртку
    if (!items.length) {
      try {
        const clean = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
        items = JSON.parse(clean).items || [];
      } catch {}
    }

    // Попытка 3 — построчный парсинг
    if (!items.length) {
      console.warn('[ShoppingList] JSON parse failed, text fallback');
      const lines = raw.split('\n')
        .map(l => l.trim())
        .filter(l => l && /[а-яё]/i.test(l) && !/^[{}[\]"]/.test(l));

      items = lines.map(l => {
        const clean = l.replace(/^[-•*\d.)\s]+/, '').replace(/[",]$/g, '').trim();
        const sepIdx = clean.search(/[—–-]\s*\d/);
        if (sepIdx > 0) {
          return {
            name: clean.slice(0, sepIdx).trim().toLowerCase(),
            amount: clean.slice(sepIdx + 1).replace(/^[—–-\s]+/, '').trim()
          };
        }
        const amtMatch = clean.match(/(\d+(?:[.,]\d+)?\s*(?:г|кг|мл|л|шт|ст\.?л\.?|ч\.?л\.?|зубчик[ова]*|пучок[аи]*|щепотк[аи]*)[^\s,]*)/i);
        if (amtMatch) {
          return {
            name: clean.replace(amtMatch[0], '').replace(/[—–\-:,.]+\s*$/g, '').trim().toLowerCase(),
            amount: amtMatch[0]
          };
        }
        return { name: clean.toLowerCase(), amount: '' };
      }).filter(i => i.name && i.name.length > 1 && i.name.length < 60);
    }

    // Финальная фильтрация
    items = items
      .filter(i => i.name && i.name.length > 1 && /[а-яё]/i.test(i.name))
      .filter(i => !/^(вода|соль|перец|масло)\b/i.test(i.name))
      // Дедупликация
      .filter((item, idx, arr) => arr.findIndex(x => x.name === item.name) === idx);

    res.json({ items });
  } catch (e) {
    console.error('Shopping list error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== СПИСОК ПОКУПОК ДЛЯ МЕНЮ НА НЕДЕЛЮ =====
router.post('/vip/weekmenu-shopping', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { menu } = req.body;

    if (!menu || menu.length < 50) {
      return res.status(400).json({ error: 'Меню слишком короткое' });
    }

    // Доступно тем у кого есть меню — VIP или использовавшим бесплатное
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    const { rows: [user] } = await global.pool.query(`SELECT * FROM users WHERE tg_id=$1`, [tgId]);
    if (sub?.plan_type !== 'VIP' && !user?.free_weekmenu_used) {
      return res.status(403).json({ error: 'Сначала создай меню на неделю' });
    }

    const system = `Ты помощник по закупкам продуктов. Из текста меню на неделю извлеки все уникальные ингредиенты и просуммируй их по всем дням.

Верни ТОЛЬКО валидный JSON объект без какого-либо другого текста:
{"items":[{"name":"куриное филе","amount":"1200г","days":"пн, ср, пт"}]}

Правила:
- name: строчными буквами, только название продукта
- amount: суммарное количество с единицей (напр. "1200г", "5 шт")
- days: краткие сокращения дней через запятую (пн, вт, ср, чт, пт, сб, вс)
- Если одинаковый продукт в нескольких блюдах — просуммируй количество
- НЕ включай: вода, соль, перец, растительное масло
- Отвечай СТРОГО только JSON`;

    const menuTrunc = (menu || '').replace(/[═─]+/g, '').slice(0, 7000);
    const raw = await callGigaChat(system, `Меню на неделю:\n${menuTrunc}`, 2500);

    let items = [];
    try {
      const m = raw.match(/\{[\s\S]*?"items"[\s\S]*?\}\s*$/m) || raw.match(/\{[\s\S]*?"items"[\s\S]*?\}/);
      if (m) items = JSON.parse(m[0]).items || [];
    } catch {}

    if (!items.length) {
      try {
        const clean = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
        items = JSON.parse(clean).items || [];
      } catch {}
    }

    if (!items.length) {
      // Текстовый fallback
      items = raw.split('\n')
        .map(l => l.trim())
        .filter(l => l && /[а-яё]/i.test(l) && !/^[{}[\]"]/.test(l))
        .map(l => ({
          name: l.replace(/^[-•*\d.)\s]+/, '').replace(/[",]$/g, '').trim().toLowerCase(),
          amount: '',
          days: ''
        }))
        .filter(i => i.name && i.name.length > 1 && i.name.length < 60);
    }

    // Финальная фильтрация
    items = items
      .filter(i => i.name && i.name.length > 1 && /[а-яё]/i.test(i.name))
      .filter(i => !/^(вода|соль|перец|масло)\b/i.test(i.name))
      .filter((item, idx, arr) => arr.findIndex(x => x.name === item.name) === idx);

    res.json({ items });
  } catch (e) {
    console.error('Week shopping error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== VIP: ДИЕТОЛОГ =====
router.post('/vip/diet', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { question } = req.body;
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`, [tgId]
    );
    if (!sub || sub.plan_type !== 'VIP') {
      return res.status(403).json({ error: 'Только для VIP' });
    }

    const { allergies } = await getUserPrefs(tgId);

    const system = `Ты — сертифицированный диетолог-нутрициолог с медицинским образованием и 15-летним опытом ведения частной практики. Среди твоих пациентов — спортсмены, беременные, люди с диабетом, аллергиями. Ты опираешься на доказательную медицину (научные исследования, рекомендации ВОЗ, AND, EFSA), не на «модные диеты».
${FOOD_ONLY_GUARD}${allergyBlock(allergies)}

═══════════════════════════════
ТВОЯ МЕТОДИКА ОТВЕТА (внутренне обдумай, не пиши):
1. Определи категорию вопроса: похудение / набор массы / диагноз / конкретный продукт / витамин / общее питание
2. Какие научные факты применимы — индекс гликемический, БЖУ-баланс, биодоступность, синергия продуктов
3. Какие 2-3 типичные мифы окружают этот вопрос — развенчай их
4. Дай практический, реализуемый совет — без "ешьте 6 раз в день" и других штампов
═══════════════════════════════

ОБЯЗАТЕЛЬНЫЙ ФОРМАТ ОТВЕТА:

🥗 [Заголовок — суть вопроса одной фразой]

📋 КРАТКО: [Прямой ответ за 2-3 предложения. Без воды. С конкретными цифрами если уместно.]

📊 ПОДРОБНЕЕ:
[Развёрнутое объяснение на 4-6 предложений. Опирайся на: КБЖУ, гликемический индекс, биодоступность, потребности организма по возрасту/полу/нагрузке. Конкретные цифры (граммы, мг, %) обязательно.]

✅ ЧТО ДЕЛАТЬ:
— [Конкретное действие с цифрой: "Снизь углеводы вечером до 30г"]
— [Действие: "Добавь 80-100г белка на завтрак"]
— [Действие: "Распредели приёмы так: 7:00, 13:00, 19:00"]

⚠️ ВАЖНО:
— [Распространённый миф или ошибка с этим вопросом]
— [Когда срочно обратиться к врачу, если это касается здоровья]

🍽 ПРОДУКТЫ-ПОМОЩНИКИ:
— [Конкретный продукт] — [почему: какой нутриент и сколько на 100г]
— [Продукт] — [почему]
— [Продукт] — [почему]

💡 ЛАЙФХАК: [Один конкретный приём который реально работает. Не "пейте больше воды".]
${'' /* блок при необходимости расширим */}

ПРИМЕР ИДЕАЛЬНОГО ОТВЕТА:

Вопрос: "Как набрать мышечную массу?"

🥗 Набор мышечной массы — питание

📋 КРАТКО: Для роста мышц нужен профицит калорий 200-400 ккал/день и 1,6-2,2г белка на кг веса. Это не "ешь больше всего" — лишний жир замедлит прогресс. Ключевое — стабильность и регулярные силовые тренировки.

📊 ПОДРОБНЕЕ:
Мышцы растут от микротравм при тренировке + строительного материала (аминокислоты) + восстановления. При весе 70 кг норма белка — 112-154г/день. Углеводы — 4-6г/кг (280-420г) для энергии и восстановления гликогена. Жиры — 1г/кг (70г), не меньше: они нужны для синтеза тестостерона. Распредели белок равномерно: 25-40г на каждый приём пищи, тогда усваивается лучше чем один большой приём.

✅ ЧТО ДЕЛАТЬ:
— Считай первые 2-3 недели: норма + 300 ккал, белок 1,8г/кг
— Ешь 4-5 раз в день с белком в каждом приёме (минимум 25г)
— Послетренировочный приём в течение 1-2 часов: 30г белка + 60г углеводов
— Взвешивайся раз в неделю утром натощак: прирост 0,3-0,5 кг/неделю оптимален

⚠️ ВАЖНО:
— Миф: "Окно роста" 30 минут после тренировки — преувеличение, есть 1-2 часа спокойно
— Если набираешь больше 0,7 кг/неделю — растёт жир, снизь калораж на 200
— Без силовых тренировок мышцы расти не будут, никакая еда не поможет

🍽 ПРОДУКТЫ-ПОМОЩНИКИ:
— Куриная грудка — 31г белка / 100г, дешёвый источник
— Творог 5% — 18г белка / 100г + казеин для долгого усвоения (на ночь)
— Овсянка — 12г белка + 60г сложных углеводов / 100г
— Яйца — 13г белка / 100г, идеальный аминокислотный профиль
— Лосось — 20г белка + омега-3 для восстановления

💡 ЛАЙФХАК: Готовь 1 кг куриной грудки на 3 дня вперёд — взвесил, добавил в любой приём. Это решает 80% проблемы белка в рационе.

═══════════════════════════════

КРИТИЧЕСКИЕ ПРАВИЛА:
1. Конкретные цифры везде где можно (граммы, ккал, мг, проценты)
2. Опровергай мифы — это отличает профи от блогера
3. Не используй слова "детокс", "очищение", "шлаки" — это псевдонаука
4. При вопросах о болезнях напомни что нужна консультация врача
5. Без HTML тегов и markdown звёздочек
6. Если вопрос не про еду/питание — мягко верни в тему`;
    const answer = await callGigaChat(system, question, 2000);
    res.json({ answer: cleanHtml(answer) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: СТАТИСТИКА =====
router.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const { rows: [basic] } = await global.pool.query(`SELECT (SELECT COUNT(*) FROM users) as total_users, (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours') as users_today, (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days') as users_week, (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '30 days') as users_month, (SELECT COUNT(*) FROM subscriptions WHERE is_active=TRUE) as active_subs, (SELECT COUNT(*) FROM subscriptions WHERE is_active=TRUE AND plan_type='PRO') as pro_subs, (SELECT COUNT(*) FROM subscriptions WHERE is_active=TRUE AND plan_type='VIP') as vip_subs, (SELECT COUNT(*) FROM payments WHERE status='pending') as pending_payments, (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status='approved') as total_revenue, (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status='approved' AND created_at > NOW() - INTERVAL '30 days') as revenue_month, (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status='approved' AND created_at > NOW() - INTERVAL '7 days') as revenue_week, (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status='approved' AND created_at > NOW() - INTERVAL '24 hours') as revenue_today`);
    const { rows: regChart } = await global.pool.query(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM users
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at) ORDER BY date ASC
    `);
    const { rows: revChart } = await global.pool.query(`
      SELECT DATE(created_at) as date, COALESCE(SUM(amount), 0) as revenue, COUNT(*) as count
      FROM payments
      WHERE status='approved' AND created_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at) ORDER BY date ASC
    `);
    const { rows: expiring } = await global.pool.query(`
      SELECT u.first_name, u.username, u.tg_id, s.plan_type, s.expires_at
      FROM subscriptions s
      JOIN users u ON s.user_id = u.tg_id
      WHERE s.is_active = TRUE AND s.expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'
      ORDER BY s.expires_at ASC
    `);
    res.json({ basic, regChart, revChart, expiring, prices: { PRO: PRO_PRICE, VIP: VIP_PRICE } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: ПЛАТЕЖИ =====
router.get('/admin/payments', adminAuth, async (req, res) => {
  try {
    const { status, plan_type, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = 'WHERE 1=1';
    const params = [];
    let idx = 1;
    if (status && status !== 'all') {
      where += ` AND p.status = $${idx++}`;      params.push(status);
    }
    if (plan_type && plan_type !== 'all') {
      where += ` AND p.plan_type = $${idx++}`;
      params.push(plan_type);
    }
    const { rows: payments } = await global.pool.query(
      `SELECT p.*, u.first_name, u.username, u.tg_id
       FROM payments p JOIN users u ON p.user_id = u.tg_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parseInt(limit), offset]
    );
    const { rows: [{ total }] } = await global.pool.query(
      `SELECT COUNT(*) as total FROM payments p ${where}`,
      params
    );
    res.json({
      payments,
      total: parseInt(total),
      page: parseInt(page),
      totalPages: Math.ceil(parseInt(total) / parseInt(limit))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: ПОЛЬЗОВАТЕЛИ =====
router.get('/admin/users', adminAuth, async (req, res) => {
  try {
    const { search, plan, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = 'WHERE 1=1';
    const params = [];
    let idx = 1;
    if (search) {
      where += ` AND (u.first_name ILIKE $${idx} OR u.username ILIKE $${idx} OR u.tg_id::text LIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }
    if (plan && plan !== 'all') {
      if (plan === 'FREE') {
        where += ` AND s.id IS NULL`;
      } else {
        where += ` AND s.plan_type = $${idx} AND s.is_active = TRUE`;
        params.push(plan);
        idx++;
      }
    }    const { rows: users } = await global.pool.query(
      `SELECT u.*, s.plan_type, s.expires_at, s.is_active,
       (SELECT COUNT(*) FROM payments WHERE user_id = u.tg_id AND status='approved') as total_paid
       FROM users u LEFT JOIN subscriptions s ON s.user_id = u.tg_id AND s.is_active = TRUE
       ${where} ORDER BY u.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parseInt(limit), offset]
    );
    const { rows: [{ total }] } = await global.pool.query(
      `SELECT COUNT(*) as total FROM users u LEFT JOIN subscriptions s ON s.user_id = u.tg_id AND s.is_active = TRUE ${where}`,
      params
    );
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
// ===== ADMIN: ПРОСМОТР ЮЗЕРА =====
router.get('/admin/user/:tgId', adminAuth, async (req, res) => {
  try {
    const { tgId } = req.params;
    const { rows: [user] } = await global.pool.query(
      `SELECT * FROM users WHERE tg_id = $1`, [tgId]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { rows: subs } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY starts_at DESC`, [tgId]
    );
    const { rows: payments } = await global.pool.query(
      `SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC`, [tgId]
    );
    res.json({ user, subscriptions: subs, payments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: ВЫДАТЬ ТАРИФ =====
router.post('/admin/user/:tgId/plan', adminAuth, async (req, res) => {
  try {
    const { tgId } = req.params;
    const { planType, days = 30 } = req.body;
    if (!['PRO', 'VIP'].includes(planType)) {
      return res.status(400).json({ error: 'Invalid plan type' });
    }
    const expiresAt = new Date();    expiresAt.setDate(expiresAt.getDate() + parseInt(days));
    await global.pool.query(
      `UPDATE subscriptions SET is_active=FALSE WHERE user_id=$1`, [tgId]
    );
    await global.pool.query(
      `INSERT INTO subscriptions (user_id, is_active, expires_at, plan_type) VALUES ($1, TRUE, $2, $3)`,
      [tgId, expiresAt, planType]
    );
    await global.pool.query(
      `UPDATE users SET free_recipes_used=0 WHERE tg_id=$1`, [tgId]
    );
    try {
      const { Telegraf } = require('telegraf');
      const notifyBot = new Telegraf(process.env.BOT_TOKEN);
      await notifyBot.telegram.sendMessage(
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
// ===== ADMIN: БАН =====
router.post('/admin/user/:tgId/ban', adminAuth, async (req, res) => {
  try {
    const { tgId } = req.params;
    const { banned = true } = req.body;
    await global.pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_banned') THEN ALTER TABLE users ADD COLUMN is_banned BOOLEAN DEFAULT FALSE; END IF; END $$;`);
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
// ===== ADMIN: ОДОБРИТЬ ПЛАТЕЖ =====
router.post('/admin/payment/:id/approve', adminAuth, async (req, res) => {  try {
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
      `INSERT INTO subscriptions (user_id, is_active, expires_at, plan_type) VALUES ($1, TRUE, $2, $3)`,
      [payment.user_id, expiresAt, payment.plan_type]
    );
    await global.pool.query(
      `UPDATE users SET free_recipes_used=0 WHERE tg_id=$1`,
      [payment.user_id]
    );
    await global.pool.query(
      `UPDATE payments SET status='approved' WHERE id=$1`, [id]
    );
    try {
      const { Telegraf } = require('telegraf');
      const notifyBot = new Telegraf(process.env.BOT_TOKEN);
      await notifyBot.telegram.sendMessage(
        payment.user_id,
        `🎉 <b>${payment.plan_type} активирована!</b>\n📅 До: ${expiresAt.toLocaleDateString('ru-RU')}`,
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
// ===== ADMIN: ОТКЛОНИТЬ ПЛАТЕЖ =====
router.post('/admin/payment/:id/reject', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: [payment] } = await global.pool.query(
      `SELECT * FROM payments WHERE id=$1`, [id]
    );
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    await global.pool.query(
      `UPDATE payments SET status='rejected' WHERE id=$1`, [id]
    );    try {
      const { Telegraf } = require('telegraf');
      const notifyBot = new Telegraf(process.env.BOT_TOKEN);
      await notifyBot.telegram.sendMessage(
        payment.user_id,
        `❌ Оплата отклонена.\n📋 #${payment.id}`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('Notify user error:', e.message);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: PENDING =====
router.get('/admin/pending', adminAuth, async (req, res) => {
  try {
    const { rows } = await global.pool.query(`SELECT p.id, u.first_name, u.username, u.tg_id, p.amount, p.plan_type, p.created_at, p.receipt_file_path FROM payments p JOIN users u ON p.user_id = u.tg_id WHERE p.status = 'pending' ORDER BY p.created_at DESC LIMIT 50`);
    res.json({ pending: rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: ЭКСПОРТ =====
router.get('/admin/export/:type', adminAuth, async (req, res) => {
  try {
    const { type } = req.params;
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
        { header: 'Регистрация', key: 'created_at', width: 20 }      ];
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
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
        SELECT p.id, p.user_id, u.username, u.first_name, p.amount, p.plan_type, p.status, p.created_at, p.receipt_file_path
        FROM payments p JOIN users u ON p.user_id = u.tg_id
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
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
      rows.forEach(r => {
        sheet.addRow({
          id: r.id,
          user_id: r.user_id,
          username: r.username || '-',
          first_name: r.first_name || '-',
          amount: r.amount,
          plan_type: r.plan_type,
          status: r.status === 'approved' ? '✅ ' + r.status :
                  r.status === 'rejected' ? '❌ ' + r.status : '⏳ ' + r.status,
          created_at: new Date(r.created_at).toLocaleString('ru-RU'),
          receipt_file_path: r.receipt_file_path || '-'
        });
      });
    } else if (type === 'subscriptions') {      const { rows } = await global.pool.query(`
        SELECT s.id, s.user_id, u.username, u.first_name, s.plan_type, s.starts_at, s.expires_at, s.is_active
        FROM subscriptions s JOIN users u ON s.user_id = u.tg_id
        ORDER BY s.starts_at DESC
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
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
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
      return res.status(400).json({ error: 'Invalid export type' });
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${type}_${new Date().toISOString().split('T')[0]}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Export error:', e);
    res.status(500).json({ error: e.message });
  }
});
module.exports = router;
