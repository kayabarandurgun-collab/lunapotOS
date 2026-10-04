# Dashboard workflow verification — 2026-10-04

Run: 2026-10-04T14:57:28.172Z → 2026-10-04T14:57:42.824Z. Origin: http://127.0.0.1:18732. Chrome: 154.0.8037.97.

**21/21 workflow cases passed; 0 failed.** Verified against the running synthetic preview at the timestamp shown; results apply to the listed local cases.

## Scope and isolation

- Owned files: tests/dashboard-workflows-browser.test.js, public/money-planning.css, public/workspace-design.css, this document, and PNG screenshots in workflow-checks/.
- Parent-controlled synthetic populated preview and coordinated restart; actual worker, routes, API responses and browser modules. No mock API responses or human restart confirmation is implied.
- Fresh browser contexts at desktop 1440×1000 and mobile 390×844; owner and no-amount reader.
- GET/HEAD-only browser guard, same loopback origin, service workers blocked. No reset, restart, git, deployment or live query.
- Report uses an in-memory synthetic CSV; handoff stops at column mapping. Invoice review, count and unbilled forms, warehouse, cari, calendar and workbench are opened/explored without saving.
- Blocked non-read/external attempts: 0. Browser errors: 0.
- Coarse fixture counts before: {"packages":71,"delivered":60,"pending":10,"products":10,"webOrders":4}; after: {"packages":71,"delivered":60,"pending":10,"products":10,"webOrders":4}. These counts alone do not prove the absence of every possible mutation.

## Reproduce

```powershell
Set-Location 'C:\Users\baran\Desktop\site\lunapot-panel'
$env:DASHBOARD_PREVIEW_URL='http://127.0.0.1:18731'; node --test tests/dashboard-workflows-browser.test.js
```

The opt-in variable is required; the normal test suite skips this browser test. Start/restart is intentionally not part of the command. Rerun only when requested after the parent changes the UI.

## Results

| Viewport | Role | Workflow | Result | Evidence |
| --- | --- | --- | --- | --- |
| 1440 | owner | dashboard | PASS | Populated dashboard rendered; no legacy layout/card-count assertions. |
| 1440 | owner | report-handoff | PASS | Retained filename, orders kind, original column headers and one parsed row reached the existing mapper after store selection. No mapping-save, file-upload or apply was submitted. |
| 1440 | owner | purchase-invoice | PASS | Existing populated invoice opens in the real review dialog; posting, payment and upload are untested. |
| 1440 | owner | physical-stock | PASS | Physical total input updates the count difference preview; no stock movement saved. |
| 1440 | owner | unbilled-entry | PASS | Dashboard action opens unbilled entry and updates incoming quantity preview; no receipt/debt saved. |
| 1440 | owner | warehouse | PASS | Both warehouse tabs load real preview data; no counting session created or applied. |
| 1440 | owner | cari-dossier | PASS | Actual cari list link opened Örnek Bahçe Ürünleri — sentetik tedarikçi; information and invoice tabs loaded without edits. |
| 1440 | owner | payment-calendar | PASS | Expected-payment filter and previous-month control update the actual calendar. |
| 1440 | owner | workbench | PASS | 1 task cards rendered from preview data. Task editor opens and cancels; no task metadata persisted. |
| 390 | owner | dashboard | PASS | Populated dashboard rendered; no legacy layout/card-count assertions. |
| 390 | owner | report-handoff | PASS | Retained filename, orders kind, original column headers and one parsed row reached the existing mapper after store selection. No mapping-save, file-upload or apply was submitted. |
| 390 | owner | purchase-invoice | PASS | Existing populated invoice opens in the real review dialog; posting, payment and upload are untested. |
| 390 | owner | physical-stock | PASS | Physical total input updates the count difference preview; no stock movement saved. |
| 390 | owner | unbilled-entry | PASS | Dashboard action opens unbilled entry and updates incoming quantity preview; no receipt/debt saved. |
| 390 | owner | warehouse | PASS | Both warehouse tabs load real preview data; no counting session created or applied. |
| 390 | owner | cari-dossier | PASS | Actual cari list link opened Örnek Bahçe Ürünleri — sentetik tedarikçi; information and invoice tabs loaded without edits. |
| 390 | owner | payment-calendar | PASS | Expected-payment filter and previous-month control update the actual calendar. |
| 390 | owner | workbench | PASS | 1 task cards rendered from preview data. Task editor opens and cancels; no task metadata persisted. |
| 1440 | reader | reader-no-amounts | PASS | 2 successful dashboard API responses inspected for monetary keys; currency-formatted amounts absent from main content. |
| 390 | reader | reader-no-amounts | PASS | 2 successful dashboard API responses inspected for monetary keys; currency-formatted amounts absent from main content. |
| HTTP | reader | reader-direct-apis | PASS | GET only. Monetary amounts, margins, revenue shares and other protected fields must be redacted or denied (403). VAT and commission_rate_bps/komisyon_oran_bps/oran_bps are intentionally allowed by existing policy. The audit accepts those metadata fields both visible and null. |

