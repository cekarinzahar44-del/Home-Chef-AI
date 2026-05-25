const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor?.('secondary_bg_color');
}

const initData = tg?.initData || '';

// ===== АББРЕВИАТУРЫ ДЛЯ TTS =====
const abbrMap = {
  'шт\\b': 'штук', 'шт\\.\\b': 'штук',
  'г\\b': 'грамм', 'г\\.\\b': 'грамм',
  'мл\\b': 'миллилитров',
  'кг\\b': 'килограмм',
  'ч\\.л\\.?\\b': 'чайной ложки',
  'ст\\.л\\.?\\b': 'столовой ложки',
  'мин\\b': 'минут', 'мин\\.\\b': 'минут',
  'сек\\b': 'секунд',
  '°C': 'градусов Цельсия',
  '°': 'градусов'
};

const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu;

function prepareForTTS(text) {
  if (!text) return '';
  let clean = text
    .replace(/<[^>]+>/g, '')
    .replace(emojiRegex, '')
    .replace(/\n+/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [abbr, full] of Object.entries(abbrMap)) {
    clean = clean.replace(new RegExp(abbr, 'gi'), full);
  }
  return clean.length > 4000 ? clean.substring(0, 4000) + '...' : clean;
}

// ===== API =====
const API = {
  async request(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'x-telegram-init-data': initData,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    return data;
  },
  getStatus: () => API.request('/api/recipe/status'),
  generateRecipe: (ingredients, details) => API.request('/api/recipe/generate', {
    method: 'POST',
    body: JSON.stringify({ ingredients, details })
  }),
  getPaymentInfo: () => API.request('/api/payment/info'),
  getFullProfile: () => API.request('/api/user/fullprofile'),
  generateWeekMenu: (prefs) => API.request('/api/vip/weekmenu', {
    method: 'POST',
    body: JSON.stringify({ prefs })
  }),
  askDiet: (question) => API.request('/api/vip/diet', {
    method: 'POST',
    body: JSON.stringify({ question })
  }),
  recognizeVoice: async (blob) => {
    const fd = new FormData();
    fd.append('audio', blob, 'voice.webm');
    const res = await fetch('/api/stt/recognize', {
      method: 'POST',
      headers: { 'x-telegram-init-data': initData },
      body: fd
    });
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
    return res.json();
  }
};

// ===== VOICE (запись + озвучка) =====
const Voice = {
  mediaRecorder: null,
  chunks: [],
  isRecording: false,
  
  async startRecording() {
    try {      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      this.chunks = [];
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      this.mediaRecorder.start();
      this.isRecording = true;
      return true;
    } catch (e) {
      alert('Нет доступа к микрофону');
      return false;
    }
  },
  
  stopRecording() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder) return resolve('');
      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.chunks, { type: 'audio/webm' });
        this.mediaRecorder.stream.getTracks().forEach(t => t.stop());
        this.isRecording = false;
        try {
          const data = await API.recognizeVoice(blob);
          resolve(data.text || '');
        } catch (e) { resolve(''); }
      };
      this.mediaRecorder.stop();
    });
  },
  
  speak(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const clean = prepareForTTS(text);
    if (!clean) return;
    const utter = new SpeechSynthesisUtterance(clean);
    utter.lang = 'ru-RU';
    utter.rate = 1;
    window.speechSynthesis.speak(utter);
  },
  
  stop() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }
};

