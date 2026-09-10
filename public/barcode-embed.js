// Başka ekranlara gömülen barkod okutma kutusu. YALNIZCA üretim (lp) alanı.
//
// Okutmak burada da yalnızca ARAMADIR: kartı bulur ve ekrana "bu kartla ne yapmak
// istiyorsun" diye sorar. Stok bu kutudan değişmez; miktar değiştiren işlem her zaman
// ekranın kendi formundan, miktarı görülerek ve onaylanarak yapılır.
import {normalizeBarcode, classifyBarcode, packWording, createScanGate, BARCODE_KINDS} from './barcode.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));

export const scanBoxHtml = ({label = 'Barkod okut', hint = 'Okuyucuyu kutuya tutun ya da kodu elle yazın.'} = {}) =>
  `<form class="v2-toolbar bc-embed" data-scan-form>
     <label>${esc(label)}<input name="code" autocomplete="off" maxlength="48" placeholder="Okut veya yaz"></label>
     <button class="secondary" type="submit">Bul</button>
     <span class="muted">${esc(hint)}</span>
   </form>
   <div class="bc-embed-result" data-scan-result hidden></div>`;

/**
 * Gömülü kutuyu bağlar.
 *   onFound(link, lookup) → kart bulununca çağrılır (ör. ilgili formu açar).
 * Bilinmeyen barkod kart AÇMAZ; ekranda ne yapılacağı söylenir.
 */
export function attachScanBox(root, {namespace = 'lp', onFound, signal} = {}) {
  const gate = createScanGate(1500);
  const show = (html, tone = '') => {
    const box = root.querySelector('[data-scan-result]');
    if (!box) return;
    box.hidden = !html;
    box.className = 'bc-embed-result' + (tone ? ' ' + tone : '');
    box.innerHTML = html;
  };

  root.addEventListener('submit', async event => {
    const form = event.target.closest('form[data-scan-form]');
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    const input = form.elements.code;
    let code;
    try { code = normalizeBarcode(input.value || ''); }
    catch (error) { show('<p>' + esc(error.message) + '</p>', 'warn'); return; }
    // Elle gönderim bilinçlidir; tekrar koruması yalnızca kameraya uygulanır.
    gate.accept(code, Date.now(), true);
    input.value = '';
    input.focus();
    try {
      const response = await fetch(`/api/${namespace}/barcodes/lookup?code=${encodeURIComponent(code)}`, {signal});
      const data = await response.json();
      if (!response.ok) { show('<p>' + esc(data.error || 'Barkod okunamadı.') + '</p>', 'warn'); return; }
      const info = classifyBarcode(code);
      if (!data.found) {
        show(`<p><strong>${esc(code)}</strong> tanımlı değil. ${esc(BARCODE_KINDS[info.kind] || info.kind)}${info.gs1 ? '' : ' · GS1 değil'}</p>
              <p>Kart kendiliğinden açılmaz. Barkod ekranından var olan bir karta bağlayabilirsiniz.</p>`, 'warn');
        return;
      }
      if (!data.active) { show('<p>Bu barkod bağlantısı kapalı. Barkod ekranından yeniden açın.</p>', 'warn'); return; }
      const link = data.link;
      show(`<p><strong>${esc(link.card_name)}</strong> · ${esc(link.code)}${link.brand ? ' · ' + esc(link.brand) : ''}</p>
            <p>${esc(packWording(link, link.unit))} · Okutmak stoğu değiştirmez; miktarı aşağıdaki formda göreceksiniz.</p>`, 'ok');
      onFound?.(link, data);
    } catch (error) {
      if (error.name !== 'AbortError') show('<p>' + esc(error.message) + '</p>', 'warn');
    }
  }, {signal});
}
