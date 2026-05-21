// Telegram WebApp initialization
const tg = window.Telegram.WebApp;
tg.expand();
tg.enableClosingConfirmation();

// ===== ВАЖНО: БАЗОВЫЙ URL ДЛЯ API =====
const API_BASE = 'https://bot-1779392471-6640-zahar0304.bothost.tech';

// App state
let currentUser = null;
let currentRecipe = null;
let pendingQuery = null;
let favorites = [];
let mediaRecorder = null;
let audioChunks = [];
let currentPaymentId = null;
let currentPlanType = null;

// Load favorites from localStorage
try {
    const saved = localStorage.getItem('chef_favorites');
    if (saved) favorites = JSON.parse(saved);
} catch(e) {}

// DOM elements
const recipeInput = document.getElementById('recipeInput');
const generateBtn = document.getElementById('generateBtn');
const voiceBtn = document.getElementById('voiceBtn');
const detailsSection = document.getElementById('detailsSection');
const detailsInput = document.getElementById('detailsInput');
const submitDetailsBtn = document.getElementById('submitDetailsBtn');
const loadingSection = document.getElementById('loadingSection');
const recipeSection = document.getElementById('recipeSection');
const favoritesSection = document.getElementById('favoritesSection');
const profileSection = document.getElementById('profileSection');
const userStatusSpan = document.getElementById('userStatus');
const welcomeSection = document.getElementById('welcomeSection');

// Toast notification
function showToast(message, type = 'info') {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className = 'toast';
        toast.innerHTML = '<span class="toast-icon"></span><span class="toast-message"></span>';
        document.body.appendChild(toast);
    }
    toast.className = `toast ${type}`;
    toast.querySelector('.toast-message').textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Helper functions
function showLoading() {
    if (loadingSection) loadingSection.style.display = 'block';
    if (recipeSection) recipeSection.style.display = 'none';
    if (detailsSection) detailsSection.style.display = 'none';
    if (welcomeSection) welcomeSection.style.display = 'none';
}

function hideLoading() {
    if (loadingSection) loadingSection.style.display = 'none';
}

function showRecipe() {
    if (recipeSection) recipeSection.style.display = 'block';
    if (welcomeSection) welcomeSection.style.display = 'none';
    if (detailsSection) detailsSection.style.display = 'none';
    if (favoritesSection) favoritesSection.style.display = 'none';
    if (profileSection) profileSection.style.display = 'none';
}

function showFavorites() {
    if (favoritesSection) favoritesSection.style.display = 'block';
    if (recipeSection) recipeSection.style.display = 'none';
    if (welcomeSection) welcomeSection.style.display = 'none';
    if (detailsSection) detailsSection.style.display = 'none';
    if (profileSection) profileSection.style.display = 'none';
    renderFavorites();
}

function showProfile() {
    if (profileSection) profileSection.style.display = 'block';
    if (recipeSection) recipeSection.style.display = 'none';
    if (welcomeSection) welcomeSection.style.display = 'none';
    if (detailsSection) detailsSection.style.display = 'none';
    if (favoritesSection) favoritesSection.style.display = 'none';
    updateProfile();
}

function showWelcome() {
    if (welcomeSection) welcomeSection.style.display = 'block';
    if (recipeSection) recipeSection.style.display = 'none';
    if (detailsSection) detailsSection.style.display = 'none';
    if (favoritesSection) favoritesSection.style.display = 'none';
    if (profileSection) profileSection.style.display = 'none';
}

// API calls - ИСПРАВЛЕНО: используем полный URL
async function getUserData() {
    try {
        const userId = tg.initDataUnsafe.user?.id;
        if (!userId) {
            console.error('No user ID');
            return null;
        }
        
        console.log('Fetching user data for:', userId);
        const response = await fetch(`${API_BASE}/api/user/${userId}`);
        const data = await response.json();
        
        if (data.success) {
            currentUser = data;
            updateUserStatus();
            return data;
        } else {
            throw new Error(data.error);
        }
    } catch (error) {
        console.error('Error fetching user:', error);
        showToast('Ошибка загрузки данных: ' + error.message, 'error');
    }
    return null;
}

