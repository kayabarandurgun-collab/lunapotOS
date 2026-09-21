// İLAN BAŞLIĞI → STOK KARTI. Pazaryeri sipariş raporunda ilanın tek okunur kimliği pazarlama
// başlığıdır: barkod ve satıcı stok kodu çoğu satırda boş gelir, "sku" yalnız pazaryerinin kendi
// ilan kodudur (HBCV…) ve hiçbir stok kartıyla ortak değildir. Eski kural (ilan adı ile kart adı
// BİREBİR aynı olacak) pazarlama başlığını hiç tutmuyordu; her yeni ilan elle eşleştirme istiyordu.
//
// Buradaki kural: kart adının BÜTÜN ayırt edici sözcükleri başlıkta geçiyorsa kart adaydır.
// Marka isteğe bağlıdır (ilan markasız yazılmış olabilir), ölçü kart adında varsa ZORUNLUDUR.
// Otomatik bağlantı yalnız aday TEK ise kurulur. Sıfır ya da birden çok adayda hiçbir şey
// yazılmaz; sebebi ve aday adları söylenir. Benzerlik puanı, kısaltma, tahmin YOKTUR.
//
// Bu modül veritabanına dokunmaz: girdi ilan başlığı + kart listesi, çıktı bileşen listesi ya da
// Türkçe sebep. Yazma kararını çağıran taraf verir.

// Ölçü tek biçime iner: 2,5 Lt = 2.5 l = 2500 ml; 1 lt = 1000 ml; 500 Ml = 500 ml; 1 kg = 1000 g.
const CARPAN = {mililitre: ['ml', 1], ml: ['ml', 1], cc: ['ml', 1], cl: ['ml', 10], santilitre: ['ml', 10],
  litre: ['ml', 1000], lt: ['ml', 1000], l: ['ml', 1000],
  gram: ['g', 1], gr: ['g', 1], g: ['g', 1], kilogram: ['g', 1000], kg: ['g', 1000]};
