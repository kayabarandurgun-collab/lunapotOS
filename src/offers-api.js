import {offerTotals, OFFER_PREFIX, NEXT_KIND, CLOSED_STATUS, effectiveStatus} from '../public/offer-math.js';

// Teklif / proforma / sözleşme uçları.
// Bu belgeler TİCARİ TEKLİFTİR: stok düşmez, cariye borç/alacak yazmaz, resmî fatura kesmez.
// Bu dosyada stok, defter ya da fatura tablolarına yazan TEK BİR sorgu yoktur.
// Dışarıya e-posta veya mesaj gönderilmez; belge tarayıcıda hazırlanır.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const id = () => crypto.randomUUID();
const today = () => new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const addDays = (isoDay, days) => new Date(Date.parse(isoDay + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

const day = (value, label = 'Tarih') => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value) fail(label + ' geçersiz.');
  return value;
};
const text = (value, label, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(label + ' alanını kontrol edin.');
  return value.trim();
};
const optionalText = (value, label, max = 4000) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > max) fail(label + ' alanını kontrol edin.');
  return value.trim();
};
const key = value => { if (!/^[\w-]{1,100}$/.test(value || '')) fail('Kayıt seçimi geçersiz.'); return value; };

async function partyCard(db, party) {
  const card = await db.prepare('SELECT id,name,tax_id,contact,phone,email,address,kind FROM suppliers WHERE id=?').bind(party).first();
  if (!card) fail('Cari bu çalışma alanında bulunamadı.', 404);
  return card;
}

// Belge numarası yıl ve tür bazlıdır; UNIQUE(document_no,revision) ile korunur.
async function nextDocumentNo(db, kind, year) {
  const prefix = OFFER_PREFIX[kind] + '-' + year + '-';
  const last = await db.prepare('SELECT document_no FROM offers WHERE document_no LIKE ? ORDER BY document_no DESC LIMIT 1')
    .bind(prefix + '%').first();
  const previous = last ? Number(last.document_no.slice(-4)) : 0;
  if (!Number.isSafeInteger(previous) || previous >= 9999) fail('Bu yıl için belge numarası tükendi.', 409);
  return prefix + String(previous + 1).padStart(4, '0');
}

// snapshot_json ham metin olarak dönmez: metnin içindeki tutarlar yetki süzgecinden geçemez.
const present = (row, extra = {}) => {
  const {snapshot_json, ...rest} = row;
  return {...rest, snapshot: JSON.parse(snapshot_json), effective_status: effectiveStatus(row, today()), ...extra};
};

function readContent(input, kind) {
  const lines = Array.isArray(input.lines) ? input.lines : fail('Belge satırlarını gönderin.');
  const totals = (() => { try { return offerTotals(lines); } catch (error) { fail(error.message); } })();
  const issue = day(input.issue_date, 'Belge tarihi');
  let validUntil = null;
  if (kind === 'contract') {
    if (input.valid_until) fail('Sözleşmede geçerlilik günü bulunmaz.');
  } else {
    validUntil = day(input.valid_until, 'Geçerlilik tarihi');
    if (validUntil < issue) fail('Geçerlilik tarihi belge tarihinden önce olamaz.');
  }
  return {
    title: text(input.title, 'Belge başlığı', 200),
    issue_date: issue,
    valid_until: validUntil,
    terms: optionalText(input.terms, 'Koşullar'),
    totals
  };
}

const snapshotOf = (card, workspace, kind, content) => ({
  party: card, workspace, kind,
  title: content.title, issue_date: content.issue_date, valid_until: content.valid_until, terms: content.terms,
  currency: 'TRY', totals: content.totals,
  notice: 'Bu belge bir ticari tekliftir; resmî fatura değildir. İndirilmesi, yazdırılması veya iletilmesi kabul ya da imza anlamına gelmez.'
});

// Aynı kaynak her uçtan AYNI şekilde döner. Aksi hâlde kaydettikten sonra dönen
// nesnede zincir alanları eksik kalır ve ekran onları okurken patlar.
async function detail(db, row, workspace) {
  const successor = await db.prepare('SELECT id,revision FROM offers WHERE supersedes=?').bind(row.id).first();
  const derived = (await db.prepare(`SELECT ${COLUMNS} FROM offers WHERE source_offer_id=?`).bind(row.id).all()).results;
  const origin = row.source_offer_id
    ? await db.prepare(`SELECT ${COLUMNS} FROM offers WHERE id=?`).bind(row.source_offer_id).first()
    : null;
  return present(row, {
    workspace, party: await partyCard(db, row.party_id),
    superseded_by: successor || null, derived, origin, next_kind: NEXT_KIND[row.kind] || null
  });
}

