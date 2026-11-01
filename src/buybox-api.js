// BUYBOX ROBOTU: Hepsiburada ve Trendyol ilanlarının fiyatını kullanıcının ayarına göre yönetir.
// Karar buybox-motor.js'te, platform farkı buybox-suruculer.js'te; burası kayıt, tur ve ekran ucudur.
//
// Fiyat yüklemesi ASENKRONDUR: sonucu bir sonraki turda sorulur, sonuç gelmeden o ilana yeni fiyat gönderilmez.
//
// GÜVENLİK: yeni ilan 'kapali' başlar; 'izle' fiyat değiştirmez, yalnız "ne yapardım" yazar. Fiyat yalnız
// mode='aktif', ayarlar geçerli ve robot durdurulmamışken gönderilir. Reddedilen yükleme ya da panelden
// elle değiştirilen fiyat ilanı 'izle'ye alır ve Telegram'a haber verir: sessizce devam etmez.
import {encryptCredentials, decryptCredentials} from './connections-api.js';
import {buyboxKarari, hedefFiyat, kurallarGecerli, aktifOlabilir, zararSiniri, guvenlikSiniri} from './buybox-motor.js';
import {surucu} from './buybox-suruculer.js';
import {telegramAriza} from './telegram.js';

export const BUYBOX_CRON = '*/2 * * * *';
const SAGLAYICI = {hb: 'hepsiburada-buybox', ty: 'trendyol-buybox'}, PLATFORM_AD = {hb: 'Hepsiburada', ty: 'Trendyol'};
const YUKLEME_ZAMAN_ASIMI = 30 * 60000, YANSIMA_MS = 15 * 60000, TUR_KILIDI_MS = 110000, YAZMA_PARTI = 50, EN_COK_SAYFA = 100;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const dbOf = env => env.ROOT_DB || env.DB;
const gunTR = ms => new Date(ms + 3 * 3600000).toISOString().slice(0, 10);
const metin = (v, ad, max = 500) => { if (typeof v !== 'string' || !v.trim() || v.length > max || /[\r\n\x00]/.test(v)) fail(ad + ' eksik ya da geçersiz.'); return v.trim(); };
const parcala = (liste, boy) => { const p = []; for (let i = 0; i < liste.length; i += boy) p.push(liste.slice(i, i + boy)); return p; };
const tamId = v => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) fail('Bağlantı seçilmedi.'); return n; };

async function topluYaz(db, ifadeler) {
  for (const parti of parcala(ifadeler, YAZMA_PARTI)) if (parti.length) await db.batch(parti);
}

const kimlikAc = (env, satir) => decryptCredentials(env, SAGLAYICI[satir.platform], satir.seller_id, satir.encrypted_credentials);

// Aynı arıza 2 dakikada bir Telegram'a düşmesin: bağlantı başına günde bir haber.
async function gundeBirHaber(db, env, satir, gun, mesaj) {
  if (satir.alert_day === gun) return;
  satir.alert_day = gun;
  await db.prepare('UPDATE ec_buybox_connection SET alert_day=? WHERE id=?').bind(gun, satir.id).run();
  await telegramAriza(env, 'Buybox robotu (' + satir.magaza + ' ' + PLATFORM_AD[satir.platform] + '): ' + mesaj);
}

