// ===== Telegram WebApp initialization с защитой от ошибок =====
let tg;
try {
    tg = window.Telegram.WebApp;
    if (!tg) {
        throw new Error('WebApp not found');
    }
    tg.expand();
    tg.enableClosingConfirmation();
    console.log('✅ Telegram WebApp initialized');
} catch(e) {
    console.error('❌ Telegram WebApp error:', e);
    // Режим отладки - показываем ошибку но не ломаем приложение
    tg = {
        initDataUnsafe: { user: { id: null, first_name: 'Тестовый', username: 'test' } },
        expand: () => {},
        enableClosingConfirmation: () => {},
        colorScheme: 'light',
        ready: () => {},
        sendData: () => {}
    };
    showToast('Откройте приложение через Telegram', 'error');
}

// ===== API BASE (используем текущий домен) =====
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

// Load favorites
try {
    const saved = localStorage.getItem('chef_favorites');
    if (saved) favorites = JSON.parse(saved);
} catch (e) {
    console.error('Favorites load error:', e);
}

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

// Sections
function showLoading() {
    if (loadingSection) loadingSection.style.display = 'block';
    if (recipeSection) recipeSection.style.display = 'none';
    if (detailsSection) detailsSection.style.display = 'none';
    if (welcomeSection) welcomeSection.style.display = 'none';
    if (favoritesSection) favoritesSection.style.display = 'none';
    if (profileSection) profileSection.style.display = 'none';
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

// Helpers
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function getUserId() {
    // Пытаемся получить ID из Telegram
    if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id) {
        return tg.initDataUnsafe.user.id;
    }
    // Запасной вариант - используем localStorage или тестовый ID
    const savedId = localStorage.getItem('test_user_id');
    if (savedId) return parseInt(savedId);
    // Тестовый ID (замените на свой)
    return 8043971654;
}

