const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor?.('secondary_bg_color');
}

const initData = tg?.initData || '';
const ADMIN_ID = parseInt(tg?.initDataUnsafe?.user?.id || 0);

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
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API error');
    return data;
  },
  getStats: () => API.request('/api/admin/stats'),
  getPayments: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return API.request(`/api/admin/payments?${query}`);
  },
  getUsers: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return API.request(`/api/admin/users?${query}`);
  },
  getUser: (tgId) => API.request(`/api/admin/user/${tgId}`),
  getPending: () => API.request('/api/admin/pending'),
  approvePayment: (id) => API.request(`/api/admin/payment/${id}/approve`, { method: 'POST' }),
  rejectPayment: (id) => API.request(`/api/admin/payment/${id}/reject`, { method: 'POST' }),
  setPlan: (tgId, planType, days) => API.request(`/api/admin/user/${tgId}/plan`, {
    method: 'POST',
    body: JSON.stringify({ planType, days })
  }),
  banUser: (tgId, banned) => API.request(`/api/admin/user/${tgId}/ban`, {
    method: 'POST',
    body: JSON.stringify({ banned })
  })
};

// ===== STATE =====
const state = {  currentTab: 'dashboard',
  paymentsPage: 1,
  usersPage: 1,
  currentPaymentId: null,
  currentUserId: null,
  charts: {}
};

// ===== TOAST =====
function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ===== INIT =====
async function init() {
  // Проверка доступа (только админ из Telegram)
  if (!initData) {
    showError('Откройте эту страницу через Telegram Mini App');
    return;
  }
  
  try {
    // Проверяем доступ через запрос к админскому эндпоинту
    await API.getStats();
    
    document.getElementById('loader').style.display = 'none';
    document.getElementById('main-panel').style.display = 'block';
    document.getElementById('admin-name').textContent = 
      tg?.initDataUnsafe?.user?.first_name || 'Admin';
    
    setupNavigation();
    setupFilters();
    await loadDashboard();
  } catch (e) {
    console.error('Init error:', e);
    if (e.message.includes('Admin only') || e.message.includes('403')) {
      showError('Доступ запрещён. Только для администратора.');
    } else {
      showError('Ошибка загрузки: ' + e.message);
    }
  }
}

function showError(msg) {
  document.getElementById('loader').style.display = 'none';
  const denied = document.getElementById('access-denied');  denied.style.display = 'flex';
  denied.querySelector('p').textContent = msg;
}

// ===== NAVIGATION =====
function setupNavigation() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
      state.currentTab = tab;
      
      tg?.HapticFeedback?.impactOccurred('light');
      
      if (tab === 'dashboard') await loadDashboard();
      else if (tab === 'payments') await loadPayments();
      else if (tab === 'users') await loadUsers();
      else if (tab === 'subscriptions') await loadSubscriptions();
    });
  });

  document.getElementById('btn-refresh').addEventListener('click', async () => {
    tg?.HapticFeedback?.impactOccurred('medium');
    if (state.currentTab === 'dashboard') await loadDashboard();
    else if (state.currentTab === 'payments') await loadPayments();
    else if (state.currentTab === 'users') await loadUsers();
    toast('✅ Обновлено');
  });
}

