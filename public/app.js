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
  getWeekMenuShopping: (menu) => API.request('/api/vip/weekmenu-shopping', {
    method: 'POST', body: JSON.stringify({ menu })
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
  }
};

// ============================================================
//  ГОЛОС — единый поток микрофона (разрешение один раз)
// ============================================================

const Voice = {
  _stream: null,          // постоянный поток — разрешение спрашивается 1 раз
  _mediaRecorder: null,
  _chunks: [],
  isRecording: false,

  // Получить/переиспользовать поток микрофона
  async _getStream() {
    if (this._stream && this._stream.active) return this._stream;
    this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return this._stream;
  },

  // Проверка — было ли уже выдано разрешение
  async hasPermission() {
    try {
      if (navigator.permissions) {
        const status = await navigator.permissions.query({ name: 'microphone' });
        return status.state === 'granted';
      }
    } catch {}
    return !!(this._stream && this._stream.active);
  },

  async startRecording() {
    try {
      const stream = await this._getStream();
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
        // НЕ останавливаем треки потока — переиспользуем чтобы не спрашивать разрешение снова
        this.isRecording = false;
        try { const d = await API.recognizeVoice(blob); resolve(d.text || ''); }
        catch { resolve(''); }
      };
      this._mediaRecorder.stop();
    });
  }
};

// ============================================================
//  РЕЦЕПТЫ В БД (история + избранное)
// ============================================================

