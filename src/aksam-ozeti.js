// AKŞAM ÖZETİ. Günde bir kez, Türkiye saatiyle akşam, "bugün neye bakman gerekiyor" mesajı.
//
// LİSTE YENİDEN HESAPLANMAZ. Panelin İş listesi (attention-api.js) ne sayıyorsa o okunur. İkinci
// bir hesap yazılsaydı ekranla mesaj sessizce ayrışırdı: aynı soruya iki farklı cevap veren bir
// panele güvenilmez. Sayaçların kuralları (teslim edilmemiş pakete kesinti yazılmaz, ikame ters
// kaydı iade sayılmaz, devam eden yükleme yarım sayılmaz …) orada ölçülerek oturtuldu.
//
// TUTAR YAZILMAZ, YALNIZ SAYI. Telegram kanalını gören herkes mesajı okur; panelde bu liste
// yalnız yöneticiye açıktır. Kural yapısal olarak da güvenlidir: attention-api.js hiçbir *_cents
// alanı döndürmez, yani sızdırılacak tutar mesaja hiç ulaşmaz. Buna ek olarak sayılar BİNLİK
// AYRAÇSIZ yazılır — "1.250" para gibi okunur ve kuralı belirsizleştirir.
//
// SIFIR OLAN SATIR HİÇ YAZILMAZ: okunmayan uzun mesaj, gönderilmemiş mesajla aynı şeydir.
//
// HİÇ İŞ YOKKEN DE KISA BİR MESAJ GİDER. Hiç göndermemek daha sessiz olurdu ama o zaman "bugün
// yapacak iş yok" ile "bot kapandı / token döndü / cron çalışmıyor" ayırt edilemezdi — bu iş tam
// o sessizliği kapatmak için yapıldı. Günde bir satır, aynı zamanda zamanlamanın çalıştığının
// kanıtıdır ve gürültü sayılmaz.
import {attentionApi} from './attention-api.js';
import {scopedDB} from './scoped-db.js';
import {telegramAcik, telegramBildir} from './telegram.js';
import {arizaBildir, damga, gunTR} from './otomatik-bakim.js';

// ZAMANLAMA İKİ YERDE YAZILI: wrangler.jsonc Cloudflare'ı tetikler, buradaki sabitler worker'ın
// hangi olayın geldiğini ayırt etmesini sağlar. İkisi ayrışırsa akşam özeti ya hiç gitmez ya 15
// dakikada bir gider; bu yüzden eşitlikleri testle bağlandı (tests/aksam-ozeti.test.js).
// CRON UTC KOŞAR. Türkiye kalıcı olarak UTC+03 (yaz saati yok), yani TR 20:00 = UTC 17:00.
export const BAKIM_CRON = '*/15 * * * *';
export const AKSAM_CRON = '0 17 * * *';
// Susturma kaydındaki (migrations/0071) sabit anahtar: akşam özeti Türkiye günü başına bir kez.
export const AKSAM_ANAHTARI = 'aksam-ozeti';
const IZ_SAKLAMA_GUN = 30;
const ESKI_RAPOR_GUN = 3;        // pazaryeri raporu bu kadar gündür işlenmediyse söylenir
const SISTEM = {owner: true, id: 'aksam-ozeti', username: 'otomatik', name: 'Akşam özeti'};

// İŞ SATIRLARI: [sayacı oku, sayıyı cümleye çevir]. Sıra ÖNEM sırasıdır — mesajın başında
// panelin kendi işleyişiyle ilgili olanlar (yarım dosya, hata veren tur) durur, çünkü onlar
// bozulduğunda aşağıdaki bütün sayılar yanlış olur.
const SATIRLAR = [
  [l => l.reports?.yarim, n => n + ' rapor dosyası yarım kaldı'],
  [l => l.reports?.bakim_sorunu, n => n + ' otomatik bakım turu hata verdi (son 24 saat)'],
  [l => l.orders?.unmapped, n => n + ' sipariş taslağında ilan eşleşmesi eksik'],
  [l => l.orders?.missing_amounts, n => n + ' sipariş taslağında fiyat bilgisi eksik'],
  [l => l.orders?.changed, n => n + ' siparişin pazaryeri kaydı değişti'],
  [l => l.orders?.long_shipping, n => n + ' paket bir haftadan uzun süredir yolda'],
  [l => l.orders?.undelivered, n => n + ' paket pazaryerinde teslim edilemedi görünüyor'],
  // İş listesinin ölçtüğü ayrım korunur: teslim EDİLMİŞ olana kesinti yazılabilir, ötekiler
  // sırasını bekliyor. Bekleyeni de sayarsak liste şişer ve gerçekten bakılacak olan gizlenir.
  [l => l.sales?.delivered_unconfirmed, n => n + ' teslim edilmiş satışta kesinti doğrulanmadı'],
  [l => l.sales?.losses, n => n + ' satış zararla kapanmış görünüyor'],
  [l => l.stock?.low, n => n + ' ürün kritik stok seviyesinde'],
  [l => l.invoices?.drafts, n => n + ' alış faturası taslak hâlinde'],
  [l => l.invoices?.awaiting_receipt, n => n + ' alış faturasının malı eksik']
];