// ===== DASHBOARD =====
async function loadDashboard() {
  try {
    const stats = await API.getStats();
    const b = stats.basic;
    
    document.getElementById('stat-total-users').textContent = b.total_users;
    document.getElementById('stat-users-today').textContent = b.users_today;
    document.getElementById('stat-active-subs').textContent = b.active_subs;
    document.getElementById('stat-pending').textContent = b.pending_payments;
    document.getElementById('stat-revenue-total').textContent = `${b.total_revenue || 0}₽`;
    document.getElementById('stat-revenue-month').textContent = `${b.revenue_month || 0}₽`;
    document.getElementById('stat-pro-count').textContent = b.pro_subs || 0;
    document.getElementById('stat-vip-count').textContent = b.vip_subs || 0;
    
    // График регистраций
    renderLineChart('chart-registrations', stats.regChart, 'Регистрации', '#667eea');    
    // График выручки
    renderLineChart('chart-revenue', stats.revChart, 'Выручка ₽', '#10b981', 'revenue');
    
    // График тарифов
    renderDoughnutChart('chart-plans', {
      labels: ['FREE', 'PRO', 'VIP'],
      data: [
        b.total_users - (b.pro_subs || 0) - (b.vip_subs || 0),
        b.pro_subs || 0,
        b.vip_subs || 0
      ]
    });
    
    // Истекающие подписки
    renderExpiringList(stats.expiring);
    
  } catch (e) {
    console.error('Dashboard error:', e);
    toast('Ошибка загрузки: ' + e.message, 'error');
  }
}

function renderLineChart(id, data, label, color, valueKey = 'count') {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  
  if (state.charts[id]) state.charts[id].destroy();
  
  state.charts[id] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(d => new Date(d.date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })),
      datasets: [{
        label,
        data: data.map(d => d[valueKey]),
        borderColor: color,
        backgroundColor: color + '20',
        tension: 0.4,
        fill: true,
        pointRadius: 3,
        pointBackgroundColor: color
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {          ticks: { color: '#8b8b9e', maxRotation: 45 },
          grid: { color: 'rgba(255,255,255,0.05)' }
        },
        y: {
          ticks: { color: '#8b8b9e' },
          grid: { color: 'rgba(255,255,255,0.05)' }
        }
      }
    }
  });
}

function renderDoughnutChart(id, data) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  
  if (state.charts[id]) state.charts[id].destroy();
  
  state.charts[id] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: data.labels,
      datasets: [{
        data: data.data,
        backgroundColor: ['#8b8b9e', '#667eea', '#fda085'],
        borderColor: '#16161f',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#ffffff', padding: 15 }
        }
      }
    }
  });
}

function renderExpiringList(items) {
  const list = document.getElementById('expiring-list');
  if (!items || items.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-emoji">✅</div><p>Нет истекающих подписок</p></div>';
    return;
  }
  
  list.innerHTML = items.map(s => `    <div class="data-item">
      <div class="data-item-info">
        <div class="data-item-title">${s.first_name || '—'} ${s.username ? `@${s.username}` : ''}</div>
        <div class="data-item-sub">
          <span class="badge badge-${s.plan_type.toLowerCase()}">${s.plan_type}</span>
          Истекает ${new Date(s.expires_at).toLocaleDateString('ru-RU')}
        </div>
      </div>
      <button class="btn-sm btn-primary" onclick="viewUser(${s.tg_id})">👁 Профиль</button>
    </div>
  `).join('');
}

