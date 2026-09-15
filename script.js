// =================================================================
// == 設定項目
// =================================================================

// ▼▼▼▼▼【重要】▼▼▼▼▼
// あなたのGoogle Apps ScriptのウェブアプリURLをここに貼り付けてください
const GAS_URL = 'https://script.google.com/macros/s/AKfycbzNpKApggyznTBt82xFHqlgCHYMM8ZMyxS0hf5N8L3kLqGiw6aktyMu1k9Bt2XZBEFS4w/exec';
// ▲▲▲▲▲【重要】▲▲▲▲▲


// =================================================================
// == DOM要素の取得
// =================================================================
const loader = document.getElementById('loader');
const loginScreen = document.getElementById('login-screen');
const mainApp = document.getElementById('main-app');
const loginIdInput = document.getElementById('login-id');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const userInfoDiv = document.getElementById('user-info');
const logoutBtn = document.getElementById('logout-btn');
const mainMenu = document.getElementById('main-menu');
const feedbackMessage = document.getElementById('feedback-message');
const appContent = document.getElementById('app-content');
const itemListBody = document.getElementById('item-list-body');
const refreshListBtn = document.getElementById('refresh-list-btn');
// 入出庫フォーム
const stockQrInput = document.getElementById('stock-qr-id');
const stockQuantityInput = document.getElementById('stock-quantity');
const stockInBtn = document.getElementById('stock-in-btn');
const stockOutBtn = document.getElementById('stock-out-btn');
// QR紐付けフォーム
const linkNewQrInput = document.getElementById('link-new-qr');
const linkSourceBarcodeInpt = document.getElementById('link-source-barcode');
const linkQrBtn = document.getElementById('link-qr-btn');
// 物品登録フォーム
const regBarcode = document.getElementById('reg-barcode');
const regItemName = document.getElementById('reg-item-name');
const regModel = document.getElementById('reg-model');
const regStock = document.getElementById('reg-stock');
const regReorderPoint = document.getElementById('reg-reorder-point');
const regPrice = document.getElementById('reg-price');
const regSupplier = document.getElementById('reg-supplier');
const registerItemBtn = document.getElementById('register-item-btn');


// =================================================================
// == 状態管理
// =================================================================
let currentUser = null; // ログイン中のユーザー情報を保持

// =================================================================
// == API通信
// =================================================================
async function callApi(action, payload = {}) {
    loader.style.display = 'flex';
    hideFeedback();
    try {
        // ログイン情報(auth)をペイロードに自動で追加
        if (currentUser) {
            payload.auth = { email: currentUser.email };
        }

        const response = await fetch(GAS_URL, {
            method: 'POST',
            mode: 'cors',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action, payload })
        });
        if (!response.ok) throw new Error('ネットワークエラー');

        const result = await response.json();
        if (result.status === 'error') throw new Error(result.message);

        return result;
    } catch (error) {
        showFeedback(`エラー: ${error.message}`, 'error');
        throw error;
    } finally {
        loader.style.display = 'none';
    }
}

// =================================================================
// == UI操作 / 画面遷移
// =================================================================
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
    document.getElementById(screenId).style.display = 'block';
}

function showAppContent(contentId) {
    document.querySelectorAll('.app-screen').forEach(s => s.style.display = 'none');
    document.getElementById(contentId).style.display = 'block';
    hideFeedback(); // 画面切り替え時にフィードバックを消す
}

function showFeedback(message, type = 'success') {
    feedbackMessage.textContent = message;
    feedbackMessage.className = type; // 'success' or 'error'
    feedbackMessage.style.display = 'block';
}

function hideFeedback() {
    feedbackMessage.style.display = 'none';
}

function setupMainAppUI() {
    userInfoDiv.textContent = `${currentUser.name} (${currentUser.role}) さん`;
    showScreen('main-app');
    if (currentUser.role === '管理者') {
        document.querySelectorAll('.admin-only').forEach(el => {
            el.style.display = 'block';
        });
    }
    showAppContent('item-list-screen');
    loadItemList();
}

// =================================================================
// == 機能別関数
// =================================================================

// --- 認証 ---
async function handleLogin() {
    const loginId = loginIdInput.value.trim();
    if (!loginId) { loginError.textContent = 'ログインIDを入力してください。'; return; }
    loginError.textContent = '';
    try {
        const result = await callApi('login', { loginId });
        if (result.data.isAuthorized) {
            currentUser = result.data;
            sessionStorage.setItem('inventory_user', JSON.stringify(currentUser));
            setupMainAppUI();
        } else {
            throw new Error(result.message);
        }
    } catch (error) {
        loginError.textContent = error.message;
    }
}

function handleLogout() {
    currentUser = null;
    sessionStorage.removeItem('inventory_user');
    window.location.reload();
}

