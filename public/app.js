// ============================================================
//  ШЕФ-ПОВАР AI — app.js
//  Полная профессиональная версия
// ============================================================

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor?.('secondary_bg_color');
  tg.disableVerticalSwipes?.();
}
const initData = tg?.initData || '';

// ============================================================
//  УТИЛИТЫ
// ============================================================

function $(id) { return document.getElementById(id); }

function toast(msg, type = 'success', duration = 3000) {
  document.querySelectorAll('.toast-msg').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = `toast-msg toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-show'));
  setTimeout(() => {
    el.classList.remove('toast-show');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

function haptic(type = 'light') {
  tg?.HapticFeedback?.impactOccurred(type);
}

function hapticNotify(type = 'success') {
  tg?.HapticFeedback?.notificationOccurred(type);
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ============================================================
//  API
// ============================================================

const API = {
  async request(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'x-telegram-init-data': initData,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
    return data;
  },
  getStatus:       ()       => API.request('/api/recipe/status'),
  getFullProfile:  ()       => API.request('/api/user/fullprofile'),
  getPaymentInfo:  ()       => API.request('/api/payment/info'),
  generateRecipe:  (ingredients, details) => API.request('/api/recipe/generate', {
    method: 'POST', body: JSON.stringify({ ingredients, details })
  }),
  generateWeekMenu: (prefs, level, portions) => API.request('/api/vip/weekmenu', {
    method: 'POST', body: JSON.stringify({ prefs, level, portions })
  }),
  askDiet: (question) => API.request('/api/vip/diet', {
    method: 'POST', body: JSON.stringify({ question })
  }),
  getShoppingList: (recipe) => API.request('/api/recipe/shopping-list', {
    method: 'POST', body: JSON.stringify({ recipe })
  }),
  recognizeVoice: async (blob) => {
    const fd = new FormData();
    fd.append('audio', blob, 'voice.webm');
    const res = await fetch('/api/stt/recognize', {
      method: 'POST',
      headers: { 'x-telegram-init-data': initData },
      body: fd
    });
    if (!res.ok) throw new Error('Ошибка распознавания');
    return res.json();
  },
  uploadReceipt: async (file, planType) => {
    const fd = new FormData();
    fd.append('receipt', file);
    fd.append('planType', planType);
    const res = await fetch('/api/payment/upload', {
      method: 'POST',
      headers: { 'x-telegram-init-data': initData },
      body: fd
    });
    if (!res.ok) throw new Error('Ошибка загрузки');
    return res.json();
  },
  analyzeFridge: async (file) => {
    const fd = new FormData();
    fd.append('photo', file);
    const res = await fetch('/api/vip/fridge-scan', {
      method: 'POST',
      headers: { 'x-telegram-init-data': initData },
      body: fd
    });
    if (!res.ok) throw new Error('Ошибка анализа');
    return res.json();
  },
  rescueCook: (ingredients, prefs) => API.request('/api/vip/rescue-cook', {
    method: 'POST', body: JSON.stringify({ ingredients, prefs })
  })
};

// ============================================================
//  TTS — Google Translate Voice
// ============================================================

const abbrMap = {
  'шт\\.?\\b': 'штук', 'г\\.?\\b': 'грамм', 'мл\\b': 'миллилитров',
  'кг\\b': 'килограмм', 'ч\\.л\\.?\\b': 'чайной ложки',
  'ст\\.л\\.?\\b': 'столовой ложки', 'мин\\.?\\b': 'минут',
  'сек\\b': 'секунд', '°C': 'градусов Цельсия', '°': 'градусов'
};
const emojiRe = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu;

function prepareForTTS(text) {
  if (!text) return '';
  let s = text.replace(/<[^>]+>/g, '').replace(emojiRe, '').replace(/\n+/g, '. ').replace(/\s+/g, ' ').trim();
  for (const [abbr, full] of Object.entries(abbrMap))
    s = s.replace(new RegExp(abbr, 'gi'), full);
  return s.length > 4000 ? s.slice(0, 4000) + '...' : s;
}

const Voice = {
  _audio: null,
  _mediaRecorder: null,
  _chunks: [],
  isRecording: false,

  speak(text) {
    const clean = prepareForTTS(text);
    if (!clean) return;
    this.stop();
    const chunks = [];
    let rem = clean;
    while (rem.length > 0) {
      const cut = rem.length > 200 ? (rem.lastIndexOf(' ', 200) > 100 ? rem.lastIndexOf(' ', 200) : 200) : rem.length;
      chunks.push(rem.slice(0, cut).trim());
      rem = rem.slice(cut).trim();
    }
    let i = 0;
    const next = () => {
      if (i >= chunks.length) return;
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=ru&client=tw-ob&q=${encodeURIComponent(chunks[i++])}`;
      this._audio = new Audio(url);
      this._audio.playbackRate = 0.95;
      this._audio.onended = next;
      this._audio.onerror = next;
      this._audio.play().catch(() => {});
    };
    next();
  },

  stop() {
    if (this._audio) { this._audio.pause(); this._audio.src = ''; this._audio = null; }
    window.speechSynthesis?.cancel();
  },

  async startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this._mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      this._chunks = [];
      this._mediaRecorder.ondataavailable = e => { if (e.data.size > 0) this._chunks.push(e.data); };
      this._mediaRecorder.start();
      this.isRecording = true;
      return true;
    } catch {
      toast('Нет доступа к микрофону', 'error');
      return false;
    }
  },

  stopRecording() {
    return new Promise(resolve => {
      if (!this._mediaRecorder) return resolve('');
      this._mediaRecorder.onstop = async () => {
        const blob = new Blob(this._chunks, { type: 'audio/webm' });
        this._mediaRecorder.stream.getTracks().forEach(t => t.stop());
        this.isRecording = false;
        try { const d = await API.recognizeVoice(blob); resolve(d.text || ''); }
        catch { resolve(''); }
      };
      this._mediaRecorder.stop();
    });
  }
};

