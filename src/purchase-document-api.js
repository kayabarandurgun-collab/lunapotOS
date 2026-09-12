// Tedarikçi alış BELGELERİ (PDF / XML) ve "her faturada yeniden dağıtılan" ürün aileleri.
//
//   POST /api/invoices/documents                 belge kaydı (aynı belge ikinci kez → 409/duplicate)
//   POST /api/invoices/documents/:id/chunk       ham dosya parçası (özgün belge saklanır)
//   POST /api/invoices/documents/:id/seal        özet doğrulanır, belge kilitlenir
//   GET  /api/invoices/documents                 yüklenen belgeler
//   GET  /api/invoices/documents/:id             belge bilgisi + okunan alanlar (aday)
//   GET  /api/invoices/documents/:id/part?index  özgün belgenin bir parçası (önizleme/indirme)
//   POST /api/invoices/documents/:id/link        {invoice_id} belgeyi mevcut fatura kaydına bağlar
//   GET  /api/invoices/families                  ürün aileleri + üyeleri + tedarikçi hatırlatmaları
//   POST /api/invoices/families                  {name,size_label,stock_unit,product_ids}
//   POST /api/invoices/families/link             tedarikçi satırı → aile (ADETLER hatırlanmaz)
//
// Bu dosya STOK, BORÇ, SEVKİYAT veya RESMÎ FATURA oluşturmaz. Yükleme ve taslak aşaması hiçbir
// mali kayıt yazmaz; borç faturanın muhasebeleştirilmesiyle, stok mal teslimiyle oluşur.
// EDM'den otomatik fatura ÇEKİLMEZ: belgeyi kullanıcı yükler.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const id = () => crypto.randomUUID();
const text = (v, label, max = 200) => { if (typeof v !== 'string' || !v.trim() || v.length > max) fail(label + ' alanını kontrol edin.'); return v.trim(); };
const optional = (v, max = 200) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const key = v => { if (!/^[\w-]{1,100}$/.test(v || '')) fail('Belge seçimi geçersiz.'); return v; };
const invoiceKey = v => v.replace(/\s+/g, '').toUpperCase();
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

export const DOC_CHUNK_B64_MAX = 700000;              // ~512 KB ham parça
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const MAX_CHUNKS = 60;

const b64bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const milliFrom = v => {
  const n = Math.round(Number(v) * 1000);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 1000000000) fail('Birim dönüşümü stok hassasiyetine uygun değil.');
  return n;
};