async function baglantiTuru(db, env, satir, simdi) {
  const gun = gunTR(simdi), ozet = {izlenen: 0, degisen: 0, reddedilen: 0};
  const kurallar = (await db.prepare("SELECT * FROM ec_buybox_rules WHERE connection_id=? AND (mode!='kapali' OR pending_upload_id IS NOT NULL)").bind(satir.id).all()).results;
  if (!kurallar.length) return {atlandi: 'ilan_yok'};
  const yaz = (sql, ...x) => db.prepare(sql).bind(...x);
  const kimlik = await kimlikAc(env, satir), s = surucu(satir.platform, kimlik);

  // 1. Bekleyen yüklemelerin sonucu. Sonuç gelmeden o ilana yeni fiyat gönderilmez.
  const bekleyen = new Set(), yuklemeler = new Map();
  for (const k of kurallar) if (k.pending_upload_id) yuklemeler.set(k.pending_upload_id, [...(yuklemeler.get(k.pending_upload_id) || []), k]);
  const sonucYaz = [], reddedilen = [];
  for (const [id, grup] of yuklemeler) {
    // Sorgu düşerse (süresi dolmuş kimlik gibi) bağlantının tamamı kilitlenmesin: yalnız bu ilanlar bekler, süre dolunca kapanır.
    let sonuclar = new Map();
    try { sonuclar = await s.sonuc(env, id, grup.map(k => k.sku)); } catch (e) { console.error('buybox yükleme sonucu', e.message); }
    for (const k of grup) {
      let {durum, neden} = sonuclar.get(k.sku) || {durum: 'bekliyor'};
      if (durum === 'bekliyor' && simdi - k.pending_since > YUKLEME_ZAMAN_ASIMI) { durum = 'hata'; neden = 'Fiyat yüklemesinin sonucu 30 dakikada gelmedi.'; }
      if (durum === 'bekliyor') { bekleyen.add(k.sku); continue; }
      sonucYaz.push(yaz('UPDATE ec_buybox_events SET status=? WHERE upload_id=? AND sku=? AND connection_id=?', durum, id, k.sku, satir.id));
      if (durum === 'tamam') {
        sonucYaz.push(yaz('UPDATE ec_buybox_rules SET pending_upload_id=NULL,pending_since=NULL,pending_cents=NULL,beklenen_cents=?,beklenen_at=?,last_error=NULL WHERE connection_id=? AND sku=?', k.pending_cents, simdi, satir.id, k.sku));
        k.beklenen_cents = k.pending_cents; k.beklenen_at = simdi; k.pending_upload_id = null; k.last_error = null;
      } else {
        sonucYaz.push(yaz("UPDATE ec_buybox_rules SET pending_upload_id=NULL,pending_since=NULL,pending_cents=NULL,mode=CASE mode WHEN 'aktif' THEN 'izle' ELSE mode END,last_error=? WHERE connection_id=? AND sku=?", neden, satir.id, k.sku));
        if (k.mode === 'aktif') k.mode = 'izle';
        k.last_error = neden; k.pending_upload_id = null;
        ozet.reddedilen++;
        reddedilen.push((k.label || k.sku) + ': ' + neden);
      }
    }
  }
  await topluYaz(db, sonucYaz);
  if (reddedilen.length) await telegramAriza(env, 'Buybox robotu: ' + reddedilen.length + ' ilanda fiyat reddedildi, ilanlar izlemeye alındı. ' + reddedilen.slice(0, 5).join(' · '));

  // 2. Güncel fiyat, stok, sıra ve rakip. 3. Karar.
  const gonderilecek = [], satirlar = [];
  let alanlar = null, hataFreni = 0;
  for (const parti of parcala(kurallar.filter(k => !bekleyen.has(k.sku) && k.mode !== 'kapali'), s.parti)) {
    const {gozlemler, alanlar: a} = await s.gozle(env, parti.map(k => k.sku), simdi);
    if (!alanlar?.length) alanlar = a;
    for (const k of parti) {
      const g = gozlemler.get(k.sku.toUpperCase());
      const gunluk = k.changes_day === gun ? k.changes_today : 0;
      let karar = g ? buyboxKarari({...k, changes_today: gunluk}, g) : {degistir: false, neden: 'ilan_yok'}, mode = k.mode, hata = null, beklenen = k.beklenen_cents, beklenenAt = k.beklenen_at, ilkBeklenen = false;
      if (k.mode === 'aktif' && g && Number.isSafeInteger(g.priceCents)) {
        if (beklenen === null || beklenen === undefined) { beklenen = g.priceCents; beklenenAt = simdi; ilkBeklenen = true; }
        else if (g.priceCents !== beklenen) {
          // Yeni gönderilen fiyat platforma geç yansıyabilir: süre dolmadan "elle değişti" denmez, karar da verilmez.
          if (simdi - (beklenenAt || 0) < YANSIMA_MS) karar = {degistir: false, neden: 'yansiyor'};
          else {
            karar = {degistir: false, neden: 'elle_degisti'}; mode = 'izle'; hata = 'Fiyat robot dışında değişti (' + (g.priceCents / 100) + ' TL). Robot bu ilanı izlemeye aldı.';
            await telegramAriza(env, 'Buybox robotu: ' + (k.label || k.sku) + ' fiyatı robot dışında değişti, ilan izlemeye alındı.');
          }
        }
      }
      if (karar.neden === 'hata_freni') hataFreni++;
      ozet.izlenen++;
      const gonder = mode === 'aktif' && karar.degistir && aktifOlabilir(k);
      satirlar.push({k, g, karar, gonder, gunluk, mode, hata, beklenen, beklenenAt, ilkBeklenen});
    }
  }
  if (alanlar) await yaz('UPDATE ec_buybox_connection SET sample_fields=? WHERE id=?', JSON.stringify(alanlar), satir.id).run();
  if (hataFreni) await gundeBirHaber(db, env, satir, gun, hataFreni + ' ilanda rakip fiyatı güvenlik sınırının üstünde; peşine düşülmedi. Ekrandan bakın.');

  // 4. Tek toplu yükleme. Trendyol'un "aynı istek 15 dakika" reddi arıza değildir: bu tur gönderilmez, durum ilerlemez.
  // Ağ istekleri sürerken kullanıcı durdurmuş ya da ilanı kapatmış olabilir: göndermeden hemen önce yeniden bakılır.
  let yuklemeId = null, tekrar = false;
  if (satirlar.some(x => x.gonder)) {
    const durdu = (await db.prepare('SELECT paused FROM ec_buybox_connection WHERE id=?').bind(satir.id).first())?.paused;
    const aktifler = new Set((await db.prepare("SELECT sku FROM ec_buybox_rules WHERE connection_id=? AND mode='aktif'").bind(satir.id).all()).results.map(x => x.sku));
    for (const x of satirlar) {
      if (x.gonder && (durdu || !aktifler.has(x.k.sku))) x.gonder = false;
      if (x.gonder) gonderilecek.push({sku: x.k.sku, cents: x.karar.yeniCents, listCents: x.g.listCents});
    }
  }
  if (gonderilecek.length) {
    try { yuklemeId = await s.fiyatGonder(env, gonderilecek); }
    catch (e) { if (!e.tekrar) throw e; tekrar = true; }
  }
  const ifadeler = [];
  for (const {k, g, karar, gonder, gunluk, mode, hata, beklenen, beklenenAt, ilkBeklenen} of satirlar) {
    const gitti = gonder && !tekrar, neden = gonder && tekrar ? 'tekrar_bekliyor' : karar.neden;
    const yeni = {price_cents: g?.priceCents ?? k.price_cents, list_cents: g?.listCents ?? k.list_cents, stock: g?.stock ?? null, rank: g?.rank ?? null, rival_cents: g?.rivalCents ?? null, oneri_cents: karar.degistir ? karar.yeniCents : null, last_reason: neden, kilit: g?.kilit ?? null, changes_today: gitti ? gunluk + 1 : gunluk, changes_day: gun};
    // Değişmeyen ilana yazılmaz: 200 ilan × 720 tur gereksiz D1 yazımı olurdu. Tazelik last_ok_at'tan okunur.
    // mode, last_error ve beklenen burada YAZILMAZ: tur sürerken kullanıcının yaptığı değişikliği ezmesin.
    if (gitti || Object.entries(yeni).some(([a, b]) => (k[a] ?? null) !== b)) ifadeler.push(yaz('UPDATE ec_buybox_rules SET price_cents=?,list_cents=?,stock=?,rank=?,rival_cents=?,oneri_cents=?,last_reason=?,kilit=?,changes_today=?,changes_day=?,pending_upload_id=COALESCE(?,pending_upload_id),pending_since=COALESCE(?,pending_since),pending_cents=COALESCE(?,pending_cents),checked_at=CURRENT_TIMESTAMP WHERE connection_id=? AND sku=?',
      yeni.price_cents, yeni.list_cents, yeni.stock, yeni.rank, yeni.rival_cents, yeni.oneri_cents, yeni.last_reason, yeni.kilit, yeni.changes_today, yeni.changes_day, gitti ? yuklemeId : null, gitti ? simdi : null, gitti ? karar.yeniCents : null, satir.id, k.sku));
    if (ilkBeklenen) ifadeler.push(yaz("UPDATE ec_buybox_rules SET beklenen_cents=?,beklenen_at=? WHERE connection_id=? AND sku=? AND mode='aktif' AND beklenen_cents IS NULL", beklenen, beklenenAt, satir.id, k.sku));
    if (mode !== k.mode) ifadeler.push(yaz("UPDATE ec_buybox_rules SET mode=?,last_error=? WHERE connection_id=? AND sku=? AND mode='aktif'", mode, hata, satir.id, k.sku));
    if (gitti) {
      ozet.degisen++;
      ifadeler.push(yaz('INSERT INTO ec_buybox_events(connection_id,sku,rank,rival_cents,old_cents,new_cents,reason,upload_id) VALUES(?,?,?,?,?,?,?,?)', satir.id, k.sku, g?.rank ?? null, g?.rivalCents ?? null, g?.priceCents ?? null, karar.yeniCents, karar.neden, yuklemeId));
    }
  }
  await topluYaz(db, ifadeler);
  return ozet;
}

