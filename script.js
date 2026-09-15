// ================================================================
// 在庫管理アプリ フロントエンド
// 修正版：GASへの通信を「フォームPOST + hidden iframe + postMessage」で実施
// CORS / JSONP に依存しません。
// ================================================================

// ★ここだけ、現在のGAS Webアプリ /exec URLに変更してください。
const GAS_URL = 'https://script.google.com/macros/s/AKfycby1LWZNRk293NIINd-VkQ7S9JgUZ5lhsxSOguAHCCCWzlHi8zfvUdebUDECULJJJOpu/exec';

const CACHE_TTL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;

let currentUser = null;
let sessionToken = '';
let items = [];
let selectedStockItem = null;
let activeInventory = null;
let inventoryFilter = 'unchecked';
let orderContext = null;

const pendingRequests = new Map();
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------
// GAS通信
// ---------------------------------------------------------------
function isAllowedGasOrigin(origin) {
  return origin === 'https://script.google.com' ||
         origin === 'https://script.googleusercontent.com';
}

window.addEventListener('message', (event) => {
  if (!isAllowedGasOrigin(event.origin)) return;

  const data = event.data;
  if (!data || data.source !== 'inventory-gas-bridge' || !data.requestId) return;

  const pending = pendingRequests.get(data.requestId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingRequests.delete(data.requestId);

  if (pending.showLoader) $('loader').style.display = 'none';

  if (!data.result) {
    pending.reject(new Error('GASから空の応答が返りました。'));
    return;
  }

  if (data.result.status === 'error') {
    pending.reject(new Error(data.result.message || '処理に失敗しました。'));
    return;
  }

  pending.resolve(data.result);
});

function callApi(action, payload = {}, options = {}) {
  if (!GAS_URL || GAS_URL.includes('PASTE_YOUR')) {
    return Promise.reject(
      new Error('script.js の GAS_URL を現在のGAS WebアプリURLへ変更してください。')
    );
  }

  const showLoader = options.showLoader !== false;
  if (showLoader) $('loader').style.display = 'flex';

  return new Promise((resolve, reject) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = GAS_URL;
    form.target = 'gas-bridge-frame';
    form.style.display = 'none';

    const addField = (name, value) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    };

    addField('requestId', requestId);
    addField('action', action);
    addField('payload', JSON.stringify(payload || {}));
    addField('token', sessionToken || '');

    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      if (showLoader) $('loader').style.display = 'none';
      reject(new Error('GASからの応答がタイムアウトしました。'));
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(requestId, {
      resolve,
      reject,
      timer,
      showLoader
    });

    document.body.appendChild(form);
    form.submit();
    setTimeout(() => form.remove(), 1000);
  });
}

// ---------------------------------------------------------------
// 共通UI
// ---------------------------------------------------------------
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(el => el.style.display = 'none');
  $(screenId).style.display = screenId === 'login-screen' ? 'flex' : 'block';
}

function showAppContent(screenId) {
  document.querySelectorAll('.app-screen').forEach(el => el.style.display = 'none');
  $(screenId).style.display = 'block';
  hideFeedback();

  if (screenId === 'order-history-screen') loadOrderHistory();
  if (screenId === 'inventory-screen') loadActiveInventory();
}

function showFeedback(message, type = 'success') {
  const box = $('feedback-message');
  box.textContent = message;
  box.className = type;
  box.style.display = 'block';
}

function hideFeedback() {
  $('feedback-message').style.display = 'none';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

// ---------------------------------------------------------------
// 認証
// ---------------------------------------------------------------
async function handleLogin() {
  const loginId = $('login-id').value.trim();
  $('login-error').textContent = '';

  if (!loginId) {
    $('login-error').textContent = 'ログインIDを入力してください。';
    return;
  }

  try {
    const result = await callApi('login', { loginId });

    currentUser = result.data.user;
    sessionToken = result.data.token;

    sessionStorage.setItem('inventory_user', JSON.stringify(currentUser));
    sessionStorage.setItem('inventory_token', sessionToken);

    await setupMainApp();
  } catch (e) {
    $('login-error').textContent = e.message;
  }
}

function handleLogout() {
  currentUser = null;
  sessionToken = '';
  sessionStorage.removeItem('inventory_user');
  sessionStorage.removeItem('inventory_token');
  localStorage.removeItem('inventory_items_v5');
  localStorage.removeItem('inventory_items_v5_ts');
  location.reload();
}

async function setupMainApp() {
  $('user-info').textContent = `${currentUser.name} (${currentUser.role}) さん`;

  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = currentUser.role === '管理者' ? 'block' : 'none';
  });

  showScreen('main-app');
  showAppContent('item-list-screen');

  try {
    await loadItems(false);
    renderItemList();
  } catch (e) {
    showFeedback(e.message, 'error');
  }
}

