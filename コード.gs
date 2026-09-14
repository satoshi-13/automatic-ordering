/** 在庫管理アプリ backend 2026-09 reviewed */
const SPREADSHEET_ID = '10llRezExCXTM9XpXCKP3vp3tbmmTO3Q_Xrgm2n5jsH8';
const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
const SHEET_USERS = 'ユーザー管理';
const SHEET_ITEM_MASTER = '物品マスター';
const SHEET_HISTORY = '入出庫履歴';
const SHEET_SETTINGS = '設定';
const SHEET_SUPPLIERS = '発注先マスター';
const SHEET_ORDER_LOG = '発注・キャンセル履歴';
const SHEET_INVENTORY = '棚卸しセッション';
const ROLES = { ADMIN: '管理者', USER: '使用者' };
const COL_USERS = { EMAIL:1, NAME:2, HOSPITAL:3, DEPARTMENT:4, ROLE:5, LOGIN_ID:6, PHS:7 };
const COL_INVENTORY = { QR_ID:1, BARCODE:2, ITEM_NAME:3, MODEL:4, STOCK:5, REORDER_POINT:6, SUPPLIER_EMAIL:7, PRICE:8, PAR_LEVEL:9, ORDERED_QUANTITY:10, IS_DELETED:11 };
const COL_HISTORY = { TIMESTAMP:1, ITEM_KEY:2, TYPE:3, QUANTITY:4, USER_EMAIL:5, DEPARTMENT:6, PHS:7, ORDER_STATUS:8, ORDER_MAIL_ID:9 };
const INV = { SESSION_ID:1, STATUS:2, USER_EMAIL:3, STARTED_AT:4, UPDATED_AT:5, COMPLETED_AT:6, ITEM_REF:7, ITEM_NAME:8, MODEL:9, EXPECTED_STOCK:10, ACTUAL_STOCK:11, DIFFERENCE:12, CHECKED_AT:13 };
function doGet() {
return HtmlService.createHtmlOutput('<h2>Backend is running</h2>');
}
function doPost(e) {
try {
const req = JSON.parse(e.postData.contents || '{}');
const action = req.action;
const payload = req.payload || {};
if (action === 'login') return jsonResponse(authUser(payload));
const user = getUser(payload.auth);
if (action === 'get_item_list') return jsonResponse(getItems(payload));
if (action === 'get_order_history') return jsonResponse(getOrders(user));
if (action === 'get_order_card') return jsonResponse(getOrderCard({ ...payload, user }));
if (action === 'get_active_inventory') return jsonResponse(getActiveInventory(user));
const lock = LockService.getScriptLock();
lock.waitLock(15000);
try {
if (action === 'stock_update') return jsonResponse(stock({ ...payload, user }));
if (action === 'send_order') return jsonResponse(sendOrder({ ...payload, user }));
if (action === 'cancel_order') return jsonResponse(cancelOrder({ ...payload, user }));
if (action === 'start_inventory') return jsonResponse(startInventory(user));
if (action === 'save_inventory_item') return jsonResponse(saveInventory({ ...payload, user }));
if (action === 'complete_inventory') return jsonResponse(completeInventory({ ...payload, user }));
if (action === 'item_register') {
if (user.role !== ROLES.ADMIN) throw new Error('管理者権限が必要です。');
return jsonResponse(registerItem({ ...payload, user }));
}
return jsonResponse({ status:'error', message:'無効なアクションです。' });
} finally {
try { lock.releaseLock(); } catch (_) {}
}
} catch (err) {
return jsonResponse({ status:'error', message: err.message || String(err) });
}
}
function authUser(auth) {
if (!auth || (!auth.loginId && !auth.email)) {
return { status:'error', data:{ isAuthorized:false }, message:'認証情報がありません。' };
}
const sh = ss.getSheetByName(SHEET_USERS);
const rows = sh && sh.getLastRow() > 1 ? sh.getRange(2,1,sh.getLastRow()-1,7).getValues() : [];
for (const r of rows) {
const loginMatch = auth.loginId && String(r[5]) === String(auth.loginId);
const emailMatch = auth.email && String(r[0]).toLowerCase() === String(auth.email).toLowerCase();
if (loginMatch || emailMatch) {
return { status:'success', data:{ isAuthorized:true, email:r[0], name:r[1], hospital:r[2], department:r[3], role:r[4], loginId:r[5], phs:r[6] } };
}
}
return { status:'error', data:{ isAuthorized:false }, message:'ログイン情報が見つかりません。' };
}
function getUser(auth) {
const r = authUser(auth);
if (r.status !== 'success' || !r.data.isAuthorized) throw new Error('認証に失敗しました。');
return r.data;
}
function getItems(payload) {
if (payload && payload.forceRefresh) clearItems();
return { status:'success', data:itemRecords() };
}
function itemRecords() {
const cache = CacheService.getScriptCache();
const hit = cache.get('items_v4');
if (hit) return JSON.parse(hit);
const sh = ss.getSheetByName(SHEET_ITEM_MASTER);
const last = sh.getLastRow();
if (last < 2) return [];
const rows = sh.getRange(2,1,last-1,Math.max(sh.getLastColumn(),11)).getValues();
const out = [];
rows.forEach((r,i) => {
if (r[COL_INVENTORY.IS_DELETED-1]) return;
out.push({
itemRef:'R:'+(i+2), itemName:r[COL_INVENTORY.ITEM_NAME-1] || '', model:r[COL_INVENTORY.MODEL-1] || '',
stock:Number(r[COL_INVENTORY.STOCK-1] || 0), reorderPoint:Number(r[COL_INVENTORY.REORDER_POINT-1] || 0),
supplierEmail:r[COL_INVENTORY.SUPPLIER_EMAIL-1] || '', price:Number(r[COL_INVENTORY.PRICE-1] || 0),
parLevel:Number(r[COL_INVENTORY.PAR_LEVEL-1] || 0), orderedQuantity:Number(r[COL_INVENTORY.ORDERED_QUANTITY-1] || 0)
});
});
cache.put('items_v4', JSON.stringify(out), 60);
return out;
}
function clearItems() {
const c = CacheService.getScriptCache();
c.remove('items_v3');
c.remove('items_v4');
}
function resolveRow(p) {
const sh = ss.getSheetByName(SHEET_ITEM_MASTER);
const ref = String(p.itemRef || '');
if (/^R:\d+$/.test(ref)) {
const row = Number(ref.slice(2));
if (row >= 2 && row <= sh.getLastRow()) {
const v = sh.getRange(row,1,1,Math.max(sh.getLastColumn(),11)).getValues()[0];
if (!v[COL_INVENTORY.IS_DELETED-1] && (!p.itemName || String(v[2]) === String(p.itemName)) && (!p.model || String(v[3]) === String(p.model))) return row;
}
}
const name = String(p.itemName || '');
const model = String(p.model || '');
if (!name || sh.getLastRow() < 2) return -1;
const rows = sh.getRange(2,1,sh.getLastRow()-1,Math.max(sh.getLastColumn(),11)).getValues();
for (let i=0;i<rows.length;i++) {
if (!rows[i][10] && String(rows[i][2]) === name && String(rows[i][3]) === model) return i+2;
}
return -1;
}
function buildLegacyKeyMap(masterRows) {
const map = new Map();
masterRows.forEach((r,i) => {
const row = i+2;
const qrList = String(r[0] || '').split(',').map(x=>x.trim()).filter(Boolean);
qrList.forEach(k => map.set(k,row));
const barcode = String(r[1] || '').trim();
if (barcode) map.set(barcode,row);
map.set('R:'+row,row);
});
return map;
}
function stock(p) {
const row = resolveRow(p);
if (row < 2) throw new Error('対象の物品が見つかりません。');
const is = ss.getSheetByName(SHEET_ITEM_MASTER);
const hs = ss.getSheetByName(SHEET_HISTORY);
const item = is.getRange(row,1,1,Math.max(is.getLastColumn(),11)).getValues()[0];
const qty = Number(p.quantity || 0);
if (qty <= 0) throw new Error('数量を確認してください。');
const next = Number(item[4] || 0) + (p.type === '入庫' ? qty : -qty);
if (next < 0) throw new Error('在庫数がマイナスになるため処理できません。');
is.getRange(row,5).setValue(next);
if (p.type === '入庫') {
const orderedCell = is.getRange(row,10);
orderedCell.setValue(Math.max(0,Number(orderedCell.getValue() || 0)-qty));
}
hs.appendRow([new Date(),'R:'+row,p.type,qty,p.user.email,p.user.department||'',p.user.phs||'','','']);
const historyId = hs.getLastRow();
clearItems();
const reorder = Number(item[5] || 0);
const par = Number(item[8] || 0);
const ordered = Number(item[9] || 0);
if (p.type === '出庫' && next < reorder) {
const target = par > 0 ? par : reorder;
const orderQty = Math.max(0,target-next-ordered);
if (orderQty > 0) {
return { status:'success', message:'在庫を更新しました。発注が必要です。', orderRequired:true, mailPreview:orderPreview(item,orderQty,p.user), historyId };
}
return { status:'success', message:'在庫を更新しました。発注済み数量を考慮すると追加発注は不要です。' };
}
return { status:'success', message:'在庫を更新しました。' };
}
function getOrderCard(p) {
const row = resolveRow(p);
if (row < 2) throw new Error('対象の物品が見つかりません。');
const sh = ss.getSheetByName(SHEET_ITEM_MASTER);
const item = sh.getRange(row,1,1,Math.max(sh.getLastColumn(),11)).getValues()[0];
const stockNow = Number(item[4] || 0), reorder = Number(item[5] || 0), par = Number(item[8] || 0), ordered = Number(item[9] || 0);
const target = par > 0 ? par : reorder;
const suggested = Math.max(1,target-stockNow-ordered);
return { status:'success', data:{ ...orderPreview(item,suggested,p.user), itemName:item[2], model:item[3] } };
}
function sendOrder(p) {
const is = ss.getSheetByName(SHEET_ITEM_MASTER), hs = ss.getSheetByName(SHEET_HISTORY), os = ss.getSheetByName(SHEET_ORDER_LOG);
let row = -1, historyId = Number(p.historyId || 0);
if (historyId >= 2 && historyId <= hs.getLastRow()) {
const key = String(hs.getRange(historyId,2).getValue() || '');
if (/^R:\d+$/.test(key)) row = Number(key.slice(2));
else {
const master = is.getLastRow()>1 ? is.getRange(2,1,is.getLastRow()-1,Math.max(is.getLastColumn(),11)).getValues() : [];
row = buildLegacyKeyMap(master).get(key) || -1;
}
}
if (row < 2) row = resolveRow(p);
if (row < 2) throw new Error('発注対象の物品が見つかりません。');
const qty = Number(p.quantity || 0);
if (qty <= 0) throw new Error('発注数量を確認してください。');
if (!String(p.to || '').trim()) throw new Error('発注先メールアドレスがありません。');
const item = is.getRange(row,1,1,Math.max(is.getLastColumn(),11)).getValues()[0];
if (!historyId) {
hs.appendRow([new Date(),'R:'+row,'発注',qty,p.user.email,p.user.department||'',p.user.phs||'','','']);
historyId = hs.getLastRow();
} else {
hs.getRange(historyId,4).setValue(qty);
}
const orderedCell = is.getRange(row,10);
orderedCell.setValue(Number(orderedCell.getValue() || 0)+qty);
const message = GmailApp.createDraft(p.to,p.subject,p.body).send();
const mailId = message.getId();
admins().forEach(x => GmailApp.sendEmail(x,'[転送：発注] '+p.subject,'',{ htmlBody:String(p.body).replace(/\n/g,'<br>') }));
hs.getRange(historyId,8).setValue('注文済み');
hs.getRange(historyId,9).setValue(mailId);
os.appendRow([new Date(),'発注',item[2],item[3],qty,p.user.name,mailId]);
clearItems();
return { status:'success', message:'発注メールを送信しました。', mailId };
}
function getOrders(user) {
const hs = ss.getSheetByName(SHEET_HISTORY), is = ss.getSheetByName(SHEET_ITEM_MASTER);
const hLast = hs.getLastRow();
if (hLast < 2) return { status:'success', data:[] };
const history = hs.getRange(2,1,hLast-1,Math.max(hs.getLastColumn(),9)).getValues();
const master = is.getLastRow()>1 ? is.getRange(2,1,is.getLastRow()-1,Math.max(is.getLastColumn(),11)).getValues() : [];
const keyMap = buildLegacyKeyMap(master);
const out = [];
history.forEach((r,i) => {
if (!['注文済み','キャンセル済み'].includes(r[7])) return;
if (user.role === ROLES.USER && String(r[4]) !== String(user.email)) return;
const row = keyMap.get(String(r[1] || '')) || -1;
let name='不明な物品', model='';
if (row >= 2 && master[row-2]) { name=master[row-2][2] || name; model=master[row-2][3] || ''; }
out.push({ historyId:i+2, mailId:r[8], itemName:name, model, orderDate:Utilities.formatDate(new Date(r[0]),'Asia/Tokyo','yyyy/MM/dd'), quantity:r[3], status:r[7] });
});
out.reverse();
return { status:'success', data:out };
}
function cancelOrder(p) {
const hs = ss.getSheetByName(SHEET_HISTORY), is = ss.getSheetByName(SHEET_ITEM_MASTER), os = ss.getSheetByName(SHEET_ORDER_LOG);
const id = Number(p.historyId);
if (id < 2 || id > hs.getLastRow()) throw new Error('発注履歴が見つかりません。');
const h = hs.getRange(id,1,1,Math.max(hs.getLastColumn(),9)).getValues()[0];
if (h[7] !== '注文済み') throw new Error('この発注はキャンセルできません。');
const key = String(h[1] || '');
let row = /^R:\d+$/.test(key) ? Number(key.slice(2)) : -1;
if (row < 2) {
const master = is.getLastRow()>1 ? is.getRange(2,1,is.getLastRow()-1,Math.max(is.getLastColumn(),11)).getValues() : [];
row = buildLegacyKeyMap(master).get(key) || -1;
}
if (row < 2) throw new Error('物品が見つかりません。');
const item = is.getRange(row,1,1,Math.max(is.getLastColumn(),11)).getValues()[0], qty=Number(h[3] || 0);
const orderedCell = is.getRange(row,10);
orderedCell.setValue(Math.max(0,Number(orderedCell.getValue() || 0)-qty));
const s = supplier(item[6]);
if (!s.email) throw new Error('発注先メールアドレスがありません。');
const subject = '【注文キャンセルのお願い】'+item[2];
const body = cancelBody(item,qty,p.user);
GmailApp.sendEmail(s.email,subject,body);
admins().forEach(x => GmailApp.sendEmail(x,'[転送：キャンセル] '+subject,'',{ htmlBody:body.replace(/\n/g,'<br>') }));
os.appendRow([new Date(),'キャンセル',item[2],item[3],qty,p.user.name,h[8] || '']);
hs.getRange(id,8).setValue('キャンセル済み');
clearItems();
return { status:'success', message:'キャンセルメールを送信しました。' };
}
function invSheet() {
let sh = ss.getSheetByName(SHEET_INVENTORY);
if (!sh) {
sh = ss.insertSheet(SHEET_INVENTORY);
sh.getRange(1,1,1,13).setValues([['session_id','status','user_email','started_at','updated_at','completed_at','item_ref','item_name','model','expected_stock','actual_stock','difference','checked_at']]);
}
return sh;
}
function inventoryMapKey(sessionId) { return 'invmap:'+sessionId; }
function saveInventoryRowMap(sessionId,map) { CacheService.getScriptCache().put(inventoryMapKey(sessionId),JSON.stringify(map),21600); }
function getInventoryRowMap(sessionId) {
const cache = CacheService.getScriptCache();
const hit = cache.get(inventoryMapKey(sessionId));
if (hit) return JSON.parse(hit);
const sh = invSheet(), last=sh.getLastRow(), map={};
if (last > 1) {
const rows=sh.getRange(2,1,last-1,13).getValues();
rows.forEach((r,i)=>{ if (String(r[0])===String(sessionId)) map[String(r[6])]=i+2; });
}
saveInventoryRowMap(sessionId,map);
return map;
}
function startInventory(user) {
const active = getActiveInventory(user).data;
if (active) return { status:'success', data:active };
const items=itemRecords(), sh=invSheet(), id='INV-'+Utilities.formatDate(new Date(),'Asia/Tokyo','yyyyMMdd-HHmmss')+'-'+String(user.email).slice(0,20), now=new Date();
const startRow=sh.getLastRow()+1;
const rows=items.map(i=>[id,'進行中',user.email,now,now,'',i.itemRef,i.itemName,i.model,i.stock,'','','']);
if (rows.length) sh.getRange(startRow,1,rows.length,13).setValues(rows);
const map={}; items.forEach((i,index)=>map[i.itemRef]=startRow+index); saveInventoryRowMap(id,map);
return { status:'success', data:{ sessionId:id, status:'進行中', items:rows.map(invObj) } };
}
function getActiveInventory(user) {
const sh=invSheet(), last=sh.getLastRow();
if (last<2) return { status:'success', data:null };
const rows=sh.getRange(2,1,last-1,13).getValues();
let id='';
for (let i=rows.length-1;i>=0;i--) {
if (String(rows[i][2])===String(user.email) && rows[i][1]==='進行中') { id=rows[i][0]; break; }
}
if (!id) return { status:'success', data:null };
const selected=[]; const map={};
rows.forEach((r,i)=>{ if (r[0]===id) { selected.push(r); map[String(r[6])]=i+2; } });
saveInventoryRowMap(id,map);
return { status:'success', data:{ sessionId:id, status:'進行中', items:selected.map(invObj) } };
}
function invObj(r) {
const checked=!!r[12];
return { itemRef:r[6], itemName:r[7], model:r[8], expectedStock:Number(r[9]||0), actualStock:checked?Number(r[10]||0):'', difference:checked?Number(r[11]||0):0, checked };
}
function saveInventory(p) {
const actual=Number(p.actualStock);
if (!Number.isFinite(actual) || actual < 0) throw new Error('実在庫数を確認してください。');
const sh=invSheet(), map=getInventoryRowMap(p.sessionId), rowNum=Number(map[String(p.itemRef)] || 0);
if (rowNum < 2) throw new Error('棚卸し対象が見つかりません。');
const r=sh.getRange(rowNum,1,1,13).getValues()[0];
if (r[1] !== '進行中') throw new Error('この棚卸しは完了済みです。');
if (String(r[2]) !== String(p.user.email)) throw new Error('編集権限がありません。');
const expected=Number(r[9]||0), now=new Date();
sh.getRange(rowNum,5).setValue(now);
sh.getRange(rowNum,11,1,3).setValues([[actual,actual-expected,now]]);
return { status:'success', data:{ itemRef:p.itemRef, itemName:r[7], model:r[8], expectedStock:expected, actualStock:actual, difference:actual-expected, checked:true } };
}
function completeInventory(p) {
const sh=invSheet(), last=sh.getLastRow();
if (last<2) throw new Error('棚卸しデータがありません。');
const rows=sh.getRange(2,1,last-1,13).getValues();
const target=[];
rows.forEach((r,i)=>{ if (String(r[0])===String(p.sessionId)) target.push({ row:i+2, data:r }); });
if (!target.length) throw new Error('棚卸しセッションが見つかりません。');
if (String(target[0].data[2]) !== String(p.user.email)) throw new Error('編集権限がありません。');
if (target[0].data[1] !== '進行中') throw new Error('この棚卸しは完了済みです。');
const unchecked=target.filter(x=>!x.data[12]);
if (unchecked.length) throw new Error(`未確認の物品が${unchecked.length}件あります。すべて確認してから完了してください。`);
const is=ss.getSheetByName(SHEET_ITEM_MASTER), hs=ss.getSheetByName(SHEET_HISTORY), logs=[];
let changed=0;
target.forEach(x=>{
const r=x.data, actual=Number(r[10]||0), expected=Number(r[9]||0);
if (actual !== expected) {
const row=resolveRow({ itemRef:r[6], itemName:r[7], model:r[8] });
if (row>=2) {
is.getRange(row,5).setValue(actual);
changed++;
logs.push([new Date(),'R:'+row,'棚卸修正',actual,p.user.email,p.user.department||'',p.user.phs||'','','']);
}
}
});
if (logs.length) hs.getRange(hs.getLastRow()+1,1,logs.length,9).setValues(logs);
const now=new Date();
target.forEach(x=>{ sh.getRange(x.row,2).setValue('完了'); sh.getRange(x.row,6).setValue(now); });
CacheService.getScriptCache().remove(inventoryMapKey(p.sessionId));
clearItems();
return { status:'success', message:`棚卸しを完了しました（確認 ${target.length}件 / 在庫修正 ${changed}件）。` };
}
function registerItem(p) {
if (!String(p.itemName||'').trim()) throw new Error('物品名は必須です。');
const sh=ss.getSheetByName(SHEET_ITEM_MASTER);
sh.appendRow(['','',p.itemName,p.model||'',Number(p.stock||0),Number(p.reorderPoint||0),p.supplierEmail||'',Number(p.price||0),Number(p.parLevel||0),0,false]);
const row=sh.getLastRow();
ss.getSheetByName(SHEET_HISTORY).appendRow([new Date(),'R:'+row,'新規登録',Number(p.stock||0),p.user.email,p.user.department||'',p.user.phs||'','','']);
clearItems();
return { status:'success', message:`「${p.itemName}」を新規登録しました。` };
}
function orderPreview(r,qty,u) {
const sh=ss.getSheetByName(SHEET_SETTINGS), subjectTpl=sh.getRange('B1').getValue(), bodyTpl=sh.getRange('B2').getValue(), s=supplier(r[6]), price=Number(r[7]||0), subtotal=price*qty;
return {
to:s.email,
subject:String(subjectTpl).replace(/{{物品名}}/g,r[2]).replace(/{{発注者名}}/g,u.name||''),
body:String(bodyTpl).replace(/{{会社名}}/g,s.companyName||'ご担当者様').replace(/{{担当者名}}/g,s.contactName?s.contactName+' 様':'').replace(/{{物品名}}/g,r[2]).replace(/{{型番}}/g,r[3]||'').replace(/{{数量}}/g,qty).replace(/{{単価}}/g,price.toLocaleString()+'円').replace(/{{小計}}/g,subtotal.toLocaleString()+'円').replace(/{{合計金額}}/g,subtotal.toLocaleString()+'円').replace(/{{病院名}}/g,u.hospital||'').replace(/{{部署名}}/g,u.department||'').replace(/{{発注者名}}/g,u.name||'').replace(/{{発注者メールアドレス}}/g,u.email||''),
quantity:qty, price, subtotal
};
}
function cancelBody(r,qty,u) {
const t=ss.getSheetByName(SHEET_SETTINGS).getRange('B3').getValue(), price=Number(r[7]||0);
return String(t).replace(/{{物品名}}/g,r[2]).replace(/{{型番}}/g,r[3]||'').replace(/{{数量}}/g,qty).replace(/{{単価}}/g,price.toLocaleString()+'円').replace(/{{合計金額}}/g,(price*qty).toLocaleString()+'円').replace(/{{病院名}}/g,u.hospital||'').replace(/{{部署名}}/g,u.department||'').replace(/{{発注者名}}/g,u.name||'').replace(/{{発注者メールアドレス}}/g,u.email||'');
}
function supplier(email) {
const sh=ss.getSheetByName(SHEET_SUPPLIERS), last=sh.getLastRow();
if (last<2) return { email, companyName:'', contactName:'' };
const rows=sh.getRange(2,1,last-1,Math.max(sh.getLastColumn(),3)).getValues(), target=String(email||'').trim().toLowerCase();
for (const r of rows) if (String(r[0]||'').trim().toLowerCase()===target) return { email:r[0], companyName:r[1], contactName:r[2] };
return { email, companyName:'', contactName:'' };
}
function admins() {
const sh=ss.getSheetByName(SHEET_USERS), rows=sh.getLastRow()>1?sh.getRange(2,1,sh.getLastRow()-1,5).getValues():[];
return rows.filter(r=>r[4]===ROLES.ADMIN).map(r=>r[0]).filter(Boolean);
}
function jsonResponse(o) {
return ContentService.createTextOutput(JSON.stringify(o||{})).setMimeType(ContentService.MimeType.JSON);
}