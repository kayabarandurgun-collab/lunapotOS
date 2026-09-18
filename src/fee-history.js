// GEÇMİŞTEN KESİNTİ TAHMİNİ. Kargo, hizmet bedeli ve komisyon oranı pazaryerinin GERÇEK ekstresinden
// gelmiş, teslim edilmiş paketlerden öğrenilir; tarife ya da elle girilen ölçü beklenmez.
// Kargodaki paketin tahmini, kesintisi henüz ekstreye yazılmamış teslim ve "Kaça satmalıyım" hesabı
// aynı kaynağı kullanır.
//
// Örnek seçimi (ilk bulunan):
//  1. aynı kanal, aynı içerik (hangi stok ürününden kaç adet): son 5 teslim
//  2. aynı kanal, aynı ürünü tek başına taşıyan paketler: adedi en yakın 5 teslim
//  3. aynı ürünün DİĞER kanaldaki teslimleri (kargo, hizmet); komisyon oranı bu kanalın ortancası.
//     Hacimli ürünün (39 kg torf balyası) kargosu kanal ortalamasıyla tahmin edilemez.
//  4. aynı kanal: son 30 teslim
// Tutarlar ORTANCA alınır: tek bir sıra dışı paket (ceza, ek ücret) tahmini bozmaz.
// İade edilmiş paket örnek alınmaz: dönüş kargosu normal satışın kesintisi değildir.
// Tutarlar KDV HARİÇTİR (satış kaydındaki kesintilerle aynı); stopaj KDV dahil satışa oranla verilir.

const ortanca = v => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const icerik = parts => JSON.stringify(Object.entries(parts.reduce((m, c) => (m[c.product_id] = (m[c.product_id] || 0) + c.quantity_milli, m), {})).sort());