// ===== PAYMENTS =====
async function loadPayments(page = 1) {
  state.paymentsPage = page;
  const status = document.getElementById('filter-status').value;
  const plan = document.getElementById('filter-plan').value;
  
  try {
    const data = await API.getPayments({
      status: status === 'all' ? '' : status,
      plan_type: plan === 'all' ? '' : plan,
      page,
      limit: 20
    });
    
    renderPaymentsList(data.payments);
    renderPagination('payments-pagination', data.page, data.totalPages, loadPayments);
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
}

function renderPaymentsList(payments) {
  const list = document.getElementById('payments-list');
  if (!payments || payments.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-emoji">💳</div><p>Платежей нет</p></div>';
    return;
  }
  
  list.innerHTML = payments.map(p => `
    <div class="data-item">
      <div class="data-item-info">
        <div class="data-item-title">#${p.id} · ${p.first_name || '—'} ${p.username ? `@${p.username}` : ''}</div>
        <div class="data-item-sub">
          <span class="badge badge-${p.status}">${statusText(p.status)}</span>
          <span class="badge badge-${p.plan_type.toLowerCase()}">${p.plan_type}</span>
          ${p.amount}₽ · ${new Date(p.created_at).toLocaleString('ru-RU')}
        </div>      </div>
      <div class="data-item-actions">
        ${p.receipt_file_path ? `<button class="btn-sm btn-primary" onclick="viewReceipt(${p.id}, '${p.receipt_file_path}')">👁 Чек</button>` : ''}
        ${p.status === 'pending' ? `
          <button class="btn-sm btn-success" onclick="quickApprove(${p.id})">✅</button>
          <button class="btn-sm btn-danger" onclick="quickReject(${p.id})">❌</button>
        ` : ''}
        <button class="btn-sm btn-ghost" onclick="viewUser(${p.tg_id})">👤</button>
      </div>
    </div>
  `).join('');
}

function statusText(status) {
  const map = { pending: '⏳ Ожидает', approved: '✅ Одобрен', rejected: '❌ Отклонён' };
  return map[status] || status;
}

// ===== USERS =====
async function loadUsers(page = 1) {
  state.usersPage = page;
  const search = document.getElementById('search-users').value;
  const plan = document.getElementById('filter-user-plan').value;  
  try {
    const data = await API.getUsers({
      search,
      plan: plan === 'all' ? '' : plan,
      page,
      limit: 20
    });
    
    renderUsersList(data.users);
    renderPagination('users-pagination', data.page, data.totalPages, loadUsers);
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
}

function renderUsersList(users) {
  const list = document.getElementById('users-list');
  if (!users || users.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-emoji">👥</div><p>Пользователей нет</p></div>';
    return;
  }
  
  list.innerHTML = users.map(u => {
    const plan = u.plan_type || 'FREE';
    const expires = u.expires_at ? new Date(u.expires_at).toLocaleDateString('ru-RU') : '—';
    return `
      <div class="data-item">        <div class="data-item-info">
          <div class="data-item-title">${u.first_name || '—'} ${u.username ? `@${u.username}` : ''} ${u.is_banned ? '🚫' : ''}</div>
          <div class="data-item-sub">
            <span class="badge badge-${plan.toLowerCase()}">${plan}</span>
            До: ${expires} · Рецептов: ${u.free_recipes_used || 0} · Оплат: ${u.total_paid || 0}
          </div>
        </div>
        <div class="data-item-actions">
          <button class="btn-sm btn-primary" onclick="viewUser(${u.tg_id})">👁 Подробнее</button>
        </div>
      </div>
    `;
  }).join('');
}

// ===== SUBSCRIPTIONS =====
async function loadSubscriptions() {
  try {
    const stats = await API.getStats();
    const list = document.getElementById('subs-list');
    list.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">💎</div>
          <div class="stat-info">
            <div class="stat-number">${stats.basic.active_subs}</div>
            <div class="stat-label">Всего активных</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">💳</div>
          <div class="stat-info">
            <div class="stat-number">${stats.basic.pro_subs}</div>
            <div class="stat-label">PRO</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">💎</div>
          <div class="stat-info">
            <div class="stat-number">${stats.basic.vip_subs}</div>
            <div class="stat-label">VIP</div>
          </div>
        </div>
      </div>
      <div class="section-card">
        <h3>⏰ Истекают в 7 дней</h3>
        <div id="subs-expiring"></div>
      </div>
    `;
    renderExpiringListDetailed(stats.expiring);  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
}

function renderExpiringListDetailed(items) {
  const list = document.getElementById('subs-expiring');
  if (!items || items.length === 0) {
    list.innerHTML = '<div class="empty-state"><p>Нет истекающих</p></div>';
    return;
  }
  list.innerHTML = items.map(s => {
    const days = Math.ceil((new Date(s.expires_at) - new Date()) / 86400000);
    return `
      <div class="data-item">
        <div class="data-item-info">
          <div class="data-item-title">${s.first_name || '—'} ${s.username ? `@${s.username}` : ''}</div>
          <div class="data-item-sub">
            <span class="badge badge-${s.plan_type.toLowerCase()}">${s.plan_type}</span>
            Истекает через ${days} д. (${new Date(s.expires_at).toLocaleDateString('ru-RU')})
          </div>
        </div>
        <button class="btn-sm btn-primary" onclick="viewUser(${s.tg_id})">👁 Профиль</button>
      </div>
    `;
  }).join('');
}

// ===== FILTERS =====
function setupFilters() {
  document.getElementById('filter-status').addEventListener('change', () => loadPayments(1));
  document.getElementById('filter-plan').addEventListener('change', () => loadPayments(1));
  document.getElementById('filter-user-plan').addEventListener('change', () => loadUsers(1));
  
  let searchTimeout;
  document.getElementById('search-users').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => loadUsers(1), 500);
  });
}

// ===== PAGINATION =====
function renderPagination(containerId, currentPage, totalPages, loadFn) {
  const container = document.getElementById(containerId);
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }
  
  let html = '';  const maxPages = 5;
  let start = Math.max(1, currentPage - 2);
  let end = Math.min(totalPages, start + maxPages - 1);
  start = Math.max(1, end - maxPages + 1);
  
  if (start > 1) html += `<button class="page-btn" onclick="${loadFn.name}(1)">«</button>`;
  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="${loadFn.name}(${i})">${i}</button>`;
  }
  if (end < totalPages) html += `<button class="page-btn" onclick="${loadFn.name}(${totalPages})">»</button>`;
  
  container.innerHTML = html;
}

// ===== RECEIPT MODAL =====
window.viewReceipt = async (id, path) => {
  state.currentPaymentId = id;
  document.getElementById('receipt-id').textContent = id;
  document.getElementById('receipt-image').src = path;
  document.getElementById('receipt-modal').style.display = 'flex';
};

window.closeReceiptModal = () => {
  document.getElementById('receipt-modal').style.display = 'none';
};

window.approvePayment = async () => {
  try {
    await API.approvePayment(state.currentPaymentId);
    toast('✅ Одобрено');
    closeReceiptModal();
    loadPayments(state.paymentsPage);
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
};

window.rejectPayment = async () => {
  if (!confirm('Отклонить платёж?')) return;
  try {
    await API.rejectPayment(state.currentPaymentId);
    toast('❌ Отклонено');
    closeReceiptModal();
    loadPayments(state.paymentsPage);
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
};

window.quickApprove = async (id) => {  if (!confirm('Одобрить?')) return;
  try {
    await API.approvePayment(id);
    toast('✅ Одобрено');
    loadPayments(state.paymentsPage);
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
};

window.quickReject = async (id) => {
  if (!confirm('Отклонить?')) return;
  try {
    await API.rejectPayment(id);
    toast('❌ Отклонено');
    loadPayments(state.paymentsPage);
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
};

// ===== USER MODAL =====
window.viewUser = async (tgId) => {
  state.currentUserId = tgId;
  document.getElementById('user-modal').style.display = 'flex';
  const content = document.getElementById('modal-user-content');
  content.innerHTML = '<div class="empty-state"><p>Загрузка...</p></div>';
  
  try {
    const data = await API.getUser(tgId);
    const u = data.user;
    document.getElementById('modal-user-name').textContent = u.first_name || 'User';
    
    content.innerHTML = `
      <div class="user-detail-grid">
        <div class="user-detail-item">
          <div class="user-detail-label">Username</div>
          <div class="user-detail-value">@${u.username || '—'}</div>
        </div>
        <div class="user-detail-item">
          <div class="user-detail-label">TG ID</div>
          <div class="user-detail-value"><code>${u.tg_id}</code></div>
        </div>
        <div class="user-detail-item">
          <div class="user-detail-label">Регистрация</div>
          <div class="user-detail-value">${new Date(u.created_at).toLocaleDateString('ru-RU')}</div>
        </div>
        <div class="user-detail-item">
          <div class="user-detail-label">Рецептов создано</div>
          <div class="user-detail-value">${u.free_recipes_used || 0}</div>        </div>
      </div>
      
      <div class="section-title">💎 Активная подписка</div>
      ${data.subscriptions && data.subscriptions.length > 0 && data.subscriptions[0].is_active ? `
        <div class="user-detail-grid">
          <div class="user-detail-item">
            <div class="user-detail-label">Тариф</div>
            <div class="user-detail-value"><span class="badge badge-${data.subscriptions[0].plan_type.toLowerCase()}">${data.subscriptions[0].plan_type}</span></div>
          </div>
          <div class="user-detail-item">
            <div class="user-detail-label">Истекает</div>
            <div class="user-detail-value">${new Date(data.subscriptions[0].expires_at).toLocaleDateString('ru-RU')}</div>
          </div>
        </div>
      ` : '<p style="color:var(--hint);">Нет активной подписки</p>'}
      
      <div class="section-title">⚡ Действия</div>
      <div class="user-actions">
        <button class="btn-sm btn-primary" onclick="extendPlan('PRO', 30)">💳 Выдать PRO 30д</button>
        <button class="btn-sm btn-primary" onclick="extendPlan('VIP', 30)">💎 Выдать VIP 30д</button>
        <button class="btn-sm btn-primary" onclick="extendPlan('PRO', 7)">💳 PRO 7д</button>
        <button class="btn-sm btn-primary" onclick="extendPlan('VIP', 7)">💎 VIP 7д</button>
        <button class="btn-sm ${u.is_banned ? 'btn-success' : 'btn-danger'}" onclick="toggleBan(${!u.is_banned})">
          ${u.is_banned ? '🔓 Разбанить' : '🚫 Забанить'}
        </button>
        <button class="btn-sm btn-ghost" onclick="openInTelegram(${u.tg_id})">💬 Написать</button>
      </div>
      
      ${data.payments && data.payments.length > 0 ? `
        <div class="section-title">💳 История платежей (${data.payments.length})</div>
        <div class="data-list">
          ${data.payments.map(p => `
            <div class="data-item">
              <div class="data-item-info">
                <div class="data-item-title">#${p.id} · ${p.amount}₽</div>
                <div class="data-item-sub">
                  <span class="badge badge-${p.status}">${statusText(p.status)}</span>
                  <span class="badge badge-${p.plan_type.toLowerCase()}">${p.plan_type}</span>
                  ${new Date(p.created_at).toLocaleDateString('ru-RU')}
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;
  } catch (e) {
    content.innerHTML = `<div class="empty-state">❌ ${e.message}</div>`;
  }};

window.closeUserModal = () => {
  document.getElementById('user-modal').style.display = 'none';
};

window.extendPlan = async (planType, days) => {
  if (!confirm(`Выдать ${planType} на ${days} дней?`)) return;
  try {
    await API.setPlan(state.currentUserId, planType, days);
    toast(`✅ ${planType} выдан на ${days} дней`);
    viewUser(state.currentUserId);
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
};

window.toggleBan = async (banned) => {
  if (!confirm(banned ? 'Забанить пользователя?' : 'Разбанить?')) return;
  try {
    await API.banUser(state.currentUserId, banned);
    toast(banned ? '🚫 Забанен' : '🔓 Разбанен');
    viewUser(state.currentUserId);
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
};

window.openInTelegram = (tgId) => {
  window.open(`tg://user?id=${tgId}`, '_blank');
};

// ===== EXPORT =====
window.exportData = async (type) => {
  try {
    const res = await fetch(`/api/admin/export/${type}`, {
      headers: { 'x-telegram-init-data': initData }
    });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${type}_${new Date().toISOString().split('T')[0]}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    toast('📥 Файл скачан');
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }};

// ===== START =====
init();
