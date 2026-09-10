import {buildStatement, counterpartyDifference, statementFingerprint} from '../public/party-statement.js';

// Cari ekstresi. Kesinti eşleştirmesinden (reconciliation-api.js) ayrı bir işlevdir.
// Ekstre dönemin TAMAMINI kapsar; cari listesindeki sayfalama burada geçerli değildir.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const day = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value) fail('Tarih geçersiz.');
  return value;
};

// Güvenli üst sınır: bunun üzerinde belge üretmek yerine dönemi daraltmak istenir.
const MAX_ROWS = 20000;

export async function partyStatementApi(request, env, path) {
  if (path !== '/api/statement' || request.method !== 'GET') return null;
  if (!['ec', 'lp'].includes(env.WORKSPACE)) fail('Çalışma alanı geçersiz.', 403);

  const db = env.DB, url = new URL(request.url);
  const party = url.searchParams.get('party_id') || '';
  if (!/^[\w-]{1,100}$/.test(party)) fail('Cari hesabı seçin.');
  const from = day(url.searchParams.get('from') || ''), to = day(url.searchParams.get('to') || '');
  if (from > to) fail('Başlangıç tarihi bitişten sonra olamaz.');

  const card = await db.prepare('SELECT id,name,tax_id,contact,kind FROM suppliers WHERE id=?').bind(party).first();
  if (!card) fail('Cari bu çalışma alanında bulunamadı.', 404);

  // Devir için dönem öncesi hareketler de gerekir; bu yüzden bitişe kadar olan her şey alınır.
  const entries = (await db.prepare(
    'SELECT id,amount_cents,occurred_on,due_on,reference,description,source,reversal_of,created_at ' +
    'FROM party_entries WHERE party_id=? AND occurred_on<=? ORDER BY occurred_on,created_at,id LIMIT ?'
  ).bind(party, to, MAX_ROWS + 1).all()).results;
  if (entries.length > MAX_ROWS) fail('Bu cari için ' + MAX_ROWS + '’den fazla hareket var. Dönemi daraltın.', 409);

  const allocations = (await db.prepare(
    'SELECT a.id,a.positive_entry_id,a.negative_entry_id,a.amount_cents,' +
    '(SELECT r.id FROM allocation_reversals r WHERE r.allocation_id=a.id) reversed_by ' +
    'FROM payment_allocations a JOIN party_entries p ON p.id=a.positive_entry_id WHERE p.party_id=?'
  ).bind(party).all()).results;

  const statement = buildStatement({entries, allocations, from, to});
  return {
    party: card,
    workspace: env.WORKSPACE,
    statement,
    fingerprint: statementFingerprint(statement),
    // Bildirim yoksa fark bilinmiyordur; sıfır değildir.
    difference: counterpartyDifference({closing_cents: statement.closing_cents, reported_cents: null}),
    as_of: new Date().toISOString(),
    notice: 'Tutarlar TRY’dir ve yalnızca kaydedilmiş hareketleri içerir. Pozitif bakiye bizim alacağımız, negatif bakiye bizim borcumuzdur. Bu belge resmî fatura değildir.'
  };
}
