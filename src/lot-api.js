// Üretim partisi (lot) ve koli etiketi uçları. YALNIZCA üretim (lp) çalışma alanı.
//
// Parti kodu ÜRÜN BARKODU DEĞİLDİR. Barkod ürünün kimliğidir; parti o ürünün belirli
// bir üretimidir. Koli etiketi ikisini birlikte taşır ama karıştırmaz.
//
// Bu dosya stok DEĞİŞTİRMEZ: parti açmak ya da etiket basmak hiçbir stok hareketi
// üretmez. Miktar ve maliyet eskisi gibi üretim işleri üzerinden yürür.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const id = () => crypto.randomUUID();
const today = () => new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});

const day = (value, label = 'Tarih') => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value) fail(label + ' geçersiz.');
  return value;
};
const optionalDay = (value, label) => (value === undefined || value === null || value === '' ? null : day(value, label));
const optionalText = (value, label, max = 500) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > max) fail(label + ' alanını kontrol edin.');
  return value.trim();
};
const key = value => { if (!/^[\w-]{1,100}$/.test(value || '')) fail('Kayıt seçimi geçersiz.'); return value; };
const milli = (value, label, {required = true} = {}) => {
  if (value === undefined || value === null || value === '') { if (required) fail(label + ' gerekli.'); return null; }
  const parsed = Number(String(value).replace(',', '.')), result = Math.round(parsed * 1000);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(result) || result > 100000000000)
    fail(label + ' sıfırdan büyük bir sayı olmalı.');
  return result;
};

// Parti kodu okunabilir ve tekildir: yıl-ay + sıra. Kullanıcı kendi kodunu da yazabilir.
export const LOT_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._\-/]{1,39}$/;
export async function nextLotCode(db, produced, table = 'lots') {
  const prefix = produced.slice(0, 7) + '-P';
  const last = await db.prepare('SELECT lot_code FROM ' + table + ' WHERE lot_code LIKE ? ORDER BY lot_code DESC LIMIT 1')
    .bind(prefix + '%').first();
  const previous = last ? Number(last.lot_code.slice(prefix.length)) : 0;
  if (!Number.isSafeInteger(previous) || previous >= 999) fail('Bu ay için parti numarası tükendi.', 409);
  return prefix + String(previous + 1).padStart(3, '0');
}

const LOT_SQL =
  'SELECT l.*, p.name product_name, p.sku product_sku, p.stock_unit product_unit, ' +
  'j.reference job_reference, ' +
  '(SELECT COUNT(*) FROM carton_labels c WHERE c.lot_id=l.id) printed_cartons, ' +
  '(SELECT COALESCE(SUM(c.quantity_milli),0) FROM carton_labels c WHERE c.lot_id=l.id) printed_quantity_milli ' +
  'FROM lots l JOIN products p ON p.id=l.product_id LEFT JOIN lp_production_jobs j ON j.id=l.job_id ';