// ============================================================
//  ИСТОРИЯ РЕЦЕПТОВ
// ============================================================

const RecipeHistory = {
  KEY: 'chef_history_v2',
  load() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); } catch { return []; }
  },
  save(list) {
    try { localStorage.setItem(this.KEY, JSON.stringify(list.slice(0, 20))); } catch {}
  },
  push(recipe) {
    if (!recipe?.title) return;
    const list = this.load();
    const title = recipe.title.replace(/<[^>]+>/g, '');
    // Не дублируем одно и то же блюдо подряд
    if (list[0]?.title === title) return;
    list.unshift({ title, ts: Date.now(), fullText: recipe.fullText || recipe.steps?.join('\n\n') || '' });
    this.save(list);
  },
  clear() {
    try { localStorage.removeItem(this.KEY); } catch {}
  }
};
window.RecipeHistory = RecipeHistory;

// ============================================================
//  STEP TIMER
// ============================================================

const StepTimer = {
  _interval: null,
  _seconds: 0,
  running: false,

  start(secs) {
    this.stop();
    this._seconds = secs;
    this.running = true;
    this._render();
    this._interval = setInterval(() => {
      if (this._seconds > 0) { this._seconds--; this._render(); }
      else { this.stop(); this._onDone(); }
    }, 1000);
  },

  stop() {
    clearInterval(this._interval);
    this.running = false;
    this._render();
  },

  _render() {
    const m = String(Math.floor(this._seconds / 60)).padStart(2, '0');
    const s = String(this._seconds % 60).padStart(2, '0');
    const disp = $('step-timer-display');
    const btn  = $('btn-step-timer');
    if (disp) disp.textContent = `${m}:${s}`;
    if (btn)  btn.textContent = this.running ? '⏹ Стоп' : '▶ Старт';
  },

  _onDone() {
    hapticNotify('success');
    navigator.vibrate?.([200, 100, 200]);
    toast('⏰ Время вышло! Переходи к следующему шагу.', 'success', 4000);
  },

  promptStart() {
    const plan = window._userPlan || 'FREE';
    if (plan === 'FREE') { showScreen('subscription'); return; }
    if (this.running) { this.stop(); return; }
    // Пытаемся вытащить время из текста текущего шага
    const stepText = $('step-text')?.textContent || '';
    const mins = stepText.match(/(\d+)\s*мин/i);
    const defaultMins = mins ? parseInt(mins[1]) : 5;
    const input = prompt(`Сколько минут таймер? (по умолчанию ${defaultMins})`, defaultMins);
    const parsed = parseInt(input);
    if (!isNaN(parsed) && parsed > 0) this.start(parsed * 60);
  }
};

// ============================================================
//  RECIPE MANAGER
// ============================================================

const RecipeManager = {
  current: null,
  step: 0,

  load(recipe) {
    this.current = recipe;
    this.step = 0;
    RecipeHistory.push(recipe);
    this._updatePlanUI();
    this.render();
  },

  _updatePlanUI() {
    const plan = window._userPlan || 'FREE';
    const timerWrap = $('step-timer-wrap');
    const lockShopping = $('lock-shopping');
    const lockShare = $('lock-share');
    if (timerWrap)    timerWrap.style.display = plan !== 'FREE' ? 'flex' : 'none';
    if (lockShopping) lockShopping.style.display = plan !== 'FREE' ? 'none' : 'inline';
    if (lockShare)    lockShare.style.display    = plan === 'VIP' ? 'none' : 'inline';
  },

  render() {
    if (!this.current) return;
    const { title, steps, total } = this.current;
    const pct = Math.round(((this.step + 1) / total) * 100);
    $('recipe-title').innerHTML = title;
    $('step-current').textContent = this.step + 1;
    $('step-total').textContent = total;
    $('step-text').innerHTML = steps[this.step];
    $('step-progress-fill').style.width = pct + '%';
    $('step-percent').textContent = pct + '%';
    $('btn-prev').disabled = this.step === 0;
    const nextBtn = $('btn-next');
    if (this.step === total - 1) {
      nextBtn.textContent = '🏁 Готово!';
      nextBtn.classList.add('done');
    } else {
      nextBtn.textContent = 'Далее →';
      nextBtn.classList.remove('done');
    }
    // Сбрасываем таймер при смене шага
    StepTimer.stop();
  },

  next() {
    if (!this.current) return;
    if (this.step < this.current.total - 1) {
      this.step++;
      this.render();
      haptic('light');
    } else {
      hapticNotify('success');
      toast('🎉 Блюдо готово! Приятного аппетита!', 'success', 4000);
      showScreen('home');
    }
  },

  prev() {
    if (this.step > 0) {
      this.step--;
      this.render();
      haptic('light');
    }
  }
};

// ============================================================
//  WEEK MENU
// ============================================================

