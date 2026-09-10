import {buildStatement, counterpartyDifference, statementFingerprint} from '../public/party-statement.js';

// Cari ekstresi ve mutabakat belgesi.
// Kesinti eşleştirmesinden (reconciliation-api.js) ayrı bir işlevdir.
// Ekstre dönemin TAMAMINI kapsar; cari listesindeki sayfalama burada geçerli değildir.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const id = () => crypto.randomUUID();
const day = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value) fail('Tarih geçersiz.');
  return value;
};
const party = value => {
  if (!/^[\w-]{1,100}$/.test(value || '')) fail('Cari hesabı seçin.');
  return value;
};

// Güvenli üst sınır: bunun üzerinde belge üretmek yerine dönemi daraltmak istenir.
const MAX_ROWS = 20000;
// Kaydedilen belge tek satırda saklandığı için ekrandakinden daha dar tutulur.
const MAX_DOCUMENT_ROWS = 5000;
const NOTICE = 'Tutarlar TRY’dir ve yalnızca kaydedilmiş hareketleri içerir. Pozitif bakiye bizim alacağımız, negatif bakiye bizim borcumuzdur. Bu belge resmî fatura değildir.';

async function partyCard(db, key) {
  const card = await db.prepare('SELECT id,name,tax_id,contact,kind FROM suppliers WHERE id=?').bind(key).first();
  if (!card) fail('Cari bu çalışma alanında bulunamadı.', 404);
  return card;
}

// Dönem sonuna kadar olan HER hareket alınır: devir dönem öncesinden hesaplanır.
async function compute(db, key, from, to) {
  const entries = (await db.prepare(
    'SELECT id,amount_cents,occurred_on,due_on,reference,description,source,reversal_of,created_at ' +
    'FROM party_entries WHERE party_id=? AND occurred_on<=? ORDER BY occurred_on,created_at,id LIMIT ?'
  ).bind(key, to, MAX_ROWS + 1).all()).results;
  if (entries.length > MAX_ROWS) fail('Bu cari için ' + MAX_ROWS + '’den fazla hareket var. Dönemi daraltın.', 409);

  const allocations = (await db.prepare(
    'SELECT a.id,a.positive_entry_id,a.negative_entry_id,a.amount_cents,' +
    '(SELECT r.id FROM allocation_reversals r WHERE r.allocation_id=a.id) reversed_by ' +
    'FROM payment_allocations a JOIN party_entries p ON p.id=a.positive_entry_id WHERE p.party_id=?'
  ).bind(key).all()).results;

  return buildStatement({entries, allocations, from, to});
}

// Belge numarası yıl bazlıdır ve UNIQUE(document_no,revision) ile korunur.
async function nextDocumentNo(db, year) {
  const last = await db.prepare(
    'SELECT document_no FROM party_statements WHERE document_no LIKE ? ORDER BY document_no DESC LIMIT 1'
  ).bind('MUT-' + year + '-%').first();
  const previous = last ? Number(last.document_no.slice(-4)) : 0;
  if (!Number.isSafeInteger(previous) || previous >= 9999) fail('Bu yıl için belge numarası tükendi.', 409);
  return 'MUT-' + year + '-' + String(previous + 1).padStart(4, '0');
}

const difference = row => counterpartyDifference({
  closing_cents: row.closing_cents,
  reported_cents: row.reported_cents === undefined ? null : row.reported_cents,
  perspective: row.reported_perspective || 'theirs'
});

// snapshot_json ASLA ham metin olarak dönmez: metnin içindeki tutarlar
// yetki süzgecinden (scrubAmounts) geçemez, ayrıştırılmış nesne geçer.
const present = (row, extra = {}) => {
  const {snapshot_json, ...rest} = row;
  return {...rest, snapshot: JSON.parse(snapshot_json), difference: difference(row), notice: NOTICE, ...extra};
};

