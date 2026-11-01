// BUYBOX ROBOTU ekranı: Hepsiburada | Trendyol yan yana. Karar sunucuda (src/buybox-motor.js);
// burası ilan seçer, ayar girer ve durumu gösterir. Telefonda iki liste sekmeye döner.
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const tl = v => v === null || v === undefined ? '—' : new Intl.NumberFormat('tr-TR', {style: 'currency', currency: 'TRY', minimumFractionDigits: v % 100 ? 2 : 0, maximumFractionDigits: 2}).format(v / 100);
const kutu = v => v === null || v === undefined ? '' : String(v / 100);
const zaman = v => { if (!v) return '—'; const t = Date.parse(String(v).replace(' ', 'T') + 'Z'); return Number.isFinite(t) ? new Date(t).toLocaleString('tr-TR', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}) : '—'; };
const PLATFORM = {hb: 'Hepsiburada', ty: 'Trendyol'};
const MAGAZALAR = ['Lunapot', 'Pazaria'], MAGAZA_ANAHTARI = 'buybox-magaza';
// Son seçilen mağaza yalnız kolaylıktır: okunamazsa seçim ekranı açılır.
const hatirlanan = () => { try { return localStorage.getItem(MAGAZA_ANAHTARI); } catch { return null; } };
const hatirla = m => { try { localStorage.setItem(MAGAZA_ANAHTARI, m); } catch { /* yok say */ } };
const BICIM = {kapali: 'Kapalı', izle: 'İzle', aktif: 'Aktif'};
const NEDEN = {cekil: 'Rakip tabana indi, çekilme fiyatına çıkıldı', esitle: 'Rakibin fiyatına inildi', alta_in: 'Aynı fiyatta sıra gelmedi, 1 TL altına inildi', yukari: 'Rakip yükseldi, birlikte çıkıldı', rakipsiz: 'Rakip yok, çekilme fiyatında',
  yerinde: 'Fiyat zaten doğru yerde', esit: 'Rakiple aynı fiyatta, sıra bizde', onde: 'Rakibin hemen altında, sıra bizde', esit_tabanda: 'Aynı fiyatta sıra gelmedi; taban daha fazla inmeye izin vermiyor', fiyat_disi: 'Rakipten ucuzuz ama sıra gelmiyor; fark fiyatta değil',
  rakip_bilinmiyor: 'Rakip fiyatı okunamadı, dokunulmadı', hata_freni: 'Rakip fiyatı güvenlik sınırının üstünde, peşine düşülmedi', zarar_kilidi: 'Zarar kilidi: bu fiyata inilmedi', taban_alti: 'Hedef tabanın altında, inilmedi', yon_kilitli: 'Platform bu yönde fiyat değişikliğini kapatmış',
  kilitli: 'İlan kilitli ya da kampanyada, dokunulmadı', fiyat_yok: 'Fiyat okunamadı', stok_yok: 'Stok yok', ayar_yok: 'Taban ve çekilme fiyatı girilmedi', ilan_yok: 'İlan platformda bulunamadı', gunluk_sinir: 'Günlük değişiklik sınırına gelindi',
  yansiyor: 'Gönderilen fiyatın platforma yansıması bekleniyor', elle_degisti: 'Fiyat robot dışında değişti, izlemeye alındı', tekrar_bekliyor: 'Trendyol aynı isteği 15 dakika kabul etmiyor, bekleniyor'};
const SONUC = {gonderildi: 'Gönderildi', tamam: 'Uygulandı', hata: 'Reddedildi'};

