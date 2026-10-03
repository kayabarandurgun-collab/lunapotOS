# Lunapot Panel — Durum Raporu (3 Ekim 2026)

Bu rapor, projeyi **sıfır bağlamla** devralacak bir ajan için yazıldı. Panel canlıda ve gerçek
para/stok kayıtları tutuyor; aşağıdaki kurallar süs değil, her biri canlıda bir hataya mal oldu.

---

## 1. Nerede ne var

| | |
|---|---|
| Canlı | https://muhasebe.lunapot.com |
| Depo | `C:/Users/baran/Desktop/site/lunapot-panel` (main) |
| **DOKUNMA** | `C:/Users/baran/Documents/Codex/.../lunapot-panel` — eski kopya, 334 commit geride |
| Yığın | Cloudflare Workers + D1 (SQLite), yapı aracı yok, `public/` doğrudan sunuluyor |
| Sürüm | `public/sw.js` içindeki `CACHE` adı — şu an `lunapot-shell-v172-kdv-yirmi` |
| Migration | `migrations/NNNN_ad.sql`, en son **0064** |
| Test | `npm test` → 1077 test, 1062 geçiyor, 15 atlanıyor, **0 düşüyor** |

**Yayın sırası:** migration varsa ÖNCE `node scripts/migrate-remote.mjs`, sonra
`git add src public tests migrations && git commit && git push origin main`.
Cloudflare 2–6 dakikada yayınlar. Çıktığını `sw.js`'teki CACHE adını canlıdan çekerek doğrula.

**UI değiştiyse `public/sw.js` içindeki CACHE adını artır**, yoksa tarayıcılar eski sürümde kalır.

---

## 2. Uyulması gereken kurallar

1. **Canlıya elle SQL YAZMA.** Okuma serbest. Yazma ya uygulamanın kendi ucundan ya da
   versiyonlu migration'dan. Sahibinin açık talimatı.
2. **`git add -A` KULLANMA.** Depoda commit'e girmemesi gereken `.Codex/`, `.claude/`,
   `docs/*.zip`, `kart-idleri.json` duruyor. Hedefli ekle.
3. **Kullanıcının terminali Windows PowerShell 5.1.** `&&` çalışmaz; `npm` ExecutionPolicy'ye
   takılır (`npm.cmd` ya da doğrudan `node`). Komut verirken buna göre yaz.
4. **İddia etmeden önce ölç.** Sahibi iddiaları sorguluyor ve genelde haklı çıkıyor. Bu oturumda
   üç yanlış teşhis ölçümle çürütüldü.
5. **Bilinmeyen sıfır sayılmaz.** Panelin her yerindeki ilke bu: okunamayan alan boş bırakılır,
   tahmin edilmez, ve neden bilinmediği yazılır.
6. **Kilitler ve değiştirilemezlik kasıtlı.** Alış belgesi silinemez, gönderilmiş siparişin satırı
   değiştirilemez, stok hareketi güncellenemez. Baypas etme; gerekiyorsa migration'da dar ve
   gerekçeli bir delik aç ve korumayı **birebir** geri koy.

---

## 3. Bu oturumda yayına alınanlar (v158 → v172)

### 3.1 Sipariş ürün düzeltmesi — ikame ve parasız ilave
Gönderilmiş/teslim edilmiş siparişte "depodan gerçekte ne çıktı" düzeltilebiliyor (örn. 10 L torf
bitince 2 adet 5 L gönderilmiş). **Kalıcı ilan eşleşmesine dokunmuyor** — aynı ilanın sonraki
siparişi eskisi gibi eşleşiyor.

Tasarım: ciro **asıl bileşende kalır**, düzeltme bileşeninin gelir payı 0'dır. Böylece satır payı
toplamı 10000'de kalır ve `packageProfit` "complete" sayması bozulmaz. Kesintiler `0` ve
`confirmed` yazılır; `null` bırakılsaydı kâr raporu paketi "kesintisi eksik" sayıp sonucu gizlerdi.

Ters kayıt `DUZELTME-IKAME-` önekiyle yazılıyor. **Bu önekin "iade" sanılmaması için 11 yer
tarandı**; dördü hiç süzülmemişti ve fark edilmeseydi sipariş kargo takibinden sessizce düşecekti.

