document.addEventListener("DOMContentLoaded", () => {
  const APP_VERSION = "2026.03.23.r5.10";
  console.log('=== 在庫管理アプリ v5.10 起動 ===');
  console.log('Version:', APP_VERSION);
  
  const urlParams = new URLSearchParams(window.location.search);
  const urlVersion = urlParams.get("v");
  
  if (urlVersion && urlVersion !== APP_VERSION) {
    console.log('Version mismatch. Reloading...', 'URL:', urlVersion, 'APP:', APP_VERSION);
    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set("v", APP_VERSION);
    newUrl.searchParams.set("t", Date.now());
    window.location.replace(newUrl.href);
    return;
  }

  // =========================================================
  // 【重要】最新のGAS Web App URL（/exec）に変更してください
  // =========================================================
  const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbxdMDvk9H6uRCBPHon_46lRRyx-L8qDiUvPJxKviCGj1gum1zg2BLngoC_FtVDAq2VJ/exec";
  
  const DEBUG = true;
  const CACHE_KEY_ITEMS = 'inventory_app_items_cache'; 

  // ===== State =====
  const state = {
    user:null,
    currentView:null,
    historyStack:[],
    itemList:[],
    cartItems:[], 
    stockUpdate:{ action:null, itemId:null, itemName:null },
    otherUserInfo:{ department:null, phs:null },
    orderContext:{ historyId:null, unitPrice:0 },
    inventoryCount:{ items:[], currentIndex:0, currentItemId:null, tempOrderContext:null }
  };

  let currentEditItemId = null;

  // ===== DOM =====
  const dom = {
    views:document.querySelectorAll(".view"),
    loading:document.getElementById("loading-overlay"),
    header:document.getElementById("app-header"),
    headerTitle:document.getElementById("header-app-title"),
    mainMenuBtn:document.getElementById("main-menu-button"),
    mainRoot:document.getElementById("main-root"),
    userName:document.getElementById("user-name"),
    loginId:document.getElementById("login-id-input"),
    modals:{
      alert:document.getElementById("alert-modal"),
      confirm:document.getElementById("confirm-modal"),
      edit:document.getElementById("edit-item-modal")
    }
  };

  // ===== helpers =====
  const log = (...args) => { if(DEBUG) console.log('[APP]', ...args); };
  const freezeBody = (on)=>document.body.classList.toggle("overflow-hidden", on);
  const clearCache = () => { sessionStorage.removeItem(CACHE_KEY_ITEMS); log('Cache cleared'); }; 

  const sizeInventoryView = ()=>{
    const view = document.getElementById("inventory-fit-root");
    if(!view) return;
    const headerH = dom.header.classList.contains("hidden") ? 0 : dom.header.offsetHeight;
    const pad = parseFloat(getComputedStyle(dom.mainRoot).paddingTop) + parseFloat(getComputedStyle(dom.mainRoot).paddingBottom);
    view.style.minHeight = `calc(100vh - ${headerH + pad}px)`;
  };

  const showView = (id, isBack=false)=>{
    log('showView:', id);
    dom.views.forEach(v=>v.style.display="none");
    const el = document.getElementById(id);
    if(el){
      el.style.display="block";
      if(!isBack && state.currentView) state.historyStack.push(state.currentView);
      state.currentView = id;
    }
    const showHeader = id!=="view-login" && id!=="view-home-other-1";
    dom.header.classList.toggle("hidden", !showHeader);
    const isMain = id==="view-home-user";
    dom.headerTitle.classList.toggle("hidden", !isMain);
    dom.mainMenuBtn.classList.toggle("hidden", isMain);
    if(id==="view-inventory-count"){ freezeBody(true); sizeInventoryView(); }
    else{ freezeBody(false); }
  };

  const goBack = ()=>{ const prev = state.historyStack.pop(); if(prev) showView(prev,true); };
  const goHome = ()=>{ state.historyStack=[]; showView("view-home-user"); };
  const toggleLoading = (on)=>{ dom.loading.classList.toggle("hidden", !on); };
  
  let alertCb=null;
  const showAlert = (m, cb=null)=>{ 
    document.getElementById("alert-message").innerHTML=String(m).replace(/\n/g, '<br>'); 
    dom.modals.alert.classList.remove("hidden"); 
    alertCb = cb;
  };
  
  let confirmCb=null;
  const showConfirm=(m,onOk)=>{ document.getElementById("confirm-message").textContent=m; dom.modals.confirm.classList.remove("hidden"); confirmCb=onOk; };
  
  const hideAllModals=()=>{ 
    dom.modals.alert.classList.add("hidden"); 
    dom.modals.confirm.classList.add("hidden"); 
    dom.modals.edit.classList.add("hidden");
  };
  
  const showDoneAnd=(m,sub,next)=>{ 
    document.getElementById("complete-message").innerHTML=String(m).replace(/\n/g, '<br>'); 
    document.getElementById("complete-sub-message").innerHTML=String(sub||"").replace(/\n/g, '<br>'); 
    showView("view-action-complete"); 
    setTimeout(next,2000); 
  };

  // Drive helpers
  function extractDriveFileId(u){
    if(!u) return null;
    if(/^[A-Za-z0-9_-]{20,}$/.test(u)) return u;
    let m=String(u).match(/\/file\/d\/([A-Za-z0-9_-]+)\//); if(m) return m[1];
    m=String(u).match(/[?&]id=([A-Za-z0-9_-]+)/); if(m) return m[1];
    m=String(u).match(/\/d\/([A-Za-z0-9_-]+)/); if(m) return m[1];
    return null;
  }
  const buildDriveThumbUrl = (id,s=480,c=true)=>`https://lh3.googleusercontent.com/d/${id}=s${s}${c?"-c":""}`;
  const buildDriveFullUrl  = (id,s=1600)=>`https://lh3.googleusercontent.com/d/${id}=s${s}`;
  function deriveImageSources(url){
    if(!url) return {thumb:null,full:null};
    const id=extractDriveFileId(url);
    if(id) return {thumb:buildDriveThumbUrl(id,480,true), full:buildDriveFullUrl(id,1600)};
    return {thumb:url, full:url};
  }
  function setProgressiveImage(img,url){
    const {thumb,full}=deriveImageSources(url);
    if(!thumb){ img.removeAttribute("src"); img.classList.remove("loaded"); return; }
    img.classList.remove("loaded");
    const fileId = extractDriveFileId(url);
    const fallback = fileId ? `${GAS_WEB_APP_URL}?action=image64&id=${fileId}` : null;
    img.onerror = ()=>{
      if (fallback) { img.onerror = null; img.src = fallback; requestAnimationFrame(()=>img.classList.add("loaded")); } 
      else { requestAnimationFrame(()=>img.classList.add("loaded")); }
    };
    img.src = thumb;
    if(full && full!==thumb){
      const hi=new Image();
      hi.onload=()=>{ img.src=full; requestAnimationFrame(()=>img.classList.add("loaded")); };
      hi.onerror=()=>{ requestAnimationFrame(()=>img.classList.add("loaded")); };
      hi.src=full;
    } else { requestAnimationFrame(()=>img.classList.add("loaded")); }
  }

  // API
  const callGasApi = async(action,payload={})=>{
    try{
      const req={action,payload};
      const noAuth=["login","get_departments","get_supplier_emails"];
      if(!noAuth.includes(action)){
        if(!state.user) throw new Error("認証が必要です。");
        req.payload.auth={
          loginId: state.user.loginId || '',
          email:state.user.email, name: state.user.name, hospital: state.user.hospital || '',
          department: state.user.department, phs: state.user.phs, role: state.user.role
        };
      }
      const res=await fetch(GAS_WEB_APP_URL,{ method:"POST", mode:"cors", headers:{ "Content-Type":"text/plain;charset=utf-8" }, body:JSON.stringify(req) });
      const json=await res.json();
      if(json.status==="error") throw new Error(json.message||"不明なエラー");
      return json;
    }catch(e){
      showAlert(`エラー: ${e.message}`);
      return null;
    }
  };

  // Auth
  const handleLogin = async(payload)=>{
    toggleLoading(true);
    const result=await callGasApi("login",payload);
    toggleLoading(false);
    if(result && result.status==="success"){
      state.user=result.data;
      dom.userName.textContent=state.user.name||"";
      if (state.user.role === '管理者') { document.getElementById('cart-button').classList.remove('hidden'); } 
      else { document.getElementById('cart-button').classList.add('hidden'); }
      const home=(["管理者","使用者"].includes(state.user.role))?"view-home-user":"view-home-other-1";
      showView(home);
      if(home==="view-home-other-1") loadDepartments();
    }else{
      state.user=null;
      dom.loginId.classList.add("shake-error");
      if(navigator.vibrate) navigator.vibrate([100,50,100]);
      setTimeout(()=>{ dom.loginId.classList.remove("shake-error"); dom.loginId.value=""; },820);
    }
  };
  const handleLogout=()=>{ state.user=null; state.historyStack=[]; dom.loginId.value=""; clearCache(); showView("view-login"); };

  // Masters
  const loadDepartments=async()=>{
    const listEl=document.getElementById("department-list");
    const result=await callGasApi("get_departments");
    if(result && result.status==="success" && result.data.length){
      listEl.innerHTML="";
      result.data.forEach(name=>{
        const btn=document.createElement("button"); btn.textContent=name;
        btn.className="bg-white border border-gray-300 px-4 py-2 rounded-full hover:bg-gray-100 shadow-sm";
        btn.addEventListener("click",()=>{ state.otherUserInfo.department=name; showView("view-home-other-2"); });
        listEl.appendChild(btn);
      });
    }else{ listEl.innerHTML = `<p class="text-red-500">部署読込失敗</p>`; }
  };
  const loadSupplierEmails=async()=>{
    const result=await callGasApi("get_supplier_emails");
    const dl=document.getElementById("supplier-email-list"); dl.innerHTML="";
    if(result && result.status==="success"){ result.data.forEach(email=>{ const o=document.createElement("option"); o.value=email; dl.appendChild(o); }); }
  };

  // Item list (v5.10 キャッシュ/SWR機能搭載)
  const handleShowItemList = async (forceRefresh = false) => {
    showView("view-item-list");
    const cached = sessionStorage.getItem(CACHE_KEY_ITEMS);
    
    if (cached && !forceRefresh) {
      log('🟢 キャッシュから瞬時に読み込みます');
      state.itemList = JSON.parse(cached);
      renderItemList();

      callGasApi("get_item_list").then(result => {
        if (result && result.data) {
          state.itemList = result.data;
          sessionStorage.setItem(CACHE_KEY_ITEMS, JSON.stringify(result.data));
          if (state.currentView === "view-item-list") {
            renderItemList();
          }
        }
      });
    } else {
      toggleLoading(true);
      const result = await callGasApi("get_item_list");
      toggleLoading(false);
      
      if (result && result.data) {
        state.itemList = result.data;
        sessionStorage.setItem(CACHE_KEY_ITEMS, JSON.stringify(result.data));
        renderItemList();
      } else {
        showAlert('物品一覧の取得に失敗しました。');
      }
    }
  };

  const renderItemList=()=>{
    const container=document.getElementById("item-list-container");
    const q=(document.getElementById("item-search-input").value||"").toLowerCase();
    const onlyReorder=document.getElementById("filter-reorder-needed").checked;
    const onlyOnOrder=document.getElementById("filter-on-order").checked;

    let items=[...state.itemList];
    if(q) items=items.filter(i=>(i.itemName||"").toLowerCase().includes(q));
    if(onlyReorder) items=items.filter(i=>Number(i.stock)<Number(i.reorderPoint));
    if(onlyOnOrder) items=items.filter(i=>Number(i.orderedQuantity)>0);

    if(!items.length){ container.innerHTML = `<p class="text-center text-gray-500">該当する物品はありません。</p>`; return; }

    container.innerHTML = items.map(item => `
      <div class="item-card p-3 border rounded-lg shadow-sm" data-item-id="${item.itemId||""}" data-item-name="${item.itemName||""}" data-image-url="${item.imageUrl||""}">
        <div class="flex items-start justify-between">
          <div>
            <h3 class="font-bold text-base leading-tight">${item.itemName||""}</h3>
            <p class="text-xs text-gray-500">用途: ${item.useFor||"—"}</p>
            <p class="text-xs text-gray-400">ID: ${item.itemId||"—"}</p>
          </div>
          <div class="w-16 h-16 overflow-hidden rounded ml-3 bg-gray-100">
            ${item.imageUrl ? `<img src="${item.imageUrl}" alt="" class="item-image w-16 h-16 object-cover rounded">` : `<div class="w-16 h-16 flex items-center justify-center text-gray-300">—</div>`}
          </div>
        </div>
        <div class="mt-2 text-sm space-y-2">
          <div class="flex justify-between items-center">
            <div class="flex items-center space-x-4">
              <div><span class="font-semibold text-gray-600">在庫:</span> <span class="font-bold text-lg">${item.stock??""}</span></div>
              <div><span class="font-semibold text-gray-600">発注点:</span> <span class="text-red-500 font-bold text-lg">${item.reorderPoint??""}</span></div>
            </div>
            <div><span class="font-semibold text-gray-600">単価:</span> ¥${Number(item.price||0).toLocaleString()}</div>
          </div>
          <div class="flex justify-between items-center text-xs text-gray-500 pt-1 border-t">
            <div><span class="font-semibold">発注上限:</span> ${item.parLevel||"未設定"}</div>
            <div><span class="font-semibold">発注中:</span> ${item.orderedQuantity||0}</div>
          </div>
        </div>
        <div class="mt-3 flex justify-end space-x-2">
          <button class="photo-button bg-purple-500 text-white px-3 py-1 rounded-md text-sm">写真</button>
          <button class="edit-button bg-gray-500 text-white px-3 py-1 rounded-md text-sm">変更</button>
          <button class="inflow-button bg-green-500 text-white px-3 py-1 rounded-md text-sm">入庫</button>
          <button class="outflow-button bg-yellow-500 text-white px-3 py-1 rounded-md text-sm">出庫</button>
        </div>
      </div>
    `).join("");

    document.querySelectorAll("#item-list-container .item-image").forEach(img=>{
      const url = img.closest('.item-card').dataset.imageUrl;
      if(url) setProgressiveImage(img, url);
    });
  };

  const handleItemListClick=(e)=>{
    const card=e.target.closest(".item-card");
    if(!card) return;
    const itemId = card.dataset.itemId;
    if(!itemId){ showAlert('物品IDが見つかりません。'); return; }

    if(e.target.classList.contains("edit-button")){ openEditItemModal(itemId); return; }

    if(e.target.classList.contains("inflow-button")){
      state.stockUpdate={ action:"入庫", itemId:itemId, itemName:card.dataset.itemName||"" };
      document.getElementById("final-code-display").textContent=`ID: ${itemId}`;
      document.getElementById("item-name-display-quantity").textContent=state.stockUpdate.itemName||"";
      document.getElementById("quantity-title").textContent="入庫";
      document.getElementById("quantity-input").value="";
      showView("view-quantity");
    }
    else if(e.target.classList.contains("outflow-button")){
      state.stockUpdate={ action:"出庫", itemId:itemId, itemName:card.dataset.itemName||"" };
      document.getElementById("final-code-display").textContent=`ID: ${itemId}`;
      document.getElementById("item-name-display-quantity").textContent=state.stockUpdate.itemName||"";
      document.getElementById("quantity-title").textContent="出庫";
      document.getElementById("quantity-input").value="";
      showView("view-quantity");
    }
    else if(e.target.classList.contains("photo-button")){
      pickAndUploadPhoto(itemId,(newUrl)=>{
        const img=card.querySelector(".item-image");
        if(img) setProgressiveImage(img,newUrl);
        const item=state.itemList.find(i=>i.itemId===itemId);
        if(item) item.imageUrl=newUrl;
        card.dataset.imageUrl = newUrl;
        clearCache(); 
      });
    }
  };

  // Edit item
  const openEditItemModal = (itemId) => {
    const item = state.itemList.find(i => i.itemId === itemId);
    if (!item) return;
    currentEditItemId = itemId;
    document.getElementById("edit-item-name").value = item.itemName || "";
    document.getElementById("edit-stock").value = item.stock || 0;
    document.getElementById("edit-reorder-point").value = item.reorderPoint || 0;
    document.getElementById("edit-price").value = item.price || 0;
    document.getElementById("edit-par-level").value = item.parLevel || "";
    document.getElementById("edit-ordered-quantity").value = item.orderedQuantity || 0;
    dom.modals.edit.classList.remove("hidden");
  };

  const handleEditItemSave = async () => {
    if (!currentEditItemId) return;
    const payload = {
      itemId: currentEditItemId, itemName: document.getElementById("edit-item-name").value.trim(),
      stock: Number(document.getElementById("edit-stock").value), reorderPoint: Number(document.getElementById("edit-reorder-point").value),
      price: Number(document.getElementById("edit-price").value), parLevel: document.getElementById("edit-par-level").value.trim() || "",
      orderedQuantity: Number(document.getElementById("edit-ordered-quantity").value)
    };
    if (!payload.itemName) { showAlert("物品名は必須です。"); return; }
    toggleLoading(true);
    const result = await callGasApi("update_item", payload);
    toggleLoading(false);
    if (result && result.status === "success") {
      dom.modals.edit.classList.add("hidden"); 
      clearCache(); 
      showAlert("物品情報を更新しました。"); 
      await handleShowItemList(true);
    }
  };

  // Stock update
  const handleStockUpdate=async()=>{
    const qty=parseInt(document.getElementById("quantity-input").value,10);
    if(!qty || qty<=0){ showAlert("正しい数量を入力してください。"); return; }

    const payload={ itemId:state.stockUpdate.itemId, type:state.stockUpdate.action, quantity:qty, department:state.otherUserInfo.department, phs:state.otherUserInfo.phs };
    toggleLoading(true);
    const result=await callGasApi("stock_update",payload);
    toggleLoading(false);
    if(!result) return;

    if(result.status==="success"){
      document.getElementById("quantity-input").value="";
      clearCache(); 
      showDoneAnd("更新完了", result.message, ()=>showView("view-item-list")); 
    }
  };

  // Cart
  const handleShowCart = async () => {
    toggleLoading(true);
    const result = await callGasApi("get_cart");
    toggleLoading(false);
    if (result && result.status === "success") {
      state.cartItems = result.data || [];
      renderCart();
      showView("view-cart");
    } else {
      showAlert('カート情報の取得に失敗しました。');
    }
  };

  const renderCart = () => {
    const container = document.getElementById("cart-container");
    if (!state.cartItems.length) {
      container.innerHTML = '<p class="text-center text-gray-500 py-6">発注が必要な物品は現在ありません。</p>';
      document.getElementById("submit-cart-button").classList.add("hidden");
      return;
    }
    
    document.getElementById("submit-cart-button").classList.remove("hidden");
    const grouped = {};
    state.cartItems.forEach(item => {
      const sup = item.supplierEmail || '未設定（※マスター要確認）';
      if (!grouped[sup]) grouped[sup] = [];
      grouped[sup].push(item);
    });

    let html = '';
    for (const sup in grouped) {
      html += `<div class="border rounded-lg p-3 bg-white shadow-sm border-blue-200">
        <h3 class="font-bold text-blue-800 mb-3 border-b pb-2 text-sm">宛先: ${sup}</h3>
        <div class="space-y-4">`;
        
      grouped[sup].forEach(item => {
        html += `<div class="flex flex-col text-sm border-l-4 border-gray-300 pl-2">
          <div class="font-semibold text-gray-800">${item.itemName} <span class="text-xs font-normal text-gray-500">${item.model ? `(${item.model})` : ''}</span></div>
          <div class="flex justify-between items-center mt-2">
            <div class="text-xs text-gray-600">
              実在庫:<span class="font-bold">${item.stock}</span> 
              <span class="text-gray-400">|</span> 未納:<span class="font-bold">${item.orderedQuantity}</span> 
              <span class="text-gray-400">|</span> 発注点:<span class="text-red-500 font-bold">${item.reorderPoint}</span>
            </div>
            <div class="flex items-center space-x-2 bg-pink-50 p-1 rounded">
              <label class="text-xs font-bold text-pink-700">発注数:</label>
              <input type="number" class="cart-qty-input border border-pink-300 rounded w-16 p-1 text-center font-bold text-lg focus:ring-pink-500 focus:border-pink-500" data-item-id="${item.itemId}" value="${item.suggestedQty}" min="0">
            </div>
          </div>
        </div>`;
      });
      html += `</div></div>`;
    }
    container.innerHTML = html;
  };

  const handleSubmitBatchOrders = async () => {
    const orders = [];
    document.querySelectorAll('.cart-qty-input').forEach(input => {
      const qty = parseInt(input.value, 10);
      if (qty > 0) {
        const item = state.cartItems.find(i => i.itemId === input.dataset.itemId);
        if (item) orders.push({ ...item, quantity: qty });
      }
    });

    if (!orders.length) { showAlert('発注する物品がありません。'); return; }

    showConfirm(`${orders.length}件の物品を一括発注します。よろしいですか？`, async () => {
      hideAllModals();
      toggleLoading(true);
      const result = await callGasApi("submit_batch_orders", { orders });
      toggleLoading(false);
      if (result && result.status === "success") {
        clearCache(); 
        showDoneAnd("一括発注 完了", result.message, goHome);
      }
    });
  };

  // Order history
  const handleGetOrderHistory=async()=>{
    toggleLoading(true);
    const result=await callGasApi("get_order_history",{});
    toggleLoading(false);
    if(!result||!result.data) return;
    const list=document.getElementById("order-history-list");
    if(!result.data.length){ list.innerHTML = `<p class="text-center text-gray-500">履歴はありません。</p>`; } 
    else {
      list.innerHTML = result.data.map(r => `
        <div class="border rounded-md p-3">
          <div class="flex justify-between items-center">
            <div>
              <p class="font-semibold">${r.itemName||""}</p>
              <p class="text-xs text-gray-500">${r.orderDate} / 数量: ${r.quantity} / ${r.status}</p>
            </div>
            ${r.status==="注文済み" ? `<button class="cancel-order-button bg-blue-500 text-white px-3 py-1 rounded text-sm" data-mail-id="${r.mailId}" data-history-id="${r.historyId}">キャンセル</button>` : ``}
          </div>
        </div>
      `).join("");
    }
    showView("view-order-history");
  };

  const handleCancelOrderFromHistory=(mailId,historyId)=>{
    showConfirm("この注文をキャンセルしますか？", async()=>{
      hideAllModals();
      toggleLoading(true);
      const result=await callGasApi("cancel_order",{mailId,historyId});
      toggleLoading(false);
      if(result && result.status==="success"){ clearCache(); showAlert("キャンセルしました。", handleGetOrderHistory); }
    });
  };

  // Inventory
  const startInventoryCount=async()=>{
    toggleLoading(true);
    const result=await callGasApi("get_item_list");
    toggleLoading(false);
    if(result && result.data){
      state.inventoryCount.items=result.data; state.inventoryCount.currentIndex=0; state.inventoryCount.currentItemId=null;
      displayCurrentInventoryItem(); showView("view-inventory-count");
    } else { showAlert('物品一覧の取得に失敗しました。'); }
  };

  const displayCurrentInventoryItem=()=>{
    const {items,currentIndex}=state.inventoryCount;
    if(currentIndex>=items.length){ showDoneAnd("棚卸し完了","全ての物品の確認が終わりました。", goHome); return; }
    const item=items[currentIndex];
    const itemId = item.itemId;
    if(!itemId){ state.inventoryCount.currentIndex++; displayCurrentInventoryItem(); return; }
    
    state.inventoryCount.currentItemId = itemId;
    document.getElementById("inventory-count-progress").textContent = `${currentIndex+1} / ${items.length}`;
    document.getElementById("inventory-item-name").textContent=item.itemName||"";
    document.getElementById("inventory-usefor").textContent=item.useFor?item.useFor:"—";
    setProgressiveImage(document.getElementById("inventory-image"), item.imageUrl||"");
    const input=document.getElementById("inventory-actual-stock"); input.value=item.stock??0; input.focus();
    sizeInventoryView();
  };

  const handleInventoryConfirm=async()=>{
    const {items,currentIndex}=state.inventoryCount;
    if(currentIndex>=items.length) return;
    const actual=parseInt(document.getElementById("inventory-actual-stock").value,10);
    if(Number.isNaN(actual)||actual<0){ showAlert("有効な在庫数を入力してください。"); return; }
    const itemId = state.inventoryCount.currentItemId;
    if(!itemId){ showAlert("物品IDがありません。"); return; }

    const payload={ itemId: itemId, type:"棚卸修正", quantity:actual, isCorrection:true };
    toggleLoading(true);
    const result=await callGasApi("stock_update",payload);
    toggleLoading(false);
    if(!result) return;

    if(result.status==="success"){
      clearCache(); 
      if(result.message && result.message.includes('カート')){
        showAlert(result.message, () => { state.inventoryCount.currentIndex++; displayCurrentInventoryItem(); });
      } else {
        state.inventoryCount.currentIndex++; displayCurrentInventoryItem();
      }
    }
  };

  const handleInventoryBack = () => {
    if (state.inventoryCount.currentIndex > 0) { state.inventoryCount.currentIndex--; displayCurrentInventoryItem(); } 
    else { goHome(); }
  };

  // New item
  const handleNewItemRegistration=async()=>{
    const payload={
      itemName:document.getElementById("new-item-name").value.trim(), model:document.getElementById("new-model").value.trim(),
      stock:Number(document.getElementById("new-stock").value), reorderPoint:Number(document.getElementById("new-reorder-point").value),
      price:Number(document.getElementById("new-price").value), supplierEmail:document.getElementById("new-supplier-email").value.trim(),
      imageUrl:state.newItemPhotoUrl, parLevel:document.getElementById("new-par-level").value.trim(), useFor:document.getElementById("new-use-for").value.trim(),
    };
    if(!payload.itemName || !payload.stock || !payload.reorderPoint || !payload.price || !payload.supplierEmail){ showAlert("必須項目を入力してください。"); return; }
    toggleLoading(true);
    const result=await callGasApi("item_register",payload);
    toggleLoading(false);
    if(result && result.status==="success"){
      clearCache(); 
      showAlert("登録しました。"); document.querySelectorAll("#view-new-item input").forEach(i=>i.value="");
      state.newItemPhotoUrl=''; document.getElementById("new-item-photo-preview").innerHTML='<span class="text-gray-400 text-sm">写真未登録</span>';
    }
  };

  // Photo upload
  function compressImageToDataUrl(file,maxSize=1024,quality=0.8){
    return new Promise((resolve,reject)=>{
      const img=new Image(), reader=new FileReader();
      reader.onload=()=>{
        img.onload=()=>{
          let {width,height}=img; const scale=Math.min(1,maxSize/Math.max(width,height));
          width=Math.round(width*scale); height=Math.round(height*scale);
          const canvas=document.createElement("canvas"); canvas.width=width; canvas.height=height;
          const ctx=canvas.getContext("2d"); ctx.drawImage(img,0,0,width,height);
          resolve(canvas.toDataURL("image/jpeg",quality));
        };
        img.onerror=()=>reject(new Error("画像読込失敗")); img.src=reader.result;
      };
      reader.onerror=()=>reject(new Error("ファイル読込失敗")); reader.readAsDataURL(file);
    });
  }

  async function uploadWithRetry(payload,tries=3){
    let err=null;
    for(let i=0;i<tries;i++){
      const res=await callGasApi("upload_item_image",payload);
      if(res && res.status==="success" && (res.imageUrl||res.fileId)) return res;
      err=new Error(res?.message||"アップロード失敗"); await new Promise(r=>setTimeout(r,600*(i+1)));
    }
    throw err;
  }

  function pickAndUploadPhoto(itemId,onDone){
    if(!itemId){ showAlert("物品IDが不明です。"); return; }
    const input=document.createElement("input"); input.type="file"; input.accept="image/*"; input.capture="environment";
    input.onchange=async()=>{
      const file=input.files && input.files[0]; if(!file) return;
      try{
        toggleLoading(true); const dataUrl=await compressImageToDataUrl(file,1024,0.8);
        const [pfx,base64]=dataUrl.split(","); const mime=(pfx.match(/data:(.*?);base64/)||[])[1]||"image/jpeg";
        const safeName=(file.name||"photo.jpg").replace(/[^\w.\-]/g,"_");
        const res=await uploadWithRetry({ itemId, imageDataUrl:dataUrl, base64, mimeType:mime, fileName:safeName },3);
        if(typeof onDone==="function") onDone(res.imageUrl||res.fileId||"");
        showAlert("画像を登録しました。");
      }catch(e){ showAlert("エラー: "+e.message); }finally{ toggleLoading(false); }
    };
    input.click();
  }

  function setupDrumroll(input){
    const clamp=v=>Math.max(0, v|0);
    input.addEventListener("wheel",e=>{ e.preventDefault(); input.value=clamp((parseInt(input.value)||0)+(e.deltaY<0?1:-1)); }, {passive:false});
    let lastY=null;
    input.addEventListener("touchstart",e=>{ lastY=e.touches[0].clientY; }, {passive:true});
    input.addEventListener("touchmove",e=>{ const y=e.touches[0].clientY; const dy=y-lastY; if(Math.abs(dy)>=18){ input.value=clamp((parseInt(input.value)||0)+(dy<0?1:-1)); lastY=y; } e.preventDefault(); }, {passive:false});
    document.getElementById("roll-inc").addEventListener("click",()=>input.value=clamp((parseInt(input.value)||0)+1));
    document.getElementById("roll-dec").addEventListener("click",()=>input.value=clamp((parseInt(input.value)||0)-1));
  }

  // listeners
  const setupListeners=()=>{
    dom.loginId.addEventListener("input",()=>{ if(dom.loginId.value.length===5) handleLogin({loginId:dom.loginId.value}); });
    document.getElementById("other-staff-login-button").addEventListener("click",()=>{ state.user={role:"その他"}; dom.userName.textContent="その他"; showView("view-home-other-1"); loadDepartments(); });
    document.getElementById("phs-submit-button").addEventListener("click",()=>{
      const name = document.getElementById("other-name-input").value.trim();
      const phs = document.getElementById("phs-input").value.trim();
      if(!name) { showAlert("お名前を入力してください。"); return; }
      state.user.name = name; state.user.department = state.otherUserInfo.department; state.user.phs = phs || '';
      state.user.email = `other_${Date.now()}@temp.local`; state.otherUserInfo.phs = phs; dom.userName.textContent = name;
      showView("view-home-other-menu");
    });

    dom.mainMenuBtn.addEventListener("click",goHome);
    document.getElementById("logout-button").addEventListener("click",handleLogout);
    
    document.getElementById("item-list-button").addEventListener("click",() => handleShowItemList(false));
    document.getElementById("refresh-item-list").addEventListener("click", () => handleShowItemList(true));

    document.getElementById("inventory-count-button").addEventListener("click",startInventoryCount);
    document.getElementById("new-item-button").addEventListener("click",()=>{ loadSupplierEmails(); showView("view-new-item"); });
    document.getElementById("order-history-button").addEventListener("click",handleGetOrderHistory);
    
    document.getElementById("cart-button").addEventListener("click", handleShowCart);
    document.getElementById("submit-cart-button").addEventListener("click", handleSubmitBatchOrders);

    document.querySelectorAll(".back-button").forEach(b=>b.addEventListener("click",e=>{ const t=e.currentTarget.dataset.target; t?showView(t):goBack(); }));

    document.getElementById("alert-ok-button").addEventListener("click",()=>{ dom.modals.alert.classList.add("hidden"); if(alertCb) alertCb(); alertCb=null; });
    document.getElementById("confirm-ok-button").addEventListener("click",()=>{ dom.modals.confirm.classList.add("hidden"); if(confirmCb) confirmCb(); confirmCb=null; });
    document.getElementById("confirm-cancel-button").addEventListener("click",()=>{ dom.modals.confirm.classList.add("hidden"); confirmCb=null; });

    document.getElementById("submit-stock-update").addEventListener("click",handleStockUpdate);
    document.getElementById("item-list-container").addEventListener("click",handleItemListClick);
    document.getElementById("item-search-input").addEventListener("input",renderItemList);
    document.getElementById("filter-reorder-needed").addEventListener("change",renderItemList);
    document.getElementById("filter-on-order").addEventListener("change",renderItemList);

    document.getElementById("inventory-confirm-button").addEventListener("click",handleInventoryConfirm);
    document.getElementById("inventory-back-button").addEventListener("click",handleInventoryBack);
    setupDrumroll(document.getElementById("inventory-actual-stock"));

    document.getElementById("order-history-list").addEventListener("click",(e)=>{
      const btn=e.target.closest(".cancel-order-button"); if(!btn) return;
      handleCancelOrderFromHistory(btn.dataset.mailId,btn.dataset.historyId);
    });

    document.getElementById("edit-item-cancel").addEventListener("click", () => { dom.modals.edit.classList.add("hidden"); currentEditItemId = null; });
    document.getElementById("edit-item-save").addEventListener("click", handleEditItemSave);

    window.addEventListener("resize",()=>{ if(state.currentView==="view-inventory-count") sizeInventoryView(); });
    document.getElementById("submit-new-item").addEventListener("click",handleNewItemRegistration);
    
    document.getElementById("new-item-photo-button").addEventListener("click",()=>{
      const input=document.createElement("input"); input.type="file"; input.accept="image/*"; input.capture="environment";
      input.onchange=async()=>{
        const file=input.files && input.files[0]; if(!file) return;
        try{
          toggleLoading(true); const dataUrl=await compressImageToDataUrl(file,1024,0.8);
          document.getElementById("new-item-photo-preview").innerHTML=`<img src="${dataUrl}" alt="プレビュー" class="blur-up loaded" />`;
          state.newItemPhotoUrl=dataUrl; showAlert("写真を選択しました。「登録する」ボタンを押してください。");
        }catch(e){ showAlert("エラー: "+e.message); }finally{ toggleLoading(false); }
      };
      input.click();
    });
  };

  const init=()=>{ setupListeners(); showView("view-login"); };
  init();
});