function updateUserStatus() {
    if (!currentUser || !userStatusSpan) return;
    
    if (currentUser.hasSubscription) {
        userStatusSpan.innerHTML = `✨ ${currentUser.subscription.plan_type}`;
    } else {
        userStatusSpan.innerHTML = `🎁 ${currentUser.freeRecipesLeft}/${currentUser.freeLimit || 3}`;
    }
}

async function generateRecipe(query, details = '') {
    if (!currentUser || !currentUser.canGenerate) {
        showSubscriptionModal();
        return false;
    }
    
    showLoading();
    
    try {
        const response = await fetch(`${API_BASE}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tgId: tg.initDataUnsafe.user.id,
                query: query,
                details: details,
                planType: currentUser.subscription?.plan_type || 'FREE'
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            displayRecipe(data.recipe);
            hideLoading();
            await getUserData();
            return true;
        } else if (data.error === 'FREE_LIMIT_REACHED') {
            hideLoading();
            showSubscriptionModal();
            return false;
        } else {
            throw new Error(data.error || 'Unknown error');
        }
    } catch (error) {
        hideLoading();
        showToast('Ошибка генерации: ' + error.message, 'error');
        return false;
    }
}

function displayRecipe(recipe) {
    currentRecipe = recipe;
    
    // Title
    const titleEl = document.getElementById('recipeTitle');
    if (titleEl) titleEl.textContent = recipe.title || 'Твой рецепт';
    
    // Description
    const descEl = document.getElementById('recipeDescription');
    if (descEl) {
        if (recipe.description && recipe.description.length > 0) {
            descEl.textContent = recipe.description;
            descEl.style.display = 'block';
        } else {
            descEl.style.display = 'none';
        }
    }
    
    // Time
    const timeEl = document.getElementById('recipeTime');
    if (timeEl) timeEl.textContent = recipe.time || '30 минут';
    
    // Ingredients
    const ingredientsList = document.getElementById('ingredientsList');
    if (ingredientsList) {
        ingredientsList.innerHTML = '';
        if (recipe.ingredients && recipe.ingredients.length > 0) {
            recipe.ingredients.forEach(ing => {
                const li = document.createElement('li');
                li.textContent = ing;
                ingredientsList.appendChild(li);
            });
        } else {
            ingredientsList.innerHTML = '<li>Ингредиенты не указаны</li>';
        }
    }
    
    // Steps
    const stepsContainer = document.getElementById('stepsList');
    if (stepsContainer) {
        stepsContainer.innerHTML = '';
        if (recipe.steps && recipe.steps.length > 0) {
            recipe.steps.forEach((step, idx) => {
                const stepDiv = document.createElement('div');
                stepDiv.className = 'step-item';
                stepDiv.innerHTML = `
                    <span class="step-number">${idx + 1}</span>
                    <span class="step-text">${escapeHtml(step)}</span>
                `;
                stepsContainer.appendChild(stepDiv);
            });
        } else {
            stepsContainer.innerHTML = '<div class="step-item">Шаги приготовления не указаны</div>';
        }
    }
    
    // Tips
    const tipsBlock = document.getElementById('tipsBlock');
    if (tipsBlock) {
        if (recipe.tips && recipe.tips.length > 0) {
            document.getElementById('tipsText').textContent = recipe.tips;
            tipsBlock.style.display = 'block';
        } else {
            tipsBlock.style.display = 'none';
        }
    }
    
    // Favorite button state
    const isFavorite = favorites.some(f => f.title === recipe.title);
    const favBtn = document.getElementById('favoriteBtn');
    if (favBtn) {
        if (isFavorite) {
            favBtn.classList.add('active');
        } else {
            favBtn.classList.remove('active');
        }
    }
    
    showRecipe();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Favorites
function saveToFavorites() {
    if (!currentRecipe) return;
    
    const index = favorites.findIndex(f => f.title === currentRecipe.title);
    if (index === -1) {
        favorites.push({ ...currentRecipe, savedAt: Date.now() });
        localStorage.setItem('chef_favorites', JSON.stringify(favorites));
        showToast('Рецепт сохранён в избранное', 'success');
        const favBtn = document.getElementById('favoriteBtn');
        if (favBtn) favBtn.classList.add('active');
    } else {
        favorites.splice(index, 1);
        localStorage.setItem('chef_favorites', JSON.stringify(favorites));
        showToast('Рецепт удалён из избранного', 'info');
        const favBtn = document.getElementById('favoriteBtn');
        if (favBtn) favBtn.classList.remove('active');
    }
}

function renderFavorites() {
    const container = document.getElementById('favoritesList');
    const emptyEl = document.getElementById('emptyFavorites');
    
    if (!container) return;
    
    if (!favorites || favorites.length === 0) {
        container.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }
    
    if (emptyEl) emptyEl.style.display = 'none';
    container.innerHTML = favorites.map((recipe, idx) => `
        <div class="favorite-item" onclick="window.loadFavoriteRecipe(${idx})">
            <div>
                <div class="favorite-title">${escapeHtml(recipe.title)}</div>
                <div style="font-size: 12px; color: #999;">${recipe.time || '30 мин'}</div>
            </div>
            <button class="favorite-delete" onclick="event.stopPropagation(); window.deleteFavorite(${idx})">🗑️</button>
        </div>
    `).join('');
}

window.loadFavoriteRecipe = function(index) {
    currentRecipe = favorites[index];
    displayRecipe(currentRecipe);
};

window.deleteFavorite = function(index) {
    favorites.splice(index, 1);
    localStorage.setItem('chef_favorites', JSON.stringify(favorites));
    renderFavorites();
    showToast('Рецепт удалён', 'info');
};

// Profile
function updateProfile() {
    if (!currentUser) return;
    
    const firstName = tg.initDataUnsafe.user?.first_name || 'Пользователь';
    const nameEl = document.getElementById('profileName');
    if (nameEl) nameEl.textContent = firstName;
    
    const usernameEl = document.getElementById('profileUsername');
    if (usernameEl) usernameEl.textContent = '@' + (tg.initDataUnsafe.user?.username || 'user');
    
    const subStatus = document.getElementById('subStatus');
    const freeRecipesRow = document.getElementById('freeRecipesRow');
    const expiresRow = document.getElementById('expiresRow');
    
    if (subStatus) {
        if (currentUser.hasSubscription) {
            subStatus.textContent = currentUser.subscription.plan_type;
            subStatus.style.color = '#FF6B35';
            if (freeRecipesRow) freeRecipesRow.style.display = 'none';
            if (expiresRow && currentUser.subscription.expires_at) {
                expiresRow.style.display = 'flex';
                const expiresDate = document.getElementById('expiresDate');
                if (expiresDate) {
                    expiresDate.textContent = new Date(currentUser.subscription.expires_at).toLocaleDateString('ru-RU');
                }
            }
        } else {
            subStatus.textContent = 'Бесплатный';
            subStatus.style.color = '#95A5A6';
            if (freeRecipesRow) {
                freeRecipesRow.style.display = 'flex';
                const freeLeft = document.getElementById('freeRecipesLeft');
                if (freeLeft) {
                    freeLeft.textContent = `${currentUser.freeRecipesLeft}/${currentUser.freeLimit || 3}`;
                }
            }
            if (expiresRow) expiresRow.style.display = 'none';
        }
    }
    
    const favoritesCount = document.getElementById('favoritesCount');
    if (favoritesCount) favoritesCount.textContent = favorites.length;
}

// Subscription & Payment
function showSubscriptionModal() {
    const modal = document.getElementById('subscriptionModal');
    if (modal) modal.style.display = 'flex';
}

function hideSubscriptionModal() {
    const modal = document.getElementById('subscriptionModal');
    if (modal) modal.style.display = 'none';
}

async function handlePayment(planType) {
    const amount = planType === 'PRO' ? 500 : 800;
    
    try {
        const response = await fetch(`${API_BASE}/api/create-payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tgId: tg.initDataUnsafe.user.id,
                planType: planType,
                amount: amount
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentPaymentId = data.paymentId;
            currentPlanType = planType;
            
            const badge = document.getElementById('paymentPlanBadge');
            if (badge) badge.textContent = `${planType} — ${amount}₽`;
            
            const sbpNumber = document.getElementById('sbpNumber');
            if (sbpNumber) sbpNumber.textContent = data.sbpPhone;
            
            const sbpName = document.getElementById('sbpName');
            if (sbpName) sbpName.textContent = data.sbpRecipient;
            
            hideSubscriptionModal();
            const paymentModal = document.getElementById('paymentModal');
            if (paymentModal) paymentModal.style.display = 'flex';
        }
    } catch (error) {
        showToast('Ошибка создания платежа', 'error');
    }
}

