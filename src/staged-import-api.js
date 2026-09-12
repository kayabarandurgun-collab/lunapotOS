// Hazırlanmış gerçek kayıtların denetlenebilir aktarımı (şimdilik: alış faturaları).
//
//   GET  /api/invoices/staged/batches   uygulanmış partiler ve sonuçları
//   POST /api/invoices/staged/preview   {kind,source_name,sha256,items,suppliers} — HİÇBİR ŞEY YAZMAZ
//   POST /api/invoices/staged/apply     aynı gövde — mevcut fatura API'si üzerinden taslak oluşturur
//
// Kurallar:
//  · Kendi SQL'ini yazmaz: faturayı mevcut `accountingApi` ucundan geçirir, böylece belge tekilliği,
//    doğrulama ve muhasebe korumaları aynen çalışır.
//  · Taslak oluşturur; BORÇ ve STOK YAZMAZ. Borç muhasebeleştirmede, stok mal tesliminde oluşur.
//  · Aynı kaynak kayıt ikinci kez uygulanamaz: `ec_import_items(kind,source_key)` tekildir.
//    Aynı dosyanın tekrar yüklenmesi, örtüşen dosya veya yarım kalan aktarımın sürdürülmesi
//    ikinci fatura/borç/stok yaratmaz.
//  · Eksik bilgi UYDURULMAZ: tedarikçi adı verilmediyse ya da ürün kimliği belirsizse kayıt
//    "inceleme" olarak bırakılır, satır eşleşmesiz kalır ve fatura kesinleştirilemez.
import {accountingApi} from './accounting.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const id = () => crypto.randomUUID();
const text = (v, label, max = 200) => { if (typeof v !== 'string' || !v.trim() || v.length > max) fail(label + ' alanını kontrol edin.'); return v.trim(); };
const optional = (v, max = 300) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const money = v => { if (!Number.isSafeInteger(v) || v < 0 || v > 10000000000) fail('Tutar tam kuruş olmalı.'); return v; };
const day = v => { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(v).toISOString().slice(0, 10) !== v) fail('Tarih geçersiz.'); return v; };
const KINDS = ['purchase_invoices'];
const MAX_ITEMS = 200;

/** Aynı istek bağlamında mevcut uca iç çağrı: bütün iş kuralları korunur. */
const callApi = (handler, env, path, body) =>
  handler(new Request('https://internal.invalid' + path, {method: 'POST'}), env, path, async () => body);

/** Kaynak faturayı doğrular. Tutarsız belge sessizce düzeltilmez; reddedilir. */
function checkInvoice(item, index) {
  const where = (index + 1) + '. kayıt';
  if (!item || typeof item !== 'object') fail(where + ': kayıt okunamadı.');
  const vkn = optional(item.supplier_vkn, 11);
  if (!/^\d{10,11}$/.test(vkn)) fail(where + ': tedarikçi VKN/TCKN 10 veya 11 rakam olmalı.');
  const invoiceNo = text(item.invoice_no, where + ' fatura numarası', 60);
  const date = day(item.invoice_date);
  const net = money(item.net_cents), vat = money(item.vat_cents), gross = money(item.gross_cents);
  if (net + vat !== gross) fail(where + ': net + KDV, fatura toplamına eşit değil.');
  if (!Array.isArray(item.lines) || !item.lines.length || item.lines.length > 40) fail(where + ': faturada 1–40 satır olmalı.');
  let lineNet = 0, lineVat = 0;
  const lines = item.lines.map((l, i) => {
    const at = where + ' / ' + (i + 1) + '. satır';
    if (!l || typeof l !== 'object') fail(at + ': satır okunamadı.');
    const quantity = Number(l.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || Math.round(quantity * 1000) !== quantity * 1000) fail(at + ': miktar geçersiz.');
    const n = money(l.net_cents), v = money(l.vat_cents);
    lineNet += n; lineVat += v;
    return {description: text(l.source_product || l.description || 'Fatura satırı', at + ' açıklaması', 300),
      quantity, unit: optional(l.unit, 30) || 'adet', net_cents: n, vat_cents: v,
      product_sku: optional(l.product_sku, 80) || null, mapping_status: optional(l.mapping_status, 60),
      mapping_reason: optional(l.mapping_reason, 500), family_size_ml: l.family_size_ml ?? null};
  });
  if (lineNet !== net || lineVat !== vat) fail(where + ': satır toplamları fatura toplamıyla uyuşmuyor.');
  return {vkn, invoiceNo, date, net, vat, gross, lines, ettn: optional(item.ettn, 60).toLowerCase(),
    source_file: optional(item.source_file, 255), source_page: Number.isSafeInteger(item.source_page) ? item.source_page : null,
    source_key: vkn + ':' + invoiceNo};
}

