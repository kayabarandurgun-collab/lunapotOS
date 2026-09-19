// SATIŞ MALİYETİ: satış tarihine göre ilk giren ilk çıkar (bkz. migrations/0048_fifo_cost.sql, 0049).
//
// Hareketi değişen ürünler ec_cost_dirty'de bekler. Her ürün için bütün stok hareketleri TARİH
// sırasıyla yeniden oynatılır (aynı gün önce girişler, sonra çıkışlar; yalnız-değer düzeltmeleri
// çıkışların arasına kayıt anına göre girer). Model: her giriş bir PARTİ açar; partinin adetleri kuyrukta "parça" olarak durur,
// satışa geçince satışın "kaydı" olur. Değerler tam kuruştur; bölmede son pay kalanı alır.
//  · alış/açılış/sayım fazlası kendi değeriyle parti açar; önce stoksuz satılmış (bekleyen) adetleri karşılar;
//  · satış en eski parçadan tüketir; stok yetmiyorsa eksik kısım SONRAKİ ilk girişten karşılanır;
//  · satış iadesi önce satışın bekleyen (hiç stoktan çıkmamış) adedini iptal eder; kalanı satışın
//    tükettiği partilerin parçası olarak, satışın gerçek maliyetiyle kuyruğa döner (kümülatif kuruş);
//  · geri alınan mal teslimi (receipt-reverse) hiç olmamış sayılır: teslim de ters kaydı da oynatılmaz;
//  · geçici sayımın fatura kapanışı (provisional-close:<sayım>:<fatura>:<teslim>) sayım partisinin
//    kapanan adetlerini (önce satılmış olanlar, sonra raftakiler) faturanın GERÇEK birim maliyetine
//    çeker; faturanın aynı adetleri ikinci kez stokta durmaz;
//  · alış fiyat düzeltmesinin stok payı düzeltilen satırın partilerine, düzeltme tarihinde rafta
//    duran adetlere yazılır; raftakilerin indirimdeki payını aşan kısım o partiden satılmış adetlere
//    geçer. Ters kaydı olan düzeltme hiç oynatılmaz;
//  · sayım eksiği, tedarikçiye iade ve diğer çıkışlar KAYITLI değerleriyle bütün parçalardan orantılı
//    düşer (hangi fiziksel adedin eksildiği bilinmez; stok değeri defterle uzlaşır).
//    Tarih sırasında stok yokken yazılmışsa (geriye tarihli kayıt) sonraki girişten düşülür;
//  · kayba giden geçici sayım adedinin fatura farkı ve bakiye yetmediği için eksik yazılan kapanış
//    değeri ec_close_cost_revaluations'a yazılır (0049): sıfır adette sahipsiz değer kalmaz.
// Satışın/iadenin stoktan aldığı değer modeldekinden farklıysa fark ec_cost_revaluations'a yazılır:
// böylece stok değeri = kalan parçaların değeri. Satışın açık (tahmini) kısmına dokunulmaz; FIFO'nun
// bekleyen adedi açık maliyet kaydıyla uyuşmuyorsa (geriye tarihli kayıt) o satışa yazılmaz.

const yuvarla = x => Math.round(x);
// `toplam`ı `paylar` oranında böler; kümülatif yuvarlama, parçaların toplamı tam `toplam`.
function bol(toplam, paylar) {
  const T = paylar.reduce((a, b) => a + b, 0), out = [];
  let birikim = 0, onceki = 0;
  for (const p of paylar) { birikim += p; const simdi = T ? yuvarla(toplam * birikim / T) : 0; out.push(simdi - onceki); onceki = simdi; }
  return out;
}
const topla = (l, f) => l.reduce((a, x) => a + f(x), 0);

