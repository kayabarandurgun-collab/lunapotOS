// Hazırlanmış gerçek alış kayıtlarının yükleme ekranı.
//
// Dosya tarayıcıda okunur, özeti çıkarılır ve ÖNCE kontrol edilir. Uygulandığında yalnızca
// TASLAK fatura açılır: cari borç "Muhasebeleştir", depo girişi "Mal teslimi" ile oluşur.
// Aynı dosya ya da daha önce aktarılmış fatura ikinci kez kayıt yaratmaz.
// Tedarikçi adı bilinmeyen kayıt uydurulmaz; adı sen yazana kadar incelemede kalır.
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const num = v => new Intl.NumberFormat('tr-TR').format(v || 0);
const money = c => new Intl.NumberFormat('tr-TR', {style: 'currency', currency: 'TRY'}).format((c || 0) / 100);

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function openStagedImport(api, onDone) {
  const dialog = document.createElement('dialog');
  dialog.className = 'staged-import';
  dialog.innerHTML = `<form method="dialog"><button class="text-button" aria-label="Kapat">✕</button></form>
    <h2>Hazır alış kaydı dosyası</h2>
    <p>Hazırlanmış alış faturalarını (JSON) yükle. Önce kontrol edilir; uygularsan yalnızca <b>taslak</b> fatura açılır —
      cari borç ve stok bu adımda yazılmaz.</p>
    <label>Kayıt dosyası<input type="file" accept=".json,application/json" data-file></label>
    <div data-suppliers hidden><h3>Tedarikçi adları</h3>
      <p class="help">Dosyada yalnız vergi numarası var. Ad yazmadığın tedarikçinin faturası açılmaz, incelemede kalır. Marka adı değil, faturayı kesen firmanın adını yaz.</p>
      <div data-supplier-fields></div></div>
    <div role="status" data-summary>Dosya seçilmesini bekliyor.</div>
    <details><summary>Kayıt ayrıntıları</summary><div data-detail></div></details>
    <p role="alert" class="error" data-error></p>
    <div class="ac-actions"><button class="secondary" data-preview type="button">Kontrol et</button>
      <button class="primary" data-apply type="button" disabled>Taslakları oluştur</button></div>`;
  document.body.append(dialog);
  dialog.showModal();

  const $ = s => dialog.querySelector(s);
  let items = null, sha = '', name = '', busy = false, ready = false;
  const close = () => { if (!busy) { dialog.remove(); onDone?.(); } };
  dialog.addEventListener('close', close);
  dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); });

  const suppliers = () => Object.fromEntries([...dialog.querySelectorAll('[data-vkn]')]
    .map(input => [input.dataset.vkn, input.value.trim()]).filter(([, v]) => v));

  function show(report, applied) {
    const c = report.counts;
    $('[data-summary]').textContent = (applied ? 'Uygulandı: ' : 'Ön kontrol: ') +
      num(c.created) + (applied ? ' taslak açıldı' : ' kayıt açılacak') + ', ' + num(c.skipped) + ' atlandı (zaten var), ' +
      num(c.review) + ' inceleme, ' + num(c.failed) + ' başarısız · ' + num(c.pending_lines) + ' satır ürün eşleşmesi bekliyor.';
    const detail = $('[data-detail]');
    detail.replaceChildren();
    for (const r of report.results || []) {
      const p = document.createElement('p');
      p.textContent = r.invoice_no + ' · ' + ({created: 'Açıldı', skipped: 'Atlandı', review: 'İnceleme', failed: 'Başarısız'}[r.outcome] || r.outcome) +
        (r.detail ? ' — ' + r.detail : '');
      detail.append(p);
    }
    if (report.missing_suppliers?.length) {
      const p = document.createElement('p');
      p.textContent = 'Adı bekleyen vergi numaraları: ' + report.missing_suppliers.join(', ');
      detail.append(p);
    }
  }

  async function run(applied) {
    if (busy) return;
    busy = true; $('[data-error]').textContent = '';
    dialog.querySelectorAll('button,input').forEach(x => x.disabled = true);
    try {
      if (!items) throw new Error('Önce kayıt dosyasını seç.');
      const body = {kind: 'purchase_invoices', source_name: name, sha256: sha, items, suppliers: suppliers()};
      const report = await api('/invoices/staged/' + (applied ? 'apply' : 'preview'), body);
      show(report, applied);
      ready = !applied && report.counts.created > 0;
    } catch (e) {
      ready = false;
      $('[data-error]').textContent = e.message + ' Daha önce açılan taslaklar korunur; düzeltip yeniden deneyebilirsin.';
    } finally {
      busy = false;
      dialog.querySelectorAll('button,input').forEach(x => x.disabled = false);
      $('[data-apply]').disabled = !ready;
    }
  }

  $('[data-file]').addEventListener('change', async e => {
    ready = false; items = null; $('[data-apply]').disabled = true; $('[data-error]').textContent = '';
    try {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5000000) throw new Error('Kayıt dosyası 5 MB’tan küçük olmalı.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      sha = await sha256Hex(bytes);
      name = file.name;
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(parsed) || !parsed.length) throw new Error('Dosyada kayıt listesi bulunamadı.');
      if (!parsed.every(x => x && x.supplier_vkn && x.invoice_no)) throw new Error('Bu dosya alış faturası listesi değil.');
      items = parsed;
      const total = parsed.reduce((n, x) => n + (x.gross_cents || 0), 0);
      $('[data-summary]').textContent = num(parsed.length) + ' fatura okundu · toplam ' + money(total) + '. Kontrol et.';
      const vkns = [...new Set(parsed.map(x => x.supplier_vkn))];
      const box = $('[data-supplier-fields]');
      box.replaceChildren();
      for (const vkn of vkns) {
        const label = document.createElement('label');
        label.textContent = 'VKN ' + vkn + ' — firma adı';
        const input = document.createElement('input');
        input.dataset.vkn = vkn; input.maxLength = 200;
        label.append(input); box.append(label);
      }
      $('[data-suppliers]').hidden = !vkns.length;
      await run(false);
    } catch (err) { $('[data-error]').textContent = err.message; }
  });

  $('[data-preview]').addEventListener('click', () => run(false));
  $('[data-apply]').addEventListener('click', () => { if (ready) run(true); });
  return () => dialog.remove();
}