## Actionable failures

No failures in this bounded verification.

## Reader API evidence

Existing no-amount contract retains amounts/margins/revenue-share protection while permitting VAT and the three commission-rate metadata aliases. See tests/komisyon-orani.test.js:177 and src/permission-policy.js MONEY_NAMES.

| Endpoint | HTTP | Exposed protected money fields |
| --- | ---: | --- |
| /api/ec | 200 | None found |
| /api/ec/panorama | 200 | None found |
| /api/ec/performance | 200 | None found |
| /api/ec/urun-karlilik | 200 | None found |
| /api/ec/purchases | 200 | None found |
| /api/ec/ledger | 200 | None found |
| /api/ec/party-profiles/608de7c1-040b-495b-8469-784714ab9165 | 200 | None found |
| /api/ec/warehouse | 200 | None found |
| /api/ec/workbench | 200 | None found |
| /api/ec/money-calendar | 403 | None found |
| /api/ec/business-result | 403 | None found |

### Commission-rate metadata — existing intentional policy

- /api/ec/performance: 28 allowed commission-rate values observed; examples: $.rows[0].commission_rate_bps=1400; $.rows[1].commission_rate_bps=1400; $.rows[2].commission_rate_bps=1400; $.rows[3].commission_rate_bps=1400; $.rows[4].commission_rate_bps=1400; $.rows[5].commission_rate_bps=1400
- /api/ec/urun-karlilik: 67 allowed commission-rate values observed; examples: $.rows[0].komisyon_oran_bps=1500; $.rows[0].komisyon_donemler.son_30.oran_bps=1500; $.rows[0].komisyon_donemler.tum.oran_bps=1500; $.rows[0].komisyon_kanallar[0].oran_bps=1500; $.rows[0].komisyon_kanallar[0].donemler.son_30.oran_bps=1500; $.rows[0].komisyon_kanallar[0].donemler.tum.oran_bps=1500
The established regression explicitly requires no-amount staff to see commission_rate_bps, komisyon_oran_bps and nested oran_bps while commission amounts and revenue remain hidden. The proposed rate-hiding change was reverted by the parent; existing policy is retained. This audit exempts exactly those commission fields and VAT metadata. Margins and revenue shares remain protected. Allowed fields may be present or null in this bounded amount-disclosure audit; it does not independently require their display.

## Screenshots and layout measurements

Document overflow is checked at both widths. Mobile standalone enabled controls in main, open dialogs and the bottom navigation are checked against 44×44 CSS pixels (0.5px rounding tolerance). In-text inline links and hidden/disabled controls are excluded; native checkbox/radio labels are measured. This is a geometric check, not a full accessibility audit.