async function submitReceipt(file) {
    if (!currentPaymentId) return;
    
    const formData = new FormData();
    formData.append('receipt', file);
    formData.append('tgId', tg.initDataUnsafe.user.id);
    formData.append('paymentId', currentPaymentId);
    formData.append('planType', currentPlanType);
    formData.append('amount', currentPlanType === 'PRO' ? 500 : 800);
    
    try {
        const response = await fetch(`${API_BASE}/api/upload-receipt`, {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Чек отправлен! Ожидайте подтверждения', 'success');
            const paymentModal = document.getElementById('paymentModal');
            if (paymentModal) paymentModal.style.display = 'none';
            currentPaymentId = null;
            currentPlanType = null;
        } else {
            throw new Error(data.error);
        }
    } catch (error) {
        showToast('Ошибка отправки чека', 'error');
    }
}

// Voice recording
async function startRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };
        
        mediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const formData = new FormData();
            formData.append('audio', audioBlob);
            
            showToast('🎤 Распознаю голос...', 'info');
            
            try {
                const response = await fetch(`${API_BASE}/api/transcribe`, {
                    method: 'POST',
                    body: formData
                });
                const data = await response.json();
                if (data.success && data.text && recipeInput) {
                    recipeInput.value = data.text;
                    showToast('✅ Голос распознан!', 'success');
                } else {
                    showToast('Не удалось распознать', 'error');
                }
            } catch (error) {
                showToast('Ошибка распознавания', 'error');
            }
            
            stream.getTracks().forEach(track => track.stop());
            if (voiceBtn) voiceBtn.classList.remove('recording');
        };
        
        mediaRecorder.start();
        if (voiceBtn) voiceBtn.classList.add('recording');
        showToast('🎤 Говорите... Нажмите снова для остановки', 'info');
    } catch (error) {
        showToast('Нет доступа к микрофону', 'error');
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
    }
}