export async function buyboxTuru(env, {simdi = Date.now(), connectionId = null} = {}) {
  const db = dbOf(env), gun = gunTR(simdi), ozet = {izlenen: 0, degisen: 0, reddedilen: 0, hatalar: []};
  const baglantilar = (await db.prepare('SELECT * FROM ec_buybox_connection').all()).results.filter(b => connectionId === null || b.id === connectionId);
  if (!baglantilar.length) return {atlandi: 'baglanti_yok'};
  let calisti = 0;
  for (const satir of baglantilar) {
    if (satir.paused) continue;
    // Bir önceki tur bitmeden ikincisi aynı ilanlara fiyat göndermesin.
    const kilit = await db.prepare('UPDATE ec_buybox_connection SET turda_at=? WHERE id=? AND (turda_at IS NULL OR turda_at<?)').bind(simdi, satir.id, simdi - TUR_KILIDI_MS).run();
    if (!kilit.meta?.changes) continue;
    try {
      const r = await baglantiTuru(db, env, satir, simdi);
      if (!r.atlandi) { calisti++; for (const a of ['izlenen', 'degisen', 'reddedilen']) ozet[a] += r[a]; }
      await db.prepare('UPDATE ec_buybox_connection SET last_run_at=CURRENT_TIMESTAMP,last_ok_at=CURRENT_TIMESTAMP,last_error=NULL,turda_at=NULL WHERE id=?').bind(satir.id).run();
    } catch (e) {
      ozet.hatalar.push(PLATFORM_AD[satir.platform] + ': ' + e.message);
      await db.prepare('UPDATE ec_buybox_connection SET last_error=?,last_run_at=CURRENT_TIMESTAMP,turda_at=NULL WHERE id=?').bind(String(e.message).slice(0, 300), satir.id).run();
      await gundeBirHaber(db, env, satir, gun, e.message);
    }
  }
  await db.prepare('DELETE FROM ec_buybox_events WHERE id NOT IN (SELECT id FROM ec_buybox_events ORDER BY id DESC LIMIT 5000)').run();
  return calisti || ozet.hatalar.length ? ozet : {atlandi: 'calisacak_ilan_yok'};
}

