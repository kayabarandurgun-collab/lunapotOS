# Kraken checkpoint — hayalet raf sayımı telafisi düzeltmesi

## Checkpoints
**Task:** thoughts/shared/hayalet-stok-plani-2026-10-06.md — hatalı raf sayımı telafisini düzelt
**Started:** 2026-10-06
**Last Updated:** 2026-10-06

### Phase Status
- Phase 1 (Testler yazıldı, kırmızı doğrulandı): ✓ VALIDATED — 11 yeni test, 9'u kırmızı; mevcut
  hatanın canlı imzası sentetik veride birebir yakalandı (uydurma `kayip` satırı)
- Phase 2a (src/fifo-cost.js `dus` kümesi — planın kalbi): ✓ VALIDATED
- Phase 2b (mekanizma kaldırıldı + stok kartı etiketleri + sw v187): ✓ VALIDATED
- Phase 2c (migrations/0072_sayim_telafisi_geri_alindi.sql): ✓ VALIDATED
- Phase 3 (yerel D1 ölçümü + fifo A/B ölçümü + dry-run derleme): ✓ VALIDATED
- Phase 4 (commit'ler): ✓ VALIDATED

### Validation State
```json
{
  "test_count": 1459,
  "tests_passing": 1426,
  "tests_failing": 2,
  "tests_skipped": 31,
  "failing_are_out_of_repo": ["seed-local-catalog", "store-sync"],
  "baseline_before_work": {"tests": 1448, "pass": 1415, "fail": 2},
  "new_test_file": "tests/hayalet-sayim-telafisi.test.js (10 test)",
  "amended_tests": [
    "tests/report-stock-link.test.js (hatayı doğru sanan beklenti düzeltildi)",
    "tests/codex-rapor-stok.test.js (R05 testi ayar 0 / ayar 1 olarak ikiye bölündü)",
    "tests/ux-2026-10-03-purchase-stock.test.js (3 yeni etiket beklentisi)"
  ],
  "last_test_command": "node --test tests/*.test.js",
  "last_test_exit_code": 1,
  "dry_run": "wrangler deploy --dry-run → 1142.47 KiB, hata yok",
  "local_d1": "0001..0071 + sentetik canlı eşi (341/398000/1349234) + 0072 → 335 ayna / -392000 / -1107500, 13 ürün; TS1 ve Kaktüs dokunulmadı"
}
```

### Ölçülen sayılar
- **fifo-cost.js yaması A/B** (13 ürün, planın §4 adet ve birim değerleri; aynı veri, tek fark yama):
  | fatura/sayım birim oranı | YAMASIZ uydurma kayıp | YAMALI |
  |---|---|---|
  | %100 | 0 satır / 0,00 TL | 0 satır / 0,00 TL |
  | %96  | **13 satır / −230,99 TL** | **0 satır / 0,00 TL** |
  | %104 | **13 satır / +230,96 TL** | **0 satır / 0,00 TL** |
  Yamasız durumda stok bakiyesi de aynı tutar kadar fazla kalıyor (%96'da 14.055,95 yerine
  13.824,96 olmalı): aynı değer hem rafta duruyor hem gider yazılıyor — çift sayım.
- **GECICI-IPTAL- genellemesi** (mükerrer irsaliye iptali, 10 adet): yamasız −50,00 TL, yamalı 0,00.
- **Tam olmayan (kırpılmış) ayna**: davranış bilerek DEĞİŞMEDİ (−28,57 TL) → 0072 kırpma yazmaz.

### Resume Context
- Current focus: yok, bütün fazlar doğrulandı ve commit'lendi
- Next action: işletme sahibi sırayla basacak — ÖNCE kod deploy, SONRA migration (README'nin
  tersi; sebebi plan §6.1: 15 dakikalık cron aynaları eski FIFO ile okur)
- Blockers: bu ortamdan canlı D1'e okuma yetkisi YOK (Cloudflare API 7403). Planın §Uygulama
  adım 2 ve 3'ü (geri alınamaz hâle gelecek 5 teslimin sahibe gösterilmesi ve dokuz sabitin
  yeniden ölçülmesi) YAPILMADI — göçten önce yapılmalı. Göçteki ölçüm kapısı kayma olursa
  SAYIM_TELAFI_OLCUM_DEGISTI ile tamamını geri alır, veri değişmez.
