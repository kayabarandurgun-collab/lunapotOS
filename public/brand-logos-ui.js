// LOGO KÜTÜPHANESİ — kaynak tasarımın panel içindeki hâli.
//
// Kaynak: lunapot-claude-modul-guncelleme-2026-10-09/01-Logo-Kutuphanesi/logo-indir.js
// Görünüm: public/marka-logo-kutuphanesi.css (.lk-root altına hapsedilmiş)
//
// Uyarlama: global document seçicileri, DOMContentLoaded ve tek global durum
// yerine mount/unmount; bütün olaylar modül köküne AbortController ile bağlı.
//
// ONAYLI V8 GEOMETRİSİ DEĞİŞMEZ. Amblem parçaları, path'ler, radii, açılar,
// aralıklar, oranlar ve wordmark harfleri sabittir. composeSvg() bütün logoyu
// TEK eş oranlı dönüşümle ortalar; parçalar ayrı ayrı taşınmaz.
import {can} from './permissions.js';

const ASSET_ROOT = '/marka/logo-v2/';
const asset = path => ASSET_ROOT + path;
const LABELS = {yatay: 'Yatay logo', dikey: 'Dikey logo', amblem: 'Yalnız amblem', yazi: 'Yalnız yazı'};
// Renkli zemin çerçeveleri. Kaynakla aynı; manifest kendi ölçüsünü verirse o kazanır.
const FRAMES = {yatay: {width: 1600, height: 640}, dikey: {width: 1000, height: 1100},
  amblem: {width: 1000, height: 1000}, yazi: {width: 1600, height: 640}};
const PNG_SIZES = [1024, 2048, 4096];
// Serbest SVG yükleme ya da HTML çalıştırma YOK: yalnız altı haneli HEX.
const HEX = /^#[0-9A-Fa-f]{6}$/;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

