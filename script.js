// ============================================================
// 🛒 Telegram Mini App — Список покупок
// ============================================================

const tg = window.Telegram?.WebApp;

// ---------- Инициализация ----------
if (tg) {
    tg.ready();          // сообщаем Telegram, что приложение готово
    tg.expand();         // разворачиваем на весь экран
    tg.enableClosingConfirmation(); // предупреждение при закрытии, если есть несохранённые данные (опционально)

    // Подстраиваем цвета под тему Telegram
    applyTelegramTheme();
    tg.onEvent("themeChanged", applyTelegramTheme);
}

function applyTelegramTheme() {
    if (!tg?.themeParams) return;
    const p = tg.themeParams;
    const root = document.documentElement;
    if (p.bg_color) root.style.setProperty("--tg-bg", p.bg_color);
    if (p.text_color) root.style.setProperty("--tg-text", p.text_color);
    if (p.hint_color) root.style.setProperty("--tg-hint", p.hint_color);
    if (p.button_color) root.style.setProperty("--tg-button", p.button_color);
    if (p.button_text_color) root.style.setProperty("--tg-button-text", p.button_text_color);
    if (p.secondary_bg_color) root.style.setProperty("--tg-secondary-bg", p.secondary_bg_color);
    if (p.link_color) root.style.setProperty("--tg-accent", p.link_color);
}

// ---------- Приветствие ----------
const user = tg?.initDataUnsafe?.user;
const greeting = document.getElementById("user-greeting");

if (user) {
    greeting.textContent = `Привет, ${user.first_name}!`;
} else {
    greeting.textContent = "Откройте через Telegram";
}

// ============================================================
// 📦 Состояние списка
// ============================================================

let shopping = [];  // [{ id, name, bought }]

// ---------- Загрузка с сервера ----------
async function loadShopping() {
    try {
        const res = await fetch("/api/shopping", {
            headers: { "X-Telegram-Init-Data": tg?.initData || "" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        shopping = await res.json();
        render();
    } catch (err) {
        console.error("Ошибка загрузки:", err);
        // Заглушка для теста вне сервера
        shopping = [
            { id: "1", name: "Молоко", bought: false },
            { id: "2", name: "Хлеб", bought: true },
        ];
        render();
    }
}

// ---------- Сохранение на сервер ----------
async function syncWithServer(action, payload) {
    try {
        const res = await fetch("/api/shopping", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Telegram-Init-Data": tg?.initData || "",
            },
            body: JSON.stringify({ action, ...payload }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        console.error("Ошибка синхронизации:", err);
        return null;
    }
}

// ============================================================
// 🎨 Рендер
// ============================================================

const listEl = document.getElementById("shopping-list");
const emptyEl = document.getElementById("empty-state");
const statsEl = document.getElementById("stats");
const statRemainingEl = document.getElementById("stat-remaining");
const statBoughtEl = document.getElementById("stat-bought");

function render() {
    listEl.innerHTML = "";

    if (shopping.length === 0) {
        emptyEl.classList.remove("hidden");
        statsEl.classList.add("hidden");
        return;
    }

    emptyEl.classList.add("hidden");
    statsEl.classList.remove("hidden");

    // Сортировка: сначала невыполненные, потом выполненные
    const sorted = [
        ...shopping.filter(p => !p.bought),
        ...shopping.filter(p => p.bought),
    ];

    sorted.forEach(product => {
        const li = document.createElement("li");
        li.className = "shopping-item" + (product.bought ? " bought" : "");
        li.dataset.id = product.id;

        li.innerHTML = `
            <div class="checkbox">${product.bought ? "✓" : ""}</div>
            <span class="item-name"></span>
            <button class="btn-delete" type="button" aria-label="Удалить">✕</button>
        `;

        // Безопасно вставляем имя (защита от XSS)
        li.querySelector(".item-name").textContent = product.name;

        // Тап по строке — toggle
        li.addEventListener("click", e => {
            if (e.target.closest(".btn-delete")) return;
            toggleProduct(product.id);
        });

        // Удаление
        li.querySelector(".btn-delete").addEventListener("click", e => {
            e.stopPropagation();
            deleteProduct(product.id);
        });

        listEl.appendChild(li);
    });

    const remaining = shopping.filter(p => !p.bought).length;
    const bought = shopping.filter(p => p.bought).length;
    statRemainingEl.textContent = remaining;
    statBoughtEl.textContent = bought;
}

// ============================================================
// ⚡ Действия
// ============================================================

async function addProduct(name) {
    name = name.trim();
    if (!name) return;

    // Оптимистичное обновление
    const tempId = "tmp-" + Date.now();
    const optimistic = { id: tempId, name, bought: false };
    shopping.push(optimistic);
    render();

    const result = await syncWithServer("add", { name });
    if (result?.product) {
        // Заменяем tempId на настоящий id от сервера
        const idx = shopping.findIndex(p => p.id === tempId);
        if (idx !== -1) shopping[idx] = result.product;
        render();
    } else {
        // Откат при ошибке
        shopping = shopping.filter(p => p.id !== tempId);
        render();
    }
}

async function toggleProduct(id) {
    const product = shopping.find(p => p.id === id);
    if (!product) return;

    // Оптимистично
    product.bought = !product.bought;
    render();

    const result = await syncWithServer("toggle", { id });
    if (!result) {
        // Откат
        product.bought = !product.bought;
        render();
    } else if (result.product) {
        Object.assign(product, result.product);
        render();
    }
}

async function deleteProduct(id) {
    const backup = [...shopping];
    shopping = shopping.filter(p => p.id !== id);
    render();

    const result = await syncWithServer("delete", { id });
    if (!result) {
        shopping = backup;
        render();
    }
}

async function clearBought() {
    const boughtCount = shopping.filter(p => p.bought).length;
    if (boughtCount === 0) return;

    if (!confirm(`Убрать ${boughtCount} купленных товаров?`)) return;

    const backup = [...shopping];
    shopping = shopping.filter(p => !p.bought);
    render();

    const result = await syncWithServer("clear_bought", {});
    if (!result) {
        shopping = backup;
        render();
    }
}

// ============================================================
// 🎯 События
// ============================================================

document.getElementById("add-form").addEventListener("submit", e => {
    e.preventDefault();
    const input = document.getElementById("product-input");
    addProduct(input.value);
    input.value = "";
    input.focus();
});

document.getElementById("btn-clear-bought").addEventListener("click", clearBought);

// Haptic feedback при клике (вибрация на мобильных)
if (tg?.HapticFeedback) {
    document.addEventListener("click", e => {
        if (e.target.closest("button, .shopping-item")) {
            tg.HapticFeedback.impactOccurred("light");
        }
    });
}

// ============================================================
// 🚀 Запуск
// ============================================================

loadShopping();