const WeekMenuStorage = {
  KEY: 'chef_weekmenu_v2',
  save(text) { try { localStorage.setItem(this.KEY, JSON.stringify({ text, ts: Date.now() })); } catch {} },
  load() { try { const d = JSON.parse(localStorage.getItem(this.KEY)); return d?.text || null; } catch { return null; } },
  clear() { try { localStorage.removeItem(this.KEY); } catch {} }
};

const WeekMenu = {
  days: [],
  current: 0,
  _rawText: null,

  parse(raw) {
    const dayNames = ['понедельник','вторник','среда','четверг','пятница','суббота','воскресенье'];
    const lines = raw.split('\n');
    const days = [];
    let cur = null;

    for (const line of lines) {
      const clean = line.replace(/<[^>]+>/g, '').trim();
      const lower = clean.toLowerCase();
      const isHeader = (
        (dayNames.some(d => lower.includes(d)) && /день\s*\d+|^\d|^═/.test(lower + clean)) ||
        /^ДЕНЬ\s+\d+/i.test(clean) ||
        /════/.test(clean)
      );
      if (isHeader && clean.length < 80) {
        if (cur) days.push(cur);
        cur = { title: clean.replace(/[═\s]+/g, ' ').trim(), lines: [] };
      } else if (/^ДЕНЬ\s+\d+\s*—/i.test(clean)) {
        if (cur) days.push(cur);
        cur = { title: clean, lines: [] };
      } else if (cur && clean) {
        cur.lines.push(line);
      }
    }
    if (cur) days.push(cur);

    // Fallback — делим на 7 частей
    if (days.length < 3) {
      const allLines = lines.filter(l => l.trim());
      const chunk = Math.ceil(allLines.length / 7);
      return ['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'].map((title, i) => ({
        title: `День ${i+1} — ${title}`,
        content: allLines.slice(i * chunk, (i + 1) * chunk).join('\n')
      }));
    }

    return days.map(d => ({ title: d.title, content: d.lines.join('\n') }));
  },

  load(raw) {
    this._rawText = raw;
    this.days = this.parse(raw);
    this.current = 0;
    this.render();
  },

  render() {
    if (!this.days.length) return;
    const day = this.days[this.current];
    const total = this.days.length;
    const pct = Math.round(((this.current + 1) / total) * 100);

    // Прогресс-бар
    const fill = $('wm-progress-fill');
    const meta = $('wm-progress-meta');
    if (fill) fill.style.width = pct + '%';
    if (meta) meta.textContent = `День ${this.current + 1} из ${total}`;

    // Заголовок
    const titleEl = $('wm-day-title');
    if (titleEl) titleEl.textContent = day.title;

    // Контент — форматируем
    const contentEl = $('wm-day-content');
    if (contentEl) {
      const html = day.content
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        // Приёмы пищи
        .replace(/(🌅\s*ЗАВТРАК[^\n]*)/g, '<div class="wm-meal-header wm-breakfast">$1</div>')
        .replace(/(☀️\s*ОБЕД[^\n]*)/g,    '<div class="wm-meal-header wm-lunch">$1</div>')
        .replace(/(🌙\s*УЖИН[^\n]*)/g,    '<div class="wm-meal-header wm-dinner">$1</div>')
        .replace(/(🍎\s*ПЕРЕКУС[^\n]*)/g, '<div class="wm-meal-header wm-snack">$1</div>')
        // Секции
        .replace(/(🥣[^\n]+)/g, '<div class="wm-ingr">$1</div>')
        .replace(/(⏱[^\n]+)/g,  '<div class="wm-time">$1</div>')
        .replace(/(🌡[^\n]+)/g,  '<div class="wm-temp">$1</div>')
        .replace(/(👨‍🍳[^\n]*)/g, '<div class="wm-steps-header">$1</div>')
        .replace(/^(\d+\.[^\n]+)/gm, '<div class="wm-step">$1</div>')
        .replace(/(📊[^\n]*КБЖУ[^\n]*)/gi, '<div class="wm-kbju">$1</div>')
        .replace(/(📊\s*ИТОГО[^\n]*)/gi,   '<div class="wm-total">$1</div>')
        .replace(/(💡[^\n]+)/g,  '<div class="wm-tip">$1</div>')
        .replace(/\n/g, '<br>');
      contentEl.innerHTML = html;
    }

    // Кнопки
    const btnPrev = $('wm-btn-prev');
    const btnNext = $('wm-btn-next');
    if (btnPrev) btnPrev.disabled = this.current === 0;
    if (btnNext) {
      if (this.current === total - 1) {
        btnNext.textContent = '📋 Всё меню';
        btnNext.onclick = () => {
          $('wm-day-view').style.display = 'none';
          $('wm-full-wrap').style.display = 'block';
          const rawEl = $('weekmenu-text');
          if (rawEl && this._rawText) rawEl.textContent = this._rawText.replace(/<[^>]+>/g, '');
        };
      } else {
        btnNext.textContent = 'Далее →';
        btnNext.onclick = () => this.next();
      }
    }

    const card = $('wm-day-card');
    if (card) card.scrollTop = 0;
    window.scrollTo({ top: document.getElementById('weekmenu-result')?.offsetTop || 0, behavior: 'smooth' });
  },

  next() { if (this.current < this.days.length - 1) { this.current++; this.render(); haptic('light'); } },
  prev() { if (this.current > 0) { this.current--; this.render(); haptic('light'); } }
};

