/**
 * =================================================================
 * 在庫管理アプリ - バックエンド (Google Apps Script) - 完成版
 * =================================================================
 * 最終更新: 2025-09-08
 * 変更要点:
 * - doPostの最初にデバッグ用のログを追加。リクエストが届いているかを確認。
 * =================================================================
 */

/** ▼▼ 設定 ▼▼ **/

// 使用するスプレッドシート
const SPREADSHEET_ID = '10llRezExCXTM9XpXCKP3vp3tbmmTO3Q_Xrgm2n5jsH8';
const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

// シート名
const SHEET_USERS         = 'ユーザー管理';
const SHEET_ITEM_MASTER   = '物品マスター';
const SHEET_HISTORY       = '入出庫履歴';
const SHEET_SETTINGS      = '設定';
const SHEET_DEPARTMENTS   = '部署マスター';
const SHEET_SUPPLIERS     = '発注先マスター';
const SHEET_ORDER_LOG     = '発注・キャンセル履歴';

// CORS: 許可するオリジン（'*'は全て許可。本番環境ではフロントエンドのURLに限定推奨）
// 例）'https://satoshi-13.github.io'
const ALLOWED_ORIGIN = '*';

// 権限ロール
const ROLES = {
  ADMIN: '管理者',
  USER: '使用者',
  ANY: '誰でも' // ログインさえしていればOK
};

// カラム定義（1始まり）
const COL_USERS = {
  EMAIL: 1, NAME: 2, HOSPITAL: 3, DEPARTMENT: 4, ROLE: 5, LOGIN_ID: 6, PHS: 7
};
const COL_INVENTORY = {
  QR_ID: 1, BARCODE: 2, ITEM_NAME: 3, MODEL: 4, STOCK: 5, REORDER_POINT: 6,
  SUPPLIER_EMAIL: 7, PRICE: 8, PAR_LEVEL: 9, ORDERED_QUANTITY: 10, IS_DELETED: 11
};
const COL_HISTORY = {
  TIMESTAMP: 1, QR_ID: 2, TYPE: 3, QUANTITY: 4, USER_EMAIL: 5, DEPARTMENT: 6,
  PHS: 7, ORDER_STATUS: 8, ORDER_MAIL_ID: 9
};
const COL_SUPPLIERS = { EMAIL: 1, COMPANY_NAME: 2, CONTACT_NAME: 3 };
const COL_ORDER_LOG = { TIMESTAMP: 1, TYPE: 2, ITEM_NAME: 3, MODEL: 4, QUANTITY: 5, USER: 6, MAIL_ID: 7 };

/** ▲▲ 設定ここまで ▲▲ **/


/* -------------------------------------------------------------
 * Web エンドポイント
 * ----------------------------------------------------------- */

/**
 * GETリクエストに対する応答。バックエンドの稼働状況を示すHTMLを返す。
 * @param {object} e - Google Apps Scriptのイベントオブジェクト
 * @returns {HtmlOutput} HTMLページ
 */
function doGet(e) {
  const html = `
<html><head><meta charset="utf-8"><title>在庫管理アプリ バックエンド</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f4f7f9}
.card{padding:24px 32px;background:#fff;border-radius:10px;box-shadow:0 6px 18px rgba(0,0,0,.08);text-align:center}
h1{margin:0 0 8px;color:#1a73e8}p{margin:0;color:#3c4043}
</style></head>
<body><div class="card"><h1>🚀 Backend is running</h1><p>Apps Script endpoint is healthy.</p></div></body></html>`;
  return HtmlService.createHtmlOutput(html).setTitle('在庫管理アプリ バックエンド');
}


