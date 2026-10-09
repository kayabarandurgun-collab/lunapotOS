// Logo Kütüphanesi. Onaylı V8 geometrisi burada DEĞİŞMEZ: amblem parçaları, path'ler,
// yuvarlatmalar, açılar, aralıklar, oran ve wordmark harfleri sabittir. Tek renk seçimi
// yalnız currentColor değerini değiştirir; bütün logo eş oranlı ölçeklenir.
// Kaynak: lunapot-kurumsal-moduller-devir/02-Logo-Kutuphanesi/logo-indir.js
// Uyarlama: global document seçicileri ve DOMContentLoaded yerine mount/unmount.
const ASSET_ROOT = '/marka/logo/';
const asset = path => ASSET_ROOT + path;
const LAYOUT_LABEL = {yatay: 'Yatay logo', dikey: 'Dikey logo', amblem: 'Yalnız amblem', yazi: 'Yalnız yazı'};
const PNG_SIZES = [1024, 2048, 4096];
// Serbest SVG yükleme veya HTML çalıştırma YOK: yalnız altı haneli HEX kabul edilir.
const HEX = /^#[0-9A-Fa-f]{6}$/;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

export function mountBrandLogos(root, namespace) {
  if (!['ec', 'lp'].includes(namespace)) throw new Error('Çalışma alanı geçersiz.');
  const controller = new AbortController();
  const signal = controller.signal;
  const state = {
    data: null, layout: 'all', color: 'all', background: 'light',
    custom: {layout: 'yatay', hex: '#20251F', size: 1024},
    svg: '', busy: false, revision: 0, error: '', status: '', disposed: false
  };
  const sources = new Map();
  let previewUrl = '';

  // Blob önizlemesi iş bitince VE unmount'ta serbest bırakılır.
  const releasePreview = () => { if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = ''; } };

  const hexOf = () => {
    const value = String(state.custom.hex || '').trim();
    return HEX.test(value) ? value.toUpperCase() : null;
  };

  // Renk noktalari data-hex ile isaretlenir, rengi render sonrasi CSSOM ile atanir.
  // Satir ici style="..." niteligi `style-src 'self'` altinda ENGELLENIR; panelin
  // baska hicbir modulu de kullanmaz. Programatik el.style ataması CSP'ye takılmaz.
  const colorDots = variant => {
    const entry = state.data.colors.find(color => color.id === variant.colorId);
    return [variant.hex, ...(variant.hexes || []), entry?.hex, entry?.secondaryHex, ...(entry?.hexes || [])]
      .filter((hex, index, values) => typeof hex === 'string' && HEX.test(hex) && values.indexOf(hex) === index)
      .map(hex => '<i data-hex="' + esc(hex) + '"></i>').join('');
  };

  const paintDots = () => {
    for (const dot of root.querySelectorAll('.marka-dots i[data-hex]')) {
      const hex = dot.dataset.hex;
      if (HEX.test(hex)) dot.style.background = hex;
    }
  };

  function cards() {
    const shown = state.data.variants.filter(variant =>
      (state.layout === 'all' || variant.layout === state.layout) &&
      (state.color === 'all' || variant.colorId === state.color));
    if (!shown.length) return {count: 0, html: '<p class="marka-empty">Bu seçimle eşleşen hazır varyant yok. Çift renkli seçenekler yalnız bazı yerleşimlerde bulunur.</p>'};
    return {
      count: shown.length,
      html: '<div class="marka-grid">' + shown.map(variant =>
        '<article class="marka-card">' +
        '<div class="marka-art" data-background="' + esc(variant.background || 'light') + '" data-layout="' + esc(variant.layout) + '">' +
        '<img src="' + esc(asset(variant.svg)) + '" alt="' + esc(variant.label) + '" loading="lazy"></div>' +
        '<div class="marka-card-head"><h3>' + esc(variant.label) + '</h3><span class="marka-dots" aria-hidden="true">' + colorDots(variant) + '</span></div>' +
        '<p class="marka-card-info">' + esc(LAYOUT_LABEL[variant.layout] || variant.layout) + ' · Şeffaf zemin</p>' +
        '<div class="marka-downloads">' +
        '<a class="marka-svg" href="' + esc(asset(variant.svg)) + '" download="' + esc(variant.svg.split('/').pop()) + '">SVG ↓</a>' +
        '<span class="marka-png"><span>PNG</span>' + variant.pngs.map(png =>
          '<a href="' + esc(asset(png.path)) + '" download="' + esc(png.path.split('/').pop()) +
          '" title="' + esc(png.width + ' px genişlik · şeffaf PNG') +
          '" aria-label="' + esc(variant.label + ', şeffaf PNG, ' + png.width + ' piksel indir') + '">' + png.width + '</a>').join('') +
        '</span></div></article>').join('') + '</div>'
    };
  }

  function render() {
    const data = state.data;
    const list = cards();
    const hex = hexOf();
    const ready = !!state.svg && !!hex && !state.busy;
    root.innerHTML =
      '<section class="card pad marka-logo-intro"><div class="section-heading"><div><span class="eyebrow">MARKA</span>' +
      '<h2>Logo Kütüphanesi</h2><p>Onaylı Lunapot logosunun hazır dosyaları ve kendi renginle hazırlanan kopyaları. ' +
      'Amblemin şekli, oranı ve marka yazısı değişmez; yalnız renk ve boyut seçilir.</p></div>' +
      '<a class="secondary" href="' + esc(asset(data.zip)) + '" download="' + esc(data.zip) + '">Tüm varyantları indir (ZIP) ↓</a></div></section>' +

      '<section class="card pad marka-logo"><div class="section-heading"><div><h2>Hazır varyantlar</h2>' +
      '<p>' + data.variants.length + ' varyant · her biri SVG ve 1024 / 2048 / 4096 piksel şeffaf PNG.</p></div>' +
      '<span class="pill" data-marka-count>' + list.count + ' varyant gösteriliyor</span></div>' +
      '<form class="marka-filters" data-marka-filters><fieldset><legend>Yerleşim</legend><div class="marka-layout-buttons">' +
      [['all', 'Tümü'], ...data.layouts.map(layout => [layout.id, layout.label])].map(([id, label]) =>
        '<button type="button" data-marka-layout="' + esc(id) + '" aria-pressed="' + (state.layout === id) + '">' + esc(label) + '</button>').join('') +
      '</div></fieldset><label>Renk<select name="color">' +
      [['all', 'Tüm renkler'], ...data.colors.map(color => [color.id, color.label])].map(([id, label]) =>
        '<option value="' + esc(id) + '"' + (state.color === id ? ' selected' : '') + '>' + esc(label) + '</option>').join('') +
      '</select></label></form>' + list.html + '</section>' +

      '<section class="card pad marka-custom"><div class="section-heading"><div><h2>Kendi rengimle hazırla</h2>' +
      '<p>Onaylı kaynağın yalnız rengi değişir. Dosya bu tarayıcıda üretilir; sunucuya gönderilmez ve kurumsal varsayılanı değiştirmez.</p></div></div>' +
      '<div class="marka-custom-grid"><form class="marka-custom-form" data-marka-custom>' +
      '<label>Yerleşim<select name="layout">' + data.layouts.map(layout =>
        '<option value="' + esc(layout.id) + '"' + (state.custom.layout === layout.id ? ' selected' : '') + '>' + esc(layout.label) + '</option>').join('') + '</select></label>' +
      '<label>Renk kodu<input name="hex" type="text" inputmode="text" spellcheck="false" maxlength="7" value="' + esc(state.custom.hex) +
      '" aria-invalid="' + (!hex) + '" aria-describedby="marka-hex-help"></label>' +
      '<label class="marka-swatch">Renk seçici<input name="picker" type="color" value="' + esc(hex || '#20251F') + '"></label>' +
      '<label>PNG boyutu<select name="size">' + PNG_SIZES.map(size =>
        '<option value="' + size + '"' + (state.custom.size === size ? ' selected' : '') + '>' + size + ' piksel</option>').join('') + '</select></label>' +
      '<p class="help" id="marka-hex-help">Altı haneli HEX kodu yaz: örneğin #20251F.</p>' +
      '<div class="marka-custom-actions">' +
      '<button type="button" class="primary" data-marka-download="svg"' + (ready ? '' : ' disabled') + '>SVG indir ↓</button>' +
      '<button type="button" class="secondary" data-marka-download="png"' + (ready ? '' : ' disabled') + '>PNG indir ↓</button></div>' +
      (state.error ? '<p class="notice" role="alert" data-marka-error>' + esc(state.error) + '</p>' : '') +
      '<p class="help" role="status" data-marka-status>' + esc(state.status) + '</p></form>' +
      '<div class="marka-preview" data-background="' + esc(state.background) + '" data-marka-preview>' +
      '<div class="marka-preview-toggle">' + [['light', 'Açık zemin'], ['dark', 'Koyu zemin']].map(([id, label]) =>
        '<button type="button" data-marka-background="' + esc(id) + '" aria-pressed="' + (state.background === id) + '">' + esc(label) + '</button>').join('') + '</div>' +
      '<div class="marka-preview-art" data-layout="' + esc(state.custom.layout) + '">' +
      (previewUrl ? '<img src="' + esc(previewUrl) + '" alt="' + esc((LAYOUT_LABEL[state.custom.layout] || '') + ' önizlemesi') + '">' : '<span class="marka-preview-empty">Önizleme hazırlanıyor…</span>') +
      '</div><p class="marka-preview-label">' + esc(hex ? (LAYOUT_LABEL[state.custom.layout] || state.custom.layout) + ' · ' + hex : 'Geçerli bir renk seçtiğinde önizleme açılır.') + '</p>' +
      '</div></div></section>';
    paintDots();
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

  async function refreshCustom() {
    const revision = ++state.revision;
    const hex = hexOf();
    state.svg = '';
    if (!hex) {
      releasePreview();
      state.error = 'Geçerli bir HEX renk kodu yaz: örneğin #20251F.';
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
      state.svg = source.replace(/currentColor/g, hex);
      releasePreview();
      previewUrl = URL.createObjectURL(new Blob([state.svg], {type: 'image/svg+xml;charset=utf-8'}));
      state.status = 'Hazır. İndirme, seçtiğin renk ve yerleşimle hazırlanır.';
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

  const customName = extension => 'lunapot-' + state.custom.layout + '-' + hexOf().slice(1).toLowerCase() + extension;

  function downloadSvg() {
    if (!state.svg || !hexOf() || state.busy) return;
    saveBlob(new Blob([state.svg], {type: 'image/svg+xml;charset=utf-8'}), customName('.svg'));
    state.status = 'SVG dosyan hazırlandı.';
    render();
  }

  // PNG oran koruması: tamsayı piksel viewport + değişmez viewBox/preserveAspectRatio +
  // doğal boyutta drawImage(img,0,0). Yuvarlanmış yüksekliğe bağımsız x/y ölçek UYGULANMAZ.
  async function downloadPng() {
    if (!state.svg || !hexOf() || state.busy) return;
    const svg = state.svg, name = customName(''), width = Number(state.custom.size);
    if (!PNG_SIZES.includes(width)) { state.error = 'Geçerli bir PNG boyutu seç.'; render(); return; }
    state.busy = true; state.error = ''; state.status = width + ' piksel PNG hazırlanıyor…';
    render();
    let imageUrl = '';
    try {
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const viewBox = parsed.documentElement.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
      if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0)
        throw new Error('Logo ölçüleri okunamadı.');
      const height = Math.max(1, Math.round(width * viewBox[3] / viewBox[2]));
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Tarayıcı PNG dışa aktarmayı desteklemiyor. SVG dosyasını indirebilirsin.');
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
      state.status = width + ' × ' + height + ' piksel, şeffaf PNG hazırlandı.';
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

  function failed(message) {
    root.innerHTML = '<section class="card pad" data-marka-failed><h2>Logo Kütüphanesi açılamadı</h2>' +
      '<p role="alert">' + esc(message) + '</p></section>';
  }

  // Olaylar YALNIZ modül köküne bağlanır; route değişiminde signal ile kalkar.
  root.addEventListener('click', event => {
    const layoutButton = event.target.closest('[data-marka-layout]');
    if (layoutButton && state.data) { state.layout = layoutButton.dataset.markaLayout; render(); return; }
    const backgroundButton = event.target.closest('[data-marka-background]');
    if (backgroundButton) { state.background = backgroundButton.dataset.markaBackground; render(); return; }
    const download = event.target.closest('[data-marka-download]');
    if (download) { if (download.dataset.markaDownload === 'svg') downloadSvg(); else downloadPng(); }
  }, {signal});

  root.addEventListener('change', event => {
    const field = event.target;
    if (field.matches('[data-marka-filters] [name=color]')) { state.color = field.value; render(); return; }
    if (field.matches('[data-marka-custom] [name=layout]')) { state.custom.layout = field.value; refreshCustom(); return; }
    if (field.matches('[data-marka-custom] [name=size]')) { state.custom.size = Number(field.value); render(); }
  }, {signal});

  root.addEventListener('input', event => {
    const field = event.target;
    if (field.matches('[data-marka-custom] [name=hex]')) {
      state.custom.hex = field.value;
      const caret = field.selectionStart;
      refreshCustom();
      const next = root.querySelector('[data-marka-custom] [name=hex]');
      if (next) { next.focus({preventScroll: true}); try { next.setSelectionRange(caret, caret); } catch { /* seçim taşınamadıysa imleç sonda kalır */ } }
      return;
    }
    if (field.matches('[data-marka-custom] [name=picker]')) {
      state.custom.hex = field.value.toUpperCase();
      refreshCustom();
    }
  }, {signal});

  root.addEventListener('submit', event => {
    if (event.target.matches('[data-marka-filters],[data-marka-custom]')) event.preventDefault();
  }, {signal});

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
      state.custom.layout = data.layouts[0]?.id || 'yatay';
      render();
      await refreshCustom();
    } catch (problem) {
      if (state.disposed || problem.name === 'AbortError') return;
      failed(problem.message || 'Logo dosyaları yüklenemedi. Sayfayı yenileyerek tekrar dene.');
    }
  })();

  return () => { state.disposed = true; releasePreview(); controller.abort(); };
}