export function mountBrandLogos(root, namespace) {
  if (!['ec', 'lp'].includes(namespace)) throw new Error('Çalışma alanı geçersiz.');
  const controller = new AbortController();
  const signal = controller.signal;
  const state = {
    data: null, layout: 'all', color: 'all', family: 'background',
    custom: {layout: 'yatay', hex: '#20251F', mode: 'background', bgHex: '#D5EF74', size: 2048},
    preview: 'light', svg: '', busy: false, revision: 0,
    error: '', status: 'Logo kaynağı hazırlanıyor…', contrast: false, disposed: false
  };
  const sources = new Map();
  let previewUrl = '';
  const $ = selector => root.querySelector(selector);
  const releasePreview = () => { if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = ''; } };

  const familyOf = variant => variant.family || (variant.backgroundIncluded ? 'background' : 'transparent');
  const hexOf = value => HEX.test(String(value || '').trim()) ? String(value).trim().toUpperCase() : null;
  const logoHex = () => hexOf(state.custom.hex);
  const withBackground = () => state.custom.mode === 'background';
  const bgHex = () => hexOf(state.custom.bgHex);
  const validCustom = () => logoHex() && (!withBackground() || bgHex());

  function colorHexes(variant) {
    const entry = state.data.colors.find(color => color.id === variant.colorId);
    return [variant.backgroundHex, variant.hex, ...(variant.hexes || []), entry?.hex, entry?.secondaryHex, ...(entry?.hexes || [])]
      .filter((hex, index, values) => typeof hex === 'string' && HEX.test(hex) && values.indexOf(hex) === index);
  }

  const shownVariants = () => state.data.variants.filter(variant =>
    familyOf(variant) === state.family &&
    (state.layout === 'all' || variant.layout === state.layout) &&
    (state.color === 'all' || variant.colorId === state.color));

  function colorOptions() {
    const used = new Set(state.data.variants.filter(variant =>
      familyOf(variant) === state.family && (state.layout === 'all' || variant.layout === state.layout))
      .map(variant => variant.colorId));
    if (!used.has(state.color)) state.color = 'all';
    const first = state.family === 'background' ? 'Tüm zemin ve renkler' : 'Tüm logo renkleri';
    return '<option value="all"' + (state.color === 'all' ? ' selected' : '') + '>' + first + '</option>' +
      [...used].map(id => {
        const color = state.data.colors.find(entry => entry.id === id);
        const variant = state.data.variants.find(entry => entry.colorId === id);
        return '<option value="' + esc(id) + '"' + (state.color === id ? ' selected' : '') + '>' +
          esc(color?.label || variant?.colorLabel || id) + '</option>';
      }).join('');
  }

  function cardsHtml() {
    return shownVariants().map(variant => {
      const colored = familyOf(variant) === 'background';
      const png = variant.pngs.find(item => item.width === 2048) || variant.pngs[0];
      return '<article class="logo-card" data-variant="' + esc(variant.id) + '">' +
        '<div class="logo-art" data-background="' + esc(variant.background || 'light') + '" data-layout="' +
        esc(variant.layout) + '" data-family="' + esc(familyOf(variant)) + '">' +
        '<img src="' + esc(asset(variant.svg)) + '" alt="' + esc(variant.label) + '" loading="lazy"></div>' +
        '<div class="logo-card-heading"><h3>' + esc(variant.label) + '</h3>' +
        '<span class="color-dots" aria-hidden="true">' +
        colorHexes(variant).map(hex => '<i data-hex="' + esc(hex) + '"></i>').join('') + '</span></div>' +
        '<p class="logo-card-info">' + esc(LABELS[variant.layout] || variant.layout) + ' · ' +
        (colored ? 'Arka plan dosyaya dahil' : 'Şeffaf zemin') + '</p>' +
        '<div class="card-downloads">' +
        '<a class="svg-link" href="' + esc(asset(variant.svg)) + '" download="' + esc(variant.svg.split('/').pop()) + '">SVG indir ↓</a>' +
        (png ? '<a class="png-link" href="' + esc(asset(png.path)) + '" download="' + esc(png.path.split('/').pop()) +
          '" title="' + esc(png.width + ' × ' + png.height + ' px · ' + (colored ? 'arka plan dahil' : 'şeffaf')) +
          '" aria-label="' + esc(variant.label + ', ' + (colored ? 'renkli zemin dahil' : 'şeffaf') + ', PNG indir') +
          '">PNG indir ↓</a>' : '') +
        '</div></article>';
    }).join('');
  }

  function heroFor(layout) {
    const pick = state.data.variants.find(variant =>
      familyOf(variant) === 'transparent' && variant.layout === layout && variant.colorId === 'beyaz');
    return pick || state.data.variants.find(variant => variant.layout === layout && variant.background === 'dark');
  }

  function render() {
    const data = state.data;
    const shown = shownVariants();
    const logo = logoHex(), background = withBackground() ? bgHex() : null;
    const ready = !!state.svg && validCustom() && !state.busy;
    const heroYatay = heroFor('yatay'), heroDikey = heroFor('dikey');
    const zip = data.zip ? asset(data.zip) : '';

    root.innerHTML = '<div class="lk-root">' +
      '<header class="page-header frame">' +
      '<a class="home-logo" href="/atolye/#belge-atolyesi?alan=' + namespace + '" aria-label="Belge Atölyesi">' +
      '<img src="/marka/logo-v2/Uygulama/lunapot-wordmark-dark.svg" alt="Lunapot" width="150" height="54"></a>' +
      '<span class="edition">MARKA KAYNAKLARI / 2026</span>' +
      '<nav aria-label="Sayfa bölümleri"><a href="#logolar" data-lk-jump="logolar">Hazır dosyalar</a>' +
      '<a href="#ozel-renk" data-lk-jump="ozel-renk">Kendi rengin</a></nav>' +
      (zip ? '<a class="all-download" href="' + esc(zip) + '" download="' + esc(data.zip) + '">Logo paketi <span aria-hidden="true">↓</span></a>' : '') +
      '</header>' +

      '<section class="intro frame" aria-labelledby="lk-title"><div>' +
      '<p class="eyebrow">LUNAPOT / LOGO KÜTÜPHANESİ</p>' +
      '<h1 id="lk-title">İmzan hazır.<br>Zemini de.</h1></div>' +
      '<div class="intro-note"><p>Yerleşimi, rengi ve zemini seç.<br>Gördüğün dosyayı indir.</p>' +
      '<span>Onaylı çizim. Sabit oranlar.<br>Bir SVG + bir yüksek çözünürlüklü PNG.</span></div></section>' +

      '<section class="signature-band" aria-label="Yatay ve dikey Lunapot yerleşimi"><div class="frame signature-grid">' +
      '<div class="signature-horizontal">' + (heroYatay ? '<img src="' + esc(asset(heroYatay.svg)) + '" alt="Lunapot yatay logo">' : '') + '</div>' +
      '<div class="signature-stacked">' + (heroDikey ? '<img src="' + esc(asset(heroDikey.svg)) + '" alt="Lunapot dikey logo">' : '') +
      '<span>AMBLEM ÜSTTE / YAZI ALTTA</span></div></div></section>' +

      '<section class="usage-note frame" aria-label="Hangi dosyayı kullanmalıyım">' +
      '<div><span class="usage-number">01</span><p><strong>Şeffaf logo</strong>Kendi fotoğrafının, belgenin veya tasarımının üstüne yerleştirmek için. Dosyada zemin bulunmaz.</p></div>' +
      '<div><span class="usage-number">02</span><p><strong>Renkli zeminli görsel</strong>Logo ve arka plan birlikte indirilir. Lime, antrasit ve diğer hazır renk eşleşmeleri.</p></div>' +
      '<div><span class="usage-number">03</span><p><strong>İki dosya, net seçim</strong>Günlük kullanım için 2048 px PNG. Tasarım ve baskı için her boyuta ölçeklenen SVG.</p></div></section>' +

      '<section class="library frame" id="lk-logolar" aria-labelledby="lk-library-title">' +
      '<div class="section-heading"><div><p class="eyebrow">01 / HAZIR DOSYALAR</p>' +
      '<h2 id="lk-library-title">Seç. İndir. Kullan.</h2></div>' +
      '<p>Yatay, dikey, yalnız amblem veya yalnız yazı.<br>Her dosyada aynı onaylı geometri.</p></div>' +
      '<div class="family-filters" role="group" aria-label="Dosyanın zemini">' +
      '<button type="button" data-lk-family="background" aria-pressed="' + (state.family === 'background') + '">' +
      '<span class="family-icon filled" aria-hidden="true"></span><span>Renkli zeminli görseller<small>Logo + arka plan birlikte</small></span></button>' +
      '<button type="button" data-lk-family="transparent" aria-pressed="' + (state.family === 'transparent') + '">' +
      '<span class="family-icon clear" aria-hidden="true"></span><span>Şeffaf logolar<small>Kendi tasarımının üzerine</small></span></button>' +
      '</div>' +
      '<div class="library-controls"><div class="layout-filters" role="group" aria-label="Logo yerleşimi">' +
      [['all', 'Tümü'], ...data.layouts.map(layout => [layout.id, layout.label])].map(([id, label]) =>
        '<button type="button" data-lk-layout="' + esc(id) + '" aria-pressed="' + (state.layout === id) + '">' + esc(label) + '</button>').join('') +
      '</div><label class="color-filter"><span class="sr-only">Renk seçimi</span>' +
      '<select data-lk-color>' + colorOptions() + '</select></label></div>' +
      '<p class="result-count" aria-live="polite">' + shown.length + ' seçenek · Her biri SVG + 2048 px PNG' +
      (state.family === 'transparent' ? ' · Kart zemini yalnızca önizleme' : ' · Renkli zemin indirmeye dahil') + '</p>' +
      '<div class="logo-grid">' + cardsHtml() + '</div>' +
      (shown.length ? '' : '<p class="empty-state">Bu yerleşim ve renk için hazır dosya bulunmuyor. Aşağıdan kendi rengini oluşturabilirsin.</p>') +
      '</section>' +

      '<section class="custom-section" id="lk-ozel-renk" aria-labelledby="lk-custom-title"><div class="frame custom-grid">' +
      '<div class="custom-copy"><p class="eyebrow">02 / KENDİ RENGİN</p>' +
      '<h2 id="lk-custom-title">Rengini seç.<br>Zeminini tamamla.</h2>' +
      '<p>Logo rengini ve istersen arka planını değiştir. Amblem, harfler, aralar ve oranlar aynı kalır. Önizlediğin yerleşim dosyana da uygulanır.</p>' +
      '<form data-lk-form novalidate>' +
      '<label class="field-label" for="lk-layout">Yerleşim</label>' +
      '<select id="lk-layout" data-lk-custom="layout">' + data.layouts.map(layout =>
        '<option value="' + esc(layout.id) + '"' + (state.custom.layout === layout.id ? ' selected' : '') + '>' +
        esc(layout.label) + '</option>').join('') + '</select>' +
      '<label class="field-label" for="lk-hex">Logo rengi</label><div class="color-input-row">' +
      '<input type="color" data-lk-custom="picker" value="' + esc(logo || '#20251F') + '" aria-label="Logo rengini seç">' +
      '<input type="text" id="lk-hex" data-lk-custom="hex" value="' + esc(state.custom.hex) + '" maxlength="7" spellcheck="false" ' +
      'autocomplete="off" aria-invalid="' + (!logo) + '" aria-describedby="lk-color-hint"></div>' +
      '<p class="field-hint" id="lk-color-hint">Altı haneli HEX kodu kullan: #20251F</p>' +
      '<label class="field-label" for="lk-mode">Dosyanın zemini</label>' +
      '<select id="lk-mode" data-lk-custom="mode">' +
      '<option value="background"' + (withBackground() ? ' selected' : '') + '>Renkli zemin — dosyaya dahil</option>' +
      '<option value="transparent"' + (withBackground() ? '' : ' selected') + '>Şeffaf — zemin yok</option></select>' +
      '<div' + (withBackground() ? '' : ' hidden') + '>' +
      '<label class="field-label" for="lk-bg-hex">Arka plan rengi</label><div class="color-input-row">' +
      '<input type="color" data-lk-custom="bgpicker" value="' + esc(background || '#D5EF74') + '" aria-label="Arka plan rengini seç">' +
      '<input type="text" id="lk-bg-hex" data-lk-custom="bghex" value="' + esc(state.custom.bgHex) + '" maxlength="7" ' +
      'spellcheck="false" autocomplete="off" aria-invalid="' + (withBackground() && !background) + '"></div>' +
      '<p class="field-hint">Bu renk SVG ve PNG dosyasının içine eklenir.</p></div>' +
      (state.error ? '<p class="custom-error" role="alert">' + esc(state.error) + '</p>' : '') +
      (state.contrast ? '<p class="field-hint contrast-hint">Logo ile arka plan rengi çok yakın. Daha belirgin bir eşleşme seçebilirsin.</p>' : '') +
      '<details class="advanced-options"><summary>PNG boyutunu değiştir <span>Standart: 2048 px</span></summary>' +
      '<label class="field-label" for="lk-size">PNG genişliği</label><select id="lk-size" data-lk-custom="size">' +
      PNG_SIZES.map(size => '<option value="' + size + '"' + (state.custom.size === size ? ' selected' : '') + '>' +
        size + ' px' + (size === 2048 ? ' — standart' : '') + '</option>').join('') + '</select>' +
      '<p class="field-hint">Hazır pakette her görselin yalnızca 2048 px sürümü var. Burada gerektiğinde başka boyut seçebilirsin.</p></details>' +
      '<div class="custom-actions">' +
      '<button type="button" data-lk-download="svg"' + (ready ? '' : ' disabled') + '>SVG indir <span aria-hidden="true">↓</span></button>' +
      '<button type="button" data-lk-download="png"' + (ready ? '' : ' disabled') + '>PNG indir <span aria-hidden="true">↓</span></button></div>' +
      '<p class="field-hint" aria-live="polite" data-lk-status>' + esc(state.status) + '</p>' +
      '</form></div>' +
      '<div class="custom-preview" data-background="' + esc(state.preview) + '" data-mode="' + (withBackground() ? 'background' : 'transparent') + '">' +
      '<div class="preview-top"><span>İNDİRECEĞİN GÖRSEL</span>' +
      '<div class="background-controls" role="group" aria-label="Yalnız şeffaf dosyanın önizleme zemini"' + (withBackground() ? ' hidden' : '') + '>' +
      ['light', 'dark'].map(tone => '<button type="button" data-lk-preview="' + tone + '" aria-pressed="' +
        (state.preview === tone) + '" aria-label="' + (tone === 'light' ? 'Açık' : 'Koyu') + ' önizleme zemini">' +
        '<i class="' + tone + '-dot"></i></button>').join('') + '</div></div>' +
      '<div class="preview-art">' + (previewUrl
        ? '<img src="' + esc(previewUrl) + '" alt="Seçtiğin renkte Lunapot logosu" data-layout="' + esc(state.custom.layout) + '">' : '') + '</div>' +
      '<div class="preview-bottom"><span>' + esc(logo ? (LABELS[state.custom.layout] || state.custom.layout) + ' / ' + logo : LABELS[state.custom.layout]) + '</span>' +
      '<span>' + esc(withBackground()
        ? (background ? background + ' zemin dosyaya dahil.' : 'Arka plan dosyaya dahil.')
        : 'Şeffaf dosya; önizleme zemini indirilmez.') + '</span></div>' +
      '</div></div></section>' +

      '<section class="closing frame"><div><p class="eyebrow">HEPSİ ELİNİN ALTINDA.</p>' +
      '<h2>Düzenli klasörler.<br>Kolay kullanım.</h2></div><div>' +
      '<p>Şeffaf logolar ve renkli zeminli görseller ayrı. Her yerleşim kendi klasöründe; her seçenek için bir SVG, bir PNG.</p>' +
      (zip ? '<a class="closing-download" href="' + esc(zip) + '" download="' + esc(data.zip) + '">Logo paketini indir <span>ZIP ↓</span></a>' : '') +
      '<a class="guide-link" href="/atolye/#belge-atolyesi?alan=' + namespace + '">Belge Atölyesi\'nde kullan ↗</a></div></section>' +

      '<footer class="page-footer frame"><span>Lunapot / Logo kütüphanesi</span>' +
      '<a href="/atolye/#belge-atolyesi?alan=' + namespace + '">Belge Atölyesi ↗</a></footer>' +
      '</div>';

    paintDots();
  }

  // Renk noktaları CSSOM ile boyanır: satır içi style niteliği `style-src 'self'`
  // altında engellenir ve panelde başka hiçbir modül de kullanmaz.
  function paintDots() {
    for (const dot of root.querySelectorAll('.color-dots i[data-hex]')) {
      const hex = dot.dataset.hex;
      if (HEX.test(hex)) dot.style.background = hex;
    }
  }

  async function sourceFor(layout) {
    if (sources.has(layout)) return sources.get(layout);
    const path = state.data.customSources?.[layout];
    if (!path) throw new Error('Bu yerleşimin renk kaynağı bulunamadı.');
    const response = await fetch(asset(path), {signal});
    if (!response.ok) throw new Error('Logo kaynağı yüklenemedi. Sayfayı yenileyerek tekrar dene.');
    const svg = await response.text();
    if (!svg.includes('currentColor') || !svg.includes('<svg')) throw new Error('Logo kaynağı renk değişimi için uygun değil.');
    sources.set(layout, svg);
    return svg;
  }

  function viewBoxOf(svg) {
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const box = parsed.documentElement.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if (parsed.querySelector('parsererror') || !box || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0)
      throw new Error('Logo ölçüleri okunamadı.');
    return box;
  }

  // Onaylı path'ler TEK eş oranlı dönüşümün içinde değişmeden kalır.
  // Zemin, dosyanın kendi <rect>'idir: kart arka planı boyamak değildir.
  function composeSvg(source, layout, color, background) {
    const colored = source.replace(/currentColor/g, color);
    if (!background) return colored;
    const [x, y, w, h] = viewBoxOf(source);
    const {width, height} = state.data.backgroundLayout?.frames?.[layout] || FRAMES[layout];
    const ratio = state.data.backgroundLayout?.fitRatio || 2 / 3;
    const scale = Math.min(width * ratio / w, height * ratio / h);
    const tx = (width - w * scale) / 2, ty = (height - h * scale) / 2;
    const body = colored.match(/<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i)?.[1];
    if (!body) throw new Error('Logo kaynağı okunamadı.');
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
      '" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Lunapot ' + LABELS[layout] +
      ' — renkli zemin"><rect width="' + width + '" height="' + height + '" fill="' + background +
      '"/><g transform="translate(' + tx + ' ' + ty + ') scale(' + scale + ') translate(' + (-x) + ' ' + (-y) + ')">' +
      body + '</g></svg>';
  }

  const luminance = hex => {
    const values = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  };

  async function refreshCustom() {
    const revision = ++state.revision;
    const color = logoHex(), background = withBackground() ? bgHex() : null;
    state.svg = ''; state.contrast = false;
    if (!color || (withBackground() && !background)) {
      releasePreview();
      state.error = 'Logo ve arka plan için geçerli bir HEX renk kodu yaz: örneğin #20251F.';
      state.status = 'Geçerli bir renk seçtiğinde indirme açılır.';
      render();
      return;
    }
    state.error = '';
    state.status = 'Önizleme hazırlanıyor…';
    render();
    try {
      const source = await sourceFor(state.custom.layout);
      if (state.disposed || revision !== state.revision) return;
      state.svg = composeSvg(source, state.custom.layout, color, background);
      releasePreview();
      previewUrl = URL.createObjectURL(new Blob([state.svg], {type: 'image/svg+xml;charset=utf-8'}));
      if (withBackground()) {
        const a = luminance(color), b = luminance(background);
        state.contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 2;
      }
      state.status = withBackground()
        ? 'Hazır. Logo ve renkli arka plan birlikte indirilir.'
        : 'Hazır. Dosya şeffaf zeminle indirilir.';
      render();
    } catch (problem) {
      if (state.disposed || revision !== state.revision || problem.name === 'AbortError') return;
      state.error = problem.message;
      state.status = 'Özel renk dosyası hazırlanamadı.';
      render();
    }
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = filename; link.hidden = true;
    root.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  const customName = extension => 'lunapot-' + state.custom.layout + '-' + logoHex().slice(1).toLowerCase() +
    (withBackground() ? '-' + bgHex().slice(1).toLowerCase() + '-zemin' : '-seffaf') + extension;

  function downloadSvg() {
    if (!state.svg || !validCustom() || state.busy) return;
    saveBlob(new Blob([state.svg], {type: 'image/svg+xml;charset=utf-8'}), customName('.svg'));
    state.status = 'SVG dosyan hazırlandı.';
    render();
  }

  // PNG oran koruması: tamsayı çıktı boyutu, değişmeyen viewBox,
  // preserveAspectRatio="xMidYMid meet", doğal boyutta drawImage(img,0,0).
  // Renkli modda canvas ÖNCE tam renkle doldurulur ve zemin rect'i YALNIZ
  // rasterizasyon kopyasından çıkarılır; böylece yuvarlanan yüksekliğin
  // kenarında şeffaf ya da farklı renkli piksel oluşmaz.
  // İNDİRİLEN SVG'DEN RECT ÇIKARILMAZ.
  async function downloadPng() {
    if (!state.svg || !validCustom() || state.busy) return;
    const svg = state.svg, name = customName(''), width = Number(state.custom.size), colored = withBackground();
    if (!PNG_SIZES.includes(width)) { state.error = 'Geçerli bir PNG boyutu seç.'; render(); return; }
    state.busy = true; state.error = ''; state.status = width + ' piksel PNG hazırlanıyor…';
    render();
    let imageUrl = '';
    try {
      const box = viewBoxOf(svg);
      const height = Math.max(1, Math.round(width * box[3] / box[2]));
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Tarayıcı PNG dışa aktarmayı desteklemiyor. SVG dosyasını indirebilirsin.');
      if (colored) {
        const rect = parsed.querySelector(':scope > rect') || parsed.documentElement.querySelector('rect');
        context.fillStyle = rect.getAttribute('fill');
        context.fillRect(0, 0, width, height);
        rect.remove();
      }
      parsed.documentElement.setAttribute('width', String(width));
      parsed.documentElement.setAttribute('height', String(height));
      parsed.documentElement.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      imageUrl = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(parsed)], {type: 'image/svg+xml;charset=utf-8'}));
      const image = new Image();
      image.src = imageUrl;
      await image.decode();
      if (state.disposed) return;
      context.drawImage(image, 0, 0);
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!png) throw new Error('PNG hazırlanamadı. Daha küçük bir boyutla tekrar dene.');
      if (state.disposed) return;
      saveBlob(png, name + '-' + width + 'px.png');
      state.status = width + ' × ' + height + ' piksel PNG hazırlandı. ' + (colored ? 'Arka plan dahil.' : 'Zemin şeffaf.');
    } catch (problem) {
      if (state.disposed) return;
      state.error = problem.message || 'PNG hazırlanamadı. SVG dosyasını indirebilirsin.';
      state.status = 'PNG hazırlanamadı; tekrar deneyebilirsin.';
    } finally {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      state.busy = false;
      if (!state.disposed) render();
    }
  }

  // Olaylar YALNIZ modül köküne bağlanır; route değişiminde signal ile kalkar.
  root.addEventListener('click', event => {
    const jump = event.target.closest('[data-lk-jump]');
    if (jump) { event.preventDefault(); root.querySelector('#lk-' + jump.dataset.lkJump)?.scrollIntoView({block: 'start'}); return; }
    const family = event.target.closest('[data-lk-family]');
    if (family && state.data) { state.family = family.dataset.lkFamily; render(); return; }
    const layout = event.target.closest('[data-lk-layout]');
    if (layout && state.data) { state.layout = layout.dataset.lkLayout; render(); return; }
    const preview = event.target.closest('[data-lk-preview]');
    if (preview) { state.preview = preview.dataset.lkPreview; render(); return; }
    const download = event.target.closest('[data-lk-download]');
    if (download) { if (download.dataset.lkDownload === 'svg') downloadSvg(); else downloadPng(); }
  }, {signal});

  root.addEventListener('change', event => {
    const field = event.target;
    if (field.hasAttribute('data-lk-color')) { state.color = field.value; render(); return; }
    const key = field.dataset.lkCustom;
    if (key === 'layout') { state.custom.layout = field.value; refreshCustom(); return; }
    if (key === 'mode') { state.custom.mode = field.value; refreshCustom(); return; }
    if (key === 'size') { state.custom.size = Number(field.value); render(); }
  }, {signal});

  root.addEventListener('input', event => {
    const field = event.target, key = field.dataset.lkCustom;
    if (key === 'hex' || key === 'bghex') {
      const caret = field.selectionStart;
      if (key === 'hex') state.custom.hex = field.value; else state.custom.bgHex = field.value;
      refreshCustom();
      const next = root.querySelector('[data-lk-custom="' + key + '"]');
      if (next) { next.focus({preventScroll: true}); try { next.setSelectionRange(caret, caret); } catch { /* imleç sonda kalır */ } }
      return;
    }
    if (key === 'picker') { state.custom.hex = field.value.toUpperCase(); refreshCustom(); return; }
    if (key === 'bgpicker') { state.custom.bgHex = field.value.toUpperCase(); refreshCustom(); }
  }, {signal});

  root.addEventListener('submit', event => { if (event.target.matches('[data-lk-form]')) event.preventDefault(); }, {signal});

  root.innerHTML = '<section class="card pad" role="status"><p>Logo kütüphanesi yükleniyor…</p></section>';
  (async () => {
    try {
      const response = await fetch(asset('manifest.json'), {signal});
      if (!response.ok) throw new Error('Logo dosyaları yüklenemedi.');
      const data = await response.json();
      if (!Array.isArray(data.variants) || !Array.isArray(data.layouts) || !Array.isArray(data.colors))
        throw new Error('Logo listesi okunamadı.');
      if (state.disposed) return;
      state.data = data;
      render();
      await refreshCustom();
    } catch (problem) {
      if (state.disposed || problem.name === 'AbortError') return;
      root.innerHTML = '<section class="card pad"><h2>Logo Kütüphanesi açılamadı</h2>' +
        '<p role="alert">' + esc(problem.message || 'Logo dosyaları yüklenemedi. Sayfayı yenileyerek tekrar dene.') + '</p></section>';
    }
  })();

  return () => { state.disposed = true; releasePreview(); controller.abort(); };
}