export async function purchaseDocumentApi(request, env, path, readBody) {
  if (!path.startsWith('/api/invoices/documents') && !path.startsWith('/api/invoices/families')) return null;
  if (!['ec', 'lp'].includes(env.WORKSPACE)) fail('Çalışma alanı geçersiz.', 403);
  const db = env.DB, method = request.method, url = new URL(request.url), user = env.USER || {};

  /* ---------------- ürün aileleri ---------------- */
  // Aile yalnızca ADAY kartları ve birim dönüşümünü hatırlar. Çeşit adetleri ASLA hatırlanmaz:
  // her faturada gerçek teslim bilgisiyle yeniden girilir.
  if (path === '/api/invoices/families' && method === 'GET') {
    const [families, members, links] = await Promise.all([
      db.prepare('SELECT * FROM product_families WHERE archived_at IS NULL ORDER BY name,size_label').all(),
      db.prepare('SELECT m.family_id,m.product_id,p.name,p.sku,p.stock_unit FROM product_family_members m JOIN products p ON p.id=m.product_id ORDER BY p.name').all(),
      db.prepare('SELECT * FROM purchase_family_links ORDER BY created_at DESC LIMIT 500').all()
    ]);
    return {
      families: families.results.map(f => ({...f, members: members.results.filter(m => m.family_id === f.id)})),
      links: links.results,
      notice: 'Aile yalnız aday çeşitleri ve birim dönüşümünü hatırlar. Adetler her faturada yeniden girilir.'
    };
  }
  if (path === '/api/invoices/families' && method === 'POST') {
    const x = await readBody(request);
    const name = text(x.name, 'Aile adı', 120), size = optional(x.size_label, 60), unit = text(x.stock_unit, 'Stok birimi', 30);
    if (!Array.isArray(x.product_ids) || x.product_ids.length < 1 || x.product_ids.length > 20 || new Set(x.product_ids).size !== x.product_ids.length)
      fail('Aileye 1–20 farklı stok kartı seçin.');
    const products = (await db.prepare('SELECT id,stock_unit FROM products WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(x.product_ids)).all()).results;
    if (products.length !== x.product_ids.length) fail('Stok kartı bu çalışma alanında bulunamadı.', 404);
    if (products.some(p => p.stock_unit !== unit)) fail('Ailedeki bütün çeşitler aynı stok biriminde olmalı.');
    const row = {id: id(), name, size_label: size, stock_unit: unit, allocation_required: x.allocation_required === false ? 0 : 1};
    try {
      await db.batch([
        db.prepare('INSERT INTO product_families(id,name,size_label,stock_unit,allocation_required) VALUES(?,?,?,?,?)').bind(row.id, row.name, row.size_label, row.stock_unit, row.allocation_required),
        ...products.map(p => db.prepare('INSERT INTO product_family_members(family_id,product_id) VALUES(?,?)').bind(row.id, p.id))
      ]);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) fail('Bu ad ve boy için bir aile zaten var.', 409);
      if (/FAMILY_UNIT/.test(e.message)) fail('Ailedeki bütün çeşitler aynı stok biriminde olmalı.', 409);
      throw e;
    }
    return row;
  }
  if (path === '/api/invoices/families/link' && method === 'POST') {
    const x = await readBody(request);
    const supplier = text(x.supplier_id, 'Tedarikçi', 100);
    if (!await db.prepare('SELECT id FROM suppliers WHERE id=?').bind(supplier).first()) fail('Tedarikçi bulunamadı.', 404);
    const family = await db.prepare('SELECT * FROM product_families WHERE id=? AND archived_at IS NULL').bind(key(x.family_id)).first();
    if (!family) fail('Ürün ailesi bulunamadı.', 404);
    const matchBy = x.match_by === 'name' ? 'name' : 'code';
    const row = {id: id(), supplier_id: supplier, match_by: matchBy, match_value: text(x.match_value, 'Tedarikçi ürün kodu veya adı', 300),
      source_unit: text(x.source_unit, 'Fatura birimi', 30), family_id: family.id, units: milliFrom(x.units_per_invoice_unit)};
    try {
      await db.prepare('INSERT INTO purchase_family_links(id,supplier_id,match_by,match_value,source_unit,family_id,units_per_invoice_unit_milli) VALUES(?,?,?,?,?,?,?)')
        .bind(row.id, row.supplier_id, row.match_by, row.match_value, row.source_unit, row.family_id, row.units).run();
    } catch (e) {
      if (/UNIQUE/.test(e.message)) fail('Bu tedarikçi satırı için bir aile hatırlatması zaten var.', 409);
      throw e;
    }
    return {...row, notice: 'Sonraki faturada bu satır bu aileye yönlendirilir. Çeşit adetleri yine her seferinde sorulur.'};
  }

  /* ---------------- belgeler ---------------- */
  if (path === '/api/invoices/documents' && method === 'GET') {
    const rows = (await db.prepare(`SELECT d.id,d.kind,d.filename,d.size_bytes,d.page_count,d.text_layer,d.status,d.doc_no,d.doc_uuid,d.supplier_tax_id,d.invoice_id,d.warnings_json,d.created_at,
      i.invoice_no,i.status invoice_status FROM purchase_documents d LEFT JOIN purchase_invoices i ON i.id=d.invoice_id ORDER BY d.created_at DESC LIMIT 100`).all()).results;
    return {documents: rows.map(d => ({...d, warnings: parse(d.warnings_json, [])})),
      notice: 'Belgeler özgün hâliyle saklanır. Yükleme tek başına borç veya stok oluşturmaz.'};
  }

  if (path === '/api/invoices/documents' && method === 'POST') {
    const x = await readBody(request);
    if (!['pdf', 'xml'].includes(x.kind)) fail('Belge türü pdf veya xml olmalı.');
    if (!/^[a-f0-9]{64}$/.test(x.sha256 || '')) fail('Dosya özeti geçersiz.');
    if (!Number.isSafeInteger(x.size_bytes) || x.size_bytes < 1 || x.size_bytes > MAX_DOC_BYTES) fail('Belge boyutu geçersiz (en çok 20 MB).');
    if (!Number.isSafeInteger(x.chunk_count) || x.chunk_count < 1 || x.chunk_count > MAX_CHUNKS) fail('Parça sayısı geçersiz.');
    const uuid = optional(x.doc_uuid, 60).toLowerCase();
    if (uuid && !/^[0-9a-f-]{10,60}$/.test(uuid)) fail('ETTN / UUID biçimi geçersiz.');
    const taxId = optional(x.supplier_tax_id, 11), docNo = optional(x.doc_no, 60);
    if (taxId && !/^\d{10,11}$/.test(taxId)) fail('Tedarikçi VKN / TCKN 10 veya 11 hane olmalı.');

    // Aynı belge ikinci kez yüklenemez. Üç ayrı kimlik denetlenir: dosya özeti, ETTN ve
    // tedarikçi VKN + fatura no. Dosya adı değişse de belge yakalanır.
    const same = await db.prepare('SELECT id,status,filename FROM purchase_documents WHERE sha256=?').bind(x.sha256).first();
    if (same?.status === 'receiving') return {id: same.id, resume: true};
    if (same) return {duplicate: true, existing: same, reason: 'sha256', notice: 'Bu dosya daha önce yüklendi; ikinci kez işlenmedi.'};
    if (uuid) {
      const byUuid = await db.prepare('SELECT id,filename,invoice_id FROM purchase_documents WHERE doc_uuid=?').bind(uuid).first();
      if (byUuid) return {duplicate: true, existing: byUuid, reason: 'ettn',
        notice: 'Aynı ETTN ile bir belge zaten yüklü ("' + byUuid.filename + '"). Satırları farklı olsa bile otomatik üzerine yazılmaz; farklıysa inceleyin.'};
    }
    if (taxId && docNo) {
      const byNo = await db.prepare('SELECT id,filename,invoice_id FROM purchase_documents WHERE supplier_tax_id=? AND doc_no=?').bind(taxId, docNo).first();
      if (byNo) return {duplicate: true, existing: byNo, reason: 'invoice_no',
        notice: 'Bu tedarikçinin aynı numaralı faturası zaten yüklü ("' + byNo.filename + '").'};
    }
    // Panelde zaten işlenmiş bir belge mi? (iki çalışma alanı ortak belge kaydını paylaşır)
    const rootDB = env.ROOT_DB || db;
    const registryKeys = [...(uuid ? ['uuid:' + uuid] : []), ...(taxId && docNo ? ['invoice:' + taxId + ':' + invoiceKey(docNo)] : [])];
    if (registryKeys.length) {
      const registered = await rootDB.prepare('SELECT workspace FROM document_registry WHERE document_key IN (' + registryKeys.map(() => '?').join(',') + ') LIMIT 1').bind(...registryKeys).first();
      if (registered) return {duplicate: true, reason: 'registry',
        notice: 'Bu belge ' + (registered.workspace === 'ec' ? 'E-Ticaret' : 'Lunapot') + ' alanında zaten faturaya işlenmiş. İkinci kez işlenmedi.'};
    }
    const row = {id: id()};
    await db.prepare(`INSERT INTO purchase_documents(id,kind,filename,mime,size_bytes,sha256,chunk_count,page_count,text_layer,supplier_tax_id,doc_no,doc_uuid,extracted_json,warnings_json,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(row.id, x.kind, text(x.filename, 'Dosya adı', 255), optional(x.mime, 100), x.size_bytes, x.sha256, x.chunk_count,
      Number.isSafeInteger(x.page_count) ? x.page_count : null, x.text_layer ? 1 : 0, taxId, docNo, uuid,
      JSON.stringify(x.extracted && typeof x.extracted === 'object' ? x.extracted : {}),
      JSON.stringify((x.warnings || []).slice(0, 20).map(w => String(w).slice(0, 500))), user.id || 'owner').run();
    return {id: row.id};
  }

  const docMatch = path.match(/^\/api\/invoices\/documents\/([\w-]+)(?:\/(chunk|seal|part|link))?$/);
  if (!docMatch) return null;
  const doc = await db.prepare('SELECT * FROM purchase_documents WHERE id=?').bind(key(docMatch[1])).first();
  if (!doc) fail('Belge bulunamadı.', 404);
  const action = docMatch[2];

  if (!action && method === 'GET') {
    return {...doc, extracted: parse(doc.extracted_json, {}), warnings: parse(doc.warnings_json, []),
      notice: doc.text_layer ? 'Okunan alanlar ADAYDIR; kaydetmeden önce belgeyle karşılaştırın.'
        : 'Bu belgede metin katmanı yok. Satırlar okunamadı; bilgileri elle girin.'};
  }

  if (action === 'chunk' && method === 'POST') {
    const x = await readBody(request);
    if (doc.status !== 'receiving') fail('Belge kilitlendi; yeni parça eklenemez.', 409);
    if (!Number.isInteger(x.index) || x.index < 0 || x.index >= doc.chunk_count) fail('Parça sırası geçersiz.');
    if (typeof x.data !== 'string' || !x.data || x.data.length > DOC_CHUNK_B64_MAX || !/^[A-Za-z0-9+/]+=*$/.test(x.data)) fail('Parça geçersiz.');
    await db.prepare('INSERT OR IGNORE INTO purchase_document_chunks(document_id,idx,data_b64) VALUES(?,?,?)').bind(doc.id, x.index, x.data).run();
    return {ok: true};
  }

  if (action === 'seal' && method === 'POST') {
    if (doc.status !== 'receiving') return {ok: true, status: doc.status};
    const chunks = (await db.prepare('SELECT idx,data_b64 FROM purchase_document_chunks WHERE document_id=? ORDER BY idx').bind(doc.id).all()).results;
    if (chunks.length !== doc.chunk_count || chunks.some((c, i) => c.idx !== i)) fail('Belge parçaları eksik; yüklemeyi sürdürün.', 409);
    const parts = chunks.map(c => b64bytes(c.data_b64)), size = parts.reduce((s, p) => s + p.length, 0);
    const all = new Uint8Array(size); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    if (size !== doc.size_bytes || await sha256Hex(all) !== doc.sha256) fail('Sunucuya ulaşan belge, seçilen dosyayla aynı değil. Yeniden yükleyin.', 409);
    await db.prepare("UPDATE purchase_documents SET status='stored' WHERE id=? AND status='receiving'").bind(doc.id).run();
    return {ok: true, status: 'stored'};
  }

  // Özgün belge yetkili kullanıcıya parça parça verilir (önizleme ve indirme).
  if (action === 'part' && method === 'GET') {
    const index = Number(url.searchParams.get('index'));
    if (!Number.isInteger(index) || index < 0 || index >= doc.chunk_count) fail('Parça sırası geçersiz.');
    const chunk = await db.prepare('SELECT data_b64 FROM purchase_document_chunks WHERE document_id=? AND idx=?').bind(doc.id, index).first();
    if (!chunk) fail('Belge parçası bulunamadı.', 404);
    return {index, chunk_count: doc.chunk_count, filename: doc.filename, mime: doc.mime || (doc.kind === 'pdf' ? 'application/pdf' : 'application/xml'), data: chunk.data_b64};
  }

  if (action === 'link' && method === 'POST') {
    const x = await readBody(request);
    if (doc.status === 'receiving') fail('Önce belgenin yüklenmesini tamamlayın.', 409);
    if (doc.invoice_id) fail('Bu belge zaten bir fatura kaydına bağlı.', 409);
    const invoice = await db.prepare('SELECT id,status FROM purchase_invoices WHERE id=?').bind(key(x.invoice_id)).first();
    if (!invoice) fail('Fatura kaydı bulunamadı.', 404);
    const taken = await db.prepare('SELECT id FROM purchase_documents WHERE invoice_id=?').bind(invoice.id).first();
    if (taken) fail('Bu fatura kaydına başka bir belge bağlı.', 409);
    await db.prepare("UPDATE purchase_documents SET status='linked',invoice_id=? WHERE id=? AND invoice_id IS NULL").bind(invoice.id, doc.id).run();
    return {ok: true, invoice_id: invoice.id, notice: 'Özgün belge fatura kaydına bağlandı. Belge saklanır; kayıt silinemez.'};
  }
  return null;
}