/** Ürünün FIFO modelini kurar; yazılacak farkları ve tanı bilgisini döner (yazmaz). */
export async function fifoHesap(db, productId) {
  const oku = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results;
  const [mv, entries, acikR, kapananR, duzR, kabulR, adjR, bakiyeR, tamamR] = await Promise.all([
    oku('SELECT rowid rid,id,kind,quantity_milli,value_cents,reference,occurred_on,created_at FROM ec_stock_movements WHERE product_id=?', productId),
    oku('SELECT rowid rid,id,kind,parent_id,quantity_milli,cost_cents,restock FROM ec_sale_entries WHERE product_id=?', productId),
    oku('SELECT sale_id,open_milli,settled_milli,cancelled_milli FROM ec_open_costs WHERE product_id=?', productId),
    oku('SELECT sale_id,SUM(value_cents) v FROM ec_cost_settlements WHERE product_id=? GROUP BY sale_id', productId),
    oku('SELECT sale_id,SUM(delta_cents) d FROM ec_cost_revaluations WHERE product_id=? GROUP BY sale_id', productId),
    oku('SELECT g.id,g.line_id,l.invoice_id,g.reference,(SELECT x.id FROM ec_receipt_reversals x WHERE x.receipt_id=g.id) ters FROM ec_goods_receipts g JOIN ec_purchase_lines l ON l.id=g.line_id WHERE l.product_id=?', productId),
    oku("SELECT a.rowid rid,a.id,a.line_id,a.net_cents,a.stock_cents,a.occurred_on,a.created_at,a.reversal_of FROM ec_purchase_adjustments a JOIN ec_purchase_lines l ON l.id=a.line_id WHERE l.product_id=? AND a.kind='price' AND a.stock_cents!=0", productId),
    oku('SELECT value_cents v FROM ec_stock_balances WHERE product_id=?', productId),
    oku('SELECT movement_id,kind,SUM(value_cents) v FROM ec_close_cost_revaluations WHERE product_id=? GROUP BY movement_id,kind', productId)
  ]);
  const tamamlanan = new Map(tamamR.map(r => [r.kind + ':' + r.movement_id, r.v]));
  const tamamla = [];          // kapanış tamamlamaları {movement_id, kind, value} (bkz. 0049)
  const sales = new Map(entries.map(s => [s.id, s]));
  const acik = new Map(acikR.map(o => [o.sale_id, o]));
  const kapanan = new Map(kapananR.map(r => [r.sale_id, r.v]));
  const duz = new Map(duzR.map(r => [r.sale_id, r.d]));
  const kabul = new Map(kabulR.map(g => [g.id, g]));
  // Geri alınan teslim ve ters kaydı: ikisi de oynatılmaz (teslim hiç olmamış).
  const dus = new Set(kabulR.filter(g => g.ters).flatMap(g => [g.id, g.ters]));
  const tersDuz = new Set(adjR.filter(a => a.reversal_of).flatMap(a => [a.id, a.reversal_of]));
  // Aynı gün: önce girişler, sonra çıkışlar; yalnız-değer düzeltmesi çıkışlar arasına kayıt anına göre girer.
  const sonRid = t => mv.reduce((r, m) => m.created_at <= t ? Math.max(r, m.rid) : r, 0);
  const olaylar = [
    ...mv.filter(m => !dus.has(m.id)).map(m => ({t: m.occurred_on, g: m.quantity_milli > 0 ? 0 : 1, r: m.rid, m})),
    ...adjR.filter(a => !tersDuz.has(a.id)).map(a => ({t: a.occurred_on, g: 1, r: sonRid(a.created_at) + 0.5, a}))
  ].sort((x, y) => x.t.localeCompare(y.t) || x.g - y.g || x.r - y.r);

  const parti = new Map();     // parti id → {line, invoice, ref, q0, v0}
  let kuyruk = [];             // raftaki parçalar {lot, q, v, kapali}
  const kayit = new Map();     // satış id → tükettiği parçalar
  const lotKayit = new Map();  // parti id → [{sale, k}] tüketim sırasıyla
  const brut = new Map();      // satış id → stoktan aldığı değer (model)
  const bekleyen = [];         // stoksuz satılmış, henüz karşılanmamış {sale, q}; sale=null: bekleyen kayıtlı çıkış {q, v}
  const iptal = new Map();     // satış id → iadeyle iptal edilen bekleyen (stoksuz) adet
  const iadeDeger = new Map(); // iade id → stoğa dönen değer (model)
  const karsilama = [];        // bekleyen adedin sonradan karşılanması (önizleme için)

  const ayir = (p, t) => { const v = t >= p.q ? p.v : yuvarla(p.v * t / p.q); p.q -= t; p.v -= v; return {lot: p.lot, q: t, v, kapali: p.kapali, hat: p.hat}; };
  const kayitEkle = (sale, k) => {
    if (!kayit.has(sale)) kayit.set(sale, []);
    kayit.get(sale).push(k);
    if (!lotKayit.has(k.lot)) lotKayit.set(k.lot, []);
    lotKayit.get(k.lot).push({sale, k});
    brut.set(sale, (brut.get(sale) || 0) + k.v);
  };
  const temizle = () => { kuyruk = kuyruk.filter(p => p.q > 0 || p.v); };
  // Değer farkını raftaki parçalardan düşer (fark < 0 ise ekler). Parça yoksa artık kalır (tanı).
  const dagit = (fark, secili = kuyruk) => {
    const l = secili.filter(p => p.q > 0).length ? secili.filter(p => p.q > 0) : kuyruk.filter(p => p.q > 0);
    if (!fark || !l.length) return;
    bol(fark, l.map(p => p.q)).forEach((d, i) => { l[i].v -= d; });
  };
  const gir = parcalar => {
    for (const p of parcalar) {
      while (p.q > 0 && bekleyen.length) {
        const b = bekleyen[0], t = Math.min(p.q, b.q);
        if (b.sale) { const k = ayir(p, t); kayitEkle(b.sale, k); karsilama.push({sale: b.sale, ...k}); }
        else { const v = t >= b.q ? b.v : yuvarla(b.v * t / b.q); p.q -= t; p.v -= v; b.v -= v; }  // bekleyen kayıtlı çıkış
        b.q -= t; if (!b.q) bekleyen.shift();
      }
      if (p.q > 0) kuyruk.push(p); else if (p.v) dagit(-p.v);  // adetsiz kalan değer diğer parçalara
    }
  };
  // Tarih sırasında stok yokken kayda geçmiş çıkış (geriye tarihli kayıt): adet ve kayıtlı değer
  // bekler, sonraki girişten düşülür (stoksuz satışın bekleyen adedi gibi).
  const bekleyenCikis = (n, v) => { if (n > 0) bekleyen.push({sale: null, q: n, v}); else dagit(v); };
  // Kayıtlı değerle çıkış: önce `oncelik` partilerinin parçaları, sonra en eskiden; fark kalanlara.
  const cikis = (n, deger, oncelik) => {
    const sira = [...kuyruk.filter(p => oncelik.includes(p.lot)), ...kuyruk.filter(p => !oncelik.includes(p.lot))];
    let dogal = 0;
    for (const p of sira) { if (n <= 0) break; const t = Math.min(n, p.q); dogal += ayir(p, t).v; n -= t; }
    temizle();
    if (n > 0) return bekleyenCikis(n, deger - dogal);
    dagit(deger - dogal, kuyruk.filter(p => oncelik.includes(p.lot)));
  };
  // Kayıtlı değerle orantılı çıkış (sayım eksiği, tedarikçiye iade, diğer).
  const orantili = (n, deger) => {
    const l = kuyruk.filter(p => p.q > 0), Q = topla(l, p => p.q);
    let dogal = 0;
    bol(Math.min(n, Q), l.map(p => p.q)).forEach((t, i) => { if (!t) return; const k = ayir(l[i], t); dogal += k.v; if (!lotKayit.has(k.lot)) lotKayit.set(k.lot, []); lotKayit.get(k.lot).push({sale: null, k}); });
    temizle();
    if (n > Q) return bekleyenCikis(n - Math.max(0, Q), deger - dogal);
    dagit(deger - dogal);
  };
  const satisIsle = m => {
    const id = m.reference; if (!brut.has(id)) brut.set(id, 0);
    let n = -m.quantity_milli;
    while (n > 0 && kuyruk.length) {
      const p = kuyruk[0], t = Math.min(n, p.q);
      if (t > 0) kayitEkle(id, ayir(p, t));
      n -= t; if (p.q <= 0) { kuyruk.shift(); if (p.v) dagit(-p.v); }
    }
    if (n > 0) bekleyen.push({sale: id, q: n});
  };
  const iadeIsle = (m, r) => {
    let n = m.quantity_milli;
    for (const b of bekleyen) if (b.sale === r.parent_id && n > 0) { const t = Math.min(n, b.q); b.q -= t; n -= t; iptal.set(b.sale, (iptal.get(b.sale) || 0) + t); }
    for (let i = bekleyen.length - 1; i >= 0; i--) if (!bekleyen[i].q) bekleyen.splice(i, 1);
    const liste = (kayit.get(r.parent_id) || []).filter(k => k.q > 0), Q = topla(liste, k => k.q), V = topla(liste, k => k.v);
    n = Math.min(n, Q);
    if (n <= 0) { iadeDeger.set(r.id, 0); return; }
    const hedef = n >= Q ? V : yuvarla(V * n / Q), parcalar = [];
    bol(n, liste.map(k => k.q)).forEach((t, i) => { if (t) parcalar.push(ayir(liste[i], t)); });
    const fark = hedef - topla(parcalar, p => p.v);
    if (fark) { parcalar[parcalar.length - 1].v += fark; const kalan = liste.filter(k => k.q > 0); if (kalan.length) bol(fark, kalan.map(k => k.q)).forEach((d, i) => { kalan[i].v -= d; }); }
    iadeDeger.set(r.id, hedef);
    gir(parcalar);
  };
  const kapanisSira = new Map(); // fatura:teslim → bu teslime yazılmış kapanış adedi (kümülatif fiyat)
  const kapanisIsle = (m, sayim, fatura, ref) => {
    const rq = -m.quantity_milli, sm = mv.find(x => x.id === sayim);
    // Kapanışın olması gereken değeri sayımın kendi birim değeridir; kayıttaki değer o anki bakiye
    // yetmediyse eksik yazılmıştır. Eksik kısım (daha önce tamamlanmamışsa) tamamlama kaydıyla düşülür.
    const ideal = sm ? yuvarla(sm.value_cents * rq / sm.quantity_milli) : -m.value_cents;
    const eksik = ideal + m.value_cents - (tamamlanan.get('tamamla:' + m.id) || 0);
    if (eksik > 0) tamamla.push({movement_id: m.id, kind: 'tamamla', value: eksik});
    const kayitli = Math.max(-m.value_cents, ideal);
    const fp = [...parti.entries()].filter(([, l]) => l.invoice === fatura && l.ref === ref).map(([id]) => id);
    const RQ = topla(fp, id => parti.get(id).q0), RV = topla(fp, id => parti.get(id).v0);
    if (!RQ) return cikis(rq, kayitli, [sayim]);
    const anahtar = fatura + ':' + ref, baz = kapanisSira.get(anahtar) || 0;
    kapanisSira.set(anahtar, baz + rq);
    const hedef = x => yuvarla(RV * Math.min(RQ, baz + x) / RQ), hat = parti.get(fp[0]).line;
    let k = 0, fark = 0, kayipFark = 0, son = null;
    // Önce bu sayımdan çıkmış adetler (tüketim sırasıyla: satış ya da kayıp), sonra raftakiler faturanın
    // fiyatına çekilir. Satışın farkı satışa; kayıp adedin farkı kayıp giderine (kayip tamamlaması).
    for (const {sale, k: rec} of lotKayit.get(sayim) || []) {
      if (k >= rq) break; if (rec.kapali || rec.q <= 0) continue;
      const n = Math.min(rq - k, rec.q), h = hedef(k + n) - hedef(k), hp = n < rec.q ? ayir(rec, n) : rec;
      if (hp !== rec) { if (sale) kayit.get(sale).push(hp); lotKayit.get(sayim).push({sale, k: hp}); }
      fark += h - hp.v; if (sale) brut.set(sale, brut.get(sale) + h - hp.v); else kayipFark += h - hp.v;
      hp.v = h; hp.kapali = true; hp.hat = hat; k += n; son = {sale, k: hp, kayip: !sale};
    }
    for (let i = 0; i < kuyruk.length && k < rq; i++) {
      const p = kuyruk[i]; if (p.lot !== sayim || p.kapali || p.q <= 0) continue;
      const n = Math.min(rq - k, p.q), h = hedef(k + n) - hedef(k);
      let hp = p;
      if (n < p.q) { hp = ayir(p, n); kuyruk.splice(i, 0, hp); i++; }
      fark += h - hp.v; hp.v = h; hp.kapali = true; hp.hat = hat; k += n; son = {k: hp};
    }
    // Faturanın sayımla aynı adetleri düşülür: önce kapanışı bekleyen teslim parçaları, yetmezse kuyruk.
    const cift = ciftler.get(anahtar) || [];
    let n = rq, dogal = 0;
    for (const p of cift) { if (n <= 0) break; const t = Math.min(n, p.q); dogal += ayir(p, t).v; n -= t; }
    const kalan = cift.filter(p => p.q > 0);
    ciftler.set(anahtar, kalan);
    const fazla = kayitli + fark - dogal;  // model bu kadar daha düşmeli (eksi: fazla düştü)
    if (n > 0) cikis(n, fazla, fp);
    // Kuruş artığı: kapanışı bekleyen teslim parçasına, yoksa bu kapanışın fiyatladığı son adede.
    else if (fazla && kalan.length) bol(fazla, kalan.map(p => p.q)).forEach((d, i) => { kalan[i].v -= d; });
    else if (fazla && son) { son.k.v -= fazla; if (son.sale) brut.set(son.sale, brut.get(son.sale) - fazla); else if (son.kayip) kayipFark -= fazla; }
    else dagit(fazla, kuyruk.filter(p => fp.includes(p.lot)));
    const kf = kayipFark - (tamamlanan.get('kayip:' + m.id) || 0);
    if (kf) tamamla.push({movement_id: m.id, kind: 'kayip', value: kf});
  };
  const duzeltmeIsle = a => {
    // Satırın partileri + bu satırın teslimiyle kapanıp fatura fiyatına çekilmiş geçici sayım adetleri
    // (faturanın malı onlardır; teslimin aynı adetleri kapanışta düşülmüştü).
    const lotlar = [...parti.entries()].filter(([, l]) => l.line === a.line_id).map(([id]) => id);
    const bagli = p => lotlar.includes(p.lot) || p.hat === a.line_id;
    const N = topla(lotlar, id => parti.get(id).q0);
    const raf = kuyruk.filter(p => bagli(p) && p.q > 0);
    const satilan = [...lotKayit.values()].flat().filter(x => x.sale && x.k.q > 0 && bagli(x.k));
    const nRaf = topla(raf, p => p.q), nSat = topla(satilan, x => x.k.q), S = a.stock_cents;
    // Satırın adetleri rafta da satışta da değilse (kayıp/tedarikçiye iade; kayıtlı değerleri düzeltmeyi
    // içerip içermediği kayıt sırasından bilinemez) değer ürünün raftaki parçalarına yazılır.
    let sRaf = S, sSat = 0;
    if (nSat && !nRaf) { sRaf = 0; sSat = S; }
    else if (nSat && nRaf) { sRaf = Math.sign(S) * Math.min(Math.abs(S), yuvarla(Math.abs(a.net_cents) * nRaf / (N || nRaf + nSat))); sSat = S - sRaf; }
    if (nRaf) bol(-sRaf, raf.map(p => p.q)).forEach((d, i) => { raf[i].v += d; });
    else dagit(sRaf);
    if (nSat) bol(-sSat, satilan.map(x => x.k.q)).forEach((d, i) => { satilan[i].k.v += d; brut.set(satilan[i].sale, brut.get(satilan[i].sale) + d); });
  };

  const KAPANIS = /^provisional-close:([^:]+):([^:]+):([\s\S]*)$/;
  const kapanisAdet = new Map(); // fatura:teslim referansı → geçici sayımla kapanan adet
  const ciftler = new Map();     // fatura:teslim referansı → kapanışı bekleyen (sayımla aynı) teslim parçaları
  for (const m of mv) { const k = m.kind === 'purchase' && m.quantity_milli < 0 && KAPANIS.exec(m.reference || ''); if (k) kapanisAdet.set(k[2] + ':' + k[3], (kapanisAdet.get(k[2] + ':' + k[3]) || 0) - m.quantity_milli); }
  const ertelenen = new Map(), kapanisBekler = new Map();
  const bekle = (map, key, e) => { if (!map.has(key)) map.set(key, []); map.get(key).push(e); };
  const isle = e => {
    if (e.a) return duzeltmeIsle(e.a);
    const m = e.m;
    if (m.quantity_milli > 0) {
      const r = m.kind === 'return' ? sales.get(m.reference) : null;
      if (r?.kind === 'return' && sales.get(r.parent_id)?.kind === 'sale') {
        // İade, iade ettiği satıştan ÖNCE işlenemez (aynı gün girişler önce sıralanır).
        if (!brut.has(r.parent_id)) return bekle(ertelenen, r.parent_id, e);
        return iadeIsle(m, r);
      }
      const g = kabul.get(m.id), parca = {lot: m.id, q: m.quantity_milli, v: m.value_cents, kapali: false};
      parti.set(m.id, {line: g?.line_id, invoice: g?.invoice_id, ref: g?.reference, q0: m.quantity_milli, v0: m.value_cents});
      // Teslimin geçici sayımla kapanacak adedi aynı maldır (sayılan mal zaten rafta/satılmış): ne
      // bekleyen satışı karşılar ne satılabilir; kuyruk dışında bekler, kapanış onu düşer.
      const anahtar = g && g.invoice_id + ':' + g.reference, cift = anahtar ? Math.min(parca.q, kapanisAdet.get(anahtar) || 0) : 0;
      if (cift) { kapanisAdet.set(anahtar, kapanisAdet.get(anahtar) - cift); if (!ciftler.has(anahtar)) ciftler.set(anahtar, []); ciftler.get(anahtar).push(ayir(parca, cift)); }
      gir([parca]);
      const l = kapanisBekler.get(m.id); if (l) { kapanisBekler.delete(m.id); l.forEach(isle); }
      return;
    }
    if (m.kind === 'sale' && sales.get(m.reference)?.kind === 'sale') {
      satisIsle(m);
      const l = ertelenen.get(m.reference); if (l) { ertelenen.delete(m.reference); l.forEach(isle); }
      return;
    }
    const k = m.kind === 'purchase' && KAPANIS.exec(m.reference || '');
    if (k) {
      // Sayımdan önce tarihli kapanış (fatura tarihi sayımdan eski): sayım partisi açılınca işlenir.
      if (!parti.has(k[1]) && mv.some(x => x.id === k[1] && !dus.has(x.id))) return bekle(kapanisBekler, k[1], e);
      return kapanisIsle(m, k[1], k[2], k[3]);
    }
    orantili(-m.quantity_milli, -m.value_cents);
  };
  for (const e of olaylar) isle(e);
  // Satışı hiç görülmeyen iade (veri hatası) kendi değeriyle parti açar.
  for (const l of ertelenen.values()) for (const e of l) gir([{lot: e.m.id, q: e.m.quantity_milli, v: e.m.value_cents, kapali: false}]);
  for (const l of kapanisBekler.values()) for (const e of l) orantili(-e.m.quantity_milli, -e.m.value_cents);
  for (const l of ciftler.values()) gir(l.filter(p => p.q > 0 || p.v));

  const mvDeger = new Map(mv.map(m => [m.id, m.value_cents]));
  const bekleyenAdet = new Map();
  for (const b of bekleyen) bekleyenAdet.set(b.sale, (bekleyenAdet.get(b.sale) || 0) + b.q);
  // FIFO (tarih sırası) satışın aynı adetlerini maliyetli saymış mı, açık maliyet kaydı (tetik, kayıt
  // sırası) gibi? Bekleyen (açık) adet ve iadeyle iptal edilen açık adet aynı olmalı. Geriye tarihli
  // kayıt ya da hareket geçmişi olmayan bakiye yüzünden ayrışan satışa ve iadelerine yazılmaz.
  const tutarli = id => {
    const o = acik.get(id);
    return (bekleyenAdet.get(id) || 0) === (o ? o.open_milli - o.settled_milli : 0) && (iptal.get(id) || 0) === (o?.cancelled_milli || 0);
  };
  const writes = [], atlanan = [];
  for (const [id, hedef] of brut) {
    if (sales.get(id)?.kind !== 'sale') continue;
    // Stok tarafı: satış hareketinin düştüğü değer + kapanışlar + önceki farklar (tahmin hariç).
    const stok = -(mvDeger.get(id) || 0) + (kapanan.get(id) || 0) + (duz.get(id) || 0);
    if (!tutarli(id)) { if (hedef !== stok) atlanan.push(id); continue; }
    if (hedef !== stok) writes.push({sale_id: id, delta: hedef - stok});
  }
  for (const [id, hedef] of iadeDeger) {
    const stok = (mvDeger.get(id) || 0) - (duz.get(id) || 0);
    if (!tutarli(sales.get(id).parent_id)) { if (stok !== hedef) atlanan.push(id); continue; }
    if (stok !== hedef) writes.push({sale_id: id, delta: stok - hedef});
  }
  // Önce stoğa değer döndüren farklar: bakiye batch içinde hiçbir an eksiye inmez.
  writes.sort((a, b) => a.delta - b.delta);
  const kalanDeger = topla(kuyruk, p => p.v);
  const sonraki = (bakiyeR[0]?.v || 0) - topla(writes, w => w.delta) - topla(tamamla, t => t.value);
  // Ayrışmış geçmişte (atlanan satışlar) farklar bakiyeyi eksiye itebilir: o zaman hiçbiri yazılmaz.
  return {writes, tamamla, atlanan, karsilama, kalan_deger: kalanDeger, artik: sonraki - kalanDeger, guvenli: sonraki >= 0,
    bekleyen: [...bekleyenAdet].filter(([sale_id]) => sale_id).map(([sale_id, q]) => ({sale_id, quantity_milli: q}))};
}