/**
 * POSTリクエストを処理するメイン関数。アクションに応じて各処理を呼び出す。
 * @param {object} e - Google Apps Scriptのイベントオブジェクト
 * @returns {ContentService.TextOutput} JSON形式のレスポンス
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  // ▼▼▼ デバッグ用ログ ▼▼▼
  // このログが実行履歴に残るかを確認することで、リクエストがサーバーに届いているかを判断します。
  console.log('doPost function was called. Received data: ' + JSON.stringify(e.postData.contents));
  // ▲▲▲ デバッグ用ログ ▲▲▲
  try {
    lock.waitLock(15000); // 15秒待機

    const req = JSON.parse(e.postData.contents || '{}');
    const action = req.action;
    const payload = req.payload || {};
    let user;

    switch (action) {
      case 'login':
        return createJsonResponse(authenticateUser(payload));

      case 'get_departments':
      case 'get_supplier_emails':
      case 'get_item_name':
      case 'get_item_details':
        // これらの読み取り専用アクションは認証不要
        return createJsonResponse(handleAction(action, payload));

      case 'stock_update':
        // 認証は任意（その他ユーザーを許容するため）
        payload.user = payload.auth ? authenticateUser(payload.auth).data : null;
        if (payload.user && !payload.user.isAuthorized) throw new Error('認証情報が無効です。');
        return createJsonResponse(handleStockUpdate(payload));

      case 'get_item_list':
        user = getAuthenticatedUser(payload.auth, [ROLES.ADMIN, ROLES.USER]);
        return createJsonResponse(getItemList());

      case 'get_order_history':
        user = getAuthenticatedUser(payload.auth, [ROLES.ADMIN, ROLES.USER]);
        return createJsonResponse(getOrderHistory({ ...payload, user }));

      case 'send_order':
      case 'cancel_order':
      case 'copy_item_info':
      case 'create_equipment_document':
        user = getAuthenticatedUser(payload.auth, [ROLES.ADMIN, ROLES.USER]);
        return createJsonResponse(handleAction(action, { ...payload, user }));
        
      case 'item_register':
      case 'update_item':
      case 'delete_item':
        user = getAuthenticatedUser(payload.auth, [ROLES.ADMIN]);
        return createJsonResponse(handleAction(action, { ...payload, user }));

      default:
        return createJsonResponse({ status: 'error', message: '無効なアクションです。' });
    }
  } catch (err) {
    console.error(`Error in doPost: ${err.stack || err}`);
    return createJsonResponse({ status: 'error', message: err.message || String(err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/**
 * アクション名に基づいて適切な関数を呼び出すヘルパー
 * @param {string} action - アクション名
 * @param {object} payload - フロントエンドから送信されたデータ
 * @returns {object} 各関数の実行結果
 */
function handleAction(action, payload) {
    switch (action) {
        case 'get_departments':           return getDepartments();
        case 'get_supplier_emails':       return getSupplierEmails();
        case 'get_item_name':             return handleGetItemName(payload);
        case 'get_item_details':          return getItemDetails(payload);
        case 'send_order':                return sendOrderEmail(payload);
        case 'cancel_order':              return cancelOrder(payload);
        case 'copy_item_info':            return handleLinkNewQrCode(payload);
        case 'create_equipment_document': return createEquipmentDocument(payload);
        case 'item_register':             return handleItemRegistration(payload);
        case 'update_item':               return updateItem(payload);
        case 'delete_item':               return deleteItem(payload);
        default:                          throw new Error(`Unhandled action: ${action}`);
    }
}


/* -------------------------------------------------------------
 * 認証・共通
 * ----------------------------------------------------------- */

/**
 * ユーザー認証を行い、指定されたロールを持っているか検証する。
 * @param {object} authPayload - { loginId, email } を含む認証情報
 * @param {string[]} requiredRoles - 許可されるロールの配列 (例: [ROLES.ADMIN])
 * @returns {object} 認証されたユーザー情報
 * @throws {Error} 認証失敗時または権限不足時
 */
function getAuthenticatedUser(authPayload, requiredRoles) {
  const userResult = authenticateUser(authPayload);
  if (userResult.status !== 'success' || !userResult.data.isAuthorized) {
    throw new Error('認証に失敗しました。');
  }
  const user = userResult.data;
  if (requiredRoles && !requiredRoles.includes(user.role)) {
    throw new Error('この操作を実行する権限がありません。');
  }
  return user;
}


/**
 * ユーザーのログインIDまたはメールアドレスを基に認証を行う。
 * @param {object} authPayload - { loginId, email } を含む認証情報
 * @returns {object} { status, data, message } を含む認証結果
 */
function authenticateUser(authPayload) {
  if (!authPayload || (!authPayload.loginId && !authPayload.email)) {
    return { status: 'error', data: { isAuthorized: false }, message: '認証情報がありません。' };
  }
  const sheet = ss.getSheetByName(SHEET_USERS);
  if (!sheet) {
    return { status: 'error', data: { isAuthorized: false }, message: 'ユーザー管理シートが見つかりません。' };
  }
  const last = sheet.getLastRow();
  if (last < 2) return { status: 'error', data: { isAuthorized: false }, message: 'ユーザーが登録されていません。' };

  const data = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  for (const row of data) {
    const loginIdMatch = authPayload.loginId && String(row[COL_USERS.LOGIN_ID - 1]) === String(authPayload.loginId);
    const emailMatch   = authPayload.email && row[COL_USERS.EMAIL - 1] === authPayload.email;
    if (loginIdMatch || emailMatch) {
      return {
        status: 'success',
        data: {
          isAuthorized: true,
          email: row[COL_USERS.EMAIL - 1],
          name: row[COL_USERS.NAME - 1],
          hospital: row[COL_USERS.HOSPITAL - 1],
          department: row[COL_USERS.DEPARTMENT - 1],
          role: row[COL_USERS.ROLE - 1],
          phs: row[COL_USERS.PHS - 1]
        }
      };
    }
  }
  return { status: 'error', data: { isAuthorized: false }, message: 'ログイン情報が見つかりません。' };
}

