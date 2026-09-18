// Kullanıcı yalnız mağazayı seçer; raporun sipariş mi finans mı olduğu sütunlardan anlaşılır.
// Başlıklar gerçek Trendyol / Hepsiburada dökümlerinin sütun adlarıdır (müşteri verisi yok).
import test from 'node:test';
import assert from 'node:assert/strict';
import {detectReportKind, headerSignature} from '../public/report-core.js';

const TY_ORDERS = ['Barkod', 'Paket No', 'Kargo Firması', 'Sipariş Tarihi', 'Termin Süresinin Bittiği Tarih', 'Kargoya Teslim Tarihi', 'Kargo Kodu', 'Sipariş Numarası', 'Alıcı', 'Teslimat Adresi', 'İl', 'İlçe', 'Ürün Adı', 'Fatura Adresi', 'Alıcı - Fatura Adresi', 'Sipariş Statüsü', 'E-Posta', 'Komisyon Oranı', 'Marka', 'Stok Kodu', 'Adet', 'Birim Fiyatı', 'Satış Tutarı', 'İndirim Tutarı', 'Trendyol İndirim Tutarı', 'Faturalanacak Tutar', 'Teslim Tarihi'];
const TY_FIN = ['Sipariş No', 'Sipariş Tarihi', 'Sipariş Statüsü', 'Şirket', 'Müşteri', 'Ürün Adedi', 'Sipariş Tutarı', 'İndirim', 'Komisyon/Yurt Dışı Stok Destek Bedeli', 'Gönderi Kargo Bedeli', 'İade Kargo Bedeli', 'Platform Hizmet Bedeli', 'Ceza Bedeli', 'İptal', 'İade', 'Net Tutar', 'Ödeme Yöntemi', 'Ülke'];
const HB_ORDERS = ['Sipariş Numarası', 'Paket Numarası', 'Kalem Numarası', 'Sipariş Tarihi', 'Kargo Firması', 'Kargo Takip No', 'Barkod', 'Satıcı Stok Kodu', 'Adet', 'Alıcı', 'Teslimat Adresi', 'KDV(%)', 'Komisyon Tutarı (KDV Dahil)', 'Paket Durumu', 'Teslim Tarihi'];
const HB_FIN = ['Sipariş No', 'Sipariş Durumu', 'Sipariş Tutarı, TL', 'İndirim', 'Komisyon (KDV Dahil)', 'Kargo Kesintisi, TL', 'Hizmet Bedeli', 'Tahsilat Bedeli', 'Ceza', 'İptal / İade', 'Stopaj', 'Net Tutar, TL'];

test('Kayıtlı biçim yokken sipariş ve finans raporu sütunlarından ayırt edilir', () => {
  assert.equal(detectReportKind(TY_ORDERS), 'orders');
  assert.equal(detectReportKind(TY_FIN), 'finance');
  assert.equal(detectReportKind(HB_ORDERS), 'orders');
  assert.equal(detectReportKind(HB_FIN), 'finance');
});

test('Kayıtlı biçimle birebir ya da büyük ölçüde aynı dosya o biçimin türünü alır', () => {
  const profiles = [{kind: 'finance', signature: headerSignature(TY_FIN), active: 1}];
  assert.equal(detectReportKind(TY_FIN, profiles), 'finance');
  assert.equal(detectReportKind([...TY_FIN.slice(0, 15), 'Yeni Sütun'], profiles), 'finance', 'pazaryeri bir sütun eklese de tanınır');
});

test('Ne sipariş ne finans olan dosyada tür uydurulmaz', () => {
  assert.equal(detectReportKind(['Tarih', 'Açıklama', 'Tutar']), null);
});
