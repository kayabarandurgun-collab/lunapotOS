import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {headerSignature} from '../public/report-core.js';

// PAZARYERİ RAPORA SÜTUN EKLEYİNCE EŞLEŞTİRME SIFIRLANMAMALI.
// Gerçek olay (27.09.2026): Trendyol sipariş raporuna "Tedarik Süresi Durumu" sütununu ekledi.
// 56 sütunun 56'sı yerindeydi, dosya 57 sütun oldu; imza birebir tutmadığı için kayıtlı eşleştirme
// bulunamadı ve toplu yükleme dosyayı "ilk kez görülen biçim" diye atladı.
// Kural: eşleştirmede KULLANILAN sütunların hepsi dosyada duruyorsa kayıtlı biçim kullanılır.
// Sütun EKSİLDİYSE kullanılmaz — orada susmak alanı boş okuyup sessizce yanlış veri yazmak olurdu.

const COLUMNS = ['Sipariş No', 'Paket No', 'Kalem No', 'Barkod', 'Ürün', 'Adet', 'Durum', 'Sipariş Tarihi', 'Tutar', 'Kargo', 'Teslim Tarihi'];
const MAPPING = {order_no: 'Sipariş No', package_id: 'Paket No', line_id: 'Kalem No', barcode: 'Barkod', product_name: 'Ürün',
  quantity: 'Adet', status: 'Durum', order_date: 'Sipariş Tarihi', gross: 'Tutar', cargo_package: 'Kargo', delivered_date: 'Teslim Tarihi'};

const ara = (f, headers) => f.req('/ec/reports/profiles?provider=trendyol&kind=orders&signature=' + encodeURIComponent(headerSignature(headers)));

async function fixture() {
  const f = appFixture();
  await f.setup();
  await f.ok('/ec/reports/profiles', {provider: 'trendyol', kind: 'orders', headers: COLUMNS, mapping: MAPPING, options: {}});
  return f;
}

test('birebir aynı sütunlarda kayıtlı eşleştirme bulunur', async () => {
  const f = await fixture();
  try {
    const {data} = await ara(f, COLUMNS);
    assert.ok(data.profile, 'kayıtlı biçim bulunmalı');
    assert.equal(data.profile.mapping.order_no, 'Sipariş No');
    assert.ok(!data.profile.signature_drift, 'birebir eşleşmede sapma işareti olmamalı');
  } finally { f.close(); }
});

test('pazaryeri yeni sütun eklediğinde kayıtlı eşleştirme kullanılmaya devam eder', async () => {
  const f = await fixture();
  try {
    const {data} = await ara(f, [...COLUMNS, 'Tedarik Süresi Durumu']);
    assert.ok(data.profile, 'yalnız sütun eklendiğinde biçim yine bulunmalı');
    assert.equal(data.profile.mapping.delivered_date, 'Teslim Tarihi');
    assert.equal(data.profile.signature_drift, true, 'sütun eklendiği kullanıcıya bildirilebilsin');
  } finally { f.close(); }
});

test('eşleştirmede kullanılan sütun kaybolursa kullanıcıya yine sorulur', async () => {
  const f = await fixture();
  try {
    const {data} = await ara(f, COLUMNS.filter(h => h !== 'Teslim Tarihi'));
    assert.equal(data.profile, null, 'eksilen sütunda sessizce devam edilmemeli');
  } finally { f.close(); }
});

test('eşleştirmede kullanılmayan sütun kaybolsa da kullanıcıya sorulur', async () => {
  const f = await fixture();
  try {
    // Kural bilerek dar: "yalnız eklendi" diyebilmek için kayıtlı biçimin BÜTÜN sütunları durmalı.
    const {data} = await f.ok('/ec/reports/profiles', {provider: 'trendyol', kind: 'orders',
      headers: [...COLUMNS, 'Not'], mapping: MAPPING, options: {}}).then(() => ara(f, COLUMNS.concat('Başka')));
    assert.equal(data.profile?.signature_drift, true, 'ilk biçim hâlâ tam olarak duruyor, o kullanılır');
  } finally { f.close(); }
});

test('başka türün biçimi ödünç alınmaz', async () => {
  const f = await fixture();
  try {
    const {data} = await f.req('/ec/reports/profiles?provider=trendyol&kind=finance&signature=' + encodeURIComponent(headerSignature([...COLUMNS, 'Yeni'])));
    assert.equal(data.profile, null, 'sipariş biçimi finans raporuna uygulanmamalı');
  } finally { f.close(); }
});

test('boş imzayla biçim döndürülmez', async () => {
  const f = await fixture();
  try {
    const {data} = await f.req('/ec/reports/profiles?provider=trendyol&kind=orders&signature=');
    assert.equal(data.profile, null);
  } finally { f.close(); }
});