// API calls
async function getUserData() {
    try {
        const userId = getUserId();
        
        if (!userId) {
            showToast('Ошибка авторизации, перезапустите приложение', 'error');
            // Временные данные для демонстрации
            currentUser = {
                hasSubscription: false,
                freeRecipesLeft: 3,
                freeLimit: 3,
                canGenerate: true
            };
            updateUserStatus();
            return currentUser;
        }

        console.log('📡 Запрос пользователя:', userId);
        const response = await fetch(`${API_BASE}/api/user/${userId}`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        if (data.success) {
            currentUser = data;
            updateUserStatus();
            return data;
        }

        throw new Error(data.error || 'Ошибка сервера');

    } catch (error) {
        console.error('Get user error:', error);
        showToast('Ошибка загрузки: ' + error.message, 'error');
        
        // Временные данные для демонстрации, чтобы приложение работало
        currentUser = {
            hasSubscription: false,
            freeRecipesLeft: 3,
            freeLimit: 3,
            canGenerate: true
        };
        updateUserStatus();
    }

    return currentUser;
}

function updateUserStatus() {
    if (!currentUser || !userStatusSpan) return;

    if (currentUser.hasSubscription) {
        userStatusSpan.innerHTML = `✨ ${currentUser.subscription?.plan_type || 'PRO'}`;
    } else {
        userStatusSpan.innerHTML = `🎁 ${currentUser.freeRecipesLeft || 3}/${currentUser.freeLimit || 3}`;
    }
}

// Recipe generation
async function generateRecipe(query, details = '') {
    if (!currentUser || !currentUser.canGenerate) {
        showSubscriptionModal();
        return false;
    }

    const userId = getUserId();

    if (!userId) {
        showToast('Ошибка авторизации', 'error');
        return false;
    }

    showLoading();

    try {
        console.log('📡 Генерация рецепта:', query);
        
        const response = await fetch(`${API_BASE}/api/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                tgId: userId,
                query: query,
                details: details,
                planType: currentUser.subscription?.plan_type || 'FREE'
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `HTTP ${response.status}`);
        }

        const data = await response.json();

        if (data.success) {
            displayRecipe(data.recipe);
            await getUserData(); // Обновляем счетчик бесплатных рецептов
            pendingQuery = null;
            hideLoading();
            return true;
        }

        if (data.error === 'FREE_LIMIT_REACHED') {
            hideLoading();
            showSubscriptionModal();
            return false;
        }

        throw new Error(data.error || 'Ошибка генерации');

    } catch (error) {
        console.error('Generate error:', error);
        hideLoading();
        showToast(error.message, 'error');
        
        // Демо-рецепт для теста, если API не отвечает
        const demoRecipe = {
            title: query,
            description: `Вкусный рецепт "${query}" для вас!`,
            ingredients: [
                `Свежие продукты для ${query}`,
                'Соль, перец по вкусу',
                'Растительное масло'
            ],
            time: '30-40 минут',
            steps: [
                `Подготовьте все ингредиенты для ${query}.`,
                'Следуйте инструкции приготовления.',
                'Подавайте горячим, украсив зеленью.',
                'Приятного аппетита!'
            ],
            tips: 'Используйте только свежие продукты для лучшего результата.'
        };
        displayRecipe(demoRecipe);
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
        if (recipe.description) {
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
        (recipe.ingredients || ['Ингредиенты не указаны']).forEach(ing => {
            const li = document.createElement('li');
            li.textContent = ing;
            ingredientsList.appendChild(li);
        });
    }

    // Steps
    const stepsList = document.getElementById('stepsList');
    if (stepsList) {
        stepsList.innerHTML = '';
        (recipe.steps || ['Шаги не указаны']).forEach((step, idx) => {
            const div = document.createElement('div');
            div.className = 'step-item';
            div.innerHTML = `
                <span class="step-number">${idx + 1}</span>
                <span class="step-text">${escapeHtml(step)}</span>
            `;
            stepsList.appendChild(div);
        });
    }

    // Tips
    const tipsBlock = document.getElementById('tipsBlock');
    if (tipsBlock) {
        if (recipe.tips) {
            const tipsText = document.getElementById('tipsText');
            if (tipsText) {
                tipsText.textContent = Array.isArray(recipe.tips) 
                    ? recipe.tips.join('\n') 
                    : recipe.tips;
            }
            tipsBlock.style.display = 'block';
        } else {
            tipsBlock.style.display = 'none';
        }
    }

    // Nutrition (VIP feature)
    const nutritionBlock = document.getElementById('nutritionBlock');
    if (nutritionBlock && recipe.nutrition) {
        const nutritionContent = document.getElementById('nutritionContent');
        if (nutritionContent) {
            nutritionContent.innerHTML = `
                <div class="nutrition-item">
                    <span class="nutrition-label">🔥 Калории</span>
                    <span class="nutrition-value">${recipe.nutrition.calories || '—'}</span>
                </div>
                <div class="nutrition-item">
                    <span class="nutrition-label">🍗 Белки</span>
                    <span class="nutrition-value">${recipe.nutrition.protein || '—'}г</span>
                </div>
                <div class="nutrition-item">
                    <span class="nutrition-label">🍚 Жиры</span>
                    <span class="nutrition-value">${recipe.nutrition.fat || '—'}г</span>
                </div>
                <div class="nutrition-item">
                    <span class="nutrition-label">🌾 Углеводы</span>
                    <span class="nutrition-value">${recipe.nutrition.carbs || '—'}г</span>
                </div>
            `;
        }
        nutritionBlock.style.display = 'block';
    } else if (nutritionBlock) {
        nutritionBlock.style.display = 'none';
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
    
    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Favorites
function saveToFavorites() {
    if (!currentRecipe) return;

    const exists = favorites.find(f => f.title === currentRecipe.title);

    if (!exists) {
        favorites.push({
            ...currentRecipe,
            savedAt: Date.now()
        });
        showToast('Сохранено в избранное ❤️', 'success');
    } else {
        favorites = favorites.filter(f => f.title !== currentRecipe.title);
        showToast('Удалено из избранного', 'info');
    }

    localStorage.setItem('chef_favorites', JSON.stringify(favorites));
    renderFavorites();
    
    const favBtn = document.getElementById('favoriteBtn');
    if (favBtn) {
        if (!exists) {
            favBtn.classList.add('active');
        } else {
            favBtn.classList.remove('active');
        }
    }
}

function renderFavorites() {
    const container = document.getElementById('favoritesList');
    const empty = document.getElementById('emptyFavorites');

    if (!container) return;

    if (!favorites.length) {
        container.innerHTML = '';
        if (empty) empty.style.display = 'block';
        return;
    }

    if (empty) empty.style.display = 'none';

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
    displayRecipe(favorites[index]);
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

    const firstName = tg?.initDataUnsafe?.user?.first_name || 'Пользователь';
    const username = tg?.initDataUnsafe?.user?.username || 'user';
    
    const nameEl = document.getElementById('profileName');
    if (nameEl) nameEl.textContent = firstName;
    
    const usernameEl = document.getElementById('profileUsername');
    if (usernameEl) usernameEl.textContent = '@' + username;
    
    const favoritesCount = document.getElementById('favoritesCount');
    if (favoritesCount) favoritesCount.textContent = favorites.length;
}

// Subscription modal
function showSubscriptionModal() {
    const modal = document.getElementById('subscriptionModal');
    if (modal) modal.style.display = 'flex';
}

function hideSubscriptionModal() {
    const modal = document.getElementById('subscriptionModal');
    if (modal) modal.style.display = 'none';
}

// Share recipe
async function shareRecipe() {
    if (!currentRecipe) return;

    const text = `🍽 ${currentRecipe.title}\n\n` +
        `🥄 Ингредиенты:\n${(currentRecipe.ingredients || []).map(i => `• ${i}`).join('\n')}\n\n` +
        `🔥 Приготовление:\n${(currentRecipe.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}`;

    try {
        if (navigator.share) {
            await navigator.share({
                title: currentRecipe.title,
                text: text
            });
        } else {
            await navigator.clipboard.writeText(text);
            showToast('Рецепт скопирован в буфер', 'success');
        }
    } catch (error) {
        console.error('Share error:', error);
    }
}

// Save as image (requires html2canvas)
async function saveRecipeAsImage() {
    if (!currentRecipe) return;
    showToast('Функция сохранения изображения будет доступна в следующем обновлении', 'info');
}

// Voice recording
async function startRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = e => {
            if (e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const formData = new FormData();
            formData.append('audio', audioBlob);
            
            showToast('🎤 Распознаю...', 'info');
            
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
            
            stream.getTracks().forEach(t => t.stop());
            if (voiceBtn) voiceBtn.classList.remove('recording');
        };

        mediaRecorder.start();
        if (voiceBtn) voiceBtn.classList.add('recording');
        showToast('🎤 Говорите... Нажмите снова для остановки', 'info');
    } catch (error) {
        console.error('Microphone error:', error);
        showToast('Нет доступа к микрофону', 'error');
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        if (voiceBtn) voiceBtn.classList.remove('recording');
    }
}

// Event listeners
document.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 App starting...');
    await getUserData();

    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            item.classList.add('active');
            const page = item.dataset.page;
            if (page === 'home') showWelcome();
            if (page === 'favorites') showFavorites();
            if (page === 'profile') showProfile();
        });
    });

    // Generate button
    generateBtn?.addEventListener('click', () => {
        const query = recipeInput?.value.trim();
        if (!query) {
            showToast('Напишите, что хотите приготовить', 'info');
            return;
        }
        pendingQuery = query;
        if (detailsSection) detailsSection.style.display = 'block';
        if (detailsInput) detailsInput.focus();
    });

    // Submit details
    submitDetailsBtn?.addEventListener('click', async () => {
        const details = detailsInput?.value.trim() || '';
        if (detailsSection) detailsSection.style.display = 'none';
        await generateRecipe(pendingQuery, details);
        if (detailsInput) detailsInput.value = '';
    });

    // Quick options
    document.querySelectorAll('.quick-option').forEach(btn => {
        btn.addEventListener('click', () => {
            if (detailsInput) detailsInput.value = btn.dataset.detail;
        });
    });

    // Voice button
    voiceBtn?.addEventListener('click', () => {
        if (voiceBtn.classList.contains('recording')) {
            stopRecording();
        } else {
            startRecording();
        }
    });

    // Favorite button
    document.getElementById('favoriteBtn')?.addEventListener('click', saveToFavorites);

    // Share button
    document.getElementById('shareBtn')?.addEventListener('click', shareRecipe);

    // Save image button
    document.getElementById('saveImageBtn')?.addEventListener('click', saveRecipeAsImage);

    // New recipe button
    document.getElementById('newRecipeBtn')?.addEventListener('click', () => {
        showWelcome();
        if (recipeInput) recipeInput.value = '';
        currentRecipe = null;
    });

    // Upgrade button
    document.getElementById('upgradeBtn')?.addEventListener('click', showSubscriptionModal);

    // Modal close
    document.querySelector('.close-modal')?.addEventListener('click', hideSubscriptionModal);
    document.querySelector('.modal-overlay')?.addEventListener('click', hideSubscriptionModal);
    
    // Close payment modal
    document.querySelector('.close-payment-modal')?.addEventListener('click', () => {
        const modal = document.getElementById('paymentModal');
        if (modal) modal.style.display = 'none';
    });
    
    document.querySelector('.cancel-payment')?.addEventListener('click', () => {
        const modal = document.getElementById('paymentModal');
        if (modal) modal.style.display = 'none';
    });
    
    // Copy SBP button
    document.getElementById('copySbpBtn')?.addEventListener('click', () => {
        const number = document.getElementById('sbpNumber')?.textContent;
        if (number) {
            navigator.clipboard.writeText(number);
            showToast('Номер скопирован!', 'success');
        }
    });
});

// Theme adaptation
if (tg && tg.colorScheme === 'dark') {
    document.body.classList.add('dark');
}

console.log('✅ App.js loaded successfully');
