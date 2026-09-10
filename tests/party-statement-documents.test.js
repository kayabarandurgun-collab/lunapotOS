import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

// Ocak dönemi: devir 30.000, dönem içi +30.000 / -12.500, kapanış 47.500.
async function ledgerFixture() {
  const f = appFixture(); await f.setup();
  const party = await f.ok('/ec/ledger/parties', {name: 'Şişli Çiçekçilik Ltd. Şti.', kind: 'customer', tax_id: '1234567890', contact: 'muhasebe@ornek.test'});
  const insert = f.sqlite.prepare('INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,due_on,reference,description,source,source_key) VALUES(?,?,?,?,?,?,?,\'manual\',?)');
  insert.run('devir1', party.id, 50000, '2025-11-10', null, 'DEV-1', 'Önceki dönem satışı', 'k1');
  insert.run('devir2', party.id, -20000, '2025-12-01', null, 'DEV-2', 'Önceki dönem tahsilatı', 'k2');
  insert.run('d1', party.id, 30000, '2026-01-05', '2026-02-05', 'F-1', 'Ocak satışı', 'k3');
  insert.run('d2', party.id, -12500, '2026-01-20', null, 'T-1', 'Ocak tahsilatı', 'k4');
  return {f, party: party.id, insert};
}

const period = party => ({party_id: party, from: '2026-01-01', to: '2026-01-31'});

test('Mutabakat belgesi numaralanır, ekstre görüntüsünü saklar ve taslak başlar', async () => {
  const {f, party} = await ledgerFixture(); try {
    const doc = await f.ok('/ec/statement/documents', period(party));
    assert.equal(doc.document_no, 'MUT-2026-0001');
    assert.equal(doc.revision, 1);
    assert.equal(doc.status, 'draft');
    assert.equal(doc.closing_cents, 47500);
    assert.equal(doc.snapshot.statement.rows.length, 2, 'belge kendi ekstre görüntüsünü taşımalı');
    assert.equal(doc.snapshot.party.name, 'Şişli Çiçekçilik Ltd. Şti.', 'karşı taraf bilgisi de dondurulmalı');
    assert.equal(doc.difference.status, 'unknown', 'bildirim yokken mutabık sayılmamalı');
    assert.equal(doc.created_by_name, 'Yönetici');

    const second = await f.ok('/ec/statement/documents', {party_id: party, from: '2026-02-01', to: '2026-02-28'});
    assert.equal(second.document_no, 'MUT-2026-0002', 'numara sırayla ilerlemeli');

    const list = await f.ok('/ec/statement/documents?party_id=' + party);
    assert.deepEqual(list.documents.map(d => d.document_no).sort(), ['MUT-2026-0001', 'MUT-2026-0002']);
    assert.ok(list.documents.every(d => d.superseded === false));
  } finally { f.close(); }
});

test('Sonradan gelen geçmiş tarihli kayıt belgeyi değiştirmez, yeni revizyon açtırır', async () => {
  const {f, party, insert} = await ledgerFixture(); try {
    const doc = await f.ok('/ec/statement/documents', period(party));

    insert.run('gec', party, 7500, '2026-01-15', null, 'F-GEC', 'Geç girilen Ocak satışı', 'k9');

    const reread = await f.ok('/ec/statement/documents/' + doc.id);
    assert.equal(reread.closing_cents, 47500, 'kaydedilmiş belge olduğu gibi kalmalı');
    assert.equal(reread.snapshot.statement.rows.length, 2);
    assert.equal(reread.ledger_changed, true, 'defterin değiştiği bildirilmeli');
    assert.equal(reread.ledger_now.closing_cents, 55000);
    assert.equal(reread.ledger_now.row_count, 3);

    const revision = await f.ok('/ec/statement/documents', {...period(party), supersedes: doc.id});
    assert.equal(revision.document_no, 'MUT-2026-0001', 'revizyon aynı belge numarasını sürdürür');
    assert.equal(revision.revision, 2);
    assert.equal(revision.closing_cents, 55000);
    assert.equal(revision.supersedes, doc.id);

    const again = await f.req('/ec/statement/documents', {...period(party), supersedes: doc.id});
    assert.equal(again.status, 409, 'aynı belgenin ikinci revizyonu açılamaz');

    const unchanged = await f.req('/ec/statement/documents', {...period(party), supersedes: revision.id});
    assert.equal(unchanged.status, 409, 'defter değişmediyse boş revizyon açılmaz');

    const old = await f.ok('/ec/statement/documents/' + doc.id);
    assert.equal(old.superseded_by.revision, 2);
  } finally { f.close(); }
});

test('Kaydedilmiş belgenin tutarları ve görüntüsü veritabanında bile değiştirilemez', async () => {
  const {f, party} = await ledgerFixture(); try {
    const doc = await f.ok('/ec/statement/documents', period(party));
    assert.throws(() => f.sqlite.exec("UPDATE ec_party_statements SET closing_cents=1 WHERE id='" + doc.id + "'"), /STATEMENT_IMMUTABLE/);
    assert.throws(() => f.sqlite.exec("UPDATE ec_party_statements SET snapshot_json='{}' WHERE id='" + doc.id + "'"), /STATEMENT_IMMUTABLE/);
    assert.throws(() => f.sqlite.exec("DELETE FROM ec_party_statements WHERE id='" + doc.id + "'"), /IMMUTABLE_LEDGER/);
    // Bildirim olmadan mutabık kaydı veritabanı düzeyinde de reddedilir.
    assert.throws(() => f.sqlite.exec("UPDATE ec_party_statements SET status='agreed' WHERE id='" + doc.id + "'"), /CHECK constraint/);
  } finally { f.close(); }
});

