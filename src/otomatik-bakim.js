// OTOMATİK BAKIM (zamanlanmış, wrangler "triggers.crons"). Rapor yüklendikten sonraki işler normalde
// Rapor Kutusu ekranında hemen yapılır; ama o iş kullanıcının AÇIK SAYFASINDA yürür. Sayfa kapanırsa
// iş yarım kalır; bir kural sonradan iyileşirse (yeni iade/eşleme kuralı) eski veriye kimse
// uygulamaz. Kullanıcı "ne sana ne bana ihtiyaç duysun" dedi: sunucu aynı adımları kendisi tekrarlar.
//
//   1. yarım kalan rapor dosyalarını bitirir (kaldığı partiden)
//   2. her mağaza için: yeni siparişleri aktarır (stok ayırır / gönderir / teslim eder)
//   3. rapora göre teslimleri günceller, iadeleri kaydeder, kesintileri yazar
//   4. pazaryeri bağlantılarından yeni kaynakları çeker (yalnız aralığı dolmuşsa)
//   5. hareketi değişen ürünlerin satış maliyetini (FIFO) günceller
//
// Adımların hepsi tekrar çalıştırılabilir: yapılmış işi ikinci kez yazmaz. Kullanıcı o sırada dosya
// yüklüyorsa (son 10 dakikada rapor hareketi) aynı işi ekranla yarışarak yapmamak için tur atlanır.
import {scopedDB} from './scoped-db.js';
import {reportInboxApi} from './report-inbox-api.js';
import {reportStockLinkApi} from './report-stock-link-api.js';
import {syncProvider} from './connections-api.js';
import {telegramBildir} from './telegram.js';
import {fifoRevalue} from './fifo-cost.js';

const SISTEM = {owner: true, id: 'otomatik-bakim', username: 'otomatik', name: 'Otomatik bakım'};
// D1 damgaları 'YYYY-MM-DD HH:MM:SS' ve UTC'dir; ISO'ya çevrilmeden Date.parse yerel saat sanıyor.
const damga = t => Date.parse(String(t).replace(' ', 'T') + 'Z');
// Defterdeki gün TÜRKİYE günüdür. Türkiye kalıcı olarak UTC+03, yaz saati yok: sabit kaydırma yeter.
const gunTR = ms => new Date(ms + 3 * 3600000).toISOString().slice(0, 10);

