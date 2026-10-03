# Operations rebuild audit — 3/4 October 2026

Repo: `C:/Users/baran/Desktop/site/lunapot-panel`. Bounded operations sidecar; parent owns UI and combined release. Previous FA01–05 read first and preserved. **6 newly demonstrated issues fixed; no migration, live writes, UI changes, commit or deploy.**

## Verified findings

| ID | Before (synthetic real SQLite + actual handlers) | After | Code |
|---|---|---|---|
| OP01 | Two requests read the same order as absent and created **2 undeclared packages**. Concurrent retry of identical source failed with 409. | Atomic package insert creates **1 package**. A different undeclared package gets 409; identical retry returns the same ID. Losing request creates no lines/components/reservations. Declared splits, cancelled orders and different channels retain their rules. | `src/orders-api.js:47` and `:68` |
| OP02 | Invoice A on document A/page 1 was reported **already_linked:1** when asked to link it to document B/page 1, although B had no such link. | **already_linked:0, conflicts:1**. Other valid requested pages still link. Page lookup is scoped to its document. | `src/purchase-document-api.js:443` |
| OP03 | Two concurrent requests both reported success linking the same document to different invoices, although only one UPDATE wrote. Conversely, two documents could claim one invoice. | Exactly **1 success + 1 explicit 409**, and returned invoice ID matches the saved link. Atomic UPDATE includes the invoice exclusivity check and tests RETURNING output. | `src/purchase-document-api.js:409` |
| OP04 | A replacement upload rejected as duplicate still cleared the original document's ETTN (`uuid → ''`). A later insert failure could strand the original identity too. | UUID remains unchanged on rejection/failure. Releasing the old identity and inserting its replacement are one transaction. Page-linked documents also count as already attached and cannot surrender ETTN. Original bytes remain immutable. | `src/purchase-document-api.js:316–356` |
| OP05 | Concurrent page retries/competing links threw raw UNIQUE database errors. | Exactly **1 new link**; identical retry reports already linked; competing request reports a reviewable conflict. Nothing is moved or overwritten. | `src/purchase-document-api.js:455` |
| OP06 | Older fee transfer computed commission **80 TL**, paused, newer report wrote **30 TL**, then old transfer overwrote it back to **80 TL**. Source change without a newer transfer also wrote stale 80 TL. Concurrent manual corrections were overwritten. | New **30 TL stays 30 TL**. Stale transfer gets 409 and adds no false audit record. Changed source without a current transfer leaves fees unknown (NULL), not stale 80 TL. Manual **12/34/5 TL** commission/shipping/other survives. | `src/report-inbox-api.js:872–889`, `:1033–1065` |

OP06 takes report record count + version sum before calculating (records cannot be deleted; content changes advance version). Each existing write batch uses the existing 0050 write-guard trigger to check source revision, prior fee values/status and invoice allocations, then writes fees and audit together. The same protection covers normal transfers, twin copies and return-fee normalization. One extra read per committed transfer and one guard statement per write batch. Preview adds neither writes nor revision read.

## Verification

- New regression file: `tests/rebuild-operations.test.js`: **15/15 pass**, including original shipping source-change rollback protection.
- Related suite: **240 total, 238 pass, 2 browser/environment conditional skips, 0 fail**. Includes orders, purchase/document flows, reports, report linking, fee transfer, stock history, prior FA regressions and OCR.
- Initial five new tests were all red on original code for outcome reasons (2 vs 1 packages, false success, false already-linked, lost UUID). Page-race additions also failed on raw UNIQUE errors before fixing them.
- OP06 additionally rerun against **HEAD's unmodified report-inbox module** using a temporary Node load hook; shared working files were never reverted. Three red tests, including actual **8000 vs expected 3000 kuruş** and **8000 vs expected NULL**. Temporary loader removed. Current 15 tests rerun green afterward.
- `git diff --check` clean on the three owned source files.
- Local logs: `docs/rebuild-operations-tests.log` and `docs/rebuild-operations-before-fees.log`; synthetic only. Not a separate full-suite certification; parent runs combined checks.

