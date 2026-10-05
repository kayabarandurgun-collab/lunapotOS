// TELEGRAM BİLDİRİMİ. Paneldeki bir iş bitince kanala haber düşer. Bildirim yalnızca HABERDİR:
// hiçbir kayıt yazmaz, hiçbir sonucu değiştirmez, hiçbir işi durdurmaz. Telegram ulaşılamazsa,
// token yanlışsa ya da kanal silinmişse iş aynen sürer; hata yalnızca console'a yazılır.
//
// Secret'lar Worker ortamından (env) gelir; Worker'da process.env YOKTUR, bu yüzden env her çağrıda
// parametre olarak geçirilir. Canlı dışı ortamda (yerel geliştirme, test) secret bulunmaz: o durumda
// sessizce atlanır, uyarı bile üretmez — eksik secret bir hata değildir.
//
// parse_mode KULLANILMAZ. Mesajda dosya adı, mağaza adı gibi serbest metinler geçer; bunlardaki
// '_', '*', '[' gibi işaretler Markdown'da biçim başlatır: Telegram mesajı ya bozuk gösterir ya da
// 400 ile reddeder. Düz metinde böyle bir tuzak yok, kaçırma koduna da gerek kalmıyor.
const API = 'https://api.telegram.org/bot';
const MAX = 3500;              // Telegram sınırı 4096; başlık/kuyruk için pay bırakılır.

export async function telegramGonder(env, chatId, metin) {
  const token = env?.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId || !metin) return false;
  try {
    const cevap = await fetch(API + token + '/sendMessage', {
      method: 'POST',
      headers: {'Content-Type': 'application/json; charset=utf-8'},
      body: JSON.stringify({chat_id: chatId, text: String(metin).slice(0, MAX), disable_web_page_preview: true}),
      // Telegram yanıt vermezse istek burada asılı kalmasın: kullanıcı rapor sonucunu bekliyor.
      signal: AbortSignal.timeout(8000)
    });
    const veri = await cevap.json().catch(() => null);
    if (!veri?.ok) { console.error('Telegram bildirimi gönderilemedi:', cevap.status, veri?.description || ''); return false; }
    return true;
  } catch (e) {
    console.error('Telegram bildirimi gönderilemedi:', e?.message || e);
    return false;
  }
}

/** Normal özet kanalı (siparişler/raporlar). */
export const telegramBildir = (env, metin) => telegramGonder(env, env?.TELEGRAM_CHAT_ORDERS, metin);
/** Hata kanalı: yalnızca beklenmeyen durumlar; gündelik uyarılar buraya düşmez. */
export const telegramHata = (env, metin) => telegramGonder(env, env?.TELEGRAM_CHAT_ERRORS, metin);

/**
 * Bildirim altyapısı KURULU MU? Kurulmamışsa gönderim hiç DENENMEZ.
 * Ayrım önemlidir: telegramGonder hem "secret yok" hem "gönderim reddedildi" için false döner.
 * Arıza bildirimi bu ikisini ayırt etmek zorunda, çünkü "gönderilemedi" panele yazılacak bir
 * sorundur ama "kurulmamış" (yerel geliştirme, test) sorun DEĞİLDİR.
 */
export const telegramAcik = env => Boolean(env?.TELEGRAM_BOT_TOKEN && (env?.TELEGRAM_CHAT_ERRORS || env?.TELEGRAM_CHAT_ORDERS));

/**
 * ARIZA KANALI. Hata kanalı kuruluysa oraya, değilse ÖZET KANALINA düşer.
 * Geri dönüş bilerek var: TELEGRAM_CHAT_ERRORS ayrı bir secret ve canlıda kurulu olduğu
 * doğrulanmadı. Kurulmamışsa telegramHata sessizce false döner ve arıza haberi kaybolurdu —
 * bu iş tam o sessizliği kapatmak için yapıldı. Kurulu olan hangi kanalsa haber oraya gider.
 * Hata kanalı DENENİP reddedilirse de özet kanalı denenir: haberin gitmesi kanalın doğru
 * olmasından önemlidir. (Nadir bir durumda mesaj iki kanala da düşebilir; iki kez okunan bir
 * arıza, hiç okunmayandan iyidir.)
 */
export async function telegramAriza(env, metin) {
  if (env?.TELEGRAM_CHAT_ERRORS && await telegramGonder(env, env.TELEGRAM_CHAT_ERRORS, metin)) return true;
  return telegramGonder(env, env?.TELEGRAM_CHAT_ORDERS, metin);
}