// ===== ГОЛОСОВАЯ НАВИГАЦИЯ =====
// ===== ГОЛОСОВАЯ НАВИГАЦИЯ =====
const VoiceNav = {
  isListening: false,
  recognition: null,
  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('Голосовое управление не поддерживается'); return; }
    this.recognition = new SR();
    this.recognition.lang = 'ru-RU';
    this.recognition.continuous = true;
    this.recognition.interimResults = false;
    this.recognition.onresult = (e) => {
      const text = e.results[e.results.length - 1][0].transcript.toLowerCase().trim();
      console.log('🎤', text);
      this.handleCommand(text);
    };
    this.recognition.onerror = (e) => console.error('Voice nav error:', e);
    this.recognition.onend = () => {
      if (this.isListening) this.recognition.start();
    };
    this.recognition.start();
    this.isListening = true;
  },
  stop() {
    this.isListening = false;
    if (this.recognition) this.recognition.stop();
  },
  handleCommand(text) {
    // Если пользователь приветствует, запускаем микрофон
    if (/привет шеф|привет|здравствуй/i.test(text)) {
      const success = Voice.startRecording();
      if (success) {
        const userName = tg?.initDataUnsafe?.user?.first_name || 'пользователь';
        Voice.speak(`Здравствуйте, ${userName}! Готов приготовить для вас блюдо.`);
      }
      return;
    }
    
    // Обработка команды "шеф давай приготовим [блюдо]"
    if (/шеф\s*(давай\s*)?приготовим\s+/i.test(text)) {
      const dish = text.replace(/шеф\s*(давай\s*)?приготовим\s+/i, '').trim();
      if (dish) {
        document.getElementById('dish-input').value = dish;
        showScreen('details');
      }
      return;
    }
    
    // Стандартные команды
    if (!RecipeManager.current) {
      // Если пользователь говорит о блюде, генерируем рецепт
      if (/приготовить|сделай|дай|давай|приготовим/i.test(text)) {
        const dishMatch = text.match(/(?:приготовить|сделай|дай|давай|приготовим)\s+(.+?)(?:\s|$)/i);
        if (dishMatch && dishMatch[1]) {
          const dish = dishMatch[1].trim();
          document.getElementById('dish-input').value = dish;
          showScreen('details');
          return;
        }
      }
    }
    
    // Стандартные команды
    if (/следующий|дальше|далее|вперёд/i.test(text)) {
      RecipeManager.next();
    } else if (/назад|предыдущий|прошлый/i.test(text)) {
      RecipeManager.prev();
    } else if (/первый|начало/i.test(text)) {
      RecipeManager.step = 0;
      RecipeManager.render();
      Voice.speak(RecipeManager.current.steps[0]);
    } else if (/второй/i.test(text)) {
      RecipeManager.step = 1;
      RecipeManager.render();
      Voice.speak(RecipeManager.current.steps[1]);
    } else if (/третий/i.test(text)) {
      RecipeManager.step = 2;
      RecipeManager.render();
      Voice.speak(RecipeManager.current.steps[2]);
    } else if (/повтори|озвуч|читать|произнеси/i.test(text)) {
      Voice.speak(RecipeManager.current.steps[RecipeManager.step]);
    } else if (/стоп|выход|закрыть|хватит/i.test(text)) {
      showScreen('home');
    }
  }
};
    

// ===== RECIPE MANAGER =====
const RecipeManager = {
  current: null,
  step: 0,
  
  load(recipe) {
    this.current = recipe;
    this.step = 0;
    this.render();
  },
  
  render() {
    if (!this.current) return;
    document.getElementById('recipe-title').innerHTML = this.current.title;
    document.getElementById('step-total').textContent = this.current.total;
    document.getElementById('step-current').textContent = this.step + 1;
    document.getElementById('step-text').innerHTML = this.current.steps[this.step];
    document.getElementById('btn-prev').disabled = this.step === 0;
    document.getElementById('btn-next').textContent =
      this.step === this.current.total - 1 ? '🏁 Готово' : 'Далее ➡️';
  },
  
  next() {
    if (!this.current) return;
    if (this.step < this.current.total - 1) {
      this.step++;
      this.render();
      Voice.speak(this.current.steps[this.step]);
    } else showScreen('home');
  },
  
  prev() {
    if (this.step > 0) {
      this.step--;
      this.render();
      Voice.speak(this.current.steps[this.step]);
    }
  }
};