export function mountBuybox(root) {
  if (!document.querySelector('link[data-buybox]')) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./buybox.css', import.meta.url); link.dataset.buybox = '1'; document.head.append(link); }
  let veri = null, mesaj = '', hata = false, mesgul = false, magaza = null, sekme = 'hb', ilkYukleme = true;
  const secim = {hb: new Set(), ty: new Set()}, arama = {hb: '', ty: ''}, suzgec = {hb: 'hepsi', ty: 'hepsi'};
  root.innerHTML = '<div class="v2-page bb"><div data-govde><div class="loading">Buybox robotu yükleniyor…</div></div><dialog class="bb-pencere" data-pencere aria-labelledby="bb-pencere-baslik"></dialog></div>';
  const kap = root.firstElementChild, govde = kap.querySelector('[data-govde]'), pencere = kap.querySelector('[data-pencere]');
  const istek = async (yol = '', veriler) => {
    const cevap = await fetch('/api/ec/buybox' + yol, veriler === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(veriler)});
    const j = await cevap.json().catch(() => ({}));
    if (!cevap.ok) throw new Error(j.error || 'İşlem yapılamadı.');
    return j;
  };
  // API'si girilmiş mağazaya doğrudan girilir; girilmemişse ya da hangisi olduğu belli değilse önce seçim sorulur.
  const baslangicMagazasi = () => {
    const bagli = MAGAZALAR.filter(m => veri.baglantilar.some(b => b.magaza === m)), son = hatirlanan();
    return bagli.includes(son) ? son : bagli.length === 1 ? bagli[0] : null;
  };
  const yukle = async () => { veri = await istek(); if (ilkYukleme) { ilkYukleme = false; magaza = baslangicMagazasi(); } ciz(); };
  const yap = async (is, basari) => {
    if (mesgul) return; mesgul = true; mesaj = ''; hata = false; ciz();
    try { const s = await is(); mesaj = basari(s); await yukle(); }
    catch (e) { mesaj = e.message; hata = true; }
    finally { mesgul = false; ciz(); }
  };
  const baglanti = p => veri.baglantilar.find(b => b.magaza === magaza && b.platform === p) || null;
  const ilanlar = b => b ? veri.kurallar.filter(k => k.connection_id === b.id) : [];
  const gorunen = (p, b) => {
    const q = arama[p].trim().toLocaleLowerCase('tr-TR'), f = suzgec[p];
    return ilanlar(b).filter(k => (f === 'hepsi' || k.mode === f) && (!q || `${k.label} ${k.sku} ${k.merchant_sku}`.toLocaleLowerCase('tr-TR').includes(q)));
  };
  const satir = (p, k) => {
    const n = esc(k.label || k.sku), secili = secim[p].has(k.sku), kilit = !veri.yonetici ? ' disabled' : '';
    const alt = k.last_error || (k.mode === 'kapali' ? '' : NEDEN[k.last_reason]) || '';
    return `<div class="bb-satir bb-satir--${k.mode}" data-sku="${esc(k.sku)}" role="listitem">
      <input type="checkbox" data-sec aria-label="${n} seç"${secili ? ' checked' : ''}${kilit}>
      <button type="button" class="bb-ad" data-ac><strong>${n}</strong>${(k.merchant_sku || k.sku) !== k.label ? `<small>${esc(k.merchant_sku || k.sku)}</small>` : ''}${alt ? `<small class="${k.last_error ? 'bb-hata' : 'bb-neden'}">${esc(alt)}${k.mode === 'izle' && k.oneri_cents ? ` · Aktif olsa ${tl(k.oneri_cents)}` : ''}</small>` : ''}</button>
      <span class="bb-deger"><small>Fiyat</small>${tl(k.price_cents)}${k.pending_upload_id ? '<small>gönderildi</small>' : ''}</span>
      <span class="bb-deger"><small>Sıra</small>${k.rank === null || k.mode === 'kapali' ? '—' : `<b class="bb-sira${k.rank === 1 ? ' bb-sira--bir' : ''}">${k.rank}</b>`}</span>
      <span class="bb-deger"><small>Rakip</small>${k.mode === 'kapali' ? '—' : tl(k.rival_cents)}</span>
      <span class="bb-rozet bb-rozet--${k.mode}">${BICIM[k.mode]}</span></div>`;
  };
  const baglantiFormu = p => `<form data-baglanti="${p}" autocomplete="off" class="bb-form"><label>Satıcı kimliği (${p === 'hb' ? 'Merchant ID' : 'Satıcı ID'})<input name="seller_id" required autocomplete="off"></label><label>API kullanıcı adı<input name="key" required autocomplete="off"></label><label>API şifresi<input name="secret" type="password" required autocomplete="new-password"></label>${p === 'hb' ? '<label>User-Agent<input name="user_agent" required autocomplete="off"></label>' : ''}<button class="primary" type="submit">Şifreli kaydet</button></form>`;
  const liste = p => {
    const b = baglanti(p);
    if (!b) return `<div class="bb-bos"><h3>${PLATFORM[p]} bağlı değil</h3><p>${esc(magaza)} için API bilgilerini gir. Bilgiler şifreli saklanır, bu bağlantı yalnız fiyat robotu içindir; kapalı olan rapor senkronunu açmaz.</p>${veri.yonetici ? baglantiFormu(p) : ''}</div>`;
    const tum = ilanlar(b), v = gorunen(p, b), say = m => tum.filter(k => k.mode === m).length, sec = secim[p].size;
    const okunmayan = tum.filter(k => k.mode !== 'kapali' && k.last_reason === 'rakip_bilinmiyor').length;
    const hepsi = v.length > 0 && v.every(k => secim[p].has(k.sku));
    return `${b.last_error ? `<div class="notice bb-uyari" role="alert"><strong>Son tur hata verdi.</strong> ${esc(b.last_error)}</div>` : ''}
      ${b.paused ? '<div class="notice" role="status"><strong>Bu mağazada robot durduruldu.</strong> Hiçbir fiyat değişmiyor.</div>' : ''}
      ${okunmayan ? `<div class="notice" role="status"><strong>${okunmayan} ilanda rakip fiyatı okunamıyor.</strong> Robot bu ilanlara dokunmuyor.${b.sample_fields ? ' Okunan alanlar: ' + esc(b.sample_fields.join(', ') || 'boş yanıt') : ''}</div>` : ''}
      <div class="bb-ozet"><span><b>${say('aktif')}</b> aktif</span><span><b>${say('izle')}</b> izleniyor</span><span><b>${tum.length}</b> ilan</span><span class="bb-zaman">Son tur ${zaman(b.last_ok_at)} · ${esc(b.hint)}</span></div>
      ${veri.yonetici ? `<div class="bb-araclar"><button type="button" class="secondary" data-is="ilanlar">İlanları getir</button><button type="button" class="secondary" data-is="sina">Bağlantıyı sına</button><button type="button" class="secondary" data-is="calistir">Şimdi çalıştır</button><button type="button" class="${b.paused ? 'primary' : 'secondary'}" data-duraklat>${b.paused ? 'Başlat' : 'Durdur'}</button></div>` : ''}
      ${tum.length ? `<div class="bb-suzgec"><input type="search" data-ara value="${esc(arama[p])}" placeholder="Ürün, SKU ya da barkod ara" aria-label="${PLATFORM[p]} ilanlarında ara"><select data-suz aria-label="Duruma göre süz">${[['hepsi', 'Tümü'], ['aktif', 'Aktif'], ['izle', 'İzle'], ['kapali', 'Kapalı']].map(([a, t]) => `<option value="${a}"${suzgec[p] === a ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
        ${veri.yonetici ? `<div class="bb-toplu"><label class="bb-hepsi"><input type="checkbox" data-hepsi${hepsi ? ' checked' : ''}> ${sec ? `${sec} seçili` : `Görünen ${v.length} ilanı seç`}</label>${sec ? `<span class="bb-toplu-dugme"><button type="button" class="secondary" data-toplu="izle">İzle</button><button type="button" class="primary" data-toplu="aktif">Aktif</button><button type="button" class="secondary" data-toplu="kapali">Kapat</button></span><form class="bb-yuzde" data-yuzde><label>Taban: fiyatın %<input name="yuzde" inputmode="decimal" required aria-label="Taban için indirim yüzdesi"> altı</label><button type="submit" class="secondary">Uygula</button></form>` : ''}</div>` : ''}
        <div class="bb-liste" role="list">${v.map(k => satir(p, k)).join('') || '<p class="bb-yok">Bu aramaya uyan ilan yok.</p>'}</div>` : '<div class="bb-bos"><p>Henüz ilan yok. "İlanları getir" ile çek; hepsi Kapalı başlar, fiyat değişmez.</p></div>'}
      ${veri.yonetici ? `<details class="bb-degistir"><summary>${PLATFORM[p]} bağlantısını değiştir</summary>${baglantiFormu(p)}</details>` : ''}`;
  };
  const kolon = p => `<section class="v2-card bb-kolon${sekme === p ? ' bb-kolon--acik' : ''}" data-kolon="${p}" aria-label="${PLATFORM[p]}"><h2>${PLATFORM[p]}</h2>${liste(p)}</section>`;
  const secimEkrani = () => `<div class="page-heading"><div><span class="eyebrow">FİYAT TAKİBİ</span><h1>Hangi mağazada çalışacağız?</h1><p>Her mağazanın Hepsiburada ve Trendyol API bilgileri ayrı saklanır. Sonradan üstteki düğmelerle geçebilirsin.</p></div></div>
      ${mesaj ? `<div class="notice${hata ? ' bb-uyari' : ''}" role="status">${esc(mesaj)}</div>` : ''}
      <div class="bb-magaza-sec">${MAGAZALAR.map(m => `<button type="button" class="bb-magaza-kart" data-magaza-sec="${esc(m)}"><strong>${esc(m)}</strong>${Object.keys(PLATFORM).map(p => { const b = veri.baglantilar.find(x => x.magaza === m && x.platform === p); return `<span class="${b ? 'bb-bagli' : 'bb-bagsiz'}">${PLATFORM[p]}: ${b ? `bağlı · ${ilanlar(b).length} ilan` : 'API girilmedi'}</span>`; }).join('')}</button>`).join('')}</div>`;
  function ciz() {
    if (!veri) return;
    if (!magaza) { govde.innerHTML = secimEkrani(); return; }
    const durabilir = veri.yonetici && veri.baglantilar.length, hepsiDurdu = veri.baglantilar.length && veri.baglantilar.every(b => b.paused);
    const kaydirma = [...govde.querySelectorAll('.bb-liste')].map(e => [e.closest('[data-kolon]').dataset.kolon, e.scrollTop]);
    const odak = document.activeElement?.matches?.('[data-ara]') ? {p: document.activeElement.closest('[data-kolon]').dataset.kolon, s: document.activeElement.selectionStart} : null;
    govde.innerHTML = `<div class="page-heading"><div><span class="eyebrow">FİYAT TAKİBİ</span><h1>Buybox robotu</h1><p>Rakibi 2 dakikada bir takip eder: tabana inerse onu aşağıda bırakıp çekilme fiyatına çıkar, yükselirse birlikte çıkar. Kapalı ilana dokunmaz.</p></div>
        <div class="ac-actions bb-ust"><div class="bb-magaza" role="group" aria-label="Mağaza">${MAGAZALAR.map(m => `<button type="button" class="${m === magaza ? 'primary' : 'secondary'}" data-magaza-sec="${esc(m)}"${m === magaza ? ' aria-current="true"' : ''}>${esc(m)}</button>`).join('')}</div>${durabilir ? `<button type="button" class="${hepsiDurdu ? 'primary' : 'bb-dur'}" data-hepsini-durdur>${hepsiDurdu ? 'Tüm robotları başlat' : 'Tüm robotları durdur'}</button>` : ''}</div></div>
      ${mesaj ? `<div class="notice${hata ? ' bb-uyari' : ''}" role="status">${esc(mesaj)}</div>` : ''}
      <div class="bb-sekmeler" role="tablist">${Object.keys(PLATFORM).map(p => `<button type="button" role="tab" aria-selected="${sekme === p}" data-sekme="${p}">${PLATFORM[p]}</button>`).join('')}</div>
      <div class="bb-bolme">${kolon('hb')}${kolon('ty')}</div>`;
    for (const [p, y] of kaydirma) { const e = govde.querySelector(`[data-kolon="${p}"] .bb-liste`); if (e) e.scrollTop = y; }
    if (odak) { const e = govde.querySelector(`[data-kolon="${odak.p}"] [data-ara]`); if (e) { e.focus(); e.setSelectionRange(odak.s, odak.s); } }
  }
  const ornekler = (t, c) => [[t + 2000, 'yukarıdan iniyor'], [t + 100, 'tabanın 1 TL üstü'], [t, 'tabanda'], [c + 100, 'yukarı kaçtı'], [c + 5100, 'çok yukarı kaçtı']];
  async function pencereAc(p, sku) {
    const b = baglanti(p), k = ilanlar(b).find(x => x.sku === sku);
    if (!k) return;
    const kilit = veri.yonetici ? '' : ' disabled';
    pencere.dataset.platform = p; pencere.dataset.sku = sku; pencere.dataset.cid = b.id; pencere.dataset.fiyat = kutu(k.price_cents);
    pencere.innerHTML = `<form data-kural method="dialog"><header><div><span class="eyebrow">${PLATFORM[p]} · ${esc(b.magaza)}</span><h2 id="bb-pencere-baslik">${esc(k.label || k.sku)}</h2><p>${esc(k.merchant_sku || k.sku)}${k.url ? ` · <a href="${esc(k.url)}" target="_blank" rel="noopener">Ürün sayfası</a>` : ''}</p></div><button type="button" class="secondary" data-kapat aria-label="Kapat">Kapat</button></header>
      <div class="bb-canli"><span><small>Fiyatımız</small>${tl(k.price_cents)}</span><span><small>Sıra</small>${k.rank ?? '—'}</span><span><small>Rakip</small>${tl(k.rival_cents)}</span><span><small>Stok</small>${k.stock ?? '—'}</span></div>
      ${k.kilit ? `<div class="notice" role="status"><strong>Platformda ${esc(k.kilit)}.</strong> Bu durum bitene kadar robot fiyata dokunmaz.</div>` : ''}
      <fieldset class="bb-bicim"><legend>Robot bu ilanda</legend>${Object.entries(BICIM).map(([m, t]) => `<label><input type="radio" name="mode" value="${m}"${k.mode === m ? ' checked' : ''}${kilit}><span>${t}</span></label>`).join('')}</fieldset>
      <div class="bb-alanlar"><label>Taban fiyat (TL)<small>Rakip buraya inince kapışmadan çekilir</small><input name="taban" inputmode="decimal" value="${kutu(k.taban_cents)}"${kilit}></label><label>Çekilme fiyatı (TL)<small>Rakibi bırakıp çıktığımız fiyat</small><input name="cekilme" inputmode="decimal" value="${kutu(k.cekilme_cents)}"${kilit}></label></div>
      <div class="bb-senaryo" data-senaryo aria-live="polite"></div>
      <fieldset class="bb-zarar"><legend>Zarar kilidi</legend><div class="bb-alanlar bb-alanlar--uc"><label>Maliyet (TL)<input name="maliyet" inputmode="decimal" value="${kutu(k.maliyet_cents)}"${kilit}></label><label>Komisyon (%)<input name="komisyon" inputmode="decimal" value="${k.komisyon_bp === null ? '' : k.komisyon_bp / 100}"${kilit}></label><label>Kargo (TL)<input name="kargo" inputmode="decimal" value="${kutu(k.kargo_cents)}"${kilit}></label></div><p class="bb-zarar-sonuc" data-zarar aria-live="polite"></p><label class="bb-onay"><input type="checkbox" name="zarar_onay"${k.zarar_onay ? ' checked' : ''}${kilit}> Maliyeti bilmesem de ya da zararına olsa da bu ilanı Aktif çalıştır</label></fieldset>
      <details class="bb-gelismis"><summary>Gelişmiş</summary><label class="bb-onay"><input type="checkbox" name="yukari_esit"${k.yukari_esit ? ' checked' : ''}${kilit}> Rakip yükselince 1 TL altına değil, aynı fiyata çık</label><label>Güvenlik sınırı (TL)<small>Rakip bunun üstündeyse hatalı fiyat sayılır, peşine düşülmez. Boşsa çekilme fiyatının 3 katı.</small><input name="guvenlik" inputmode="decimal" value="${kutu(k.guvenlik_cents)}"${kilit}></label></details>
      <details class="bb-deneme"><summary>Dene: rakip şu fiyata gelirse?</summary><div class="bb-alanlar bb-alanlar--uc"><label>Şu anki fiyat<input name="d_fiyat" inputmode="decimal" value="${kutu(k.price_cents)}"></label><label>Rakip fiyatı<input name="d_rakip" inputmode="decimal"></label><label>Sıra<select name="d_sira"><option value="1">Sıra bizde</option><option value="2">Sıra rakipte</option></select></label></div><button type="button" class="secondary" data-dene>Sonucu göster</button><p data-deneme-sonuc aria-live="polite"></p></details>
      <p class="bb-pencere-hata" data-pencere-hata role="alert"></p>
      <details class="bb-gecmis" data-gecmis><summary>Fiyat geçmişi</summary><div data-gecmis-icerik>Yükleniyor…</div></details>
      ${veri.yonetici ? '<footer><button type="button" class="secondary" data-kapat>Vazgeç</button><button type="submit" class="primary">Kaydet</button></footer>' : ''}</form>`;
    pencere.showModal();
    ayarOzeti();
    istek(`/olaylar?connection_id=${b.id}&sku=${encodeURIComponent(sku)}`).then(({olaylar}) => {
      const yer = pencere.querySelector('[data-gecmis-icerik]');
      if (yer) yer.innerHTML = olaylar.length ? `<ul>${olaylar.map(o => `<li><time>${zaman(o.at)}</time> ${tl(o.old_cents)} → <b>${tl(o.new_cents)}</b> <small>rakip ${tl(o.rival_cents)} · ${esc(NEDEN[o.reason] || o.reason)} · ${esc(SONUC[o.status] || o.status)}</small></li>`).join('')}</ul>` : 'Henüz fiyat değişikliği yok.';
    }).catch(e => { const yer = pencere.querySelector('[data-gecmis-icerik]'); if (yer) yer.textContent = e.message; });
  }
  const sayi = ad => { const v = pencere.querySelector(`[name="${ad}"]`)?.value.trim().replace(',', '.'); if (!v) return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };
  // Girilen ayarın ne yapacağını kullanıcının kendi örneğiyle gösterir. Kural sunucudaki motordadır; bu yalnız önizlemedir.
  function ayarOzeti() {
    const t = sayi('taban'), c = sayi('cekilme'), yer = pencere.querySelector('[data-senaryo]'), z = pencere.querySelector('[data-zarar]');
    if (yer) {
      const ok = t !== null && c !== null && c > t, esit = pencere.querySelector('[name="yukari_esit"]')?.checked;
      yer.innerHTML = ok ? `<strong>Bu ayarla robot:</strong><ul>${ornekler(t, c).map(([r, ad]) => {
        const hedef = r <= t ? c : r > c ? (esit ? r : r - 100) : r;
        return `<li>Rakip ${tl(r)} <small>${ad}</small> → <b>${tl(hedef)}</b></li>`;
      }).join('')}</ul>` : (t !== null && c !== null ? '<span class="bb-hata">Çekilme fiyatı tabandan yüksek olmalı.</span>' : '<span>Taban ve çekilme fiyatını girince robotun ne yapacağı burada görünür.</span>');
    }
    if (z) {
      const m = sayi('maliyet'), o = Number((pencere.querySelector('[name="komisyon"]')?.value || '0').replace(',', '.')), k = sayi('kargo') || 0;
      if (!m) z.textContent = 'Maliyet girilmedi: Aktif için aşağıdaki kutuyu işaretlemek gerekir.';
      else if (!(o >= 0 && o < 100)) z.textContent = 'Komisyon oranı geçersiz.';
      else { const s = Math.ceil((m + k) * 100 / (100 - o)); z.innerHTML = `Zarar sınırı <b>${tl(s)}</b> <small>KDV dahil, stopaj hariç</small>${t !== null && t < s ? ' <span class="bb-hata">Taban bunun altında.</span>' : ''}`; }
    }
  }
  const kuralGovdesi = (form, cid) => ({connection_id: Number(cid), taban: form.taban.value, cekilme: form.cekilme.value, guvenlik: form.guvenlik.value, maliyet: form.maliyet.value, kargo: form.kargo.value, komisyon: form.komisyon.value, yukari_esit: form.yukari_esit.checked, zarar_onay: form.zarar_onay.checked});
  kap.addEventListener('input', e => {
    if (e.target.closest('[data-pencere]')) { ayarOzeti(); return; }
    if (!e.target.matches('[data-ara]')) return;
    arama[e.target.closest('[data-kolon]').dataset.kolon] = e.target.value; ciz();
  });
  kap.addEventListener('change', e => {
    const t = e.target, p = t.closest('[data-kolon]')?.dataset.kolon;
    if (t.closest('[data-pencere]')) { ayarOzeti(); return; }
    if (!p) return;
    if (t.matches('[data-suz]')) { suzgec[p] = t.value; ciz(); }
    if (t.matches('[data-sec]')) { const s = t.closest('[data-sku]').dataset.sku; t.checked ? secim[p].add(s) : secim[p].delete(s); ciz(); }
    if (t.matches('[data-hepsi]')) { for (const k of gorunen(p, baglanti(p))) t.checked ? secim[p].add(k.sku) : secim[p].delete(k.sku); ciz(); }
  });
  kap.addEventListener('click', e => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.matches('[data-kapat]')) { pencere.close(); return; }
    if (t.matches('[data-dene]')) {
      const f = t.form, yer = pencere.querySelector('[data-deneme-sonuc]');
      istek('/dene', {...kuralGovdesi(f, pencere.dataset.cid), fiyat: f.d_fiyat.value, rakip: f.d_rakip.value, sira: f.d_sira.value}).then(s => { yer.textContent = s.degistir ? `Yeni fiyat ${tl(s.yeniCents)}. ${NEDEN[s.neden] || ''}` : `Fiyat değişmez. ${NEDEN[s.neden] || ''}`; }).catch(x => { yer.textContent = x.message; });
      return;
    }
    if (t.matches('[data-sekme]')) { sekme = t.dataset.sekme; ciz(); return; }
    if (t.dataset.magazaSec) {
      magaza = t.dataset.magazaSec; hatirla(magaza); mesaj = ''; hata = false; secim.hb.clear(); secim.ty.clear(); arama.hb = arama.ty = ''; suzgec.hb = suzgec.ty = 'hepsi';
      // Bir platform eksikse telefonda doğrudan onun formu açılır.
      const eksik = Object.keys(PLATFORM).find(p => !baglanti(p)); if (eksik) sekme = eksik;
      ciz(); return;
    }
    if (t.matches('[data-hepsini-durdur]')) {
      const dur = !veri.baglantilar.every(b => b.paused);
      yap(() => istek('/duraklat', {paused: dur}), () => dur ? 'Tüm robotlar durduruldu. Hiçbir fiyat değişmiyor.' : 'Robotlar başlatıldı.');
      return;
    }
    const p = t.closest('[data-kolon]')?.dataset.kolon; if (!p) return;
    const b = baglanti(p);
    if (t.matches('[data-ac]')) { pencereAc(p, t.closest('[data-sku]').dataset.sku); return; }
    if (t.matches('[data-duraklat]')) yap(() => istek('/duraklat', {connection_id: b.id, paused: !b.paused}), s => s.paused ? PLATFORM[p] + ' robotu durduruldu.' : PLATFORM[p] + ' robotu başlatıldı.');
    if (t.dataset.is === 'ilanlar') yap(() => istek('/ilanlar', {connection_id: b.id}), s => `${s.getirilen} ilan getirildi. Yeniler Kapalı başlar, fiyat değişmedi.`);
    if (t.dataset.is === 'sina') yap(() => istek('/sina', {connection_id: b.id}), s => `Bağlantı çalışıyor. ${s.ilan} ilanın ${s.sira_okundu} tanesinde sıra, ${s.rakip_okundu} tanesinde rakip okundu. Alanlar: ${s.alanlar.join(', ') || 'boş yanıt'}`);
    if (t.dataset.is === 'calistir') yap(() => istek('/calistir', {connection_id: b.id}), s => s.hatalar?.length ? s.hatalar.join(' ') : s.atlandi ? 'Çalışacak ilan yok.' : `${s.izlenen} ilan kontrol edildi, ${s.degisen} fiyat gönderildi.`);
    if (t.dataset.toplu) {
      const mode = t.dataset.toplu, skus = [...secim[p]];
      if (mode === 'aktif' && !confirm(`${skus.length} ilanın fiyatı artık otomatik değişecek. Ayarı eksik ya da zarar kilidine takılan ilanlar atlanır. Devam edilsin mi?`)) return;
      yap(() => istek('/toplu', {connection_id: b.id, skus, mode}), s => `${s.secilen} ilandan ${s.degisen} tanesi ${BICIM[mode]} yapıldı.${s.degisen < s.secilen ? ' Kalanların ayarı eksik ya da zarar kilidine takıldı.' : ''}`);
    }
  });
  pencere.addEventListener('close', () => { pencere.innerHTML = ''; });
  kap.addEventListener('submit', async e => {
    const f = e.target;
    if (f.matches('[data-kural]')) {
      e.preventDefault();
      const cid = pencere.dataset.cid, mode = f.mode.value, yer = pencere.querySelector('[data-pencere-hata]');
      if (mode === 'aktif' && !confirm('Bu ilanın fiyatı artık otomatik değişecek. Ayarlar doğru mu?')) return;
      try {
        await istek('/kural', {...kuralGovdesi(f, cid), sku: pencere.dataset.sku, mode});
        pencere.close(); mesaj = 'Kaydedildi.'; hata = false; await yukle();
      } catch (x) { yer.textContent = x.message; }
      return;
    }
    const p = f.closest('[data-kolon]')?.dataset.kolon;
    if (f.matches('[data-yuzde]')) {
      e.preventDefault();
      const b = baglanti(p), yuzde = f.yuzde.value;
      yap(() => istek('/toplu', {connection_id: b.id, skus: [...secim[p]], taban_yuzde: yuzde}), () => `Seçilenlerde taban şu anki fiyatın %${yuzde} altı, çekilme şu anki fiyat oldu. Aktif olanlar izlemeye alındı; kontrol edip yeniden aç.`);
    }
    if (f.matches('[data-baglanti]')) {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      // Bilgiler kaydedilince ilanlar da hemen çekilir: yalnız okur, fiyat değiştirmez.
      yap(async () => {
        const c = await istek('/baglanti', {...d, platform: f.dataset.baglanti, magaza});
        try { return {getirilen: (await istek('/ilanlar', {connection_id: c.connection_id})).getirilen}; }
        catch (x) { return {kayitli: x.message}; }
      }, s => s.kayitli ? `Bilgiler kaydedildi ama ilanlar çekilemedi: ${s.kayitli}` : `Bağlandı, ${s.getirilen} ilan çekildi. Hepsi Kapalı, fiyat değişmedi.`);
    }
  });
  // Ekran açıkken liste tazelenir. Kullanıcı yazarken ya da pencere açıkken ekran altından değişmez.
  const tazele = setInterval(() => {
    if (!root.contains(kap)) { clearInterval(tazele); return; }
    if (document.hidden || mesgul || pencere.open || kap.contains(document.activeElement) && document.activeElement.matches('input,select')) return;
    yukle().catch(() => {});
  }, 60000);
  yukle().catch(e => { govde.innerHTML = `<div class="v2-empty"><h3>Buybox ekranı yüklenemedi.</h3><p>${esc(e.message)}</p></div>`; });
}
