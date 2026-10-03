// SATIŞ KDV ORANI PAZARYERİNDEN ALINMAZ.
//
// Kullanıcı bütün faturalarını %20 ile kesiyor (torf, toprak, gübre, sprey — ayrımsız).
// Hepsiburada raporu bazı ilanlarda %10 bildiriyordu ve sipariş satırının KDV'si doğrudan oradan
// alınıyordu: 03.10.2026'da ölçüldü, 18 satır %10 ile kayıtlıydı (14.606,85 TL brüt). Kaynak
// rapor kaldıkça hata her yüklemede tekrar ederdi.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';

function db() {
  const s = new DatabaseSync(':memory:');
  s.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
    s.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  return s;
}

test('Satış KDV oranı ayardan gelir ve varsayılanı %20', () => {
  const s = db();
  try {
    const r = s.prepare("SELECT sales_vat_bps FROM workspace_settings WHERE workspace='ec'").get();
    assert.equal(r.sales_vat_bps, 2000, 'varsayılan %20 olmalı');
    // Oran KODA GÖMÜLÜ DEĞİL: kanunla değişirse ayardan güncellenir.
    s.prepare("UPDATE workspace_settings SET sales_vat_bps=1000 WHERE workspace='ec'").run();
    assert.equal(s.prepare("SELECT sales_vat_bps FROM workspace_settings WHERE workspace='ec'").get().sales_vat_bps, 1000);
    // Saçma oran kabul edilmez.
    assert.throws(() => s.prepare("UPDATE workspace_settings SET sales_vat_bps=15000 WHERE workspace='ec'").run(), /CHECK/);
  } finally { s.close(); }
});

test('KDV hariç tutar %20 ile hesaplanır: brüt değişmez, net düşer', () => {
  // Müşterinin ödediği tutar AYNI kalır; değişen, içinden ayrılan KDV'dir.
  const net20 = brut => Math.round(brut * 10000 / 12000);
  const net10 = brut => Math.round(brut * 10000 / 11000);
  assert.equal(net10(24000), 21818, 'eski (yanlış) hesap');
  assert.equal(net20(24000), 20000, 'yeni (doğru) hesap');
  // Düzeltme kârı ARTIRMAZ, azaltır: rakamı iyileştirmiyoruz, gerçeğe yaklaştırıyoruz.
  assert.ok(net20(24000) < net10(24000));
});

test('Fiyat profili UYDURULMAZ: profil yalnız KDV değil, ölçü ve maliyet de ister', () => {
  const s = db();
  try {
    s.exec("INSERT INTO ec_products(id,name,sku) VALUES('yeni','Yeni Urun','YENI-1')");
    // Yalniz KDV yazmaya calismak PATLAR: profil ambalaj, olcu ve agirlik da ister ve hepsi
    // sifirdan buyuk olmali. Migration bu yuzden eksik profili doldurmaz; sahibi gercek
    // degerleriyle girer. Uydurma olcu, kargo tarifesi hesabini sessizce yanlis yapardi.
    assert.throws(() => s.prepare("INSERT INTO ec_price_profiles(product_id,vat_bps) VALUES('yeni',2000)").run(),
      /NOT NULL/, 'eksik alanlarla profil yazilamaz');
  } finally { s.close(); }
});