function parseBody(x) {
  if (!KINDS.includes(x?.kind)) fail('Aktarım türü geçersiz.');
  if (!/^[a-f0-9]{64}$/.test(x.sha256 || '')) fail('Kaynak dosya özeti geçersiz.');
  if (!Array.isArray(x.items) || !x.items.length || x.items.length > MAX_ITEMS) fail('Aktarımda 1–' + MAX_ITEMS + ' kayıt olmalı.');
  const suppliers = {};
  for (const [vkn, name] of Object.entries(x.suppliers || {})) {
    if (!/^\d{10,11}$/.test(vkn)) fail('Tedarikçi VKN/TCKN geçersiz.');
    if (typeof name === 'string' && name.trim()) suppliers[vkn] = name.trim().slice(0, 200);
  }
  return {kind: x.kind, sha256: x.sha256, source_name: text(x.source_name, 'Kaynak dosya adı', 255),
    items: x.items.map(checkInvoice), suppliers};
}

const invoiceKey = v => v.replace(/\s+/g, '').toUpperCase();

/**
 * Belgenin kanonik içerik özeti. Aynı kimlik + aynı içerik = mükerrer yükleme (atlanır).
 * Aynı kimlik + FARKLI içerik = düzeltilmiş belge ya da hatalı okuma olabilir: incelemeye alınır,
 * tutar sessizce üzerine yazılmaz.
 */