// ===== STATE =====
const state = { ingredients: '', prefs: [], planToBuy: null };

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
  Voice.stop();  VoiceNav.stop();
  const navBtn = document.getElementById('btn-voice-nav');
  if (navBtn) {
    navBtn.classList.remove('recording');
    navBtn.textContent = '🎤';
  }
  tg?.HapticFeedback?.impactOccurred('light');
  if (name === 'profile') loadProfile();
}

// ===== INIT =====
async function init() {
  window._initData = initData;
  try {
    const status = await API.getStatus();
    const badge = document.getElementById('user-badge');
    const freeCount = document.getElementById('free-count');
    window._userPlan = status.planType || (status.subscription ? status.subscription.plan_type : 'FREE');
    if (status.subscription) {
      const pt = status.subscription.plan_type;
      badge.textContent = pt;
      badge.className = 'badge ' + pt;
      freeCount.textContent = '✨ Безлимит активен';
    } else {
      badge.textContent = 'FREE';
      badge.className = 'badge';
      const left = Math.max(0, status.freeLimit - status.freeUsed);
      freeCount.textContent = `Осталось: ${left} из ${status.freeLimit}`;
    }
  } catch (e) {
    console.error('Init:', e);
    window._userPlan = 'FREE';
    document.getElementById('free-count').textContent = 'Нет соединения';
  }
}

// ===== EVENT LISTENERS =====
document.querySelectorAll('.chip').forEach(c => {
  c.addEventListener('click', () => {
    document.getElementById('dish-input').value = c.dataset.dish;
    tg?.HapticFeedback?.impactOccurred('light');
  });
});

document.querySelectorAll('.pref').forEach(p => {
  p.addEventListener('click', () => {
    p.classList.toggle('active');
    const v = p.dataset.pref;
    if (state.prefs.includes(v)) state.prefs = state.prefs.filter(x => x !== v);
    else state.prefs.push(v);
    tg?.HapticFeedback?.impactOccurred('light');
  });
});

document.getElementById('btn-send').addEventListener('click', () => {
  const val = document.getElementById('dish-input').value.trim();  if (!val) {
    tg?.HapticFeedback?.notificationOccurred('error');
    return;
  }
  state.ingredients = val;
  showScreen('details');
});

document.getElementById('btn-voice').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (!Voice.isRecording) {
    const ok = await Voice.startRecording();
    if (ok) {
      btn.classList.add('recording');
      btn.textContent = '⏹';
      tg?.HapticFeedback?.impactOccurred('medium');
    }
  } else {
    btn.classList.remove('recording');
    btn.textContent = '🎤';
    const text = await Voice.stopRecording();
    if (text) {
      document.getElementById('dish-input').value = text;
      tg?.HapticFeedback?.notificationOccurred('success');
    }
  }
});

document.getElementById('btn-generate').addEventListener('click', async () => {
  const portions = document.getElementById('portions').value;
  const extra = document.getElementById('extra-details').value;
  const details = `${portions} порций. ${state.prefs.join(', ')}. ${extra}`.trim();
  showScreen('loading');
  tg?.HapticFeedback?.impactOccurred('light');
  
  try {
    const recipe = await API.generateRecipe(state.ingredients, details);
    RecipeManager.load(recipe);
    showScreen('recipe');
    Voice.speak(recipe.steps[0]);
    tg?.HapticFeedback?.notificationOccurred('success');
  } catch (e) {
    console.error('Recipe generation error:', e);
    if (e.message.includes('limit_reached')) showScreen('subscription');
    else {
      alert('Ошибка: ' + e.message);
      showScreen('home');
    }
  }
});
document.getElementById('btn-next').addEventListener('click', () => RecipeManager.next());
document.getElementById('btn-prev').addEventListener('click', () => RecipeManager.prev());
document.getElementById('btn-voice-read').addEventListener('click', () => {
  if (RecipeManager.current) Voice.speak(RecipeManager.current.steps[RecipeManager.step]);
});
document.getElementById('btn-full-recipe').addEventListener('click', () => {
  if (!RecipeManager.current) return;
  const full = RecipeManager.current.steps.map((s, i) => `Шаг ${i+1}: ${s}`).join('\n\n');
  alert(RecipeManager.current.title.replace(/<[^>]+>/g, '') + '\n\n' + full.replace(/<[^>]+>/g, ''));
});