export async function lotApi(request, env, path, readBody) {
  if (!path.startsWith('/api/lots')) return null;
  if (env.WORKSPACE !== 'lp') fail('Parti ve koli etiketi yalnızca üretim çalışma alanında kullanılır.', 403);
  const db = env.DB, method = request.method, url = new URL(request.url);
  const user = env.USER || {};
  const sub = path.slice('/api/lots'.length);

  if (sub === '' && method === 'GET') {
    const product = url.searchParams.get('product_id') || '';
    const status = url.searchParams.get('status') || '';
    if (status && !['open', 'closed', 'blocked'].includes(status)) fail('Parti durumu geçersiz.');
    const terms = [], args = [];
    if (product) { terms.push('l.product_id=?'); args.push(key(product)); }
    if (status) { terms.push('l.status=?'); args.push(status); }
    const where = terms.length ? 'WHERE ' + terms.join(' AND ') + ' ' : '';
    const rows = (await db.prepare(LOT_SQL + where + 'ORDER BY l.produced_on DESC,l.lot_code DESC LIMIT 300').bind(...args).all()).results;
    return {workspace: env.WORKSPACE, lots: rows, as_of: today()};
  }

  const single = sub.match(/^\/([\w-]{1,100})$/);
  if (single && method === 'GET') {
    const row = await db.prepare(LOT_SQL + 'WHERE l.id=?').bind(single[1]).first();
    if (!row) fail('Parti bulunamadı.', 404);
    const cartons = (await db.prepare(
      'SELECT id,sequence,total_cartons,quantity_milli,barcode,printed_by_name,printed_at FROM carton_labels WHERE lot_id=? ORDER BY sequence'
    ).bind(row.id).all()).results;
    // Ürünün tanımlı barkodları: koli etiketinde hangisinin basılacağını kullanıcı seçer.
    const barcodes = (await db.prepare(
      'SELECT id,code,brand,pack_label,source,pack_quantity_milli FROM barcodes WHERE product_id=? AND active=1 ORDER BY code'
    ).bind(row.product_id).all()).results;
    return {...row, cartons, barcodes, workspace: env.WORKSPACE};
  }

  if (sub === '' && method === 'POST') {
    const input = await readBody(request);
    const product = key(input.product_id);
    const card = await db.prepare('SELECT id,name,stock_unit FROM products WHERE id=?').bind(product).first();
    if (!card) fail('Ürün bu çalışma alanında bulunamadı.', 404);
    const produced = day(input.produced_on, 'Üretim tarihi');
    const bestBefore = optionalDay(input.best_before, 'Son kullanma tarihi');
    if (bestBefore && bestBefore < produced) fail('Son kullanma tarihi üretim tarihinden önce olamaz.');

    let job = null;
    if (input.job_id) {
      job = await db.prepare('SELECT id,product_id,status FROM lp_production_jobs WHERE id=?').bind(key(input.job_id)).first();
      if (!job) fail('Üretim işi bulunamadı.', 404);
      if (job.product_id !== product) fail('Üretim işi başka bir ürüne ait.');
      if (job.status !== 'posted') fail('Yalnızca kaydedilmiş bir üretim işine parti bağlanır.', 409);
    }

    let code;
    if (input.lot_code) {
      code = String(input.lot_code).trim();
      if (!LOT_PATTERN.test(code)) fail('Parti kodu 2-40 karakter olmalı ve harf/rakam ile başlamalı.');
      if (await db.prepare('SELECT id FROM lots WHERE lot_code=?').bind(code).first())
        fail('Bu parti kodu zaten kullanılmış.', 409);
    } else {
      code = await nextLotCode(db, produced);
    }

    const row = {
      id: id(), lot_code: code, product_id: product, job_id: job ? job.id : null,
      produced_on: produced, best_before: bestBefore,
      quantity_milli: milli(input.quantity, 'Üretilen miktar'),
      unit: card.stock_unit,
      pack_size_milli: milli(input.pack_size, 'Koli içi adet', {required: false}),
      note: optionalText(input.note, 'Not'),
      created_by: user.id || '', created_by_name: user.name || 'Yönetici'
    };
    try {
      await db.prepare(
        'INSERT INTO lots(id,lot_code,product_id,job_id,produced_on,best_before,quantity_milli,unit,pack_size_milli,note,created_by,created_by_name) ' +
        'VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(row.id, row.lot_code, row.product_id, row.job_id, row.produced_on, row.best_before,
        row.quantity_milli, row.unit, row.pack_size_milli, row.note, row.created_by, row.created_by_name).run();
    } catch (error) {
      if (/UNIQUE constraint/.test(String(error.message))) fail('Bu parti kodu az önce kullanıldı. Tekrar deneyin.', 409);
      throw error;
    }
    return await db.prepare(LOT_SQL + 'WHERE l.id=?').bind(row.id).first();
  }

  if (single && method === 'POST') {
    const input = await readBody(request);
    const row = await db.prepare('SELECT * FROM lots WHERE id=?').bind(single[1]).first();
    if (!row) fail('Parti bulunamadı.', 404);
    const status = input.status === undefined ? row.status : input.status;
    if (!['open', 'closed', 'blocked'].includes(status)) fail('Parti durumu geçersiz.');
    const verilenNot = optionalText(input.status_note, 'Durum açıklaması', 1000);
    const note = verilenNot || row.status_note;
    // Durum değişikliği gerekçesiz kaydedilmez. Kapanmış bir partiyi yeniden açmak da
    // bir karardır: sessizce olmaz, nedeni kayda geçer.
    if (status !== row.status && !verilenNot)
      fail(status === 'open' && row.status === 'closed'
        ? 'Kapanmış partiyi yeniden açmak için nedenini yazın.'
        : 'Parti durumunu değiştirmek için nedenini yazın.');
    try {
      await db.prepare('UPDATE lots SET best_before=?,pack_size_milli=?,note=?,status=?,status_note=? WHERE id=?')
        .bind(optionalDay(input.best_before, 'Son kullanma tarihi') ?? row.best_before,
          input.pack_size === undefined ? row.pack_size_milli : milli(input.pack_size, 'Koli içi adet', {required: false}),
          input.note === undefined ? row.note : optionalText(input.note, 'Not'),
          status, note, row.id).run();
    } catch (error) {
      // Parti kodu ve ürün bağı bilerek dondurulmuştur: basılmış etiket anlam değiştirmesin.
      if (/LOT_IMMUTABLE/.test(String(error.message))) fail('Parti kodu ve ürün bağlantısı değiştirilemez.', 409);
      if (/CHECK constraint/.test(String(error.message))) fail('Parti bu bilgilerle kaydedilemez.', 409);
      throw error;
    }
    return await db.prepare(LOT_SQL + 'WHERE l.id=?').bind(row.id).first();
  }

  // Koli etiketi basımı. Etiket kayıtları DEĞİŞTİRİLEMEZ ve SİLİNEMEZ:
  // hangi kolinin ne taşıdığı geriye dönük değişmemelidir.
  const cartons = sub.match(/^\/([\w-]{1,100})\/cartons$/);
  if (cartons && method === 'POST') {
    const input = await readBody(request);
    const lot = await db.prepare(LOT_SQL + 'WHERE l.id=?').bind(cartons[1]).first();
    if (!lot) fail('Parti bulunamadı.', 404);
    if (lot.status !== 'open') fail('Yalnızca açık partiye koli etiketi basılır.', 409);

    const count = Number(input.count);
    if (!Number.isSafeInteger(count) || count < 1 || count > 500) fail('Koli sayısı 1 ile 500 arasında olmalı.');
    const perCarton = milli(input.quantity_per_carton ?? (lot.pack_size_milli ? lot.pack_size_milli / 1000 : null), 'Koli içi adet');

    let barcode = String(input.barcode || '').trim();
    if (barcode) {
      const link = await db.prepare('SELECT code,product_id FROM barcodes WHERE code=? AND active=1').bind(barcode).first();
      if (!link) fail('Bu barkod tanımlı değil. Önce Barkod ekranından ürüne bağlayın.', 404);
      if (link.product_id !== lot.product_id) fail('Seçilen barkod başka bir ürüne ait.');
    } else {
      const link = await db.prepare('SELECT code FROM barcodes WHERE product_id=? AND active=1 ORDER BY code LIMIT 1').bind(lot.product_id).first();
      if (!link) fail('Bu ürünün tanımlı barkodu yok. Önce Barkod ekranından bir barkod bağlayın.', 409);
      barcode = link.code;
    }

    const already = lot.printed_cartons || 0;
    const total = already + count;
    // Basılan toplam, partide üretilen miktarı aşamaz: olmayan mal etiketlenmesin.
    if (perCarton * total > lot.quantity_milli)
      fail('Bu kadar koli partideki miktarı aşıyor. Partide ' + (lot.quantity_milli / 1000) + ' ' + lot.unit + ' var.', 409);

    const snapshot = {
      lot_code: lot.lot_code, product_name: lot.product_name, product_sku: lot.product_sku,
      produced_on: lot.produced_on, best_before: lot.best_before, unit: lot.unit,
      notice: 'Parti kodu ürün barkodu değildir. Bu etiket stok hareketi oluşturmaz.'
    };
    const items = [];
    for (let i = 0; i < count; i++) {
      const sequence = already + i + 1;
      items.push({
        id: id(), lot_id: lot.id, sequence, total_cartons: total,
        quantity_milli: perCarton, barcode,
        snapshot_json: JSON.stringify({...snapshot, sequence, total_cartons: total, quantity_milli: perCarton, barcode})
      });
    }
    try {
      await db.batch(items.map(item => db.prepare(
        'INSERT INTO carton_labels(id,lot_id,sequence,total_cartons,quantity_milli,barcode,snapshot_json,printed_by,printed_by_name) ' +
        'VALUES(?,?,?,?,?,?,?,?,?)'
      ).bind(item.id, item.lot_id, item.sequence, item.total_cartons, item.quantity_milli, item.barcode,
        item.snapshot_json, user.id || '', user.name || 'Yönetici')));
    } catch (error) {
      const message = String(error.message);
      if (/UNIQUE constraint/.test(message)) fail('Bu koli sırası zaten basılmış. Sayfayı yenileyin.', 409);
      if (/LOT_NOT_OPEN/.test(message)) fail('Parti kapalı; etiket basılamaz.', 409);
      throw error;
    }
    const saved = (await db.prepare(
      'SELECT id,sequence,total_cartons,quantity_milli,barcode,printed_by_name,printed_at FROM carton_labels WHERE lot_id=? ORDER BY sequence'
    ).bind(lot.id).all()).results;
    return {
      lot: await db.prepare(LOT_SQL + 'WHERE l.id=?').bind(lot.id).first(),
      printed: saved.filter(row => items.some(item => item.id === row.id)),
      cartons: saved,
      notice: 'Etiket kayıtları değiştirilemez ve silinemez. Bu işlem stok hareketi oluşturmaz.'
    };
  }

  fail('İstek bulunamadı.', 404);
}