// PAZARYERİ SENKRONU. Cron 15 DAKİKADA BİR tetikleniyor ama her turda pazaryerine gitmek YANLIŞ
// olur: sağlayıcının istek sınırı boşuna yenir ve ücretsiz D1 yazma bütçesi (günde 100.000 satır)
// değişmemiş kayıtların upsert'iyle tükenir — aynı sayfayı günde 96 kez çekmek aynı satırları 96 kez
// yazar. ARALIK KAYNAK TÜRÜNE GÖRE seçildi:
//   · siparişler 4 SAAT: paketin kargo/teslim durumu gün içinde değişiyor ve kâr yalnız TESLİM
//     edilen pakette doğuyor; 4 saatlik gecikme kâr raporunu bozmaz, günde 6 tur eder.
//   · hakediş/iade finansı 12 SAAT, kesinti ve hakediş emri 24 SAAT: bu kayıtlar günlük kesiliyor,
//     daha sık çekmek aynı satırları tekrar yazmaktan başka işe yaramaz.
// PENCERE son başarılı senkrondan bugüne kurulur (+1 gün emniyet payı, en az 2 gün: pazaryeri geç
// güncellenen paketi geriye dönük değiştirebiliyor). Sürekli 14 günlük pencere çekmek boşuna yazma
// üretirdi. Uç sınırı aşılamaz: sipariş ucu en fazla 14, Trendyol finans uçları 15 gün (gün sayısı
// 'enGeri' başlangıç ile bitiş arası fark olduğu için 13/14'tür).
// Hepsiburada 'commissions' türü buraya girmez: o uç SKU listesi ister, kullanıcı seçimi olmadan
// hangi ürünlerin sorulacağı uydurulamaz.
export const SENKRON_KAYNAKLARI = {
  trendyol: [{kind: 'orders', saat: 4, enGeri: 13}, {kind: 'sale', saat: 12, enGeri: 14}, {kind: 'return', saat: 12, enGeri: 14},
    {kind: 'deductions', saat: 24, enGeri: 14}, {kind: 'payments', saat: 24, enGeri: 14}],
  // HEPSİBURADA 24 SAATTEN UZUN ARALIK KABUL ETMİYOR: enGeri 0, yani pencere tek gündür.
  // HB teslim kaydı siparişle AYNI sıklıkta çekilir: kâr yalnız teslim edilen pakette doğuyor ve
  // HB'nin sipariş ucu yalnız paketlenmeyi bekleyenleri verdiği için teslim bilgisi ancak buradan
  // geliyor. 'undelivered' kâr için ters yönde aynı derecede önemli: pazaryeri teslim edemediğini
  // söylüyorsa bizde teslim duran paketin kârı yanlış sayılmış olabilir, iş listesinde uyarıya
  // dönüşüyor. 'shipped' paketin yolda olduğunu doğruluyor, günde iki kez yeter.
  hepsiburada: [{kind: 'orders', saat: 4, enGeri: 0}, {kind: 'delivered', saat: 4, enGeri: 0},
    {kind: 'undelivered', saat: 4, enGeri: 0}, {kind: 'shipped', saat: 12, enGeri: 0}, {kind: 'finance', saat: 12, enGeri: 0}]
};
// Tur başına sağlayıcı isteği sınırı: 50 sipariş/sayfa ile 8 sayfa iki günlük hacmi rahat alır.
// Sınır hem sağlayıcı nezaketi hem de tek turda yazılacak satır sayısı için üst kapaktır.
export const SENKRON_ISTEK = 8;
const SENKRON_PAY = 10000;   // sağlayıcı isteği için bütçeden ayrılan pay (istek zaman aşımı 20 sn)
// Senkronun kullanabileceği EN BÜYÜK bütçe oranı; kalanı rapor işlerinindir.
export const SENKRON_PAYI = 0.5;
/** Aşama süreleri, iz kaydının sonuna eklenen kısa özet: [dosya 0.2sn, senkron 3.1sn, rapor 59.6sn]. */
const sureOzeti = ozet => {
  const parcalar = Object.entries(ozet.sure).map(([ad, ms]) => ad + ' ' + Math.round(ms / 100) / 10 + 'sn');
  return parcalar.length ? ' [' + parcalar.join(', ') + ']' : '';
};
const SENKRON_ILK_GUN = 3;   // hiç senkron yapılmamış bağlantıda ilk pencere (ilk tam alım elle yapılır)
const coz = v => { try { return JSON.parse(v); } catch { return null; } };

/**
 * Tur bütçesinin kapıları. Tek yerde durur ki ölçülebilsin ve sınanabilsin.
 * SENKRON RAPOR İŞLERİNDEN ÖNCE ÇALIŞIR VE KENDİ PAYINI AŞMAZ. Canlıda ölçüldü (2026-09-25):
 * rapor turu 59,6 saniye sürüyor, 50 saniyelik bütçe orada bitiyordu ve pazaryeri senkronuna HİÇ
 * sıra gelmiyordu — Trendyol 22,5 saat çekilmedi, iz kaydı ise "yapılacak iş yoktu" diyordu.
 * Sırayı değiştirmek tek başına yetmez, senkron da sınırsız kalamaz: iki taraf da payıyla çalışır.
 * Yarıda kalan iş kaybolmaz, sıradaki tur kaldığı yerden sürer (hepsi imleçli/atlamalı döngüler).
 * Senkron SAĞLAYICIYA ÇIKAR: tek istek zaman aşımına kadar 20 saniye sürebilir, o yüzden ayrıca
 * SENKRON_PAY ayrılır ve payın içine girilmişken yeni sayfa istenmez.
 */
export function butceler(sureMs, saat = Date.now) {
  const bas = saat(), gecen = () => saat() - bas, vakitVar = () => gecen() < sureMs;
  return {gecen, vakitVar, raporVakti: vakitVar,
    senkronVakti: () => gecen() < sureMs * SENKRON_PAYI && gecen() + SENKRON_PAY < sureMs};
}

/**
 * Yapılandırılmış pazaryeri bağlantılarından kaynak sayfalarını çeker. Hiçbir hata yukarı kaçmaz:
 * bir sağlayıcı düşerse bakımın geri kalanı (iade, kesinti, maliyet, iz kaydı) aynen sürer.
 */