export async function fifoProduct(db, productId) { return (await fifoHesap(db, productId)).writes; }

/** Kirli ürünlerin maliyetini yeniden hesaplar. En çok `limit` ürün; kalan sayısını döner.
 *  Yazım, okunan kuyruk nesli (seq) hâlâ duruyorsa yapılır: paralel ikinci yürütücü ya da hesap
 *  sırasında gelen yeni hareket varsa hiçbir şey yazılmaz, ürün kuyrukta kalır (R02). */
export async function fifoRevalue(db, limit = 8) {
  const dirty = (await db.prepare('SELECT seq,product_id FROM ec_cost_dirty ORDER BY seq LIMIT ?').bind(limit).all()).results;
  let changed = 0, failed = 0;
  for (const {seq, product_id} of dirty) {
    try {
      const h = await fifoHesap(db, product_id), {writes, tamamla} = h.guvenli ? h : {writes: [], tamamla: []};
      // Yazılamayan (bakiyeyi eksiye iterdi) ürün kuyruktan çıkar; önizlemede artık değeriyle görünür.
      if (!h.guvenli) { failed++; console.error('fifo', product_id, 'ayrışmış geçmiş: düzeltme yazılmadı, artık', h.artik); }
      const kosul = 'EXISTS(SELECT 1 FROM ec_cost_dirty WHERE product_id=? AND seq=?)';
      // Önce stoğa değer döndürenler (etki < 0): bakiye batch içinde hiçbir an eksiye inmez.
      const stmts = [...writes.map(w => ({etki: w.delta, st: db.prepare(`INSERT INTO ec_cost_revaluations(id,sale_id,product_id,delta_cents) SELECT ?,?,?,? WHERE ${kosul} RETURNING id`)
        .bind('fifo:' + seq + ':' + w.sale_id, w.sale_id, product_id, w.delta, product_id, seq)})),
      ...tamamla.map(t => ({etki: t.value, st: db.prepare(`INSERT INTO ec_close_cost_revaluations(id,movement_id,product_id,kind,value_cents) SELECT ?,?,?,?,? WHERE ${kosul} RETURNING id`)
        .bind('fifo:' + seq + ':' + t.kind + ':' + t.movement_id, t.movement_id, product_id, t.kind, t.value, product_id, seq)}))]
        .sort((a, b) => a.etki - b.etki).map(x => x.st);
      stmts.push(db.prepare('DELETE FROM ec_cost_dirty WHERE product_id=? AND seq=?').bind(product_id, seq));
      const r = await db.batch(stmts);
      changed += topla(r.slice(0, -1), x => x?.results?.length || 0);
    } catch (e) {
      // Hatalı ürün kuyruğun sonuna geçer: diğer ürünler beklemez; veri değişince yeniden denenir.
      failed++; console.error('fifo', product_id, e.message);
      try { await db.batch([db.prepare('DELETE FROM ec_cost_dirty WHERE product_id=? AND seq=?').bind(product_id, seq), db.prepare('INSERT OR IGNORE INTO ec_cost_dirty(product_id) VALUES(?)').bind(product_id)]); } catch {}
    }
  }
  const left = (await db.prepare('SELECT COUNT(*) n FROM ec_cost_dirty').first()).n;
  return {products: dirty.length, changed, failed, remaining: left};
}