| Width | Role | Screen | Overflow | Controls below 44px | Capture |
| ---: | --- | --- | --- | --- | --- |
| 1440 | owner | dashboard | 1440/1440 fits | Siparişleri gör ↗ 132.1×40.2; Şimdi kontrol et 127.9×40.2; Ne zaman uyarır, ne zaman bekler? 1094×38; Tarih 5 Eyl 2026 – 4 Eki 2026 202.3×37.2; Maliyet ve kesintiler ↓ 130.2×36; Bugüne kadar ↓ 101.6×36; Depo ve günlük işler ↓ 134.9×36; Giderler sonrası sonucu gör → 248.7×32; Satış dökümü → 210.3×32; Maliyet dağılımı ↓ 248.7×32; Kesintileri incele ↓ 210.3×32; Ciro 56.1×36; Maliyet ve kesintiler 142.7×36; Kalan 64×36; Grafiğin rakamlarını aç 637.2×38; Maliyet ve kesintilerin paket dökümü 46.5×36; Kayıtlı ve tahmini tutarları ayır 394.8×38; Tüm dönemi aç ↗ 85.6×36; Kâr bırakan 22 266.3×38; Zarar eden 6 266.3×38; Başa baş 0 266.3×38; Hesap bekleyen 0 266.3×38; Hesap kapsamı ve iadeler 27 pakette tahmini tutar 1144×38; Diğer 4 kontrolü göster 619.2×38; Bekleyenlerin kanal dağılımı 412.8×38; Bütün dönemler · nakit, ciro ve zarar 1106×38; Ödeme takvimi → 136.8×40; Giderler sonrası işletme sonucu → 239.9×40; Sayım ve tedarik → 144.8×40; Bu ekrandaki rakamlar neyi kapsıyor? 1144×38 | [PNG](workflow-checks/owner-1440-dashboard.png) |
| 1440 | owner | report-choice | 1440/1440 fits | Günlük işler 103.1×40.2; Sipariş raporu 115.3×40.2; Finans / kesinti raporu 163.6×40.2 | [PNG](workflow-checks/owner-1440-report-choice.png) |
| 1440 | owner | report-source-handoff | 1440/1440 fits | Günlük işler 103.1×40.2; Günlük akışa dön 135.2×40.2; Siparişlere git → 128.4×40.2; Rapor yükle 90.9×40; Dosyalar 73.2×40; İnceleme 74.8×40; Sonuçlar 73.2×40; Mağaza seçin… Hepsiburada · Sentetik hepsiburada mağazası (HB) Trendyol · Sentetik trendyo 499×42; ← Geri (dosya seçimine) 173×40.2; Dosyayı kontrol et 139.5×40.2; Yükledikten sonra ne olur? 1014×32; Alış faturası mı yükleyeceksin? → 1014×19.2 | [PNG](workflow-checks/owner-1440-report-source-handoff.png) |
| 1440 | owner | report-handoff | 1440/1440 fits | Günlük işler 103.1×40.2; Günlük akışa dön 135.2×40.2; Siparişlere git → 128.4×40.2; Rapor yükle 90.9×40; Dosyalar 73.2×40; İnceleme 74.8×40; Sonuçlar 73.2×40; Sipariş raporu Finans / hakediş raporu 291.8×42; — bu dosyada yok — Alan Bilgi 393.2×42; — bu dosyada yok — Alan Bilgi 393.2×42; — bu dosyada yok — Alan Bilgi 393.2×42; — bu dosyada yok — Alan Bilgi 393.2×42; — bu dosyada yok — Alan Bilgi 393.2×42; — bu dosyada yok — Alan Bilgi 393.2×42; — bu dosyada yok — Alan Bilgi 393.2×42; — bu dosyada yok — Alan Bilgi 393.2×42; — bu dosyada yok — Alan Bilgi 393.2×42; — bu dosyada yok — Alan Bilgi 393.2×42; — bu dosyada yok — Alan Bilgi 393.2×42; — bu dosyada yok — Alan Bilgi 393.2×42; — bu dosyada yok — Alan Bilgi 393.2×42; — bu dosyada yok — Alan Bilgi 393.2×42; ← Geri (dosya bilgilerine) 180.5×40.2; Vazgeç 73.1×40.2; Eşleştirmeyi kaydet ve kontrol et 225.8×40.2 | [PNG](workflow-checks/owner-1440-report-handoff.png) |
| 1440 | owner | purchase-invoices | 1440/1440 fits | PDF fatura yükle 374.3×40.2; XML veya elle giriş 374.3×35.2; Mal geldi, faturası henüz yok → 374.3×16.5; Fatura no, ETTN veya tedarikçi ara 957.8×42; Ara 52.6×40.2; Durum ve sıralama 113.6×39.2; İncele → 57.5×40; Ödeme gir → 83.6×40 | [PNG](workflow-checks/owner-1440-purchase-invoices.png) |
| 1440 | owner | purchase-invoice-review | 1440/1440 fits | Kapat 42×42; Kapat 65.9×40.2; Mal teslimi kaydet 139.9×40.2; Tedarikçiye iade 125.8×40.2; Fatura düzeltmesi 136.3×40.2 | [PNG](workflow-checks/owner-1440-purchase-invoice-review.png) |
| 1440 | owner | physical-stock | 1440/1440 fits | ＋ Faturasız mal girişi 163.5×40.2; Depo sayımı yap 129.7×40.2; Diğer depo işlemleri 121×38; Ürün adı, kodu veya marka 1015.5×42; Filtreler ve sıralama 116.5×39.2; Ürün işlemleri 79.8×30.5; Hareketler → 70.3×40; Ürün işlemleri 79.8×30.5; Hareketler → 70.3×40; Ürün işlemleri 79.8×30.5; Hareketler → 70.3×40; Ürün işlemleri 79.8×30.5; Hareketler → 70.3×40; Ürün işlemleri 79.8×30.5; Hareketler → 70.3×40; Ürün işlemleri 79.8×30.5; Hareketler → 70.3×40; Ürün işlemleri 79.8×30.5; Hareketler → 70.3×40; Ürün işlemleri 79.8×30.5; Hareketler → 70.3×40; Ürün işlemleri 79.8×30.5; Hareketler → 70.3×40; Stok miktarlarını nasıl okumalıyım? 1144×38; Kapsam ve stok ipuçları 136.9×38; Satış dönemi ve set sonuçları 1114×38; Son 200 stok hareketi · 2026-09-04 – 2026-10-04 1114×38 | [PNG](workflow-checks/owner-1440-physical-stock.png) |
| 1440 | owner | physical-count-preview | 1440/1440 fits | Kapat 42×42; Ürün seç Hassas köklü bitkiler için ince taneli perlit 5 litre · DEMO-5 (adet) KDV profili 923×42; Sayım: depodaki gerçek toplamı düzelt İlk kurulum: daha önce hareketi olmayan ürün 923×42; quantity 454.5×42; unit_cost 454.5×42; occurred_on 923×43; reference 923×42; notes 923×42; Vazgeç 73.1×40.2; Kaydet 72.7×40.2 | [PNG](workflow-checks/owner-1440-physical-count-preview.png) |
| 1440 | owner | unbilled-entry | 1440/1440 fits | Kapat 42×42; Tedarikçi seç Örnek Bahçe Ürünleri — sentetik tedarikçi 923×42; occurred_on 454.5×43; Örn. IRS-2026-105 454.5×42; Ürün seç Hassas köklü bitkiler için ince taneli perlit 5 litre · DEMO-5 (adet) KDV profili 889×42; quantity 287×42; unit_cost 287×42; vat_rate 287×42; + Başka ürün ekle 138.7×40.2; Vade ve açıklama · isteğe bağlı 893×38; Vazgeç 73.1×40.2; Gelen malı kaydet 137.8×40.2 | [PNG](workflow-checks/owner-1440-unbilled-entry.png) |
| 1440 | owner | warehouse-reorder | 1440/1440 fits | Hesabın dayanakları 1095.6×38; q 1056.8×43; Tedarik ayarları 515.6×38; Tedarik ayarları 515.6×38; Tedarik ayarları 515.6×38; Tedarik ayarları 515.6×38; Tedarik ayarları 515.6×38; Tedarik ayarları 515.6×38; Tedarik ayarları 515.6×38; Tedarik ayarları 515.6×38; Tedarik ayarları 515.6×38 | [PNG](workflow-checks/owner-1440-warehouse-reorder.png) |
| 1440 | owner | warehouse-counts | 1440/1440 fits | Örn. Ekim raf sayımı 514.4×43 | [PNG](workflow-checks/owner-1440-warehouse-counts.png) |
| 1440 | owner | cari-information | 1440/1440 fits | None | [PNG](workflow-checks/owner-1440-cari-information.png) |
| 1440 | owner | cari-invoices | 1440/1440 fits | None | [PNG](workflow-checks/owner-1440-cari-invoices.png) |
| 1440 | owner | payment-calendar | 1440/1440 fits | Ödeme takvimi 115.1×41.5; İşletme sonucu 115.6×41.5; ← Önceki ay 102.6×43; Bu ay 62.5×43; Sonraki ay → 106.2×43; Dönemi göster 117.7×43; Tümü 62.8×43; Beklenen 84×43; Kayıtlı hareket 114×43; Girişler 72.7×43; Çıkışlar 73.5×43; Vadesi geçen 106.9×43; Kapsam ve kayıt yöntemi 1098×37.2 | [PNG](workflow-checks/owner-1440-payment-calendar.png) |
| 1440 | owner | workbench | 1440/1440 fits | Belge yükle 99.9×40.2; Yenile 66.5×40.2; + İş ekle 82.7×40.2; Görev, belge veya sipariş 476.6×43; Açık işler Tarihi geçen Bana atanan Ertelenen Tamamlanan Tümü 238.3×41; Tüm bölümler Web Mağaza Siparişler Satış ve kâr Satış ve kesinti kayıtları Depomdaki ürünl 238.3×41; Göster 70.8×40.2; Teslimatı incele 121.6×40.2; Görevi düzenle 120.3×40.2 | [PNG](workflow-checks/owner-1440-workbench.png) |
| 1440 | owner | workbench-unsaved-task | 1440/1440 fits | Kapat 65.9×40.2; title 606×43; Web Mağaza Siparişler Satış ve kâr Satış ve kesinti kayıtları Depomdaki ürünler Ürün eşleş 606×41; Atanmamış Deniz Örnek — tutar görmeyen ekip üyesi Ece Örnek — davet bekliyor 295×41; Açık Üzerinde çalışılıyor Tamamlandı 295×41; Vazgeç 73.1×40.2; Kaydet 72.7×40.2 | [PNG](workflow-checks/owner-1440-workbench-unsaved-task.png) |
| 390 | owner | dashboard | 390/390 fits | None | [PNG](workflow-checks/owner-390-dashboard.png) |
| 390 | owner | report-choice | 390/390 fits | None | [PNG](workflow-checks/owner-390-report-choice.png) |
| 390 | owner | report-source-handoff | 390/390 fits | None | [PNG](workflow-checks/owner-390-report-source-handoff.png) |
| 390 | owner | report-handoff | 390/390 fits | None | [PNG](workflow-checks/owner-390-report-handoff.png) |
| 390 | owner | purchase-invoices | 390/390 fits | None | [PNG](workflow-checks/owner-390-purchase-invoices.png) |
| 390 | owner | purchase-invoice-review | 390/390 fits | None | [PNG](workflow-checks/owner-390-purchase-invoice-review.png) |
| 390 | owner | physical-stock | 390/390 fits | None | [PNG](workflow-checks/owner-390-physical-stock.png) |
| 390 | owner | physical-count-preview | 390/390 fits | None | [PNG](workflow-checks/owner-390-physical-count-preview.png) |
| 390 | owner | unbilled-entry | 390/390 fits | None | [PNG](workflow-checks/owner-390-unbilled-entry.png) |
| 390 | owner | warehouse-reorder | 390/390 fits | None | [PNG](workflow-checks/owner-390-warehouse-reorder.png) |
| 390 | owner | warehouse-counts | 390/390 fits | None | [PNG](workflow-checks/owner-390-warehouse-counts.png) |
| 390 | owner | cari-information | 390/390 fits | None | [PNG](workflow-checks/owner-390-cari-information.png) |
| 390 | owner | cari-invoices | 390/390 fits | None | [PNG](workflow-checks/owner-390-cari-invoices.png) |
| 390 | owner | payment-calendar | 390/390 fits | None | [PNG](workflow-checks/owner-390-payment-calendar.png) |
| 390 | owner | workbench | 390/390 fits | None | [PNG](workflow-checks/owner-390-workbench.png) |
| 390 | owner | workbench-unsaved-task | 390/390 fits | None | [PNG](workflow-checks/owner-390-workbench-unsaved-task.png) |
| 1440 | reader | reader-dashboard | 1440/1440 fits | None | [PNG](workflow-checks/reader-1440-reader-dashboard.png) |
| 390 | reader | reader-dashboard | 390/390 fits | None | [PNG](workflow-checks/reader-390-reader-dashboard.png) |

