// Telegram WebApp initialization
const tg = window.Telegram?.WebApp;

if (!tg) {
    alert('Откройте приложение через Telegram');
    throw new Error('Telegram WebApp not found');
}

tg.expand();
tg.enableClosingConfirmation();

// ===== API =====
const API_BASE = window.location.origin;

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
    console.error(e);
}

// DOM
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

// Toast
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;

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
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function getUserId() {
    return tg.initDataUnsafe?.user?.id || null;
}

// API
async function getUserData() {
    try {
        const userId = getUserId();

        if (!userId) {
            showToast('Ошибка Telegram авторизации', 'error');
            return null;
        }

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
        console.error(error);
        showToast(error.message, 'error');
    }

    return null;
}

function updateUserStatus() {
    if (!currentUser || !userStatusSpan) return;

    if (currentUser.hasSubscription) {
        userStatusSpan.innerHTML = `✨ ${currentUser.subscription.plan_type}`;
    } else {
        userStatusSpan.innerHTML =
            `🎁 ${currentUser.freeRecipesLeft}/${currentUser.freeLimit || 3}`;
    }
}

// Recipe
async function generateRecipe(query, details = '') {

    if (!currentUser || !currentUser.canGenerate) {
        showSubscriptionModal();
        return;
    }

    const userId = getUserId();

    if (!userId) {
        showToast('Ошибка Telegram', 'error');
        return;
    }

    showLoading();

    try {

        const response = await fetch(`${API_BASE}/api/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                tgId: userId,
                query,
                details,
                planType: currentUser.subscription?.plan_type || 'FREE'
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        if (data.success) {

            displayRecipe(data.recipe);

            await getUserData();

            pendingQuery = null;

            hideLoading();

            return;
        }

        if (data.error === 'FREE_LIMIT_REACHED') {
            hideLoading();
            showSubscriptionModal();
            return;
        }

        throw new Error(data.error || 'Ошибка');

    } catch (error) {

        console.error(error);

        hideLoading();

        showToast(error.message, 'error');
    }
}

function displayRecipe(recipe) {

    currentRecipe = recipe;

    document.getElementById('recipeTitle').textContent =
        recipe.title || 'Твой рецепт';

    const descEl = document.getElementById('recipeDescription');

    if (recipe.description) {
        descEl.textContent = recipe.description;
        descEl.style.display = 'block';
    } else {
        descEl.style.display = 'none';
    }

    document.getElementById('recipeTime').textContent =
        recipe.time || '30 минут';

    // Ingredients
    const ingredientsList = document.getElementById('ingredientsList');

    ingredientsList.innerHTML = '';

    (recipe.ingredients || []).forEach(ing => {
        const li = document.createElement('li');
        li.textContent = ing;
        ingredientsList.appendChild(li);
    });

    // Steps
    const stepsList = document.getElementById('stepsList');

    stepsList.innerHTML = '';

    (recipe.steps || []).forEach((step, idx) => {

        const div = document.createElement('div');

        div.className = 'step-item';

        div.innerHTML = `
            <span class="step-number">${idx + 1}</span>
            <span class="step-text">${escapeHtml(step)}</span>
        `;

        stepsList.appendChild(div);
    });

    // Tips
    const tipsBlock = document.getElementById('tipsBlock');

    if (recipe.tips) {

        document.getElementById('tipsText').textContent =
            Array.isArray(recipe.tips)
                ? recipe.tips.join('\n')
                : recipe.tips;

        tipsBlock.style.display = 'block';

    } else {
        tipsBlock.style.display = 'none';
    }

    // Nutrition
    const nutritionBlock = document.getElementById('nutritionBlock');
    const nutritionContent = document.getElementById('nutritionContent');

    if (recipe.nutrition) {

        nutritionBlock.style.display = 'block';

        nutritionContent.innerHTML = `
            <div class="nutrition-item">
                <span class="nutrition-label">Калории</span>
                <span class="nutrition-value">${recipe.nutrition.calories || 0}</span>
            </div>

            <div class="nutrition-item">
                <span class="nutrition-label">Белки</span>
                <span class="nutrition-value">${recipe.nutrition.protein || 0}г</span>
            </div>

            <div class="nutrition-item">
                <span class="nutrition-label">Жиры</span>
                <span class="nutrition-value">${recipe.nutrition.fat || 0}г</span>
            </div>

            <div class="nutrition-item">
                <span class="nutrition-label">Углеводы</span>
                <span class="nutrition-value">${recipe.nutrition.carbs || 0}г</span>
            </div>
        `;

    } else {
        nutritionBlock.style.display = 'none';
    }

    showRecipe();
}

// Favorites
function saveToFavorites() {

    if (!currentRecipe) return;

    const exists =
        favorites.find(f => f.title === currentRecipe.title);

    if (!exists) {

        favorites.push({
            ...currentRecipe,
            savedAt: Date.now()
        });

        showToast('Сохранено ❤️', 'success');

    } else {

        favorites =
            favorites.filter(f => f.title !== currentRecipe.title);

        showToast('Удалено', 'info');
    }

    localStorage.setItem(
        'chef_favorites',
        JSON.stringify(favorites)
    );

    renderFavorites();
}

function renderFavorites() {

    const container =
        document.getElementById('favoritesList');

    const empty =
        document.getElementById('emptyFavorites');

    if (!favorites.length) {

        container.innerHTML = '';

        empty.style.display = 'block';

        return;
    }

    empty.style.display = 'none';

    container.innerHTML =
        favorites.map((recipe, idx) => `
            <div class="favorite-item"
                 onclick="window.loadFavoriteRecipe(${idx})">

                <div>
                    <div class="favorite-title">
                        ${escapeHtml(recipe.title)}
                    </div>
                </div>

                <button class="favorite-delete"
                    onclick="event.stopPropagation();
                    window.deleteFavorite(${idx})">
                    🗑️
                </button>
            </div>
        `).join('');
}

window.loadFavoriteRecipe = function(index) {
    displayRecipe(favorites[index]);
};

window.deleteFavorite = function(index) {

    favorites.splice(index, 1);

    localStorage.setItem(
        'chef_favorites',
        JSON.stringify(favorites)
    );

    renderFavorites();
};

// Profile
function updateProfile() {

    if (!currentUser) return;

    document.getElementById('profileName').textContent =
        tg.initDataUnsafe.user?.first_name || 'Пользователь';

    document.getElementById('profileUsername').textContent =
        '@' + (tg.initDataUnsafe.user?.username || 'user');

    document.getElementById('favoritesCount').textContent =
        favorites.length;
}

// Subscription
function showSubscriptionModal() {
    document.getElementById('subscriptionModal').style.display = 'flex';
}

function hideSubscriptionModal() {
    document.getElementById('subscriptionModal').style.display = 'none';
}

// Share
async function shareRecipe() {

    if (!currentRecipe) return;

    const text = `
🍽 ${currentRecipe.title}

🥄 Ингредиенты:
${(currentRecipe.ingredients || []).join('\n')}

🔥 Приготовление:
${(currentRecipe.steps || []).join('\n')}
`;

    try {

        if (navigator.share) {

            await navigator.share({
                title: currentRecipe.title,
                text
            });

        } else {

            await navigator.clipboard.writeText(text);

            showToast('Скопировано', 'success');
        }

    } catch (error) {
        console.error(error);
    }
}

// Save image
async function saveRecipeAsImage() {

    if (!currentRecipe) return;

    try {

        const recipeCard =
            document.querySelector('.recipe-card');

        const canvas =
            await html2canvas(recipeCard);

        const link =
            document.createElement('a');

        link.download =
            `${currentRecipe.title}.png`;

        link.href =
            canvas.toDataURL();

        link.click();

    } catch (error) {

        console.error(error);

        showToast('Ошибка сохранения', 'error');
    }
}

// Voice
async function startRecording() {

    try {

        const stream =
            await navigator.mediaDevices.getUserMedia({
                audio: true
            });

        mediaRecorder =
            new MediaRecorder(stream);

        audioChunks = [];

        mediaRecorder.ondataavailable = e => {
            if (e.data.size > 0)
                audioChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
            stream.getTracks().forEach(t => t.stop());
        };

        mediaRecorder.start();

        voiceBtn.classList.add('recording');

        showToast('🎤 Запись...', 'info');

    } catch (error) {

        console.error(error);

        showToast('Нет доступа к микрофону', 'error');
    }
}

function stopRecording() {

    if (
        mediaRecorder &&
        mediaRecorder.state === 'recording'
    ) {

        mediaRecorder.stop();

        voiceBtn.classList.remove('recording');
    }
}

// Init
document.addEventListener('DOMContentLoaded', async () => {

    await getUserData();

    // Nav
    document.querySelectorAll('.nav-item')
        .forEach(item => {

            item.addEventListener('click', () => {

                document.querySelectorAll('.nav-item')
                    .forEach(n => n.classList.remove('active'));

                item.classList.add('active');

                const page = item.dataset.page;

                if (page === 'home') showWelcome();
                if (page === 'favorites') showFavorites();
                if (page === 'profile') showProfile();
            });
        });

    // Generate
    generateBtn?.addEventListener('click', () => {

        const query = recipeInput.value.trim();

        if (!query) {
            showToast('Введите запрос', 'info');
            return;
        }

        pendingQuery = query;

        detailsSection.style.display = 'block';
    });

    // Submit details
    submitDetailsBtn?.addEventListener('click', async () => {

        const details =
            detailsInput.value.trim();

        detailsSection.style.display = 'none';

        await generateRecipe(pendingQuery, details);

        detailsInput.value = '';
    });

    // Voice
    voiceBtn?.addEventListener('click', () => {

        if (voiceBtn.classList.contains('recording')) {
            stopRecording();
        } else {
            startRecording();
        }
    });

    // Favorites
    document.getElementById('favoriteBtn')
        ?.addEventListener('click', saveToFavorites);

    // Share
    document.getElementById('shareBtn')
        ?.addEventListener('click', shareRecipe);

    // Save image
    document.getElementById('saveImageBtn')
        ?.addEventListener('click', saveRecipeAsImage);

    // New recipe
    document.getElementById('newRecipeBtn')
        ?.addEventListener('click', () => {

            showWelcome();

            recipeInput.value = '';

            currentRecipe = null;
        });

    // Upgrade
    document.getElementById('upgradeBtn')
        ?.addEventListener('click', showSubscriptionModal);

    // Modal close
    document.querySelector('.close-modal')
        ?.addEventListener('click', hideSubscriptionModal);

    document.querySelector('.modal-overlay')
        ?.addEventListener('click', hideSubscriptionModal);
});

// Theme
if (tg.colorScheme === 'dark') {
    document.body.classList.add('dark');
}