async function ilanlariGetir(db, env, satir) {
  const s = surucu(satir.platform, await kimlikAc(env, satir));
  let toplam = 0;
  for (let sayfa = 0; sayfa < EN_COK_SAYFA; sayfa++) {
    const {urunler, bitti} = await s.urunSayfasi(env, sayfa);
    await topluYaz(db, urunler.map(u => db.prepare('INSERT INTO ec_buybox_rules(connection_id,sku,merchant_sku,label,url,price_cents,list_cents,stock,komisyon_bp,checked_at) VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(connection_id,sku) DO UPDATE SET merchant_sku=excluded.merchant_sku,label=CASE WHEN excluded.label=excluded.merchant_sku THEN ec_buybox_rules.label ELSE excluded.label END,url=excluded.url,price_cents=excluded.price_cents,list_cents=excluded.list_cents,stock=excluded.stock,komisyon_bp=COALESCE(ec_buybox_rules.komisyon_bp,excluded.komisyon_bp),checked_at=CURRENT_TIMESTAMP').bind(satir.id, u.sku, u.merchant_sku, u.label, u.url, u.price_cents, u.list_cents, u.stock, u.komisyon_bp)));
    toplam += urunler.length;
    if (bitti) break;
  }
  // Hepsiburada ilan listesinde ürün adı yok: adı stok kodundan, önce aynı mağazanın Trendyol ilanından,
  // sonra panelin ürün kartından alır. Bulunamazsa stok kodu kalır; bu adım fiyata etki etmez, düşürmez de.
  if (satir.platform === 'hb') {
    try {
      await db.prepare("UPDATE ec_buybox_rules SET label=COALESCE((SELECT t.label FROM ec_buybox_rules t JOIN ec_buybox_connection c ON c.id=t.connection_id WHERE c.platform='ty' AND c.magaza=? AND t.merchant_sku=ec_buybox_rules.merchant_sku AND t.merchant_sku!='' LIMIT 1),label) WHERE connection_id=?").bind(satir.magaza, satir.id).run();
      await db.prepare("UPDATE ec_buybox_rules SET label=COALESCE((SELECT p.name FROM ec_products p WHERE p.sku=ec_buybox_rules.merchant_sku AND p.sku!='' LIMIT 1),label) WHERE connection_id=? AND label=merchant_sku").bind(satir.id).run();
    } catch (e) { console.error('buybox ürün adı', e.message); }
  }
  return toplam;
}