// ============================================================
//  НАВИГАЦИЯ МЕЖДУ ЭКРАНАМИ
// ============================================================

const state = { ingredients: '', prefs: [], planToBuy: null };

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = $(`screen-${name}`);
  if (!screen) return;
  screen.classList.add('active');
  Voice.stop();
  haptic('light');
  window.scrollTo(0, 0);

  // Действия при открытии экранов
  if (name === 'profile') loadProfile();
  if (name === 'weekmenu') {
    const saved = WeekMenuStorage.load();
    if (saved) {
      WeekMenu.load(saved);
      $('weekmenu-result').style.display = 'block';
      $('wm-day-view').style.display = 'block';
      $('wm-full-wrap').style.display = 'none';
      const resetBtn = $('btn-reset-weekmenu');
      if (resetBtn) resetBtn.style.display = 'block';
    }
  }
}
window.showScreen = showScreen;

// ============================================================
//  INIT
// ============================================================

async function init() {
  try {
    const status = await API.getStatus();
    window._userPlan = status.planType || status.subscription?.plan_type || 'FREE';
    const badge = $('user-badge');
    const freeCount = $('free-count');
    if (status.subscription) {
      const pt = status.subscription.plan_type;
      if (badge) { badge.textContent = pt; badge.className = `badge badge-${pt.toLowerCase()}`; }
      if (freeCount) freeCount.textContent = '✨ Безлимит активен';
    } else {
      if (badge) { badge.textContent = 'FREE'; badge.className = 'badge'; }
      const left = Math.max(0, (status.freeLimit || 3) - (status.freeUsed || 0));
      if (freeCount) freeCount.textContent = `Бесплатных запросов: ${left}`;
    }
  } catch {
    window._userPlan = 'FREE';
    const fc = $('free-count');
    if (fc) fc.textContent = 'Нет соединения';
  }
}

// ============================================================
//  ГЛАВНЫЙ ЭКРАН — ВВОД БЛЮДА
// ============================================================

document.querySelectorAll('.chip').forEach(c => {
  c.addEventListener('click', () => {
    $('dish-input').value = c.dataset.dish;
    haptic('light');
  });
});

document.querySelectorAll('.pref').forEach(p => {
  p.addEventListener('click', () => {
    p.classList.toggle('active');
    const v = p.dataset.pref;
    state.prefs = p.classList.contains('active')
      ? [...state.prefs, v]
      : state.prefs.filter(x => x !== v);
    haptic('light');
  });
});

$('btn-send').addEventListener('click', () => {
  const val = $('dish-input').value.trim();
  if (!val) { hapticNotify('error'); toast('Введи название блюда', 'error'); return; }
  state.ingredients = val;
  showScreen('details');
});

$('dish-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('btn-send').click(); }
});

// Голосовой ввод
$('btn-voice').addEventListener('click', async e => {
  const btn = e.currentTarget;
  if (!Voice.isRecording) {
    const ok = await Voice.startRecording();
    if (ok) { btn.classList.add('recording'); btn.textContent = '⏹'; haptic('medium'); }
  } else {
    btn.classList.remove('recording');
    btn.textContent = '🎤';
    btn.disabled = true;
    const text = await Voice.stopRecording();
    btn.disabled = false;
    if (text) { $('dish-input').value = text; hapticNotify('success'); toast('✅ Распознано!'); }
    else toast('Не удалось распознать, попробуй ещё раз', 'error');
  }
});

// ============================================================
//  ДЕТАЛИ БЛЮДА — ГЕНЕРАЦИЯ РЕЦЕПТА
// ============================================================

window.changePortions = function(delta) {
  const inp = $('portions');
  inp.value = Math.max(1, Math.min(20, parseInt(inp.value || 2) + delta));
};

$('btn-generate').addEventListener('click', async () => {
  const portions = $('portions').value;
  const extra = $('extra-details').value.trim();
  const prefs = state.prefs.join(', ');
  const details = [
    portions > 1 ? `${portions} порции` : '1 порция',
    prefs,
    extra
  ].filter(Boolean).join('. ');

  showScreen('loading');
  haptic('medium');

  try {
    const recipe = await API.generateRecipe(state.ingredients, details);
    RecipeManager.load(recipe);
    showScreen('recipe');
    hapticNotify('success');
  } catch (e) {
    if (e.message.includes('limit_reached') || e.message.includes('лимит')) {
      showScreen('subscription');
    } else {
      toast('Ошибка: ' + e.message, 'error');
      showScreen('details');
    }
  }
});

// ============================================================
//  РЕЦЕПТ — НАВИГАЦИЯ И ДЕЙСТВИЯ
// ============================================================

$('btn-next').addEventListener('click', () => RecipeManager.next());
$('btn-prev').addEventListener('click', () => RecipeManager.prev());

$('btn-voice-read').addEventListener('click', () => {
  if (!RecipeManager.current) return;
  Voice.speak(RecipeManager.current.steps[RecipeManager.step]);
  haptic('light');
});

$('btn-full-recipe').addEventListener('click', () => {
  if (!RecipeManager.current) return;
  const full = RecipeManager.current.steps.map((s, i) => `Шаг ${i+1}:\n${s.replace(/<[^>]+>/g,'')}`).join('\n\n');
  const titleClean = RecipeManager.current.title.replace(/<[^>]+>/g,'');
  // Показываем в модальном окне вместо alert
  showFullRecipeModal(titleClean, full);
});

