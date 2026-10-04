# Independent business workflow review — 2026-10-04

Status: review complete. Latest combined verification: **35 passed, 0 failed**. **No open proven findings in the reviewed scope.** R1, R2, and R3 were reproduced, reported during the review, then fixed concurrently by the implementation team; all three unchanged reviewer regressions now pass. No P0/P1 or cross-namespace/personnel amount leak was demonstrated in the tested paths.

Scope: `src/money-planning-api.js`, `src/warehouse-api.js`, migration 0067, source ledger/performance accounting, and parent permission mappings/Worker dispatch. Reviewer authored only this report and `tests/business-workflows-review.test.js`; no implementation or other tests were edited. All execution used synthetic in-memory SQLite. No Git, live data, network, deployment, or historical repair.

## Calendar finding fixed concurrently and independently verified

### R3 — P2: lifetime payment history blocks even an empty one-day money calendar

Original locations: `src/money-planning-api.js:58` (unfiltered party-entry read), `:22` (25,000-row cap), and `:88` (payment exclusion after retrieval). The corrected query is still near line 58.

Before the fix, the calendar retrieved every unreversed party entry before discarding `cash` and `legacy_payment` entries in JavaScript. Once this history exceeds 25,000 rows, `readRows` throws 409 before it can exclude those irrelevant entries. Selecting a shorter interval cannot affect the underlying query.

**SQLite reproduction:** insert 25,001 valid January `legacy_payment` entries; request only September 20. Expected: an empty calendar because none of those historical payments constitutes an expected receipt or payment. Actual: 409, “Kayıt sayısı fazla. Tam sonuç için tarih aralığını daraltın.” Every date selection remains unavailable for that workspace. This is an availability defect, not silent subtotal truncation.

**Resolution observed:** the implementation filters paid/ineligible entries before the capped read while retaining pending cheques and open balances. The generated schedule-reference read is also restricted to the selected months and relevant schedules. The original 25,001-payment reproduction now passes, together with cheque settlement, calendar pagination, and schedule deduplication controls. Reviewer did not make these edits.

**Regression:** `review R3: irrelevant lifetime payments cannot exhaust a one-day calendar row budget`, `tests/business-workflows-review.test.js:174`. Now passes unchanged in the latest combined run.

## Findings fixed concurrently and independently verified

### R1 — P2: stock-count losses truncated fractional cents

Original location: migration 0067, `ec_warehouse_count_review`, line 53.

Counting 10 units valued at 10,009 cents down to 8 produced a preview and persisted stock movement of −2,001 cents and a loss expense of 2,001 cents; proper rounding gives −2,002 / 2,002. SQLite integer division discarded the fraction before `ROUND`. This copied an existing count formula's behavior into the new workflow; the demonstrated impact was one cent per affected count line.

**Resolution observed:** the implementation now promotes the numerator to REAL with `* 1.0`. The original reviewer regression at test line 52 now passes, verifying preview, persisted movement, and expense. Reviewer did not make this edit.

### R2 — P2: recount validated against the obsolete product unit

Original location: `src/warehouse-api.js`, save-lines unit validation/rebase. Current validation is around line 134.

Using public handlers: create a new kilogram product without movements, save a count of 1500 milli, change its unit to `adet` (permitted before movements), then save with `recount: true`. Ordinary review rejected the unit change, but explicit recount validated against the obsolete kilogram unit, captured the new piece unit, and allowed review/application of **1.5 discrete items**.

**Resolution observed:** recount validates against the current unit; migration guards also reject fractional piece counts. The unchanged reviewer regression at test line 63 now passes. Reviewer did not make these edits.

## Verification

Combined command:

```text
node --test tests/business-workflows-review.test.js tests/warehouse-workflows.test.js tests/business-workflows-permissions.test.js tests/ledger.test.js tests/purchase-returns.test.js tests/package-profit.test.js
```

Result after the concurrent fixes: **35 total, 35 passed, 0 failed**. Independent review file: **10/10 passed**. All 25 existing tests in this targeted run passed. The three finding regressions assert correct behavior and passed without weakening their assertions; none is skipped or marked TODO.

Additional migration validation: apply the actual migration chain, splitting 0067 with local Wrangler `unstable_splitSqlQuery`: **16 statements**, `PRAGMA foreign_key_check` empty, `PRAGMA integrity_check` = `ok`.

Independently verified behaviors:

- General invoice service credits/reversals affect their own dates exactly once; original expense plus correction agrees with net totals.
- Delivered marketplace contribution matches the authoritative performance engine. Product cost is deducted once; other-channel sales are excluded; unallocated sales-fee invoices are not subtracted again as overhead and prevent a final result.
- Partial cash settlement plus pending cheque does not duplicate expected debt; linking cheque payout moves it from expected to recorded cash.
- Cash reversals retain their own occurrence dates and cancel when both dates are selected.
- Planned net expenses are not added to gross cash; generating a scheduled expense does not duplicate its plan row. Users lacking expense permission receive no expense/schedule rows.
- Calendar pagination includes all 501 relevant entries; identical EC/LP identifiers remain isolated. Calendar/result reads do not mutate SQLite.
- Real Worker login/session tests reject money views without amount permission and deny cross-workspace access. Warehouse count snapshot, change, and summary monetary values are null while quantity remains visible; read-only staff cannot review/apply counts.
- A reservation introduced after review blocks count application without posting any partial movement.
- Existing SQLite tests additionally cover stale stock/value snapshots, net-zero intervening movements, concurrent saves, repeated/concurrent application, late-trigger rollback, FIFO consistency, allocation reversals, purchase returns, and namespace guards.