async function contentHash(item) {
  const canonical = JSON.stringify([item.date, 'TRY', item.net, item.vat, item.gross,
    item.lines.map(l => [l.description, l.quantity, l.unit, l.net_cents, l.vat_cents]).sort()]);
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function stagedImportApi(request, env, path, readBody) {
  if (!path.startsWith('/api/invoices/staged')) return null;
  if (!['ec', 'lp'].includes(env.WORKSPACE)) fail('Çalışma alanı geçersiz.', 403);
  const db = env.DB, rootDB = env.ROOT_DB || db, method = request.method, user = env.USER || {};
  const sub = path.slice('/api/invoices/staged'.length);

  if (sub === '/batches' && method === 'GET') {
    const batches = (await db.prepare('SELECT * FROM import_batches ORDER BY created_at DESC LIMIT 50').all()).results;
    const attempts = (await db.prepare('SELECT * FROM import_attempts ORDER BY batch_id,attempt_no').all()).results;
    return {batches: batches.map(b => ({...b, counts: JSON.parse(b.counts_json || '{}'),
      attempts: attempts.filter(a => a.batch_id === b.id).map(a => ({...a, counts: JSON.parse(a.counts_json || '{}')}))})),
      notice: 'Aktarım taslak oluşturur; cari borç ve stok ayrı adımlarda yazılır.'};
  }
  if (!['/preview', '/apply'].includes(sub) || method !== 'POST') return null;

  const x = parseBody(await readBody(request));
  const apply = sub === '/apply';
  const startedAt = new Date().toISOString();

  // Daha önce uygulanmış kaynak kayıtlar ve belge kaydı: ikinci kez oluşturulmaz.
  const doneRows = (await db.prepare('SELECT source_key,content_hash FROM import_items WHERE kind=?').bind(x.kind).all()).results;
  const doneKeys = new Set(doneRows.map(r => r.source_key));
  const doneHashes = new Map(doneRows.map(r => [r.source_key, r.content_hash]));
  const suppliersByTax = new Map((await db.prepare('SELECT id,tax_id,name FROM suppliers WHERE tax_id IS NOT NULL').all()).results.map(s => [s.tax_id, s]));
  const products = new Map((await db.prepare('SELECT id,sku FROM products').all()).results.map(p => [String(p.sku).toUpperCase(), p.id]));

  const results = [], counts = {created: 0, skipped: 0, review: 0, failed: 0, pending_lines: 0, unknown_suppliers: 0};
  const missingSuppliers = new Set();

  for (const item of x.items) {
    const line = {source_key: item.source_key, invoice_no: item.invoiceNo, supplier_vkn: item.vkn};
    const hash = await contentHash(item);
    if (doneKeys.has(item.source_key)) {
      const prior = doneHashes.get(item.source_key);
      if (prior && prior !== hash) {
        // Kimlik aynı, içerik farklı: sessizce atlanmaz.
        counts.review++;
        results.push({...line, outcome: 'review', conflict: true,
          detail: 'Bu fatura kimliği daha önce aktarıldı ama gelen belgenin içeriği farklı (tarih, toplam veya satırlar değişmiş). Üzerine yazılmadı; incelemeye alındı.'});
      } else {
        counts.skipped++;
        results.push({...line, outcome: 'skipped', detail: 'Bu fatura daha önce aktarıldı.'});
      }
      continue;
    }

    // Panelde zaten kayıtlı belge (ETTN ya da VKN + fatura no) ikinci kez işlenmez.
    const keys = [...(item.ettn ? ['uuid:' + item.ettn] : []), 'invoice:' + item.vkn + ':' + invoiceKey(item.invoiceNo)];
    const registered = await rootDB.prepare('SELECT workspace FROM document_registry WHERE document_key IN (' + keys.map(() => '?').join(',') + ') LIMIT 1').bind(...keys).first();
    if (registered) { counts.skipped++; results.push({...line, outcome: 'skipped', detail: 'Belge panelde zaten kayıtlı (' + registered.workspace + ').'}); continue; }

    const supplier = suppliersByTax.get(item.vkn);
    const givenName = x.suppliers[item.vkn];
    if (!supplier && !givenName) {
      missingSuppliers.add(item.vkn);
      counts.review++; results.push({...line, outcome: 'review', detail: 'Bu VKN için tedarikçi adı yok. Ad verilmeden kayıt açılmaz.'});
      continue;
    }

    const unresolved = item.lines.filter(l => !l.product_sku || !products.has(String(l.product_sku).toUpperCase()));
    counts.pending_lines += unresolved.length;
    const detail = unresolved.length ? unresolved.length + ' satır ürün eşleşmesi bekliyor.' : '';

    if (!apply) { counts.created++; results.push({...line, outcome: 'created', detail: detail || 'Yeni taslak olarak açılacak.'}); continue; }

    try {
      let supplierId = supplier?.id;
      if (!supplierId) {
        const created = await callApi(accountingApi, env, '/api/accounting/suppliers', {name: givenName, tax_id: item.vkn});
        supplierId = created.id;
        suppliersByTax.set(item.vkn, {id: supplierId, tax_id: item.vkn, name: givenName});
      }
      const body = {
        supplier_id: supplierId, invoice_no: item.invoiceNo, uuid: item.ettn || '', invoice_date: item.date,
        currency: 'TRY', source: 'pdf',
        notes: item.source_file ? 'Kaynak belge: ' + item.source_file + (item.source_page ? ' / sayfa ' + item.source_page : '') : '',
        lines: item.lines.map(l => {
          const productId = l.product_sku ? products.get(String(l.product_sku).toUpperCase()) || null : null;
          return {description: l.description, external_code: '', invoice_quantity: l.quantity, invoice_unit: l.unit,
            net: l.net_cents / 100, tax: l.vat_cents / 100, line_type: 'product',
            // Kimliği doğrulanmamış satır BAĞLANMAZ: fatura taslakta kalır, kesinleştirilemez.
            ...(productId ? {product_id: productId, stock_quantity: l.quantity} : {})};
        })
      };
      const invoice = await callApi(accountingApi, env, '/api/accounting/invoices', body);
      counts.created++;
      results.push({...line, outcome: 'created', invoice_id: invoice.id, detail, content_hash: hash});
    } catch (e) {
      if (e.status === 409) { counts.skipped++; results.push({...line, outcome: 'skipped', detail: e.message, content_hash: hash}); }
      else { counts.failed++; results.push({...line, outcome: 'failed', detail: String(e.message).slice(0, 400)}); }
    }
  }
  counts.unknown_suppliers = missingSuppliers.size;

  if (!apply) {
    return {mode: 'preview', kind: x.kind, source_name: x.source_name, counts, results: results.slice(0, MAX_ITEMS),
      missing_suppliers: [...missingSuppliers],
      notice: 'Önizleme hiçbir şey yazmaz. Uygulandığında yalnız TASLAK fatura oluşur; cari borç ve stok yazılmaz.'};
  }

  // Parti ve her kaynak kaydın sonucu denetim için saklanır. Kayıt yazımı başarısız olsa bile
  // belge kaydı ikinci oluşturmayı engeller.
  // Dosya kaydı ile işleme denemesi AYRIDIR. Eksik bilgi tamamlanıp aynı dosya yeniden
  // gönderildiğinde yeni parti açılmaz; mevcut parti sürdürülür ve her denemenin sonucu
  // denetime eklenir. Aksi hâlde fatura oluşur ama istek 409 döner ve denetim izi eksik kalırdı.
  const openBatch = await db.prepare('SELECT id,counts_json FROM import_batches WHERE kind=? AND sha256=?').bind(x.kind, x.sha256).first();
  const batchId = openBatch?.id || id();
  const stmts = [];
  if (openBatch) {
    // Güncel durum = son tam değerlendirme. Denemelerin işlem sayıları ayrı tabloda tutulur.
    stmts.push(db.prepare('UPDATE import_batches SET counts_json=? WHERE id=?').bind(JSON.stringify(counts), batchId));
  } else {
    stmts.push(db.prepare('INSERT INTO import_batches(id,kind,source_name,sha256,item_count,counts_json,status,created_by) VALUES(?,?,?,?,?,?,?,?)')
      .bind(batchId, x.kind, x.source_name, x.sha256, x.items.length, JSON.stringify(counts), 'applied', user.id || 'owner'));
  }
  for (const r of results) {
    // YALNIZCA sonuçlanmış kayıtlar tekil anahtarı tutar. 'review' ve 'failed' kayıtlar
    // inceleme kuyruğunda kalır ve eksik bilgi tamamlanınca YENİDEN aktarılabilir olmalıdır;
    // bunları tekil anahtara yazmak kullanıcıyı kalıcı olarak kilitlerdi.
    if (!['created', 'skipped'].includes(r.outcome)) continue;
    if (r.outcome === 'skipped' && doneKeys.has(r.source_key)) continue;   // zaten kayıtlı, tekrar yazma
    stmts.push(db.prepare('INSERT OR IGNORE INTO import_items(id,batch_id,kind,source_key,outcome,target_kind,target_id,detail,content_hash) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(id(), batchId, x.kind, r.source_key, r.outcome, r.invoice_id ? 'purchase_invoice' : '', r.invoice_id || '',
        String(r.detail || '').slice(0, 500), r.content_hash || null));
  }
  const attemptNo = ((await db.prepare('SELECT COUNT(*) n FROM import_attempts WHERE batch_id=?').bind(batchId).first())?.n || 0) + 1;
  stmts.push(db.prepare('INSERT INTO import_attempts(id,batch_id,attempt_no,actor,started_at,finished_at,counts_json) VALUES(?,?,?,?,?,?,?)')
    .bind(id(), batchId, attemptNo, user.id || 'owner', startedAt, new Date().toISOString(), JSON.stringify(counts)));
  try { await db.batch(stmts); }
  catch (e) {
    if (/UNIQUE/.test(e.message)) fail('Bu aktarım az önce işlendi. Listeyi yenileyip sonucu kontrol edin.', 409);
    throw e;
  }
  return {mode: 'applied', batch_id: batchId, attempt_no: attemptNo, kind: x.kind, counts, results,
    missing_suppliers: [...missingSuppliers],
    notice: 'Faturalar TASLAK olarak açıldı. Cari borç "Muhasebeleştir", depo girişi "Mal teslimi" ile oluşur. Eşleşmesi olmayan satırlar incelemede kalır.'};
}