/** Yazmadan önizleme: bir sonraki FIFO turunun yazacağı farklar (canlı veri onarımı öncesi). */
export async function fifoOnizleme(db, {product = '', limit = 50} = {}) {
  const ids = product ? [product] : (await db.prepare('SELECT DISTINCT product_id FROM ec_stock_movements ORDER BY product_id LIMIT ?').bind(limit).all()).results.map(r => r.product_id);
  const urunler = [];
  for (const id of ids) {
    const h = await fifoHesap(db, id);
    if (h.writes.length || h.tamamla.length || h.atlanan.length || h.artik) urunler.push({product_id: id, writes: h.writes, tamamla: h.tamamla, atlanan: h.atlanan, artik_cents: h.artik, kalan_deger_cents: h.kalan_deger});
  }
  return {urunler};
}

/** R15 — 0047'nin tarihsel doldurması (gecmis:) her açık satışı kapasiteye bakmadan satıştan
 *  sonraki İLK girişle kapattı. Önizleme: kapanışları giriş adedini aşan kaynaklar ve tarih
 *  sırası + kalan kapasiteyle doğru tahsis (FIFO modelinin karşılaması). Yazmaz; ikinci çağrı aynı sonucu verir. */
export async function gecmisKapasiteOnizleme(db) {
  const sources = (await db.prepare(`SELECT c.source_id,c.product_id,m.quantity_milli capacity_milli,SUM(c.quantity_milli) settled_milli,SUM(c.value_cents) settled_cents
    FROM ec_cost_settlements c JOIN ec_stock_movements m ON m.id=c.source_id GROUP BY c.source_id,c.product_id,m.quantity_milli
    HAVING SUM(c.quantity_milli)>m.quantity_milli ORDER BY c.product_id,c.source_id`).all()).results;
  const gecmis = (await db.prepare("SELECT sale_id,product_id,quantity_milli,value_cents,source_id FROM ec_cost_settlements WHERE id LIKE 'gecmis:%' ORDER BY product_id,occurred_on,sale_id").all()).results;
  const urunler = [...new Set([...sources.map(s => s.product_id), ...gecmis.map(g => g.product_id)])].sort();
  const proposal = [];
  for (const p of urunler) {
    const h = await fifoHesap(db, p), satislar = new Set(gecmis.filter(g => g.product_id === p).map(g => g.sale_id));
    const top = new Map();
    for (const k of h.karsilama) if (satislar.has(k.sale)) {
      const key = k.sale + '|' + k.lot, x = top.get(key) || {product_id: p, sale_id: k.sale, source_id: k.lot, quantity_milli: 0, value_cents: 0};
      x.quantity_milli += k.q; x.value_cents += k.v; top.set(key, x);
    }
    for (const b of h.bekleyen) if (satislar.has(b.sale_id)) top.set(b.sale_id + '|', {product_id: p, sale_id: b.sale_id, source_id: null, quantity_milli: b.quantity_milli, value_cents: null});
    proposal.push(...top.values());
  }
  return {sources, proposal, current: gecmis};
}