// Share recipe
async function shareRecipe() {
    if (!currentRecipe) return;
    
    const shareText = `🍽 *${currentRecipe.title}*\n\n` +
        `🥄 Ингредиенты:\n${(currentRecipe.ingredients || []).map(i => `• ${i}`).join('\n')}\n\n` +
        `🔥 Приготовление:\n${(currentRecipe.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
    
    if (navigator.share) {
        try {
            await navigator.share({ title: currentRecipe.title, text: shareText });
        } catch(e) {}
    } else {
        await navigator.clipboard.writeText(shareText);
        showToast('Рецепт скопирован!', 'success');
    }
}

// Helper
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Event listeners
document.addEventListener('DOMContentLoaded', async () => {
    console.log('App loaded, API_BASE:', API_BASE);
    
    await getUserData();
    
    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const page = item.dataset.page;
            document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
            
            if (page === 'home') showWelcome();
            else if (page === 'favorites') showFavorites();
            else if (page === 'profile') showProfile();
        });
    });
    
    // Generate button
    if (generateBtn) {
        generateBtn.addEventListener('click', () => {
            const query = recipeInput?.value.trim();
            if (!query) {
                showToast('Напишите, что хотите приготовить', 'info');
                return;
            }
            pendingQuery = query;
            if (detailsSection) detailsSection.style.display = 'block';
            if (detailsInput) detailsInput.focus();
        });
    }
    
    // Voice button
    if (voiceBtn) {
        voiceBtn.addEventListener('click', () => {
            if (voiceBtn.classList.contains('recording')) {
                stopRecording();
            } else {
                startRecording();
            }
        });
    }
    
    // Submit details
    if (submitDetailsBtn) {
        submitDetailsBtn.addEventListener('click', async () => {
            const details = detailsInput?.value.trim() || '';
            if (detailsSection) detailsSection.style.display = 'none';
            await generateRecipe(pendingQuery, details);
            if (detailsInput) detailsInput.value = '';
        });
    }
    
    // Quick options
    document.querySelectorAll('.quick-option').forEach(btn => {
        btn.addEventListener('click', () => {
            if (detailsInput) detailsInput.value = btn.dataset.detail;
        });
    });
    
    // Favorite button
    const favBtn = document.getElementById('favoriteBtn');
    if (favBtn) favBtn.addEventListener('click', saveToFavorites);
    
    // Share button
    const shareBtn = document.getElementById('shareBtn');
    if (shareBtn) shareBtn.addEventListener('click', shareRecipe);
    
    // New recipe button
    const newBtn = document.getElementById('newRecipeBtn');
    if (newBtn) {
        newBtn.addEventListener('click', () => {
            showWelcome();
            if (recipeInput) recipeInput.value = '';
            currentRecipe = null;
        });
    }
    
    // Upgrade button
    const upgradeBtn = document.getElementById('upgradeBtn');
    if (upgradeBtn) upgradeBtn.addEventListener('click', showSubscriptionModal);
    
    // Subscription modal
    const closeModal = document.querySelector('.close-modal');
    if (closeModal) closeModal.addEventListener('click', hideSubscriptionModal);
    
    const modalOverlay = document.querySelector('.modal-overlay');
    if (modalOverlay) modalOverlay.addEventListener('click', hideSubscriptionModal);
    
    document.querySelectorAll('.select-plan-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const plan = e.target.closest('.plan-card')?.dataset.plan;
            if (plan) handlePayment(plan);
        });
    });
    
    // Payment modal
    const closePayment = document.querySelector('.close-payment-modal');
    if (closePayment) closePayment.addEventListener('click', () => {
        const modal = document.getElementById('paymentModal');
        if (modal) modal.style.display = 'none';
    });
    
    const cancelPayment = document.querySelector('.cancel-payment');
    if (cancelPayment) cancelPayment.addEventListener('click', () => {
        const modal = document.getElementById('paymentModal');
        if (modal) modal.style.display = 'none';
    });
    
    const copyBtn = document.getElementById('copySbpBtn');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const number = document.getElementById('sbpNumber')?.textContent;
            if (number) {
                navigator.clipboard.writeText(number);
                showToast('Номер скопирован!', 'success');
            }
        });
    }
    
    const receiptInput = document.getElementById('receiptInput');
    if (receiptInput) {
        receiptInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const preview = document.getElementById('receiptPreview');
                if (preview) {
                    const img = document.createElement('img');
                    img.src = URL.createObjectURL(file);
                    preview.innerHTML = '';
                    preview.appendChild(img);
                }
                const submitBtn = document.querySelector('.submit-payment');
                if (submitBtn) submitBtn.disabled = false;
            }
        });
    }
    
    const submitPayment = document.querySelector('.submit-payment');
    if (submitPayment) {
        submitPayment.addEventListener('click', () => {
            const file = document.getElementById('receiptInput')?.files[0];
            if (!file) {
                showToast('Выберите чек', 'info');
                return;
            }
            submitReceipt(file);
        });
    }
});

// Telegram theme adaptation
if (tg.colorScheme === 'dark') {
    document.body.classList.add('dark');
}