// Голосовая навигация
document.getElementById('btn-voice-nav').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  if (!VoiceNav.isListening) {
    VoiceNav.start();
    btn.classList.add('recording');
    btn.textContent = '🎙';
    tg?.HapticFeedback?.impactOccurred('medium');
  } else {
    VoiceNav.stop();
    btn.classList.remove('recording');
    btn.textContent = '🎤';
  }
});

// ===== ОПЛАТА =====
window.buyPlan = async (plan) => {
  state.planToBuy = plan;
  try {
    const info = await API.getPaymentInfo();
    document.getElementById('sbp-phone').textContent = info.sbpPhone;
    document.getElementById('sbp-recipient').textContent = info.recipient;
    document.getElementById('pay-amount').textContent = info.prices[plan];
    showScreen('payment');
  } catch (e) {
    console.error('Payment info error:', e);
    alert('Ошибка: ' + e.message);
  }
};

document.getElementById('btn-upload-receipt').addEventListener('click', async () => {
  const file = document.getElementById('receipt-file').files[0];
  if (!file) return alert('Выберите файл');
  try {
    const res = await API.uploadReceipt(file, state.planToBuy);
    alert(`✅ Чек принят!\n📋 Заявка #${res.paymentId}\nОжидайте подтверждения.`);
    showScreen('home');
    init();  } catch (e) {
    console.error('Receipt upload error:', e);
    alert('Ошибка: ' + e.message);
  }
});

// ===== VIP: WEEK MENU — ПОШАГОВЫЙ РЕЖИМ =====