const OLCU = /(\d+(?:\.\d+)?)\s*(mililitre|santilitre|kilogram|litre|gram|ml|cl|lt|kg|gr|cc|l|g)(?:lik|luk|lük)?(?![a-zçğöşü0-9])/g;
// Yalnız gerçek bağlaç/ayraç dolgudur. "adet", "paket" gibi sözcükler ürün adının parçası olabilir.
const DOLGU = new Set(['ve', 'ile', 'veya', 'ya', 'icin', 'and', 'with']);
const AYIRAC = /\s+ve\s+|\s+ile\s+|\s+arti\s+|\s*\+\s*|\s*,\s*/;
const BOSLUK = /[^a-z0-9çğöşü]+/;
// Başlıkta geçen çokluk: "4 adet", "2 paket", "2'li", "3'lü", "x2", "2x". Ondalık virgül ve ölçü
// birimleri ÖNCE sadeleştiği için ("2,5 Lt" → "2500ml") sayılar birbirine karışmaz.
const COKLUK = [
  /(\d{1,2})\s*(?:adet|paket|kutu|şişe|parça|takım)(?![a-zçğöşü0-9])/g,
  /(\d{1,2})\s*['’´`]?\s*l[iuü](?![a-zçğöşü0-9])/g,
  /(?:^|[^a-z0-9çğöşü])x\s*(\d{1,2})(?![a-zçğöşü0-9])/g,
  /(?:^|[^a-z0-9çğöşü])(\d{1,2})\s*x(?![a-zçğöşü0-9])/g,
];

/** Küçük harf (tr-TR), ı=i, ondalık virgül nokta olur: virgül artık yalnız ayraçtır. */
const kucuk = s => String(s || '').toLocaleLowerCase('tr-TR').replace(/ı/g, 'i').replace(/(\d),(\d)/g, '$1.$2');
/** Karşılaştırmaya hazır metin: harf/ölçü biçimi tek, noktalama olduğu gibi (ayraç için gerekli). */
export const duzles = s => kucuk(s).replace(OLCU, (_, sayi, birim) => {
  const [ad, kat] = CARPAN[birim];
  return Math.round(Number(sayi) * kat) + ad;
});
export const sozcukler = s => duzles(s).split(BOSLUK).filter(Boolean);
const olcuMu = t => /^\d+(?:ml|g)$/.test(t);
const kume = s => new Set(s.split(BOSLUK).filter(Boolean));

/** Kartın aranacak sözcükleri: markası ve bağlaçları düşer, ölçüsü kalır. */
export function kartAnahtari(kart) {
  const marka = new Set(sozcukler(kart.brand || ''));
  const gerek = [...new Set(sozcukler(kart.name).filter(t => !DOLGU.has(t) && !marka.has(t)))];
  return {id: kart.id, name: kart.name, gerek, olcu: gerek.filter(olcuMu)};
}

/**
 * Aday kartlar: bütün ayırt edici sözcükleri başlıkta geçenler. Yalnız ölçüden ibaret kalan kart
 * ("Tropikal 500 ml") hiç aday olmaz: her 500 ml başlığına yapışırdı.
 */
export function adaylar(baslik, kartlar) {
  const sozler = new Set(sozcukler(baslik));
  return kartlar.map(kartAnahtari).filter(k => k.gerek.some(t => !olcuMu(t)) && k.gerek.every(t => sozler.has(t)));
}

/** Parçadaki çokluk. İki farklı sayı görünüyorsa belirsizdir: 1 kabul edilir, uydurulmaz. */
export function coklukBul(parca) {
  const bulunan = new Set();
  for (const desen of COKLUK) for (const m of String(parca).matchAll(desen)) {
    const n = Number(m[1]);
    if (n >= 2 && n <= 24) bulunan.add(n);
  }
  return bulunan.size === 1 ? [...bulunan][0] : 1;
}

/** Kart hangi parçayı anlatıyor: en çok sözcüğünü barındıran TEK parça, ölçüsü de oradaysa. */
function tutunanParca(kart, parcaSozleri) {
  const puan = parcaSozleri.map(s => kart.gerek.filter(t => s.has(t)).length);
  const en = Math.max(...puan, 0);
  if (!en || puan.filter(p => p === en).length !== 1) return -1;
  const i = puan.indexOf(en);
  return kart.olcu.every(t => parcaSozleri[i].has(t)) ? i : -1;
}

/**
 * Başlığı çözer. Dönen: {parts:[{kart,adet}]} ya da {reason:'…'}.
 * Tek aday → tek bileşen. Birden çok aday ancak SET ise kabul edilir: başlık " ve ", " ile ",
 * "+" ya da "," ile bölündüğünde her aday AYRI bir parçaya tutunmalıdır. Aynı parçaya iki aday
 * düşüyorsa hangisinin satıldığı belirsizdir; hiçbir şey kurulmaz.
 */
export function ilanCozumle(baslik, kartlar) {
  const aday = adaylar(baslik, kartlar);
  const adlar = () => aday.map(k => k.name).join(', ');
  if (!aday.length) return {reason: 'İlan başlığı hiçbir stok kartıyla eşleşmedi; elle eşleştirin.'};
  const duz = duzles(baslik);
  if (aday.length === 1) return {parts: [{kart: aday[0], adet: coklukBul(duz)}]};
  const parca = duz.split(AYIRAC).map(p => p.trim()).filter(Boolean);
  const belirsiz = {reason: 'Birden çok stok kartı bu başlığa uyuyor (' + adlar() + '); hangisi olduğu belli değil, eşleşmedi.'};
  if (aday.length > 5 || parca.length < 2) return belirsiz;
  const sozler = parca.map(kume), yer = aday.map(k => tutunanParca(k, sozler));
  if (yer.some(i => i < 0) || new Set(yer).size !== yer.length) return belirsiz;
  return {parts: aday.map((k, i) => ({kart: k, adet: coklukBul(parca[yer[i]])}))};
}

/**
 * Gelir payları (bps). Bütün bileşenlerin güncel satış fiyatı biliniyorsa fiyata orantılı,
 * biri bile bilinmiyorsa eşit bölünür; artık EN BÜYÜK paya eklenir, toplam tam 10000 olur.
 * Pay o ürünün tek başına kârı DEĞİLDİR: yalnız satış tutarını muhasebe bileşenlerine dağıtır.
 */
export function paylar(agirliklar) {
  const gecerli = agirliklar.length > 0 && agirliklar.every(a => Number.isFinite(a) && a > 0);
  const w = gecerli ? agirliklar : agirliklar.map(() => 1);
  const toplam = w.reduce((s, a) => s + a, 0);
  const bps = w.map(a => Math.floor(a * 10000 / toplam));
  let en = 0;
  for (let i = 1; i < w.length; i++) if (w[i] > w[en]) en = i;
  bps[en] += 10000 - bps.reduce((s, b) => s + b, 0);
  return bps;
}