export async function partyStatementApi(request, env, path, readBody) {
  if (!path.startsWith('/api/statement')) return null;
  if (!['ec', 'lp'].includes(env.WORKSPACE)) fail('Çalışma alanı geçersiz.', 403);
  const db = env.DB, method = request.method, url = new URL(request.url);
  const user = env.USER || {};
  const sub = path.slice('/api/statement'.length);

  if (sub === '' && method === 'GET') {
    const key = party(url.searchParams.get('party_id'));
    const from = day(url.searchParams.get('from') || ''), to = day(url.searchParams.get('to') || '');
    if (from > to) fail('Başlangıç tarihi bitişten sonra olamaz.');
    const card = await partyCard(db, key);
    const statement = await compute(db, key, from, to);
    return {
      party: card, workspace: env.WORKSPACE, statement,
      fingerprint: statementFingerprint(statement),
      // Bildirim yoksa fark bilinmiyordur; sıfır değildir.
      difference: counterpartyDifference({closing_cents: statement.closing_cents, reported_cents: null}),
      as_of: new Date().toISOString(), notice: NOTICE
    };
  }

  if (sub === '/documents' && method === 'GET') {
    const key = party(url.searchParams.get('party_id'));
    await partyCard(db, key);
    const rows = (await db.prepare(
      'SELECT id,document_no,revision,period_from,period_to,opening_cents,debit_cents,credit_cents,closing_cents,' +
      'row_count,status,reported_cents,reported_perspective,reported_note,reported_at,supersedes,created_by_name,created_at ' +
      'FROM party_statements WHERE party_id=? ORDER BY created_at DESC,document_no DESC,revision DESC LIMIT 500'
    ).bind(key).all()).results;
    const superseded = new Set(rows.map(r => r.supersedes).filter(Boolean));
    return {
      workspace: env.WORKSPACE,
      documents: rows.map(r => ({...r, superseded: superseded.has(r.id), difference: difference(r)})),
      notice: NOTICE
    };
  }

  const single = sub.match(/^\/documents\/([\w-]{1,100})$/);
  if (single && method === 'GET') {
    const row = await db.prepare('SELECT * FROM party_statements WHERE id=?').bind(single[1]).first();
    if (!row) fail('Belge bulunamadı.', 404);
    const card = await partyCard(db, row.party_id);
    // Belge kaydedildikten sonra deftere geçmiş tarihli kayıt girmiş olabilir.
    // Belge DEĞİŞTİRİLMEZ; yalnızca güncel defterle arasındaki fark bildirilir.
    const live = await compute(db, row.party_id, row.period_from, row.period_to);
    const current = statementFingerprint(live);
    const successor = await db.prepare('SELECT id,revision FROM party_statements WHERE supersedes=?').bind(row.id).first();
    return present(row, {
      party: card, workspace: env.WORKSPACE, superseded_by: successor || null,
      ledger_changed: current !== row.fingerprint,
      ledger_now: current === row.fingerprint ? null : {
        fingerprint: current, opening_cents: live.opening_cents,
        closing_cents: live.closing_cents, row_count: live.row_count
      }
    });
  }

  if (sub === '/documents' && method === 'POST') {
    const input = await readBody(request);
    const key = party(input.party_id);
    const from = day(input.from), to = day(input.to);
    if (from > to) fail('Başlangıç tarihi bitişten sonra olamaz.');
    const card = await partyCard(db, key);

    let previous = null;
    if (input.supersedes !== undefined && input.supersedes !== null && input.supersedes !== '') {
      previous = await db.prepare('SELECT * FROM party_statements WHERE id=?').bind(String(input.supersedes)).first();
      if (!previous) fail('Düzeltilecek belge bulunamadı.', 404);
      if (previous.party_id !== key) fail('Revizyon aynı cariye ait olmalı.');
      if (previous.period_from !== from || previous.period_to !== to) fail('Revizyon aynı dönemi kapsamalı.');
      if (['agreed', 'cancelled'].includes(previous.status)) fail('Kapanmış belgenin revizyonu alınamaz.', 409);
      if (await db.prepare('SELECT id FROM party_statements WHERE supersedes=?').bind(previous.id).first())
        fail('Bu belgenin zaten bir revizyonu var.', 409);
    }

    const statement = await compute(db, key, from, to);
    if (statement.row_count > MAX_DOCUMENT_ROWS)
      fail('Belgeye en fazla ' + MAX_DOCUMENT_ROWS + ' hareket sığar. Dönemi daraltın.', 409);
    const fingerprint = statementFingerprint(statement);
    if (previous && previous.fingerprint === fingerprint)
      fail('Defterde bu dönem için değişiklik yok; yeni revizyon gerekmiyor.', 409);

    const documentNo = previous ? previous.document_no : await nextDocumentNo(db, to.slice(0, 4));
    const snapshot = {party: card, workspace: env.WORKSPACE, statement, notice: NOTICE, taken_at: new Date().toISOString()};
    const row = {
      id: id(), party_id: key, document_no: documentNo, revision: previous ? previous.revision + 1 : 1,
      period_from: from, period_to: to,
      opening_cents: statement.opening_cents, debit_cents: statement.debit_cents,
      credit_cents: statement.credit_cents, closing_cents: statement.closing_cents,
      row_count: statement.row_count, fingerprint, snapshot_json: JSON.stringify(snapshot),
      supersedes: previous ? previous.id : null,
      created_by: user.id || '', created_by_name: user.name || 'Yönetici'
    };
    try {
      await db.prepare(
        'INSERT INTO party_statements(id,party_id,document_no,revision,period_from,period_to,opening_cents,debit_cents,' +
        'credit_cents,closing_cents,row_count,fingerprint,snapshot_json,supersedes,created_by,created_by_name) ' +
        'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(row.id, row.party_id, row.document_no, row.revision, row.period_from, row.period_to, row.opening_cents,
        row.debit_cents, row.credit_cents, row.closing_cents, row.row_count, row.fingerprint, row.snapshot_json,
        row.supersedes, row.created_by, row.created_by_name).run();
    } catch (error) {
      const message = String(error.message);
      if (/UNIQUE constraint/.test(message)) fail('Aynı anda başka bir belge oluşturuldu. Tekrar deneyin.', 409);
      if (/STATEMENT_REVISION/.test(message)) fail('Revizyon sırası geçersiz.', 409);
      throw error;
    }
    const saved = await db.prepare('SELECT * FROM party_statements WHERE id=?').bind(row.id).first();
    return present(saved, {party: card, workspace: env.WORKSPACE, superseded_by: null, ledger_changed: false, ledger_now: null});
  }

  const status = sub.match(/^\/documents\/([\w-]{1,100})\/status$/);
  if (status && method === 'POST') {
    const input = await readBody(request);
    const row = await db.prepare('SELECT * FROM party_statements WHERE id=?').bind(status[1]).first();
    if (!row) fail('Belge bulunamadı.', 404);
    if (!['sent', 'agreed', 'disputed', 'cancelled'].includes(input.status)) fail('Belge durumu geçersiz.');
    if (['agreed', 'cancelled'].includes(row.status)) fail('Bu belge kapanmış; durumu değiştirilemez.', 409);

    let reported = row.reported_cents === undefined ? null : row.reported_cents;
    let perspective = row.reported_perspective || null;
    let note = row.reported_note || '';
    if (input.reported_cents !== undefined && input.reported_cents !== null) {
      if (!Number.isSafeInteger(input.reported_cents) || Math.abs(input.reported_cents) > 100000000000)
        fail('Bildirilen bakiye geçersiz.');
      if (!['ours', 'theirs'].includes(input.reported_perspective))
        fail('Bildirilen bakiyenin kimin defterinden geldiği seçilmeli.');
      reported = input.reported_cents;
      perspective = input.reported_perspective;
    }
    if (typeof input.note === 'string') {
      if (input.note.length > 1000) fail('Not en fazla 1000 karakter olabilir.');
      note = input.note.trim();
    }
    // Bilinmeyen sıfır değildir: bildirim gelmeden mutabakat sonucu yazılamaz.
    if (['agreed', 'disputed'].includes(input.status) && reported === null)
      fail('Karşı taraf bakiyesini bildirmeden mutabık ya da ihtilaflı işaretlenemez.');

    const outcome = counterpartyDifference({
      closing_cents: row.closing_cents, reported_cents: reported, perspective: perspective || 'theirs'
    });
    if (input.status === 'agreed' && outcome.status !== 'agreed')
      fail('Bildirilen bakiye belgedeki bakiyeyle örtüşmüyor; mutabık işaretlenemez.', 409);
    if (input.status === 'disputed' && outcome.status === 'agreed')
      fail('Bildirilen bakiye belgeyle örtüşüyor; ihtilaflı işaretlenemez.', 409);
    if (input.status === 'disputed' && !note) fail('İhtilaf için farkın nedenini yazın.');

    const stamp = new Date().toISOString();
    try {
      await db.prepare(
        'UPDATE party_statements SET status=?,reported_cents=?,reported_perspective=?,reported_note=?,reported_at=?,' +
        'status_changed_by=?,status_changed_at=? WHERE id=?'
      ).bind(input.status, reported, perspective, note, reported === null ? null : stamp,
        user.id || '', stamp, row.id).run();
    } catch (error) {
      const message = String(error.message);
      if (/STATEMENT_SUPERSEDED/.test(message)) fail('Bu belgenin daha yeni bir revizyonu var.', 409);
      if (/STATEMENT_CLOSED|STATEMENT_STATUS/.test(message)) fail('Bu durum değişikliğine izin verilmiyor.', 409);
      if (/STATEMENT_IMMUTABLE|CHECK constraint/.test(message)) fail('Belge içeriği değiştirilemez.', 409);
      throw error;
    }
    const saved = await db.prepare('SELECT * FROM party_statements WHERE id=?').bind(row.id).first();
    return present(saved, {party: await partyCard(db, row.party_id), workspace: env.WORKSPACE});
  }

  fail('İstek bulunamadı.', 404);
}