async function pazaryeriSenkronu(ec, db, {simdi, vakitVar, getir, ozet}) {
  const baglantilar = (await db.prepare('SELECT provider,last_success_at,last_error FROM ec_provider_connections ORDER BY provider').all()).results;
  for (const b of baglantilar) {
    const kaynaklar = SENKRON_KAYNAKLARI[b.provider];
    if (!kaynaklar) continue;
    // SÜRE BİTTİYSE SESSİZ KALINMAZ. Rapor işleri bütçeyi yiyip senkronu aç bıraktığında dışarıdan
    // "yapılacak iş yoktu" görünüyordu: sağlayıcıya hiç gidilmediği hâlde hata da kayıt da yok.
    if (!vakitVar()) { ozet.senkronSebep.push(b.provider + ': süre bütçesi bitti'); continue; }
    // ÇÖZÜLMEMİŞ HATASI OLAN BAĞLANTI OTOMATİK DENENMEZ: kimlik bilgisi bozulmuş ya da mağaza
    // erişimi kapanmışsa her 4 saatte bir aynı hatayı üretmek sağlayıcıya da bize de yük olur.
    // Sessiz kalmıyoruz: hata metni Bağlantılar ekranında kırmızı satır olarak zaten duruyor ve
    // kullanıcı "Verileri al" ile bir kez başarılı çektiğinde last_error silinir, otomatik senkron
    // kendiliğinden geri gelir.
    if (b.last_error) { ozet.senkronAtlandi.push(b.provider); continue; }
    if (b.last_success_at && simdi - damga(b.last_success_at) < Math.min(...kaynaklar.map(k => k.saat)) * 3600000) { ozet.senkronSebep.push(b.provider + ': aralık dolmadı'); continue; }
    // Tür başına son başarı zamanı: imleç satırı yalnız YAZILAN sayfada tazelenir, yani bu damga
    // "bu türü en son ne zaman gerçekten çektik" sorusunun cevabıdır.
    const turlar = (await db.prepare('SELECT kind,MAX(last_success_at) son FROM ec_provider_cursors WHERE provider=? GROUP BY kind').bind(b.provider).all()).results;
    let istek = SENKRON_ISTEK;
    try {
      for (const k of kaynaklar) {
        if (istek <= 0 || !vakitVar()) { ozet.senkronSebep.push(b.provider + '/' + k.kind + (istek <= 0 ? ': istek payı bitti' : ': süre bütçesi bitti')); break; }
        const son = turlar.find(t => t.kind === k.kind)?.son, gecen = son ? simdi - damga(son) : null;
        if (gecen !== null && gecen < k.saat * 3600000) continue;
        // İmleç sorgu anahtarı sunucuda hash'lendiği için burada pencere (from/to) ile eşleştirilir.
        const imlecler = (await db.prepare('SELECT query_json,next_page,has_more,last_success_at FROM ec_provider_cursors WHERE provider=? AND kind=? ORDER BY last_success_at DESC')
          .bind(b.provider, k.kind).all()).results.map(c => ({...c, q: coz(c.query_json)})).filter(c => c.q?.from && c.q?.to);
        // YARIM KALAN PENCERE ÖNCE BİTİRİLİR. Süre/istek bütçesi dolduğunda aynı pencere ve kalınan
        // sayfadan sürülür; yoksa her tur daha dar bir pencere kurulur ve önceki pencerenin
        // çekilmemiş son sayfalarına bir daha hiç sıra gelmezdi. Yalnız TAZE (son iki gün içinde
        // ilerlemiş) pencere sürdürülür: panelden haftalar önce yarım bırakılmış geniş bir aralık
        // otomatik bakımı sonsuza kadar geçmişte tutmasın, o iş ekrandan elle sürdürülür.
        const yarim = imlecler.find(c => c.has_more && simdi - damga(c.last_success_at) < 2 * 86400000);
        // UÇ SINIRI HER DURUMDA ÜST KAPAKTIR: ilk senkronun geniş penceresi de, en az iki günlük
        // taban da bu sınırı aşamaz. Hepsiburada aralığı en fazla 24 saat kabul ettiği için
        // (enGeri:0) aşan her pencere uçtan geri dönerdi; sınır dışarı alınmazsa ilk tur 3 gün,
        // sonraki turlar 2 gün isteyip hiç veri çekemezdi.
        const geri = Math.min(gecen === null ? SENKRON_ILK_GUN : Math.max(Math.ceil(gecen / 86400000) + 1, 2), k.enGeri);
        const to = yarim ? yarim.q.to : gunTR(simdi), from = yarim ? yarim.q.from : gunTR(simdi - geri * 86400000);
        const imlec = yarim ?? imlecler.find(c => c.q.from === from && c.q.to === to);
        let sayfa = imlec?.has_more ? imlec.next_page : 0;
        while (istek > 0 && vakitVar()) {
          istek--;
          const r = await syncProvider(ec, b.provider, {kind: k.kind, from, to, page: sayfa, preview: false}, getir);
          ozet.senkronKayit += r.records.length;
          ozet.senkronTeslim += r.deliveredMarked || 0;
          ozet.senkronTaslak += r.orders?.created || 0;
          // Ücretsiz işlem sınırı yüzünden ertelenen taslaklar AYNI sayfada kalır: ilerleme varsa
          // sayfa tekrar çekilir, hiç ilerleme yoksa sıradaki tura bırakılır (panelin kuralıyla aynı).
          if (r.deferredOrders > 0) { if (r.orders?.created > 0) continue; break; }
          if (!r.hasMore) break;
          sayfa = r.next_page;
        }
      }
    } catch (e) {
      // Sağlayıcı hatası bakımı ÇÖKERTMEZ. Bu sağlayıcının sıradaki türleri de zorlanmaz: 429/401
      // gibi hatalar bağlantının tamamını ilgilendirir, arka arkaya denemek sınırı daha da yer.
      // Hata metni zaten syncProvider tarafından provider_connections.last_error'a yazıldı.
      ozet.hatalar.push('senkron ' + b.provider + ': ' + e.message);
    }
  }
}