İlgili: `migrations/0061_*.sql`, `src/orders-api.js`, `public/orders-ui.js`,
`tests/siparis-urun-duzeltme.test.js`.

**Canlıda henüz denenmedi** — sahibi bir ikame yaptığında rakamları doğrulamak gerekiyor.

### 3.2 Fatura OCR (harf taşımayan PDF)
Bazı tedarikçi PDF'lerinde okunacak harf yok. Ölçüldü: bir dosyada **0 metin komutu, 0 font,
16.814 bezier eğrisi** — yazı çizim olarak gömülmüş. Gömülü görüntüleri çıkarmak yetmiyor
(çıkanlar logolardı); sayfanın kendisi rasterize edilmeli.

Çözüm: `pdf.js` ile sayfa resme çevrilip Cloudflare Workers AI'ye okutuluyor.
Model **`@cf/moondream/moondream3.1-9B-A2B`** (türü *Image-to-Text*).

> Önce `@cf/google/gemma-4-26b-a4b-it` denendi: hesapta var ama Workers AI türü *Text Generation*
> ve OpenAI biçimli `messages/image_url` girdisiyle **dakikalarca askıda kaldı**.
> Model seçerken `wrangler ai models` ile **türe bak**.

Sayfalar tek tek gönderiliyor (gövde sınırı 1 MB), sığmazsa kademeli küçülüyor, ilk sayfanın
üst %42'si ayrıca büyütülmüş okunuyor (fatura no/tarih tam sayfada okunamıyordu). 50 sn zaman aşımı.

**OCR'ın güvenilir okuduğu:** ürün satırları, tutarlar, tedarikçi VKN, tarih.
**Güvenilir OKUMADIĞI:** fatura numarası (aynı dosyayı üç kez 17/14/hiç okudu, doğrusu 16 hane)
ve ETTN (her okumada farklı). **ETTN bilerek boş bırakılıyor**: biçimi doğru ama yanlış bir ETTN,
boş alandan tehlikelidir — düzgün göründüğü için kimse kontrol etmez.

### 3.3 OCR'lı faturanın otomatik muhasebeleşmesi
"Kesin değil" işaretleri **kaldırılmadı**. Yerine modelden bağımsız üç kanıt aranıyor:
1. VKN, kayıtlı bir tedarikçiyle **birebir** eşleşti (yanlış okunan VKN hiçbir yere tutmaz),
2. fatura numarası o tedarikçinin önceki faturalarının kalıbına uyuyor,
3. **satırların toplamı = belgenin kendi yazdığı toplam** (en güçlü kanıt).

Üçü birden tutmazsa durur. Karar saf ve dışa açık fonksiyonda: `otomatikEngelKarari`
(`public/purchase-document-ui.js`), testleri `tests/fatura-otomatik-kapi.test.js`.

### 3.4 KDV %20
Sahibi bütün faturalarını %20 ile kesiyor. Satış KDV'si artık **pazaryerinin raporundan değil**,
`workspace_settings.sales_vat_bps` ayarından geliyor (varsayılan 2000). Oran koda gömülmedi:
KDV oranları kanunla değişiyor.

Geçmişteki 18 satır (%10, 14.606,85 TL brüt) %20'ye çekildi: brüt değişmedi, KDV hariç ciro
**13.278,97 → 12.172,38 TL** düştü. Kârın azalacağı sahibine sayıyla söylendi ve onaylandı.
`ec_order_line_lock` yalnız bu düzeltme için düşürülüp birebir geri kondu (`migrations/0064_*.sql`).

### 3.5 Diğer
- **ETTN devri:** işlenmemiş bir belge, aynı faturanın düzgün hâlinin önünü kesmiyor artık.
- **Stopaj metni:** stopaj yüzünden tahmini olanlar ayrı cümlede — o rakam hiçbir belgeyle
  kesinleşmez (Trendyol stopajı hiç bildirmiyor), ekran her gün boşuna "belge bekleniyor" diyordu.
- **PDF uyarısı** sebep uyduruyordu ("büyük olasılıkla taranmış"); ölçüldü, dosya taranmış değildi.
- **Tutar ayıklama:** model `2.850,00`'ı `2,850,00` yazıyordu ve tarayıcı bunu ikiye bölüp
  15 adetlik kalemi **2,85 TL** okuyordu.