const tlOku = (v, ad) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(',', '.')); if (!Number.isFinite(n) || n <= 0 || n > 1e7) fail(ad + ' geçersiz.'); return Math.round(n * 100); };
const oranOku = v => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(',', '.')); if (!Number.isFinite(n) || n < 0 || n >= 100) fail('Komisyon oranı geçersiz.'); return Math.round(n * 100); };

function kuralOku(x) {
  const r = {taban_cents: tlOku(x.taban, 'Taban fiyat'), cekilme_cents: tlOku(x.cekilme, 'Çekilme fiyatı'), guvenlik_cents: tlOku(x.guvenlik, 'Güvenlik sınırı'), yukari_esit: x.yukari_esit === true || x.yukari_esit === 1 ? 1 : 0,
    maliyet_cents: tlOku(x.maliyet, 'Maliyet'), kargo_cents: tlOku(x.kargo, 'Kargo'), komisyon_bp: oranOku(x.komisyon), zarar_onay: x.zarar_onay === true || x.zarar_onay === 1 ? 1 : 0};
  r.zarar_cents = zararSiniri(r);
  if (r.taban_cents !== null && r.cekilme_cents !== null && r.cekilme_cents <= r.taban_cents) fail('Çekilme fiyatı tabandan yüksek olmalı.');
  if (r.guvenlik_cents !== null && r.cekilme_cents !== null && r.guvenlik_cents < r.cekilme_cents) fail('Güvenlik sınırı çekilme fiyatından küçük olamaz.');
  return r;
}