/* -------------------------------------------------------------
 * マスター取得系
 * ----------------------------------------------------------- */
function getDepartments() {
  const sheet = ss.getSheetByName(SHEET_DEPARTMENTS);
  if (!sheet) throw new Error('「部署マスター」シートが見つかりません。');
  const last = sheet.getLastRow();
  if (last < 2) return { status: 'success', data: [] };
  const list = sheet.getRange(2, 1, last - 1, 1).getValues()
    .map(r => r[0]).filter(v => v && String(v).trim() !== '');
  return { status: 'success', data: list };
}

function getSupplierEmails() {
  const sheet = ss.getSheetByName(SHEET_SUPPLIERS);
  if (!sheet) throw new Error('「発注先マスター」シートが見つかりません。');
  const last = sheet.getLastRow();
  if (last < 2) return { status: 'success', data: [] };
  const emails = sheet.getRange(2, 1, last - 1, 1).getValues()
    .map(r => r[0])
    .filter(v => typeof v === 'string' && v.trim() !== '');
  return { status: 'success', data: Array.from(new Set(emails)).sort() };
}

/* -------------------------------------------------------------
 * 物品取得
 * ----------------------------------------------------------- */
function handleGetItemName(payload) {
  const { code } = payload || {};
  if (!code) throw new Error('コードが指定されていません。');

  const sheet = ss.getSheetByName(SHEET_ITEM_MASTER);
  if (!sheet) throw new Error('物品マスターシートが見つかりません。');

  let rowIndex = findRow(sheet, code, COL_INVENTORY.QR_ID);
  if (rowIndex === -1) rowIndex = findRow(sheet, code, COL_INVENTORY.BARCODE);

  const itemName = (rowIndex !== -1)
    ? sheet.getRange(rowIndex, COL_INVENTORY.ITEM_NAME).getValue()
    : null;

  return { status: 'success', data: { itemName } };
}

function getItemDetails(payload) {
  const { code } = payload || {};
  if (!code) throw new Error('コードが指定されていません。');

  const sheet = ss.getSheetByName(SHEET_ITEM_MASTER);
  if (!sheet) throw new Error('物品マスターシートが見つかりません。');

  let rowIndex = findRow(sheet, code, COL_INVENTORY.BARCODE);
  if (rowIndex === -1) rowIndex = findRow(sheet, code, COL_INVENTORY.QR_ID);
  if (rowIndex === -1) throw new Error('対象の物品が見つかりません。');

  const item = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];

  // 納品日の探索（入庫の最新）
  const hSheet = ss.getSheetByName(SHEET_HISTORY);
  const hasHistory = hSheet.getLastRow() > 1;
  const history = hasHistory ? hSheet.getRange(2, 1, hSheet.getLastRow() - 1, hSheet.getLastColumn()).getValues() : [];

  let lastDeliveryDate = '不明';
  const qrIds = String(item[COL_INVENTORY.QR_ID - 1] || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const barcode = String(item[COL_INVENTORY.BARCODE - 1] || '');

  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i];
    const hQr  = String(row[COL_HISTORY.QR_ID - 1] || '');
    const typ  = row[COL_HISTORY.TYPE - 1];
    if (typ === '入庫' && (qrIds.includes(hQr) || barcode === hQr)) {
      lastDeliveryDate = Utilities.formatDate(new Date(row[COL_HISTORY.TIMESTAMP - 1]), 'Asia/Tokyo', 'yyyy/MM/dd');
      break;
    }
  }

  return {
    status: 'success',
    data: {
      itemName: item[COL_INVENTORY.ITEM_NAME - 1],
      lastPrice: item[COL_INVENTORY.PRICE - 1],
      lastDeliveryDate,
      barcode: code
    }
  };
}

/* -------------------------------------------------------------
 * 入出庫・棚卸し
 * ----------------------------------------------------------- */
