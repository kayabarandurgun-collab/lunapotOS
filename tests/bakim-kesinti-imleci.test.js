// KESİNTİ TARAMASI HİÇ BİTMİYORDU. Ölçüldü (07.10.2026, canlı önizleme ucu zamanlandı):
// bir sayfa (50 sipariş) Trendyol'da 8,7 sn, Hepsiburada'da 7,0 sn; 771 + 327 siparişin tam
// taraması ~188 saniye. Tur bütçesi 50 saniye, yani tarama sona HİÇ varmıyor ve imleç her tur
// sıfırdan başladığı için aynı ilk sayfalar 15 dakikada bir yeniden okunuyordu. İki mağazanın
// ilk sayfasında yazılacak kesinti SIFIR: harcanan 51,2 saniyenin tamamı zaten yazılmış
// kesintileri yeniden kontrol etmekti.
//
// Kanıtlanan: (a) tur kaldığı imleçten SÜRER, (b) sona varınca imleç başa döner, (c) göç
// gelmemişse özellik kapalı sayılır ve tur bugünkü gibi sıfırdan çalışır, (d) başka bir
// veritabanı hatası YUTULMAZ, (e) iş başına ve mağaza başına ayrı imleç tutulur.
// Ağa çıkılmaz, para yazılmaz: bu dosya yalnız imleç sözleşmesini sınar.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {imlecOku, imlecYaz} from '../src/otomatik-bakim.js';

function kur({goc = true} = {}) {
  const sqlite = new DatabaseSync(':memory:');
  if (goc) for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const db = {prepare(sql) { return {args: [], bind(...a) { this.args = a; return this; },
    first() { return sqlite.prepare(sql).get(...this.args) || null; },
    all() { return {results: sqlite.prepare(sql).all(...this.args)}; },
    run() { return sqlite.prepare(sql).run(...this.args); }}; }};
  return {sqlite, db, close: () => sqlite.close()};
}

test('İmleç hatırlanır: tur kaldığı sayfadan sürer', async () => {
  const f = kur(); try {
    assert.equal(await imlecOku(f.db, 'kesinti:A'), 0, 'hiç yazılmamışsa baştan');
    await imlecYaz(f.db, 'kesinti:A', 150);
    assert.equal(await imlecOku(f.db, 'kesinti:A'), 150);
    await imlecYaz(f.db, 'kesinti:A', 300);
    assert.equal(await imlecOku(f.db, 'kesinti:A'), 300, 'aynı anahtar güncellenir, satır çoğalmaz');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_bakim_imleci').get().n, 1);
  } finally { f.close(); }
});

test('Sona varınca imleç başa döner: yeni kesintiler baştaki siparişlerde de olabilir', async () => {
  const f = kur(); try {
    await imlecYaz(f.db, 'kesinti:A', 750);
    await imlecYaz(f.db, 'kesinti:A', 0);
    assert.equal(await imlecOku(f.db, 'kesinti:A'), 0);
  } finally { f.close(); }
});

test('İş ve mağaza başına ayrı imleç', async () => {
  const f = kur(); try {
    await imlecYaz(f.db, 'kesinti:A', 100);
    await imlecYaz(f.db, 'kesinti:B', 50);
    assert.equal(await imlecOku(f.db, 'kesinti:A'), 100);
    assert.equal(await imlecOku(f.db, 'kesinti:B'), 50);
    assert.equal(await imlecOku(f.db, 'kesinti:C'), 0, 'bilinmeyen anahtar baştan başlar');
  } finally { f.close(); }
});

// 07.10 DERSİ: yeni tablo okuyan kod göç gelmeden yayına çıktı ve panelin yarısı 500 verdi.
// Bakım turu göç gecikse de ÇALIŞMAYA DEVAM ETMELİ; imleç yoksa bugünkü davranış geçerli.
test('Göç gelmemişse özellik KAPALI sayılır: imleç 0, yazma sessizce atlanır', async () => {
  const f = kur({goc: false}); try {
    assert.equal(await imlecOku(f.db, 'kesinti:A'), 0, 'tablo yoksa baştan başlanır');
    await imlecYaz(f.db, 'kesinti:A', 150);
    assert.equal(await imlecOku(f.db, 'kesinti:A'), 0, 'yazma çökmemeli, sessizce atlanmalı');
  } finally { f.close(); }
});

// Geniş catch REDDEDİLDİ: gerçek arıza sessiz kalırsa kimse görmez.
test('Başka bir veritabanı hatası YUTULMAZ', async () => {
  const patlak = {prepare() { return {bind() { return this; },
    first() { throw new Error('database disk image is malformed'); },
    run() { throw new Error('database disk image is malformed'); }}; }};
  await assert.rejects(() => imlecOku(patlak, 'kesinti:A'), /malformed/);
  await assert.rejects(() => imlecYaz(patlak, 'kesinti:A', 5), /malformed/);
});

test('Bozuk imleç değeri 0 sayılır, eksi yazılmaz', async () => {
  const f = kur(); try {
    await imlecYaz(f.db, 'kesinti:A', -5);
    assert.equal(await imlecOku(f.db, 'kesinti:A'), 0);
    await imlecYaz(f.db, 'kesinti:B', NaN);
    assert.equal(await imlecOku(f.db, 'kesinti:B'), 0);
  } finally { f.close(); }
});

// Tur gövdesinin imleci GERÇEKTEN kullandığı: kodun kendisi sınanır, yoksa yardımcılar doğru
// çalışsa da tur onları hiç çağırmıyor olabilir.
test('Bakım turu kesinti imlecini okuyup yazıyor', () => {
  const kaynak = readFileSync(new URL('../src/otomatik-bakim.js', import.meta.url), 'utf8');
  assert.match(kaynak, /let cursor = await imlecOku\(db, anahtar\)/, 'imleç okunmalı');
  assert.match(kaynak, /await imlecYaz\(db, anahtar, bitti \? 0 : cursor\)/, 'sona varınca başa dönmeli');
  assert.ok(!/let cursor = 0;\s*\n\s*for \(let i = 0; i < 40 && raporVakti\(\)/.test(kaynak),
    'eski "her tur sıfırdan" döngüsü kalmamalı');
});
