## Checkpoints
<!-- kraken: cari ödeme (fatura borcu, ödeme, çek, ay sonu planı) -->
**Task:** Alış faturası -> cari borcu, banka zorunlu olmayan ödeme, çek vadesi, planlanan ödeme, toplu ödeme, durum rozetleri
**Last Updated:** 2026-09-21

### Phase Status
- Phase 1 (Tests Written, tests/cari-odeme.test.js): VALIDATED (12 tests; 10 failed before the fix)
- Phase 2 (Migration 0053 + API): VALIDATED
- Phase 3 (UI: business-ui payments tab, accounting-ui badge): VALIDATED
- Phase 4 (Full suite + build): VALIDATED

### Validation State
```json
{
  "new_tests": 12,
  "suite_total": 810,
  "suite_pass": 795,
  "suite_skipped": 15,
  "suite_fail": 0,
  "build": "wrangler deploy --dry-run OK",
  "last_test_command": "npm test",
  "last_test_exit_code": 0
}
```

### Resume Context
- Not deployed. `npm run db:remote` (migration 0053) must run before `npm run deploy`.
- After deploy the owner runs "Eksik fatura borçlarını tamamla" once for the 38 live invoices.