// Локальный кэш чтобы не дёргать API при каждом изменении
const RecipeStore = {
  // Push больше не нужен — рецепт сохраняется на бэке при генерации
  cache: { all: null, favorites: null },

  async list(filter = 'all') {
    const data = await API.request(`/api/recipes/list?filter=${filter}`);
    this.cache[filter] = data.recipes || [];
    return this.cache[filter];
  },

  async get(id) {
    return API.request(`/api/recipes/${id}`);
  },

  async toggleFavorite(id) {
    const data = await API.request(`/api/recipes/${id}/favorite`, { method: 'POST' });
    return data.isFavorite;
  },

  async rate(id, rating) {
    return API.request(`/api/recipes/${id}/rate`, {
      method: 'POST',
      body: JSON.stringify({ rating })
    });
  },

  async delete(id) {
    return API.request(`/api/recipes/${id}`, { method: 'DELETE' });
  }
};
window.RecipeStore = RecipeStore;

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
    this._updatePlanUI();
    this._updateFavoriteButton();
    this.render();
  },

  _updateFavoriteButton() {
    const btn = $('btn-fav-recipe');
    if (!btn) return;
    const icon = btn.querySelector('.fav-icon');
    const text = btn.querySelector('.fav-text');
    if (this.current?.isFavorite) {
      btn.classList.add('active');
      if (icon) icon.textContent = '❤️';
      if (text) text.textContent = 'В избранном';
    } else {
      btn.classList.remove('active');
      if (icon) icon.textContent = '🤍';
      if (text) text.textContent = 'В избранное';
    }
  },

  _updatePlanUI() {
    const plan = window._userPlan || 'FREE';
    const timerWrap = $('step-timer-wrap');
    const lockShare = $('lock-share');
    if (timerWrap) timerWrap.style.display = plan !== 'FREE' ? 'flex' : 'none';
    if (lockShare) lockShare.style.display = plan === 'VIP' ? 'none' : 'inline';
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
      // Если есть id — показываем рейтинг, иначе просто закрываем
      if (this.current?.id) {
        showRatingModal();
      } else {
        toast('🎉 Блюдо готово! Приятного аппетита!', 'success', 4000);
        showScreen('home');
      }
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

// HTML escape для безопасного отображения текста
function esc(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

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
    // Разбиваем по маркеру который сами же вставляем в api.js:
    // "════...════\nДЕНЬ N — НАЗВАНИЕ\n════...════"
    // Ищем "ДЕНЬ N" как разделитель — надёжный паттерн
    const dayPattern = /ДЕНЬ\s+(\d+)\s*[—–-]\s*([^\n]+)/gi;
    const segments = [];
    let lastIndex = 0;
    let match;

    while ((match = dayPattern.exec(raw)) !== null) {
      if (segments.length > 0) {
        segments[segments.length - 1].end = match.index;
      }
      segments.push({
        num: parseInt(match[1]),
        title: `День ${match[1]} — ${match[2].trim().replace(/[═\s]+$/,'')}`,
        start: match.index,
        end: raw.length
      });
    }

    if (segments.length >= 3) {
      return segments.map(seg => ({
        title: seg.title,
        content: raw.slice(seg.start, seg.end)
          // убираем заголовок и разделители из контента
          .replace(/^[═\s]*ДЕНЬ\s+\d+\s*[—–-][^\n]*\n?/i, '')
          .replace(/^[═]+\n?/gm, '')
          .replace(/\*\*/g, '').replace(/\*/g, '')
          .trim()
      }));
    }

    // Fallback — по названиям дней
    const dayNames = ['ПОНЕДЕЛЬНИК','ВТОРНИК','СРЕДА','ЧЕТВЕРГ','ПЯТНИЦА','СУББОТА','ВОСКРЕСЕНЬЕ'];
    const ruNames  = ['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'];
    const fallbackPattern = new RegExp(`(${dayNames.join('|')})`, 'gi');
    const parts = raw.split(fallbackPattern).filter(Boolean);
    const result = [];
    for (let i = 0; i < parts.length - 1; i += 2) {
      const dayName = parts[i].trim();
      const content = (parts[i + 1] || '').replace(/\*\*/g,'').replace(/\*/g,'').trim();
      const idx = dayNames.findIndex(d => d === dayName.toUpperCase());
      result.push({ title: `День ${idx + 1} — ${ruNames[idx] || dayName}`, content });
    }
    if (result.length >= 3) return result;

    // Последний fallback — делим на 7 равных частей
    const lines = raw.split('\n').filter(l => l.trim());
    const chunk = Math.ceil(lines.length / 7);
    return ruNames.map((name, i) => ({
      title: `День ${i+1} — ${name}`,
      content: lines.slice(i * chunk, (i + 1) * chunk).join('\n')
    }));
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

    const fill = $('wm-progress-fill');
    const meta = $('wm-progress-meta');
    if (fill) fill.style.width = pct + '%';
    if (meta) meta.textContent = `День ${this.current + 1} из ${total}`;

    const titleEl = $('wm-day-title');
    if (titleEl) titleEl.textContent = day.title;

    const contentEl = $('wm-day-content');
    if (contentEl) {
      // Форматируем построчно — надёжнее чем regex по всему тексту
      const lines = day.content.split('\n');
      let html = '';

      for (const line of lines) {
        const t = line.trim();
        if (!t) { html += '<div class="wm-spacer"></div>'; continue; }

        if (/^🌅.*ЗАВТРАК/i.test(t))      html += `<div class="wm-meal-header wm-breakfast">${esc(t)}</div>`;
        else if (/^☀️.*ОБЕД/i.test(t))    html += `<div class="wm-meal-header wm-lunch">${esc(t)}</div>`;
        else if (/^🌙.*УЖИН/i.test(t))    html += `<div class="wm-meal-header wm-dinner">${esc(t)}</div>`;
        else if (/^🍎.*ПЕРЕКУС/i.test(t)) html += `<div class="wm-meal-header wm-snack">${esc(t)}</div>`;
        else if (/^🥣/.test(t))           html += `<div class="wm-ingr">${esc(t)}</div>`;
        else if (/^—\s/.test(t))          html += `<div class="wm-ingr-item">${esc(t)}</div>`;
        else if (/^⏱/.test(t))           html += `<div class="wm-time">${esc(t)}</div>`;
        else if (/^🌡/.test(t))           html += `<div class="wm-temp">${esc(t)}</div>`;
        else if (/^👨‍🍳/.test(t))          html += `<div class="wm-steps-header">${esc(t)}</div>`;
        else if (/^\d+\./.test(t))        html += `<div class="wm-step"><span class="wm-step-num">${t.match(/^\d+/)[0]}.</span><span class="wm-step-text">${esc(t.replace(/^\d+\.\s*/,''))}</span></div>`;
        else if (/^📊.*ИТОГО/i.test(t))   html += `<div class="wm-total">${esc(t)}</div>`;
        else if (/^📊/.test(t))           html += `<div class="wm-kbju">${esc(t)}</div>`;
        else if (/^💡/.test(t))           html += `<div class="wm-tip">${esc(t)}</div>`;
        else if (/^[═─]+$/.test(t))       html += ''; // разделители — пропускаем
        else                               html += `<div class="wm-text">${esc(t)}</div>`;
      }

      contentEl.innerHTML = html;
    }

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
          if (rawEl && this._rawText) rawEl.textContent = this._rawText.replace(/[═]+/g,'---').replace(/\*\*/g,'').replace(/\*/g,'');
        };
      } else {
        btnNext.textContent = 'Далее →';
        btnNext.onclick = () => this.next();
      }
    }

    const card = $('wm-day-card');
    if (card) card.scrollTop = 0;
    $('weekmenu-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  haptic('light');
  window.scrollTo(0, 0);

  // Действия при открытии экранов
  if (name === 'profile') loadProfile();
  if (name === 'weekmenu') {
    // Баннеры в зависимости от статуса
    const isVIP = window._userPlan === 'VIP';
    const freeUsed = !!window._freeWeekmenuUsed;
    const freeBanner = $('wm-free-banner');
    const usedBanner = $('wm-used-banner');
    if (freeBanner) freeBanner.style.display = (!isVIP && !freeUsed) ? 'flex' : 'none';
    if (usedBanner) usedBanner.style.display = (!isVIP && freeUsed) ? 'flex' : 'none';

    const saved = WeekMenuStorage.load();
    if (saved) {
      WeekMenu.load(saved);
      $('weekmenu-result').style.display = 'block';
      $('wm-day-view').style.display = 'block';
      $('wm-full-wrap').style.display = 'none';
      const resetBtn = $('btn-reset-weekmenu');
      if (resetBtn) resetBtn.style.display = 'block';
    }

    // Подгружаем счётчик блюд в истории
    loadWeekmenuHistoryCount();
  }
}

window.loadWeekmenuHistoryCount = async function() {
  const wrap = $('wm-history-info');
  if (!wrap) return;
  try {
    const data = await API.request('/api/vip/weekmenu-history-count');
    const count = data.count || 0;
    if (count > 0) {
      $('wm-history-count').textContent = count;
      // Слово "блюд" в правильной форме
      const word = count === 1 ? 'блюдо' : (count < 5 ? 'блюда' : 'блюд');
      $('wm-history-count-text').innerHTML = `В истории <b id="wm-history-count">${count}</b> ${word} — шеф не повторяется`;
      wrap.style.display = 'flex';
    } else {
      wrap.style.display = 'none';
    }
  } catch {
    wrap.style.display = 'none';
  }
};

