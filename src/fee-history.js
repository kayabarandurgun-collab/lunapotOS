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
//
// ADET UYUMU (her dönüşte): uyum 'ayni' (örnekler istenen adette), 'aralik' (istenen adet örneklerin
// en az/en çok adedi arasında), 'uzak' (örneklerin hepsi daha az ya da hepsi daha çok adetli), 'yok'
// (ürüne ait örnek yok, kanal ortancası); ornekAdet {en_az, en_cok} milli adet. Uyum 'uzak'/'yok' ise
// ayrıca uyari: kısa Türkçe not (kâr yolu bunu satıra taşır; TUTARI DEĞİŞTİRMEZ, belirsizliği söyler).
// {adetSiniri: true} (fiyat önerisi): uzak adetler ortancaya karışmaz. Aynı adet varsa onlar; yoksa
// istenen adedin iki yanındaki en yakın gözlenmiş adetlerden kargo ve hizmet adede göre orantılanır;
// yalnız bir yanda örnek varsa o adetteki örnekler 'uzak' döner. Tek paket kargosu adetle ÇARPILMAZ.
// Varsayılan seçim (kargodaki paket, kâr raporu, ürün kârlılığı) değişmedi; yalnız uyum bilgisi eklendi.

const ortanca = v => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const icerik = parts => JSON.stringify(Object.entries(parts.reduce((m, c) => (m[c.product_id] = (m[c.product_id] || 0) + c.quantity_milli, m), {})).sort());
const adetYaz = m => (m / 1000).toLocaleString('tr-TR');
const uyumOf = (liste, adet) => { const a = liste.map(x => x.adet), en_az = Math.min(...a), en_cok = Math.max(...a);
  return {uyum: en_az === adet && en_cok === adet ? 'ayni' : en_az <= adet && adet <= en_cok ? 'aralik' : 'uzak', ornekAdet: {en_az, en_cok}}; };
const kaynakNotu = o => o.uyum === 'aralik' ? adetYaz(o.ornekAdet.en_az) + ' ve ' + adetYaz(o.ornekAdet.en_cok) + ' adetlik ' + o.n + ' teslimden adede göre orantılandı'
  : adetYaz(o.ornekAdet.en_az) + ' adetlik ' + o.n + ' teslimden alındı';
