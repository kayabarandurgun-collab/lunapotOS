// KAÇA SATMALIYIM? Ürün, kanal ve adet seçilir; kargo, hizmet bedeli, komisyon oranı ve stopaj
// GERÇEK teslimlerin ekstresinden (fee-history.js), maliyet ürünün son alış fiyatından gelir.
// Ölçü, ağırlık, tarife girmek gerekmez. Bütün tutarlar KDV DAHİL (kullanıcının gördüğü para).
//
//   GET /api/fiyat-hesap?product_id&channel&qty&price&target
//     price  : KDV dahil satış fiyatı (TL, isteğe bağlı) → cebine kalan
//     target : cebine kalması istenen tutar (TL, varsayılan 0) → gereken en düşük fiyat
//
// Sonuç her zaman TAHMİNDİR. Kargo/hizmet örnekleri istenen adede uymuyorsa (geçmişte yalnız daha az
// ya da yalnız daha çok adetli paket var: 'uzak') ya da ürünün hiç teslimi yoksa ('yok') kesin fiyat
// verilmez: guven='belirsiz', kısa uyarı ve açıkça etiketli senaryo döner. Tek paket kargosu adetle
// çarpılmaz. Ürün profilindeki ambalaj ve diğer paket gideri (KDV hariç, paket başına) bir kez düşülür;
// pazaryerinin hizmet bedeli (ekstreden) ayrı kalemdir. Başabaş ve hedef aynı gider kırılımını kullanır.
import {kesintiTahmincisi} from './fee-history.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const kurus = v => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(',', '.')); if (!Number.isFinite(n) || n < 0 || n > 1e7) fail('Tutar geçersiz.'); return Math.round(n * 100); };
const adetYaz = m => (m / 1000).toLocaleString('tr-TR');

