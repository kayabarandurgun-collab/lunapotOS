// Banka ekstresi aktarımı — YALNIZCA e-ticaret (ec) çalışma alanı.
//
//   GET  /api/ec/bank                      hesaplar, son dosyalar, özet
//   POST /api/ec/bank/accounts             {name, kind:'bank'|'cash'}
//   POST /api/ec/bank/files                {account_id, filename, sha256, size_bytes} → dosya kaydı (aynı dosya 409)
//   POST /api/ec/bank/files/:id/lines      {lines:[...]} satır partisi; aynı hareket ikinci kez yazılmaz
//   POST /api/ec/bank/files/:id/seal       {row_count} dosya kapatılır
//   GET  /api/ec/bank/lines?account_id     ekstre satırları (sayfalı)
//
// Bu uç STOK, SATIŞ, FATURA veya CARİ KAYDI OLUŞTURMAZ. Ekstre satırı ham veridir;
// hangi hakedişe denk geldiği ayrıca eşleştirilir. Böylece yanlış eşleşme defteri bozmaz.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const id = () => crypto.randomUUID();
const key = v => { if (!/^[\w-]{1,100}$/.test(v || '')) fail('Kayıt seçimi geçersiz.'); return v; };
const text = (v, label, max = 200) => { if (typeof v !== 'string' || !v.trim() || v.length > max) fail(label + ' alanını kontrol edin.'); return v.trim(); };
const opt = (v, max = 200) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const day = v => { const s = String(v || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail('Tarih GG.AA.YYYY veya YYYY-AA-GG olmalı: ' + v); return s; };
const cents = (v, label) => { if (!Number.isSafeInteger(v)) fail(label + ' tam sayı kuruş olmalı.'); return v; };
export const BANK_LINES_PER_CALL = 400;

/**
 * Hareket kimliği. Banka dekont/işlem numarası verdiyse O kullanılır — en güvenilirdir.
 * Vermediyse tarih + tutar + açıklama + bakiyeden kurulur: aynı gün aynı tutarlı iki farklı
 * hareket, bakiyeleri farklı olacağı için ayrışır. Uydurma sıra numarası EKLENMEZ;
 * gerçekten ayırt edilemeyen iki satır aynı kabul edilir ve ikincisi yazılmaz.
 */
export function bankRecordKey(line) {
  const ref = String(line.reference || '').trim();
  if (ref) return 'R:' + ref;
  return ['D:' + day(line.occurred_on), line.amount_cents, String(line.description || '').trim().toLocaleLowerCase('tr-TR').replace(/\s+/g, ' '),
    line.balance_cents === null || line.balance_cents === undefined ? '' : line.balance_cents].join('|');
}

export async function bankApi(request, env, path, readBody) {
  if (!path.startsWith('/api/bank')) return null;
  if (env.WORKSPACE !== 'ec') fail('Banka ekstresi yalnızca e-ticaret çalışma alanında kullanılır.', 403);
  const db = env.DB, method = request.method, url = new URL(request.url), sub = path.slice('/api/bank'.length);

  if (sub === '' && method === 'GET') {
    const [accounts, files] = await Promise.all([
      db.prepare("SELECT a.id,a.name,a.kind,(SELECT COUNT(*) FROM bank_lines l WHERE l.account_id=a.id) line_count," +
        "(SELECT MAX(l.occurred_on) FROM bank_lines l WHERE l.account_id=a.id) last_date," +
        "(SELECT COALESCE(SUM(l.amount_cents),0) FROM bank_lines l WHERE l.account_id=a.id) net_cents" +
        ' FROM cash_accounts a WHERE a.role IS NULL ORDER BY a.name').all(),
      db.prepare('SELECT f.id,f.account_id,f.filename,f.row_count,f.status,f.period_from,f.period_to,f.created_at,a.name account_name' +
        ' FROM bank_files f JOIN cash_accounts a ON a.id=f.account_id ORDER BY f.created_at DESC LIMIT 50').all()
    ]);
    return {accounts: accounts.results, files: files.results,
      notice: 'Ekstre aktarımı stok, satış, fatura veya cari kaydı oluşturmaz. Satırlar ham haliyle saklanır; hangi hakedişe denk geldiği ayrıca eşleştirilir.'};
  }

  if (sub === '/accounts' && method === 'POST') {
    const x = await readBody(request);
    if (!['bank', 'cash'].includes(x.kind)) fail('Hesap türü banka veya kasa olmalı.');
    const row = {id: id(), name: text(x.name, 'Hesap adı', 120), kind: x.kind};
    try { await db.prepare('INSERT INTO cash_accounts(id,name,kind) VALUES(?,?,?)').bind(row.id, row.name, row.kind).run(); }
    catch (e) { if (/UNIQUE/.test(e.message)) fail('Bu adla bir hesap zaten var.', 409); throw e; }
    return row;
  }

  if (sub === '/files' && method === 'POST') {
    const x = await readBody(request);
    const account = await db.prepare('SELECT id,name,role FROM cash_accounts WHERE id=?').bind(key(x.account_id)).first();
    if (!account) fail('Hesap bulunamadı.', 404);
    // Pazaryeri alacak hesabı (role='marketplace_clearing') bir defter hesabıdır, bankadan ekstresi
    // gelmez. Oraya ekstre yüklenirse hakediş eşleştirmesi kendi çıktısını kaynak sanardı.
    if (account.role) fail(account.name + ' bir pazaryeri alacak hesabıdır; banka ekstresi yüklenmez.', 409);
    if (!/^[0-9a-f]{64}$/.test(x.sha256 || '')) fail('Dosya özeti geçersiz.');
    if (!Number.isSafeInteger(x.size_bytes) || x.size_bytes <= 0 || x.size_bytes > 25 * 1024 * 1024) fail('Dosya boyutu geçersiz.');
    const varOlan = await db.prepare('SELECT id,filename,row_count,status FROM bank_files WHERE account_id=? AND sha256=?').bind(account.id, x.sha256).first();
    if (varOlan) return {...varOlan, duplicate: true, notice: 'Bu dosya bu hesaba daha önce yüklendi; ikinci kez işlenmez.'};
    const row = {id: id(), account_id: account.id, filename: text(x.filename, 'Dosya adı', 260), sha256: x.sha256, size_bytes: x.size_bytes};
    await db.prepare('INSERT INTO bank_files(id,account_id,filename,sha256,size_bytes) VALUES(?,?,?,?,?)')
      .bind(row.id, row.account_id, row.filename, row.sha256, row.size_bytes).run();
    return {...row, duplicate: false};
  }

  const satir = sub.match(/^\/files\/([\w-]+)\/lines$/);
  if (satir && method === 'POST') {
    const x = await readBody(request);
    const file = await db.prepare('SELECT * FROM bank_files WHERE id=?').bind(key(satir[1])).first();
    if (!file) fail('Ekstre dosyası bulunamadı.', 404);
    if (file.status === 'applied') fail('Bu dosya kapatıldı; yeni satır eklenemez.', 409);
    if (!Array.isArray(x.lines) || !x.lines.length || x.lines.length > BANK_LINES_PER_CALL) fail('Satır partisi 1 ile ' + BANK_LINES_PER_CALL + ' arasında olmalı.');
    const hazir = x.lines.map(l => {
      if (!l || typeof l !== 'object') fail('Satır okunamadı.');
      const row = {id: id(), file_id: file.id, account_id: file.account_id, occurred_on: day(l.occurred_on),
        amount_cents: cents(l.amount_cents, 'Tutar'),
        balance_cents: l.balance_cents === null || l.balance_cents === undefined ? null : cents(l.balance_cents, 'Bakiye'),
        description: opt(l.description, 500), reference: opt(l.reference, 120), counterparty: opt(l.counterparty, 200)};
      if (row.amount_cents === 0) fail('Sıfır tutarlı hareket aktarılmaz.');
      return {...row, record_key: bankRecordKey(row)};
    });
    // Aynı hareket ikinci kez yazılmaz: OR IGNORE, UNIQUE(account_id,record_key) ile birlikte çalışır.
    const before = (await db.prepare('SELECT COUNT(*) n FROM bank_lines WHERE account_id=?').bind(file.account_id).first()).n;
    await db.batch(hazir.map(r => db.prepare(
      'INSERT OR IGNORE INTO bank_lines(id,file_id,account_id,occurred_on,amount_cents,balance_cents,description,reference,counterparty,record_key) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(r.id, r.file_id, r.account_id, r.occurred_on, r.amount_cents, r.balance_cents, r.description, r.reference, r.counterparty, r.record_key)));
    const after = (await db.prepare('SELECT COUNT(*) n FROM bank_lines WHERE account_id=?').bind(file.account_id).first()).n;
    const yeni = after - before;
    return {file_id: file.id, received: hazir.length, inserted: yeni, duplicate: hazir.length - yeni};
  }

  const muhur = sub.match(/^\/files\/([\w-]+)\/seal$/);
  if (muhur && method === 'POST') {
    const file = await db.prepare('SELECT * FROM bank_files WHERE id=?').bind(key(muhur[1])).first();
    if (!file) fail('Ekstre dosyası bulunamadı.', 404);
    const özet = await db.prepare('SELECT COUNT(*) n,MIN(occurred_on) ilk,MAX(occurred_on) son FROM bank_lines WHERE file_id=?').bind(file.id).first();
    await db.prepare("UPDATE bank_files SET row_count=?,period_from=?,period_to=?,status='applied' WHERE id=?")
      .bind(özet.n, özet.ilk, özet.son, file.id).run();
    return {id: file.id, row_count: özet.n, period_from: özet.ilk, period_to: özet.son, status: 'applied'};
  }

  if (sub === '/lines' && method === 'GET') {
    const account = key(url.searchParams.get('account_id') || '');
    const page = Math.max(1, Math.min(10000, Number(url.searchParams.get('page')) || 1));
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    const where = 'account_id=?' + (q ? ' AND (instr(lower(description),lower(?))>0 OR instr(lower(reference),lower(?))>0 OR instr(lower(counterparty),lower(?))>0)' : '');
    const args = q ? [account, q, q, q] : [account];
    const [total, rows] = await Promise.all([
      db.prepare('SELECT COUNT(*) n FROM bank_lines WHERE ' + where).bind(...args).first(),
      db.prepare('SELECT * FROM bank_lines WHERE ' + where + ' ORDER BY occurred_on DESC,rowid DESC LIMIT 100 OFFSET ?').bind(...args, (page - 1) * 100).all()
    ]);
    return {lines: rows.results, total: total.n, page, page_size: 100};
  }

  fail('Banka işlemi bulunamadı.', 404);
}
