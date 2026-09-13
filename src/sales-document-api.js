// Pazaryerinin kestiği SATIŞ faturalarının özgün belgeleri (PDF / XML).
//
//   POST /api/sales/documents                    belge kaydı (aynı dosya ikinci kez → duplicate)
//   POST /api/sales/documents/:id/chunk          ham dosya parçası
//   POST /api/sales/documents/:id/seal           özet doğrulanır, belge kilitlenir
//   GET  /api/sales/documents                    yüklenen satış belgeleri
//   GET  /api/sales/documents/:id                belge bilgisi
//   GET  /api/sales/documents/:id/part?index     özgün belgenin bir parçası
//   GET  /api/sales/documents/:id/pages          sayfa → fatura bağlantıları
//   POST /api/sales/documents/:id/pages          {pages:[{page_no,invoice_no,ettn,order_no,gross}]}
//   POST /api/sales/documents/:id/pages/correct  {reason,corrections:[{page_no,invoice_no,order_no,gross}]}
//   POST /api/sales/documents/:id/pages/link     {links:[{page_no,package_id}]} sonradan sipariş bağı
//
// Alış belgesinden AYRI bir tablodur: karşı taraf tedarikçi değil müşteridir ve kayıt bir alış
// faturasına değil sipariş paketine bağlanır. Alış tablosuna sokmak satışı borç tarafında gösterirdi.
//
// Bu dosya SATIŞ, STOK veya GELİR KAYDI oluşturmaz. Belge arşividir: fatura yüklemek malın
// sevk edildiği anlamına gelmez. Sipariş paketi henüz sistemde olmayabilir; sayfa o zaman
// siparişsiz arşivlenir ve bağlantı sonradan bir kez kurulur.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const id = () => crypto.randomUUID();
const text = (v, label, max = 255) => { if (typeof v !== 'string' || !v.trim() || v.length > max) fail(label + ' alanını kontrol edin.'); return v.trim(); };
const optional = (v, max = 200) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const key = v => { if (!/^[\w-]{1,100}$/.test(v || '')) fail('Belge seçimi geçersiz.'); return v; };
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

const CHUNK_B64_MAX = 700000;                 // ~512 KB ham parça
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const MAX_CHUNKS = 60;
const PROVIDERS = ['trendyol', 'hepsiburada', 'other'];

const b64bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const centsFrom = (v, label) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Math.round(Number(v) * 100);
  if (!Number.isSafeInteger(n) || n < 0) fail(label + ' tutarı geçersiz.');
  return n;
};