// ---------------------------------------------------------------
// 物品一覧
// ---------------------------------------------------------------
async function loadItems(force = false) {
  const cacheKey = 'inventory_items_v5';
  const cacheTsKey = 'inventory_items_v5_ts';

  if (!force) {
    try {
      const raw = localStorage.getItem(cacheKey);
      const ts = Number(localStorage.getItem(cacheTsKey) || 0);

      if (raw && Date.now() - ts < CACHE_TTL_MS) {
        items = JSON.parse(raw);
        return;
      }
    } catch (_) {}
  }

  const result = await callApi('get_item_list', { forceRefresh: force });
  items = result.data || [];

  try {
    localStorage.setItem(cacheKey, JSON.stringify(items));
    localStorage.setItem(cacheTsKey, String(Date.now()));
  } catch (_) {}
}

function renderItemList() {
  const query = $('item-search').value.trim().toLowerCase();
  const tbody = $('item-list-body');

  const filtered = items.filter(item =>
    `${item.itemName || ''} ${item.model || ''}`.toLowerCase().includes(query)
  );

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="6">該当する物品がありません。</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(item => {
    const low = Number(item.stock || 0) < Number(item.reorderPoint || 0);

    return `
      <tr class="${low ? 'low-stock-row' : ''}">
        <td>${escapeHtml(item.itemName)}</td>
        <td>${escapeHtml(item.model)}</td>
        <td>${Number(item.stock || 0)}</td>
        <td>${Number(item.reorderPoint || 0)}</td>
        <td>${Number(item.orderedQuantity || 0)}</td>
        <td>
          <button class="open-order-btn" data-ref="${escapeHtml(item.itemRef)}">
            発注カードを開く
          </button>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.open-order-btn').forEach(btn => {
    btn.addEventListener('click', () => openOrderCard(btn.dataset.ref));
  });
}

// ---------------------------------------------------------------
// 入出庫
// ---------------------------------------------------------------
function renderStockSearchResults() {
  const query = $('stock-item-search').value.trim().toLowerCase();
  const box = $('stock-search-results');

  selectedStockItem = null;
  $('selected-stock-item').style.display = 'none';

  if (!query) {
    box.innerHTML = '';
    box.style.display = 'none';
    return;
  }

  const matches = items.filter(item =>
    `${item.itemName || ''} ${item.model || ''}`.toLowerCase().includes(query)
  ).slice(0, 20);

  if (!matches.length) {
    box.innerHTML = '<div class="small-note" style="padding:10px">該当する物品がありません。</div>';
    box.style.display = 'block';
    return;
  }

  box.innerHTML = matches.map(item => `
    <button class="search-result-item" data-ref="${escapeHtml(item.itemRef)}">
      <strong>${escapeHtml(item.itemName)}</strong>
      ${item.model ? ` / ${escapeHtml(item.model)}` : ''}
      <span class="small-note">　現在庫：${Number(item.stock || 0)}</span>
    </button>
  `).join('');

  box.style.display = 'block';

  box.querySelectorAll('.search-result-item').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedStockItem = items.find(x => x.itemRef === btn.dataset.ref) || null;
      if (!selectedStockItem) return;

      $('selected-stock-item').innerHTML = `
        <strong>${escapeHtml(selectedStockItem.itemName)}</strong>
        ${selectedStockItem.model ? ` / ${escapeHtml(selectedStockItem.model)}` : ''}
        <br><span class="small-note">現在庫：${Number(selectedStockItem.stock || 0)}</span>`;

      $('selected-stock-item').style.display = 'block';
      $('stock-search-results').style.display = 'none';
      $('stock-item-search').value =
        `${selectedStockItem.itemName}${selectedStockItem.model ? ' / ' + selectedStockItem.model : ''}`;
    });
  });
}

async function handleStockUpdate(type) {
  if (!selectedStockItem) {
    showFeedback('物品を選択してください。', 'error');
    return;
  }

  const quantity = Number($('stock-quantity').value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    showFeedback('数量を正しく入力してください。', 'error');
    return;
  }

  try {
    const result = await callApi('stock_update', {
      itemRef: selectedStockItem.itemRef,
      itemName: selectedStockItem.itemName,
      model: selectedStockItem.model || '',
      type,
      quantity
    });

    showFeedback(result.message || `${type}が完了しました。`, 'success');

    await loadItems(true);
    renderItemList();

    selectedStockItem =
      items.find(x => x.itemRef === selectedStockItem.itemRef) || null;

    $('stock-quantity').value = '1';

    if (result.orderRequired && result.orderPreview) {
      showFeedback(
        '在庫を更新しました。発注点を下回ったため発注カードを開きます。',
        'info'
      );
      showOrderModal(result.orderPreview);
    }
  } catch (e) {
    showFeedback(e.message, 'error');
  }
}

// ---------------------------------------------------------------
// 発注
// ---------------------------------------------------------------
async function openOrderCard(itemRef) {
  const item = items.find(x => x.itemRef === itemRef);
  if (!item) {
    showFeedback('物品が見つかりません。', 'error');
    return;
  }

  try {
    const result = await callApi('get_order_card', {
      itemRef,
      itemName: item.itemName,
      model: item.model || ''
    });

    showOrderModal(result.data);
  } catch (e) {
    showFeedback(e.message, 'error');
  }
}

function showOrderModal(preview) {
  orderContext = {
    itemRef: preview.itemRef,
    itemName: preview.itemName,
    model: preview.model || ''
  };

  $('order-item-summary').innerHTML = `
    <strong>${escapeHtml(preview.itemName)}</strong>
    ${preview.model ? ` / ${escapeHtml(preview.model)}` : ''}
    <br><span class="small-note">
      現在庫：${Number(preview.stock || 0)}
      / 発注点：${Number(preview.reorderPoint || 0)}
      / 定数在庫：${Number(preview.parLevel || 0)}
      / 発注中：${Number(preview.orderedQuantity || 0)}
    </span>`;

  $('order-to').value = preview.to || '';
  $('order-subject').value = preview.subject || '';
  $('order-quantity').value = Number(preview.quantity || 1);
  $('order-body').value = preview.body || '';

  $('order-modal').style.display = 'flex';
}

async function refreshOrderPreviewForQuantity() {
  if (!orderContext) return;

  const quantity = Number($('order-quantity').value);
  if (!Number.isFinite(quantity) || quantity <= 0) return;

  try {
    const result = await callApi(
      'get_order_card',
      { ...orderContext, requestedQuantity: quantity },
      { showLoader: false }
    );

    $('order-subject').value = result.data.subject || '';
    $('order-body').value = result.data.body || '';
  } catch (_) {}
}

async function sendOrder() {
  if (!orderContext) return;

  const quantity = Number($('order-quantity').value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    showFeedback('発注数量を正しく入力してください。', 'error');
    return;
  }

  if (!confirm(`${quantity}個を発注します。よろしいですか？`)) return;

  try {
    const result = await callApi('send_order', {
      ...orderContext,
      quantity
    });

    $('order-modal').style.display = 'none';
    orderContext = null;

    showFeedback(result.message || '発注メールを送信しました。', 'success');

    await loadItems(true);
    renderItemList();
  } catch (e) {
    showFeedback(e.message, 'error');
  }
}

// ---------------------------------------------------------------
// 発注履歴
// ---------------------------------------------------------------
async function loadOrderHistory() {
  const box = $('order-history-list');
  box.innerHTML = '<p>読み込み中...</p>';

  try {
    const result = await callApi('get_order_history');
    const rows = result.data || [];

    if (!rows.length) {
      box.innerHTML = '<p>発注履歴はありません。</p>';
      return;
    }

    box.innerHTML = rows.map(row => `
      <div class="order-history-card">
        <strong>${escapeHtml(row.itemName)}</strong>
        ${row.model ? ` / ${escapeHtml(row.model)}` : ''}
        <div class="order-history-meta">
          ${escapeHtml(row.orderDate)}　
          ${Number(row.quantity || 0)}個　
          ${escapeHtml(row.status)}
        </div>
        ${row.status === '注文済み'
          ? `<button class="cancel-order-btn danger-btn" data-history="${row.historyId}">キャンセル</button>`
          : ''}
      </div>
    `).join('');

    box.querySelectorAll('.cancel-order-btn').forEach(btn => {
      btn.addEventListener('click', () =>
        cancelOrder(Number(btn.dataset.history))
      );
    });
  } catch (e) {
    box.innerHTML = `<p class="error-message">${escapeHtml(e.message)}</p>`;
  }
}

async function cancelOrder(historyId) {
  if (!confirm('この発注をキャンセルし、キャンセルメールを送信しますか？')) return;

  try {
    const result = await callApi('cancel_order', { historyId });

    showFeedback(result.message || 'キャンセルしました。', 'success');

    await loadOrderHistory();
    await loadItems(true);
    renderItemList();
  } catch (e) {
    showFeedback(e.message, 'error');
  }
}

// ---------------------------------------------------------------
// 棚卸し
// ---------------------------------------------------------------
async function loadActiveInventory() {
  try {
    const result = await callApi('get_active_inventory');
    activeInventory = result.data || null;

    if (!activeInventory) {
      $('inventory-no-session').style.display = 'block';
      $('inventory-active').style.display = 'none';
      return;
    }

    $('inventory-no-session').style.display = 'none';
    $('inventory-active').style.display = 'block';
    renderInventory();
  } catch (e) {
    showFeedback(e.message, 'error');
  }
}

async function startInventory() {
  if (!confirm('現在のシステム在庫を基準に棚卸しを開始します。よろしいですか？')) return;

  try {
    const result = await callApi('start_inventory');

    activeInventory = result.data;
    inventoryFilter = 'unchecked';

    $('inventory-no-session').style.display = 'none';
    $('inventory-active').style.display = 'block';

    renderInventory();

    showFeedback(
      '棚卸しを開始しました。ブラウザを閉じても続きから再開できます。',
      'success'
    );
  } catch (e) {
    showFeedback(e.message, 'error');
  }
}

function renderInventory() {
  if (!activeInventory) return;

  const all = activeInventory.items || [];
  const checked = all.filter(x => x.checked).length;
  const diff = all.filter(x => x.checked && Number(x.difference || 0) !== 0).length;
  const percent = all.length ? Math.round((checked / all.length) * 100) : 0;

  $('inventory-progress-text').textContent =
    `${checked} / ${all.length}（${percent}%）`;

  $('inventory-diff-text').textContent = `差異 ${diff}件`;
  $('inventory-progress-bar').style.width = `${percent}%`;

  const query = $('inventory-search').value.trim().toLowerCase();

  let visible = all.filter(item =>
    `${item.itemName || ''} ${item.model || ''}`.toLowerCase().includes(query)
  );

  if (inventoryFilter === 'unchecked') {
    visible = visible.filter(x => !x.checked);
  } else if (inventoryFilter === 'diff') {
    visible = visible.filter(x => x.checked && Number(x.difference || 0) !== 0);
  }

  if (!visible.length) {
    $('inventory-list').innerHTML =
      '<div class="panel">該当する物品はありません。</div>';
    return;
  }

  $('inventory-list').innerHTML = visible.map(item => `
    <div class="inventory-card ${item.checked ? 'checked' : ''} ${
      item.checked && Number(item.difference || 0) !== 0 ? 'diff' : ''
    }">
      <div class="inventory-card-title">
        <div>
          <strong>${escapeHtml(item.itemName)}</strong>
          ${item.model ? ` / ${escapeHtml(item.model)}` : ''}
        </div>
        <div class="small-note">
          システム在庫：${Number(item.expectedStock || 0)}
          ${item.checked ? ` / 差異：${Number(item.difference || 0)}` : ''}
        </div>
      </div>

      <div class="inventory-input-row">
        <div>
          <label>実在庫</label>
          <input class="inventory-actual-input"
                 type="number"
                 min="0"
                 data-ref="${escapeHtml(item.itemRef)}"
                 value="${item.checked ? Number(item.actualStock || 0) : ''}">
        </div>

        <button class="save-inventory-btn"
                data-ref="${escapeHtml(item.itemRef)}">
          ${item.checked ? '更新' : '確定'}
        </button>
      </div>
    </div>
  `).join('');

  $('inventory-list').querySelectorAll('.save-inventory-btn').forEach(btn => {
    btn.addEventListener('click', () => saveInventoryItem(btn.dataset.ref));
  });
}

async function saveInventoryItem(itemRef) {
  const item = activeInventory.items.find(x => x.itemRef === itemRef);
  if (!item) return;

  const input = document.querySelector(
    `.inventory-actual-input[data-ref="${CSS.escape(itemRef)}"]`
  );

  const actualStock = Number(input?.value);
  if (!Number.isFinite(actualStock) || actualStock < 0) {
    showFeedback('実在庫を0以上の数値で入力してください。', 'error');
    return;
  }

  try {
    const result = await callApi('save_inventory_item', {
      sessionId: activeInventory.sessionId,
      itemRef,
      itemName: item.itemName,
      model: item.model || '',
      actualStock
    });

    Object.assign(item, result.data);
    renderInventory();
  } catch (e) {
    showFeedback(e.message, 'error');
  }
}

async function completeInventory() {
  if (!activeInventory) return;

  const remaining = activeInventory.items.filter(x => !x.checked).length;
  if (remaining > 0) {
    showFeedback(
      `未確認の物品が${remaining}件あります。すべて確認してから完了してください。`,
      'error'
    );
    return;
  }

  if (!confirm('棚卸し結果を現在庫へ反映して完了します。よろしいですか？')) return;

  try {
    const result = await callApi('complete_inventory', {
      sessionId: activeInventory.sessionId
    });

    showFeedback(result.message || '棚卸しを完了しました。', 'success');

    activeInventory = null;
    await loadItems(true);
    renderItemList();
    await loadActiveInventory();
  } catch (e) {
    showFeedback(e.message, 'error');
  }
}

// ---------------------------------------------------------------
// 物品登録
// ---------------------------------------------------------------
async function registerItem() {
  const payload = {
    itemName: $('reg-item-name').value.trim(),
    model: $('reg-model').value.trim(),
    stock: Number($('reg-stock').value || 0),
    reorderPoint: Number($('reg-reorder-point').value || 0),
    parLevel: Number($('reg-par-level').value || 0),
    price: Number($('reg-price').value || 0),
    supplierEmail: $('reg-supplier').value.trim()
  };

  if (!payload.itemName) {
    showFeedback('物品名は必須です。', 'error');
    return;
  }

  try {
    const result = await callApi('item_register', payload);

    showFeedback(result.message || '登録しました。', 'success');

    $('reg-item-name').value = '';
    $('reg-model').value = '';
    $('reg-stock').value = '0';
    $('reg-reorder-point').value = '0';
    $('reg-par-level').value = '0';
    $('reg-price').value = '0';
    $('reg-supplier').value = '';

    await loadItems(true);
    renderItemList();
  } catch (e) {
    showFeedback(e.message, 'error');
  }
}

// ---------------------------------------------------------------
// イベント
// ---------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  $('login-btn').addEventListener('click', handleLogin);
  $('login-id').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });

  $('logout-btn').addEventListener('click', handleLogout);

  $('main-menu').addEventListener('click', e => {
    const btn = e.target.closest('button[data-screen]');
    if (btn) showAppContent(btn.dataset.screen);
  });

  $('item-search').addEventListener('input', renderItemList);

  $('refresh-list-btn').addEventListener('click', async () => {
    try {
      await loadItems(true);
      renderItemList();
      showFeedback('物品一覧を更新しました。', 'success');
    } catch (e) {
      showFeedback(e.message, 'error');
    }
  });

  $('stock-item-search').addEventListener('input', renderStockSearchResults);

  $('stock-in-btn').addEventListener('click', () => handleStockUpdate('入庫'));
  $('stock-out-btn').addEventListener('click', () => handleStockUpdate('出庫'));

  $('close-order-modal').addEventListener('click', () => {
    $('order-modal').style.display = 'none';
    orderContext = null;
  });

  $('order-quantity').addEventListener('change', refreshOrderPreviewForQuantity);
  $('send-order-btn').addEventListener('click', sendOrder);

  $('refresh-order-history-btn').addEventListener('click', loadOrderHistory);

  $('start-inventory-btn').addEventListener('click', startInventory);
  $('refresh-inventory-btn').addEventListener('click', loadActiveInventory);
  $('inventory-search').addEventListener('input', renderInventory);

  $('filter-unchecked-btn').addEventListener('click', () => {
    inventoryFilter = 'unchecked';
    renderInventory();
  });

  $('filter-diff-btn').addEventListener('click', () => {
    inventoryFilter = 'diff';
    renderInventory();
  });

  $('filter-all-btn').addEventListener('click', () => {
    inventoryFilter = 'all';
    renderInventory();
  });

  $('complete-inventory-btn').addEventListener('click', completeInventory);
  $('register-item-btn').addEventListener('click', registerItem);

  const savedUser = sessionStorage.getItem('inventory_user');
  const savedToken = sessionStorage.getItem('inventory_token');

  if (savedUser && savedToken) {
    try {
      currentUser = JSON.parse(savedUser);
      sessionToken = savedToken;
      setupMainApp();
    } catch (_) {
      handleLogout();
    }
  } else {
    showScreen('login-screen');
  }
});