// Хранилище распарсенного меню по дням
const WeekMenu = {
  days: [],      // [{title, content}]
  current: 0,

  // Парсим текст меню в массив дней
  parse(rawText) {
    // Разбиваем по дням — ищем паттерны: "Понедельник", "День 1", "ДЕНЬ 1", "📅", цифра + день недели
    const dayNames = ['понедельник','вторник','среда','четверг','пятница','суббота','воскресенье'];
    const lines = rawText.split(/\n/);
    const days = [];
    let current = null;

    lines.forEach(line => {
      const clean = line.replace(/<[^>]+>/g, '').trim();
      const lower = clean.toLowerCase();

      // Проверяем: это заголовок дня?
      const isDayHeader = dayNames.some(d => lower.includes(d))
        || /^(день|day)\s*\d+/i.test(clean)
        || /^📅/.test(clean)
        || /^\d+\s*(день|day)/i.test(clean);

      if (isDayHeader && clean.length < 60) {
        if (current) days.push(current);
        current = { title: clean.replace(/^[📅\s]+/, ''), lines: [] };
      } else if (current && clean) {
        current.lines.push(line);
      } else if (!current && clean) {
        // До первого дня — игнорируем или создаём вводный блок
      }
    });
    if (current) days.push(current);

    // Если не распарсилось по дням — делим на 7 равных частей
    if (days.length < 3) {
      const allLines = lines.filter(l => l.replace(/<[^>]+>/g,'').trim());
      const chunk = Math.ceil(allLines.length / 7);
      const weekDays = ['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'];
      return weekDays.map((title, i) => ({
        title,
        content: allLines.slice(i * chunk, (i+1) * chunk).join('\n')
      }));
    }

    return days.map(d => ({ title: d.title, content: d.lines.join('\n') }));
  },

  load(rawText) {
    this.days = this.parse(rawText);
    this.current = 0;
    this.render();
  },

  render() {
    if (!this.days.length) return;
    const day = this.days[this.current];
    const total = this.days.length;
    const pct = Math.round(((this.current + 1) / total) * 100);

    // Прогресс
    const fill = document.getElementById('wm-progress-fill');
    const meta = document.getElementById('wm-progress-meta');
    if (fill) fill.style.width = pct + '%';
    if (meta) meta.textContent = `День ${this.current + 1} из ${total}`;

    // Заголовок дня
    const titleEl = document.getElementById('wm-day-title');
    if (titleEl) titleEl.textContent = day.title;

    // Контент дня — форматируем красиво
    const contentEl = document.getElementById('wm-day-content');
    if (contentEl) {
      let html = day.content
        .replace(/\n/g, '<br>')
        .replace(/(<b>[^<]+<\/b>)/g, '$1')  // сохраняем bold
        // Завтрак/Обед/Ужин — выделяем заголовки приёмов пищи
        .replace(/(🌅|🍳|☀️)([^<\n<br>]+)/g, '<div class="meal-header breakfast">$1$2</div>')
        .replace(/(🥗|🍲|🌞|🍽)([^<\n<br>]+)/g, '<div class="meal-header lunch">$1$2</div>')
        .replace(/(🌙|🍴|🌛)([^<\n<br>]+)/g, '<div class="meal-header dinner">$1$2</div>')
        // Завтрак/Обед/Ужин текстом
        .replace(/(Завтрак[^<:]*:?)/gi, '<div class="meal-type">🌅 $1</div>')
        .replace(/(Обед[^<:]*:?)/gi, '<div class="meal-type">☀️ $1</div>')
        .replace(/(Ужин[^<:]*:?)/gi, '<div class="meal-type">🌙 $1</div>')
        .replace(/(Перекус[^<:]*:?)/gi, '<div class="meal-type snack">🍎 $1</div>')
        .replace(/(КБЖУ[^<\n]*)/gi, '<div class="kcal-line">$1</div>');
      contentEl.innerHTML = html;
    }

    // Кнопки навигации
    const btnPrev = document.getElementById('wm-btn-prev');
    const btnNext = document.getElementById('wm-btn-next');
    if (btnPrev) btnPrev.disabled = this.current === 0;
    if (btnNext) {
      if (this.current === total - 1) {
        btnNext.textContent = '🏁 Готово';
        btnNext.onclick = () => {
          document.getElementById('wm-day-view').style.display = 'none';
          document.getElementById('wm-full-wrap').style.display = 'block';
        };
      } else {
        btnNext.textContent = 'Далее →';
        btnNext.onclick = () => WeekMenu.next();
      }
    }

    // Скролл наверх
    const card = document.getElementById('wm-day-card');
    if (card) card.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  next() {
    if (this.current < this.days.length - 1) {
      this.current++;
      this.render();
      tg?.HapticFeedback?.impactOccurred('light');
    }
  },

  prev() {
    if (this.current > 0) {
      this.current--;
      this.render();
      tg?.HapticFeedback?.impactOccurred('light');
    }
  }
};

document.getElementById('btn-generate-weekmenu').addEventListener('click', async () => {
  const prefs = document.getElementById('weekmenu-prefs').value;
  const btn = document.getElementById('btn-generate-weekmenu');
  const originalText = btn.innerHTML;

  btn.disabled = true;
  btn.innerHTML = '⏳ Шеф составляет меню...';
  tg?.HapticFeedback?.impactOccurred('medium');

  try {
    const data = await API.generateWeekMenu(prefs);

    // Сохраняем сырой текст для скачивания
    WeekMenu._rawText = data.menu;

    // Показываем пошаговый вид
    document.getElementById('weekmenu-result').style.display = 'block';
    document.getElementById('wm-day-view').style.display = 'block';
    document.getElementById('wm-full-wrap').style.display = 'none';

    // Парсим и отображаем первый день
    WeekMenu.load(data.menu.replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n'));

    setTimeout(() => {
      document.getElementById('weekmenu-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);

    tg?.HapticFeedback?.notificationOccurred('success');

  } catch (e) {
    console.error('Week menu error:', e);
    if (e.message.includes('Только для VIP')) {
      showScreen('subscription');
    } else {
      alert('Ошибка: ' + e.message);
    }
    tg?.HapticFeedback?.notificationOccurred('error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
});

// Навигация по дням
document.addEventListener('click', function(e) {
  if (e.target.id === 'wm-btn-next') WeekMenu.next();
  if (e.target.id === 'wm-btn-prev') WeekMenu.prev();
  if (e.target.id === 'wm-btn-show-full') {
    document.getElementById('wm-day-view').style.display = 'none';
    document.getElementById('wm-full-wrap').style.display = 'block';
  }
});

// ===== СКАЧАТЬ КАК ИЗОБРАЖЕНИЕ (PNG) — работает везде =====
document.getElementById('btn-download-weekmenu').addEventListener('click', async () => {
  const btn = document.getElementById('btn-download-weekmenu');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '⏳ Создаём картинку...';

  try {
    // Проверяем наличие html2canvas
    if (typeof html2canvas === 'undefined') {
      throw new Error('Библиотека не загружена. Попробуй кнопку «Печать» → «Сохранить как PDF»');
    }

    // Создаём временный div с меню для рендеринга
    const rawText = WeekMenu._rawText || document.getElementById('weekmenu-text').innerText || '';
    const date = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

    const tempDiv = document.createElement('div');
    tempDiv.style.cssText = [
      'position:fixed', 'left:-9999px', 'top:0',
      'width:390px', 'background:#faf7f4',
      'font-family:Arial,sans-serif', 'padding:0',
      'box-sizing:border-box', 'z-index:-1'
    ].join(';');

    tempDiv.innerHTML = `
      <div style="background:linear-gradient(135deg,#d98f78,#c4735a);padding:28px 24px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:#fff;">Меню на неделю</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:6px;">Шеф-Повар AI · ${date}</div>
      </div>
      <div style="padding:20px 20px 28px;line-height:1.7;font-size:14px;color:#2c2420;white-space:pre-wrap;">${
        rawText.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim()
      }</div>
    `;
    document.body.appendChild(tempDiv);

    // Используем html2canvas (входит в состав html2pdf)
    const canvas = await html2canvas(tempDiv, {
      scale: 2,
      backgroundColor: '#faf7f4',
      useCORS: true,
      logging: false,
      width: 390
    });
    document.body.removeChild(tempDiv);

    const dataUrl = canvas.toDataURL('image/png');
    const filename = `menu-${new Date().toISOString().split('T')[0]}.png`;

    const isAndroid = /Android/.test(navigator.userAgent);
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

    if (isAndroid) {
      // Android: открываем картинку в новой вкладке → долгое нажатие → «Сохранить»
      const win = window.open('', '_blank');
      if (win) {
        win.document.write(`<html><head><meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <title>Меню на неделю</title>
          <style>body{margin:0;background:#1a1a1a;display:flex;flex-direction:column;align-items:center;padding:16px;}
          img{max-width:100%;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.4);}
          p{color:#fff;font-family:sans-serif;font-size:14px;margin-top:16px;text-align:center;opacity:0.8;}</style>
          </head><body>
          <img src="${dataUrl}" alt="Меню на неделю">
          <p>Удержи палец на картинке → «Сохранить изображение»</p>
          </body></html>`);
        win.document.close();
      }
      toast('📸 Удержи палец на картинке → Сохранить!');
    } else if (isIOS) {
      // iOS: открываем картинку — Share → «Сохранить в Фото»
      const win = window.open(dataUrl, '_blank');
      if (!win) window.location.href = dataUrl;
      toast('📸 Нажми «Поделиться» → «Сохранить изображение»');
    } else {
      // Desktop — прямое скачивание
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      a.click();
      toast('🖼 Картинка сохранена!');
    }

    tg?.HapticFeedback?.notificationOccurred('success');

  } catch (e) {
    console.error('Image error:', e);
    // Fallback — скачиваем как текстовый файл, работает везде
    try {
      const raw = WeekMenu._rawText || '';
      const text = raw.replace(/<[^>]+>/g, '').trim();
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `menu-${new Date().toISOString().split('T')[0]}.txt`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
      toast('📄 Сохранено как текстовый файл!');
    } catch(e2) {
      alert('Не удалось сохранить. Используй кнопку «Печать».');
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
});

// ===== ПЕЧАТЬ =====
document.getElementById('btn-print-weekmenu').addEventListener('click', () => {
  const raw = WeekMenu._rawText || '';
  const text = raw.replace(/<[^>]+>/g, '').trim();
  const printWindow = window.open('', '_blank');
  if (!printWindow) { alert('Разреши всплывающие окна'); return; }
  printWindow.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Меню на неделю</title>
    <style>
      body{font-family:Arial,sans-serif;padding:24px;line-height:1.75;color:#2c2420;max-width:700px;margin:0 auto;}
      .hdr{text-align:center;padding:20px;background:linear-gradient(135deg,#d98f78,#c4735a);color:#fff;border-radius:10px;margin-bottom:24px;}
      .hdr h1{margin:0;font-size:22px;} .hdr p{margin:4px 0 0;font-size:13px;opacity:.9;}
      pre{white-space:pre-wrap;font-family:inherit;font-size:14px;}
      @media print{body{padding:0;}.hdr{border-radius:0;}}
    </style></head><body>
    <div class="hdr"><h1>Меню на неделю</h1>
    <p>Шеф-Повар AI · ${new Date().toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'})}</p></div>
    <pre>${text}</pre>
    <script>window.onload=function(){window.print();}<\/script>
    </body></html>`);
  printWindow.document.close();
});

// ===== ПОДЕЛИТЬСЯ =====
document.getElementById('btn-share-weekmenu').addEventListener('click', async () => {
  const raw = WeekMenu._rawText || '';
  const text = raw.replace(/<[^>]+>/g, '').trim();
  const shareText = text.substring(0, 1500) + (text.length > 1500 ? '...' : '') + '\n\n📱 Шеф-Повар AI';
  if (navigator.share) {
    try { await navigator.share({ title: 'Моё меню на неделю', text: shareText }); }
    catch(e) { /* отменено */ }
  } else {
    try {
      await navigator.clipboard.writeText(shareText);
      toast('📋 Меню скопировано!');
    } catch(e) { alert('Не удалось скопировать'); }
  }
});


// ===== TOAST (если ещё нет) =====
function toast(message, type = 'success') {
  const existing = document.querySelector('.toast-msg');
  if (existing) existing.remove();
  
  const el = document.createElement('div');
  el.className = `toast-msg toast-${type}`;
  el.textContent = message;
  el.style.cssText = `
    position: fixed;
    bottom: 30px;
    left: 50%;
    transform: translateX(-50%);
    background: linear-gradient(135deg, #d98f78 0%, #c4735a 100%);
    color: white;
    padding: 14px 24px;
    border-radius: 16px;
    font-weight: 600;
    z-index: 9999;
    box-shadow: 0 8px 32px rgba(196,115,90,0.35);
    animation: slideUpToast 0.3s;  `;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// Добавляем CSS для toast
if (!document.getElementById('toast-styles')) {
  const style = document.createElement('style');
  style.id = 'toast-styles';
  style.textContent = `
    @keyframes slideUpToast {
      from { transform: translate(-50%, 100px); opacity: 0; }
      to { transform: translate(-50%, 0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);
}


// ===== VIP: DIET =====
document.getElementById('btn-ask-diet').addEventListener('click', async () => {
  const question = document.getElementById('diet-question').value.trim();
  if (!question) return alert('Задай вопрос');
  const btn = document.getElementById('btn-ask-diet');
  btn.disabled = true;
  btn.textContent = '⏳ Думаю...';
  try {
    const data = await API.askDiet(question);
    document.getElementById('diet-text').innerHTML = data.answer.replace(/\n/g, '<br>');
    document.getElementById('diet-result').style.display = 'block';
  } catch (e) {
    console.error('Diet consultation error:', e);
    if (e.message.includes('Только для VIP')) {
      alert('🔒 Эта функция доступна только с VIP подпиской');
      showScreen('subscription');
    } else {
      alert('Ошибка: ' + e.message);
    }
  } finally {    btn.disabled = false;
    btn.textContent = '💬 Спросить';
  }
});

// ===== PROFILE =====
async function loadProfile() {
  try {
    const data = await API.getFullProfile();
    document.getElementById('profile-name').textContent = data.user?.first_name || 'Пользователь';
    document.getElementById('profile-username').textContent = data.user?.username ? '@' + data.user.username : '';
    document.getElementById('stat-recipes').textContent = data.user?.free_recipes_used || 0;
    document.getElementById('stat-plan').textContent = data.subscription?.plan_type || 'FREE';
    document.getElementById('stat-expires').textContent = data.subscription
      ? new Date(data.subscription.expires_at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
      : '—';
  } catch (e) {
    console.error('Profile error:', e);
  }
}

// ===== ЗАПУСК =====
window.addEventListener('load', async () => {
  await init();
  // Скрываем лоадер
  const loader = document.getElementById('loader');
  if (loader) {
    loader.style.transition = 'opacity 0.35s';
    loader.style.opacity = '0';
    setTimeout(() => { loader.style.display = 'none'; }, 350);
  }
  // Показываем главный экран
  const active = document.querySelector('.screen.active');
  if (!active) showScreen('home');
});

// ===== PREMIUM UI ENHANCEMENTS =====

// Update step progress bar
const _origRender = RecipeManager.render.bind(RecipeManager);
RecipeManager.render = function() {
  _origRender();
  if (!this.current) return;
  const pct = Math.round(((this.step + 1) / this.current.total) * 100);
  const fill = document.getElementById('step-progress-fill');
  const pctEl = document.getElementById('step-percent');
  if (fill) fill.style.width = pct + '%';
  if (pctEl) pctEl.textContent = pct + '%';
};


// ===== НОВЫЕ ФУНКЦИИ: история, замки, таймер =====
// Перехватываем RecipeManager.load для сохранения в историю и показа таймера
const RecipeHistory = {
  KEY: 'chef_history',
  load() { try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); } catch(e) { return []; } },
  save(list) { try { localStorage.setItem(this.KEY, JSON.stringify(list.slice(0,10))); } catch(e) {} },
  push(recipe) {
    const list = this.load();
    list.unshift({ title: (recipe.title||'').replace(/<[^>]+>/g,''), ts: Date.now(), fullText: recipe.fullText || recipe.steps.join('\n\n') });
    this.save(list);
  }
};
window.RecipeHistory = RecipeHistory;

const _origLoad2 = RecipeManager.load.bind(RecipeManager);
RecipeManager.load = function(recipe) {
  _origLoad2(recipe);
  if (recipe && recipe.title) RecipeHistory.push(recipe);
  const plan = window._userPlan || 'FREE';
  // Таймер — только PRO+
  const tw = document.getElementById('step-timer-wrap');
  if (tw) tw.style.display = (plan !== 'FREE') ? 'block' : 'none';
  // Замок на список покупок
  const ls = document.getElementById('lock-shopping');
  if (ls) ls.textContent = (plan !== 'FREE') ? '' : '\uD83D\uDD12';
  // Замок на поделиться
  const lsh = document.getElementById('lock-share');
  if (lsh) lsh.textContent = (plan === 'VIP') ? '' : '\uD83D\uDD12';
};