// POST /api/ec/cost-fifo — bekleyen ürünleri hemen işler (toplu yeniden hesap; kalan 0 olana dek çağrılır).
// GET  /api/ec/cost-fifo/preview[?product_id=] — yazmadan önizleme; GET /api/ec/cost-fifo/history-capacity — R15.
export async function fifoApi(request, env, path, readBody) {
  if (path === '/api/cost-fifo/preview' && request.method === 'GET') {
    if (env.WORKSPACE !== 'ec') return {urunler: []};
    const u = new URL(request.url), product = u.searchParams.get('product_id') || '';
    return fifoOnizleme(env.DB, {product: /^[\w-]{1,80}$/.test(product) ? product : '', limit: Math.min(500, Math.max(1, Number(u.searchParams.get('limit')) || 50))});
  }
  if (path === '/api/cost-fifo/history-capacity' && request.method === 'GET') return env.WORKSPACE === 'ec' ? gecmisKapasiteOnizleme(env.DB) : {sources: [], proposal: [], current: []};
  if (path !== '/api/cost-fifo' || request.method !== 'POST') return null;
  if (env.WORKSPACE !== 'ec') return {products: 0, changed: 0, remaining: 0};
  // {all:true}: bütün ürünler yeniden hesaplanmak üzere işaretlenir (kural değişikliğinden sonra).
  if ((await readBody(request))?.all === true)
    await env.DB.prepare('INSERT OR IGNORE INTO ec_cost_dirty(product_id) SELECT DISTINCT product_id FROM ec_stock_movements').run();
  return fifoRevalue(env.DB, 15);
}