function showFullRecipeModal(title, text) {
  const existing = document.getElementById('full-recipe-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'full-recipe-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="modal-close" onclick="document.getElementById('full-recipe-modal').remove()">✕</button>
      </div>
      <div class="modal-body"><pre class="modal-text">${text}</pre></div>
      <button class="primary-btn full-btn" style="margin-top:12px;" onclick="copyFullRecipe(${JSON.stringify(title)}, ${JSON.stringify(text)})">📋 Скопировать</button>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

window.copyFullRecipe = async function(title, text) {
  try {
    await navigator.clipboard.writeText(`${title}\n\n${text}`);
    toast('📋 Рецепт скопирован!');
  } catch { toast('Не удалось скопировать', 'error'); }
};

// Голосовая навигация
$('btn-voice-nav').addEventListener('click', e => {
  const btn = e.currentTarget;
  if (!VoiceNav.isListening) {
    VoiceNav.start();
    btn.classList.add('recording');
    btn.textContent = '🎙';
    haptic('medium');
  } else {
    VoiceNav.stop();
    btn.classList.remove('recording');
    btn.textContent = '🎤';
  }
});

// Таймер
document.addEventListener('click', e => {
  if (e.target.id === 'btn-step-timer') StepTimer.promptStart();
});

// ============================================================
//  СПИСОК ПОКУПОК
// ============================================================

window.showShoppingList = async function() {
  const plan = window._userPlan || 'FREE';
  if (plan === 'FREE') { showScreen('subscription'); return; }
  if (!RecipeManager.current) return;

  showScreen('shopping');
  $('shopping-recipe-name').textContent = RecipeManager.current.title.replace(/<[^>]+>/g,'');
  $('shopping-loading').style.display = 'flex';
  $('shopping-list-wrap').style.display = 'none';

  try {
    const fullText = RecipeManager.current.fullText || RecipeManager.current.steps.join('\n');
    const data = await API.getShoppingList(fullText);
    const items = data.items || [];
    window._shoppingItems = items;

    const wrap = $('shopping-items');
    wrap.innerHTML = '';
    if (!items.length) {
      wrap.innerHTML = '<p style="color:var(--text-muted);padding:16px 0;text-align:center">Не удалось извлечь ингредиенты</p>';
    } else {
      items.forEach((item, idx) => {
        const el = document.createElement('div');
        el.className = 'check-item';
        el.innerHTML = `
          <label class="check-lbl" for="ci-${idx}">
            <input type="checkbox" id="ci-${idx}" onchange="this.closest('.check-item').classList.toggle('done', this.checked)">
            <span class="checkmark"></span>
          </label>
          <span class="check-name">${item.name}</span>
          <span class="check-amt">${item.amount || ''}</span>`;
        wrap.appendChild(el);
      });
    }

    $('shopping-loading').style.display = 'none';
    $('shopping-list-wrap').style.display = 'block';
  } catch {
    $('shopping-loading').style.display = 'none';
    $('shopping-list-wrap').innerHTML = '<p style="color:var(--text-muted);padding:20px;text-align:center">Ошибка загрузки списка</p>';
    $('shopping-list-wrap').style.display = 'block';
  }
};

window.copyShoppingList = async function() {
  const items = window._shoppingItems || [];
  const text = '🛒 Список покупок\n\n' + items.map(i => `• ${i.name}${i.amount ? ' — ' + i.amount : ''}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('📋 Список скопирован!');
  } catch { toast('Не удалось скопировать', 'error'); }
};

// ============================================================
//  ПОДЕЛИТЬСЯ РЕЦЕПТОМ
// ============================================================

window.shareRecipe = async function() {
  const plan = window._userPlan || 'FREE';
  if (plan !== 'VIP') { showScreen('subscription'); return; }
  if (!RecipeManager.current) return;
  const title = RecipeManager.current.title.replace(/<[^>]+>/g,'');
  const text = `🍽 ${title}\n\nПриготовлено с Шеф-Повар AI 👨‍🍳`;
  if (navigator.share) {
    try { await navigator.share({ title, text }); }
    catch { /* отменено */ }
  } else {
    try { await navigator.clipboard.writeText(text); toast('📋 Скопировано для отправки!'); }
    catch { toast('Не удалось скопировать', 'error'); }
  }
};

// ============================================================
//  ИСТОРИЯ РЕЦЕПТОВ
// ============================================================

window.loadHistory = function() {
  const list = RecipeHistory.load();
  const wrap = $('history-list');
  const empty = $('history-empty');
  if (!wrap) return;
  wrap.innerHTML = '';

  if (!list.length) {
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  list.forEach(item => {
    const el = document.createElement('div');
    el.className = 'hist-item';
    el.innerHTML = `
      <div class="hist-left">
        <div class="hist-title">${item.title}</div>
        <div class="hist-date">${formatDate(item.ts)}</div>
      </div>
      <button class="hist-btn">Открыть</button>`;
    el.querySelector('button').onclick = () => {
      const steps = item.fullText.split(/\n\s*\n/).filter(s => s.trim().length > 10);
      RecipeManager.load({ title: item.title, steps, total: steps.length, fullText: item.fullText });
      showScreen('recipe');
    };
    wrap.appendChild(el);
  });
};

window.clearHistory = function() {
  if (!confirm('Очистить всю историю рецептов?')) return;
  RecipeHistory.clear();
  loadHistory();
  toast('История очищена');
};

// ============================================================
//  ОПЛАТА
// ============================================================

window.buyPlan = async function(plan) {
  state.planToBuy = plan;
  try {
    const info = await API.getPaymentInfo();
    $('sbp-phone').textContent     = info.sbpPhone;
    $('sbp-recipient').textContent = info.recipient;
    $('pay-amount').textContent    = info.prices[plan];
    showScreen('payment');
  } catch (e) {
    toast('Ошибка загрузки: ' + e.message, 'error');
  }
};

$('btn-upload-receipt').addEventListener('click', async () => {
  const file = $('receipt-file').files[0];
  if (!file) { toast('Выбери файл чека', 'error'); return; }
  const btn = $('btn-upload-receipt');
  btn.disabled = true;
  btn.textContent = '⏳ Отправляем...';
  try {
    const res = await API.uploadReceipt(file, state.planToBuy);
    hapticNotify('success');
    toast(`✅ Чек принят! Заявка #${res.paymentId}. Ожидайте подтверждения.`, 'success', 5000);
    showScreen('home');
    await init();
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '📤 Отправить чек';
  }
});

// ============================================================
//  ПРОФИЛЬ
// ============================================================

async function loadProfile() {
  try {
    const data = await API.getFullProfile();
    $('profile-name').textContent     = data.user?.first_name || 'Пользователь';
    $('profile-username').textContent = data.user?.username ? '@' + data.user.username : '';
    $('stat-recipes').textContent     = data.user?.free_recipes_used || 0;
    const plan = data.subscription?.plan_type || 'FREE';
    $('stat-plan').textContent = plan;
    $('stat-expires').textContent = data.subscription
      ? new Date(data.subscription.expires_at).toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit', year:'2-digit' })
      : '—';
  } catch (e) {
    console.error('Profile error:', e);
  }
}

// ============================================================
//  ФОТО ХОЛОДИЛЬНИКА
// ============================================================

window.previewFridgePhoto = function(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    $('fridge-preview').src = e.target.result;
    $('fridge-preview-wrap').style.display = 'block';
    $('fridge-upload-ph').style.display = 'none';
    $('btn-analyze-fridge').disabled = false;
  };
  reader.readAsDataURL(file);
};