export async function buyboxApi(request, env, path, readBody) {
  if (path !== '/api/buybox' && !path.startsWith('/api/buybox/')) return null;
  if (env.WORKSPACE !== 'ec') fail('Bu ekran e-ticaret çalışma alanına aittir.', 403);
  const db = dbOf(env), method = request.method, alt = path.slice('/api/buybox'.length);
  if (method === 'GET' && alt === '') {
    const baglantilar = (await db.prepare('SELECT id,platform,magaza,seller_id,paused,last_run_at,last_ok_at,last_error,sample_fields FROM ec_buybox_connection ORDER BY magaza,platform').all()).results;
    return {
      baglantilar: baglantilar.map(({seller_id, sample_fields, paused, ...b}) => ({...b, hint: '…' + seller_id.slice(-4), paused: !!paused, sample_fields: sample_fields ? JSON.parse(sample_fields) : null})),
      kurallar: (await db.prepare('SELECT connection_id,sku,merchant_sku,label,url,mode,taban_cents,cekilme_cents,guvenlik_cents,yukari_esit,maliyet_cents,kargo_cents,komisyon_bp,zarar_cents,zarar_onay,price_cents,stock,rank,rival_cents,oneri_cents,last_reason,kilit,pending_upload_id,last_error,checked_at FROM ec_buybox_rules ORDER BY label,sku LIMIT 5000').all()).results,
      yonetici: !!env.USER?.owner
    };
  }
  if (method === 'GET' && alt === '/olaylar') {
    const q = new URL(request.url).searchParams;
    return {olaylar: (await db.prepare('SELECT at,rank,rival_cents,old_cents,new_cents,reason,status FROM ec_buybox_events WHERE connection_id=? AND sku=? ORDER BY id DESC LIMIT 30').bind(tamId(q.get('connection_id')), metin(q.get('sku'), 'SKU', 100)).all()).results};
  }
  if (method !== 'POST') return null;
  // Kimlik ve gerçek fiyatı değiştiren her iş yalnız hesap sahibinde.
  if (!env.USER?.owner) fail('Bu işlemi yalnız hesap sahibi yapabilir.', 403);
  let x = await readBody(request);
  if (alt === '/dene') {
    // Yalnız hesap: hiçbir şey kaydetmez, hiçbir yere gitmez.
    const r = kuralOku(x);
    if (!kurallarGecerli(r)) fail('Önce taban ve çekilme fiyatını girin.');
    const fiyat = tlOku(x.fiyat, 'Şu anki fiyat'), rakip = tlOku(x.rakip, 'Rakip fiyatı');
    if (fiyat === null) fail('Şu anki fiyat gerekli.');
    const g = {priceCents: fiyat, rivalCents: rakip, rakipVar: rakip === null ? false : null, rank: x.sira === 1 || x.sira === '1' ? 1 : x.sira === 2 || x.sira === '2' ? 2 : null};
    return {...buyboxKarari(r, g), hedef: hedefFiyat(r, g).hedef ?? null, guvenlik_cents: guvenlikSiniri(r), zarar_cents: r.zarar_cents};
  }
  if (alt === '/baglanti') {
    const platform = x.platform === 'ty' ? 'ty' : x.platform === 'hb' ? 'hb' : fail('Platform seçilmedi.');
    const magaza = metin(x.magaza, 'Mağaza adı', 60), seller = metin(x.seller_id, 'Satıcı kimliği', 100);
    if (platform === 'hb' ? !/^[a-f\d-]{32,36}$/i.test(seller) : !/^\d{1,20}$/.test(seller)) fail('Satıcı kimliği biçimi geçersiz.');
    const kimlik = {seller_id: seller, key: metin(x.key, 'API kullanıcı adı'), secret: metin(x.secret, 'API şifresi', 1000), user_agent: platform === 'hb' ? metin(x.user_agent, 'User-Agent', 200) : seller + ' - SelfIntegration'};
    if (!/^[\x20-\x7e]+$/.test(kimlik.key + kimlik.secret + kimlik.user_agent) || kimlik.key.includes(':')) fail('API bilgisinde geçersiz karakter var.');
    const sifreli = await encryptCredentials(env, SAGLAYICI[platform], seller, kimlik);
    await db.prepare('INSERT INTO ec_buybox_connection(platform,magaza,seller_id,encrypted_credentials) VALUES(?,?,?,?) ON CONFLICT(platform,magaza) DO UPDATE SET seller_id=excluded.seller_id,encrypted_credentials=excluded.encrypted_credentials,configured_at=CURRENT_TIMESTAMP,last_ok_at=NULL,last_error=NULL,sample_fields=NULL').bind(platform, magaza, seller, sifreli).run();
    return {kaydedildi: true};
  }
  if (alt === '/duraklat') {
    if (typeof x.paused !== 'boolean') fail('Değer yalnız true/false olabilir.');
    const v = x.paused ? 1 : 0;
    await (x.connection_id ? db.prepare('UPDATE ec_buybox_connection SET paused=? WHERE id=?').bind(v, tamId(x.connection_id)) : db.prepare('UPDATE ec_buybox_connection SET paused=?').bind(v)).run();
    return {paused: x.paused};
  }
  if (alt === '/calistir') return buyboxTuru(env, {connectionId: x.connection_id ? tamId(x.connection_id) : null});
  const cid = tamId(x.connection_id);
  if (alt === '/kural') {
    const sku = metin(x.sku, 'SKU', 100), mode = ['kapali', 'izle', 'aktif'].includes(x.mode) ? x.mode : 'kapali';
    // Komisyon gönderilmediyse platformdan gelen oran silinmez.
    if (x.komisyon === undefined) { const e = await db.prepare('SELECT komisyon_bp k FROM ec_buybox_rules WHERE connection_id=? AND sku=?').bind(cid, sku).first(); if (e?.k !== null && e?.k !== undefined) x = {...x, komisyon: e.k / 100}; }
    const r = kuralOku(x);
    if (mode === 'aktif') {
      if (!kurallarGecerli(r)) fail('Aktif için taban ve çekilme fiyatı gerekli.');
      if (!aktifOlabilir(r)) fail(r.zarar_cents === null ? 'Maliyet girilmedi. Maliyeti girin ya da "zararına satmayı kabul ediyorum" kutusunu işaretleyin.' : 'Taban, zarar sınırının (' + (r.zarar_cents / 100) + ' TL) altında. Tabanı yükseltin ya da zarar onayını işaretleyin.');
    }
    const c = await db.prepare('UPDATE ec_buybox_rules SET taban_cents=?,cekilme_cents=?,guvenlik_cents=?,yukari_esit=?,maliyet_cents=?,kargo_cents=?,komisyon_bp=?,zarar_cents=?,zarar_onay=?,mode=?,beklenen_cents=NULL,beklenen_at=NULL,last_error=NULL,oneri_cents=NULL WHERE connection_id=? AND sku=?').bind(r.taban_cents, r.cekilme_cents, r.guvenlik_cents, r.yukari_esit, r.maliyet_cents, r.kargo_cents, r.komisyon_bp, r.zarar_cents, r.zarar_onay, mode, cid, sku).run();
    if (!c.meta?.changes) fail('Bu ilan listede yok; önce ilanları getirin.', 404);
    return {kaydedildi: true, zarar_cents: r.zarar_cents};
  }
  if (alt === '/toplu') {
    const skular = Array.isArray(x.skus) ? x.skus.filter(s => typeof s === 'string' && s && s.length <= 100) : [];
    if (!skular.length || skular.length > 5000) fail('İlan seçilmedi.');
    const mode = ['kapali', 'izle', 'aktif'].includes(x.mode) ? x.mode : null, yuzde = x.taban_yuzde === undefined || x.taban_yuzde === '' ? null : Number(String(x.taban_yuzde).replace(',', '.'));
    if (mode === null && yuzde === null) fail('Toplu işlem seçilmedi.');
    if (yuzde !== null && !(yuzde > 0 && yuzde < 90)) fail('Taban yüzdesi 0 ile 90 arasında olmalı.');
    let degisen = 0;
    for (const parti of parcala(skular, 40)) {
      const yer = parti.map(() => '?').join(',');
      // Taban değişince önceki onay geçerli sayılmaz: Aktif ilan önce izlemeye düşer.
      if (yuzde !== null) await db.prepare("UPDATE ec_buybox_rules SET taban_cents=MAX(CAST(ROUND(price_cents*(100-?)/10000.0) AS INTEGER),1)*100,cekilme_cents=price_cents,mode=CASE mode WHEN 'aktif' THEN 'izle' ELSE mode END,beklenen_cents=NULL,beklenen_at=NULL WHERE connection_id=? AND price_cents>0 AND sku IN (" + yer + ')').bind(yuzde, cid, ...parti).run();
      if (mode) {
        const kosul = mode === 'aktif' ? ' AND taban_cents IS NOT NULL AND cekilme_cents>taban_cents AND (zarar_onay=1 OR (zarar_cents IS NOT NULL AND taban_cents>=zarar_cents))' : '';
        const c = await db.prepare('UPDATE ec_buybox_rules SET mode=?,beklenen_cents=NULL,beklenen_at=NULL,last_error=NULL WHERE connection_id=? AND sku IN (' + yer + ')' + kosul).bind(mode, cid, ...parti).run();
        degisen += c.meta?.changes || 0;
      }
    }
    return {secilen: skular.length, degisen};
  }
  const satir = await db.prepare('SELECT * FROM ec_buybox_connection WHERE id=?').bind(cid).first();
  if (!satir) fail('Bağlantı bulunamadı.', 404);
  if (alt === '/ilanlar') return {getirilen: await ilanlariGetir(db, env, satir)};
  if (alt === '/sina') {
    // Salt okunur: fiyat göndermez. Yanıtın ALAN ADLARINI döndürür (HB belgesinde şema yok).
    const s = surucu(satir.platform, await kimlikAc(env, satir));
    let skular = (await db.prepare('SELECT sku FROM ec_buybox_rules WHERE connection_id=? ORDER BY sku LIMIT 5').bind(cid).all()).results.map(r => r.sku);
    if (!skular.length) skular = (await s.urunSayfasi(env, 0)).urunler.slice(0, 5).map(u => u.sku);
    if (!skular.length) return {ilan: 0, alanlar: [], sira_okundu: 0, rakip_okundu: 0};
    const {gozlemler, alanlar} = await s.gozle(env, skular, Date.now()), g = [...gozlemler.values()];
    await db.prepare('UPDATE ec_buybox_connection SET sample_fields=?,last_ok_at=CURRENT_TIMESTAMP,last_error=NULL WHERE id=?').bind(JSON.stringify(alanlar), cid).run();
    return {ilan: skular.length, alanlar, sira_okundu: g.filter(o => o.rank !== null).length, rakip_okundu: g.filter(o => o.rivalCents !== null || o.rakipVar === false).length};
  }
  return null;
}
