// HAKEDİŞ–BANKA EŞLEŞTİRME — yalnızca e-ticaret (ec) çalışma alanı.
//
//   GET  /api/ec/bank/matches/candidates?account_id&provider   aday listesi — HİÇBİR ŞEY YAZMAZ
//   GET  /api/ec/bank/matches                                  onaylı/geri alınmış eşleştirmeler + alacak bakiyesi
//   POST /api/ec/bank/matches                                  onay — PARA BURADA DEFTERE GİRER
//   POST /api/ec/bank/matches/:id/reverse                      geri alma (ters kayıt)
//
// TEMEL KURAL: KAYDI DOĞURAN ŞEY BANKA SATIRIDIR.
// ec_provider_records yalnızca ADAY LİSTESİ için okunur; pazaryerinin bildirdiği tutarla ön kayıt
// AÇILMAZ (migrations/0008_connections.sql "source inbox only"). Bir kasa hareketi ancak yüklenmiş
// bir banka ekstresi satırı ve kullanıcının açık onayı birlikte varken doğar.
//
// DEFTERE YAZILAN TUTAR HER ZAMAN BANKA SATIRININ TUTARIDIR. Pazaryerinin bildirdiği tutar yalnız
// kanıt olarak (reported_cents) saklanır; böylece kuruş farkı defteri hiçbir koşulda bozamaz.
import {can} from '../public/permissions.js';

const fail = (message, status = 400, detail = null) => { throw Object.assign(new Error(message), detail ? {status, detail} : {status}); };
const uuid = () => crypto.randomUUID();
const key = v => { if (!/^[\w-]{1,100}$/.test(v || '')) fail('Kayıt seçimi geçersiz.'); return v; };

// Ödeme emri kimliği pazaryerinden gelir; sınırlandırılır ama biçimi zorlanmaz.
const label = (v, max = 200) => typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '';
const note = (v, max = 500) => typeof v === 'string' ? v.trim().slice(0, max) : '';