export async function salesDocumentApi(request, env, path, readBody) {
  if (!path.startsWith('/api/sales/documents')) return null;
  // Pazaryeri satışı yalnızca e-ticaret alanında vardır.
  if (env.WORKSPACE !== 'ec') fail('Satış belgeleri yalnızca e-ticaret alanında tutulur.', 403);
  const db = env.DB, method = request.method, url = new URL(request.url), user = env.USER || {};

  if (path === '/api/sales/documents' && method === 'GET') {
    const rows = (await db.prepare(`SELECT d.id,d.kind,d.provider,d.filename,d.size_bytes,d.page_count,d.text_layer,d.status,
      d.origin_filename,d.origin_first_page,d.origin_last_page,d.warnings_json,d.created_at,
      (SELECT COUNT(*) FROM ec_sales_document_pages p WHERE p.document_id=d.id) linked_pages,
      (SELECT COUNT(*) FROM ec_sales_document_pages p WHERE p.document_id=d.id AND p.package_id IS NOT NULL) linked_orders
      FROM ec_sales_documents d ORDER BY d.created_at DESC LIMIT 200`).all()).results;
    return {documents: rows.map(d => ({...d, warnings: parse(d.warnings_json, [])})),
      notice: 'Belgeler özgün hâliyle saklanır. Fatura yüklemek satış, gelir veya stok çıkışı oluşturmaz.'};
  }

  if (path === '/api/sales/documents' && method === 'POST') {
    const x = await readBody(request);
    if (!['pdf', 'xml'].includes(x.kind)) fail('Belge türü pdf veya xml olmalı.');
    if (!PROVIDERS.includes(x.provider)) fail('Pazaryeri seçin.');
    if (!/^[a-f0-9]{64}$/.test(x.sha256 || '')) fail('Dosya özeti geçersiz.');
    if (!Number.isSafeInteger(x.size_bytes) || x.size_bytes < 1 || x.size_bytes > MAX_DOC_BYTES) fail('Belge boyutu geçersiz (en çok 20 MB).');
    if (!Number.isSafeInteger(x.chunk_count) || x.chunk_count < 1 || x.chunk_count > MAX_CHUNKS) fail('Parça sayısı geçersiz.');

    // Büyük birleşik dosya bölünerek yüklendiyse özgün dosyanın kimliği ve bu bölümün kapsadığı
    // ÖZGÜN sayfa aralığı saklanır; yoksa sayfa numarası anlamını yitirirdi.
    const originSha = optional(x.origin_sha256, 64).toLowerCase();
    if (originSha && !/^[a-f0-9]{64}$/.test(originSha)) fail('Özgün dosya özeti geçersiz.');
    const first = x.origin_first_page, last = x.origin_last_page;
    const ranged = first !== undefined && first !== null;
    if (ranged !== (last !== undefined && last !== null)) fail('Özgün sayfa aralığının iki ucu da verilmeli.');
    if (ranged && (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first)) fail('Özgün sayfa aralığı geçersiz.');
    if (ranged && Number.isSafeInteger(x.page_count) && last - first + 1 !== x.page_count)
      fail('Bölümün sayfa sayısı bildirilen özgün aralıkla uyuşmuyor.');

    const same = await db.prepare('SELECT id,status,filename FROM ec_sales_documents WHERE sha256=?').bind(x.sha256).first();
    if (same?.status === 'receiving') return {id: same.id, resume: true};
    if (same) return {duplicate: true, existing: same, notice: 'Bu dosya daha önce yüklendi; ikinci kez işlenmedi.'};

    const row = {id: id()};
    await db.prepare(`INSERT INTO ec_sales_documents(id,kind,provider,filename,mime,size_bytes,sha256,chunk_count,page_count,text_layer,
      origin_filename,origin_sha256,origin_first_page,origin_last_page,warnings_json,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(row.id, x.kind, x.provider, text(x.filename, 'Dosya adı'), optional(x.mime, 100),
      x.size_bytes, x.sha256, x.chunk_count, Number.isSafeInteger(x.page_count) ? x.page_count : null, x.text_layer ? 1 : 0,
      optional(x.origin_filename, 255), originSha, ranged ? first : null, ranged ? last : null,
      JSON.stringify((x.warnings || []).slice(0, 20).map(w => String(w).slice(0, 500))), user.id || 'owner').run();
    return {id: row.id};
  }

  const match = path.match(/^\/api\/sales\/documents\/([\w-]+)(?:\/(chunk|seal|part|pages))?(?:\/(link|correct))?$/);
  if (!match) return null;
  const doc = await db.prepare('SELECT * FROM ec_sales_documents WHERE id=?').bind(key(match[1])).first();
  if (!doc) fail('Belge bulunamadı.', 404);
  const action = match[2], sub = match[3];
  // Özgün sayfa numarası: bölünmüş dosyada bölüm başlangıcı kadar kaydırılır.
  const originPage = page => doc.origin_first_page ? doc.origin_first_page + page - 1 : page;

  if (!action && method === 'GET') {
    return {...doc, warnings: parse(doc.warnings_json, []),
      notice: doc.text_layer ? 'Okunan alanlar ADAYDIR; kaydetmeden önce belgeyle karşılaştırın.'
        : 'Bu belgede metin katmanı yok. Fatura bilgileri elle veya ayrı okumayla girilir.'};
  }

  if (action === 'chunk' && method === 'POST') {
    const x = await readBody(request);
    if (!Number.isInteger(x.index) || x.index < 0 || x.index >= doc.chunk_count) fail('Parça sırası geçersiz.');
    if (typeof x.data !== 'string' || !x.data || x.data.length > CHUNK_B64_MAX || !/^[A-Za-z0-9+/]+=*$/.test(x.data)) fail('Parça geçersiz.');
    await db.prepare('INSERT OR IGNORE INTO ec_sales_document_chunks(document_id,idx,data_b64) VALUES(?,?,?)').bind(doc.id, x.index, x.data).run();
    return {ok: true};
  }

  if (action === 'seal' && method === 'POST') {
    if (doc.status !== 'receiving') return {ok: true, status: doc.status};
    const chunks = (await db.prepare('SELECT idx,data_b64 FROM ec_sales_document_chunks WHERE document_id=? ORDER BY idx').bind(doc.id).all()).results;
    if (chunks.length !== doc.chunk_count || chunks.some((c, i) => c.idx !== i)) fail('Belge parçaları eksik; yüklemeyi sürdürün.', 409);
    const parts = chunks.map(c => b64bytes(c.data_b64)), size = parts.reduce((s, p) => s + p.length, 0);
    const all = new Uint8Array(size); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    // Sunucuya ulaşan dosya seçilen dosya DEĞİLSE arşiv değersizdir: mühürlenmez.
    if (size !== doc.size_bytes || await sha256Hex(all) !== doc.sha256) fail('Sunucuya ulaşan belge, seçilen dosyayla aynı değil. Yeniden yükleyin.', 409);
    await db.prepare("UPDATE ec_sales_documents SET status='stored' WHERE id=? AND status='receiving'").bind(doc.id).run();
    return {ok: true, status: 'stored'};
  }

  if (action === 'part' && method === 'GET') {
    const index = Number(url.searchParams.get('index') || 0);
    if (!Number.isInteger(index) || index < 0 || index >= doc.chunk_count) fail('Parça sırası geçersiz.');
    const chunk = await db.prepare('SELECT data_b64 FROM ec_sales_document_chunks WHERE document_id=? AND idx=?').bind(doc.id, index).first();
    if (!chunk) fail('Parça bulunamadı.', 404);
    return {index, chunk_count: doc.chunk_count, filename: doc.filename,
      mime: doc.mime || (doc.kind === 'pdf' ? 'application/pdf' : 'application/xml'), data: chunk.data_b64};
  }

  if (action === 'pages' && !sub && method === 'GET') {
    const rows = (await db.prepare(`SELECT p.id,p.document_id,p.page_no,p.origin_page_no,p.package_id,p.created_by,p.created_at,
      CASE WHEN c.id IS NULL THEN p.invoice_no ELSE c.invoice_no END invoice_no,
      CASE WHEN c.id IS NULL THEN p.ettn ELSE c.ettn END ettn,
      CASE WHEN c.id IS NULL THEN p.order_no ELSE c.order_no END order_no,
      CASE WHEN c.id IS NULL THEN p.gross_cents ELSE c.gross_cents END gross_cents,
      CASE WHEN c.id IS NULL THEN 0 ELSE 1 END corrected,
      c.wrong_invoice_no,c.wrong_order_no,c.reason correction_reason,
      o.order_no package_order_no,o.status package_status
      FROM ec_sales_document_pages p LEFT JOIN ec_order_packages o ON o.id=p.package_id
      LEFT JOIN ec_sales_document_page_corrections c ON c.page_id=p.id
      WHERE p.document_id=? ORDER BY p.page_no`).bind(doc.id).all()).results;
    return {document_id: doc.id, filename: doc.filename, page_count: doc.page_count,
      origin_filename: doc.origin_filename, origin_first_page: doc.origin_first_page, pages: rows,
      notice: 'Sayfa kaydı kanıttır: fatura kimliği değiştirilemez, silinemez. Yalnız sipariş bağlantısı sonradan bir kez kurulabilir.'};
  }

  if (action === 'pages' && !sub && method === 'POST') {
    const x = await readBody(request);
    if (doc.status === 'receiving') fail('Önce belgenin yüklenmesini tamamlayın.', 409);
    if (!Array.isArray(x.pages) || !x.pages.length || x.pages.length > 200) fail('Sayfa listesi 1–200 satır olmalı.');
    const wanted = x.pages.map(p => {
      if (!Number.isSafeInteger(p?.page_no) || p.page_no < 1) fail('Sayfa numarası geçersiz.');
      if (doc.page_count && p.page_no > doc.page_count) fail('Sayfa ' + p.page_no + ' bu belgede yok (' + doc.page_count + ' sayfa).');
      return {page_no: p.page_no, invoice_no: optional(p.invoice_no, 60), ettn: optional(p.ettn, 60).toLowerCase(),
        order_no: optional(p.order_no, 60), gross_cents: centsFrom(p.gross, 'Fatura'),
        package_id: p.package_id ? key(p.package_id) : null};
    });
    if (new Set(wanted.map(p => p.page_no)).size !== wanted.length) fail('Aynı sayfa listede birden çok kez var.');
    const numbered = wanted.filter(p => p.invoice_no);
    if (new Set(numbered.map(p => p.invoice_no)).size !== numbered.length) fail('Aynı fatura numarası listede birden çok kez var.');

    const packages = wanted.map(p => p.package_id).filter(Boolean);
    if (packages.length) {
      const known = new Set((await db.prepare('SELECT id FROM ec_order_packages WHERE id IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(packages)).all()).results.map(r => r.id));
      if (packages.some(p => !known.has(p))) fail('Bağlanmak istenen sipariş paketi bulunamadı.', 404);
    }

    // Var olan sayfa kaydının ÜSTÜNE YAZILMAZ. Aynısıysa tekrar sayılmaz, farklıysa çelişki bildirilir.
    const prior = (await db.prepare('SELECT page_no,invoice_no FROM ec_sales_document_pages WHERE document_id=?').bind(doc.id).all()).results;
    const byPage = new Map(prior.map(r => [r.page_no, r.invoice_no]));
    const created = [], same = [], conflicts = [];
    for (const p of wanted) {
      const has = byPage.get(p.page_no);
      if (has === undefined) { created.push(p); continue; }
      if (has === p.invoice_no) { same.push(p.page_no); continue; }
      conflicts.push({page_no: p.page_no, reason: 'Bu sayfa "' + has + '" faturasıyla kayıtlı; üstüne yazılmadı.'});
    }
    if (created.length) {
      await db.batch(created.map(p => db.prepare(`INSERT INTO ec_sales_document_pages(id,document_id,page_no,origin_page_no,invoice_no,ettn,order_no,package_id,gross_cents,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(id(), doc.id, p.page_no, originPage(p.page_no), p.invoice_no, p.ettn, p.order_no, p.package_id, p.gross_cents, user.id || 'owner')));
    }
    return {document_id: doc.id, created: created.length, already_recorded: same.length, conflicts,
      notice: 'Belge tek kopya olarak durur; her fatura kendi sayfasıyla arşivlendi. Bu işlem satış veya stok kaydı oluşturmaz.'};
  }

  // DUZELTME. Muhurlu sayfa kaydi silinmez ve degistirilmez; yanlis satir yerinde kalir,
  // dogrusu yanina yazilir ve okuma tarafi dogruyu gosterir. Gerekce zorunludur.
  // Bu uc mali kayit olusturmaz; yalniz hangi sayfanin hangi faturaya ait oldugunu duzeltir.
  if (action === 'pages' && sub === 'correct' && method === 'POST') {
    const x = await readBody(request);
    const reason = optional(x.reason, 400).trim();
    if (reason.length < 10) fail('Düzeltme gerekçesi zorunludur (en az 10 karakter).');
    if (!Array.isArray(x.corrections) || !x.corrections.length || x.corrections.length > 200)
      fail('Düzeltme listesi 1–200 satır olmalı.');
    const wanted = x.corrections.map(c => {
      if (!Number.isSafeInteger(c?.page_no) || c.page_no < 1) fail('Sayfa numarası geçersiz.');
      return {page_no: c.page_no, invoice_no: optional(c.invoice_no, 60), ettn: optional(c.ettn, 60).toLowerCase(),
        order_no: optional(c.order_no, 60), gross_cents: centsFrom(c.gross, 'Fatura')};
    });
    if (new Set(wanted.map(c => c.page_no)).size !== wanted.length) fail('Aynı sayfa listede birden çok kez var.');

    const rows = (await db.prepare(`SELECT p.id,p.page_no,p.invoice_no,p.order_no,p.ettn,p.gross_cents,c.id corr_id
      FROM ec_sales_document_pages p LEFT JOIN ec_sales_document_page_corrections c ON c.page_id=p.id
      WHERE p.document_id=?`).bind(doc.id).all()).results;
    const byPage = new Map(rows.map(r => [r.page_no, r]));
    const yazilacak = [], atlanan = [], conflicts = [];
    for (const c of wanted) {
      const row = byPage.get(c.page_no);
      if (!row) { conflicts.push({page_no: c.page_no, reason: 'Bu sayfa belgede kayıtlı değil.'}); continue; }
      if (row.corr_id) { conflicts.push({page_no: c.page_no, reason: 'Bu sayfa zaten bir kez düzeltildi; düzeltme de mühürlüdür.'}); continue; }
      if (row.invoice_no === c.invoice_no && row.order_no === c.order_no
        && row.ettn === c.ettn && row.gross_cents === c.gross_cents) { atlanan.push(c.page_no); continue; }
      yazilacak.push({...c, page_id: row.id, wrong_invoice_no: row.invoice_no, wrong_order_no: row.order_no});
    }
    if (yazilacak.length) {
      await db.batch(yazilacak.map(c => db.prepare(`INSERT INTO ec_sales_document_page_corrections
        (id,page_id,document_id,page_no,wrong_invoice_no,wrong_order_no,invoice_no,ettn,order_no,gross_cents,reason,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id(), c.page_id, doc.id, c.page_no, c.wrong_invoice_no, c.wrong_order_no,
        c.invoice_no, c.ettn, c.order_no, c.gross_cents, reason, user.id || 'owner')));
    }
    return {document_id: doc.id, corrected: yazilacak.length, unchanged: atlanan.length, conflicts,
      notice: 'Yanlış kayıt silinmedi; düzeltme yanına yazıldı ve listede doğru değer gösterilir.'};
  }

  // Sipariş sisteme belgeden SONRA girebilir: bağlantı sonradan bir kez kurulur, geri alınmaz.
  if (action === 'pages' && sub === 'link' && method === 'POST') {
    const x = await readBody(request);
    if (!Array.isArray(x.links) || !x.links.length || x.links.length > 200) fail('Bağlantı listesi 1–200 satır olmalı.');
    const wanted = x.links.map(l => {
      if (!Number.isSafeInteger(l?.page_no) || l.page_no < 1) fail('Sayfa numarası geçersiz.');
      return {page_no: l.page_no, package_id: key(l.package_id)};
    });
    const known = new Set((await db.prepare('SELECT id FROM ec_order_packages WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(wanted.map(l => l.package_id))).all()).results.map(r => r.id));
    const missing = wanted.filter(l => !known.has(l.package_id));
    if (missing.length) fail(missing.length + ' sipariş paketi bulunamadı; bağlantı kurulmadı.', 404);

    const rows = (await db.prepare('SELECT page_no,package_id FROM ec_sales_document_pages WHERE document_id=?').bind(doc.id).all()).results;
    const current = new Map(rows.map(r => [r.page_no, r.package_id]));
    const linked = [], same = [], conflicts = [];
    for (const l of wanted) {
      if (!current.has(l.page_no)) { conflicts.push({page_no: l.page_no, reason: 'Bu sayfa belgede kayıtlı değil.'}); continue; }
      const has = current.get(l.page_no);
      if (has === l.package_id) { same.push(l.page_no); continue; }
      if (has) { conflicts.push({page_no: l.page_no, reason: 'Bu sayfa başka bir siparişe bağlı; bağlantı taşınmaz.'}); continue; }
      linked.push(l);
    }
    if (linked.length) {
      await db.batch(linked.map(l => db.prepare('UPDATE ec_sales_document_pages SET package_id=? WHERE document_id=? AND page_no=? AND package_id IS NULL')
        .bind(l.package_id, doc.id, l.page_no)));
    }
    return {document_id: doc.id, linked: linked.length, already_linked: same.length, conflicts,
      notice: 'Fatura sayfası siparişe bağlandı. Bağlantı belgedir; satış veya stok hareketi oluşturmaz.'};
  }

  return null;
}