// --- 物品一覧 ---
async function loadItemList() {
    try {
        const result = await callApi('get_item_list');
        itemListBody.innerHTML = '';
        if (result.data.length === 0) {
            itemListBody.innerHTML = '<tr><td colspan="4">物品が登録されていません。</td></tr>';
            return;
        }
        result.data.forEach(item => {
            const row = `<tr>
                <td>${item.itemName || ''}</td>
                <td>${item.model || ''}</td>
                <td>${item.stock || 0}</td>
                <td>${item.reorderPoint || 0}</td>
            </tr>`;
            itemListBody.innerHTML += row;
        });
    } catch (error) { /* callApi内でエラー処理済み */ }
}

// --- 入出庫 ---
async function handleStockUpdate(type) {
    const qrId = stockQrInput.value.trim();
    const quantity = parseInt(stockQuantityInput.value, 10);
    if (!qrId) { showFeedback('QR/バーコードを入力してください。', 'error'); return; }
    if (isNaN(quantity) || quantity <= 0) { showFeedback('正しい数量を入力してください。', 'error'); return; }

    try {
        const result = await callApi('stock_update', { qrId, type, quantity });

        let message = result.message || `${type}処理が完了しました。`;
        if (result.orderRequired) {
            message += '【！】この物品は発注が必要です。';
        }
        showFeedback(message, 'success');

        stockQrInput.value = ''; // 入力欄をクリア
        stockQuantityInput.value = '1';
        stockQrInput.focus(); // 次のスキャンのためにフォーカス

    } catch (error) { /* callApi内でエラー処理済み */ }
}


// --- QR紐付け ---
async function handleLinkQr() {
    const newQrId = linkNewQrInput.value.trim();
    const sourceBarcode = linkSourceBarcodeInpt.value.trim();
    if (!newQrId || !sourceBarcode) {
        showFeedback('2つのコードを両方入力してください。', 'error');
        return;
    }
    try {
        const result = await callApi('copy_item_info', { newQrId, sourceBarcode });
        showFeedback(result.message, 'success');
        linkNewQrInput.value = '';
        linkSourceBarcodeInpt.value = '';
    } catch (error) { /* callApi内でエラー処理済み */ }
}


// --- 物品登録 ---
async function handleRegisterItem() {
    const payload = {
        barcode: regBarcode.value.trim(),
        itemName: regItemName.value.trim(),
        model: regModel.value.trim(),
        stock: parseInt(regStock.value, 10),
        reorderPoint: parseInt(regReorderPoint.value, 10),
        price: parseFloat(regPrice.value),
        supplierEmail: regSupplier.value.trim()
    };
    if (!payload.barcode) { showFeedback('製品バーコードは必須です。', 'error'); return; }

    try {
        const result = await callApi('item_register', payload);
        showFeedback(result.message, 'success');
        // フォームをクリア
        document.querySelector('#register-item-screen').querySelectorAll('input').forEach(input => input.value = '');
        regStock.value = 0; regReorderPoint.value = 0; regPrice.value = 0;
    } catch (error) { /* callApi内でエラー処理済み */ }
}


// =================================================================
// == イベントリスナーの設定
// =================================================================
document.addEventListener('DOMContentLoaded', () => {
    const storedUser = sessionStorage.getItem('inventory_user');
    if (storedUser) {
        currentUser = JSON.parse(storedUser);
        setupMainAppUI();
    } else {
        showScreen('login-screen');
    }
});

// --- 認証 ---
loginBtn.addEventListener('click', handleLogin);
loginIdInput.addEventListener('keypress', (e) => e.key === 'Enter' && handleLogin());
logoutBtn.addEventListener('click', handleLogout);

// --- ナビゲーション ---
mainMenu.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON' && e.target.dataset.screen) {
        showAppContent(e.target.dataset.screen);
    }
});

// --- 各機能の実行ボタン ---
refreshListBtn.addEventListener('click', loadItemList);
stockInBtn.addEventListener('click', () => handleStockUpdate('入庫'));
stockOutBtn.addEventListener('click', () => handleStockUpdate('出庫'));
linkQrBtn.addEventListener('click', handleLinkQr);
registerItemBtn.addEventListener('click', handleRegisterItem);

// ----------------------------------------------------
// ▼▼▼ 以下をscript.jsの末尾に貼り付け ▼▼▼
// ----------------------------------------------------
const testBtn = document.getElementById('test-btn');
testBtn.addEventListener('click', async () => {
  try {
    const result = await callApi('test_connection');
    if (result.status === 'success') {
      alert('バックエンドとの接続に成功しました！🎉');
    }
  } catch (error) {
    alert('テスト接続に失敗しました。コンソールを確認してください。');
  }
});