function handleStockUpdate(payload) {
  const { qrId, type, quantity, user, department, phs, isCorrection } = payload || {};

  const iSheet = ss.getSheetByName(SHEET_ITEM_MASTER);
  const hSheet = ss.getSheetByName(SHEET_HISTORY);

  let rowIndex = findRow(iSheet, qrId, COL_INVENTORY.QR_ID);
  if (rowIndex === -1) rowIndex = findRow(iSheet, qrId, COL_INVENTORY.BARCODE);

  if (rowIndex === -1 && type === '入庫') return { status: 'unregistered_qr' };
  if (rowIndex === -1) throw new Error('対象の物品が見つかりません。');

  const row = iSheet.getRange(rowIndex, 1, 1, iSheet.getLastColumn()).getValues()[0];

  const currentStock = Number(row[COL_INVENTORY.STOCK - 1] || 0);
  let newStock;

  if (isCorrection) {
    newStock = Number(quantity);
  } else {
    const delta = (type === '入庫' ? 1 : -1) * Number(quantity);
    newStock = currentStock + delta;
  }

  if (newStock < 0) throw new Error('在庫数がマイナスになるため処理できません。');

  // 在庫更新
  iSheet.getRange(rowIndex, COL_INVENTORY.STOCK).setValue(newStock);

  // 入庫時は発注中数量を減算
  if (type === '入庫') {
    const orderedCell = iSheet.getRange(rowIndex, COL_INVENTORY.ORDERED_QUANTITY);
    const newOrdered = Math.max(0, Number(orderedCell.getValue() || 0) - Number(quantity));
    orderedCell.setValue(newOrdered);
  }

  // 履歴追加
  const email = user ? user.email : 'その他';
  const dept  = user ? (department || user.department || '') : (department || '');
  const phsNo = user ? (phs || user.phs || '') : (phs || '');
  hSheet.appendRow([new Date(), qrId, type, quantity, email, dept, phsNo, '', '']);
  const historyId = hSheet.getLastRow();

  // 発注点チェック（出庫/棚卸修正で下回った場合）
  const reorderPoint = Number(row[COL_INVENTORY.REORDER_POINT - 1] || 0);
  if ((type === '出庫' || type === '棚卸修正') && newStock < reorderPoint) {
    const parLevel = Number(row[COL_INVENTORY.PAR_LEVEL - 1] || 0);
    const currentOrdered = Number(row[COL_INVENTORY.ORDERED_QUANTITY - 1] || 0);

    let orderQty = 0;
    if (parLevel > 0 && parLevel > newStock) {
      orderQty = parLevel - newStock;
    } else if (reorderPoint > newStock) {
      orderQty = reorderPoint - newStock;
    }

    if (orderQty > 0) {
      return {
        status: 'success',
        message: '在庫を更新しました。発注が必要です。',
        orderRequired: true,
        mailPreview: createOrderPreview(row, orderQty, user || {name: '不明', email: '', department: '', hospital: ''}),
        historyId,
        outstandingOrder: { exists: currentOrdered > 0, quantity: currentOrdered }
      };
    }
  }

  return { status: 'success', message: '在庫を更新しました。' };
}

/* -------------------------------------------------------------
 * QR紐付け / 新規登録
 * ----------------------------------------------------------- */
function handleLinkNewQrCode(payload) {
  const { newQrId, sourceBarcode, user } = payload || {};
  const sheet = ss.getSheetByName(SHEET_ITEM_MASTER);

  const srcIndex = findRow(sheet, sourceBarcode, COL_INVENTORY.BARCODE);
  if (srcIndex === -1) throw new Error('コピー元の製品情報が見つかりません。');

  if (findRow(sheet, newQrId, COL_INVENTORY.QR_ID) !== -1) {
    throw new Error('このQRコードは既に使用されています。');
  }

  const qrCell = sheet.getRange(srcIndex, COL_INVENTORY.QR_ID);
  const existing = String(qrCell.getValue() || '').trim();
  qrCell.setValue(existing ? (existing + ',' + newQrId) : newQrId);

  const hSheet = ss.getSheetByName(SHEET_HISTORY);
  hSheet.appendRow([new Date(), newQrId, 'QRコード紐付け', 0,
    user && user.email ? user.email : '不明',
    user && user.department ? user.department : '',
    user && user.phs ? user.phs : '',
    '', ''
  ]);

  return { status: 'success', message: 'QRコードを既存の物品に紐付けました。' };
}

function handleItemRegistration(payload) {
  const { qrId, barcode, itemName, model, stock, reorderPoint, supplierEmail, price, user } = payload || {};

  if (!barcode || String(barcode).trim() === '') {
    throw new Error('製品バーコードは必須です。');
  }

  const sheet = ss.getSheetByName(SHEET_ITEM_MASTER);

  if (findRow(sheet, barcode, COL_INVENTORY.BARCODE) !== -1) {
    throw new Error('この製品バーコードは既に使用されています。');
  }
  if (qrId && String(qrId).trim() !== '' && findRow(sheet, qrId, COL_INVENTORY.QR_ID) !== -1) {
    throw new Error('この社内QRコードIDは既に使用されています。');
  }

  sheet.appendRow([
    qrId || '', barcode, itemName, model, Number(stock || 0),
    Number(reorderPoint || 0), supplierEmail, Number(price || 0), '', 0
  ]);

  const hSheet = ss.getSheetByName(SHEET_HISTORY);
  const logId = barcode;
  hSheet.appendRow([new Date(), logId, '新規登録', Number(stock || 0),
    user && user.email ? user.email : '不明',
    user && user.department ? user.department : '',
    user && user.phs ? user.phs : '',
    '', ''
  ]);

  return { status: 'success', message: `「${itemName}」を新規登録しました。` };
}