// Pazaryeri damgaları UTC gelir, defterdeki gün TÜRKİYE günüdür (+03) — src/connections-api.js gunTR ile aynı kural.
const gunTR = v => { const t = Date.parse(v || ''); return Number.isFinite(t) ? new Date(t + 3 * 3600000).toISOString().slice(0, 10) : null; };
const bugunTR = () => new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const day = v => { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) fail('Geçerli tarih girin.'); return v; };
const kaydir = (gun, n) => new Date(Date.parse(gun + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
// Pazaryeri TL cinsinden ondalıklı sayı bildirir (src/connections-api.js `numeric`); kuruşa burada çevrilir.
const kurus = v => typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null;

// Ödeme emirleri hangi kaynak kutusu türünde? Trendyol PaymentOrder kayıtları kind='payments'
// olarak saklanır. Hepsiburada bağlayıcısında ödeme emri kavramı HENÜZ YOK (kind='finance'
// kayıtlarında paymentOrderId gelmiyor): yapı pazaryeri başına hazır, ama uydurma eşleşme
// üretilmez — o pazaryeri için aday listesi boş döner ve sebebi yazılır.
const PROVIDERS = {
  trendyol: {name: 'Trendyol', kind: 'payments'},
  hepsiburada: {name: 'Hepsiburada', kind: null}
};
const clearingName = provider => PROVIDERS[provider].name + ' Alacağı';

// Tarih penceresi: ödeme emri ile bankaya geçiş arasında birkaç iş günü olabilir.
const WINDOW_DAYS = 5;
// KURUŞ FARKI KARARI: tam eşitlik dışındaki hiçbir aday ÖNERİLMEZ. 1,00 TL'ye kadar olan fark
// kullanıcıya "yakın" diye gösterilir ve ancak AÇIK ONAYLA (accept_difference) yazılabilir;
// bunun üstü hiçbir onayla geçmez. Deftere her hâlükârda banka tutarı yazıldığı için fark
// kasayı bozmaz, yalnız hangi ödeme emrine denk geldiği bilgisini etkiler.
const TOLERANCE_CENTS = 100;
const MAX_RECORDS = 20000;
const MAX_LINES = 300;
const MAX_CANDIDATES = 10;

const NOTICE = 'Aday listesi salt okunurdur: hiçbir kayıt oluşturmaz. Para yalnızca bir banka ekstresi satırını onayladığınızda deftere girer ve deftere yazılan tutar her zaman bankadaki tutardır.';
const BALANCE_NOTE = 'Pazaryeri alacak hesabının bakiyesi SIFIR olmalıdır: gelen para aynı anda gerçek banka hesabına aktarılır. Sıfırdan farklıysa açıklanmamış para vardır.';

/** Kaynak kutusundaki ödeme emirleri. SALT OKUNUR; hiçbir yere yazmaz. */
async function paymentOrders(db, provider) {
  const kind = PROVIDERS[provider].kind;
  if (!kind) return {groups: [], unusable: [], supported: false};
  // Aynı dış kimliğin her değişen sürümü saklanır; yalnız EN SON sürüm okunur
  // (src/connections-api.js:189 ile aynı sıralama kuralı).
  const rows = (await db.prepare('SELECT external_id,seller_id,payload_json,source_updated_at FROM ' +
    '(SELECT external_id,seller_id,payload_json,source_updated_at,ROW_NUMBER() OVER(PARTITION BY seller_id,external_id ORDER BY source_updated_at DESC,last_seen_at DESC,rowid DESC) rn' +
    ' FROM provider_records WHERE provider=? AND kind=?) WHERE rn=1 ORDER BY external_id LIMIT ?')
    .bind(provider, kind, MAX_RECORDS + 1).all()).results;
  if (rows.length > MAX_RECORDS) fail('Bu pazaryerinin kaynak kayıtları bu görünümün sınırını aşıyor; eksik liste gösterilmedi.', 409);
  const byKey = new Map();
  for (const row of rows) {
    let data; try { data = JSON.parse(row.payload_json); } catch { data = null; }
    const invalid = !data || typeof data !== 'object' || Array.isArray(data);
    data = invalid ? {} : data;
    const order = label(data.payment_order_id);
    // Ödeme emri kimliği gelmediyse kayıt kendi başına durur; uydurma grup kimliği üretilmez.
    const groupKey = order || 'kayit:' + label(row.external_id);
    let group = byKey.get(groupKey);
    if (!group) {
      group = {payment_order_id: groupKey, grouped_by: order ? 'payment_order' : 'record', net_cents: 0,
        record_count: 0, dates: [], sellers: new Set(), invalid: false, missing_amount: 0};
      byKey.set(groupKey, group);
    }
    group.invalid ||= invalid;
    group.record_count++;
    group.sellers.add(row.seller_id);
    const credit = kurus(data.credit), debt = kurus(data.debt);
    if (credit === null && debt === null) group.missing_amount++;
    group.net_cents += (credit || 0) - (debt || 0);
    const gun = gunTR(data.source_updated_at || row.source_updated_at);
    if (gun) group.dates.push(gun);
  }
  const groups = [], unusable = [];
  for (const group of byKey.values()) {
    const dates = group.dates.sort();
    const reason = group.invalid ? 'Kaynak kayıtta geçersiz veri var.'
      : group.sellers.size !== 1 ? 'Aynı ödeme emri birden çok satıcı hesabında görünüyor; birleştirilmedi.'
      : !dates.length ? 'Ödeme emrinin tarihi gelmedi; tarih uydurulmadı.'
      : group.missing_amount === group.record_count ? 'Ödeme emrinde tutar alanı yok.'
      : group.net_cents <= 0 ? 'Ödeme emrinin net tutarı sıfır veya eksi; para girişi adayı değil.' : null;
    const item = {payment_order_id: group.payment_order_id, grouped_by: group.grouped_by, net_cents: group.net_cents,
      record_count: group.record_count, first_date: dates[0] || null, last_date: dates.at(-1) || null};
    if (reason) unusable.push({...item, reason}); else groups.push(item);
  }
  groups.sort((a, b) => a.first_date.localeCompare(b.first_date) || a.payment_order_id.localeCompare(b.payment_order_id));
  return {groups, unusable, supported: true};
}

const inWindow = (group, occurredOn) =>
  occurredOn >= kaydir(group.first_date, -WINDOW_DAYS) && occurredOn <= kaydir(group.last_date, WINDOW_DAYS);

/**
 * Bir ekstre satırının adayları. Aynı tutarlı birden çok ödeme emri varsa ÖNERİ VERİLMEZ:
 * belirsizlikte otomatik yazma yoktur, seçimi kullanıcı yapar (report-inbox 'ambiguous_twin' kalıbı).
 */
function matchLine(line, open) {
  const yakin = open.filter(g => Math.abs(g.net_cents - line.amount_cents) <= TOLERANCE_CENTS && inWindow(g, line.occurred_on))
    .map(g => ({...g, difference_cents: line.amount_cents - g.net_cents, fit: g.net_cents === line.amount_cents ? 'exact' : 'near'}))
    .sort((a, b) => Math.abs(a.difference_cents) - Math.abs(b.difference_cents) || a.first_date.localeCompare(b.first_date));
  const tam = yakin.filter(g => g.fit === 'exact');
  const status = tam.length === 1 ? 'exact' : tam.length > 1 || yakin.length > 1 ? 'ambiguous' : yakin.length === 1 ? 'near' : 'unmatched';
  const notes = {
    exact: 'Tutar birebir aynı ve tarih penceresi tutuyor. Onaylarsanız para deftere girer.',
    ambiguous: 'Aynı tutara uyan birden çok ödeme emri var; hangisi olduğu kesin değil. Öneri verilmedi, seçimi siz yapın.',
    near: 'Tutar birebir tutmuyor (kuruş farkı). Öneri verilmedi; onaylarsanız deftere BANKA tutarı yazılır.',
    unmatched: 'Bu tutara ve tarihe uyan bir ödeme emri bulunamadı. Kaynak kayıtlar eksik olabilir veya bu para hakediş değildir.'
  };
  return {bank_line_id: line.id, occurred_on: line.occurred_on, amount_cents: line.amount_cents,
    description: line.description, reference: line.reference, counterparty: line.counterparty,
    status, suggestion: status === 'exact' ? tam[0] : null, candidates: yakin.slice(0, MAX_CANDIDATES),
    candidates_truncated: yakin.length > MAX_CANDIDATES, note: notes[status]};
}

const clearingAccount = (db, provider) =>
  db.prepare("SELECT id,name,archived_at FROM cash_accounts WHERE role='marketplace_clearing' AND provider=?").bind(provider).first();
const balance = async (db, accountId) =>
  (await db.prepare('SELECT COALESCE(SUM(amount_cents),0) b FROM cash_transactions WHERE account_id=?').bind(accountId).first()).b;

export async function bankMatchApi(request, env, path, readBody) {
  if (!path.startsWith('/api/bank/matches')) return null;
  if (env.WORKSPACE !== 'ec') fail('Hakediş–banka eşleştirme yalnızca e-ticaret çalışma alanında kullanılır.', 403);
  const db = env.DB, method = request.method, url = new URL(request.url), sub = path.slice('/api/bank/matches'.length);
  const write = !['GET', 'HEAD'].includes(method);
  // Yetki worker'da da denetlenir; burada ikinci kez sorulur çünkü bu uç KASAYA PARA YAZAR.
  if (!env.USER?.owner && !can(env.USER, 'ec', 'ledger', write))
    fail(write ? 'Bu işlem için cari ve nakit (yazma) yetkisi gerekli.' : 'Bu görünüm için cari ve nakit yetkisi gerekli.', 403);

  /* ---------- aday motoru: SALT OKUNUR ---------- */
  if (sub === '/candidates' && method === 'GET') {
    const provider = url.searchParams.get('provider') || 'trendyol';
    if (!Object.hasOwn(PROVIDERS, provider)) fail('Pazaryeri seçimi geçersiz.');
    const accountId = url.searchParams.get('account_id') || '';
    if (accountId) key(accountId);
    const [accounts, clearing, payouts] = await Promise.all([
      db.prepare('SELECT a.id,a.name,a.kind,(SELECT COUNT(*) FROM bank_lines l WHERE l.account_id=a.id) line_count' +
        ' FROM cash_accounts a WHERE a.role IS NULL AND a.archived_at IS NULL AND EXISTS(SELECT 1 FROM bank_lines l WHERE l.account_id=a.id) ORDER BY a.name').all(),
      clearingAccount(db, provider),
      paymentOrders(db, provider)
    ]);
    // Hesap seçilmemiş ya da hiç ekstresi yoksa: boş ama anlaşılır yanıt, hata DEĞİL.
    // Canlıda henüz tek bir ekstre bile yüklenmemiş olabilir; ekran o hâlde de düzgün açılmalı.
    const lines = accountId ? (await db.prepare(
      'SELECT l.id,l.occurred_on,l.amount_cents,l.description,l.reference,l.counterparty FROM bank_lines l' +
      ' JOIN cash_accounts a ON a.id=l.account_id WHERE l.account_id=? AND a.role IS NULL AND l.amount_cents>0' +
      " AND NOT EXISTS(SELECT 1 FROM bank_matches m WHERE m.bank_line_id=l.id AND m.status='confirmed')" +
      ' ORDER BY l.occurred_on DESC,l.rowid DESC LIMIT ?').bind(accountId, MAX_LINES + 1).all()).results : [];
    const used = new Set((await db.prepare("SELECT payment_order_id FROM bank_matches WHERE provider=? AND status='confirmed'").bind(provider).all()).results.map(r => r.payment_order_id));
    const open = payouts.groups.filter(g => !used.has(g.payment_order_id));
    const clearingBalance = clearing ? await balance(db, clearing.id) : 0;
    return {
      writes: false, provider, providers: Object.entries(PROVIDERS).map(([id, p]) => ({id, name: p.name, supported: !!p.kind})),
      account_id: accountId || null, accounts: accounts.results,
      clearing_account: clearing ? {...clearing, balance_cents: clearingBalance} : null,
      clearing_suggested_name: clearingName(provider),
      lines: lines.slice(0, MAX_LINES).map(line => matchLine(line, open)),
      lines_truncated: lines.length > MAX_LINES,
      payment_orders: {total: payouts.groups.length + payouts.unusable.length, matched: used.size,
        open: open.length, unusable: payouts.unusable.slice(0, 50), supported: payouts.supported},
      tolerance_cents: TOLERANCE_CENTS, window_days: WINDOW_DAYS,
      notice: payouts.supported ? NOTICE
        : PROVIDERS[provider].name + ' bağlantısı henüz ödeme emri (hakediş transferi) bildirmiyor; aday üretilmedi. ' + NOTICE,
      balance_note: BALANCE_NOTE
    };
  }

  /* ---------- onaylanmış eşleştirmeler ---------- */
  if (sub === '' && method === 'GET') {
    const [clearing, matches] = await Promise.all([
      db.prepare("SELECT a.id,a.name,a.provider,COALESCE((SELECT SUM(t.amount_cents) FROM cash_transactions t WHERE t.account_id=a.id),0) balance_cents," +
        "COALESCE((SELECT SUM(m.matched_cents) FROM bank_matches m WHERE m.clearing_account_id=a.id AND m.status='confirmed'),0) in_cents," +
        "(SELECT COUNT(*) FROM bank_matches m WHERE m.clearing_account_id=a.id AND m.status='confirmed') match_count" +
        " FROM cash_accounts a WHERE a.role='marketplace_clearing' ORDER BY a.name").all(),
      db.prepare('SELECT m.id,m.bank_line_id,m.provider,m.payment_order_id,m.matched_cents,m.reported_cents,m.status,m.reason,' +
        'm.reversal_reason,m.reversed_at,m.created_at,l.occurred_on,l.description,l.reference,l.counterparty,a.name account_name,c.name clearing_account_name' +
        ' FROM bank_matches m JOIN bank_lines l ON l.id=m.bank_line_id JOIN cash_accounts a ON a.id=l.account_id' +
        ' JOIN cash_accounts c ON c.id=m.clearing_account_id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 201').all()
    ]);
    const unexplained = clearing.results.reduce((sum, a) => sum + a.balance_cents, 0);
    return {clearing_accounts: clearing.results, matches: matches.results.slice(0, 200),
      truncated: matches.results.length > 200, unexplained_cents: unexplained,
      balance_note: BALANCE_NOTE + (unexplained ? ' Şu anda açıklanmamış para var; eşleştirmeleri gözden geçirin.' : ''),
      notice: NOTICE};
  }

  if (!write) fail('Hakediş eşleştirme işlemi bulunamadı.', 404);

  /* ---------- onay: PARA BURADA DEFTERE GİRER ---------- */
  if (sub === '' && method === 'POST') {
    const x = await readBody(request);
    const provider = label(x.provider) || 'trendyol';
    if (!Object.hasOwn(PROVIDERS, provider)) fail('Pazaryeri seçimi geçersiz.');
    const order = label(x.payment_order_id);
    if (!order) fail('Hangi ödeme emrine denk geldiğini seçin.');

    const line = await db.prepare('SELECT l.id,l.account_id,l.occurred_on,l.amount_cents,l.description,l.reference,a.name account_name,a.role account_role,a.archived_at' +
      ' FROM bank_lines l JOIN cash_accounts a ON a.id=l.account_id WHERE l.id=?').bind(key(x.bank_line_id)).first();
    if (!line) fail('Ekstre satırı bulunamadı. Önce banka ekstresini yükleyin.', 404);
    if (line.account_role) fail('Bu satır bir pazaryeri alacak hesabına ait; hakediş girişi gerçek banka ekstresinden onaylanır.', 409);
    if (line.archived_at) fail(line.account_name + ' arşivlenmiş bir hesaptır; yeni para hareketi yazılamaz.', 409);
    if (line.amount_cents <= 0) fail('Bu ekstre satırı para girişi değil. Hakediş yalnızca hesaba giren para için onaylanır.', 409);

    const varOlan = await db.prepare("SELECT id FROM bank_matches WHERE bank_line_id=? AND status='confirmed'").bind(line.id).first();
    if (varOlan) fail('Bu ekstre satırı zaten bir hakedişle eşleşti; ikinci kez yazılmaz. Önce eşleştirmeyi geri alın.', 409);
    const kullanilmis = await db.prepare("SELECT bank_line_id FROM bank_matches WHERE provider=? AND payment_order_id=? AND status='confirmed'").bind(provider, order).first();
    if (kullanilmis) fail('Bu ödeme emri başka bir ekstre satırına zaten yazıldı; aynı para iki kez sayılmaz.', 409);

    const payouts = await paymentOrders(db, provider);
    const group = payouts.groups.find(g => g.payment_order_id === order);
    if (!group) {
      const neden = payouts.unusable.find(g => g.payment_order_id === order);
      fail(neden ? 'Bu ödeme emri kullanılamaz: ' + neden.reason : 'Bu ödeme emri kaynak kayıtlarda bulunamadı. Önce pazaryeri senkronunu çalıştırın.', 404);
    }
    if (!inWindow(group, line.occurred_on))
      fail('Ödeme emrinin tarihi (' + group.first_date + (group.last_date !== group.first_date ? ' – ' + group.last_date : '') +
        ') ekstre satırının tarihine (' + line.occurred_on + ') ' + WINDOW_DAYS + ' günden uzak. Eşleştirme yazılmadı.', 409);

    const matched = line.amount_cents, reported = group.net_cents, difference = matched - reported;
    if (Math.abs(difference) > TOLERANCE_CENTS)
      fail('Bankaya giren tutar ile ödeme emrinin net tutarı birbirini tutmuyor; bu bir kuruş farkı değil. Eşleştirme yazılmadı.', 409,
        {code: 'amount_mismatch', matched_cents: matched, reported_cents: reported, difference_cents: difference});
    if (difference !== 0 && x.accept_difference !== true)
      fail('Bankaya giren tutar ile ödeme emrinin net tutarı arasında kuruş farkı var. Deftere banka tutarı yazılacak; onaylamak için farkı kabul edin.', 409,
        {code: 'amount_difference', matched_cents: matched, reported_cents: reported, difference_cents: difference});

    let clearing = await clearingAccount(db, provider);
    const items = [], clearingId = clearing ? clearing.id : uuid();
    if (clearing && clearing.archived_at) fail(clearing.name + ' arşivlenmiş; hakediş yazmadan önce arşivden geri alın.', 409);
    if (!clearing) {
      // ALACAK HESABI SESSİZCE AÇILMAZ. Para hesabı açmak başlı başına bir defter işidir:
      // yanlış pazaryeri seçimi kendiliğinden hesap doğurmamalı. Kullanıcı açıkça onaylar.
      if (x.create_clearing_account !== true)
        fail(clearingName(provider) + ' hesabı henüz yok. Bu pazaryerinden gelen para bu hesapta toplanır; açmak için onaylayın.', 409,
          {code: 'clearing_account_missing', provider, suggested_name: clearingName(provider)});
      items.push(db.prepare("INSERT INTO cash_accounts(id,name,kind,role,provider) VALUES(?,?,'bank','marketplace_clearing',?)")
        .bind(clearingId, clearingName(provider), provider));
    }

    const matchId = uuid(), gun = line.occurred_on;
    const açıklama = PROVIDERS[provider].name + ' hakedişi · ödeme emri ' + order + ' · ekstre ' + line.account_name + ' ' + gun;
    const cashInsert = (id, account, amount, reference, description) =>
      db.prepare('INSERT INTO cash_transactions(id,account_id,party_entry_id,amount_cents,occurred_on,reference,description) VALUES(?,?,NULL,?,?,?,?)')
        .bind(id, account, amount, gun, reference, description);
    // Üç hareket, tek yazma kümesi: ya hepsi yazılır ya hiçbiri.
    //  1) alacak hesabına giriş  2) alacaktan virman çıkışı  3) gerçek bankaya virman girişi
    // Net etki: gerçek banka +B, alacak hesabı 0. ANA KASA HİÇ ETKİLENMEZ.
    const girisId = uuid(), cikisId = uuid(), varisId = uuid();
    items.push(cashInsert(girisId, clearingId, matched, 'HAKEDIS-' + matchId, açıklama));
    items.push(cashInsert(cikisId, clearingId, -matched, 'HAKEDIS-VIRMAN-C-' + matchId, 'Virman · ' + açıklama + ' → ' + line.account_name));
    items.push(cashInsert(varisId, line.account_id, matched, 'HAKEDIS-VIRMAN-B-' + matchId, 'Virman · ' + clearingName(provider) + ' → ' + line.account_name + ' · ödeme emri ' + order));
    items.push(db.prepare('INSERT INTO bank_matches(id,bank_line_id,provider,payment_order_id,matched_cents,reported_cents,clearing_account_id,clearing_in_id,transfer_out_id,transfer_in_id,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .bind(matchId, line.id, provider, order, matched, reported, clearingId, girisId, cikisId, varisId,
        note(x.note) || (difference ? 'Kuruş farkı kabul edildi: bankadan gelen tutar yazıldı.' : '')));

    try { await db.batch(items); }
    catch (e) {
      const m = String(e.message);
      if (/UNIQUE constraint failed: ec_cash_accounts\.name/.test(m)) fail(clearingName(provider) + ' adıyla başka bir hesap var. Önce o hesabın adını değiştirin.', 409);
      if (/UNIQUE/.test(m)) fail('Bu ekstre satırı veya ödeme emri aynı anda başka bir işlemde yazıldı; ikinci kez yazılmadı.', 409);
      throw e;
    }
    return {id: matchId, bank_line_id: line.id, provider, payment_order_id: order, matched_cents: matched,
      reported_cents: reported, difference_cents: difference, status: 'confirmed',
      clearing_account_id: clearingId, clearing_account_name: clearing ? clearing.name : clearingName(provider),
      clearing_account_created: !clearing, account_name: line.account_name,
      clearing_balance_cents: await balance(db, clearingId), account_balance_cents: await balance(db, line.account_id),
      notice: 'Para ' + line.account_name + ' hesabına girdi. Ana Kasa etkilenmedi. ' + BALANCE_NOTE};
  }

  /* ---------- geri alma: ters kayıt, ham ekstre satırı SİLİNMEZ ---------- */
  const geri = sub.match(/^\/([\w-]{1,100})\/reverse$/);
  if (geri && method === 'POST') {
    const x = await readBody(request);
    const reason = note(x.reason, 2000);
    if (!reason) fail('Geri alma nedenini yazın.');
    const match = await db.prepare('SELECT m.*,l.account_id FROM bank_matches m JOIN bank_lines l ON l.id=m.bank_line_id WHERE m.id=?').bind(key(geri[1])).first();
    if (!match) fail('Eşleştirme bulunamadı.', 404);
    if (match.status !== 'confirmed') fail('Bu eşleştirme zaten geri alınmış.', 409);
    const bacaklar = [match.clearing_in_id, match.transfer_out_id, match.transfer_in_id];
    const tersi = await db.prepare('SELECT COUNT(*) n FROM cash_transactions WHERE reversal_of IN (?,?,?)').bind(...bacaklar).first();
    if (tersi.n) fail('Bu eşleştirmenin kasa hareketlerinden biri defterden ayrıca geri alınmış; buradan ters kayıt yazılmaz. Kasa ve banka ekranından inceleyin.', 409);
    const gun = x.occurred_on === undefined || x.occurred_on === null || x.occurred_on === '' ? bugunTR() : day(x.occurred_on);
    const ters = (asil, account, amount, reference) =>
      db.prepare('INSERT INTO cash_transactions(id,account_id,party_entry_id,amount_cents,occurred_on,reference,description,reversal_of) VALUES(?,?,NULL,?,?,?,?,?)')
        .bind(uuid(), account, -amount, gun, reference, 'Hakediş eşleştirmesi geri alındı · ' + reason, asil);
    await db.batch([
      ters(match.clearing_in_id, match.clearing_account_id, match.matched_cents, 'HAKEDIS-IPTAL-' + match.id),
      ters(match.transfer_out_id, match.clearing_account_id, -match.matched_cents, 'HAKEDIS-IPTAL-VIRMAN-C-' + match.id),
      ters(match.transfer_in_id, match.account_id, match.matched_cents, 'HAKEDIS-IPTAL-VIRMAN-B-' + match.id),
      db.prepare("UPDATE bank_matches SET status='reversed',reversed_at=?,reversal_reason=? WHERE id=? AND status='confirmed'").bind(gun, reason, match.id)
    ]);
    return {id: match.id, status: 'reversed', reversed_at: gun, reversal_reason: reason,
      clearing_balance_cents: await balance(db, match.clearing_account_id),
      account_balance_cents: await balance(db, match.account_id),
      notice: 'Ters kayıt yazıldı; ham ekstre satırı ve özgün hareketler defterde duruyor. Bu satır yeniden eşleştirilebilir.'};
  }

  fail('Hakediş eşleştirme işlemi bulunamadı.', 404);
}