export async function fiyatHesapApi(request, env, path) {
  if (path !== '/api/fiyat-hesap' || request.method !== 'GET') return null;
  if (env.WORKSPACE !== 'ec') fail('Bu hesap e-ticaret çalışma alanına aittir.', 403);
  const db = env.DB, q = new URL(request.url).searchParams;
  if (q.get('mode') === 'options') return offeringOptions(db, q.get('channel'));
  if (q.has('mapping_id')) return offeringQuote(db, q);
  const channel = q.get('channel') || '';
  if (!['trendyol', 'hepsiburada'].includes(channel)) fail('Kanal seçin.');
  const qty = Number(q.get('qty') || 1);
  if (!Number.isInteger(qty) || qty < 1 || qty > 100) fail('Adet 1 ile 100 arasında olmalı.');
  const price = kurus(q.get('price')), target = kurus(q.get('target')) ?? 0;
  const urun = await db.prepare('SELECT p.id,p.name,pp.product_id profil,pp.vat_bps,pp.replacement_cost_cents,pp.packaging_cents,pp.other_cents,pp.units_per_parcel FROM ec_products p LEFT JOIN ec_price_profiles pp ON pp.product_id=p.id WHERE p.id=?').bind(q.get('product_id') || '').first();
  if (!urun) fail('Ürün bulunamadı.', 404);
  // Maliyet: ürün profilindeki son alış fiyatı; yoksa son muhasebeleşmiş alış satırı. Uydurulmaz.
  let birim = urun.replacement_cost_cents;
  if (!birim) birim = (await db.prepare("SELECT CAST(ROUND(l.net_cents*1000.0/l.quantity_milli) AS INTEGER) b FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id WHERE l.product_id=? AND i.status='posted' AND l.line_type='product' AND l.quantity_milli>0 ORDER BY i.invoice_date DESC,i.created_at DESC LIMIT 1").bind(urun.id).first())?.b || null;
  if (!birim) fail('Bu ürünün alış fiyatı yok; önce alış faturasını girin.', 409);
  const v = urun.vat_bps ?? 2000;
  const fvRow = await db.prepare("SELECT json_extract(options_json,'$.fee_vat_bps') bps FROM ec_report_profiles WHERE kind='finance' AND provider=? AND json_extract(options_json,'$.fee_amounts_include_vat')=1 AND json_extract(options_json,'$.fee_vat_bps') IS NOT NULL LIMIT 1").bind(channel).first();
  const fv = fvRow?.bps ?? 2000;
  const h = (await kesintiTahmincisi(db))(channel, [{product_id: urun.id, quantity_milli: qty * 1000}], {adetSiniri: true});
  if (!h) fail('Bu kanalda henüz kesintisi gelmiş teslim yok; ilk teslimlerden sonra hesaplanır.', 409);

  const inc = (x, b) => Math.round(x * (10000 + b) / 10000);
  const maliyet = inc(birim * qty, v), kargo = inc(h.shipping, fv), hizmet = inc(h.other, fv);
  // Profil paket giderleri KDV hariç girilir; ürünün KDV oranıyla KDV dahil gösterilir. Paket başına bir kez.
  const profil = !!urun.profil, paketleme = inc(urun.packaging_cents ?? 0, v), diger = inc(urun.other_cents ?? 0, v);
  const sabit = maliyet + kargo + hizmet + paketleme + diger;
  // Fiyata bağlı kesintiler: komisyon (KDV hariç satışın oranı, KDV'siyle) ve stopaj (KDV dahil satışın oranı).
  const degisken = 1 - h.commissionRate * (10000 + fv) / (10000 + v) - h.withholdingRate;
  const dokum = P => {
    const komisyon = Math.round(P * 10000 / (10000 + v) * h.commissionRate * (10000 + fv) / 10000), stopaj = Math.round(P * h.withholdingRate);
    return {fiyat: P, maliyet, kargo, hizmet, komisyon, stopaj, paketleme, diger, cebine: P - sabit - komisyon - stopaj};
  };
  const fiyatFor = hedef => degisken > 0 ? Math.ceil((hedef + sabit) / degisken) : null;
  const sonuc = {
    fiyatla: price !== null ? dokum(price) : null,
    basabas: fiyatFor(0) === null ? null : dokum(fiyatFor(0)),
    hedef: target > 0 && fiyatFor(target) !== null ? {...dokum(fiyatFor(target)), istenen: target} : null
  };
  // Adet uyumu yoksa kesin öneri yok: aynı hesap yalnız etiketli senaryo olarak döner.
  const belirsiz = h.uyum === 'uzak' || h.uyum === 'yok', oa = h.ornekAdet;
  const uyari = !belirsiz ? null : h.uyum === 'yok'
    ? 'Bu ürünün teslim geçmişi yok; kargo ve hizmet bedeli başka ürünlerin paketlerinden. Rakamlar senaryodur, fiyat önerisi değildir.'
    : qty + ' adetlik paketin kargosu bilinmiyor: bu ürün geçmişte en ' + (oa.en_cok < qty * 1000 ? 'çok ' : 'az ') + adetYaz(oa.en_cok) + ' adetlik pakette teslim edildi. Rakamlar ' + adetYaz(oa.en_cok) + ' adetlik paketin kargo ve hizmet bedeliyle kurulmuş senaryodur, fiyat önerisi değildir.';
  const giderNot = !profil ? 'Ürün profili yok: ambalaj ve diğer paket gideri 0 sayıldı; "Ürün ve paket" sekmesinden girilebilir.'
    : 'Ambalaj ve diğer paket gideri ürün profilinden; KDV hariç girilen tutar KDV eklenerek, paket başına bir kez düşüldü.'
      + ((urun.packaging_cents || urun.other_cents) && urun.units_per_parcel !== qty ? ' Profil ' + urun.units_per_parcel + ' adetlik pakete göre girilmiş.' : '');
  return {
    urun: {id: urun.id, name: urun.name, birim_maliyet_kdv_dahil: inc(birim, v)}, channel, qty,
    guven: belirsiz ? 'belirsiz' : 'tahmini', uyari,
    kesinti: {kargo, hizmet, komisyon_orani: h.commissionRate, stopaj_orani: h.withholdingRate, kaynak: h.source, ornek: h.n, not: h.note,
      adet_uyumu: h.uyum, ornek_adet: oa ? {en_az: oa.en_az / 1000, en_cok: oa.en_cok / 1000} : null},
    gider: {paketleme, diger, profil, not: giderNot},
    ...(belirsiz ? {fiyatla: null, basabas: null, hedef: null,
      senaryo: {aciklama: h.uyum === 'yok' ? 'Kargo ve hizmet bedeli kanalın son teslimlerindeki gibi olursa' : 'Kargo ve hizmet bedeli ' + adetYaz(oa.en_cok) + ' adetlik paketteki gibi kalırsa', ...sonuc}}
      : {...sonuc, senaryo: null})
  };
}

