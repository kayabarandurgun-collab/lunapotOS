// OTOMATİK BAKIM (zamanlanmış, wrangler "triggers.crons"). Rapor yüklendikten sonraki işler normalde
// Rapor Kutusu ekranında hemen yapılır; ama o iş kullanıcının AÇIK SAYFASINDA yürür. Sayfa kapanırsa
// iş yarım kalır; bir kural sonradan iyileşirse (yeni iade/eşleme kuralı) eski veriye kimse
// uygulamaz. Kullanıcı "ne sana ne bana ihtiyaç duysun" dedi: sunucu aynı adımları kendisi tekrarlar.
//
//   1. yarım kalan rapor dosyalarını bitirir (kaldığı partiden)
//   2. her mağaza için: yeni siparişleri aktarır (stok ayırır / gönderir / teslim eder)
//   3. rapora göre teslimleri günceller, iadeleri kaydeder, kesintileri yazar
//   4. hareketi değişen ürünlerin satış maliyetini (FIFO) günceller
//
// Adımların hepsi tekrar çalıştırılabilir: yapılmış işi ikinci kez yazmaz. Kullanıcı o sırada dosya
// yüklüyorsa (son 10 dakikada rapor hareketi) aynı işi ekranla yarışarak yapmamak için tur atlanır.
import {scopedDB} from './scoped-db.js';
import {reportInboxApi} from './report-inbox-api.js';
import {reportStockLinkApi} from './report-stock-link-api.js';
import {fifoRevalue} from './fifo-cost.js';

const SISTEM = {owner: true, id: 'otomatik-bakim', username: 'otomatik', name: 'Otomatik bakım'};

export async function otomatikBakim(env, {sureMs = 50000, simdi = Date.now(), sakinDakika = 10} = {}) {
  const bas = Date.now(), vakitVar = () => Date.now() - bas < sureMs;
  const ec = {...env, DB: scopedDB(env.DB, 'ec'), ROOT_DB: env.DB, WORKSPACE: 'ec', USER: SISTEM};
  const db = env.DB;
  const son = await db.prepare('SELECT MAX(created_at) t FROM ec_report_files').first();
  if (son?.t && simdi - Date.parse(String(son.t).replace(' ', 'T') + 'Z') < sakinDakika * 60000)
    return {atlandi: 'Son ' + sakinDakika + ' dakikada rapor yüklendi; ekran işliyor olabilir.'};

  const cagir = (handler, yol, govde) => handler(new Request('https://internal.invalid/api/ec' + yol.replace(/^\/api/, ''), {method: govde === undefined ? 'GET' : 'POST'}),
    ec, yol, async () => govde);
  const ozet = {dosya: 0, siparis: 0, teslim: 0, iade: 0, kesinti: 0, maliyet: 0, hatalar: []};
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
      for (let i = 0; i < 200 && vakitVar(); i++) { const r = await cagir(reportInboxApi, '/api/reports/files/' + f.id + '/apply', {}); if (r.done) { ozet.dosya++; break; } }
      if (f.last_error) await db.prepare('UPDATE ec_report_file_attempts SET last_error=NULL,next_attempt_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE file_id=?').bind(f.id).run();
    } catch (e) {
      ozet.hatalar.push('dosya: ' + e.message);
      const bekle = Math.min(24 * 60, 15 * 2 ** Math.min(f.attempts, 10)) * 60000;
      await dene('dosya kaydı', () => db.prepare(`INSERT INTO ec_report_file_attempts(file_id,attempts,last_error,last_attempt_at,next_attempt_at) VALUES(?,1,?,?,?)
        ON CONFLICT(file_id) DO UPDATE SET attempts=attempts+1,last_error=excluded.last_error,last_attempt_at=excluded.last_attempt_at,next_attempt_at=excluded.next_attempt_at,updated_at=CURRENT_TIMESTAMP`)
        .bind(f.id, String(e.message || 'Bilinmeyen hata').slice(0, 500), zaman(simdi), zaman(simdi + bekle)).run());
    }
  }

  // 2–3. Mağaza başına aktarım, iade, kesinti; teslim güncellemesi mağazadan bağımsız.
  const magazalar = (await db.prepare("SELECT id FROM ec_report_stores WHERE provider IN ('trendyol','hepsiburada')").all()).results;
  for (const m of magazalar) {
    await dene('aktarım', async () => {
      const skip = [];
      for (let i = 0; i < 40 && vakitVar(); i++) {
        const r = await cagir(reportStockLinkApi, '/api/reports/stock-link/auto', {store_id: m.id, skip});
        for (const x of r.results) { if (x.done) ozet.siparis++; else skip.push(x.package_id); }
        if (!r.results.length || (!r.remaining && r.results.length < 5)) break;
      }
    });
  }
  await dene('teslim', async () => { ozet.teslim += (await cagir(reportInboxApi, '/api/reports/sync-deliveries', {confirm: true})).count || 0; });
  for (const m of magazalar) {
    await dene('iade', async () => {
      for (let i = 0; i < 10 && vakitVar(); i++) { const r = await cagir(reportStockLinkApi, '/api/reports/stock-link/returns-apply', {store_id: m.id, confirm: true}); ozet.iade += r.done.length; if (!r.remaining || !r.done.length) break; }
    });
    await dene('kesinti', async () => {
      let cursor = 0;
      for (let i = 0; i < 40 && vakitVar(); i++) {
        const f = await cagir(reportInboxApi, '/api/reports/apply-fees', {store_id: m.id, confirm: true, cursor});
        ozet.kesinti += f.sale_entries_changed || 0;
        if (!f.next_cursor || f.next_cursor <= cursor) break;
        cursor = f.next_cursor;
      }
    });
  }

  // 4. Maliyet (FIFO) kuyruğu.
  await dene('maliyet', async () => {
    for (let i = 0; i < 30 && vakitVar(); i++) { const r = await fifoRevalue(ec.DB, 8); ozet.maliyet += r.changed; if (!r.remaining) break; }
  });

  const is = ozet.dosya + ozet.siparis + ozet.teslim + ozet.iade + ozet.kesinti + ozet.maliyet;
  if (is || ozet.hatalar.length)
    await db.prepare('INSERT INTO ec_activity(id,description) VALUES(?,?)').bind(crypto.randomUUID(),
      'Otomatik bakım: ' + [ozet.dosya && ozet.dosya + ' rapor dosyası bitirildi', ozet.siparis && ozet.siparis + ' sipariş aktarıldı', ozet.teslim && ozet.teslim + ' teslim',
        ozet.iade && ozet.iade + ' iade', ozet.kesinti && ozet.kesinti + ' satışa kesinti yazıldı', ozet.maliyet && ozet.maliyet + ' maliyet düzeltmesi'].filter(Boolean).join(', ')
      + (ozet.hatalar.length ? (is ? '; ' : '') + 'sorun: ' + ozet.hatalar.join(' | ').slice(0, 400) : '')).run();
  // İŞ YOKKEN DE İZ BIRAKILIR (en çok 6 saatte bir): ekranda hiç satır olmayınca bakımın çalışıp
  // çalışmadığı anlaşılmıyordu. Her 15 dakikada yazmak listeyi doldururdu.
  else await db.prepare("INSERT INTO ec_activity(id,description) SELECT ?,'Otomatik bakım çalıştı; yapılacak iş yoktu.'"
    + " WHERE NOT EXISTS(SELECT 1 FROM ec_activity WHERE description LIKE 'Otomatik bakım%' AND created_at>datetime('now','-6 hours'))").bind(crypto.randomUUID()).run();
  return ozet;
}