---

## 4. Kanıtlanmış en önemli bulgu

**Harf taşıyan özgün e-fatura PDF'inde sistem sıfır dokunuşla çalışıyor.**
3 Ekim'de canlıda kanıtlandı: `2731455087-KRK2026000000927-...pdf` yüklendi; hiç model çalışmadan
fatura no, tarih, ETTN, satıcı VKN, unvan, 4 satır ve toplamlar birebir okundu, fatura
**kendiliğinden muhasebeleşti** (borç + stok) ve eksiye düşmüş iki ürün (Torf 2,5 L ve 10 L,
ikisi de −1) düzeldi.

OCR yalnız **yedek yoldur**. Tam otomasyonun gerçek yolu tedarikçiden düzgün dosya istemektir —
kod tarafında daha fazla uğraşmak bu sonucu değiştirmez.

---

## 5. Açık işler

### Sahibinde (kod işi değil)
1. **Tedarikçilerden e-fatura PDF'i iste.** Tam otomasyonun tek gerçek yolu.
2. **Pina Small 2 L saksının fiyat profili yok** (38 üründe tek). Hiç satılmamış ama bir ilana
   bağlı. Profil yalnız KDV değil; ambalaj, ölçü, ağırlık da zorunlu ve sıfırdan büyük olmalı.
   **UYDURMA** — uydurma ölçü kargo tarifesi hesabını sessizce bozar.
3. **Seçkin TS1/Plug Mix ay sonu işi** vadesinde: 2 adet Plug Mix iadesi + yeni TS1 faturası,
   sonra `urun-duzeltme:plugmix-ts1-2026-09-23` referanslı hareketler ters kayıtla geri alınacak.
   **Dikkat:** TS1 210 L stoğu 1 ve bekleyen bir TS1 satışı var (HB 4496993205).

### Doğrulanacak
4. HB 4496993205 (TS1) bir sonraki rapor turunda aktarıldı mı — ilan bağlantısı kuruldu
   (`HBCV00007FH2PA` → `KL-TS1-210L`).
5. **Sipariş ürün düzeltmesi canlıda hiç denenmedi.** İlk ikamede ölç: eski ürün rafa döndü mü,
   yeni düştü mü, ciro değişmedi mi, sipariş "İade edildi" görünmüyor mu.

### İzlenecek
6. 9 paket 7+ gündür kargoda (biri 15 gün; sahibi "sorun yok" dedi).
7. Otomatik bakım turu kesinti taşımasını sayfa sayfa yapıyor; birikirse
   `src/otomatik-bakim.js` süre bütçesine bakılmalı.
8. Bütün kargo tarifeleri **31.12.2026**'da bitiyor.

---

## 6. Cloudflare bütçesi — rahat

30 günlük ölçüm: D1 okunan satır **392,6M** = aylık hakkın **%1,6**'sı; Worker isteği 47.471 =
**%0,5**; depolama 173 MB. Tek D1, iki worker, R2 açılmamış, KV boş. Sıkışıklık yok.

---

## 7. Tekrarlanmaması gereken hatalar

- Model seçerken **türünü doğrulamadan** belgeye güvenmek (gemma askıda kaldı).
- **pdf.js** API'sini varsaymak: `destroy()` belgede değil, yükleme görevinde. `finally` içindeki
  hata, başarıyla çevrilmiş sayfaları çöpe atıyordu.
- Prompt'a **örnek rakam** yazmak: model `1.234,56` örneğini okumuş gibi yanıtına yazdı.
- `get_page_text` ile **form kontrol etmek**: input *değerlerini* göstermiyor, "alanlar boş kaldı"
  diye yanlış teşhis kondu. DOM'dan `value` oku.
- `wrangler.jsonc`'ye **yorum eklemek**: `scripts/recovery.mjs` onu düz `JSON.parse` ediyor.
- Veri düzelten migration'da **sıra**: önce satırı güncelleyip sonra ona göre süzmek bütün
  satırları kapsar; süzgeç eski işareti kullanmalı.

---

İlgili devir dosyası:
`thoughts/shared/handoffs/lunapot-panel/2026-10-03_18-12_siparis-duzeltme-fatura-ocr-kdv-yirmi.yaml`
