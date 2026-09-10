import {normalizeBarcode, classifyBarcode, internalCode, scanQuantityMilli, packWording} from '../public/barcode.js';

// Barkod uçları. YALNIZCA üretim (lp) çalışma alanı.
//
// Bu dosya stok DEĞİŞTİRMEZ. Okutma bir aramadır: kartı bulur, miktarı gösterir.
// Stok hareketleri eskisi gibi /api/lp/production/material-stock üzerinden yürür;
// burada ikinci bir stok sistemi yoktur.
//
// Bilinmeyen barkod hiçbir koşulda kart AÇMAZ; ne yapılabileceğini söyler ve durur.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const id = () => crypto.randomUUID();

const text = (value, label, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(label + ' alanını kontrol edin.');
  return value.trim();
};
const optionalText = (value, label, max = 500) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > max) fail(label + ' alanını kontrol edin.');
  return value.trim();
};
const key = value => { if (!/^[\w-]{1,100}$/.test(value || '')) fail('Kayıt seçimi geçersiz.'); return value; };

// Ambalaj miktarı kart biriminden girilir: 20 kg teneke için 20 yazılır.
const packMilli = value => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value), milli = Math.round(parsed * 1000);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(milli) || milli > 100000000000)
    fail('Ambalaj miktarı sıfırdan büyük bir sayı olmalı.');
  return milli;
};

const CARD_SQL =
  "SELECT b.*, " +
  "COALESCE(m.name,p.name) card_name, " +
  "COALESCE(m.unit,p.stock_unit) unit, " +
  "m.price material_price, " +
  "p.sku sku, p.inventory_kind inventory_kind, " +
  "bal.quantity_milli material_quantity_milli, bal.value_cents material_value_cents " +
  "FROM barcodes b " +
  "LEFT JOIN materials m ON m.id=b.material_id " +
  "LEFT JOIN products p ON p.id=b.product_id " +
  "LEFT JOIN lp_material_balances bal ON bal.material_id=b.material_id ";

const present = row => ({
  id: row.id, code: row.code, target_kind: row.target_kind,
  material_id: row.material_id, product_id: row.product_id,
  card_name: row.card_name, unit: row.unit, sku: row.sku || null,
  brand: row.brand, pack_quantity_milli: row.pack_quantity_milli, pack_label: row.pack_label,
  source: row.source, note: row.note, active: row.active,
  created_by_name: row.created_by_name, created_at: row.created_at,
  scan_quantity_milli: scanQuantityMilli(row),
  pack_wording: packWording(row, row.unit)
});

