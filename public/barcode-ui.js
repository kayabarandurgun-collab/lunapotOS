// Barkod ekranı. YALNIZCA üretim (lp) çalışma alanı.
//
// Okutmak bir aramadır: kartı bulur, stoğu gösterir, HİÇBİR ŞEYİ DEĞİŞTİRMEZ.
// Miktar değiştiren işlemler mevcut Hammadde deposu ekranından yürür; burada
// yalnızca hangi karta gidileceği ve ne kadar sayıldığı hazırlanır.
//
// Üç giriş yolu: USB/Bluetooth okuyucu (klavye gibi yazar), telefon kamerası
// (tarayıcı destekliyorsa) ve elle yazma. Kamera yoksa ekran çalışmaya devam eder.
import {classifyBarcode, normalizeBarcode, packWording, countDifference, createScanGate, BARCODE_KINDS} from './barcode.js';
import {LABEL_SIZES, labelPrintHtml} from './barcode-label.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const qty = milli => milli === null || milli === undefined
  ? 'Görme yetkiniz yok'
  : new Intl.NumberFormat('tr-TR', {maximumFractionDigits: 3}).format(milli / 1000);
const money = cents => cents === null || cents === undefined
  ? 'Görme yetkiniz yok'
  : new Intl.NumberFormat('tr-TR', {style: 'currency', currency: 'TRY'}).format(cents / 100);
const badge = (label, type = 'neutral') => `<span class="v2-badge ${type}">${esc(label)}</span>`;
const card = (title, content, action = '') => `<section class="v2-card"><div class="v2-card-head"><h2>${esc(title)}</h2>${action}</div>${content}</section>`;
const act = (label, action, id = '', secondary = true) => `<button type="button" class="${secondary ? 'secondary' : 'primary'}" data-bc="${action}" data-id="${esc(id)}">${esc(label)}</button>`;