## Limits and handoff

- This verifies local synthetic navigation and the listed interactions, not all production features. No payment, posting, durable upload, stock movement, receipt, warehouse apply or task save was executed.
- Successful CSV cases prove retained filename/type and parsed mapper or recognized-profile check step. XLSX/PDF/XML/image processing, OCR, server byte persistence, duplicates and report apply are outside this run.
- Reader checks cover currency-formatted dashboard text, protected money/proportion keys and daily channel cash in successful dashboard responses, and the listed endpoints. VAT and the three intentional commission-rate fields are permitted. Free-text disclosures and unvisited endpoints require separate review.
- Shared preview memory can retain worker code from process startup. At the policy correction, the parent reported that this preview still hid commission-rate metadata pending a final restart. Passing this audit verifies amount protection and permits both visible/null allowed rates; it does not prove the runtime has restored their visibility. This sidecar never restarts the preview.
- Sidecar application edits are limited to the two assigned touch-target stylesheets. Business logic, backend code and dashboard.css belong to the parent/other agents.
- Required tldr-code was read; its CLI is unavailable, so focused source searches were used. No Skill/Task/subagent tool was exposed. Handoff and continuity evidence stay in this owned document to respect the explicit file boundary.
- Handoff: the parent agent controls remaining backend fixes, preview restarts and final full-browser verification. This sidecar has completed the assigned changes; the recorded 21 cases describe the preview at the run timestamp.