// Mapped offerings are a separate read-only contract. The legacy product quote above stays intact.
const validVat = v => Number.isInteger(v) && v >= 0 && v <= 10000;
const grossOf = (net, vat) => Math.round(net * (10000 + vat) / 10000);
const queryAll = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
const offeringKind = parts => parts.length > 1 ? 'bundle' : parts.length === 1 && parts[0].stock_unit === 'adet' && parts[0].quantity_milli > 1000 ? 'multipack' : parts.length === 1 && parts[0].quantity_milli === 1000 ? 'single' : 'mapped';
async function offeringOptions(db, channel) {
  if (channel && !['trendyol', 'hepsiburada'].includes(channel)) fail('Kanal seçin.');
  const mappings = await queryAll(db, "SELECT id,external_name name,external_code,source channel,version FROM ec_catalog_mappings WHERE active=1 AND source IN ('trendyol','hepsiburada') AND (?='' OR source=?) ORDER BY external_name,id LIMIT 1001", channel || '', channel || '');
  const selected = mappings.slice(0, 1000);
  const components = await queryAll(db, 'SELECT c.mapping_id,c.product_id,c.quantity_milli,p.name product_name,p.sku,p.stock_unit FROM ec_catalog_mapping_components c JOIN ec_products p ON p.id=c.product_id WHERE c.mapping_id IN (SELECT value FROM json_each(?)) ORDER BY c.rowid', JSON.stringify(selected.map(m => m.id)));
  return {offerings: selected.map(m => { const parts = components.filter(c => c.mapping_id === m.id); return {...m, name: m.name || m.external_code, kind: offeringKind(parts), components: parts}; }), truncated: mappings.length > 1000};
}