export function mountBarcodes(root, namespace = 'lp') {
  if (namespace !== 'lp') throw new Error('Barkod yönetimi yalnızca üretim çalışma alanındadır.');
  const controller = new AbortController();
  const gate = createScanGate(1500);
  const state = {
    tab: 'scan', result: null, list: [], cards: {materials: [], products: []},
    tally: new Map(), error: '', busy: false, disposed: false, camera: null,
    labelSize: 'medium', labelCopies: 1, loaded: false
  };
  const $ = selector => root.querySelector(selector);

  async function api(path, body, method) {
    const response = await fetch(`/api/${namespace}${path}`, {
      signal: controller.signal,
      ...(method ? {method} : {}),
      ...(body === undefined ? {} : {method: method || 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
    });
    let data; try { data = await response.json(); } catch { throw new Error('Sunucuya ulaşılamadı. Lütfen yeniden deneyin.'); }
    if (!response.ok) throw new Error(data.error || 'İşlem tamamlanamadı.');
    return data;
  }

  async function loadCards() {
    if (state.cards.materials.length || state.cards.products.length) return;
    const data = await api('/data');
    state.cards = {materials: data.materials || [], products: (data.products || []).filter(p => p.inventory_kind !== 'material')};
  }
  async function loadList() {
    state.list = (await api('/barcodes')).barcodes;
    state.loaded = true;
  }

  // Okutma: yalnızca arama. Kamera aynı kodu tekrar okursa ikinci kez işlenmez.
  async function scan(raw, {manual = false} = {}) {
    let code;
    try { code = normalizeBarcode(raw); } catch (error) { throw new Error(error.message); }
    if (!gate.accept(code, Date.now(), manual)) return;
    state.result = await api('/barcodes/lookup?code=' + encodeURIComponent(code));
    if (state.tab === 'count' && state.result.found && state.result.active) {
      const link = state.result.link;
      const current = state.tally.get(link.material_id || link.product_id) || {link, scans: 0, counted_milli: 0};
      current.scans += 1;
      current.counted_milli += link.scan_quantity_milli;
      current.system_milli = state.result.stock.quantity_milli;
      state.tally.set(link.material_id || link.product_id, current);
    }
    render();
  }

  function resultPanel() {
    const r = state.result;
    if (!r) return '<div class="v2-empty"><h3>Okutmayı bekliyorum.</h3><p>Okuyucuyu kutuya tutun, telefonun kamerasını açın ya da barkodu elle yazın.</p></div>';
    const sinif = `${BARCODE_KINDS[r.classification.kind] || r.classification.kind}${r.classification.gs1 ? '' : ' · GS1 değil'}`;
    if (!r.found) return `<div class="notice"><strong>Bu barkod tanımlı değil.</strong><br>${esc(r.notice)}</div>
      <div class="v2-card-body"><p><strong>${esc(r.code)}</strong> · ${esc(sinif)}</p><p class="help">${esc(r.classification.note)}</p>
      <div class="ac-actions">${act('Var olan bir karta bağla', 'link-new', r.code, false)}</div>
      <p class="help">Yeni bir hammadde veya ürün kartı açmak için Hammaddeler / Ürünler ekranını kullanın, sonra buradan barkodu bağlayın. Bu ekran kendiliğinden kart açmaz.</p></div>`;
    const link = r.link;
    const stok = r.stock && r.stock.quantity_milli !== null
      ? `<div class="v2-summary-line"><span>Depodaki miktar</span><strong>${esc(qty(r.stock.quantity_milli))} ${esc(link.unit)}</strong></div>
         <div class="v2-summary-line"><span>Stok değeri</span><strong>${esc(money(r.stock.value_cents))}</strong></div>`
      : '<p class="help">Bu bir ürün kartı; hammadde deposu miktarı taşımaz.</p>';
    return `<div class="v2-card-body">
      ${r.active ? badge('Bağlantı açık', 'success') : badge('Bağlantı kapalı', 'warning')} ${badge(sinif, r.classification.gs1 ? 'neutral' : 'warning')}
      <h3>${esc(link.card_name)}</h3>
      <p class="help">${esc(link.code)}${link.brand ? ' · ' + esc(link.brand) : ''}${link.pack_label ? ' · ' + esc(link.pack_label) : ''}</p>
      <p><strong>${esc(packWording(link, link.unit))}</strong></p>
      ${stok}
      ${r.active ? '' : `<div class="notice">${esc(r.notice)}</div>`}
      <div class="notice subtle">${esc(r.notice)}</div>
      <div class="ac-actions">${act('Etiket bas', 'label', link.id)}${act('Bağlantıyı düzenle', 'edit', link.id)}</div>
    </div>`;
  }

  function scanPanel() {
    const cameraSupported = typeof window !== 'undefined' && 'BarcodeDetector' in window;
    return `<form class="v2-toolbar" data-bc-form="scan">
        <label>Barkod<input name="code" autocomplete="off" autofocus placeholder="Okuyucuyu tutun veya elle yazın" maxlength="48" inputmode="text"></label>
        <button class="primary" type="submit">Ara</button>
        ${cameraSupported
          ? act(state.camera ? 'Kamerayı kapat' : 'Kamerayı aç', 'camera')
          : '<span class="muted">Bu tarayıcı kamera ile barkod okumayı desteklemiyor; okuyucu veya elle giriş kullanın.</span>'}
      </form>
      <div class="bc-camera" data-bc-camera ${state.camera ? '' : 'hidden'}><video data-bc-video playsinline muted></video></div>
      ${card('Okutma sonucu', resultPanel())}`;
  }

  function countPanel() {
    const rows = [...state.tally.values()].map(entry => {
      const fark = countDifference({system_milli: entry.system_milli ?? 0, counted_milli: entry.counted_milli});
      const tip = fark.status === 'match' ? 'success' : fark.status === 'uncounted' ? 'neutral' : 'warning';
      return `<tr>
        <td><strong>${esc(entry.link.card_name)}</strong><small>${esc(entry.link.code)} · ${entry.scans} okutma</small></td>
        <td>${esc(qty(entry.system_milli))} ${esc(entry.link.unit)}</td>
        <td>${esc(qty(entry.counted_milli))} ${esc(entry.link.unit)}</td>
        <td>${badge(fark.wording, tip)}<small>${fark.difference_milli === null ? '' : esc(qty(fark.difference_milli)) + ' ' + esc(entry.link.unit)}</small></td>
        <td>${entry.link.target_kind === 'material' && fark.status !== 'match'
          ? act('Farkı düzelt', 'fix', entry.link.material_id, false)
          : '—'}</td></tr>`;
    }).join('');
    return `<div class="notice subtle">Sayımda okutmak stoğu değiştirmez. Önce farkları görürsünüz; düzeltmeyi ayrıca ve gerekçesiyle siz kaydedersiniz. <strong>Sayılmayan kartlar sıfırlanmaz.</strong></div>
      ${scanPanel()}
      ${card('Sayım listesi', state.tally.size
        ? `<div class="table-wrap"><table class="v2-table"><thead><tr><th>Kart</th><th>Sistemde</th><th>Sayılan</th><th>Fark</th><th>İşlem</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="v2-empty"><h3>Henüz okutma yok.</h3><p>Rafı okutmaya başlayın; her okutma ambalaj tanımına göre miktara eklenir.</p></div>',
        state.tally.size ? act('Listeyi temizle', 'clear-tally') : '')}`;
  }

  function listPanel() {
    const rows = state.list.map(b => `<tr>
      <td><strong>${esc(b.code)}</strong><small>${esc(BARCODE_KINDS[b.source === 'internal' ? 'internal' : b.source === 'gs1' ? 'ean13' : 'other'])}${b.source === 'gs1' ? '' : ' · GS1 değil'}</small></td>
      <td>${esc(b.card_name)}<small>${b.target_kind === 'material' ? 'Hammadde' : 'Ürün'}${b.sku ? ' · ' + esc(b.sku) : ''}</small></td>
      <td>${esc(b.brand || '—')}</td>
      <td>${esc(b.pack_wording)}<small>${esc(b.pack_label || '')}</small></td>
      <td>${b.active ? badge('Açık', 'success') : badge('Kapalı')}</td>
      <td>${act('Düzenle', 'edit', b.id)}${act('Etiket', 'label', b.id)}</td></tr>`).join('');
    return card('Tanımlı barkodlar', state.list.length
      ? `<div class="table-wrap"><table class="v2-table"><thead><tr><th>Barkod</th><th>Kart</th><th>Marka</th><th>Ambalaj</th><th>Durum</th><th>İşlem</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="v2-empty"><h3>Henüz barkod tanımlı değil.</h3><p>Bir kutuyu okutup “var olan bir karta bağla” diyerek başlayabilirsiniz.</p></div>',
      `${act('Barkod bağla', 'link-new', '', false)}${state.list.length ? act('Seçili boyutta hepsini bas', 'label-all') : ''}`);
  }

  function render() {
    if (state.disposed) return;
    const tabs = [['scan', 'Okut ve bul'], ['count', 'Sayım'], ['list', 'Tanımlı barkodlar']];
    root.innerHTML = `<div class="v2-page">
      <div class="page-heading"><div><span class="eyebrow">LUNAPOT ÇALIŞMA ALANI</span><h1>Barkod</h1>
      <p>Kutuyu okut, kartı bul, ne kadar var gör. Okutmak stoğu değiştirmez; miktar değiştiren işlemleri ayrıca onaylarsın.</p></div></div>
      <div class="notice" data-bc-error role="alert" ${state.error ? '' : 'hidden'}>${esc(state.error)}</div>
      <nav class="v2-tabs" aria-label="Barkod ekranı">${tabs.map(([key, label]) => `<button type="button" data-bc="tab" data-id="${key}" class="${state.tab === key ? 'active' : ''}" aria-current="${state.tab === key ? 'page' : 'false'}">${label}</button>`).join('')}</nav>
      <section data-bc-body>${state.tab === 'scan' ? scanPanel() : state.tab === 'count' ? countPanel() : state.loaded ? listPanel() : '<div class="loading">Barkodlar yükleniyor…</div>'}</section></div>`;
    const input = $('[data-bc-form="scan"] input[name=code]');
    input?.focus();
    if (state.camera) attachCamera();
  }

  function showError(message) {
    state.error = message;
    const box = $('[data-bc-error]');
    if (box) { box.hidden = !message; box.textContent = message; }
  }

  async function run(work) {
    if (state.busy) return;
    state.busy = true; showError('');
    try { await work(); }
    catch (error) { if (error.name !== 'AbortError' && !state.disposed) showError(error.message); }
    finally { state.busy = false; }
  }

  // Kamera: destek yoksa ekran çalışmaya devam eder, düğme hiç görünmez.
  async function attachCamera() {
    const video = $('[data-bc-video]');
    if (!video || video.srcObject) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: 'environment'}});
      state.camera = {stream, stop: () => stream.getTracks().forEach(t => t.stop())};
      video.srcObject = stream;
      await video.play();
      const detector = new window.BarcodeDetector();
      const tick = async () => {
        if (state.disposed || !state.camera) return;
        try {
          const found = await detector.detect(video);
          for (const item of found) if (item.rawValue) await run(() => scan(item.rawValue));
        } catch { /* kare okunamadı; sonraki kareye geçilir */ }
        if (state.camera) setTimeout(tick, 300);
      };
      tick();
    } catch (error) {
      state.camera = null;
      showError('Kamera açılamadı: ' + error.message + ' Okuyucu veya elle giriş kullanabilirsiniz.');
      render();
    }
  }
  function stopCamera() {
    state.camera?.stop();
    state.camera = null;
  }

  function linkForm(code = '') {
    const materials = state.cards.materials.map(m => `<option value="material:${esc(m.id)}">${esc(m.name)} · ${esc(m.unit)}</option>`).join('');
    const products = state.cards.products.map(p => `<option value="product:${esc(p.id)}">${esc(p.name)} · ${esc(p.sku)}</option>`).join('');
    root.insertAdjacentHTML('beforeend', `<dialog data-bc-dialog><form class="v2-form" data-bc-form="link">
      <div class="dialog-heading"><h2>Barkodu karta bağla</h2><button type="button" class="icon-button" data-bc="close" aria-label="Kapat">×</button></div>
      <div class="form-body">
        <label>Barkod<input name="code" value="${esc(code)}" maxlength="48" autocomplete="off" placeholder="Kutunun üzerindeki kod"></label>
        <label><input type="checkbox" name="generate_internal"> Ürünün barkodu yok, iç kullanım kodu üret</label>
        <p class="help">İç kullanım kodu “LP-” ile başlar. <strong>GS1 barkodu değildir</strong> ve işletme dışında geçerli değildir.</p>
        <label>Kart<select name="card" required><option value="">Seçin…</option><optgroup label="Hammaddeler">${materials}</optgroup><optgroup label="Ürünler">${products}</optgroup></select></label>
        <p class="help">Kart burada açılmaz. Yeni kart gerekiyorsa önce Hammaddeler veya Ürünler ekranından açın.</p>
        <div class="field-grid">
          <label>Marka<input name="brand" maxlength="200" placeholder="Örn. Klasmann"></label>
          <label>Bir okutma kaç birim?<input name="pack_quantity" type="number" min="0.001" step="0.001" placeholder="Boş bırakırsanız 1"></label>
          <label>Ambalaj açıklaması<input name="pack_label" maxlength="200" placeholder="Örn. 20 kg teneke"></label>
        </div>
        <p class="help">1 teneke okuttuğunuzda 20 kg sayılmasını istiyorsanız buraya 20 yazın. Boş bırakılırsa 1 okutma = 1 birim sayılır.</p>
        <label>Not<textarea name="note" rows="2" maxlength="500"></textarea></label>
        <p class="error" data-bc-form-error role="alert"></p>
      </div>
      <div class="dialog-footer">${act('Vazgeç', 'close')}<button class="primary" type="submit">Bağla</button></div>
    </form></dialog>`);
    $('dialog[data-bc-dialog]').showModal();
  }

  function editForm(link) {
    root.insertAdjacentHTML('beforeend', `<dialog data-bc-dialog><form class="v2-form" data-bc-form="edit" data-id="${esc(link.id)}">
      <div class="dialog-heading"><h2>${esc(link.code)}</h2><button type="button" class="icon-button" data-bc="close" aria-label="Kapat">×</button></div>
      <div class="form-body">
        <p class="help"><strong>${esc(link.card_name)}</strong> kartına bağlı. Barkodun kendisi ve bağlı kart değiştirilemez; yanlışsa bağlantıyı silip yeniden kurun.</p>
        <div class="field-grid">
          <label>Marka<input name="brand" value="${esc(link.brand || '')}" maxlength="200"></label>
          <label>Bir okutma kaç birim?<input name="pack_quantity" type="number" min="0.001" step="0.001" value="${link.pack_quantity_milli ? link.pack_quantity_milli / 1000 : ''}"></label>
          <label>Ambalaj açıklaması<input name="pack_label" value="${esc(link.pack_label || '')}" maxlength="200"></label>
        </div>
        <label>Not<textarea name="note" rows="2" maxlength="500">${esc(link.note || '')}</textarea></label>
        <label><input type="checkbox" name="active" ${link.active ? 'checked' : ''}> Bağlantı açık</label>
        <p class="error" data-bc-form-error role="alert"></p>
      </div>
      <div class="dialog-footer">${act('Bağlantıyı sil', 'delete', link.id)}${act('Vazgeç', 'close')}<button class="primary" type="submit">Kaydet</button></div>
    </form></dialog>`);
    $('dialog[data-bc-dialog]').showModal();
  }

  function labelForm(links) {
    root.insertAdjacentHTML('beforeend', `<dialog data-bc-dialog><form class="v2-form" data-bc-form="label">
      <div class="dialog-heading"><h2>Etiket bas</h2><button type="button" class="icon-button" data-bc="close" aria-label="Kapat">×</button></div>
      <div class="form-body">
        <p class="help">${links.length} barkod için etiket hazırlanacak.</p>
        <div class="field-grid">
          <label>Etiket boyutu<select name="size">${Object.entries(LABEL_SIZES).map(([key, preset]) => `<option value="${key}" ${key === state.labelSize ? 'selected' : ''}>${esc(preset.name)}</option>`).join('')}</select></label>
          <label>Her barkoddan kaç kopya<input name="copies" type="number" min="1" max="200" value="${state.labelCopies}" required></label>
        </div>
        <p class="help">Etiketler Code 128 ile basılır ve gerçek okuyucuyla okunabilir. Kod okunabilir kalmıyorsa daha büyük boyut istenir.</p>
        <p class="error" data-bc-form-error role="alert"></p>
      </div>
      <div class="dialog-footer">${act('Vazgeç', 'close')}<button class="primary" type="submit">Önizle ve yazdır</button></div>
    </form></dialog>`);
    $('dialog[data-bc-dialog]').showModal();
    $('form[data-bc-form="label"]')._links = links;
  }

  const closeDialog = () => { const node = $('dialog[data-bc-dialog]'); node?.close(); node?.remove(); };

  root.addEventListener('click', event => {
    const target = event.target.closest('[data-bc]');
    if (!target || !root.contains(target)) return;
    const action = target.dataset.bc, id = target.dataset.id;
    if (action === 'close') { closeDialog(); return; }
    if (action === 'tab') {
      state.tab = id;
      if (id !== 'scan' && id !== 'count') stopCamera();
      run(async () => { if (id === 'list') await loadList(); render(); });
      return;
    }
    if (action === 'camera') { state.camera ? stopCamera() : (state.camera = {stream: null, stop: () => {}}); render(); return; }
    if (action === 'clear-tally') { state.tally.clear(); gate.reset(); render(); return; }
    if (action === 'link-new') { run(async () => { await loadCards(); linkForm(id); }); return; }
    if (action === 'edit') {
      run(async () => {
        await loadList();
        const link = state.list.find(b => b.id === id) || state.result?.link;
        if (!link) throw new Error('Bağlantı bulunamadı.');
        editForm(link);
      });
      return;
    }
    if (action === 'delete') {
      run(async () => {
        await api('/barcodes/' + encodeURIComponent(id), undefined, 'DELETE');
        closeDialog();
        state.result = null;
        await loadList();
        render();
      });
      return;
    }
    if (action === 'label') {
      run(async () => {
        await loadList();
        const link = state.list.find(b => b.id === id) || state.result?.link;
        if (!link) throw new Error('Bağlantı bulunamadı.');
        labelForm([link]);
      });
      return;
    }
    if (action === 'label-all') { run(async () => { await loadList(); labelForm(state.list.filter(b => b.active)); }); return; }
    if (action === 'fix') {
      // Düzeltme burada yapılmaz: mevcut Hammadde deposu ekranı gerekçe ve tarih ister.
      showError('Farkı düzeltmek için Hammadde deposu ekranındaki sayım kaydını kullanın: orada tarih, referans ve gerekçe istenir ve düzeltme geçmişe yazılır.');
    }
  }, {signal: controller.signal});

  root.addEventListener('submit', event => {
    const form = event.target.closest('form[data-bc-form]');
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    const kind = form.dataset.bcForm, values = Object.fromEntries(new FormData(form));
    const error = form.querySelector('[data-bc-form-error]');
    if (error) error.textContent = '';
    run(async () => {
      try {
        if (kind === 'scan') {
          if (!String(values.code || '').trim()) throw new Error('Barkodu yazın veya okutun.');
          await scan(values.code, {manual: true});
          const input = form.querySelector('input[name=code]');
          if (input) { input.value = ''; input.focus(); }
          return;
        }
        if (kind === 'link') {
          const [target_kind, card_id] = String(values.card || '').split(':');
          if (!target_kind || !card_id) throw new Error('Kart seçin.');
          const body = {
            target_kind,
            [target_kind === 'material' ? 'material_id' : 'product_id']: card_id,
            brand: values.brand, pack_quantity: values.pack_quantity, pack_label: values.pack_label, note: values.note
          };
          if (values.generate_internal) body.generate_internal = true; else body.code = values.code;
          state.result = {found: true, active: true, code: '', classification: {kind: 'other', gs1: false, note: ''}, link: await api('/barcodes', body), stock: {quantity_milli: null}, notice: 'Bağlantı kaydedildi.'};
          closeDialog();
          await loadList();
          state.result = await api('/barcodes/lookup?code=' + encodeURIComponent(state.result.link.code));
          render();
          return;
        }
        if (kind === 'edit') {
          await api('/barcodes/' + encodeURIComponent(form.dataset.id), {
            brand: values.brand, pack_quantity: values.pack_quantity, pack_label: values.pack_label,
            note: values.note, active: values.active === 'on'
          });
          closeDialog();
          await loadList();
          render();
          return;
        }
        if (kind === 'label') {
          const copies = Number(values.copies);
          if (!Number.isSafeInteger(copies) || copies < 1 || copies > 200) throw new Error('Kopya sayısı 1 ile 200 arasında olmalı.');
          state.labelSize = values.size; state.labelCopies = copies;
          const links = form._links || [];
          const labels = [];
          for (const link of links) for (let i = 0; i < copies; i++) labels.push({
            code: link.code,
            title: link.card_name,
            subtitle: [link.brand, link.pack_wording, link.source === 'internal' ? 'İç kullanım kodu' : ''].filter(Boolean).join(' · ')
          });
          const html = labelPrintHtml(labels, {size: values.size});
          const {printDocument} = await import('./doc-engine.js');
          printDocument(html, {title: 'Barkod etiketleri'});
          closeDialog();
        }
      } catch (problem) {
        if (error && error.isConnected) { error.textContent = problem.message; return; }
        throw problem;
      }
    });
  }, {signal: controller.signal});

  render();
  run(async () => { await loadList(); render(); });
  return () => { state.disposed = true; stopCamera(); controller.abort(); closeDialog(); };
}