const COLUMNS = 'id,kind,party_id,document_no,revision,supersedes,source_offer_id,title,issue_date,valid_until,terms,' +
  'gross_cents,discount_cents,net_cents,vat_cents,total_cents,line_count,status,status_note,sent_at,decided_at,' +
  'created_by_name,created_at,status_changed_at';

async function insert(db, row) {
  try {
    await db.prepare(
      'INSERT INTO offers(id,kind,party_id,document_no,revision,supersedes,source_offer_id,title,issue_date,valid_until,' +
      'terms,gross_cents,discount_cents,net_cents,vat_cents,total_cents,line_count,snapshot_json,created_by,created_by_name) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(row.id, row.kind, row.party_id, row.document_no, row.revision, row.supersedes, row.source_offer_id,
      row.title, row.issue_date, row.valid_until, row.terms, row.gross_cents, row.discount_cents, row.net_cents,
      row.vat_cents, row.total_cents, row.line_count, row.snapshot_json, row.created_by, row.created_by_name).run();
  } catch (error) {
    const message = String(error.message);
    if (/OFFER_CHAIN/.test(message)) fail('Bu belge zinciri kurulamaz. Kaynak belge kabul edilmiş olmalı.', 409);
    if (/OFFER_REVISION/.test(message)) fail('Revizyon sırası geçersiz.', 409);
    if (/UNIQUE constraint failed: \w+_offers\.source_offer_id/.test(message))
      fail('Bu belgeden zaten aynı türde bir belge üretilmiş. Aynı iş iki kez belgelenemez.', 409);
    if (/UNIQUE constraint/.test(message)) fail('Aynı anda başka bir belge oluşturuldu. Tekrar deneyin.', 409);
    throw error;
  }
}

