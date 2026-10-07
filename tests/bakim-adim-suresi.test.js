// BAKIM TURUNUN HANGİ ADIMI BÜTÇEYİ YİYOR? Tur 50 saniyelik bütçeyi aşıyor (canlı iz: rapor
// aşaması 89,7sn) ama aşama damgası üç kaba blok veriyordu — dosya / senkron / rapor — ve 'rapor'
// ALTI işi birden sayıyordu: pazaryeri kesintisi, eşleştirme, aktarım, teslim, iade, kesinti.
// Üç devir boyunca iki TAHMİN denendi ve ikisi de ölçümde çürüdü. Bu yüzden önce ÖLÇÜM kuruldu:
// davranış değişmiyor, yalnız her adımın süresi toplanıp iz kaydına yazılıyor.
//
// Kanıtlanan: (a) her adım ayrı ayrı ölçülür ve aynı adın tekrarları TOPLANIR (iade ile kesinti
// mağaza döngüsünde iç içe geçtiği için birikimli damgayla ayrıştırılamıyorlar), (b) HATA VEREN
// adım da ölçülür, (c) özet en çok yiyenden aza sıralanır ve 0,1sn altı yazılmaz, (d) birikimli
// aşama damgaları eskisi gibi durur, (e) iz kaydı ikisini birden taşır.
//
// AĞA ÇIKILMAZ. Ölçüm testleri gerçek saat yerine SAHTE SAAT kullanır: gerçek sürelere bakan test
// yavaş makinede rastgele düşer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {otomatikBakim, adimOlcer, adimOzeti, SENKRON_KAYNAKLARI_KAPALI} from '../src/otomatik-bakim.js';

// Sahte saat: `ilerlet(ms)` ile elle yürütülür, böylece ölçülen süreler tam olarak bilinir.
function sahteSaat() {
  let t = 0;
  return {gecen: () => t, ilerlet: ms => { t += ms; }};
}
const bosOzet = () => ({adim: {}, hatalar: []});

test('Her adım kendi süresini toplar; aynı ad ikinci kez çağrılınca süre EKLENİR', async () => {
  const saat = sahteSaat(), ozet = bosOzet();
  const dene = adimOlcer(ozet, saat.gecen);

  await dene('aktarım', async () => saat.ilerlet(70000));
  // Mağaza döngüsü iade ve kesintiyi mağaza başına çağırıyor: iki mağaza = iki çağrı, tek toplam.
  await dene('iade', async () => saat.ilerlet(4000));
  await dene('kesinti', async () => saat.ilerlet(3000));
  await dene('iade', async () => saat.ilerlet(6000));
  await dene('kesinti', async () => saat.ilerlet(1000));

  assert.deepEqual({...ozet.adim}, {aktarım: 70000, iade: 10000, kesinti: 4000},
    'iade 4+6, kesinti 3+1 toplanmalı');
  assert.deepEqual(ozet.hatalar, []);
});

// BU ASIL MESELE. Bütçeyi yiyip SONRA düşen adım, tam da arandığı turda ölçümden kaçarsa ölçüm
// işe yaramaz: süre toplamı bu yüzden catch'ten SONRA yazılıyor.
test('Hata veren adım da ölçülür: süresi kaybolmaz, hata yine yutulur', async () => {
  const saat = sahteSaat(), ozet = bosOzet();
  const dene = adimOlcer(ozet, saat.gecen);

  await dene('kesinti', async () => { saat.ilerlet(42000); throw new Error('uç 500 verdi'); });
  await dene('teslim', async () => saat.ilerlet(500));

  assert.equal(ozet.adim.kesinti, 42000, 'düşen adımın süresi yazılmalı');
  assert.deepEqual(ozet.hatalar, ['kesinti: uç 500 verdi'], 'hata eskisi gibi yutulup toplanmalı');
  assert.equal(ozet.adim.teslim, 500, 'düşen adım sonrakini etkilemez');
});

test('Hata veren adımın adı HER ZAMAN ölçümde de bulunur (iz kaydı sessiz kalmasın)', async () => {
  const saat = sahteSaat(), ozet = bosOzet();
  const dene = adimOlcer(ozet, saat.gecen);
  await dene('iade', async () => { saat.ilerlet(10); throw new Error('bozuk'); });
  for (const h of ozet.hatalar)
    assert.ok(h.split(':')[0] in ozet.adim, 'hata veren adım ölçümde yok: ' + h);
});

// Özetin tek işi şu soruyu cevaplamak: "bütçeyi kim yedi?" O yüzden EN ÇOK YİYEN BAŞA yazılır.
test('Özet en çok yiyenden aza sıralanır; 0,1 saniyenin altı yazılmaz', () => {
  const metin = adimOzeti({adim: {teslim: 400, aktarım: 70100, kesinti: 12400, eşleştirme: 20}});
  assert.equal(metin, ' (aktarım 70.1sn, kesinti 12.4sn, teslim 0.4sn)');
  assert.ok(!metin.includes('eşleştirme'), '20 ms yazılmamalı: iz kaydını boş parçalar doldurur');
});

test('Hiç ölçüm yoksa özet BOŞ metin döner (iz kaydına boş parantez düşmez)', () => {
  assert.equal(adimOzeti({adim: {}}), '');
  assert.equal(adimOzeti({adim: {teslim: 20}}), '', 'yalnız eşiğin altı varsa da boş');
  assert.equal(adimOzeti({}), '', 'adim alanı hiç yoksa da çökmemeli');
});

// Gerçek tur: adların UYDURMA olmadığını, bakımın gerçekten bu adımları çağırdığını kanıtlar.
// Süre DEĞERİNE bakılmaz (testte adımlar milisaniye sürüyor), ADIN varlığına bakılır.
test('Gerçek bakım turu rapor adımlarını ayrı ayrı ölçer', async () => {
  const f = appFixture(); await f.setup(); try {
    const r = await otomatikBakim(f.env, {simdi: Date.now(), kaynaklar: SENKRON_KAYNAKLARI_KAPALI});
    assert.deepEqual(r.hatalar, [], 'tur temiz geçmeli');
    // Devir belgesinin istediği dörtlü artı aynı blokta duran iki iş.
    for (const ad of ['pazaryeri kesintisi', 'eşleştirme', 'teslim', 'maliyet'])
      assert.ok(ad in r.adim, ad + ' ölçülmeli: ' + JSON.stringify(r.adim));
    for (const [ad, ms] of Object.entries(r.adim))
      assert.ok(Number.isFinite(ms) && ms >= 0, ad + ' süresi sayı olmalı: ' + ms);
    // Birikimli aşama damgaları eskisi gibi durur: ikisi KARIŞTIRILMAZ.
    assert.ok('rapor' in r.sure && 'dosya' in r.sure, 'aşama damgaları kalmalı: ' + JSON.stringify(r.sure));
  } finally { f.close(); }
});

// Mağaza başına çağrılan aktarım/iade/kesinti ancak mağaza varken ölçülür; canlıda iki mağaza var.
test('Mağaza varsa aktarım, iade ve kesinti de ölçülür', async () => {
  const f = appFixture(); await f.setup(); try {
    await f.ok('/ec/reports/stores', {provider: 'trendyol', code: 'TY-1', name: 'Mağaza'});
    const r = await otomatikBakim(f.env, {simdi: Date.now(), kaynaklar: SENKRON_KAYNAKLARI_KAPALI});
    for (const ad of ['aktarım', 'iade', 'kesinti'])
      assert.ok(ad in r.adim, ad + ' ölçülmeli: ' + JSON.stringify(r.adim));
  } finally { f.close(); }
});
