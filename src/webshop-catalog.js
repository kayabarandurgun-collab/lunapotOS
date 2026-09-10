// Web mağaza kataloğu ↔ e-ticaret stok kartı eşlemesi.
//
// Tek stok kaynağı: web varyantı kendi "gerçek" stoğunu TUTMAZ. Hangi e-ticaret ürün kartından
// (ec_products) kaç birim tükettiği yazılır; satılabilir miktar oradaki bakiyeden, pazaryeri
// ayırmaları VE web ayırmaları düşülerek hesaplanır. Set ve ambalaj dönüşümü aynı yolla ifade
// edilir: "2'li set" = aynı karttan 2 birim.
//
// KDV ikinci kez tutulmaz: ürünün fiyat profilindeki (ec_price_profiles.vat_bps) oran kullanılır.
// Oran yoksa varyant satışa hazır SAYILMAZ; sıfır diye varsayılmaz.
//
// Test siparişleri (is_test=1) gerçek stok ayıramaz; bu kural veritabanında tetikle korunur.
// Sahte fiyat, çok satan ya da değerlendirme verisi üretilmez.

const quantityMilli = value => {
  const parsed = Number(value), milli = Math.round(parsed * 1000);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(milli) || milli > 100000000000)
    throw Object.assign(new Error('Tüketim miktarı sıfırdan büyük bir sayı olmalı.'), {status: 400});
  return milli;
};

/** Bir varyantın satılabilir adedi: bileşenlerin en kısıtlayıcısı. Bileşen yoksa null (bilinmiyor). */
export function sellableUnits(components) {
  if (!components.length) return null;
  let units = Infinity;
  for (const c of components) {
    const free = Math.max(0, (c.balance_milli || 0) - (c.ec_reserved_milli || 0) - (c.ws_reserved_milli || 0));
    units = Math.min(units, Math.floor(free / c.quantity_milli));
  }
  return units;
}

/** Satışa hazırlık engelleri. Boş liste = bu varyant için teknik engel yok. */
export function variantBlockers(variant, components) {
  const blockers = [];
  if (!components.length) blockers.push('Gerçek stok kartına bağlanmadı.');
  const noVat = components.filter(c => c.vat_bps === null || c.vat_bps === undefined);
  if (noVat.length) blockers.push('KDV oranı tanımlı değil: ' + noVat.map(c => c.product_name).join(', '));
  if (!variant.active) blockers.push('Mağazada kapalı.');
  const units = sellableUnits(components);
  if (units === 0) blockers.push('Gerçek stokta satılabilir adet yok.');
  return blockers;
}

async function readiness(db) {
  const variants = (await db.prepare('SELECT id,product_id,name,size,category,price_cents,stock test_stock,active FROM ws_catalog ORDER BY name,size').all()).results;
  const rows = (await db.prepare(
    'SELECT c.variant_id,c.product_id,c.quantity_milli,p.name product_name,p.sku,p.stock_unit,' +
    'COALESCE(b.quantity_milli,0) balance_milli,' +
    'COALESCE((SELECT SUM(r.quantity_milli) FROM ec_order_reservations r WHERE r.product_id=c.product_id AND r.released_on IS NULL),0) ec_reserved_milli,' +
    'COALESCE((SELECT SUM(w.quantity_milli) FROM ws_stock_reservations w WHERE w.product_id=c.product_id AND w.released_on IS NULL),0) ws_reserved_milli,' +
    'pp.vat_bps ' +
    'FROM ws_variant_components c JOIN ec_products p ON p.id=c.product_id ' +
    'LEFT JOIN ec_stock_balances b ON b.product_id=c.product_id LEFT JOIN ec_price_profiles pp ON pp.product_id=c.product_id ' +
    'ORDER BY c.variant_id,p.name'
  ).all()).results;
  return variants.map(variant => {
    const components = rows.filter(r => r.variant_id === variant.id);
    const vats = [...new Set(components.map(c => c.vat_bps).filter(v => v !== null && v !== undefined))];
    const blockers = variantBlockers(variant, components);
    // Farklı KDV oranlı bileşenlerden oluşan set tek oranla faturalanamaz; ayrıca belirtilir.
    if (vats.length > 1) blockers.push('Bileşenlerin KDV oranları farklı; set fatura kalemleri ayrıştırılmalı.');
    return {
      ...variant,
      components,
      sellable_units: sellableUnits(components),
      vat_bps: vats.length === 1 ? vats[0] : null,
      ready: blockers.length === 0,
      blockers
    };
  });
}

export async function catalogRoutes({request, env, path, readBody, user, helpers}) {
  const {requireDemo, event, fail} = helpers;
  const db = env.DB, method = request.method;
  const sub = path.slice('/api/webshop'.length);

  if (sub === '/catalog/readiness' && method === 'GET') {
    const items = await readiness(db);
    return {
      items,
      summary: {total: items.length, ready: items.filter(i => i.ready).length, unmapped: items.filter(i => !i.components.length).length},
      notice: 'Satılabilir adet gerçek e-ticaret stoğundan, pazaryeri ve web ayırmaları düşülerek hesaplanır. Test siparişleri bu stoğu ayırmaz.'
    };
  }

  const match = sub.match(/^\/catalog\/([\w-]{1,120})\/components$/);
  if (match && method === 'POST') {
    if (!user?.owner) fail('Stok kartı eşlemesini yönetici değiştirebilir.', 403);
    requireDemo(request, env);
    const variant = await db.prepare('SELECT id,name,size FROM ws_catalog WHERE id=?').bind(match[1]).first();
    if (!variant) fail('Katalog seçeneği bulunamadı.', 404);
    const input = await readBody(request);
    if (!Array.isArray(input.components) || input.components.length > 10) fail('1–10 stok kartı bileşeni gönderin.');
    const seen = new Set(), parsed = [];
    for (const c of input.components) {
      const product = String(c?.product_id || '');
      if (!/^[\w-]{1,100}$/.test(product)) fail('Stok kartı seçimi geçersiz.');
      if (seen.has(product)) fail('Aynı stok kartı bir seçenekte iki kez kullanılamaz.');
      seen.add(product);
      if (!await db.prepare('SELECT id FROM ec_products WHERE id=?').bind(product).first())
        fail('E-ticaret stok kartı bulunamadı. Web mağaza yalnızca e-ticaret kartlarına bağlanır.', 404);
      parsed.push({product_id: product, quantity_milli: quantityMilli(c.quantity)});
    }
    // Eşleme bütün olarak değişir: yarım kalan eşleme stok hesabını bozmasın.
    await db.batch([
      db.prepare('DELETE FROM ws_variant_components WHERE variant_id=?').bind(variant.id),
      ...parsed.map(c => db.prepare('INSERT INTO ws_variant_components(id,variant_id,product_id,quantity_milli) VALUES(?,?,?,?)')
        .bind(crypto.randomUUID(), variant.id, c.product_id, c.quantity_milli)),
      event(db, null, user.id || 'owner', `Stok eşlemesi: ${variant.name} ${variant.size} → ${parsed.length} kart`)
    ]);
    return (await readiness(db)).find(i => i.id === variant.id);
  }

  return null;
}