// TARİFELER AYRI ELE ALINIR, çünkü SIFIR DA İŞTİR. "Yürürlükteki tarife sayısı" bir iş sayacı
// değildir: sıfır olması işin bittiği değil, kesinti ve kâr hesabının dayanaksız kaldığı anlamına
// gelir. Bu yüzden sıfır-gizleme kuralı burada TERS çalışır.
// İki satır AYNI mesajda bulunamaz: "tarife tanımlı değil" ile "tarife bitiyor" birbirini
// yalanlar. Yürürlükte hiç tarife yoksa söylenecek tek şey odur.
const TARIFELER = [
  ['kargo', l => l.tariffs?.shipping_active, l => l.tariffs?.shipping_expiring],
  ['komisyon', l => l.tariffs?.commission_active, l => l.tariffs?.commission_expiring]
];

/** Takvim günü farkı: "kaç gündür" sorusu saat farkıyla değil gün dönümüyle ölçülür. */
const gunFarki = (a, b) => Math.floor((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);

/** Pazaryeri verisi akıyor mu? Rapor elle yüklendiği için akmaması sessiz bir arızadır. */
function raporSatiri(liste, bugun) {
  const son = liste.reports?.last_applied;
  if (!son) return liste.reports?.total ? null : 'henüz hiç pazaryeri raporu işlenmemiş';
  const gun = gunFarki(bugun, gunTR(damga(son)));
  return gun >= ESKI_RAPOR_GUN ? gun + ' gündür pazaryeri raporu işlenmedi' : null;
}

/**
 * Özet metni. SAFTIR: veritabanına ya da ağa dokunmaz, bu yüzden tutar sızmadığı ve sıfır
 * satırların yazılmadığı doğrudan sınanabilir.
 */
export function aksamOzetiMetni(liste, {simdi = Date.now()} = {}) {
  const bugun = gunTR(simdi);
  const satirlar = [];
  for (const [oku, cumle] of SATIRLAR) { const n = Number(oku(liste) || 0); if (n > 0) satirlar.push(cumle(n)); }
  for (const [ad, aktif, biten] of TARIFELER) {
    if (Number(aktif(liste) || 0) === 0) satirlar.push(ad + ' tarifesi tanımlı değil');
    else if (Number(biten(liste) || 0) > 0) satirlar.push(biten(liste) + ' ' + ad + ' tarifesi bir hafta içinde bitiyor');
  }
  const rapor = raporSatiri(liste, bugun);
  if (rapor) satirlar.push(rapor);

  const baslik = '🌙 Akşam özeti · ' + bugun;
  if (!satirlar.length) return baslik + '\nBekleyen iş yok. Panel ve otomatik bakım çalışıyor.';
  return baslik + '\nBugün bakman gerekenler:\n' + satirlar.map(s => '• ' + s).join('\n');
}

/** Panelin İş listesini kendi uç noktasından okur: ekranla mesaj aynı hesaptan beslenir. */
export async function isListesi(env) {
  const ec = {...env, DB: scopedDB(env.DB, 'ec'), ROOT_DB: env.DB, WORKSPACE: 'ec', USER: SISTEM};
  return attentionApi(new Request('https://internal.invalid/api/ec/attention'), ec, '/api/attention');
}

/**
 * Akşam özetini gönderir. Günde EN FAZLA BİR mesaj: Cloudflare aynı cron'u yineleyebilir ve
 * yinelenen olay sahibin telefonunda ikinci bir mesaj olarak görünürdü. Kural arıza bildirimiyle
 * AYNI kaydı kullanır (migrations/0071): gün yalnız gönderim BAŞARILI olduğunda işaretlenir, yani
 * ulaşmayan bir mesaj akşamı tüketmez ve sıradaki tetikleme yeniden dener.
 */
export async function aksamOzeti(env, secenekler = {}) {
  try { return await ozetiGonder(env, secenekler); }
  catch (e) {
    // AKŞAM ÖZETİ YENİ BİR SESSİZ ARIZA OLMAZ. İş listesi sorgusu ya da iz yazımı düşerse worker
    // bunu yalnız console'a yazardı — yani kimse görmezdi, tam da kapatmaya çalıştığımız delik.
    // Arıza kanalına düşer ve aynı susturma kuralına girer (günde bir). Hata AYNEN fırlatılır.
    await arizaBildir(env, ['akşam özeti çöktü: ' + (e?.message || e)],
      {simdi: secenekler.simdi, gonder: secenekler.arizaGonder}).catch(() => {});
    throw e;
  }
}

async function ozetiGonder(env, {simdi = Date.now(), gonder = telegramBildir, db = env?.DB} = {}) {
  // Kurulmamış bildirim bir sorun değildir: yerel geliştirmede ve testte secret yoktur.
  if (!telegramAcik(env)) return {sonuc: 'kapali'};
  const gun = gunTR(simdi), damgasi = new Date(simdi).toISOString().slice(0, 19).replace('T', ' ');
  if (await db.prepare('SELECT 1 x FROM ec_bildirim_izi WHERE anahtar=? AND gun=?').bind(AKSAM_ANAHTARI, gun).first())
    return {sonuc: 'susturuldu', gun};

  const liste = await isListesi(env);
  const metin = aksamOzetiMetni(liste, {simdi});
  let ok = false, hata = '';
  try { ok = Boolean(await gonder(env, metin)); } catch (e) { hata = e?.message || String(e); }

  await db.prepare(`INSERT INTO ec_bildirim_izi(anahtar,ozet,gun,gorulme,gonderim,son_gorulme_at,son_gonderim_at,son_sonuc) VALUES(?,?,?,1,?,?,?,?)
    ON CONFLICT(anahtar) DO UPDATE SET ozet=excluded.ozet,gun=iif(excluded.son_sonuc='ok',excluded.gun,ec_bildirim_izi.gun),
      gorulme=ec_bildirim_izi.gorulme+1,gonderim=ec_bildirim_izi.gonderim+excluded.gonderim,
      son_gorulme_at=excluded.son_gorulme_at,son_gonderim_at=excluded.son_gonderim_at,son_sonuc=excluded.son_sonuc`)
    .bind(AKSAM_ANAHTARI, metin.slice(0, 300), ok ? gun : '', ok ? 1 : 0, damgasi, damgasi, ok ? 'ok' : 'basarisiz').run();

  // İZ KAYDI: gönderim sonucu panelden de görülsün, bot kapanırsa kimse fark etmiyordu.
  const satir = metin.split('\n').filter(s => s.startsWith('•')).length;
  await db.prepare('INSERT INTO ec_activity(id,description) VALUES(?,?)').bind(crypto.randomUUID(),
    (ok ? 'Akşam özeti gönderildi: ' + (satir || 'bekleyen iş yok') + (satir ? ' bakılacak iş.' : '.')
      : 'Akşam özeti gönderilemedi' + (hata ? ' (' + hata.slice(0, 160) + ')' : '') + '.')).run();

  // SUSTURMA KAYDI BÜYÜMESİN. Günde bir kez temizlenir; her bakım turunda silmek 96 boş D1
  // yazması olurdu. Çözülmüş eski arızaların izi 30 gün sonra işe yaramaz.
  await db.prepare("DELETE FROM ec_bildirim_izi WHERE son_gorulme_at<datetime('now',?)").bind('-' + IZ_SAKLAMA_GUN + ' days').run();
  return {sonuc: ok ? 'ok' : 'basarisiz', gun, satir, metin, liste};
}