Limits: targeted local review, not an exhaustive proof of every production history. No browser/UI review, load benchmark, external integration, live database, or deployment was performed. No import/syntax failure was encountered. Source was being modified concurrently, so resolution claims refer to the executed tests above.

## Continuity

```yaml
---
session: business-workflows-independent-review
date: 2026-10-04
status: complete
outcome: SUCCEEDED
---
goal: Independently review new business modules and preserve executable findings
now: Parent can continue integration and UI verification; all reviewed fixes pass
test: node --test tests/business-workflows-review.test.js
done_this_session:
  - task: Review source semantics, reproduce defects, verify concurrent fixes
    files: [tests/business-workflows-review.test.js, docs/system-upgrade-2026-10-04/review.md]
blockers: []
questions: []
decisions:
  - ownership: Only the authorized report and independent test file were written
findings:
  - R3: Lifetime-history calendar failure fixed and independently verified
  - R1_R2: Concurrent implementation fixes verified by unchanged regressions
worked: [Actual Desktop repository, escalated shell, in-memory SQLite, real Worker sessions]
failed: []
next: [Parent integration and UI verification, retain the independent regressions]
files:
  created: [tests/business-workflows-review.test.js, docs/system-upgrade-2026-10-04/review.md]
  modified: []
```


## Independent extension — party dossiers and workbench (2026-10-04)

**Complete: no new proven high-impact permission, namespace, race, or data-loss defect in this bounded check.** Six additional independent SQLite tests pass; the existing dossier/workbench suites also pass **29/29**. Total extension evidence: **35 passing tests, 0 failures** across two executed commands. This does not claim exhaustive coverage.

Reviewed `src/party-profile-api.js`, `migrations/0066_party_profiles.sql`, `src/workbench-api.js`, `migrations/0068_workbench.sql`, and their parent permission/Worker dispatch boundaries. The reviewer added only `tests/business-dossiers-review.test.js` and appended this report. No implementation or existing test was edited. Money/warehouse probes were not repeated. No Git, network, live data, deployment, or historical repair.

### Independent checks and outcomes

1. **Real Worker permission boundaries.** An authenticated EC staff member with ledger/stock write but no amount or invoice access cannot read raw dossier notes, file lists, file bytes, invoice details, LP dossiers, private invoice tasks, or their audit snapshots. Changing a task's claimed feature cannot acquire access. Forged actor fields are rejected; permitted task writes record the authenticated actor. Banks, discounts, and minimum order amounts are redacted; a permitted metadata patch preserves their original stored values.
2. **Identity isolation.** EC and LP use identical party, note, and source-task IDs in the fixture. Editing EC leaves LP data and audit versions unchanged. Audit snapshots carry the correct namespace. A sealed attachment cannot be read under another party or workspace. All underlying supplier, invoice, ledger, cash, and stock rows remain unchanged by dossier/task metadata operations.
3. **Concurrent profile edits.** A restricted metadata writer and an owner changing protected financial terms submit the same revision. Exactly one wins; the other receives 409. Retrying with the current revision preserves both the metadata and the latest protected fields, without partial overwrite.
4. **Attachment failure rollback.** An injected SQLite chunk-insert failure rolls back the file's revision and write token as well as the chunk. Unsealed bytes remain inaccessible. Retrying succeeds; sealing verifies the bytes, and later chunk modification/deletion is blocked.
5. **Task/audit atomicity.** An injected audit-insert failure rolls back the task's title, notes, status, and version. Two concurrent retry edits produce exactly one winner and one 409, with one complete new audit snapshot. Audit and task history deletion remain blocked.
6. **Missing source preservation.** When a synthetic draft invoice disappears, its saved workbench task remains visible as `unavailable`, preserving its note, revision, and audit. It is neither falsely marked resolved nor silently deleted; a subsequent completion attempt is rejected.

### Executed validation

```text
node --test tests/business-dossiers-review.test.js
```

**6/6 passed**, using the actual complete migration chain and in-memory SQLite, including real Worker authentication for the permission test.

```text
node --test tests/party-profile-api.test.js tests/workbench.test.js
```

**29/29 passed**. These existing suites additionally exercise migration 0066/0068 through the actual Wrangler SQL splitter, ledger-derived dossier totals, file digest/signature checks, archived records, staff assignment eligibility, capped source listings, source reopening, optimistic edits, and task immutability.

The parent-assigned **LP workbench 500** was not investigated or fixed again. Its existing integrated Worker regression passes in the source version observed during this extension; ownership remains with Poincare/parent. No import/syntax blocker occurred.

Next: parent continues its integration/UI work. Retain the six independent regressions. There is no additional implementation action requested by this bounded extension.