window.resetWeekmenuHistory = async function() {
  if (!confirm('Очистить историю блюд? Шеф сможет снова предлагать те же блюда что были раньше.')) return;
  try {
    await API.request('/api/vip/weekmenu-reset-history', { method: 'POST' });
    toast('🔄 История блюд очищена');
    hapticNotify('success');
    loadWeekmenuHistoryCount();
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
};
window.showScreen = showScreen;

// ============================================================
//  ОНБОРДИНГ
// ============================================================

const ONB_KEY = 'chef_onb_done_v1';
let _onbCurrent = 0;
let _onbAllergyChips = new Set();

// Чипы аллергий
document.addEventListener('click', e => {
  const chip = e.target.closest('.onb-allergy-chip');
  if (!chip) return;
  e.preventDefault();
  const v = chip.dataset.val;
  if (_onbAllergyChips.has(v)) {
    _onbAllergyChips.delete(v);
    chip.classList.remove('active');
  } else {
    _onbAllergyChips.add(v);
    chip.classList.add('active');
  }
  // Обновляем textarea
  const ta = $('onb-allergies');
  if (ta) {
    const manual = ta.value.split(',').map(x => x.trim())
      .filter(x => x && !['орехи','лактоза','глютен','яйца','морепродукты','мёд'].includes(x.toLowerCase()));
    ta.value = [...Array.from(_onbAllergyChips), ...manual].filter(Boolean).join(', ');
  }
  haptic('light');
});

window.onbChangePortions = function(delta) {
  const inp = $('onb-portions');
  if (!inp) return;
  inp.value = Math.max(1, Math.min(10, (parseInt(inp.value) || 2) + delta));
  haptic('light');
};

window.onbNext = function() {
  const slides = document.querySelectorAll('.onb-slide');
  const dots   = document.querySelectorAll('.onb-dot');
  const nextBtn = $('onb-next');

  // Анимация смены слайда
  slides[_onbCurrent].classList.remove('active');
  slides[_onbCurrent].classList.add('exit');
  setTimeout(() => slides[_onbCurrent]?.classList.remove('exit'), 400);

  _onbCurrent++;

  if (_onbCurrent >= slides.length) {
    finishOnboarding();
    return;
  }

  slides[_onbCurrent].classList.add('active');
  dots.forEach(d => d.classList.remove('active'));
  dots[_onbCurrent]?.classList.add('active');
  haptic('light');

  // На последнем слайде меняем текст кнопки
  if (_onbCurrent === slides.length - 1) {
    nextBtn.textContent = '✅ Готово, начать!';
    nextBtn.classList.add('onb-next-final');
    $('onb-skip').style.display = 'none';
  }
};

// Свайп по слайдам
let _onbTouchX = 0;
document.addEventListener('touchstart', e => {
  if (!document.getElementById('screen-onboarding')?.classList.contains('active-onb')) return;
  _onbTouchX = e.touches[0].clientX;
}, { passive: true });
document.addEventListener('touchend', e => {
  if (!document.getElementById('screen-onboarding')?.classList.contains('active-onb')) return;
  const diff = _onbTouchX - e.changedTouches[0].clientX;
  if (Math.abs(diff) > 50 && diff > 0) onbNext();
}, { passive: true });

window.finishOnboarding = async function() {
  // Собираем данные с последнего слайда (если он показан)
  const allergiesValue = $('onb-allergies')?.value?.trim() || '';
  const portionsValue = parseInt($('onb-portions')?.value) || 2;

  try { localStorage.setItem(ONB_KEY, '1'); } catch {}

  // Сохраняем в БД (не блокируем UI)
  API.request('/api/user/onboarding', {
    method: 'POST',
    body: JSON.stringify({ allergies: allergiesValue, portions: portionsValue })
  }).then(() => {
    // Обновляем кэш
    window._userAllergies = allergiesValue;
    window._userPortions = portionsValue;
  }).catch(e => console.warn('Onboarding save failed:', e));

  const onbEl = $('screen-onboarding');
  if (onbEl) {
    onbEl.classList.add('onb-fade-out');
    onbEl.classList.remove('active-onb');
    setTimeout(() => {
      onbEl.style.display = 'none';
      onbEl.classList.remove('onb-fade-out');
    }, 400);
  }
  showScreen('home');
  hapticNotify('success');

  // Приветственный тост
  const msg = allergiesValue
    ? '👨‍🍳 Запомнил твои предпочтения. Все рецепты будут безопасными!'
    : '👨‍🍳 Привет! Назови любое блюдо или выбери из списка';
  setTimeout(() => toast(msg, 'success', 4000), 600);
};

function shouldShowOnboarding(status) {
  // Приоритет — флаг с сервера. localStorage — fallback для офлайн
  if (status?.onboardingDone === true) return false;
  if (status?.onboardingDone === false) return true;
  try { return !localStorage.getItem(ONB_KEY); } catch { return false; }
}

// ============================================================
//  INIT
// ============================================================

async function init() {
  try {
    const status = await API.getStatus();
    window._userPlan = status.planType || status.subscription?.plan_type || 'FREE';
    window._userAllergies = status.allergies || '';
    window._userPortions = status.preferredPortions || 2;
    window._freeWeekmenuUsed = !!status.freeWeekmenuUsed;
    window._onboardingDone = !!status.onboardingDone;
    // Режимы и доп. данные
    window._userMode = status.mode || 'standard';
    window._userFamilyKids = status.familyKids || '';
    window._userDisliked = status.disliked || '';
    window._userFavorites = status.favorites || '';
    window._userFitnessGoal = status.fitnessGoal || null;
    window._userDailyCalories = status.dailyCalories || null;
    window._userReminder = status.dailyReminder !== false;

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

    // Badge "подарок" для меню на неделю
    const giftBadge = $('weekmenu-gift-badge');
    if (giftBadge) {
      giftBadge.style.display = (!status.subscription && !status.freeWeekmenuUsed) ? 'inline-block' : 'none';
    }

    // Обновляем тексты пунктов меню в профиле
    updateModeMenuText();
    updateReminderMenuText();

    return status;
  } catch (e) {
    window._userPlan = 'FREE';
    const fc = $('free-count');
    if (fc) fc.textContent = 'Нет соединения';
    return null;
  }
}

// ============================================================
//  РЕДАКТОР АЛЛЕРГИЙ
// ============================================================

window.showAllergiesEditor = function() {
  const current = window._userAllergies || '';
  const existing = $('allergies-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'allergies-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <h3>🛡️ Мои аллергии</h3>
        <button class="modal-close" onclick="document.getElementById('allergies-modal').remove()">✕</button>
      </div>
      <div class="modal-body">
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">
          Шеф учтёт это в каждом рецепте. Перечисли через запятую — или оставь пустым.
        </p>
        <div class="textarea-wrap">
          <textarea id="allergies-input" rows="3" placeholder="Например: орехи, лактоза, морепродукты">${esc(current)}</textarea>
        </div>
        <div class="onb-allergy-chips" id="allergies-chips" style="margin-top:12px;">
          ${['орехи','лактоза','глютен','яйца','морепродукты','мёд'].map(v => {
            const labels = {орехи:'🥜 Орехи',лактоза:'🥛 Лактоза',глютен:'🌾 Глютен',яйца:'🥚 Яйца',морепродукты:'🦐 Морепродукты','мёд':'🍯 Мёд'};
            return `<button type="button" class="onb-allergy-chip" data-val="${v}">${labels[v]}</button>`;
          }).join('')}
        </div>
      </div>
      <button class="primary-btn full-btn" style="margin-top:16px;" onclick="saveAllergiesFromModal()">💾 Сохранить</button>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  // Активируем чипы которые уже выбраны
  const taVals = current.toLowerCase().split(',').map(x => x.trim());
  modal.querySelectorAll('.onb-allergy-chip').forEach(chip => {
    if (taVals.includes(chip.dataset.val)) chip.classList.add('active');
    chip.addEventListener('click', e => {
      e.preventDefault();
      chip.classList.toggle('active');
      // Обновляем textarea на основе активных чипов + ручного ввода
      const ta = $('allergies-input');
      const activeChips = Array.from(modal.querySelectorAll('.onb-allergy-chip.active')).map(c => c.dataset.val);
      const stdSet = new Set(['орехи','лактоза','глютен','яйца','морепродукты','мёд']);
      const manual = ta.value.split(',').map(x => x.trim()).filter(x => x && !stdSet.has(x.toLowerCase()));
      ta.value = [...activeChips, ...manual].filter(Boolean).join(', ');
      haptic('light');
    });
  });
};

window.saveAllergiesFromModal = async function() {
  const ta = $('allergies-input');
  const value = ta?.value?.trim() || '';
  try {
    await API.request('/api/user/allergies', { method: 'POST', body: JSON.stringify({ allergies: value }) });
    window._userAllergies = value;
    document.getElementById('allergies-modal')?.remove();
    toast(value ? '✅ Аллергии сохранены' : '✅ Список аллергий очищен');
    hapticNotify('success');
  } catch (e) {
    toast('Не удалось сохранить: ' + e.message, 'error');
  }
};

// ============================================================
//  РЕДАКТОР РЕЖИМОВ (Обычный / Семья / Фитнес) — только VIP
// ============================================================

window.showModeEditor = function() {
  const isVIP = window._userPlan === 'VIP';
  if (!isVIP) {
    toast('🔒 Режимы доступны только для VIP', 'error');
    setTimeout(() => showScreen('subscription'), 800);
    return;
  }

  const currentMode = window._userMode || 'standard';
  const existing = $('mode-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'mode-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <h3>🎯 Режим работы</h3>
        <button class="modal-close" onclick="document.getElementById('mode-modal').remove()">✕</button>
      </div>
      <div class="modal-body">
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px;">
          Шеф адаптирует все рецепты и меню под выбранный режим.
        </p>

        <div class="mode-list">
          <button type="button" class="mode-card ${currentMode==='standard'?'active':''}" data-mode="standard">
            <div class="mode-icon"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11h18M5 11a7 7 0 0 1 14 0M8.5 11l-.5 8a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l-.5-8"/></svg></div>
            <div class="mode-info">
              <b>Обычный</b>
              <small>Универсальные рецепты для всех</small>
            </div>
          </button>
          <button type="button" class="mode-card ${currentMode==='family'?'active':''}" data-mode="family">
            <div class="mode-icon"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="3"/><circle cx="17" cy="9" r="2"/><path d="M3 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1M15 20v-1a3 3 0 0 1 3-3h0a3 3 0 0 1 3 3v1"/></svg></div>
            <div class="mode-info">
              <b>Семья с детьми</b>
              <small>Рецепты которые понравятся и детям, без острого</small>
            </div>
          </button>
          <button type="button" class="mode-card ${currentMode==='fitness'?'active':''}" data-mode="fitness">
            <div class="mode-icon"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5l11 11M21 21l-1-1M3 3l1 1M18 6l3-3M6 18l-3 3M6.5 6.5L3 10l4 4 3-3M17.5 17.5L21 14l-4-4-3 3"/></svg></div>
            <div class="mode-info">
              <b>Фитнес</b>
              <small>КБЖУ, чистые продукты, спортивное питание</small>
            </div>
          </button>
        </div>

        <!-- Дополнительные поля для семьи -->
        <div id="mode-family-fields" class="mode-extra" style="display:none;">
          <div class="form-block">
            <div class="form-label">Возраст детей</div>
            <input type="text" id="mode-kids" placeholder="Например: 4 года, 7 лет" class="text-input">
          </div>
          <div class="form-block">
            <div class="form-label">Чего семья не любит</div>
            <input type="text" id="mode-disliked" placeholder="Например: грибы, рыба, шпинат" class="text-input">
          </div>
          <div class="form-block">
            <div class="form-label">Особенно любят</div>
            <input type="text" id="mode-favorites" placeholder="Например: курица, макароны, сыр" class="text-input">
          </div>
        </div>

        <!-- Дополнительные поля для фитнеса -->
        <div id="mode-fitness-fields" class="mode-extra" style="display:none;">
          <div class="form-block">
            <div class="form-label">Цель</div>
            <div class="fitness-goals">
              <button type="button" class="goal-btn" data-goal="gain">📈 Набор массы</button>
              <button type="button" class="goal-btn" data-goal="cut">📉 Сушка</button>
              <button type="button" class="goal-btn" data-goal="maintain">⚖️ Поддержание</button>
            </div>
          </div>
          <div class="form-block">
            <div class="form-label">Дневная норма калорий (опционально)</div>
            <input type="number" id="mode-calories" placeholder="Например: 2200" min="800" max="5000" class="text-input">
          </div>
        </div>
      </div>
      <button class="primary-btn full-btn" style="margin-top:14px;" onclick="saveModeFromModal()">💾 Сохранить</button>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  // Заполняем сохранёнными значениями
  if ($('mode-kids')) $('mode-kids').value = window._userFamilyKids || '';
  if ($('mode-disliked')) $('mode-disliked').value = window._userDisliked || '';
  if ($('mode-favorites')) $('mode-favorites').value = window._userFavorites || '';
  if ($('mode-calories')) $('mode-calories').value = window._userDailyCalories || '';

  // Активная цель
  const savedGoal = window._userFitnessGoal;
  if (savedGoal) modal.querySelector(`.goal-btn[data-goal="${savedGoal}"]`)?.classList.add('active');

  // Переключение режимов
  const updateExtra = (mode) => {
    $('mode-family-fields').style.display = mode === 'family' ? 'block' : 'none';
    $('mode-fitness-fields').style.display = mode === 'fitness' ? 'block' : 'none';
  };
  updateExtra(currentMode);

  modal.querySelectorAll('.mode-card').forEach(card => {
    card.addEventListener('click', () => {
      modal.querySelectorAll('.mode-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      updateExtra(card.dataset.mode);
      haptic('light');
    });
  });

  modal.querySelectorAll('.goal-btn').forEach(b => {
    b.addEventListener('click', () => {
      modal.querySelectorAll('.goal-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      haptic('light');
    });
  });
};

window.saveModeFromModal = async function() {
  const modal = $('mode-modal');
  if (!modal) return;
  const activeMode = modal.querySelector('.mode-card.active')?.dataset.mode || 'standard';
  const activeGoal = modal.querySelector('.goal-btn.active')?.dataset.goal || null;

  const body = {
    mode: activeMode,
    familyKids: $('mode-kids')?.value || '',
    disliked: $('mode-disliked')?.value || '',
    favorites: $('mode-favorites')?.value || '',
    fitnessGoal: activeGoal,
    dailyCalories: $('mode-calories')?.value || null
  };

  try {
    await API.request('/api/user/mode', { method: 'POST', body: JSON.stringify(body) });
    window._userMode = activeMode;
    window._userFamilyKids = body.familyKids;
    window._userDisliked = body.disliked;
    window._userFavorites = body.favorites;
    window._userFitnessGoal = activeGoal;
    window._userDailyCalories = body.dailyCalories;
    updateModeMenuText();
    modal.remove();
    const modeNames = { standard: 'Обычный', family: 'Семья', fitness: 'Фитнес' };
    toast(`✅ Режим: ${modeNames[activeMode]}`);
    hapticNotify('success');
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
};

function updateModeMenuText() {
  const el = $('mode-menu-text');
  if (!el) return;
  const mode = window._userMode || 'standard';
  const modeNames = { standard: 'Обычный', family: 'Семья', fitness: 'Фитнес' };
  const isVIP = window._userPlan === 'VIP';
  el.innerHTML = `🎯 Режим: ${modeNames[mode]}${isVIP ? '' : ' <span class="vip-badge">VIP</span>'}`;
}

// ============================================================
//  РЕДАКТОР НАПОМИНАНИЙ
// ============================================================

window.showReminderEditor = function() {
  const enabled = window._userReminder !== false;
  const existing = $('reminder-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'reminder-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <h3>🔔 Напоминания</h3>
        <button class="modal-close" onclick="document.getElementById('reminder-modal').remove()">✕</button>
      </div>
      <div class="modal-body">
        <p style="font-size:14px;color:var(--text-2);margin-bottom:18px;line-height:1.5;">
          Бот пришлёт сообщение в Telegram в <b>17:00</b> с идеей блюда на ужин.
        </p>
        <label class="toggle-row">
          <span class="toggle-label">Ежедневные напоминания</span>
          <input type="checkbox" id="reminder-toggle" ${enabled ? 'checked' : ''}>
          <span class="toggle-switch"></span>
        </label>
        <p style="font-size:12px;color:var(--text-muted);margin-top:14px;line-height:1.5;">
          💡 Можно отключить в любой момент. Напоминания помогают не забыть приготовить и не сорваться на доставку.
        </p>
      </div>
      <button class="primary-btn full-btn" style="margin-top:14px;" onclick="saveReminderFromModal()">💾 Сохранить</button>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
};

window.saveReminderFromModal = async function() {
  const enabled = $('reminder-toggle')?.checked || false;
  try {
    await API.request('/api/user/reminder', { method: 'POST', body: JSON.stringify({ enabled }) });
    window._userReminder = enabled;
    updateReminderMenuText();
    $('reminder-modal')?.remove();
    toast(enabled ? '🔔 Напоминания включены' : '🔕 Напоминания отключены');
    hapticNotify('success');
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
};

function updateReminderMenuText() {
  const el = $('reminder-menu-text');
  if (!el) return;
  const enabled = window._userReminder !== false;
  el.textContent = `🔔 Напоминания: ${enabled ? 'вкл' : 'выкл'}`;
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

// Голосовое управление по кнопке-диктофону (распознаёт команды + заполняет поле)
$('btn-voice').addEventListener('click', () => {
  VoiceNav.toggle();
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

$('btn-full-recipe').addEventListener('click', () => {
  if (!RecipeManager.current) return;
  const full = RecipeManager.current.steps.map((s, i) => `Шаг ${i+1}:\n${s.replace(/<[^>]+>/g,'')}`).join('\n\n');
  const titleClean = RecipeManager.current.title.replace(/<[^>]+>/g,'');
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

// Голосовая навигация — единый toggle
$('btn-voice-nav')?.addEventListener('click', () => {
  VoiceNav.toggle();
});

// Таймер
document.addEventListener('click', e => {
  if (e.target.id === 'btn-step-timer') StepTimer.promptStart();
});

// ============================================================
//  СПИСОК ПОКУПОК
// ============================================================

window.showShoppingList = async function() {
  // Доступно всем — список покупок это базовая фича
  if (!RecipeManager.current) {
    toast('Сначала сгенерируй рецепт', 'error');
    return;
  }

  showScreen('shopping');
  const titleClean = RecipeManager.current.title.replace(/<[^>]+>/g,'');
  $('shopping-recipe-name').textContent = titleClean;
  $('shopping-loading').style.display = 'block';
  $('shopping-list-wrap').style.display = 'none';

  // Собираем чистый текст рецепта без HTML
  const rawFull = RecipeManager.current.fullText || '';
  const rawSteps = RecipeManager.current.steps
    ? RecipeManager.current.steps.map((s, i) => `Шаг ${i+1}: ${s}`).join('\n\n')
    : '';
  const fullText = (rawFull || rawSteps)
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .trim();

  if (!fullText || fullText.length < 20) {
    $('shopping-loading').style.display = 'none';
    $('shopping-list-wrap').innerHTML = '<p style="color:var(--text-muted);padding:20px;text-align:center">Нет текста рецепта для анализа</p>';
    $('shopping-list-wrap').style.display = 'block';
    return;
  }

  try {
    const data = await API.getShoppingList(fullText);
    const items = data.items || [];
    window._shoppingItems = items;

    const wrap = $('shopping-items');
    wrap.innerHTML = '';

    if (!items.length) {
      wrap.innerHTML = '<p style="color:var(--text-muted);padding:16px 0;text-align:center">Не удалось извлечь ингредиенты.<br><small>Попробуй позже</small></p>';
    } else {
      items.forEach((item, idx) => {
        const el = document.createElement('div');
        el.className = 'check-item';
        el.innerHTML = `
          <label class="check-lbl" for="ci-${idx}">
            <input type="checkbox" id="ci-${idx}" onchange="this.closest('.check-item').classList.toggle('done', this.checked)">
            <span class="checkmark"></span>
          </label>
          <span class="check-name">${esc(item.name || '')}</span>
          <span class="check-amt">${esc(item.amount || '')}</span>`;
        wrap.appendChild(el);
      });
    }

    $('shopping-loading').style.display = 'none';
    $('shopping-list-wrap').style.display = 'block';
    hapticNotify('success');
  } catch(e) {
    console.error('[Shopping]', e);
    $('shopping-loading').style.display = 'none';
    $('shopping-list-wrap').innerHTML = `<p style="color:var(--text-muted);padding:20px;text-align:center">Ошибка: ${esc(e.message)}</p>`;
    $('shopping-list-wrap').style.display = 'block';
    toast('Ошибка загрузки списка', 'error');
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
//  СПИСОК ПОКУПОК ДЛЯ МЕНЮ НА НЕДЕЛЮ
// ============================================================

window.showWeekMenuShopping = async function() {
  if (!WeekMenu._rawText) { toast('Сначала сгенерируй меню на неделю', 'error'); return; }

  // Показываем модальное окно
  const existing = $('weekmenu-shopping-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'weekmenu-shopping-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <h3>🛒 Список покупок на неделю</h3>
        <button class="modal-close" onclick="document.getElementById('weekmenu-shopping-modal').remove()">✕</button>
      </div>
      <div class="modal-body" id="wm-shop-body">
        <div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:32px 0;flex-direction:column;">
          <div style="font-size:36px;animation:wm-bounce 1.2s ease-in-out infinite;">🛒</div>
          <div style="color:var(--text-muted);font-size:14px;">Составляю список покупок...</div>
        </div>
      </div>
      <div id="wm-shop-actions" style="display:none;margin-top:12px;display:flex;gap:8px;flex-direction:column;">
        <button class="primary-btn full-btn" onclick="copyWeekMenuShopping()">📋 Скопировать список</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  try {
    const data = await API.getWeekMenuShopping(WeekMenu._rawText);
    const items = data.items || [];
    window._weekShoppingItems = items;

    const body = $('wm-shop-body');
    if (!items.length) {
      body.innerHTML = '<p style="text-align:center;padding:24px;color:var(--text-muted);">Не удалось извлечь ингредиенты</p>';
      return;
    }

    let html = `<div style="margin-bottom:12px;font-size:13px;color:var(--text-muted);">${items.length} продуктов на всю неделю</div>`;
    html += '<div class="shop-list">';
    items.forEach((item, idx) => {
      html += `
        <div class="check-item" id="wsh-${idx}">
          <label class="check-lbl" for="wci-${idx}">
            <input type="checkbox" id="wci-${idx}" onchange="this.closest('.check-item').classList.toggle('done',this.checked)">
            <span class="checkmark"></span>
          </label>
          <span class="check-name">${item.name}</span>
          <span class="check-amt">${item.amount || ''}${item.days ? ' <span class="check-days">'+item.days+'</span>' : ''}</span>
        </div>`;
    });
    html += '</div>';
    body.innerHTML = html;
    $('wm-shop-actions').style.display = 'flex';
    hapticNotify('success');
  } catch (e) {
    $('wm-shop-body').innerHTML = `<p style="text-align:center;padding:24px;color:var(--text-muted);">Ошибка: ${e.message}</p>`;
  }
};

window.copyWeekMenuShopping = async function() {
  const items = window._weekShoppingItems || [];
  const text = '🛒 Список покупок на неделю\n\n' +
    items.map(i => `• ${i.name}${i.amount ? ' — ' + i.amount : ''}${i.days ? ' (' + i.days + ')' : ''}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('📋 Список скопирован!');
  } catch { toast('Не удалось скопировать', 'error'); }
};

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
//  РЕЦЕПТЫ — СПИСОК, ИЗБРАННОЕ, РЕЙТИНГ
// ============================================================

window.showRecipesList = async function(filter) {
  filter = filter || 'all';
  showScreen('history');

  // Заголовок и таб
  const titleEl = document.querySelector('#screen-history .screen-title');
  if (titleEl) titleEl.textContent = filter === 'favorites' ? 'Избранное' : 'История рецептов';

  const wrap = $('history-list');
  const empty = $('history-empty');
  if (!wrap) return;

  wrap.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">Загружаю...</div>';
  if (empty) empty.style.display = 'none';

  try {
    const list = await RecipeStore.list(filter);
    wrap.innerHTML = '';

    if (!list.length) {
      const msg = filter === 'favorites'
        ? 'Пока нет избранных рецептов.<br><small>Нажми ❤️ на рецепте чтобы сохранить</small>'
        : 'Пока нет рецептов.<br><small>Создай свой первый!</small>';
      wrap.innerHTML = `<div style="text-align:center;padding:40px 20px;color:var(--text-muted);font-size:14px;">${msg}</div>`;
      return;
    }

    list.forEach(item => {
      const date = new Date(item.created_at).toLocaleDateString('ru-RU', { day:'2-digit', month:'short' });
      const stars = item.rating ? '★'.repeat(item.rating) : '';
      const el = document.createElement('div');
      el.className = 'hist-item';
      el.innerHTML = `
        <div class="hist-left">
          <div class="hist-title">${esc(item.title)}</div>
          <div class="hist-date">${date}${stars ? ` · <span class="hist-stars">${stars}</span>` : ''}${item.is_favorite ? ' · ❤️' : ''}</div>
        </div>
        <button class="hist-btn">Открыть</button>`;
      el.querySelector('button').onclick = async () => {
        try {
          const recipe = await RecipeStore.get(item.id);
          RecipeManager.load(recipe);
          showScreen('recipe');
        } catch (e) { toast('Ошибка: ' + e.message, 'error'); }
      };
      wrap.appendChild(el);
    });
  } catch (e) {
    wrap.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted);">Не удалось загрузить: ${esc(e.message)}</div>`;
  }
};

// Старая совместимость
window.loadHistory = () => window.showRecipesList('all');
window.clearHistory = () => toast('История синхронизируется с сервером');

// Избранное на экране рецепта
window.toggleFavorite = async function() {
  if (!RecipeManager.current?.id) {
    toast('Этот рецепт не сохранён', 'error');
    return;
  }
  const btn = $('btn-fav-recipe');
  btn.disabled = true;
  try {
    const isFav = await RecipeStore.toggleFavorite(RecipeManager.current.id);
    RecipeManager.current.isFavorite = isFav;
    RecipeManager._updateFavoriteButton();
    toast(isFav ? '❤️ Добавлено в избранное' : 'Убрано из избранного');
    haptic(isFav ? 'medium' : 'light');
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
};

// Модалка рейтинга — показывается при нажатии "Готово!"
function showRatingModal() {
  if (!RecipeManager.current?.id) return;
  const existing = $('rating-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'rating-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box rating-box">
      <div style="text-align:center;padding:8px 0;">
        <div style="font-size:48px;line-height:1;margin-bottom:10px;">🎉</div>
        <h3 style="margin:0 0 6px;font-size:20px;">Блюдо готово!</h3>
        <p style="margin:0 0 18px;color:var(--text-muted);font-size:14px;">Как тебе рецепт?</p>
        <div class="rating-stars">
          ${[1,2,3,4,5].map(n => `<button class="rating-star" data-val="${n}">★</button>`).join('')}
        </div>
        <button class="ghost-btn full-btn" style="margin-top:18px;" onclick="closeRatingModal()">Пропустить</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelectorAll('.rating-star').forEach(btn => {
    btn.addEventListener('mouseover', () => {
      const v = parseInt(btn.dataset.val);
      modal.querySelectorAll('.rating-star').forEach((s, i) => {
        s.classList.toggle('hovered', i < v);
      });
    });
    btn.addEventListener('click', async () => {
      const rating = parseInt(btn.dataset.val);
      modal.querySelectorAll('.rating-star').forEach((s, i) => {
        s.classList.toggle('selected', i < rating);
      });
      try {
        await RecipeStore.rate(RecipeManager.current.id, rating);
        RecipeManager.current.rating = rating;
        hapticNotify('success');
        setTimeout(() => {
          closeRatingModal();
          toast(rating >= 4 ? '⭐ Отлично! Рейтинг сохранён' : 'Спасибо за оценку!');
          showScreen('home');
        }, 600);
      } catch (e) {
        toast('Ошибка: ' + e.message, 'error');
      }
    });
  });
}

window.closeRatingModal = function() {
  document.getElementById('rating-modal')?.remove();
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

    // Обновляем счётчик истории блюд
    loadWeekmenuHistoryCount();

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

// ============================================================
//  ГОЛОСОВОЕ УПРАВЛЕНИЕ — навигация + wake-word команды
// ============================================================

const VoiceNav = {
  isListening: false,
  _rec: null,
  _restartTimer: null,
  _lastTranscript: '',
  _lastTime: 0,

  _supported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  },

  start() {
    if (!this._supported()) {
      toast('Голосовое управление не поддерживается в этом браузере', 'error');
      return false;
    }
    if (this.isListening) return true;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this._rec = new SR();
    this._rec.lang = 'ru-RU';
    this._rec.continuous = true;
    this._rec.interimResults = false;
    this._rec.maxAlternatives = 1;

    this._rec.onresult = e => {
      const res = e.results[e.results.length - 1];
      if (!res || !res.isFinal) return;
      const text = res[0].transcript.toLowerCase().trim();
      // Анти-дублирование — иногда событие срабатывает дважды
      const now = Date.now();
      if (text === this._lastTranscript && now - this._lastTime < 2000) return;
      this._lastTranscript = text;
      this._lastTime = now;
      console.log('[Voice]', text);
      this._handle(text);
    };

    this._rec.onerror = (e) => {
      // no-speech и aborted — нормально, продолжаем
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        toast('Нет доступа к микрофону', 'error');
        this.stop();
      }
    };

    this._rec.onend = () => {
      // Автоматически перезапускаем если не остановлено вручную
      if (this.isListening) {
        clearTimeout(this._restartTimer);
        this._restartTimer = setTimeout(() => {
          try { this._rec?.start(); } catch {}
        }, 300);
      }
    };

    try {
      this._rec.start();
      this.isListening = true;
      this._updateBtnUI();
      return true;
    } catch (e) {
      console.error('[VoiceNav] start failed:', e);
      toast('Не удалось включить микрофон', 'error');
      return false;
    }
  },

  stop() {
    this.isListening = false;
    clearTimeout(this._restartTimer);
    try { this._rec?.stop(); } catch {}
    this._rec = null;
    this._updateBtnUI();
  },

  toggle() {
    if (this.isListening) {
      this.stop();
      toast('🎤 Голос выключен');
    } else {
      if (this.start()) {
        toast('🎤 Слушаю! Скажи "приготовь карбонару" или "далее"', 'success', 3500);
      }
    }
  },

  _updateBtnUI() {
    const btns = document.querySelectorAll('#btn-voice-nav, #btn-voice');
    btns.forEach(btn => {
      if (this.isListening) {
        btn.classList.add('recording');
      } else {
        btn.classList.remove('recording');
      }
    });
  },

  // === ОБРАБОТКА КОМАНД с учётом контекста ===
  _handle(text) {
    // На каком экране сейчас?
    const activeScreen = document.querySelector('.screen.active')?.id || '';
    const onRecipe = activeScreen === 'screen-recipe';
    const onHome = activeScreen === 'screen-home';

    // === Команды НАВИГАЦИИ по рецепту (если на экране рецепта) ===
    if (onRecipe) {
      if (/(следующ|дальше|далее|вперёд|вперед|давай дальше)/.test(text)) {
        RecipeManager.next();
        haptic('light');
        return;
      }
      if (/(назад|предыдущ|прошл|вернись)/.test(text)) {
        RecipeManager.prev();
        haptic('light');
        return;
      }
      if (/(в начало|с начала|первый шаг)/.test(text)) {
        RecipeManager.step = 0;
        RecipeManager.render();
        return;
      }
    }

    // === СТОП — выключает голосовое управление ===
    if (/(стоп|выход|закрой|закрыть|отмена|хватит|тихо|молчи)/.test(text)) {
      this.stop();
      toast('🎤 Голос выключен');
      return;
    }

    // === WAKE-WORD команды (на главном экране) ===
    if (onHome) {
      // Триггеры: "приготовь X", "хочу X", "сделай X", "рецепт X", "давай приготовим X"
      const wakeWordPatterns = [
        /(?:привет.*?(?:давай |)|давай |хочу |хотим |можешь |мне |нам |)?(?:приготов(?:ь|им|ить)|сдела(?:й|ем|ть)|рецепт)\s+(.+)/i,
        /(?:давай |хочу |)?(?:покажи|найди|подскажи)(?:\s+рецепт)?\s+(.+)/i,
        /(?:что|как)\s+(?:приготовить|сделать|готовить)\s+(?:из\s+)?(.+)/i
      ];

      let dish = null;
      for (const pattern of wakeWordPatterns) {
        const m = text.match(pattern);
        if (m && m[1]) {
          dish = m[1].trim()
            .replace(/^(?:это |же |то |мне |нам |для меня |)/i, '')
            .replace(/[.?!]+$/, '')
            .trim();
          break;
        }
      }

      if (dish && dish.length > 2) {
        const input = $('dish-input');
        if (input) input.value = dish;
        haptic('medium');
        toast(`🍳 Готовлю рецепт: ${dish}`);
        // Автоматически переход в детали и генерация
        state.ingredients = dish;
        setTimeout(() => showScreen('details'), 500);
        return;
      }

      // Просто "привет" — поприветствуем
      if (/^(привет|здравствуй|шеф|hello)/.test(text)) {
        toast('👋 Привет! Скажи что приготовить, например: "приготовь омлет"', 'success', 4000);
        return;
      }
    }
  }
};
window.VoiceNav = VoiceNav;

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
  const status = await init();
  const loader = $('loader');
  if (loader) {
    loader.style.transition = 'opacity 0.4s';
    loader.style.opacity = '0';
    setTimeout(() => loader.style.display = 'none', 400);
  }

  // Новым пользователям — онбординг (флаг с сервера приоритетнее localStorage)
  if (shouldShowOnboarding(status)) {
    const onbEl = $('screen-onboarding');
    if (onbEl) {
      onbEl.style.display = 'flex';
      onbEl.classList.add('active-onb');
      _onbCurrent = 0;
    }
  } else {
    if (!document.querySelector('.screen.active')) showScreen('home');
  }
});