export async function kesintiTahmincisi(db) {
  const [pk, cp, sl, iade, stopaj] = (await db.batch([
    db.prepare("SELECT id,channel,delivered_on FROM ec_order_packages WHERE status='delivered' AND channel IN ('trendyol','hepsiburada') ORDER BY delivered_on DESC,rowid DESC LIMIT 2000"),
    db.prepare("SELECT l.package_id,c.product_id,c.quantity_milli FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id JOIN ec_order_packages q ON q.id=l.package_id WHERE q.status='delivered'"),
    db.prepare("SELECT l.package_id,s.revenue_cents,s.shipping_cents,s.commission_cents,s.other_cents FROM ec_sale_entries s JOIN ec_order_line_components c ON s.id=c.sale_id JOIN ec_order_lines l ON l.id=c.line_id JOIN ec_order_packages q ON q.id=l.package_id WHERE q.status='delivered' AND s.kind='sale'"),
    db.prepare("SELECT DISTINCT l.package_id FROM ec_sale_entries r JOIN ec_order_line_components c ON r.parent_id=c.sale_id JOIN ec_order_lines l ON l.id=c.line_id WHERE r.kind='return'"),
    // Stopaj oranı: stopajı raporda görünen siparişlerde stopaj / KDV dahil satış.
    db.prepare(`SELECT s.provider,json_extract(r.data_json,'$.order_no') o,SUM(CASE WHEN json_extract(r.data_json,'$.type')='withholding' THEN json_extract(r.data_json,'$.amount_cents') ELSE 0 END) w,
      SUM(CASE WHEN json_extract(r.data_json,'$.type')='sale' THEN json_extract(r.data_json,'$.amount_cents') ELSE 0 END) sale
      FROM ec_report_records r JOIN ec_report_stores s ON s.id=r.store_id WHERE r.kind='finance_event' AND json_extract(r.data_json,'$.type') IN ('withholding','sale') GROUP BY 1,2`)
  ])).map(r => r.results);
  const grup = rows => { const m = new Map(); for (const r of rows) m.set(r.package_id, [...(m.get(r.package_id) || []), r]); return m; };
  const cpBy = grup(cp), slBy = grup(sl), iadeli = new Set(iade.map(r => r.package_id));
  const ornekler = [];
  for (const p of pk) {
    const parts = cpBy.get(p.id) || [], sales = slBy.get(p.id) || [];
    if (!parts.length || !sales.length || iadeli.has(p.id)) continue;
    if (sales.some(s => s.shipping_cents === null || s.commission_cents === null || s.other_cents === null)) continue;
    const revenue = sales.reduce((t, s) => t + s.revenue_cents, 0);
    if (revenue <= 0) continue;
    const urunler = new Set(parts.map(c => c.product_id));
    ornekler.push({channel: p.channel, icerik: icerik(parts), tekUrun: urunler.size === 1 ? [...urunler][0] : null,
      adet: parts.reduce((t, c) => t + c.quantity_milli, 0), revenue,
      shipping: sales.reduce((t, s) => t + s.shipping_cents, 0), other: sales.reduce((t, s) => t + s.other_cents, 0),
      commission: sales.reduce((t, s) => t + s.commission_cents, 0)});
  }
  const stopajOrani = new Map();
  for (const ch of ['trendyol', 'hepsiburada']) {
    const oranlar = stopaj.filter(r => r.provider === ch && r.w < 0 && r.sale > 0).map(r => Math.round(-r.w * 1e6 / r.sale));
    stopajOrani.set(ch, oranlar.length ? ortanca(oranlar) / 1e6 : 0);
  }
  const ozet = (liste, source) => ({source, n: liste.length,
    shipping: ortanca(liste.map(x => x.shipping)), other: ortanca(liste.map(x => x.other)),
    commissionRate: ortanca(liste.map(x => Math.round(x.commission * 1e6 / x.revenue))) / 1e6});

  /**
   * parts: [{product_id, quantity_milli}] · dönüş: {shipping, other, commissionRate, withholdingRate, source, n, note} ya da null.
   */
  return function tahmin(channel, parts) {
    const kanal = ornekler.filter(x => x.channel === channel);
    if (!kanal.length) return null;
    const wr = stopajOrani.get(channel) || 0;
    const ayni = kanal.filter(x => x.icerik === icerik(parts)).slice(0, 5);
    if (ayni.length) return {...ozet(ayni, 'content'), withholdingRate: wr,
      note: 'Kesintiler aynı içerikli son ' + ayni.length + ' teslimin ortancasından.'};
    // Aynı ürünü tek başına taşıyan paketler; birden çok ürünlü pakette en büyük kargolu ürün esas alınır.
    const urunler = [...new Set(parts.map(c => c.product_id))];
    let enIyi = null;
    for (const u of urunler) {
      const adet = parts.filter(c => c.product_id === u).reduce((t, c) => t + c.quantity_milli, 0);
      const liste = kanal.filter(x => x.tekUrun === u).map((x, i) => ({x, i})).sort((a, b) => Math.abs(a.x.adet - adet) - Math.abs(b.x.adet - adet) || a.i - b.i).slice(0, 5).map(a => a.x);
      if (!liste.length) continue;
      const o = ozet(liste, 'product');
      if (!enIyi || o.shipping > enIyi.shipping) enIyi = o;
    }
    if (enIyi) return {...enIyi, withholdingRate: wr,
      note: 'Bu içerikte teslim yok; aynı ürünün adedi en yakın ' + enIyi.n + ' teslimi örnek alındı.'};
    let diger = null;
    for (const u of urunler) {
      const adet = parts.filter(c => c.product_id === u).reduce((t, c) => t + c.quantity_milli, 0);
      const liste = ornekler.filter(x => x.channel !== channel && x.tekUrun === u).map((x, i) => ({x, i})).sort((a, b) => Math.abs(a.x.adet - adet) - Math.abs(b.x.adet - adet) || a.i - b.i).slice(0, 5).map(a => a.x);
      if (!liste.length) continue;
      const o = ozet(liste, 'product_other_channel');
      if (!diger || o.shipping > diger.shipping) diger = o;
    }
    if (diger) return {...diger, commissionRate: ozet(kanal.slice(0, 30), 'channel').commissionRate, withholdingRate: wr,
      note: 'Bu ürünün bu kanalda teslimi yok; kargo ve hizmet bedeli diğer kanaldaki ' + diger.n + ' teslimden, komisyon oranı bu kanalın ortancasından.'};
    const son = kanal.slice(0, 30);
    return {...ozet(son, 'channel'), withholdingRate: wr,
      note: 'Bu ürünün bu kanalda teslimi yok; kanalın son ' + son.length + ' teslimi örnek alındı.'};
  };
}
