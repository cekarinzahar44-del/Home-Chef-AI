const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { validateTelegramAuth } = require('./auth');
const { callGigaChat, getGigaChatHealth } = require('./gigachat');
const { transcribeVoice } = require('./stt');
const { createRateLimiter } = require('./middleware/security');
const router = express.Router();
// ===== КОНСТАНТЫ =====
const FREE_LIMIT = 3;
const PRO_PRICE = parseInt(process.env.PRO_PRICE) || 290;   // тариф «Стандарт»
const VIP_PRICE = parseInt(process.env.VIP_PRICE) || 490;   // тариф «Про»
// Отображаемые названия тарифов (внутренние коды PRO/VIP не меняем — это безопасно для БД)
const PLAN_NAMES = { FREE: 'Бесплатно', PRO: 'Стандарт', VIP: 'Про' };
const planName = (code) => PLAN_NAMES[code] || code;
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
// ===== ЛИМИТ НА ДОРОГИЕ ИИ-ЗАПРОСЫ (по пользователю) =====
// Защищает бюджет на ИИ от злоупотреблений. Лимит щедрый — реальные
// пользователи его не достигают. Отключается через RATE_LIMIT_ENABLED=false.
const aiLimiter = createRateLimiter({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_GENERATE_MAX) || 30,
  keyGenerator: (req) => `ai_${req.telegramUser?.id || req.ip}`,
  message: { error: 'too_many_requests', message: 'Слишком много запросов к ИИ. Подождите минуту 🙏' }
});
const AI_PATHS = new Set([
  '/recipe/generate', '/vip/weekmenu', '/vip/diet',
  '/recipe/shopping-list', '/vip/weekmenu-shopping', '/stt/recognize',
  '/recipe/substitute', '/recipe/suggest'
]);
router.use((req, res, next) => {
  if (process.env.RATE_LIMIT_ENABLED === 'false') return next();
  if (AI_PATHS.has(req.path)) return aiLimiter(req, res, next);
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

// Блок аллергий для промпта — СТРОГИЙ фильтр с пометкой пользователю
function allergyBlock(allergies) {
  if (!allergies) return '';
  return `

🚫🚫🚫 КРИТИЧЕСКОЕ ПРАВИЛО — АЛЛЕРГИИ ПОЛЬЗОВАТЕЛЯ: ${allergies}

ЭТО ВЫСШИЙ ПРИОРИТЕТ. НАРУШИТЬ НЕЛЬЗЯ ДАЖЕ ЕСЛИ:
— Пользователь сам просит блюдо с этим ингредиентом (например, "омлет со шпинатом" при аллергии на шпинат)
— Это классический ингредиент блюда (например, моцарелла в пицце Маргарита при аллергии на лактозу)
— Рецепт обычно невозможен без него

ЧТО ДЕЛАТЬ:
1. ПОЛНОСТЬЮ исключи аллерген из ингредиентов и из всех шагов
2. Если можно — замени безопасным аналогом (шпинат → руккола или айсберг, молоко → растительное, орехи → семечки)
3. ОБЯЗАТЕЛЬНО в начале рецепта, СРАЗУ после строки "🍽 Название", добавь отдельной строкой:
"⚠️ ВАЖНО: Я исключил из рецепта [название аллергена] — он указан в твоих аллергиях. [Если есть замена: "Заменил на [замену]"]."

Пример: если пользователь просит "омлет со шпинатом" а у него аллергия на шпинат:
🍽 Омлет с зеленью — нежный омлет с микс-салатом и травами
⚠️ ВАЖНО: Я исключил шпинат из рецепта — он указан в твоих аллергиях. Заменил на свежую рукколу и петрушку.
[дальше обычный формат рецепта]

ПРОВЕРЬ ПЕРЕД ОТВЕТОМ: убедись что аллергена НЕТ нигде в рецепте — ни в ингредиентах, ни в шагах, ни в советах, ни в подаче.
`;
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

// Проверка — содержит ли рецепт аллерген (для пост-валидации)
function detectAllergenInText(text, allergies) {
  if (!allergies) return null;
  const lowerText = text.toLowerCase();
  // Разбиваем аллергии на отдельные слова
  const allergenList = allergies.toLowerCase()
    .split(/[,;]+/)
    .map(a => a.trim())
    .filter(a => a.length > 2);

  for (const allergen of allergenList) {
    // Берём корень слова (убираем окончания) для надёжности
    const root = allergen.replace(/[аоеыийуюяь]+$/, '');
    if (root.length < 3) continue;
    // Ищем в тексте — но только в блоке ингредиентов и шагов, не в строке "ВАЖНО"
    // Убираем строку с пометкой об исключении чтобы не словить ложное срабатывание
    const textWithoutNotice = lowerText.replace(/⚠️[^\n]*/g, '');
    if (textWithoutNotice.includes(root)) {
      return allergen;
    }
  }
  return null;
}

// ===== ЕДИНЫЙ ЗАЩИТНЫЙ БЛОК =====
const FOOD_ONLY_GUARD = `
КРИТИЧЕСКОЕ ПРАВИЛО: Ты работаешь ИСКЛЮЧИТЕЛЬНО в сфере еды, кулинарии и напитков. 
Если пользователь спрашивает о чём-либо не связанном с едой, рецептами, кулинарными техниками, продуктами питания или напитками — вежливо откажи и верни разговор к теме еды.
Примеры запрещённых тем: политика, медицина, юриспруденция, финансы, техника, программирование, отношения, история, география и всё остальное не связанное с едой.
Ответ на оффтоп: "Я специализируюсь только на кулинарии 👨‍🍳 Спроси меня о рецептах, ингредиентах или способах приготовления!"
`;

// ===== ПРАВИЛА ПОНЯТНОСТИ РЕЦЕПТА (по фидбеку пользователей) =====
// Решают 3 реальные жалобы: нет объёма воды/посуды, непонятно что делать
// с ингредиентом до конца, сложные «ресторанные» названия продуктов.
const RECIPE_CLARITY_RULES = `
ПРАВИЛА ПОНЯТНОСТИ (рецепт для новичка, который готовит впервые):
1. ПОСУДА И ВОДА. Всегда указывай размер посуды и объём жидкости, привязанные к числу порций. Для супов, бульонов, круп, макарон — обязательно (пример: «кастрюля 3 л, налей 2,5 л воды»). Для жарки — диаметр сковороды (пример: «сковорода 24 см»).
2. КАЖДЫЙ ИНГРЕДИЕНТ ДО КОНЦА. Запрещены размытые «добавь остальное», «закинь всё». Что достать, нарезать, обжарить, вернуть — пиши явным действием. Мясо на кости: свари → достань → отдели от кости → разбери на волокна → верни в блюдо.
3. ПРОСТЫЕ МАГАЗИННЫЕ НАЗВАНИЯ. Только обиходные названия, по которым продукт реально купят: «салат романо» (НЕ «римские листья салата»), «пекинская капуста», «руккола». Незнакомое поясняй в скобках: «романо (хрустящий длинный салат)».`;


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

// Запрос про напиток? (напитки доступны только в тарифе «Про»)
function detectDrink(text) {
  const t = (text || '').toLowerCase();
  // Многословные/длинные — простое вхождение
  const phrases = ['напиток', 'напитк', 'смузи', 'коктейль', 'коктейл', 'молочный коктейль',
    'лимонад', 'компот', 'морс', 'глинтвейн', 'пунш', 'мохито', 'капучино', 'латте',
    'раф ', 'милкшейк', 'милк-шейк', 'кисель', 'какао', 'горячий шоколад'];
  if (phrases.some(p => t.includes(p))) return true;
  // Короткие слова — по границам, чтобы не ловить «сочный», «чайная ложка»
  if (/(^|[^а-яё])(чай|кофе|сок|квас|фреш|тоник|эспрессо)([^а-яё]|$)/i.test(t)) return true;
  return false;
}

// Грубая проверка «явно не про еду» — быстрый отказ без вызова ИИ
function looksNonFood(text) {
  const t = (text || '').toLowerCase();
  const nonFood = ['погод', 'прогноз', 'новост', 'курс валют', 'доллар', 'евро', 'биткоин',
    'политик', 'президент', 'гороскоп', 'анекдот', 'реферат',
    'сочинени', 'перевод', 'переведи', 'программ', 'код на', 'python', 'javascript',
    'математ', 'уравнени', 'столиц', 'население', 'википеди', 'кто так', 'что такое жизнь',
    'смысл жизни', 'знакомств', 'девушк', 'парень для', 'кредит', 'ипотек', 'лекарств от'];
  if (!nonFood.some(k => t.includes(k))) return false;
  // Если в тексте всё же есть явные кулинарные слова — не блокируем
  const foodHints = ['рецепт', 'приготов', 'блюд', 'суп', 'салат', 'соус', 'десерт', 'торт',
    'выпечк', 'запекан', 'пожар', 'свар', 'ингредиент', 'поужина', 'позавтрак', 'обед'];
  return !foodHints.some(k => t.includes(k));
}

function buildPrompt(requestType, ingredients, details, planType, prefs = {}, cookware = '') {
  const isVIP = planType === 'VIP';
  const isPRO = planType === 'PRO' || isVIP;
  const allergies = prefs.allergies || '';
  const modeText = isVIP ? modeBlock(prefs) : '';
  // Если пользователь явно указал посуду — готовим под неё и предупреждаем о несоответствии
  const cookwareNote = (cookware && cookware !== 'auto')
    ? `\n\nПОСУДА ПОЛЬЗОВАТЕЛЯ: ${cookware}. Готовь рецепт именно под эту посуду и явно укажи её в блоке «🍲 ПОСУДА». Если для ${prefs.portions || 2} порц. она маловата или велика — мягко предупреди и подскажи подходящий объём.`
    : '';

  const system = `${allergyBlock(allergies)}Ты — шеф-повар и наставник. Пиши рецепт так, чтобы по нему даже новичок приготовил блюдо идеально с первого раза: каждый шаг понятен, ничего не нужно додумывать.

‼️ СНАЧАЛА ПРОВЕРЬ ТЕМУ. Если запрос НЕ про приготовление еды, блюд, напитков или продуктов (например: погода, новости, политика, перевод, программирование, математика, личные вопросы и т.п.) — НЕ выдумывай рецепт. Ответь РОВНО одной строкой и больше ничем: NOT_FOOD
Рецепт по формату ниже выдавай ТОЛЬКО если запрос действительно про еду.
${FOOD_ONLY_GUARD}${modeText}

ФОРМАТ ОТВЕТА (соблюдай ТОЧНО, ни один блок не пропускай):

🍽 [Название] — [одно ёмкое предложение]

📝 О блюде: [2 предложения: чем хорошо и в чём изюминка]

👥 Порций: ${prefs.portions || 2} | ⏱ Подготовка: [X мин] | 🔥 Готовка: [X мин]

🥣 ИНГРЕДИЕНТЫ:
— [продукт обиходным магазинным названием] — [точное количество в г/мл/шт]
(перечисли ВСЕ)

🔥 МЕТОД: [жарка/варка/запекание/тушение]
🍲 ПОСУДА: [конкретно: кастрюля 3 л / сковорода 24 см]
🌡 Температура: [180°C или средний огонь]
💧 ЖИДКОСТЬ: [объём воды/бульона в л/мл — для супов, круп, макарон; если без жидкости — «—»]

👨‍🍳 ПОШАГОВЫЙ РЕЦЕПТ:
Шаг 1. [Конкретное действие + как понять, что готово] — [X мин]
(минимум 6 шагов; в каждом — время и критерий готовности; каждый ингредиент доведён до конца)

💡 СОВЕТЫ ШЕФА:
— [частая ошибка новичка и как её избежать]
— [возможная замена ингредиента]

🍷 ПОДАЧА: [как подать + с чем сочетать]${isPRO ? '\n📊 КБЖУ на порцию: [X] ккал · Б [X]г · Ж [X]г · У [X]г' : ''}

ЭТАЛОН ДЕТАЛИЗАЦИИ ШАГА (такого уровня жду каждый шаг):
«Шаг 3. Свари говядину на кости: в кастрюлю 3 л налей 2 л холодной воды, положи мясо, доведи до кипения, сними пену и вари 1 час на тихом огне до мягкости. Достань мясо, отдели от кости, разбери на волокна и верни в суп — на кости в готовом блюде его не оставляем. — 60 мин»

ГЛАВНЫЕ ПРАВИЛА:
— Минимум 6 шагов, точные граммы (не «по вкусу» для основных продуктов), реальное время.
— Коротко объясняй ПОЧЕМУ так делается (чтобы человек понял технику, а не просто повторил).
— Только продукты из обычного супермаркета. Без HTML и markdown-звёздочек **.
${RECIPE_CLARITY_RULES}${cookwareNote}`;

  const reminder = `\n\nЕсли запрос выше НЕ про еду — ответь только: NOT_FOOD\nИначе ПЕРЕД ОТВЕТОМ ПРОВЕРЬ: указаны размер посуды и объём воды; каждый ингредиент доведён до конца (что достать/нарезать/вернуть); названия продуктов простые магазинные; минимум 6 шагов со временем и критерием готовности. Пиши строго по формату.`;

  const user = (requestType === 'ingredients'
    ? `Придумай блюдо из этих продуктов (плюс базовые соль/перец/масло). Сделай профессиональный рецепт.

ПРОДУКТЫ: ${ingredients}
${details ? `ПОЖЕЛАНИЯ: ${details}` : ''}`
    : `Дай профессиональный рецепт.

БЛЮДО: ${ingredients}
${details ? `ПОЖЕЛАНИЯ: ${details}` : ''}

Минимум 6 подробных шагов с критериями готовности.`) + reminder;

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
    // Сколько блюд приготовлено всего — для достижений и личности шефа
    let recipesTotal = 0;
    try {
      const { rows: [c] } = await global.pool.query(`SELECT COUNT(*)::int AS n FROM recipes WHERE user_id=$1`, [tgId]);
      recipesTotal = c?.n || 0;
    } catch {}
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
      recipesTotal,
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
    const { ingredients, details, portions, cookware } = req.body;
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
    const planType = sub?.plan_type || 'FREE';

    // ТЕМА: принимаем только запросы про еду (быстрый отказ без вызова ИИ)
    if (looksNonFood(ingredients)) {
      return res.status(422).json({ error: 'not_food', message: 'Я помогаю только с рецептами, переформулируйте запрос' });
    }
    // НАПИТКИ доступны только в тарифе «Про» (внутренний код VIP)
    if (detectDrink(ingredients) && planType !== 'VIP') {
      return res.status(403).json({
        error: 'drinks_pro_only',
        message: 'Рецепты напитков доступны в тарифе «Про». Оформите его, чтобы готовить напитки 🍹',
        prices: { PRO: PRO_PRICE, VIP: VIP_PRICE }
      });
    }

    if (!sub && user.free_recipes_used >= FREE_LIMIT) {
      return res.status(403).json({
        error: 'limit_reached',
        message: 'Лимит исчерпан',
        prices: { PRO: PRO_PRICE, VIP: VIP_PRICE }
      });
    }

    const userPrefs = await getUserPrefs(tgId);
    // Порции, выбранные на экране, имеют приоритет над сохранёнными в профиле
    if (portions) userPrefs.portions = Math.max(1, Math.min(20, parseInt(portions) || userPrefs.portions));
    const safeCookware = String(cookware || '').trim().slice(0, 40);
    const requestType = detectRequestType(ingredients);
    const prompt = buildPrompt(requestType, ingredients, details, planType, userPrefs, safeCookware);

    let recipe = await callGigaChat(prompt.system, prompt.user, 2500, 0.6);
    recipe = cleanHtml(recipe);

    // ИИ распознал, что запрос не про еду — возвращаем вежливый отказ
    const trimmedRecipe = recipe.trim();
    if (/^NOT_FOOD/i.test(trimmedRecipe) || (trimmedRecipe.includes('NOT_FOOD') && trimmedRecipe.length < 120)) {
      return res.status(422).json({ error: 'not_food', message: 'Я помогаю только с рецептами, переформулируйте запрос' });
    }

    // ПОСТ-ПРОВЕРКА АЛЛЕРГЕНОВ — если AI всё же вставил аллерген, перегенерируем
    if (userPrefs.allergies) {
      const found = detectAllergenInText(recipe, userPrefs.allergies);
      if (found) {
        console.warn(`[Allergy] Аллерген "${found}" найден в рецепте, перегенерация...`);
        // Усиленный запрос с явным указанием убрать конкретный аллерген
        const retryUser = `${prompt.user}

❌❌❌ ВНИМАНИЕ: В прошлом ответе ты ОШИБСЯ и использовал "${found}" — это АЛЛЕРГЕН пользователя!
Сделай рецепт ЗАНОВО ПОЛНОСТЬЮ БЕЗ "${found}". 
Замени его другим продуктом. В начале напиши: "⚠️ ВАЖНО: Я исключил ${found} — он в твоих аллергиях, заменил на [замену]."
Проверь что слова "${found}" НЕТ нигде в рецепте.`;

        try {
          let retry = await callGigaChat(prompt.system, retryUser, 2500, 0.5);
          retry = cleanHtml(retry);
          // Если и повторно содержит — оставляем повтор (он хотя бы с пометкой), но логируем
          const stillFound = detectAllergenInText(retry, userPrefs.allergies);
          if (stillFound) {
            console.error(`[Allergy] Повторно не удалось убрать "${found}"`);
          }
          recipe = retry;
        } catch (e) {
          console.error('[Allergy] Retry failed:', e.message);
        }
      }
    }

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
    global.recordError?.('Генерация рецепта', e.message);
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

// ===== РЕКОМЕНДАЦИИ «ТВОИ ХИТЫ» (профиль вкуса, без ИИ) =====
// Должен идти ДО /recipes/:id, иначе "recommendations" попадёт в :id
router.get('/recipes/recommendations', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    // Любимые и высоко оценённые блюда — для повтора в один тап
    const { rows } = await global.pool.query(
      `SELECT id, title, rating, cooked_count, is_favorite
       FROM recipes
       WHERE user_id=$1 AND (is_favorite=TRUE OR rating>=4 OR cooked_count>0)
       ORDER BY is_favorite DESC, COALESCE(rating,0) DESC, cooked_count DESC, created_at DESC
       LIMIT 6`,
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
      notes: r.notes || '',
      cookedCount: r.cooked_count
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ЗАМЕТКА К РЕЦЕПТУ (профиль вкуса) =====
router.post('/recipes/:id/note', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const notes = String(req.body.notes || '').slice(0, 500).trim();
    const { rows: [updated] } = await global.pool.query(
      `UPDATE recipes SET notes=$1 WHERE id=$2 AND user_id=$3 RETURNING notes`,
      [notes, id, tgId]
    );
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, notes: updated.notes });
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

// ===== СБРОС ИСТОРИИ БЛЮД ИЗ МЕНЮ (чтобы можно было повторить старые) =====
router.post('/vip/weekmenu-reset-history', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { rows: [r] } = await global.pool.query(
      `DELETE FROM weekmenu_dishes WHERE user_id=$1 RETURNING (SELECT COUNT(*) FROM weekmenu_dishes WHERE user_id=$1) AS cnt`,
      [tgId]
    );
    // Считаем сколько удалили
    const { rows: [{ count }] } = await global.pool.query(
      `SELECT COUNT(*)::int as count FROM weekmenu_dishes WHERE user_id=$1`,
      [tgId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== СКОЛЬКО БЛЮД В ИСТОРИИ =====
router.get('/vip/weekmenu-history-count', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { rows: [{ count }] } = await global.pool.query(
      `SELECT COUNT(*)::int as count FROM weekmenu_dishes WHERE user_id=$1 AND created_at > NOW() - INTERVAL '60 days'`,
      [tgId]
    );
    res.json({ count });
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
        `   • Тариф: <b>${planName(planType)}</b>\n` +
        `   • Сумма: <b>${amount}₽</b>\n` +
        `   • Статус юзера: ${isNewUser ? '🆕 Новый' : `📅 ${planName(currentSub.plan_type)} до ${new Date(currentSub.expires_at).toLocaleDateString('ru-RU')}`}\n\n` +
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
    global.recordError?.('Загрузка чека', e.message);
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

    const systemPrompt = `Ты шеф-повар и диетолог. Составляешь сбалансированное меню на день для ${portions} чел.

${FOOD_ONLY_GUARD}${allergyBlock(allergies)}${modeText}
${levelInstructions[level] || levelInstructions.base}

ПРИНЦИПЫ БАЛАНСА:
— Завтрак (25-30% калорий): сложные углеводы + белок
— Обед (35-40%): белок + углеводы + овощи
— Ужин (20-25%): белок + овощи, минимум углеводов
— Перекус (10-15%): фрукт/йогурт/орехи

ФОРМАТ ОТВЕТА (строго для КАЖДОГО приёма пищи):

🌅 ЗАВТРАК: [Название]
🥣 Ингредиенты на ${portions} чел.:
— [продукт] — [точное количество]
⏱ Время: [X мин] | 🌡 [180°C / средний огонь]
👨‍🍳 Пошаговый рецепт:
1. [Действие с деталями] — [X мин]
2. [Действие + критерий: "до золотистой корочки"] — [X мин]
(минимум 4 шага)
📊 КБЖУ: [X] ккал | Белки [X]г | Жиры [X]г | Углеводы [X]г
💡 Совет: [лайфхак или замена]

☀️ ОБЕД: [Название]
[та же структура, 5-6 шагов]

🌙 УЖИН: [Название]
[та же структура, 5-6 шагов]

🍎 ПЕРЕКУС: [Название]
🥣 Ингредиенты: [список]
👨‍🍳 Приготовление: [3 шага]
📊 КБЖУ: [X] ккал | Белки [X]г | Жиры [X]г | Углеводы [X]г

📊 ИТОГО ЗА ДЕНЬ: [X] ккал | Белки [X]г | Жиры [X]г | Углеводы [X]г

ПРАВИЛА:
1. Блюда не повторяются между днями
2. Точные граммы для всех продуктов
3. Каждый шаг с критерием готовности
4. Завтрак до 20 мин, обед/ужин до 45 мин
5. Без HTML и markdown звёздочек
6. Для блюд с жидкостью указывай объём посуды и воды
${RECIPE_CLARITY_RULES}`;

    // Загружаем историю блюд за последние 60 дней — чтобы не повторять
    const { rows: historyRows } = await global.pool.query(
      `SELECT dish_name FROM weekmenu_dishes
       WHERE user_id=$1 AND created_at > NOW() - INTERVAL '60 days'
       ORDER BY created_at DESC LIMIT 50`,
      [tgId]
    );
    const historyDishes = historyRows.map(r => r.dish_name);

    // Генерируем каждый день отдельным запросом — полный рецепт гарантирован
    const dayResults = [];
    const usedDishes = [...historyDishes]; // начинаем с истории
    const newDishesToSave = []; // новые блюда из текущей генерации

    for (let i = 0; i < 7; i++) {
      const dayName = days[i];
      // Берём последние 20 блюд для промпта — больше не влезет в Lite
      const avoidList = usedDishes.slice(-20);
      const userMsg = `Меню на ДЕНЬ ${i + 1} — ${dayName}.
${prefs ? `Пожелания: ${prefs}` : ''}
${avoidList.length ? `СТРОГО НЕ повторяй эти блюда (они уже были): ${avoidList.join(', ')}` : ''}

Придумай ОРИГИНАЛЬНЫЕ блюда — те, которые НЕ из списка выше. Завтрак — углеводный, обед — питательный, ужин — белковый.`;

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

      // Извлекаем названия блюд для следующих дней + БД
      const mealRegex = /(ЗАВТРАК|ОБЕД|УЖИН|ПЕРЕКУС):\s*([^\n]+)/gi;
      let match;
      while ((match = mealRegex.exec(clean)) !== null) {
        const mealType = match[1].toLowerCase();
        // Чистим название от лишнего — берём только саму суть до запятой/тире
        const name = match[2]
          .replace(/[—–-]\s*[^\n]+$/, '')   // убираем описание после тире
          .replace(/[,(].*$/, '')             // убираем после запятой/скобки
          .trim()
          .slice(0, 100);
        if (name && name.length > 2) {
          usedDishes.push(name);
          newDishesToSave.push({ name, mealType });
        }
      }
    }

    const menu = dayResults.join('\n\n\n');

    // Сохраняем новые блюда в БД для будущих генераций
    if (newDishesToSave.length > 0) {
      const values = newDishesToSave.map((_, idx) => `($1, $${idx * 2 + 2}, $${idx * 2 + 3})`).join(',');
      const params = [tgId];
      newDishesToSave.forEach(d => {
        params.push(d.name);
        params.push(d.mealType);
      });
      await global.pool.query(
        `INSERT INTO weekmenu_dishes (user_id, dish_name, meal_type) VALUES ${values}`,
        params
      ).catch(e => console.warn('Save weekmenu dishes failed:', e.message));

      // Чистим старые записи (старше 90 дней) — чтобы таблица не росла бесконечно
      await global.pool.query(
        `DELETE FROM weekmenu_dishes WHERE user_id=$1 AND created_at < NOW() - INTERVAL '90 days'`,
        [tgId]
      ).catch(() => {});
    }

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
    global.recordError?.('Меню на неделю', e.message);
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
- ВАЖНО: пиши обиходное магазинное название, по которому продукт реально можно купить в обычном российском супермаркете. Например: "салат романо" (НЕ "римские листья салата"), "пекинская капуста", "руккола". Никаких ресторанных и иностранных терминов, непонятных покупателю.
- amount: точное количество с единицей измерения (г, кг, мл, л, шт, ст.л., ч.л., зубчик, пучок)
- Если одинаковый продукт встречается несколько раз — просуммируй количество
- НЕ включай: вода, соль, чёрный перец, растительное масло (это базовые продукты которые есть у всех)
- Отвечай СТРОГО только JSON объектом — никакого текста до или после`;

    const raw = await callGigaChat(system, `Извлеки продукты для покупки из этого рецепта:\n\n${cleanRecipe}`, 1500, 0.3);
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
    global.recordError?.('Список покупок', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== ЗАМЕНА ИНГРЕДИЕНТА (доступно всем, не тратит лимит рецептов) =====
router.post('/recipe/substitute', async (req, res) => {
  try {
    const ingredient = String(req.body.ingredient || '').trim().slice(0, 80);
    const dish = String(req.body.dish || '').replace(/<[^>]+>/g, '').trim().slice(0, 120);
    if (ingredient.length < 2) return res.status(400).json({ error: 'Укажи продукт для замены' });

    const tgId = req.telegramUser.id;
    const userPrefs = await getUserPrefs(tgId);

    const system = `Ты — шеф-повар. У пользователя нет одного продукта, и он спрашивает, чем его заменить в конкретном блюде.
Дай 2–3 РЕАЛЬНЫЕ замены, которые продаются в обычном российском супермаркете.
${allergyBlock(userPrefs.allergies)}
Формат ответа (без вступлений и лишнего текста):
🔄 Чем заменить: ${ingredient}
— [замена] — [сколько брать вместо оригинала + как повлияет на вкус/текстуру, кратко]
— [замена] — [...]
— [замена] — [...]

Правила: простые магазинные названия; конкретные пропорции; 1 строка на замену. Если адекватной замены нет — честно скажи об этом и предложи убрать продукт. Без HTML и markdown-звёздочек.`;

    const user = `Блюдо: ${dish || 'домашнее блюдо'}.
Нужно заменить продукт: ${ingredient}.
Предложи замены, которые не испортят блюдо.`;

    let answer = await callGigaChat(system, user, 600, 0.4);
    answer = cleanHtml(answer);
    res.json({ ingredient, answer });
  } catch (e) {
    console.error('Substitute error:', e);
    global.recordError?.('Замена ингредиента', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== «ЧТО ПРИГОТОВИТЬ?» — персональная подсказка по вкусу (дешёвый ИИ) =====
router.post('/recipe/suggest', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const moods = {
      fast: 'быстро (до 20 минут)',
      hearty: 'сытно и питательно',
      light: 'лёгкое и полезное',
      surprise: 'удиви меня чем-то необычным'
    };
    const mood = moods[req.body.mood] || '';

    const prefs = await getUserPrefs(tgId);
    // Профиль вкуса: что пользователь высоко оценил / часто готовил
    let liked = [];
    try {
      const { rows } = await global.pool.query(
        `SELECT title FROM recipes WHERE user_id=$1 AND (is_favorite=TRUE OR rating>=4)
         ORDER BY COALESCE(rating,0) DESC, cooked_count DESC, created_at DESC LIMIT 8`,
        [tgId]
      );
      liked = rows.map(r => r.title).filter(Boolean);
    } catch {}

    const tasteBlock = liked.length ? `Пользователю раньше понравились: ${liked.join(', ')}. Учитывай его вкус, но НЕ повторяй эти же блюда — предложи новое в похожем духе.` : 'История вкуса пока пустая — предложи популярные универсальные блюда.';
    const favBlock = prefs.favorites ? `Любит продукты: ${prefs.favorites}.` : '';
    const dislikeBlock = prefs.disliked ? `Не любит: ${prefs.disliked}.` : '';

    const system = `Ты — шеф-повар. Предложи РОВНО 3 идеи, что приготовить, под вкус и запрос пользователя.
${allergyBlock(prefs.allergies)}
Только домашние блюда из продуктов обычного супермаркета.
Формат ответа СТРОГО (без вступлений, без нумерации лишним текстом):
1. [Название блюда] — [почему подойдёт, одна короткая фраза]
2. [Название блюда] — [...]
3. [Название блюда] — [...]
Названия — простые и понятные. Без HTML и markdown-звёздочек.`;

    const user = `${tasteBlock} ${favBlock} ${dislikeBlock}
${mood ? `Сейчас хочется: ${mood}.` : ''}
Предложи 3 идеи на сегодня.`;

    const raw = await callGigaChat(system, user, 350, 0.85);
    // Парсим строки вида "1. Блюдо — описание"
    const ideas = String(raw).split('\n')
      .map(l => l.trim())
      .filter(l => /^\d+[.)]/.test(l))
      .map(l => {
        const clean = l.replace(/^\d+[.)]\s*/, '').replace(/<[^>]+>/g, '').replace(/\*+/g, '');
        const sep = clean.search(/\s[—–-]\s/);
        const dish = (sep > 0 ? clean.slice(0, sep) : clean).trim();
        const reason = sep > 0 ? clean.slice(sep).replace(/^\s*[—–-]\s*/, '').trim() : '';
        return { dish: dish.slice(0, 60), reason: reason.slice(0, 120) };
      })
      .filter(i => i.dish.length > 1)
      .slice(0, 3);

    if (!ideas.length) return res.json({ ideas: [{ dish: raw.slice(0, 60).trim(), reason: '' }] });
    res.json({ ideas });
  } catch (e) {
    console.error('Suggest error:', e);
    global.recordError?.('Что приготовить', e.message);
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
    const raw = await callGigaChat(system, `Меню на неделю:\n${menuTrunc}`, 2500, 0.3);

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

    const system = `Ты — консультант по здоровому питанию (нутрициолог). Даёшь ОБЩИЕ рекомендации и советы по питанию на основе доказательной базы (ВОЗ, EFSA), без модных диет.

⚕️ ГРАНИЦА КОМПЕТЕНЦИИ (СТРОГО): Ты НЕ врач. Тебе ЗАПРЕЩЕНО ставить диагнозы, назначать лечение, лечебные диеты при заболеваниях, дозировки лекарств и трактовать анализы или симптомы.
Если пользователь просит вылечить болезнь, поставить диагноз, назначить лечебную диету или лекарства — НЕ делай этого. Ответь дословно с этой мысли:
«Я не врач и не могу ставить диагнозы или назначать лечение — с этим обязательно обратитесь к врачу или клиническому диетологу 🩺»
После этого можешь дать только общий безопасный совет по здоровому питанию (без привязки к лечению).
${FOOD_ONLY_GUARD}${allergyBlock(allergies)}

ФОРМАТ ОТВЕТА:

🥗 [Заголовок одной фразой]

📋 КРАТКО: [Прямой ответ за 2-3 предложения с конкретными цифрами]

📊 ПОДРОБНЕЕ:
[4-6 предложений с цифрами: КБЖУ, граммы, проценты, гликемический индекс. Без воды.]

✅ ЧТО ДЕЛАТЬ:
— [Действие с цифрой: "Снизь углеводы вечером до 30г"]
— [Действие: "Добавь 80-100г белка на завтрак"]
— [Действие с конкретикой]

⚠️ ВАЖНО:
— [Развенчай распространённый миф по теме]
— [Когда нужна консультация врача — если касается здоровья]

🍽 ПРОДУКТЫ-ПОМОЩНИКИ:
— [Продукт] — [нутриент и сколько на 100г]
— [Продукт] — [почему именно он]
— [Продукт] — [почему]

💡 ЛАЙФХАК: [Один конкретный приём, не "пейте больше воды"]

КРИТИЧЕСКИЕ ПРАВИЛА:
1. Конкретные цифры везде где можно (граммы, ккал, мг, %)
2. Развенчивай мифы — это уровень профи
3. Не используй "детокс", "очищение", "шлаки" — псевдонаука
4. Болезни/диагнозы/лечение/лекарства — НЕ твоя зона: сообщи, что ты не врач, и направь к специалисту
5. Без HTML и markdown звёздочек
6. Если вопрос не про еду/питание — мягко верни в тему`;
    const answer = await callGigaChat(system, question, 1500, 0.5);
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
    // Расширенные метрики: активность, рецепты, вовлечённость, «зависшие» платежи
    const { rows: [extra] } = await global.pool.query(`SELECT
      (SELECT COUNT(*) FROM recipes) as recipes_total,
      (SELECT COUNT(*) FROM recipes WHERE created_at > NOW() - INTERVAL '24 hours') as recipes_today,
      (SELECT COUNT(*) FROM recipes WHERE created_at > NOW() - INTERVAL '7 days') as recipes_week,
      (SELECT COUNT(DISTINCT user_id) FROM recipes WHERE created_at > NOW() - INTERVAL '24 hours') as active_today,
      (SELECT COUNT(DISTINCT user_id) FROM recipes WHERE created_at > NOW() - INTERVAL '7 days') as active_week,
      (SELECT COUNT(*) FROM users WHERE is_banned = TRUE) as banned_users,
      (SELECT COUNT(*) FROM users WHERE onboarding_done = TRUE) as onboarded_users,
      (SELECT COUNT(*) FROM users WHERE daily_reminder = TRUE AND is_banned = FALSE) as reminders_on,
      (SELECT COUNT(DISTINCT user_id) FROM payments WHERE status='approved') as paying_users,
      (SELECT COUNT(*) FROM payments WHERE status='rejected') as rejected_payments,
      (SELECT ROUND(AVG(rating)::numeric, 2) FROM recipes WHERE rating IS NOT NULL) as avg_rating,
      (SELECT COUNT(*) FROM recipes WHERE is_favorite = TRUE) as favorites_total,
      (SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))/3600, 1) FROM payments WHERE status='pending') as oldest_pending_hours
    `);
    res.json({ basic, extra, regChart, revChart, expiring, prices: { PRO: PRO_PRICE, VIP: VIP_PRICE } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: МОНИТОРИНГ СИСТЕМЫ =====
// Позволяет ловить проблемы (БД, ИИ, зависшие платежи) ДО жалоб пользователей.
router.get('/admin/health', adminAuth, async (req, res) => {
  const health = { ts: Date.now() };

  // База данных — доступность и задержка
  const t0 = Date.now();
  try {
    await global.pool.query('SELECT 1');
    health.db = { up: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    health.db = { up: false, latencyMs: Date.now() - t0, error: e.message };
  }

  // ИИ GigaChat — статус токена и результат последнего вызова
  try {
    health.gigachat = getGigaChatHealth();
  } catch (e) {
    health.gigachat = { configured: false, error: e.message };
  }

  // Бот и интеграции
  health.bot = { configured: !!process.env.BOT_TOKEN, adminConfigured: !!ADMIN_ID };
  health.stt = { configured: !!process.env.YANDEX_API_KEY };

  // Зависшие платежи и истекающие подписки — деньги под риском
  try {
    const { rows: [p] } = await global.pool.query(`SELECT
      (SELECT COUNT(*) FROM payments WHERE status='pending') as pending_count,
      (SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))/3600, 1) FROM payments WHERE status='pending') as oldest_pending_hours,
      (SELECT COUNT(*) FROM subscriptions WHERE is_active=TRUE AND expires_at BETWEEN NOW() AND NOW() + INTERVAL '3 days') as expiring_soon
    `);
    health.payments = {
      pending: parseInt(p.pending_count) || 0,
      oldestPendingHours: p.oldest_pending_hours !== null ? parseFloat(p.oldest_pending_hours) : null,
      expiringSoon: parseInt(p.expiring_soon) || 0
    };
  } catch (e) {
    health.payments = { error: e.message };
  }

  // Сервер
  const mem = process.memoryUsage();
  health.server = {
    uptimeSec: Math.round(process.uptime()),
    memoryMB: Math.round(mem.rss / 1048576),
    node: process.version,
    env: process.env.NODE_ENV || 'development'
  };

  // Последние ошибки
  health.errors = (global.errorLog || []).slice(0, 30);

  res.json(health);
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
    const { rows: [{ count: recipesCount }] } = await global.pool.query(
      `SELECT COUNT(*) FROM recipes WHERE user_id = $1`, [tgId]
    );
    const { rows: recentRecipes } = await global.pool.query(
      `SELECT id, title, rating, created_at FROM recipes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`, [tgId]
    );
    res.json({ user, subscriptions: subs, payments, recipesCount: parseInt(recipesCount) || 0, recentRecipes });
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
        `🎉 <b>Администратор выдал вам тариф «${planName(planType)}»!</b>\n📅 До: ${expiresAt.toLocaleDateString('ru-RU')}`,
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
        `🎉 <b>Подписка «${planName(payment.plan_type)}» активирована!</b>\n📅 До: ${expiresAt.toLocaleDateString('ru-RU')}`,
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

// ===== 404 ДЛЯ НЕИЗВЕСТНЫХ API-МАРШРУТОВ =====
router.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Маршрут не найден' });
});

// ===== ЦЕНТРАЛЬНЫЙ ОБРАБОТЧИК ОШИБОК =====
// Ловит в т.ч. ошибки multer (например, превышение размера файла),
// чтобы клиент получал понятный JSON вместо «голого» HTML-стека.
router.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file_too_large', message: 'Файл слишком большой (максимум 10 МБ)' });
  }
  console.error('API error:', err);
  res.status(500).json({ error: 'internal_error', message: 'Внутренняя ошибка сервера' });
});

module.exports = router;