// KABA TAHMİN NOTU: örneklerin adedi istenene uymuyorsa ('uzak') ya da ürüne ait örnek hiç yoksa ('yok')
// kısa uyarı; uyumluysa null. Tahmin yine verilir, yalnız ne kadar dayanaksız olduğu söylenir.
const ornekAdetYaz = o => o.ornekAdet.en_az === o.ornekAdet.en_cok ? adetYaz(o.ornekAdet.en_az) : adetYaz(o.ornekAdet.en_az) + '–' + adetYaz(o.ornekAdet.en_cok);
const kabaNot = (o, adet) => o.uyum === 'yok' ? 'Tahmin kaba: bu ürünün bu kanalda teslimi yok, kanalın ortancası kullanıldı.'
  : o.uyum === 'uzak' ? 'Tahmin kaba: ' + adetYaz(adet) + ' adetlik pakete karşılık geçmişte yalnız ' + ornekAdetYaz(o) + ' adetlik teslim var.' : null;

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

  // Sıkı seçim (fiyat önerisi): liste en yeni teslim önde; her adet düzeyinden en yeni 5 örnek.
  const sikiSecim = (liste, adet, source) => {
    const duzey = a => liste.filter(x => x.adet === a).slice(0, 5), adetler = liste.map(x => x.adet);
    const ayni = duzey(adet);
    if (ayni.length) return {...ozet(ayni, source), uyum: 'ayni', ornekAdet: {en_az: adet, en_cok: adet}};
    const alt = Math.max(...adetler.filter(a => a < adet)), ust = Math.min(...adetler.filter(a => a > adet));
    if (Number.isFinite(alt) && Number.isFinite(ust)) {
      const a = duzey(alt), u = duzey(ust), oa = ozet(a, source), ou = ozet(u, source), t = (adet - alt) / (ust - alt), ara = (x, y) => Math.round(x + (y - x) * t);
      return {source, n: a.length + u.length, shipping: ara(oa.shipping, ou.shipping), other: ara(oa.other, ou.other),
        commissionRate: ozet([...a, ...u], source).commissionRate, uyum: 'aralik', ornekAdet: {en_az: alt, en_cok: ust}};
    }
    const yakin = Number.isFinite(alt) ? alt : ust;
    return {...ozet(duzey(yakin), source), uyum: 'uzak', ornekAdet: {en_az: yakin, en_cok: yakin}};
  };
  const enYakin5 = (liste, adet) => liste.map((x, i) => ({x, i})).sort((a, b) => Math.abs(a.x.adet - adet) - Math.abs(b.x.adet - adet) || a.i - b.i).slice(0, 5).map(a => a.x);
  const urunOrnegi = (tum, adet, source, siki) => { if (!tum.length) return null; if (siki) return sikiSecim(tum, adet, source);
    const liste = enYakin5(tum, adet); return {...ozet(liste, source), ...uyumOf(liste, adet)}; };

  /**
   * parts: [{product_id, quantity_milli}] · secenek: {adetSiniri} ·
   * dönüş: {shipping, other, commissionRate, withholdingRate, source, n, note, uyum, ornekAdet, uyari} ya da null.
   */
  return function tahmin(channel, parts, {adetSiniri = false} = {}) {
    const kanal = ornekler.filter(x => x.channel === channel);
    if (!kanal.length) return null;
    const wr = stopajOrani.get(channel) || 0;
    const ayni = kanal.filter(x => x.icerik === icerik(parts)).slice(0, 5);
    const toplam = parts.reduce((t, c) => t + c.quantity_milli, 0);
    if (ayni.length) return {...ozet(ayni, 'content'), withholdingRate: wr, uyum: 'ayni', ornekAdet: {en_az: toplam, en_cok: toplam}, uyari: null,
      note: 'Kesintiler aynı içerikli son ' + ayni.length + ' teslimin ortancasından.'};
    // Aynı ürünü tek başına taşıyan paketler; birden çok ürünlü pakette en büyük kargolu ürün esas alınır.
    const urunler = [...new Set(parts.map(c => c.product_id))];
    const adetOf = u => parts.filter(c => c.product_id === u).reduce((t, c) => t + c.quantity_milli, 0);
    let enIyi = null, enIyiAdet = toplam;
    for (const u of urunler) {
      const o = urunOrnegi(kanal.filter(x => x.tekUrun === u), adetOf(u), 'product', adetSiniri);
      if (o && (!enIyi || o.shipping > enIyi.shipping)) { enIyi = o; enIyiAdet = adetOf(u); }
    }
    if (enIyi) return {...enIyi, withholdingRate: wr, uyari: kabaNot(enIyi, enIyiAdet),
      note: adetSiniri ? 'Bu içerikte teslim yok; kargo ve hizmet bedeli aynı ürünün ' + kaynakNotu(enIyi) + '.'
        : 'Bu içerikte teslim yok; aynı ürünün adedi en yakın ' + enIyi.n + ' teslimi örnek alındı.'};
    let diger = null, digerAdet = toplam;
    for (const u of urunler) {
      const o = urunOrnegi(ornekler.filter(x => x.channel !== channel && x.tekUrun === u), adetOf(u), 'product_other_channel', adetSiniri);
      if (o && (!diger || o.shipping > diger.shipping)) { diger = o; digerAdet = adetOf(u); }
    }
    if (diger) return {...diger, commissionRate: ozet(kanal.slice(0, 30), 'channel').commissionRate, withholdingRate: wr, uyari: kabaNot(diger, digerAdet),
      note: adetSiniri ? 'Bu ürünün bu kanalda teslimi yok; kargo ve hizmet bedeli diğer kanaldaki ' + kaynakNotu(diger) + ', komisyon oranı bu kanalın ortancasından.'
        : 'Bu ürünün bu kanalda teslimi yok; kargo ve hizmet bedeli diğer kanaldaki ' + diger.n + ' teslimden, komisyon oranı bu kanalın ortancasından.'};
    const son = kanal.slice(0, 30);
    return {...ozet(son, 'channel'), withholdingRate: wr, uyum: 'yok', ornekAdet: null, uyari: kabaNot({uyum: 'yok'}, toplam),
      note: 'Bu ürünün bu kanalda teslimi yok; kanalın son ' + son.length + ' teslimi örnek alındı.'};
  };
}