test('Mutabık yalnızca örtüşen bir bildirimle işaretlenir, sonrasında belge kapanır', async () => {
  const {f, party} = await ledgerFixture(); try {
    const doc = await f.ok('/ec/statement/documents', period(party));

    const bare = await f.req('/ec/statement/documents/' + doc.id + '/status', {status: 'agreed'});
    assert.equal(bare.status, 400, 'bildirim gelmeden mutabık yazılamaz');

    const wrong = await f.req('/ec/statement/documents/' + doc.id + '/status', {status: 'agreed', reported_cents: 47500, reported_perspective: 'theirs'});
    assert.equal(wrong.status, 409, 'karşı tarafın defterinde bakiye ters işaretlidir; aynı sayı mutabakat değildir');

    const sent = await f.ok('/ec/statement/documents/' + doc.id + '/status', {status: 'sent'});
    assert.equal(sent.status, 'sent');
    assert.equal(sent.difference.status, 'unknown');

    const agreed = await f.ok('/ec/statement/documents/' + doc.id + '/status', {status: 'agreed', reported_cents: -47500, reported_perspective: 'theirs', note: 'Telefonla teyit alındı.'});
    assert.equal(agreed.status, 'agreed');
    assert.equal(agreed.difference.difference_cents, 0);
    assert.ok(agreed.reported_at);

    const after = await f.req('/ec/statement/documents/' + doc.id + '/status', {status: 'disputed', reported_cents: 100, reported_perspective: 'ours', note: 'fikir değişti'});
    assert.equal(after.status, 409, 'mutabık kalınan belge yeniden açılamaz');
    const revision = await f.req('/ec/statement/documents', {...period(party), supersedes: doc.id});
    assert.equal(revision.status, 409, 'mutabık kalınan belgenin revizyonu alınamaz');
  } finally { f.close(); }
});

test('İhtilaf gerçek bir fark ve yazılı neden ister', async () => {
  const {f, party} = await ledgerFixture(); try {
    const doc = await f.ok('/ec/statement/documents', period(party));
    const matching = await f.req('/ec/statement/documents/' + doc.id + '/status', {status: 'disputed', reported_cents: -47500, reported_perspective: 'theirs', note: 'olmadı'});
    assert.equal(matching.status, 409, 'bakiyeler örtüşüyorsa ihtilaf işaretlenemez');

    const silent = await f.req('/ec/statement/documents/' + doc.id + '/status', {status: 'disputed', reported_cents: -40000, reported_perspective: 'theirs'});
    assert.equal(silent.status, 400, 'farkın nedeni yazılmadan ihtilaf kaydedilemez');

    const disputed = await f.ok('/ec/statement/documents/' + doc.id + '/status', {status: 'disputed', reported_cents: -40000, reported_perspective: 'theirs', note: 'İki tahsilat makbuzu karşı tarafa ulaşmamış.'});
    assert.equal(disputed.status, 'disputed');
    assert.equal(disputed.difference.difference_cents, 7500);
    assert.equal(disputed.reported_note, 'İki tahsilat makbuzu karşı tarafa ulaşmamış.');
  } finally { f.close(); }
});

test('Belge uçları çalışma alanına ve tutar yetkisine uyar', async () => {
  const {f, party} = await ledgerFixture(); try {
    const doc = await f.ok('/ec/statement/documents', period(party));
    assert.equal((await f.req('/lp/statement/documents/' + doc.id)).status, 404, 'ec belgesi lp alanında görünmemeli');
    assert.equal((await f.req('/lp/statement/documents', period(party))).status, 404);

    const clerk = await f.ok('/admin/users', {name: 'Cari', username: 'cari', permissions: {ec: {ledger: 'read', amounts: 'none'}, lp: {}, delete_records: false}});
    await f.req('/auth/accept-invite', {token: clerk.invite_path.split('invite=')[1], password: 'cari-personel-sifresi'});
    const login = await f.req('/auth/login', {username: 'cari', password: 'cari-personel-sifresi'});

    const read = await f.req('/ec/statement/documents/' + doc.id, undefined, login.cookie);
    assert.equal(read.status, 200);
    assert.equal(read.data.closing_cents, null, 'tutar yetkisi kapalıysa bakiye gizlenmeli');
    assert.equal(read.data.snapshot.statement.closing_cents, null, 'saklanan görüntüdeki tutarlar da gizlenmeli');
    assert.equal(read.data.snapshot.statement.rows[0].occurred_on, '2026-01-05', 'tarih ve açıklama görünmeye devam etmeli');
    assert.equal(read.data.snapshot_json, undefined, 'ham JSON metni yanıtta bulunmamalı');

    const readOnly = await f.req('/ec/statement/documents', period(party), login.cookie);
    assert.equal(readOnly.status, 403, 'yalnızca görüntüleme yetkisi olan belge oluşturamamalı');

    const officer = await f.ok('/admin/users', {name: 'Cari sorumlusu', username: 'sorumlu', permissions: {ec: {ledger: 'write'}, lp: {}, delete_records: false}});
    await f.req('/auth/accept-invite', {token: officer.invite_path.split('invite=')[1], password: 'sorumlu-personel-sifresi'});
    const officerLogin = await f.req('/auth/login', {username: 'sorumlu', password: 'sorumlu-personel-sifresi'});
    const write = await f.req('/ec/statement/documents', {party_id: party, from: '2026-03-01', to: '2026-03-31'}, officerLogin.cookie);
    assert.equal(write.status, 200, 'yazma yetkisi olan cari sorumlusu belge oluşturabilmeli');
    assert.equal(write.data.created_by_name, 'Cari sorumlusu', 'belgeyi kimin oluşturduğu kayda geçmeli');
  } finally { f.close(); }
});