/** Telegram özeti: yalnız EKRAN KAPALIYKEN olan kayda değer iş bildirilir. */
export const senkronBildirimi = ozet => '🔄 Otomatik senkron — pazaryerinden yeni bilgi geldi\n' +
  [ozet.senkronTaslak && ozet.senkronTaslak + ' yeni sipariş taslağı', ozet.senkronTeslim && ozet.senkronTeslim + ' paket teslim edildi işaretlendi',
    ozet.senkronKayit && ozet.senkronKayit + ' kaynak kaydı tarandı'].filter(Boolean).join(' · ');

export async function otomatikBakim(env, {sureMs = 50000, simdi = Date.now(), sakinDakika = 10, senkronGetir = fetch, saat = Date.now} = {}) {
  const {gecen, vakitVar, raporVakti, senkronVakti} = butceler(sureMs, saat);
  const ec = {...env, DB: scopedDB(env.DB, 'ec'), ROOT_DB: env.DB, WORKSPACE: 'ec', USER: SISTEM};
  const db = env.DB;
  const son = await db.prepare('SELECT MAX(created_at) t FROM ec_report_files').first();
  if (son?.t && simdi - damga(son.t) < sakinDakika * 60000)
    return {atlandi: 'Son ' + sakinDakika + ' dakikada rapor yüklendi; ekran işliyor olabilir.'};

  const cagir = (handler, yol, govde) => handler(new Request('https://internal.invalid/api/ec' + yol.replace(/^\/api/, ''), {method: govde === undefined ? 'GET' : 'POST'}),
    ec, yol, async () => govde);
  const ozet = {dosya: 0, siparis: 0, teslim: 0, iade: 0, kesinti: 0, maliyet: 0, senkronKayit: 0, senkronTeslim: 0, senkronTaslak: 0, senkronAtlandi: [], senkronSebep: [], sure: {}, hatalar: []};
  // Aşama damgaları: hangi işin bütçeyi yediği ancak ölçülerek görülür. İz kaydına da yazılır.
  const asama = ad => { ozet.sure[ad] = gecen(); };
  const dene = async (ad, fn) => { try { await fn(); } catch (e) { ozet.hatalar.push(ad + ': ' + e.message); } };

  // 1. Yarım kalan dosyalar. Hata veren dosya silinmez ve "işlendi" sayılmaz: deneme sayısı, son hata
  // ve bir sonraki deneme zamanı ec_report_file_attempts'e yazılır (ekranda görünür). Her tur önce hiç
  // hata vermemiş dosyaları alır; hatalı olan bekleme süresi dolunca (15 dk, 30 dk, 1 sa … en çok 1 gün)
  // yeniden denenir. Böylece sürekli hata veren ilk 10 dosya sağlıklı 11. dosyayı engellemez.
  const zaman = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const yarim = (await db.prepare(`SELECT f.id,COALESCE(a.attempts,0) attempts,a.last_error FROM ec_report_files f LEFT JOIN ec_report_file_attempts a ON a.file_id=f.id
    WHERE f.status NOT IN ('applied','receiving','rejected','cancelled') AND (a.next_attempt_at IS NULL OR a.next_attempt_at<=?)
    ORDER BY COALESCE(a.attempts,0),f.created_at,f.id LIMIT 10`).bind(zaman(simdi)).all()).results;
  for (const f of yarim) {
    try {
      for (let i = 0; i < 200 && raporVakti(); i++) { const r = await cagir(reportInboxApi, '/api/reports/files/' + f.id + '/apply', {}); if (r.done) { ozet.dosya++; break; } }
      if (f.last_error) await db.prepare('UPDATE ec_report_file_attempts SET last_error=NULL,next_attempt_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE file_id=?').bind(f.id).run();
    } catch (e) {
      ozet.hatalar.push('dosya: ' + e.message);
      const bekle = Math.min(24 * 60, 15 * 2 ** Math.min(f.attempts, 10)) * 60000;
      await dene('dosya kaydı', () => db.prepare(`INSERT INTO ec_report_file_attempts(file_id,attempts,last_error,last_attempt_at,next_attempt_at) VALUES(?,1,?,?,?)
        ON CONFLICT(file_id) DO UPDATE SET attempts=attempts+1,last_error=excluded.last_error,last_attempt_at=excluded.last_attempt_at,next_attempt_at=excluded.next_attempt_at,updated_at=CURRENT_TIMESTAMP`)
        .bind(f.id, String(e.message || 'Bilinmeyen hata').slice(0, 500), zaman(simdi), zaman(simdi + bekle)).run());
    }
  }

  asama('dosya');

  // 2. PAZARYERİ SENKRONU RAPOR İŞLERİNDEN ÖNCE. Eskiden en sonda duruyordu ve rapor işleri bütçeyi
  // bitirdiği için sağlayıcıya HİÇ çıkılamıyordu (ölçüm: rapor 59,6sn / bütçe 50sn). Senkron YENİ
  // veri getirir; rapor işleri zaten sistemdeki veriyi tamamlar ve imleçli oldukları için sıradaki
  // tura kalmaları zararsızdır. Senkron kendi payını aşamaz, yani ters yönde açlık da doğmaz.
  // Yeni taslakların maliyeti aynı turda değerlenmeye devam eder: FIFO adımı hâlâ en sonda.
  await pazaryeriSenkronu(ec, db, {simdi, vakitVar: senkronVakti, getir: senkronGetir, ozet});
  asama('senkron');

  // 3–4. Mağaza başına aktarım, iade, kesinti; teslim güncellemesi mağazadan bağımsız.
  const magazalar = (await db.prepare("SELECT id FROM ec_report_stores WHERE provider IN ('trendyol','hepsiburada')").all()).results;
  for (const m of magazalar) {
    await dene('aktarım', async () => {
      const skip = [];
      for (let i = 0; i < 40 && raporVakti(); i++) {
        const r = await cagir(reportStockLinkApi, '/api/reports/stock-link/auto', {store_id: m.id, skip});
        for (const x of r.results) { if (x.done) ozet.siparis++; else skip.push(x.package_id); }
        if (!r.results.length || (!r.remaining && r.results.length < 5)) break;
      }
    });
  }
  await dene('teslim', async () => { ozet.teslim += (await cagir(reportInboxApi, '/api/reports/sync-deliveries', {confirm: true})).count || 0; });
  for (const m of magazalar) {
    await dene('iade', async () => {
      for (let i = 0; i < 10 && raporVakti(); i++) { const r = await cagir(reportStockLinkApi, '/api/reports/stock-link/returns-apply', {store_id: m.id, confirm: true}); ozet.iade += r.done.length; if (!r.remaining || !r.done.length) break; }
    });
    await dene('kesinti', async () => {
      let cursor = 0;
      for (let i = 0; i < 40 && raporVakti(); i++) {
        const f = await cagir(reportInboxApi, '/api/reports/apply-fees', {store_id: m.id, confirm: true, cursor});
        ozet.kesinti += f.sale_entries_changed || 0;
        if (!f.next_cursor || f.next_cursor <= cursor) break;
        cursor = f.next_cursor;
      }
    });
  }

  // 4. Pazaryeri senkronu. Rapor işleri ÖNCE bitirilir (onlar zaten sistemdeki veriyi tamamlıyor),
  // senkron ise YENİ veri getirir ve gerekirse bir sonraki tura kalabilir. FIFO'dan önce durur:
  // senkronun açtığı taslakların maliyeti aynı turda değerlensin ve maliyet kuyruğu bütün bütçeyi
  // yiyip senkronu aç bırakmasın.
  asama('rapor');

  // 5. Maliyet (FIFO) kuyruğu.
  await dene('maliyet', async () => {
    for (let i = 0; i < 30 && vakitVar(); i++) { const r = await fifoRevalue(ec.DB, 8); ozet.maliyet += r.changed; if (!r.remaining) break; }
  });

  // BİLDİRİM yalnız EKRAN KAPALIYKEN olan kayda değer iş için: yeni sipariş taslağı ya da teslim
  // işaretlemesi. Yalnız "kayıt tarandı" ise kanal SUSAR — 4 saatte bir "bir şey değişmedi" mesajı
  // bildirimleri okunmaz hâle getirirdi. Hatalar da kanala düşmez: Bağlantılar ekranında kırmızı
  // satır olarak duruyor ve aynı hata her turda tekrar ederdi. Bildirim hiçbir işi durdurmaz.
  if (ozet.senkronTaslak || ozet.senkronTeslim) await dene('bildirim', () => telegramBildir(env, senkronBildirimi(ozet)));

  const is = ozet.dosya + ozet.siparis + ozet.teslim + ozet.iade + ozet.kesinti + ozet.maliyet + ozet.senkronKayit + ozet.senkronTeslim + ozet.senkronTaslak;
  if (is || ozet.hatalar.length)
    await db.prepare('INSERT INTO ec_activity(id,description) VALUES(?,?)').bind(crypto.randomUUID(),
      'Otomatik bakım: ' + [ozet.dosya && ozet.dosya + ' rapor dosyası bitirildi', ozet.siparis && ozet.siparis + ' sipariş aktarıldı', ozet.teslim && ozet.teslim + ' teslim',
        ozet.iade && ozet.iade + ' iade', ozet.kesinti && ozet.kesinti + ' satışa kesinti yazıldı', ozet.maliyet && ozet.maliyet + ' maliyet düzeltmesi',
        ozet.senkronKayit && ozet.senkronKayit + ' pazaryeri kaydı tarandı', ozet.senkronTaslak && ozet.senkronTaslak + ' yeni sipariş taslağı',
        ozet.senkronTeslim && ozet.senkronTeslim + ' paket teslim işaretlendi'].filter(Boolean).join(', ')
      + (ozet.hatalar.length ? (is ? '; ' : '') + 'sorun: ' + ozet.hatalar.join(' | ').slice(0, 400) : '')
      // Aşama süreleri İŞ YAPILAN turda da yazılır: bütçeyi hangi adımın yediği yalnız boş turlarda
      // görülebiliyordu, oysa asıl merak edilen dolu turdur.
      + sureOzeti(ozet)).run();
  // İŞ YOKKEN DE İZ BIRAKILIR (en çok 6 saatte bir): ekranda hiç satır olmayınca bakımın çalışıp
  // çalışmadığı anlaşılmıyordu. Her 15 dakikada yazmak listeyi doldururdu.
  // İŞ YOKKEN SEBEP DE YAZILIR: "iş yoktu" ile "senkrona sıra gelmedi" aynı şey değil. Süre bütçesi
  // rapor işlerine gidip pazaryerine hiç çıkılamadığında bu satır tek kanıttır.
  else await db.prepare("INSERT INTO ec_activity(id,description) SELECT ?,? "
    + "WHERE NOT EXISTS(SELECT 1 FROM ec_activity WHERE description LIKE 'Otomatik bakım%' AND created_at>datetime('now','-6 hours'))")
    .bind(crypto.randomUUID(), ('Otomatik bakım çalıştı; yapılacak iş yoktu.'
      + (ozet.senkronSebep.length ? ' Senkron: ' + ozet.senkronSebep.join(' | ') : '')
      + sureOzeti(ozet)).slice(0, 480)).run();
  return ozet;
}
