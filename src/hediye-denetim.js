// HEDİYE DENETİMİ: Plus'sız mağazada hediye eşiği ödeme adımında sunucuda zorlanamıyor. Tema normal müşteriyi
// durdurur ama tasarlanmış bir ödeme bağlantısı temayı atlar. Bu yüzden her sipariş düştükten sonra denetlenir:
// mal kargoya çıkmadan ihlal yakalanır.
//
//   iptal : liste fiyatıyla bile eşik tutmuyor ya da kademe başına birden çok hediye var. Sipariş iptal, para iade.
//   uyari : liste fiyatı eşiği geçiyor, kupon düşürmüş ya da sipariş zaten kargolanmış. İyi niyetli olabilir, yalnız haber.
//
// Eşikler tema ayarından okunur; ayar okunamazsa hiçbir siparişe dokunulmaz. Hediye, satır özelliğinden değil ürünün
// etiketinden tanınır: özelliği müşteri yazabilir, etiketi yazamaz.
import {shopifyGql} from './shopify-fatura.js';
import {telegramAriza} from './telegram.js';

const IHLAL_ETIKETI = 'hediye-ihlal', HEDIYE_ETIKETI = 'hediye-urun', HARIC_ETIKETI = 'hediye-haric';
const GERI_BAKIS_MS = 3 * 86400000;
const tutar = v => Math.round(Number(v?.shopMoney?.amount ?? 0) * 100);

export function hediyeKurallari(metin) {
  const s = JSON.parse(String(metin).replace(/\/\*[\s\S]*?\*\//g, ''))?.current;
  if (!s || typeof s !== 'object') throw new Error('tema ayarı okunamadı');
  const kademeler = ['gift', 'gift2', 'gift3'].map(on => ({min: Math.round(Number(s[on + '_threshold']) * 100), handles: String(s[on + '_list'] ?? '').split(',').map(x => x.trim().split(':')[0]).filter(Boolean)}));
  if (kademeler.some(k => !Number.isFinite(k.min) || k.min <= 0)) throw new Error('hediye eşiği okunamadı');
  return {acik: s.gift_active === true, kademeler};
}

export function siparisDenetle(siparis, kurallar) {
  const satirlar = siparis.lineItems?.nodes || [];
  const hediyeler = satirlar.filter(l => l.product?.tags?.includes(HEDIYE_ETIKETI));
  if (!hediyeler.length) return null;
  const sayilan = satirlar.filter(l => !l.product?.tags?.includes(HEDIYE_ETIKETI) && !l.product?.tags?.includes(HARIC_ETIKETI));
  const net = sayilan.reduce((t, l) => t + tutar(l.discountedTotalSet), 0), liste = sayilan.reduce((t, l) => t + tutar(l.originalTotalSet), 0);
  const nedenler = [];
  let tur = null;
  const yaz = (yeni, neden) => { nedenler.push(neden); if (yeni === 'iptal' || !tur) tur = yeni; };
  if (!kurallar.acik) yaz('uyari', 'hediye kampanyası kapalıyken hediyeli sipariş');
  kurallar.kademeler.forEach(k => {
    const adet = hediyeler.filter(l => k.handles.includes(l.product.handle)).reduce((t, l) => t + l.quantity, 0);
    if (!adet) return;
    if (adet > 1) yaz('iptal', `aynı kademede ${adet} hediye`);
    if (liste < k.min) yaz('iptal', `sepet ${liste / 100} TL, hediye eşiği ${k.min / 100} TL`);
    else if (net < k.min) yaz('uyari', `kupon sonrası ${net / 100} TL, hediye eşiği ${k.min / 100} TL`);
  });
  if (hediyeler.some(l => !kurallar.kademeler.some(k => k.handles.includes(l.product.handle)))) yaz('uyari', 'hediye listesinde olmayan hediye ürünü');
  return tur ? {tur, neden: nedenler.join('; ')} : null;
}

const SIPARIS = `query($q:String!){orders(first:100,query:$q,sortKey:CREATED_AT,reverse:true){nodes{id name cancelledAt displayFulfillmentStatus lineItems(first:100){nodes{quantity originalTotalSet{shopMoney{amount}} discountedTotalSet{shopMoney{amount}} product{handle tags}}}}}}`;
const AYAR = `{themes(first:1,roles:[MAIN]){nodes{files(first:1,filenames:["config/settings_data.json"]){nodes{body{... on OnlineStoreThemeFileBodyText{content}}}}}}}`;

export async function hediyeDenetim(env, {fetcher = fetch, simdi = Date.now()} = {}) {
  if (!env.SHOPIFY_FATURA_CLIENT_ID || !env.SHOPIFY_FATURA_SECRET) return {atlandi: 'baglanti_yok'};
  const sor = (q, v) => shopifyGql(env, fetcher, q, v);
  try {
    const q = `created_at:>=${new Date(simdi - GERI_BAKIS_MS).toISOString()} -tag:${IHLAL_ETIKETI} -status:cancelled`;
    const siparisler = (await sor(SIPARIS, {q})).orders.nodes.filter(o => !o.cancelledAt);
    const hediyeli = siparisler.filter(o => o.lineItems.nodes.some(l => l.product?.tags?.includes(HEDIYE_ETIKETI)));
    const ozet = {bakilan: siparisler.length, hediyeli: hediyeli.length, iptal: 0, uyari: 0};
    if (!hediyeli.length) return ozet;
    const metin = (await sor(AYAR)).themes.nodes[0]?.files?.nodes?.[0]?.body?.content;
    const kurallar = hediyeKurallari(metin);
    for (const o of hediyeli) {
      const sonuc = siparisDenetle(o, kurallar);
      if (!sonuc) continue;
      // Kargoya çıkmış sipariş otomatik iptal edilmez: iade süreci insan kararıdır.
      const iptalEt = sonuc.tur === 'iptal' && o.displayFulfillmentStatus === 'UNFULFILLED';
      let hata = '';
      if (iptalEt) {
        const c = await sor(`mutation($id:ID!,$not:String){orderCancel(orderId:$id,reason:OTHER,restock:true,notifyCustomer:true,refundMethod:{originalPaymentMethodsRefund:true},staffNote:$not){orderCancelUserErrors{message}}}`, {id: o.id, not: ('Hediye denetimi: ' + sonuc.neden).slice(0, 255)});
        hata = c.orderCancel.orderCancelUserErrors.map(e => e.message).join(' ');
      }
      // Etiket her durumda yazılır: aynı sipariş 15 dakikada bir yeniden işlenmesin.
      await sor('mutation($id:ID!,$t:[String!]!){tagsAdd(id:$id,tags:$t){userErrors{message}}}', {id: o.id, t: [IHLAL_ETIKETI]});
      iptalEt && !hata ? ozet.iptal++ : ozet.uyari++;
      const durum = iptalEt ? (hata ? `OTOMATİK İPTAL BAŞARISIZ, ELLE İPTAL EDİN (${hata}).` : 'Sipariş iptal edildi, ödeme iade edilecek.') : 'Sipariş iptal edilmedi, kargolamadan önce bakın.';
      await telegramAriza(env, `Hediye denetimi ${o.name}: ${sonuc.neden}. ${durum}`);
    }
    return ozet;
  } catch (e) {
    console.error('hediye denetimi', e.message);
    // Denetim sessizce bozulmasın, ama 15 dakikada bir de haber vermesin: günde bir.
    const s = new Date(simdi);
    if (s.getUTCHours() === 6 && s.getUTCMinutes() < 15) await telegramAriza(env, 'Hediye denetimi çalışamıyor: ' + e.message);
    return {hata: e.message};
  }
}