/* -------------------------------------------------------------
 * 発注履歴 / 発注 / キャンセル
 * ----------------------------------------------------------- */
function getOrderHistory(payload) {
  const { user } = payload || {};
  const hSheet = ss.getSheetByName(SHEET_HISTORY);
  const iSheet = ss.getSheetByName(SHEET_ITEM_MASTER);

  const hLast = hSheet.getLastRow();
  const iLast = iSheet.getLastRow();

  const history = hLast > 1 ? hSheet.getRange(2, 1, hLast - 1, hSheet.getLastColumn()).getValues() : [];
  const items   = iLast > 1 ? iSheet.getRange(2, 1, iLast - 1, iSheet.getLastColumn()).getValues() : [];

  const map = new Map();
  items.forEach(r => {
    const qrList = String(r[COL_INVENTORY.QR_ID - 1] || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    qrList.forEach(id => map.set(id, r));
    const b = r[COL_INVENTORY.BARCODE - 1];
    if (b) map.set(String(b).trim(), r);
  });

  let filtered = history.filter(r => ['注文済み', 'キャンセル済み'].includes(r[COL_HISTORY.ORDER_STATUS - 1]));
  if (user && user.role === '使用者') {
    filtered = filtered.filter(r => r[COL_HISTORY.USER_EMAIL - 1] === user.email);
  }

  // 履歴シート上の行番号 (= 2始まり) を historyId として返す
  const result = filtered.map((r, idx) => {
    const qr = String(r[COL_HISTORY.QR_ID - 1]).trim();
    const itemInfo = map.get(qr);
    // 元の行番号を探す
    const rowNum = history.indexOf(r) + 2;
    return {
      historyId: rowNum,
      mailId: r[COL_HISTORY.ORDER_MAIL_ID - 1],
      itemName: itemInfo ? itemInfo[COL_INVENTORY.ITEM_NAME - 1] : '不明な物品',
      orderDate: Utilities.formatDate(new Date(r[COL_HISTORY.TIMESTAMP - 1]), 'Asia/Tokyo', 'yyyy/MM/dd'),
      quantity: r[COL_HISTORY.QUANTITY - 1],
      status: r[COL_HISTORY.ORDER_STATUS - 1]
    };
  }).reverse();

  return { status: 'success', data: result };
}

function sendOrderEmail(payload) {
  const { to, subject, body, historyId, user, quantity } = payload || {};
  const hSheet = ss.getSheetByName(SHEET_HISTORY);
  const iSheet = ss.getSheetByName(SHEET_ITEM_MASTER);
  const oSheet = ss.getSheetByName(SHEET_ORDER_LOG);

  const qrId = hSheet.getRange(historyId, COL_HISTORY.QR_ID).getValue();
  const qty  = Number(quantity || 0);
  hSheet.getRange(historyId, COL_HISTORY.QUANTITY).setValue(qty);

  let rowIndex = findRow(iSheet, qrId, COL_INVENTORY.QR_ID);
  if (rowIndex === -1) rowIndex = findRow(iSheet, qrId, COL_INVENTORY.BARCODE);
  if (rowIndex === -1) throw new Error('発注対象の物品が物品マスターに見つかりません。');

  // 発注中数量を加算
  const orderedCell = iSheet.getRange(rowIndex, COL_INVENTORY.ORDERED_QUANTITY);
  orderedCell.setValue(Number(orderedCell.getValue() || 0) + qty);

  const item = iSheet.getRange(rowIndex, 1, 1, iSheet.getLastColumn()).getValues()[0];

  // メール送信（ドラフト→送信）
  const draft = GmailApp.createDraft(to, subject, body);
  const message = draft.send();
  const mailId = message.getId();

  // 転送（管理者）
  getAdminEmails().forEach(admin =>
    GmailApp.sendEmail(admin, `[転送：発注] ${subject}`, "", { htmlBody: body.replace(/\n/g, '<br>') })
  );

  // 履歴に反映
  hSheet.getRange(historyId, COL_HISTORY.ORDER_STATUS).setValue('注文済み');
  hSheet.getRange(historyId, COL_HISTORY.ORDER_MAIL_ID).setValue(mailId);

  // ログ
  oSheet.appendRow([new Date(), '発注', item[COL_INVENTORY.ITEM_NAME - 1], item[COL_INVENTORY.MODEL - 1], qty, user.name, mailId]);

  // キャンセルメール本文プレビューを返す
  return {
    status: 'success',
    message: '発注メールを送信しました。',
    mailId,
    cancelPreviewBody: createCancelEmailBody(historyId, user)
  };
}

function cancelOrder(payload) {
  const { mailId, historyId, user } = payload || {};
  const hSheet = ss.getSheetByName(SHEET_HISTORY);
  const iSheet = ss.getSheetByName(SHEET_ITEM_MASTER);
  const oSheet = ss.getSheetByName(SHEET_ORDER_LOG);

  const h = hSheet.getRange(historyId, 1, 1, hSheet.getLastColumn()).getValues()[0];
  const qrId = h[COL_HISTORY.QR_ID - 1];
  const qty  = Number(h[COL_HISTORY.QUANTITY - 1] || 0);

  let rowIndex = findRow(iSheet, qrId, COL_INVENTORY.QR_ID);
  if (rowIndex === -1) rowIndex = findRow(iSheet, qrId, COL_INVENTORY.BARCODE);

  if (rowIndex !== -1) {
    const orderedCell = iSheet.getRange(rowIndex, COL_INVENTORY.ORDERED_QUANTITY);
    orderedCell.setValue(Math.max(0, Number(orderedCell.getValue() || 0) - qty));

    const item = iSheet.getRange(rowIndex, 1, 1, iSheet.getLastColumn()).getValues()[0];
    const supplierEmail = item[COL_INVENTORY.SUPPLIER_EMAIL - 1];
    const supplierInfo  = getSupplierInfo(supplierEmail);

    const body = createCancelEmailBody(historyId, user);
    const subject = `【注文キャンセルのお願い】${item[COL_INVENTORY.ITEM_NAME - 1]}`;

    // サプライヤへ通知
    GmailApp.sendEmail(supplierInfo.email, subject, body);

    // 管理者へ転送
    getAdminEmails().forEach(admin =>
      GmailApp.sendEmail(admin, `[転送：キャンセル] ${subject}`, "", { htmlBody: body.replace(/\n/g, '<br>') })
    );

    // ログ
    oSheet.appendRow([new Date(), 'キャンセル', item[COL_INVENTORY.ITEM_NAME - 1], item[COL_INVENTORY.MODEL - 1], qty, user.name, mailId]);
  }

  hSheet.getRange(historyId, COL_HISTORY.ORDER_STATUS).setValue('キャンセル済み');
  return { status: 'success', message: 'キャンセルメールを送信しました。' };
}

/* -------------------------------------------------------------
 * 依頼文書生成
 * ----------------------------------------------------------- */
function createEquipmentDocument(payload) {
  const { itemName, lastPrice, lastDeliveryDate, revisedPrice, user } = payload || {};
  if (!itemName || !revisedPrice) throw new Error('必要な情報が不足しています。');

  const sheet = ss.getSheetByName(SHEET_SETTINGS);
  const tpl = sheet.getRange('B4').getValue();
  if (!tpl) throw new Error('設備機器依頼書テンプレートが設定シート(B4)にありません。');

  const body = String(tpl)
    .replace(/{{物品名}}/g, itemName)
    .replace(/{{前回購入価格}}/g, Number(lastPrice || 0).toLocaleString())
    .replace(/{{前回納品日}}/g, lastDeliveryDate || '不明')
    .replace(/{{改定後価格}}/g, Number(revisedPrice).toLocaleString())
    .replace(/{{病院名}}/g, user.hospital || '')
    .replace(/{{部署名}}/g, user.department || '')
    .replace(/{{依頼者名}}/g, user.name || '');

  return { status: 'success', data: { documentBody: body } };
}

/* -------------------------------------------------------------
 * 物品一覧 / 更新 / 削除
 * ----------------------------------------------------------- */
function getItemList() {
  const sheet = ss.getSheetByName(SHEET_ITEM_MASTER);
  if (!sheet) throw new Error('物品マスターシートが見つかりません。');
  const last = sheet.getLastRow();
  if (last < 2) return { status: 'success', data: [] };

  const data = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  const items = data
    .filter(r => !r[COL_INVENTORY.IS_DELETED - 1]) // is_deletedフラグがtrueのものを除外
    .map(r => ({
      qrId: r[COL_INVENTORY.QR_ID - 1],
      barcode: r[COL_INVENTORY.BARCODE - 1],
      itemName: r[COL_INVENTORY.ITEM_NAME - 1],
      model: r[COL_INVENTORY.MODEL - 1],
      stock: r[COL_INVENTORY.STOCK - 1],
      reorderPoint: r[COL_INVENTORY.REORDER_POINT - 1],
      supplierEmail: r[COL_INVENTORY.SUPPLIER_EMAIL - 1],
      price: r[COL_INVENTORY.PRICE - 1],
      parLevel: r[COL_INVENTORY.PAR_LEVEL - 1],
      orderedQuantity: r[COL_INVENTORY.ORDERED_QUANTITY - 1]
    }));
  return { status: 'success', data: items };
}


function updateItem(payload) {
  const { barcode, itemName, model, stock, reorderPoint, supplierEmail, price, parLevel, orderedQuantity } = payload;
  if (!barcode) throw new Error('更新対象のバーコードが指定されていません。');

  const sheet = ss.getSheetByName(SHEET_ITEM_MASTER);
  const rowIndex = findRow(sheet, barcode, COL_INVENTORY.BARCODE);
  if (rowIndex === -1) throw new Error(`バーコード '${barcode}' の物品が見つかりませんでした。`);

  // 値が提供されている場合のみ更新
  const updates = {
    [COL_INVENTORY.ITEM_NAME]: itemName,
    [COL_INVENTORY.MODEL]: model,
    [COL_INVENTORY.STOCK]: stock,
    [COL_INVENTORY.REORDER_POINT]: reorderPoint,
    [COL_INVENTORY.SUPPLIER_EMAIL]: supplierEmail,
    [COL_INVENTORY.PRICE]: price,
    [COL_INVENTORY.PAR_LEVEL]: parLevel,
    [COL_INVENTORY.ORDERED_QUANTITY]: orderedQuantity
  };

  for (const col in updates) {
    if (updates[col] !== undefined && updates[col] !== null) {
      sheet.getRange(rowIndex, Number(col)).setValue(updates[col]);
    }
  }
  
  // 履歴に追加
  const hSheet = ss.getSheetByName(SHEET_HISTORY);
  hSheet.appendRow([new Date(), barcode, '情報更新', 0, payload.user.email, payload.user.department, payload.user.phs, '', '']);

  return { status: 'success', message: `「${itemName}」の情報を更新しました。` };
}


function deleteItem(payload) {
  const { barcode, user } = payload;
  if (!barcode) throw new Error('削除対象のバーコードが指定されていません。');

  const sheet = ss.getSheetByName(SHEET_ITEM_MASTER);
  const rowIndex = findRow(sheet, barcode, COL_INVENTORY.BARCODE);
  if (rowIndex === -1) throw new Error(`バーコード '${barcode}' の物品が見つかりませんでした。`);

  sheet.getRange(rowIndex, COL_INVENTORY.IS_DELETED).setValue(true);
  
  const itemName = sheet.getRange(rowIndex, COL_INVENTORY.ITEM_NAME).getValue();

  // 履歴に追加
  const hSheet = ss.getSheetByName(SHEET_HISTORY);
  hSheet.appendRow([new Date(), barcode, '削除', 0, user.email, user.department, user.phs, '', '']);
  
  return { status: 'success', message: `物品「${itemName}」を削除しました。` };
}


/* -------------------------------------------------------------
 * ユーティリティ
 * ----------------------------------------------------------- */
function getAdminEmails() {
  const sheet = ss.getSheetByName(SHEET_USERS);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  return rows.filter(r => r[COL_USERS.ROLE - 1] === '管理者').map(r => r[COL_USERS.EMAIL - 1]);
}

function createCancelEmailBody(historyId, user) {
  const settings = ss.getSheetByName(SHEET_SETTINGS);
  const tpl = settings.getRange('B3').getValue();

  const hSheet = ss.getSheetByName(SHEET_HISTORY);
  const h = hSheet.getRange(historyId, 1, 1, hSheet.getLastColumn()).getValues()[0];
  const qrId = h[COL_HISTORY.QR_ID - 1];
  const qty  = Number(h[COL_HISTORY.QUANTITY - 1] || 0);

  const iSheet = ss.getSheetByName(SHEET_ITEM_MASTER);
  let rowIndex = findRow(iSheet, qrId, COL_INVENTORY.QR_ID);
  if (rowIndex === -1) rowIndex = findRow(iSheet, qrId, COL_INVENTORY.BARCODE);

  let itemName = '不明な物品';
  let model = '不明';
  let price = 0;
  let total = 0;

  if (rowIndex !== -1) {
    const item = iSheet.getRange(rowIndex, 1, 1, iSheet.getLastColumn()).getValues()[0];
    itemName = item[COL_INVENTORY.ITEM_NAME - 1];
    model    = item[COL_INVENTORY.MODEL - 1];
    price    = Number(item[COL_INVENTORY.PRICE - 1] || 0);
    total    = price * qty;
  }

  return String(tpl)
    .replace(/{{物品名}}/g, itemName)
    .replace(/{{型番}}/g, model)
    .replace(/{{数量}}/g, qty)
    .replace(/{{単価}}/g, price.toLocaleString() + '円')
    .replace(/{{合計金額}}/g, total.toLocaleString() + '円')
    .replace(/{{病院名}}/g, user.hospital || '')
    .replace(/{{部署名}}/g, user.department || '')
    .replace(/{{発注者名}}/g, user.name || '')
    .replace(/{{発注者メールアドレス}}/g, user.email || '');
}

function createOrderPreview(itemRow, quantity, user) {
  const settings = ss.getSheetByName(SHEET_SETTINGS);
  const subjectTpl = settings.getRange('B1').getValue();
  const bodyTpl    = settings.getRange('B2').getValue();

  const supplierEmail = itemRow[COL_INVENTORY.SUPPLIER_EMAIL - 1];
  const supplierInfo  = getSupplierInfo(supplierEmail);
  const itemName      = itemRow[COL_INVENTORY.ITEM_NAME - 1];
  const price         = Number(itemRow[COL_INVENTORY.PRICE - 1] || 0);

  const subject = String(subjectTpl)
    .replace(/{{物品名}}/g, itemName)
    .replace(/{{発注者名}}/g, (user && user.name) || '');

  const subtotal = price * Number(quantity || 0);

  const body = String(bodyTpl)
    .replace(/{{会社名}}/g, supplierInfo.companyName || 'ご担当者様')
    .replace(/{{担当者名}}/g, supplierInfo.contactName ? (supplierInfo.contactName + ' 様') : '')
    .replace(/{{物品名}}/g, itemName)
    .replace(/{{型番}}/g, itemRow[COL_INVENTORY.MODEL - 1] || '')
    .replace(/{{数量}}/g, quantity)
    .replace(/{{単価}}/g, price.toLocaleString() + '円')
    .replace(/{{小計}}/g, subtotal.toLocaleString() + '円')
    .replace(/{{合計金額}}/g, subtotal.toLocaleString() + '円')
    .replace(/{{病院名}}/g, (user && user.hospital) || '')
    .replace(/{{部署名}}/g, (user && user.department) || '')
    .replace(/{{発注者名}}/g, (user && user.name) || '')
    .replace(/{{発注者メールアドレス}}/g, (user && user.email) || '');

  return { to: supplierEmail, subject, body, quantity, price, subtotal };
}

function getSupplierInfo(email) {
  const sheet = ss.getSheetByName(SHEET_SUPPLIERS);
  if (!sheet) return { email: email, companyName: '', contactName: '' };

  const last = sheet.getLastRow();
  if (last < 2) return { email: email, companyName: '', contactName: '' };

  const data = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  const target = String(email || '').trim().toLowerCase();

  for (const r of data) {
    const e = String(r[COL_SUPPLIERS.EMAIL - 1] || '').trim().toLowerCase();
    if (e === target) {
      return {
        email: r[COL_SUPPLIERS.EMAIL - 1],
        companyName: r[COL_SUPPLIERS.COMPANY_NAME - 1],
        contactName: r[COL_SUPPLIERS.CONTACT_NAME - 1]
      };
    }
  }
  return { email: email, companyName: '', contactName: '' };
}

/* -------------------------------------------------------------
 * レスポンス & ヘルパー
 * ----------------------------------------------------------- */
function createJsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj || {}))
    .setMimeType(ContentService.MimeType.JSON)
    .setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
    .setHeader('Vary', 'Origin');
}

/**
 * columnIndex 列の表示値で value を検索し、見つかれば 1始まりの行番号を返す。
 * QR_ID 列は「カンマ区切りの複数ID」対応。
 */
function findRow(sheet, value, columnIndex) {
  if (!value && value !== 0) return -1;
  const last = sheet.getLastRow();
  if (last === 0) return -1;

  const displayValues = sheet.getRange(1, columnIndex, last).getDisplayValues();
  const search = String(value).trim();

  for (let i = 0; i < displayValues.length; i++) {
    const cell = String(displayValues[i][0] || '').trim();
    if (columnIndex === COL_INVENTORY.QR_ID) {
      const list = cell.split(',').map(s => s.trim()).filter(Boolean);
      if (list.includes(search)) return i + 1;
    } else {
      if (cell === search) return i + 1;
    }
  }
  return -1;
}