export async function offersApi(request, env, path, readBody) {
  if (!path.startsWith('/api/offers')) return null;
  if (!['ec', 'lp'].includes(env.WORKSPACE)) fail('Çalışma alanı geçersiz.', 403);
  const db = env.DB, method = request.method, url = new URL(request.url);
  const user = env.USER || {};
  const sub = path.slice('/api/offers'.length);

  if (sub === '' && method === 'GET') {
    const kind = url.searchParams.get('kind') || '';
    if (kind && !OFFER_PREFIX[kind]) fail('Belge türü geçersiz.');
    const party = url.searchParams.get('party_id') || '';
    if (party) await partyCard(db, party);
    const terms = [], args = [];
    if (kind) { terms.push('o.kind=?'); args.push(kind); }
    if (party) { terms.push('o.party_id=?'); args.push(party); }
    const where = terms.length ? ' WHERE ' + terms.join(' AND ') : '';
    const rows = (await db.prepare(
      `SELECT ${COLUMNS.split(',').map(c => 'o.' + c).join(',')},s.name party_name FROM active_offers o ` +
      `JOIN suppliers s ON s.id=o.party_id${where} ORDER BY o.created_at DESC,o.document_no DESC LIMIT 300`
    ).bind(...args).all()).results;
    const now = today();
    return {
      workspace: env.WORKSPACE,
      offers: rows.map(row => ({...row, effective_status: effectiveStatus(row, now)})),
      as_of: now
    };
  }

  const single = sub.match(/^\/([\w-]{1,100})$/);
  if (single && method === 'GET') {
    const row = await db.prepare('SELECT * FROM offers WHERE id=?').bind(single[1]).first();
    if (!row) fail('Belge bulunamadı.', 404);
    return detail(db, row, env.WORKSPACE);
  }

  if (sub === '' && method === 'POST') {
    const input = await readBody(request);
    const kind = OFFER_PREFIX[input.kind] ? input.kind : fail('Belge türü geçersiz.');
    const party = key(input.party_id);
    const card = await partyCard(db, party);
    const content = readContent(input, kind);

    let previous = null;
    if (input.supersedes) {
      previous = await db.prepare('SELECT * FROM offers WHERE id=?').bind(key(input.supersedes)).first();
      if (!previous) fail('Düzeltilecek belge bulunamadı.', 404);
      if (previous.party_id !== party || previous.kind !== kind) fail('Revizyon aynı cari ve aynı belge türü olmalı.');
      if (CLOSED_STATUS.includes(previous.status)) fail('Kapanmış belgenin revizyonu alınamaz.', 409);
      if (await db.prepare('SELECT id FROM offers WHERE supersedes=?').bind(previous.id).first())
        fail('Bu belgenin zaten bir revizyonu var.', 409);
    }
    let source = null;
    if (input.source_offer_id) {
      source = await db.prepare('SELECT * FROM offers WHERE id=?').bind(key(input.source_offer_id)).first();
      if (!source) fail('Kaynak belge bulunamadı.', 404);
      if (NEXT_KIND[source.kind] !== kind) fail('Bu belge türü kaynak belgeden türetilemez.');
      if (source.status !== 'accepted') fail('Yalnızca kabul edilmiş bir belgeden sonraki belge üretilir.', 409);
    }

    const row = {
      id: id(), kind, party_id: party,
      document_no: previous ? previous.document_no : await nextDocumentNo(db, kind, content.issue_date.slice(0, 4)),
      revision: previous ? previous.revision + 1 : 1,
      supersedes: previous ? previous.id : null,
      source_offer_id: source ? source.id : null,
      title: content.title, issue_date: content.issue_date, valid_until: content.valid_until, terms: content.terms,
      gross_cents: content.totals.gross_cents, discount_cents: content.totals.discount_cents,
      net_cents: content.totals.net_cents, vat_cents: content.totals.vat_cents, total_cents: content.totals.total_cents,
      line_count: content.totals.rows.length,
      snapshot_json: JSON.stringify(snapshotOf(card, env.WORKSPACE, kind, content)),
      created_by: user.id || '', created_by_name: user.name || 'Yönetici'
    };
    await insert(db, row);
    return detail(db, await db.prepare('SELECT * FROM offers WHERE id=?').bind(row.id).first(), env.WORKSPACE);
  }

  // Taslak düzenleme. Gönderilmiş belge burada değişmez; değişiklik için yeni revizyon alınır.
  if (single && method === 'POST') {
    const input = await readBody(request);
    const row = await db.prepare('SELECT * FROM offers WHERE id=?').bind(single[1]).first();
    if (!row) fail('Belge bulunamadı.', 404);
    if (row.status !== 'draft') fail('Gönderilmiş belge değiştirilemez. Yeni revizyon alın.', 409);
    if (await db.prepare('SELECT id FROM offers WHERE supersedes=?').bind(row.id).first())
      fail('Bu belgenin daha yeni bir revizyonu var.', 409);
    const card = await partyCard(db, row.party_id);
    const content = readContent(input, row.kind);
    try {
      await db.prepare(
        'UPDATE offers SET title=?,issue_date=?,valid_until=?,terms=?,gross_cents=?,discount_cents=?,net_cents=?,' +
        'vat_cents=?,total_cents=?,line_count=?,snapshot_json=? WHERE id=?'
      ).bind(content.title, content.issue_date, content.valid_until, content.terms, content.totals.gross_cents,
        content.totals.discount_cents, content.totals.net_cents, content.totals.vat_cents, content.totals.total_cents,
        content.totals.rows.length, JSON.stringify(snapshotOf(card, env.WORKSPACE, row.kind, content)), row.id).run();
    } catch (error) {
      const message = String(error.message);
      if (/OFFER_SENT_IMMUTABLE|OFFER_CLOSED|OFFER_SUPERSEDED/.test(message))
        fail('Bu belge artık değiştirilemez.', 409);
      throw error;
    }
    return detail(db, await db.prepare('SELECT * FROM offers WHERE id=?').bind(row.id).first(), env.WORKSPACE);
  }

  const status = sub.match(/^\/([\w-]{1,100})\/status$/);
  if (status && method === 'POST') {
    const input = await readBody(request);
    const row = await db.prepare('SELECT * FROM offers WHERE id=?').bind(status[1]).first();
    if (!row) fail('Belge bulunamadı.', 404);
    const wanted = input.status;
    if (!['sent', 'accepted', 'rejected', 'cancelled'].includes(wanted)) fail('Belge durumu geçersiz.');
    if (CLOSED_STATUS.includes(row.status)) fail('Bu belge kapanmış; durumu değiştirilemez.', 409);
    const note = optionalText(input.note, 'Açıklama', 1000);
    if (['rejected', 'cancelled'].includes(wanted) && !note) fail('Nedenini yazmadan reddedemez ya da iptal edemezsiniz.');

    // İndirmek, yazdırmak veya iletmek kabul değildir: kabul yalnızca yanıt beklenen belgede olur.
    if (['accepted', 'rejected'].includes(wanted) && row.status !== 'sent')
      fail('Önce belgeyi "karşı tarafa iletildi" olarak işaretleyin. İndirmek kabul anlamına gelmez.', 409);
    const now = today();
    if (wanted === 'accepted' && effectiveStatus(row, now) === 'expired')
      fail('Bu belgenin geçerlilik süresi dolmuş. Yeni revizyon alıp yeniden iletin.', 409);

    const stamp = new Date().toISOString();
    try {
      await db.prepare(
        'UPDATE offers SET status=?,status_note=?,sent_at=COALESCE(sent_at,?),decided_at=?,status_changed_by=?,status_changed_at=? WHERE id=?'
      ).bind(wanted, note, wanted === 'sent' ? stamp : row.sent_at, ['accepted', 'rejected'].includes(wanted) ? stamp : row.decided_at,
        user.id || '', stamp, row.id).run();
    } catch (error) {
      const message = String(error.message);
      if (/OFFER_NOT_SENT/.test(message)) fail('Bu belge yanıt beklemiyor.', 409);
      if (/OFFER_CLOSED|OFFER_STATUS/.test(message)) fail('Bu durum değişikliğine izin verilmiyor.', 409);
      if (/OFFER_SUPERSEDED/.test(message)) fail('Bu belgenin daha yeni bir revizyonu var.', 409);
      if (/CHECK constraint/.test(message)) fail('Belge durumu bu bilgilerle kaydedilemez.', 409);
      throw error;
    }
    return detail(db, await db.prepare('SELECT * FROM offers WHERE id=?').bind(row.id).first(), env.WORKSPACE);
  }

  // Kabul edilmiş belgeden sonraki belgeyi satırları yeniden yazmadan hazırlar.
  const convert = sub.match(/^\/([\w-]{1,100})\/convert$/);
  if (convert && method === 'POST') {
    const input = await readBody(request);
    const source = await db.prepare('SELECT * FROM offers WHERE id=?').bind(convert[1]).first();
    if (!source) fail('Belge bulunamadı.', 404);
    const kind = NEXT_KIND[source.kind];
    if (!kind) fail('Sözleşmeden yeni belge türetilmez.');
    if (source.status !== 'accepted') fail('Önce bu belge kabul edilmiş olmalı.', 409);
    if (await db.prepare('SELECT id FROM offers WHERE source_offer_id=? AND kind=?').bind(source.id, kind).first())
      fail('Bu belgeden zaten aynı türde bir belge üretilmiş. Aynı iş iki kez belgelenemez.', 409);

    const snapshot = JSON.parse(source.snapshot_json);
    const card = await partyCard(db, source.party_id);
    const issue = input.issue_date ? day(input.issue_date, 'Belge tarihi') : today();
    const content = readContent({
      title: input.title || snapshot.title,
      issue_date: issue,
      // Aynı gün biten proforma işe yaramaz; kullanıcı tarih vermediyse makul bir süre verilir.
      valid_until: kind === 'contract' ? null : (input.valid_until || addDays(issue, 30)),
      terms: input.terms === undefined ? snapshot.terms : input.terms,
      lines: snapshot.totals.rows
    }, kind);

    const row = {
      id: id(), kind, party_id: source.party_id,
      document_no: await nextDocumentNo(db, kind, content.issue_date.slice(0, 4)),
      revision: 1, supersedes: null, source_offer_id: source.id,
      title: content.title, issue_date: content.issue_date, valid_until: content.valid_until, terms: content.terms,
      gross_cents: content.totals.gross_cents, discount_cents: content.totals.discount_cents,
      net_cents: content.totals.net_cents, vat_cents: content.totals.vat_cents, total_cents: content.totals.total_cents,
      line_count: content.totals.rows.length,
      snapshot_json: JSON.stringify(snapshotOf(card, env.WORKSPACE, kind, content)),
      created_by: user.id || '', created_by_name: user.name || 'Yönetici'
    };
    await insert(db, row);
    return detail(db, await db.prepare('SELECT * FROM offers WHERE id=?').bind(row.id).first(), env.WORKSPACE);
  }

  fail('İstek bulunamadı.', 404);
}