Relevant suite command:

```powershell
node --test tests/rebuild-operations.test.js tests/orders*.test.js tests/*purchase*.test.js tests/*document*.test.js tests/*report*.test.js tests/codex-rapor-*.test.js tests/codex-duz-kesinti.test.js tests/stock-history.test.js tests/financial-audit-2026-10-03.test.js tests/fatura-ocr.test.js
```

## Scope and historical impact

No database/schema migration. Existing `ec_report_write_guard` from **0050** is required and already present in current 0065 deployment. New order/document guards use current tables. No cost, permission, Worker, migration or UI files changed. `report-stock-link-api.js` and `stock-history-api.js` reviewed with their tests but not modified because no additional demonstrated fix was needed in this bounded pass.

No live data examined or repaired by this sidecar. Existing duplicate orders, detached ETTNs, or stale fees are **not automatically cleaned up by deploying this patch**. A future normal report fee transfer can apply its current report amounts, as before. Historical occurrence/financial magnitude remains unmeasured; local reproducibility is not evidence these races occurred live.

Fee source guard is deliberately conservative: any report content change in that store during calculation yields a retryable 409. Atomicity is per existing write batch, not across every batch of a large transfer; earlier successfully guarded batches may already be committed when a later batch asks for retry. Repeating transfer is safe. This is a concurrency audit, not independent accounting/tax certification.

The inspected suspected shipping hole (status update matched zero, subsequent writes) was **not reported as a new corruption bug**: current component/status triggers roll the entire batch back. New guard test confirms quantity **10 → 10**, sales **0**, reservation **1**, status reserved when the source changes just before shipping writes.

## Parent handoff

```yaml
session: lunapot-panel
date: 2026-10-04
status: complete
outcome: SUCCEEDED
goal: Fix demonstrated operations races and document identity errors without changing financial history.
now: Run combined verification and include OP01–06 in the parent redesign handoff/release.
test: node --test tests/rebuild-operations.test.js
done_this_session:
  - task: Atomic order creation and document identity/link results.
    files: [src/orders-api.js, src/purchase-document-api.js]
  - task: Prevent stale report fee writes and false audit records.
    files: [src/report-inbox-api.js, tests/rebuild-operations.test.js]
blockers: []
questions: []
decisions:
  - history: No live repair or migration; fix future operation semantics.
findings:
  - stale_fees: Old 80 TL must not overwrite newer 30 TL.
worked: [Real-schema synthetic transactions, explicit concurrency barriers, HEAD module comparison.]
failed: []
next: [Parent combined tests and release.]
files:
  created: [tests/rebuild-operations.test.js, docs/UX-2026-10-03-REBUILD-operations.md]
  modified: [src/orders-api.js, src/purchase-document-api.js, src/report-inbox-api.js]
```

## Combined-test follow-up: connections fixture (4 October)

Parent's combined run found two `connections.test.js` failures (`orders` was null in source-page import). Root cause was **fixture result shape, not query budget**: its `DB.batch()` executed statements through Node SQLite `run()`, which discarded INSERT RETURNING rows. Production D1 and the other real-schema fixtures return `{results:[...]}`. The new atomic order creator therefore committed a package in this fixture, then failed reading the absent result array; `syncProvider` caught that as an incomplete import and returned `orders:null`.

Fixed `tests/connections.test.js` batch to execute each statement with its existing `all()` wrapper. Query counting still increments once per statement. Transaction rollback is unchanged. No assertions were removed or limits raised; explicit non-null outcome assertions and query diagnostics were added. **First 50-source page: 28 queries. Repeated page: 28 queries. Existing <45 bound passes unchanged.** Both original regression scenarios pass, including the expected package counts and deferred-import progression.

`node --test tests/connections.test.js tests/rebuild-operations.test.js`: **41/41 pass, 0 skip/fail**. Log: `docs/rebuild-operations-connections-tests.log`. `git diff --check` clean. Runtime source needs no compatibility fallback for this inaccurate fixture and was left unchanged in this follow-up. Add `tests/connections.test.js` to this sidecar's modified-file list.
