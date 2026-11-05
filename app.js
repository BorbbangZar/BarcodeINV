(() => {
  'use strict';

  const DB_NAME = 'invc-barcode-workspace';
  const DB_STORE = 'workspace';
  const DB_KEY = 'active-job';
  const PAGE_SIZE = 30;
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const fmt = value => new Intl.NumberFormat('th-TH').format(Number(value) || 0);
  const nowIso = () => new Date().toISOString();

  const state = {
    job: null,
    query: '',
    status: 'unlinked',
    dosageForm: '',
    location: '',
    sort: 'name-asc',
    page: 1,
    scanTarget: null,
    scannerStop: null
  };

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function dbGet() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE).objectStore(DB_STORE).get(DB_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function dbSet(value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, DB_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbClear() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(DB_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  function toast(message, error = false) {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast show${error ? ' error' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.className = 'toast', 3200);
  }

  function normalizeText(value) {
    return String(value ?? '').trim();
  }

  function normalizeItem(raw, index) {
    const tradeRecordNumber = Number(raw.tradeRecordNumber ?? raw.recordNumber ?? raw.RECORD_NUMBER ?? index + 1);
    const currentBarcode = normalizeText(raw.currentBarcode ?? raw.barcode ?? raw.BAR_CODE);
    return {
      tradeRecordNumber,
      code: normalizeText(raw.code ?? raw.workingCode ?? raw.WORKING_CODE),
      name: normalizeText(raw.name ?? raw.drugName ?? raw.DRUG_NAME),
      tradeName: normalizeText(raw.tradeName ?? raw.TRADE_NAME),
      dosageForm: normalizeText(raw.dosageForm ?? raw.form ?? raw.DOSAGE_FORM),
      unit: normalizeText(raw.unit ?? raw.saleUnit ?? raw.SALE_UNIT),
      packRatio: Number(raw.packRatio ?? raw.PACK_RATIO ?? 0),
      location: normalizeText(raw.location ?? raw.LOCATION),
      vendorCode: normalizeText(raw.vendorCode ?? raw.VENDOR_CODE),
      vendor: normalizeText(raw.vendor ?? raw.vendorName ?? raw.VENDOR_NAME),
      manufacturerCode: normalizeText(raw.manufacturerCode ?? raw.manufacCode ?? raw.MANUFAC_CODE),
      manufacturer: normalizeText(raw.manufacturer ?? raw.manufacturerName ?? raw.MANUFACTURER_NAME),
      currentBarcode,
      transferProof: normalizeText(raw.transferProof),
      scannedBarcode: normalizeText(raw.scannedBarcode),
      scannedAt: raw.scannedAt || null,
      operator: normalizeText(raw.operator),
      lots: Array.isArray(raw.lots) ? raw.lots.map(lot => ({
        recordNumber: Number(lot.recordNumber ?? lot.RECORD_NUMBER ?? 0),
        lot: normalizeText(lot.lot ?? lot.LOT_NO),
        expire: lot.expire ?? lot.EXPIRE_DATE ?? null,
        qty: Number(lot.qty ?? lot.QTY_ON_HAND ?? 0),
        barcode: normalizeText(lot.barcode ?? lot.BAR_CODE),
        location: normalizeText(lot.location ?? lot.LOCATION)
      })) : [],
      lotCount: Number(raw.lotCount ?? (Array.isArray(raw.lots) ? raw.lots.length : 0))
    };
  }

  function normalizeJob(raw) {
    const items = Array.isArray(raw) ? raw : raw.items;
    if (!Array.isArray(items) || !items.length) throw new Error('ไม่พบรายการยาในไฟล์งาน');
    const normalized = items.map(normalizeItem).filter(item => item.code && item.name && Number.isFinite(item.tradeRecordNumber));
    if (!normalized.length) throw new Error('รายการในไฟล์ไม่มีรหัสยา ชื่อยา หรือเลขระเบียนที่ถูกต้อง');
    const ids = new Set();
    for (const item of normalized) {
      if (ids.has(item.tradeRecordNumber)) throw new Error(`เลขระเบียนซ้ำในไฟล์: ${item.tradeRecordNumber}`);
      ids.add(item.tradeRecordNumber);
    }
    return {
      schema: 'invc-barcode-work/v1',
      batchId: normalizeText(raw.batchId) || `LOCAL-${Date.now()}`,
      exportedAt: raw.exportedAt || nowIso(),
      importedAt: nowIso(),
      warehouse: normalizeText(raw.warehouse) || 'inventory',
      warehouseLabel: normalizeText(raw.warehouseLabel) || 'คลังที่นำเข้า',
      transferToken: normalizeText(raw.transferToken),
      operator: normalizeText(raw.operator),
      items: normalized
    };
  }

  function effectiveBarcode(item) {
    return item.scannedBarcode || item.currentBarcode || '';
  }

  function isChanged(item) {
    return Boolean(item.scannedBarcode && item.scannedBarcode !== item.currentBarcode);
  }

  function isValidBarcode(value) {
    if (!/^\d{8}$|^\d{12}$|^\d{13}$/.test(value)) return false;
    const digits = [...value].map(Number);
    const check = digits.pop();
    const sum = digits.reverse().reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
    return (10 - (sum % 10)) % 10 === check;
  }

  function duplicateOwner(barcode, exceptRecord) {
    if (!state.job) return null;
    return state.job.items.find(item => item.tradeRecordNumber !== exceptRecord && effectiveBarcode(item) === barcode) || null;
  }

  function filteredItems() {
    if (!state.job) return [];
    const q = state.query.toLocaleLowerCase('th-TH');
    const rows = state.job.items.filter(item => {
      const barcode = effectiveBarcode(item);
      const matchesQuery = !q || [item.code,item.name,item.tradeName,item.vendor,item.manufacturer,barcode,item.location].some(value => String(value).toLocaleLowerCase('th-TH').includes(q));
      const matchesStatus = state.status === 'all' || (state.status === 'linked' ? Boolean(barcode) : !barcode) || (state.status === 'changed' ? isChanged(item) : false);
      return matchesQuery && matchesStatus && (!state.dosageForm || item.dosageForm === state.dosageForm) && (!state.location || item.location === state.location);
    });
    const compare = (a,b) => String(a).localeCompare(String(b),'th',{numeric:true,sensitivity:'base'});
    rows.sort((a,b) => {
      if (state.sort === 'name-desc') return compare(b.name,a.name);
      if (state.sort === 'code-asc') return compare(a.code,b.code);
      if (state.sort === 'code-desc') return compare(b.code,a.code);
      if (state.sort === 'unlinked') return Number(Boolean(effectiveBarcode(a))) - Number(Boolean(effectiveBarcode(b))) || compare(a.name,b.name);
      return compare(a.name,b.name);
    });
    return rows;
  }

  function renderEmpty() {
    $('#warehouseBadge').textContent = 'ยังไม่โหลดไฟล์งาน';
    $('#sideExport').disabled = true;
    $('#app').innerHTML = `
      <section class="emptyWorkspace"><div class="importCard">
        <div class="importIcon">▦</div>
        <h1>นำเข้าไฟล์งาน Barcode</h1>
        <p>ไฟล์ต้องส่งออกมาจากระบบ INVC เดิม ข้อมูลจะถูกอ่านและบันทึกในอุปกรณ์นี้เท่านั้น ไม่ถูกอัปโหลดขึ้น GitHub</p>
        <div class="importSteps"><div><b>1 · นำเข้า</b><span>เลือกไฟล์งานจากเว็บ INVC</span></div><div><b>2 · สแกน</b><span>ค้นหารายการและใช้กล้องอ่าน Barcode</span></div><div><b>3 · ส่งกลับ</b><span>ดาวน์โหลดผลเพื่อนำกลับไปตรวจสอบ</span></div></div>
        <button id="mainImport" class="primary" type="button">เลือกไฟล์งานจาก INVC</button>
        <small class="formatHelp">รองรับไฟล์ JSON รูปแบบ invc-barcode-work/v1</small>
      </div></section>`;
    $('#mainImport').onclick = chooseFile;
  }

  function render() {
    if (!state.job) return renderEmpty();
    const all = state.job.items;
    const linked = all.filter(item => effectiveBarcode(item)).length;
    const unlinked = all.length - linked;
    const changed = all.filter(isChanged).length;
    const percent = all.length ? Math.round(linked * 10000 / all.length) / 100 : 0;
    const dosageForms = [...new Set(all.map(item => item.dosageForm).filter(Boolean))].sort((a,b) => a.localeCompare(b,'th'));
    const locations = [...new Set(all.map(item => item.location).filter(Boolean))].sort((a,b) => a.localeCompare(b,'th',{numeric:true}));
    const results = filteredItems();
    const pages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages);
    const start = (state.page - 1) * PAGE_SIZE;
    const rows = results.slice(start, start + PAGE_SIZE);
    $('#warehouseBadge').textContent = state.job.warehouseLabel;
    $('#sideExport').disabled = changed === 0;

    $('#app').innerHTML = `
      <div class="heading"><p class="eyebrow">${esc(state.job.warehouseLabel)} • ข้อมูลในอุปกรณ์</p><h1>จัดการ Barcode</h1><p>ค้นหา กรอง สแกน และเตรียมผลลัพธ์เพื่อนำกลับไปตรวจสอบในระบบ INVC</p></div>
      <section class="metrics" aria-label="สถานะการผูก Barcode">
        <button class="metric unlinked ${state.status==='unlinked'?'active':''}" data-status="unlinked"><span>ยังไม่ผูก</span><strong>${fmt(unlinked)}</strong><small>รายการที่ต้องดำเนินการ</small></button>
        <button class="metric linked ${state.status==='linked'?'active':''}" data-status="linked"><span>ผูกแล้ว</span><strong>${fmt(linked)}</strong><small>${fmt(percent)}%</small></button>
        <button class="metric ready ${state.status==='changed'?'active':''}" data-status="changed"><span>พร้อมส่งกลับ</span><strong>${fmt(changed)}</strong><small>รายการที่สแกนใหม่</small></button>
        <div class="progressCard"><div><span>ความคืบหน้า</span><b>${fmt(percent)}%</b></div><progress max="100" value="${percent}"></progress><small>บันทึกอัตโนมัติในอุปกรณ์นี้</small></div>
      </section>
      <section class="panel">
        <div class="jobBar"><span>ชุดงาน <b>${esc(state.job.batchId)}</b> · นำเข้า ${formatDateTime(state.job.importedAt)}</span><div class="jobBarActions"><button id="replaceJob" class="ghost" type="button">เปลี่ยนไฟล์</button><button id="clearJob" class="ghost danger" type="button">ล้างงาน</button></div></div>
        <div class="toolbar"><label>ค้นหารายการ<input id="searchInput" maxlength="100" value="${esc(state.query)}" placeholder="รหัส ชื่อรายการ ชื่อการค้า บริษัท หรือ Barcode" autocomplete="off"></label><div class="toolbarActions"><button id="searchButton" class="primary" type="button">ค้นหา</button><button id="scanSearch" class="secondary" type="button">สแกน Barcode</button><button id="exportButton" class="ghost" type="button" ${changed?'':'disabled'}>ส่งออกผล</button></div></div>
        <div class="filters"><label>รูปแบบยา<select id="dosageFilter"><option value="">ทุกรูปแบบยา</option>${dosageForms.map(value => `<option ${value===state.dosageForm?'selected':''}>${esc(value)}</option>`).join('')}</select></label><label>Location<select id="locationFilter"><option value="">ทุก Location</option>${locations.map(value => `<option ${value===state.location?'selected':''}>${esc(value)}</option>`).join('')}</select></label><label>เรียงลำดับ<select id="sortFilter"><option value="name-asc" ${state.sort==='name-asc'?'selected':''}>ชื่อรายการ A–Z</option><option value="name-desc" ${state.sort==='name-desc'?'selected':''}>ชื่อรายการ Z–A</option><option value="code-asc" ${state.sort==='code-asc'?'selected':''}>รหัสน้อยไปมาก</option><option value="code-desc" ${state.sort==='code-desc'?'selected':''}>รหัสมากไปน้อย</option><option value="unlinked" ${state.sort==='unlinked'?'selected':''}>ยังไม่ผูกขึ้นก่อน</option></select></label><button id="clearFilters" class="ghost" type="button">ล้างตัวกรอง</button></div>
        <div class="statusTabs"><button data-status="unlinked" class="${state.status==='unlinked'?'active':''}">ยังไม่ผูก <b>${fmt(unlinked)}</b></button><button data-status="linked" class="${state.status==='linked'?'active':''}">ผูกแล้ว <b>${fmt(linked)}</b></button><button data-status="changed" class="${state.status==='changed'?'active':''}">พร้อมส่งกลับ <b>${fmt(changed)}</b></button><button data-status="all" class="${state.status==='all'?'active':''}">ทั้งหมด <b>${fmt(all.length)}</b></button></div>
        <div class="resultHead"><p>พบ <b>${fmt(results.length)}</b> รายการ</p><span>หน้า ${fmt(state.page)} / ${fmt(pages)}</span></div>
        <div class="cardList">${rows.length ? rows.map(renderCard).join('') : '<div class="emptyResult">ไม่พบรายการตามคำค้นหาและตัวกรอง</div>'}</div>
        <div class="pagination"><button id="prevPage" ${state.page<=1?'disabled':''}>ก่อนหน้า</button><span>หน้า ${fmt(state.page)} จาก ${fmt(pages)}</span><button id="nextPage" ${state.page>=pages?'disabled':''}>ถัดไป</button></div>
      </section>`;
    wirePage(pages);
  }

  function renderCard(item) {
    const barcode = effectiveBarcode(item);
    const changed = isChanged(item);
    const badge = changed ? ['changed','พร้อมส่งกลับ'] : barcode ? ['linked','ผูกแล้ว'] : ['unlinked','ยังไม่ผูก'];
    return `<article class="itemCard">
      <div class="cardHead"><small>${esc(item.code)}${item.tradeName ? ` · ${esc(item.tradeName)}` : ''}</small><span class="stateBadge ${badge[0]}">${badge[1]}</span></div>
      <h3>${esc(item.name)}</h3>
      <div class="facts"><span><small>รูปแบบยา</small><b>${esc(item.dosageForm || '-')}</b></span><span><small>ขนาดบรรจุ</small><b>${fmt(item.packRatio)} ${esc(item.unit)}</b></span><span><small>Location</small><b>${esc(item.location || '-')}</b></span><span><small>Lot ที่ตรงกัน</small><b>${fmt(item.lotCount || item.lots.length)}</b></span></div>
      <div class="companies"><p>ผู้ผลิต: <b>${esc(item.manufacturer || item.manufacturerCode || '-')}</b></p><p>ผู้จำหน่าย: ${esc(item.vendor || item.vendorCode || '-')}</p></div>
      <div class="barcodeCurrent"><small>${changed ? 'Barcode ใหม่ · รอตรวจสอบใน INVC' : 'Barcode ปัจจุบัน'}</small><code>${esc(barcode || 'ยังไม่มี Barcode')}</code></div>
      <button class="scanItem" data-record="${item.tradeRecordNumber}" type="button">${barcode ? 'ดู / แก้ไข Barcode' : 'สแกน / กำหนด Barcode'}</button>
    </article>`;
  }

  function wirePage(pages) {
    document.querySelectorAll('[data-status]').forEach(button => button.onclick = () => { state.status = button.dataset.status; state.page = 1; render(); });
    const input = $('#searchInput');
    const search = () => { state.query = input.value.trim(); state.page = 1; render(); };
    $('#searchButton').onclick = search;
    input.onkeydown = event => { if (event.key === 'Enter') search(); };
    $('#scanSearch').onclick = () => openScanner(code => { state.query = code; state.status = 'all'; state.page = 1; render(); });
    $('#exportButton').onclick = exportResults;
    $('#replaceJob').onclick = chooseFile;
    $('#clearJob').onclick = clearJob;
    $('#dosageFilter').onchange = event => { state.dosageForm = event.target.value; state.page = 1; render(); };
    $('#locationFilter').onchange = event => { state.location = event.target.value; state.page = 1; render(); };
    $('#sortFilter').onchange = event => { state.sort = event.target.value; state.page = 1; render(); };
    $('#clearFilters').onclick = () => { state.query=''; state.status='unlinked'; state.dosageForm=''; state.location=''; state.sort='name-asc'; state.page=1; render(); };
    document.querySelectorAll('[data-record]').forEach(button => button.onclick = () => openAssign(Number(button.dataset.record)));
    $('#prevPage').onclick = () => { if (state.page > 1) { state.page--; render(); scrollTo({top:0,behavior:'smooth'}); } };
    $('#nextPage').onclick = () => { if (state.page < pages) { state.page++; render(); scrollTo({top:0,behavior:'smooth'}); } };
  }

  function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? esc(value) : date.toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'numeric'});
  }

  function formatDateTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('th-TH',{dateStyle:'medium',timeStyle:'short'});
  }

  function openAssign(record) {
    const item = state.job.items.find(row => row.tradeRecordNumber === record);
    if (!item) return;
    const dialog = $('#assignDialog');
    const lots = item.lots.length ? item.lots : Array.from({length:item.lotCount || 0},(_,i) => ({lot:`รายการที่ ${i+1}`,expire:null,qty:0,barcode:item.currentBarcode}));
    $('#assignBody').innerHTML = `<div class="assignContent">
      <button id="assignClose" class="dialogClose" type="button" aria-label="ปิด">×</button>
      <div class="assignHeader"><small>${esc(item.code)}</small><h2>${esc(item.name)}</h2><p>${esc(item.tradeName || 'ไม่ระบุชื่อการค้า')}</p></div>
      <div class="assignMeta"><div><span>ผู้ผลิต</span><b>${esc(item.manufacturer || item.manufacturerCode || '-')}</b></div><div><span>ขนาดบรรจุ</span><b>${fmt(item.packRatio)} ${esc(item.unit)}</b></div><div><span>Lot ที่จะนำไปเทียบ</span><b>${fmt(item.lotCount || item.lots.length)} รายการ</b></div></div>
      <label>Barcode<div class="barcodeInputRow"><input id="barcodeValue" inputmode="numeric" maxlength="13" value="${esc(effectiveBarcode(item))}" placeholder="ตัวเลข 8, 12 หรือ 13 หลัก" autocomplete="off"><button id="openCamera" class="secondary" type="button">เปิดกล้อง</button></div></label>
      <div class="warning">ข้อมูลนี้ยังไม่เขียนเข้า SQL Server ระบบ INVC เดิมจะตรวจ Barcode ซ้ำ บริษัทผู้ผลิต และขนาดบรรจุอีกครั้งก่อนอัปเดต</div>
      <div class="lotTable"><table><thead><tr><th>Lot</th><th>หมดอายุ</th><th>คงเหลือ</th><th>Barcode เดิม</th></tr></thead><tbody>${lots.length ? lots.map(lot => `<tr><td>${esc(lot.lot || '-')}</td><td>${formatDate(lot.expire)}</td><td>${fmt(lot.qty)}</td><td>${esc(lot.barcode || '-')}</td></tr>`).join('') : '<tr><td colspan="4">ไม่มีรายละเอียด Lot ในไฟล์งาน</td></tr>'}</tbody></table></div>
      <div class="formActions"><button id="assignCancel" class="ghost" type="button">ยกเลิก</button><button id="assignSave" class="primary" type="button">บันทึกในอุปกรณ์</button></div>
    </div>`;
    dialog.showModal();
    const close = () => dialog.close();
    $('#assignClose').onclick = close;
    $('#assignCancel').onclick = close;
    const input = $('#barcodeValue');
    $('#openCamera').onclick = () => openScanner(code => { input.value = code; input.focus(); });
    $('#assignSave').onclick = async () => {
      const barcode = input.value.trim();
      if (!isValidBarcode(barcode)) return toast('Barcode ต้องเป็นตัวเลข 8, 12 หรือ 13 หลัก และ check digit ต้องถูกต้อง', true);
      const duplicate = duplicateOwner(barcode, item.tradeRecordNumber);
      if (duplicate) return toast(`Barcode นี้อยู่กับ ${duplicate.code} ${duplicate.name}`, true);
      item.scannedBarcode = barcode;
      item.scannedAt = nowIso();
      item.operator = state.job.operator || '';
      await dbSet(state.job);
      dialog.close();
      toast('บันทึก Barcode ในอุปกรณ์แล้ว');
      render();
    };
  }

  async function openScanner(onCode) {
    const dialog = $('#scannerDialog');
    const video = $('#scannerVideo');
    const status = $('#scannerStatus');
    let stopped = false;
    let controls = null;
    let stream = null;
    let timer = null;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      try { controls?.stop(); } catch (_) {}
      stream?.getTracks().forEach(track => track.stop());
      video.srcObject = null;
      if (dialog.open) dialog.close();
    };
    state.scannerStop?.();
    state.scannerStop = stop;
    $('#scannerClose').onclick = stop;
    $('#scannerManual').onclick = stop;
    dialog.oncancel = event => { event.preventDefault(); stop(); };
    status.textContent = 'กำลังเปิดกล้อง…';
    dialog.showModal();
    let last = '', seen = 0;
    const accept = raw => {
      const value = String(raw || '').replace(/\s/g,'');
      if (!/^\d{8}$|^\d{12}$|^\d{13}$/.test(value)) return;
      if (value === last) seen++; else { last = value; seen = 1; }
      status.textContent = `กำลังยืนยัน ${value} • ${seen}/2`;
      if (seen >= 2) { stop(); onCode(value); }
    };
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('เบราว์เซอร์ไม่อนุญาตให้เปิดกล้อง กรุณาตรวจสิทธิ Camera');
      if ('BarcodeDetector' in window) {
        stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});
        video.srcObject = stream;
        await video.play();
        const detector = new BarcodeDetector({formats:['ean_8','ean_13','upc_a','upc_e','code_128']});
        let busy = false;
        status.textContent = 'กำลังสแกน • ถือกล้องให้นิ่ง';
        timer = setInterval(async () => {
          if (busy || video.readyState < 2 || stopped) return;
          busy = true;
          try { const codes = await detector.detect(video); if (codes[0]) accept(codes[0].rawValue); } catch (_) {} finally { busy = false; }
        }, 280);
      } else if (window.ZXingBrowser?.BrowserMultiFormatReader) {
        const reader = new ZXingBrowser.BrowserMultiFormatReader(undefined,{delayBetweenScanAttempts:250,delayBetweenScanSuccess:500});
        status.textContent = 'กำลังสแกน • ถือกล้องให้นิ่ง';
        controls = await reader.decodeFromConstraints({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false}, video, (result,error) => { if (result) accept(result.getText()); });
      } else {
        throw new Error('ไม่พบตัวอ่าน Barcode ในอุปกรณ์นี้');
      }
    } catch (error) {
      status.textContent = error.name === 'NotAllowedError' ? 'ยังไม่ได้อนุญาตใช้กล้อง กรุณาอนุญาต Camera ในการตั้งค่าเบราว์เซอร์' : error.message;
    }
  }

  function chooseFile() {
    const input = $('#fileInput');
    input.value = '';
    input.click();
  }

  async function importFile(file) {
    if (!file || file.size > 25 * 1024 * 1024) throw new Error('ไฟล์งานต้องมีขนาดไม่เกิน 25 MB');
    const text = await file.text();
    const raw = JSON.parse(text);
    const job = normalizeJob(raw);
    if (!job.operator) {
      job.operator = normalizeText(prompt('ชื่อผู้ปฏิบัติงานสำหรับบันทึกในไฟล์ผลลัพธ์', ''));
    }
    state.job = job;
    state.query=''; state.status='unlinked'; state.dosageForm=''; state.location=''; state.sort='name-asc'; state.page=1;
    await dbSet(job);
    render();
    toast(`นำเข้า ${fmt(job.items.length)} รายการเรียบร้อย`);
  }

  async function clearJob() {
    if (!confirm('ล้างไฟล์งานและผลสแกนที่เก็บอยู่ในอุปกรณ์นี้ใช่ไหม?')) return;
    await dbClear();
    state.job = null;
    render();
    toast('ล้างข้อมูลในอุปกรณ์แล้ว');
  }

  function exportResults() {
    if (!state.job) return;
    const results = state.job.items.filter(isChanged).map(item => ({
      tradeRecordNumber: item.tradeRecordNumber,
      workingCode: item.code,
      manufacturerCode: item.manufacturerCode,
      packRatio: item.packRatio,
      expectedBarcode: item.currentBarcode,
      newBarcode: item.scannedBarcode,
      transferProof: item.transferProof,
      scannedAt: item.scannedAt,
      operator: item.operator || state.job.operator || ''
    }));
    if (!results.length) return toast('ยังไม่มีรายการใหม่สำหรับส่งกลับ', true);
    const payload = {
      schema: 'invc-barcode-result/v1',
      batchId: state.job.batchId,
      sourceExportedAt: state.job.exportedAt,
      warehouse: state.job.warehouse,
      warehouseLabel: state.job.warehouseLabel,
      transferToken: state.job.transferToken,
      exportedAt: nowIso(),
      operator: state.job.operator || '',
      resultCount: results.length,
      results
    };
    const blob = new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[-:]/g,'').slice(0,15);
    link.href = url;
    link.download = `INVC-Barcode-Result-${state.job.batchId}-${stamp}.json`.replace(/[^a-zA-Z0-9._-]/g,'_');
    link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
    toast(`ส่งออก ${fmt(results.length)} รายการแล้ว`);
  }

  function wireShell() {
    $('#sideImport').onclick = chooseFile;
    $('#sideExport').onclick = exportResults;
    $('#fileInput').onchange = async event => {
      try { await importFile(event.target.files[0]); }
      catch (error) { toast(error instanceof SyntaxError ? 'ไฟล์ JSON ไม่ถูกต้อง' : error.message, true); }
    };
    const sidebar = $('#sidebar'), scrim = $('#scrim');
    const toggleMenu = open => { sidebar.classList.toggle('open',open); scrim.classList.toggle('open',open); };
    $('#menuButton').onclick = () => toggleMenu(!sidebar.classList.contains('open'));
    scrim.onclick = () => toggleMenu(false);
  }

  async function init() {
    wireShell();
    try { state.job = await dbGet(); }
    catch (_) { toast('อุปกรณ์นี้ไม่อนุญาตพื้นที่เก็บข้อมูลถาวร', true); }
    render();
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  init();
})();