export async function barcodeApi(request, env, path, readBody) {
  if (!path.startsWith('/api/barcodes')) return null;
  // Barkod yönetimi yalnızca üretim modülündedir; e-ticaret alanında bulunmaz.
  if (env.WORKSPACE !== 'lp') fail('Barkod yönetimi yalnızca üretim çalışma alanında kullanılır.', 403);
  const db = env.DB, method = request.method, url = new URL(request.url);
  const user = env.USER || {};
  const sub = path.slice('/api/barcodes'.length);

  // Okutma = arama. Stok DEĞİŞMEZ.
  if (sub === '/lookup' && method === 'GET') {
    let code;
    try { code = normalizeBarcode(url.searchParams.get('code') || ''); }
    catch (error) { fail(error.message); }
    const info = classifyBarcode(code);
    const row = await db.prepare(CARD_SQL + 'WHERE b.code=?').bind(code).first();
    if (!row) return {
      found: false, code, classification: info,
      // Bilinmeyen barkod kendiliğinden kart AÇMAZ.
      options: ['Var olan bir karta bağla', 'Yeni kart aç ve sonra bağla'],
      notice: 'Bu barkod tanımlı değil. Kart kendiliğinden açılmaz; ne yapılacağını siz seçersiniz.'
    };
    if (!row.active) return {
      found: true, active: false, code, classification: info, link: present(row),
      notice: 'Bu barkod bağlantısı kapalı. Kullanmak için önce yeniden açın.'
    };
    return {
      found: true, active: true, code, classification: info, link: present(row),
      stock: row.target_kind === 'material'
        ? {quantity_milli: row.material_quantity_milli ?? 0, value_cents: row.material_value_cents ?? 0, unit: row.unit}
        : {quantity_milli: null, value_cents: null, unit: row.unit},
      notice: 'Okutma yalnızca kartı bulur. Stok bu ekranda değişmez; miktar değiştiren işlemler ayrıca onaylanır.'
    };
  }

  if (sub === '' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length > 100) fail('Arama en fazla 100 karakter olabilir.');
    const term = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
    const rows = (await db.prepare(
      CARD_SQL + (q ? "WHERE b.code LIKE ? ESCAPE '\\' OR COALESCE(m.name,p.name) LIKE ? ESCAPE '\\' OR b.brand LIKE ? ESCAPE '\\' " : '') +
      'ORDER BY COALESCE(m.name,p.name),b.code LIMIT 500'
    ).bind(...(q ? [term, term, term] : [])).all()).results;
    return {workspace: env.WORKSPACE, barcodes: rows.map(present)};
  }

  // Var olan bir karta barkod bağlar. Kart AÇMAZ.
  if (sub === '' && method === 'POST') {
    const input = await readBody(request);
    const kind = ['material', 'product'].includes(input.target_kind) ? input.target_kind : fail('Kart türünü seçin.');
    const card = key(kind === 'material' ? input.material_id : input.product_id);
    const table = kind === 'material' ? 'materials' : 'products';
    if (!await db.prepare(`SELECT id FROM ${table} WHERE id=?`).bind(card).first())
      fail('Kart bu çalışma alanında bulunamadı.', 404);

    let code, info;
    if (input.generate_internal === true) {
      code = internalCode();
      info = classifyBarcode(code);
    } else {
      try { code = normalizeBarcode(input.code || ''); } catch (error) { fail(error.message); }
      info = classifyBarcode(code);
      if (info.kind === 'internal') fail('“LP-” ile başlayan kodlar yalnızca sistem tarafından üretilir.');
    }

    const existing = await db.prepare(CARD_SQL + 'WHERE b.code=?').bind(code).first();
    if (existing) fail('Bu barkod zaten “' + existing.card_name + '” kartına bağlı. Aynı barkod iki karta bağlanamaz.', 409);

    const row = {
      id: id(), code, target_kind: kind,
      material_id: kind === 'material' ? card : null,
      product_id: kind === 'product' ? card : null,
      brand: optionalText(input.brand, 'Marka', 200),
      pack_quantity_milli: packMilli(input.pack_quantity),
      pack_label: optionalText(input.pack_label, 'Ambalaj açıklaması', 200),
      source: info.gs1 ? 'gs1' : info.kind === 'internal' ? 'internal' : 'other',
      note: optionalText(input.note, 'Not', 500),
      created_by: user.id || '', created_by_name: user.name || 'Yönetici'
    };
    try {
      await db.prepare(
        'INSERT INTO barcodes(id,code,target_kind,material_id,product_id,brand,pack_quantity_milli,pack_label,source,note,created_by,created_by_name) ' +
        'VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(row.id, row.code, row.target_kind, row.material_id, row.product_id, row.brand,
        row.pack_quantity_milli, row.pack_label, row.source, row.note, row.created_by, row.created_by_name).run();
    } catch (error) {
      const message = String(error.message);
      if (/UNIQUE constraint/.test(message)) fail('Bu barkod başka bir karta bağlandı. Sayfayı yenileyin.', 409);
      if (/BARCODE_NOT_GS1|BARCODE_INTERNAL_PREFIX|CHECK constraint/.test(message)) fail('Barkod bu bilgilerle kaydedilemez.', 409);
      throw error;
    }
    return {...present(await db.prepare(CARD_SQL + 'WHERE b.id=?').bind(row.id).first()), classification: info};
  }

  const single = sub.match(/^\/([\w-]{1,100})$/);
  if (single && method === 'POST') {
    const input = await readBody(request);
    const row = await db.prepare('SELECT * FROM barcodes WHERE id=?').bind(single[1]).first();
    if (!row) fail('Barkod bağlantısı bulunamadı.', 404);
    if (input.active !== undefined && typeof input.active !== 'boolean') fail('Durum seçimi geçersiz.');
    try {
      await db.prepare('UPDATE barcodes SET brand=?,pack_quantity_milli=?,pack_label=?,note=?,active=? WHERE id=?')
        .bind(optionalText(input.brand, 'Marka', 200), packMilli(input.pack_quantity),
          optionalText(input.pack_label, 'Ambalaj açıklaması', 200), optionalText(input.note, 'Not', 500),
          input.active === undefined ? row.active : (input.active ? 1 : 0), row.id).run();
    } catch (error) {
      // Kod ve kart bağlantısı değiştirilemez: yanlış bağlantı silinip yeniden kurulur.
      if (/BARCODE_RELINK/.test(String(error.message))) fail('Barkodun kendisi ve bağlı kart değiştirilemez.', 409);
      throw error;
    }
    return present(await db.prepare(CARD_SQL + 'WHERE b.id=?').bind(row.id).first());
  }

  if (single && method === 'DELETE') {
    const row = await db.prepare('SELECT id FROM barcodes WHERE id=?').bind(single[1]).first();
    if (!row) fail('Barkod bağlantısı bulunamadı.', 404);
    // Bağlantıyı silmek geçmişi bozmaz: stok hareketleri karta bağlıdır, barkoda değil.
    await db.prepare('DELETE FROM barcodes WHERE id=?').bind(row.id).run();
    return {ok: true};
  }

  fail('İstek bulunamadı.', 404);
}