async function offeringQuote(db, q) {
  if (q.get('product_id')) fail('Satılan ürün bağlantısı veya stok ürünü seçin; ikisi birlikte hesaplanamaz.');
  const mapping = await db.prepare("SELECT id,external_name name,external_code,source channel,version FROM ec_catalog_mappings WHERE id=? AND active=1 AND source IN ('trendyol','hepsiburada')").bind(q.get('mapping_id')).first();
  if (!mapping) fail('Etkin satılan ürün bağlantısı bulunamadı.', 404);
  const channel = q.get('channel') || mapping.channel;
  if (channel !== mapping.channel) fail('Satılan ürün bağlantısı seçilen kanala ait değil.');
  const qty = Number(q.get('qty') || 1);
  if (!Number.isInteger(qty) || qty < 1 || qty > 100) fail('Adet 1 ile 100 arasında olmalı.');
  const price = kurus(q.get('price')), target = kurus(q.get('target')) ?? 0;
  // Explicit package expenses are GROSS and cover this entire quote once, even for multiple sets.
  const packaging = kurus(q.get('packaging')), other = kurus(q.get('other'));
  let saleVat = null;
  const explicitVat = q.has('sale_vat_rate') && q.get('sale_vat_rate').trim() !== '';
  if (explicitVat) {
    const percent = Number(q.get('sale_vat_rate').replace(',', '.'));
    const scaled = percent * 100;
    if (!Number.isFinite(percent) || Math.abs(scaled - Math.round(scaled)) > 0.000001 || !validVat(Math.round(scaled))) fail('Satış KDV senaryosu %0–100 arasında ve en fazla iki ondalıklı olmalı.');
    saleVat = Math.round(scaled);
  }
  const rows = await queryAll(db, `SELECT c.product_id,c.quantity_milli,p.name product_name,p.sku,p.stock_unit,
    pp.vat_bps,pp.replacement_cost_cents,
    (SELECT l.id FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id WHERE l.product_id=c.product_id AND i.status='posted' AND l.line_type='product' AND l.quantity_milli>0 ORDER BY i.invoice_date DESC,i.created_at DESC,l.rowid DESC LIMIT 1) purchase_line_id
    FROM ec_catalog_mapping_components c JOIN ec_products p ON p.id=c.product_id LEFT JOIN ec_price_profiles pp ON pp.product_id=p.id WHERE c.mapping_id=? ORDER BY c.rowid`, mapping.id);
  if (!rows.length || rows.length > 10) fail('Satılan ürünün stok bileşenleri doğrulanamadı.', 409);
  if (rows.some(c => !Number.isSafeInteger(c.quantity_milli) || c.quantity_milli <= 0 || c.quantity_milli * qty > 1000000000 || c.stock_unit === 'adet' && c.quantity_milli % 1000 !== 0)) fail('İstenen paket stok bileşeni miktar sınırını aşıyor veya birimine uymuyor.', 409);
  const purchases = await queryAll(db, 'SELECT id,quantity_milli,net_cents,tax_cents FROM ec_purchase_lines WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(rows.map(c => c.purchase_line_id).filter(Boolean)));
  const components = rows.map(c => {
    const purchase = purchases.find(p => p.id === c.purchase_line_id), total = c.quantity_milli * qty;
    // A zero replacement profile is not evidence of a free product. Posted zero-cost purchases are.
    const profile = c.replacement_cost_cents > 0 && validVat(c.vat_bps);
    const net = profile ? c.replacement_cost_cents : purchase ? purchase.net_cents * 1000 / purchase.quantity_milli : null;
    const vat = profile ? c.vat_bps : purchase?.net_cents > 0 ? Math.round(purchase.tax_cents * 10000 / purchase.net_cents) : null;
    const unitGross = profile ? grossOf(net, vat) : purchase ? Math.round((purchase.net_cents + purchase.tax_cents) * 1000 / purchase.quantity_milli) : null;
    const cost = profile ? Math.round(net * total / 1000 * (10000 + vat) / 10000) : purchase ? Math.round((purchase.net_cents + purchase.tax_cents) * total / purchase.quantity_milli) : null;
    return {product_id: c.product_id, product_name: c.product_name, sku: c.sku, stock_unit: c.stock_unit,
      quantity_milli: c.quantity_milli, total_quantity_milli: total, cost_vat_bps: vat,
      unit_cost_gross_cents: unitGross, cost_gross_cents: cost, cost_source: profile ? 'profile' : purchase ? 'posted_purchase' : 'unknown'};
  });
  // Sale VAT is a sale-line fact, never the VAT of a conveniently chosen stock component.
  // Mapping identity AND recorded composition ratio must match; historical snapshots are not edited.
  if (!explicitVat) {
    const vats = await queryAll(db, `SELECT DISTINCT l.vat_bps FROM ec_order_lines l JOIN ec_order_packages p ON p.id=l.package_id
      WHERE p.channel=? AND p.status='delivered' AND l.quantity_milli>0
      AND (SELECT COUNT(*) FROM ec_order_line_components c WHERE c.line_id=l.id)=?
      AND NOT EXISTS (SELECT 1 FROM ec_order_line_components c WHERE c.line_id=l.id AND NOT EXISTS
        (SELECT 1 FROM ec_catalog_mapping_components m WHERE m.mapping_id=? AND c.mapping_id=m.mapping_id AND c.product_id=m.product_id AND c.stock_unit=(SELECT stock_unit FROM ec_products WHERE id=m.product_id) AND c.quantity_milli*1000=m.quantity_milli*l.quantity_milli))`, channel, rows.length, mapping.id);
    if (vats.length === 1 && validVat(vats[0].vat_bps)) saleVat = vats[0].vat_bps;
  }
  const feeRows = await queryAll(db, "SELECT DISTINCT json_extract(options_json,'$.fee_vat_bps') bps FROM ec_report_profiles WHERE kind='finance' AND provider=? AND json_extract(options_json,'$.fee_amounts_include_vat')=1", channel);
  const feeVat = feeRows.length === 1 && validVat(feeRows[0].bps) ? feeRows[0].bps : null;
  const h = (await kesintiTahmincisi(db))(channel, components.map(c => ({product_id: c.product_id, quantity_milli: c.total_quantity_milli})), {adetSiniri: true});
  const mixed = components.length > 1;
  // The shared strict helper can choose one component of a mixed set. Never treat that as set evidence.
  const compositionMatch = h?.source === 'content';
  const uncertainHistory = !h || ['uzak', 'yok'].includes(h.uyum) || mixed && !compositionMatch;
  const missing = [], assumptions = [];
  for (const c of components) if (c.cost_gross_cents === null) missing.push(c.product_name + ': alış maliyeti veya alış KDV bilgisi eksik.');
  if (saleVat === null) missing.push('Satılan ürünün doğrulanmış satış KDV oranı yok. Etiketli hesap için satış KDV senaryosu girin.');
  if (feeVat === null) missing.push('Kanalın kesinti KDV oranı eksik veya çelişkili.');
  if (!h) missing.push('Bu kanalda kesintileri bilinen teslim geçmişi yok.');
  if (explicitVat) assumptions.push('Satış KDV oranı kullanıcının girdiği senaryodur; doğrulanmış satış vergisi değildir.');
  if (packaging === null || other === null) assumptions.push('Girilmemiş ambalaj / diğer paket gideri bu senaryoda 0 sayıldı. Bilinen sıfır için 0 girin.');
  if (uncertainHistory && h) assumptions.push(mixed && !compositionMatch
    ? 'Bu setin tamamıyla aynı içerik ve adette teslim yok. Seçilen tek ürün / kanal geçmişinin kargo ve hizmet bedeli yalnız senaryo varsayımıdır.'
    : h.uyari || 'İstenen adet için uyumlu teslim yok; kargo ve hizmet bedeli yalnız senaryo varsayımıdır.');
  const cost = components.every(c => c.cost_gross_cents !== null) ? components.reduce((n, c) => n + c.cost_gross_cents, 0) : null;
  const shipping = h && feeVat !== null ? grossOf(h.shipping, feeVat) : null;
  const service = h && feeVat !== null ? grossOf(h.other, feeVat) : null;
  let result = {fiyatla: null, basabas: null, hedef: null};
  if (!missing.length) {
    const fixed = cost + shipping + service + (packaging ?? 0) + (other ?? 0);
    const factor = 1 - h.commissionRate * (10000 + feeVat) / (10000 + saleVat) - h.withholdingRate;
    const breakdown = P => {
      const komisyon = Math.round(P * h.commissionRate * (10000 + feeVat) / (10000 + saleVat)), stopaj = Math.round(P * h.withholdingRate);
      return {fiyat: P, maliyet: cost, kargo: shipping, hizmet: service, komisyon, stopaj, paketleme: packaging ?? 0, diger: other ?? 0, cebine: P - fixed - komisyon - stopaj};
    };
    const floor = goal => {
      if (factor <= 0) return null;
      let P = Math.ceil((fixed + goal) / factor);
      if (!Number.isSafeInteger(P)) return null;
      // Independent fee rounding can leave a one-cent shortfall at the algebraic floor.
      for (let i = 0; i < 4 && breakdown(P).cebine < goal; i++) {
        P += Math.max(1, Math.ceil((goal - breakdown(P).cebine) / factor));
        if (!Number.isSafeInteger(P)) return null;
      }
      return breakdown(P).cebine >= goal ? breakdown(P) : null;
    };
    const targetResult = target > 0 ? floor(target) : null;
    result = {fiyatla: price === null ? null : breakdown(price), basabas: floor(0), hedef: targetResult ? {...targetResult, istenen: target} : null};
    if (!result.basabas || target > 0 && !targetResult) missing.push('Kesinti oranlarıyla ulaşılabilir başabaş veya hedef fiyat hesaplanamıyor.');
  }
  const uncertain = missing.length > 0 || assumptions.length > 0;
  return {
    offering: {mapping_id: mapping.id, name: mapping.name || mapping.external_code, external_code: mapping.external_code, version: mapping.version, kind: offeringKind(rows), components},
    channel, qty, quote_unit: 'whole_parcel', sale_vat_bps: saleVat, sale_vat_source: explicitVat ? 'scenario' : saleVat === null ? 'unknown' : 'mapped_delivered_lines',
    cost_gross_cents: cost, guven: uncertain ? 'belirsiz' : 'tahmini', uyari: [...missing, ...assumptions].join(' ') || null, missing, assumptions,
    kesinti: {kargo: shipping, hizmet: service, komisyon_orani: h?.commissionRate ?? null, stopaj_orani: h?.withholdingRate ?? null,
      kaynak: h?.source ?? null, ornek: h?.n ?? 0, not: h?.note ?? 'Teslim geçmişi bekleniyor.', adet_uyumu: h?.uyum ?? 'yok',
      composition_match: compositionMatch, ornek_adet: h?.ornekAdet ? {en_az: h.ornekAdet.en_az / 1000, en_cok: h.ornekAdet.en_cok / 1000} : null},
    gider: {paketleme: packaging, diger: other, profil: false, not: 'Ambalaj ve diğer gider bu teklifin tamamına KDV dahil bir kez girilir. Bileşen profillerinin paket giderleri toplanmaz.'},
    ...(uncertain ? {fiyatla: null, basabas: null, hedef: null, senaryo: !missing.length ? {aciklama: assumptions.join(' '), ...result} : null} : {...result, senaryo: null})
  };
}