window.analyzeFridge = async function() {
  const plan = window._userPlan || 'FREE';
  if (plan !== 'VIP') { showScreen('subscription'); return; }
  const file = $('fridge-photo').files[0];
  if (!file) return;
  const btn = $('btn-analyze-fridge');
  btn.disabled = true;
  btn.textContent = '🔍 Анализирую...';
  try {
    const data = await API.analyzeFridge(file);
    $('fridge-text').innerHTML = (data.suggestion || 'Не удалось определить').replace(/\n/g, '<br>');
    $('fridge-result').style.display = 'block';
    window._fridgeSuggestion = data.dish;
    hapticNotify('success');
  } catch (e) {
    toast('Ошибка анализа: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 Что приготовить?';
  }
};

window.cookFromFridgeSuggestion = function() {
  if (window._fridgeSuggestion) {
    $('dish-input').value = window._fridgeSuggestion;
    showScreen('details');
  }
};

// ============================================================
//  ЧТО ЕСТЬ В ДОМЕ
// ============================================================

let _fridgeTextPrefs = [];
document.querySelectorAll('#fridge-prefs .pref')?.forEach(p => {
  p.addEventListener('click', () => {
    p.classList.toggle('active');
    const v = p.dataset.pref;
    _fridgeTextPrefs = p.classList.contains('active')
      ? [..._fridgeTextPrefs, v]
      : _fridgeTextPrefs.filter(x => x !== v);
  });
});

window.rescueCook = async function() {
  const plan = window._userPlan || 'FREE';
  if (plan !== 'VIP') { showScreen('subscription'); return; }
  const ingredients = $('fridge-ingredients').value.trim();
  if (!ingredients) { toast('Введи что есть в холодильнике', 'error'); return; }
  const btn = $('btn-rescue-cook');
  btn.disabled = true;
  btn.textContent = '⏳ Придумываю...';
  try {
    const data = await API.rescueCook(ingredients, _fridgeTextPrefs.join(', '));
    $('fridge-text-content').innerHTML = (data.suggestion || 'Попробуй снова').replace(/\n/g, '<br>');
    $('fridge-text-result').style.display = 'block';
    window._rescueDish = data.dish;
    hapticNotify('success');
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🍳 Спаси ужин!';
  }
};

window.cookFridgeText = function() {
  if (window._rescueDish) { $('dish-input').value = window._rescueDish; showScreen('details'); }
};

// ============================================================
//  ДИЕТОЛОГ
// ============================================================

$('btn-ask-diet').addEventListener('click', async () => {
  const question = $('diet-question').value.trim();
  if (!question) { toast('Задай вопрос', 'error'); return; }
  const btn = $('btn-ask-diet');
  btn.disabled = true;
  btn.textContent = '⏳ Консультирую...';
  try {
    const data = await API.askDiet(question);
    $('diet-text').innerHTML = data.answer.replace(/\n/g, '<br>');
    $('diet-result').style.display = 'block';
    $('diet-result').scrollIntoView({ behavior: 'smooth' });
    hapticNotify('success');
  } catch (e) {
    if (e.message.includes('VIP')) { showScreen('subscription'); }
    else toast('Ошибка: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '💬 Спросить';
  }
});

// ============================================================
//  МЕНЮ НА НЕДЕЛЮ — УРОВНИ И ПОРЦИИ
// ============================================================

let _wmLevel = 'base';
let _wmPortions = 2;

document.addEventListener('click', e => {
  const btn = e.target.closest('.wm-level-btn');
  if (btn) {
    document.querySelectorAll('.wm-level-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _wmLevel = btn.dataset.level;
    haptic('light');
  }
});

window.changeWmPortions = function(delta) {
  _wmPortions = Math.max(1, Math.min(10, _wmPortions + delta));
  $('wm-portions').value = _wmPortions;
};

// Генерация меню с прогресс-анимацией
$('btn-generate-weekmenu').addEventListener('click', async () => {
  const userPrefs = $('weekmenu-prefs').value.trim();
  const btn = $('btn-generate-weekmenu');
  const originalText = btn.innerHTML;

  const dayNames = ['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'];
  const dayEmoji = ['🌅','🌤','⛅','🌥','🌦','🌈','☀️'];

  let progressWrap = $('wm-progress-wrap');
  if (!progressWrap) {
    progressWrap = document.createElement('div');
    progressWrap.id = 'wm-progress-wrap';
    progressWrap.innerHTML = `
      <div class="wm-progress-box">
        <div class="wm-progress-chef">👨‍🍳</div>
        <div class="wm-progress-title">Шеф составляет меню...</div>
        <div class="wm-progress-day" id="wm-progress-day">Подбираем рецепты для вас</div>
        <div class="wm-progress-bar-wrap">
          <div class="wm-progress-bar" id="wm-progress-bar" style="width:0%"></div>
        </div>
        <div class="wm-progress-count" id="wm-progress-count">0 из 7 дней</div>
      </div>`;
    btn.parentNode.insertBefore(progressWrap, btn.nextSibling);
  }

  btn.disabled = true;
  btn.innerHTML = '⏳ Готовим меню...';
  progressWrap.style.display = 'block';
  haptic('medium');

  let dayIndex = 0;
  const interval = setInterval(() => {
    if (dayIndex < 7) {
      $('wm-progress-day').textContent = `${dayEmoji[dayIndex]} ${dayNames[dayIndex]} — пишем рецепты...`;
      $('wm-progress-bar').style.width = `${Math.round(((dayIndex + 1) / 7) * 90)}%`;
      $('wm-progress-count').textContent = `${dayIndex + 1} из 7 дней`;
      dayIndex++;
    }
  }, 6500);

  try {
    const data = await API.generateWeekMenu(userPrefs, _wmLevel, _wmPortions);
    clearInterval(interval);

    $('wm-progress-bar').style.width = '100%';
    $('wm-progress-day').textContent = '✅ Меню на неделю готово!';
    $('wm-progress-count').textContent = '7 из 7 дней';
    hapticNotify('success');

    await new Promise(r => setTimeout(r, 900));
    progressWrap.style.display = 'none';

    const clean = (data.menu || '').replace(/\*\*/g,'').replace(/\*/g,'').replace(/^#{1,3}\s*/gm,'');
    WeekMenu.load(clean);
    WeekMenuStorage.save(clean);

    $('weekmenu-result').style.display = 'block';
    $('wm-day-view').style.display = 'block';
    $('wm-full-wrap').style.display = 'none';
    const resetBtn = $('btn-reset-weekmenu');
    if (resetBtn) resetBtn.style.display = 'block';

    setTimeout(() => $('weekmenu-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);

  } catch (e) {
    clearInterval(interval);
    progressWrap.style.display = 'none';
    if (e.message.includes('VIP')) showScreen('subscription');
    else toast('Ошибка: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
});

// Сброс меню
document.addEventListener('click', e => {
  if (e.target.id === 'btn-reset-weekmenu') {
    if (!confirm('Удалить текущее меню и создать новое?')) return;
    WeekMenuStorage.clear();
    WeekMenu._rawText = null;
    WeekMenu.days = [];
    $('weekmenu-result').style.display = 'none';
    $('btn-reset-weekmenu').style.display = 'none';
    haptic('medium');
    toast('Меню удалено. Создай новое!');
  }
});

// Скачать меню
$('btn-download-weekmenu')?.addEventListener('click', async () => {
  const btn = $('btn-download-weekmenu');
  btn.disabled = true;
  btn.innerHTML = '⏳ Создаём...';
  try {
    const raw = WeekMenu._rawText || '';
    const text = raw.replace(/<[^>]+>/g,'').trim();
    const date = new Date().toLocaleDateString('ru-RU', { day:'numeric', month:'long', year:'numeric' });

    if (typeof html2canvas !== 'undefined') {
      const tempDiv = document.createElement('div');
      tempDiv.style.cssText = 'position:fixed;left:-9999px;top:0;width:390px;background:#faf7f4;font-family:Arial,sans-serif;padding:0;box-sizing:border-box;z-index:-1';
      tempDiv.innerHTML = `
        <div style="background:linear-gradient(135deg,#d98f78,#c4735a);padding:28px 24px;text-align:center;">
          <div style="font-size:22px;font-weight:700;color:#fff;">🍽 Меню на неделю</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:6px;">Шеф-Повар AI · ${date}</div>
        </div>
        <div style="padding:20px;line-height:1.75;font-size:13px;color:#2c2420;white-space:pre-wrap;">${text}</div>`;
      document.body.appendChild(tempDiv);
      const canvas = await html2canvas(tempDiv, { scale: 2, backgroundColor: '#faf7f4', useCORS: true, logging: false });
      document.body.removeChild(tempDiv);
      const dataUrl = canvas.toDataURL('image/png');
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      if (isIOS) {
        window.open(dataUrl, '_blank');
        toast('📸 Нажми «Поделиться» → «Сохранить в Фото»');
      } else {
        const win = window.open('', '_blank');
        win?.document.write(`<html><body style="margin:0;background:#111;display:flex;flex-direction:column;align-items:center;padding:16px;"><img src="${dataUrl}" style="max-width:100%;border-radius:12px;"><p style="color:#fff;font-family:sans-serif;font-size:14px;margin-top:12px;opacity:.8">Удержи палец на картинке → «Сохранить»</p></body></html>`);
        win?.document.close();
        toast('📸 Удержи на картинке → Сохранить');
      }
    } else {
      // Fallback — текстовый файл
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `menu-${new Date().toISOString().split('T')[0]}.txt`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
      toast('📄 Сохранено как текст');
    }
  } catch (e) {
    toast('Ошибка сохранения', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '💾 Сохранить';
  }
});

// Поделиться меню
$('btn-share-weekmenu')?.addEventListener('click', async () => {
  const raw = WeekMenu._rawText || '';
  const text = raw.replace(/<[^>]+>/g,'').trim();
  const shareText = text.slice(0, 1500) + (text.length > 1500 ? '...' : '') + '\n\n📱 Шеф-Повар AI';
  if (navigator.share) {
    try { await navigator.share({ title: 'Моё меню на неделю', text: shareText }); }
    catch { /* отменено */ }
  } else {
    try { await navigator.clipboard.writeText(shareText); toast('📋 Меню скопировано!'); }
    catch { toast('Не удалось скопировать', 'error'); }
  }
});

// Печать меню
$('btn-print-weekmenu')?.addEventListener('click', () => {
  const raw = WeekMenu._rawText || '';
  const text = raw.replace(/<[^>]+>/g,'').trim();
  const date = new Date().toLocaleDateString('ru-RU', { day:'numeric', month:'long', year:'numeric' });
  const win = window.open('', '_blank');
  if (!win) { toast('Разреши всплывающие окна', 'error'); return; }
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Меню на неделю</title>
    <style>body{font-family:Arial,sans-serif;padding:24px;line-height:1.8;color:#2c2420;max-width:720px;margin:0 auto;}
    .hdr{text-align:center;padding:24px;background:linear-gradient(135deg,#d98f78,#c4735a);color:#fff;border-radius:12px;margin-bottom:28px;}
    .hdr h1{margin:0;font-size:24px;}.hdr p{margin:4px 0 0;font-size:14px;opacity:.9;}
    pre{white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.8;}
    @media print{.hdr{border-radius:0;}}</style></head>
    <body><div class="hdr"><h1>🍽 Меню на неделю</h1><p>Шеф-Повар AI · ${date}</p></div>
    <pre>${text}</pre><script>window.onload=()=>window.print();<\/script></body></html>`);
  win.document.close();
});

// ============================================================
//  ГОЛОСОВАЯ НАВИГАЦИЯ ПО РЕЦЕПТУ
// ============================================================

const VoiceNav = {
  isListening: false,
  _rec: null,

  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('Голосовое управление не поддерживается', 'error'); return; }
    this._rec = new SR();
    this._rec.lang = 'ru-RU';
    this._rec.continuous = true;
    this._rec.interimResults = false;
    this._rec.onresult = e => {
      const text = e.results[e.results.length - 1][0].transcript.toLowerCase().trim();
      this._handle(text);
    };
    this._rec.onerror = () => {};
    this._rec.onend = () => { if (this.isListening) this._rec.start(); };
    this._rec.start();
    this.isListening = true;
    Voice.speak('Голосовое управление включено. Говори: далее, назад, повтори или стоп.');
  },

  stop() {
    this.isListening = false;
    this._rec?.stop();
  },

  _handle(text) {
    if (/следующий|дальше|далее|вперёд/.test(text)) RecipeManager.next();
    else if (/назад|предыдущий|прошлый/.test(text)) RecipeManager.prev();
    else if (/повтори|озвуч|читай/.test(text)) Voice.speak(RecipeManager.current?.steps[RecipeManager.step]);
    else if (/стоп|выход|закрыть|хватит/.test(text)) showScreen('home');
    else if (/первый|начало/.test(text)) { RecipeManager.step = 0; RecipeManager.render(); }
  }
};

// ============================================================
//  GATED ACTIONS (проверка подписки)
// ============================================================

window.gatedAction = function(screen, required) {
  const plan = window._userPlan || 'FREE';
  const ok = required === 'PRO'
    ? (plan === 'PRO' || plan === 'VIP')
    : (plan === 'VIP');
  if (!ok) { showScreen('subscription'); return; }
  if (screen === 'history') loadHistory();
  showScreen(screen);
};

// ============================================================
//  ЗАПУСК ПРИЛОЖЕНИЯ
// ============================================================

window.addEventListener('load', async () => {
  await init();
  const loader = $('loader');
  if (loader) {
    loader.style.transition = 'opacity 0.4s';
    loader.style.opacity = '0';
    setTimeout(() => loader.style.display = 'none', 400);
  }
  if (!document.querySelector('.screen.active')) showScreen('home');
});
