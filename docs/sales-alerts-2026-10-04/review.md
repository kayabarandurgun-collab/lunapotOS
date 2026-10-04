# Final verification and resolution — 2026-10-04

**Verified: all independent findings are resolved in the reviewed local implementation.** This final verification supersedes the initial verdict below; the initial snapshot is preserved verbatim.

The rerun occurred after `src/panorama-api.js` began passing `historyPartial: eksik.some(x => x.from <= today)` to the sales engine, alongside the separate current-window partial flag.

- Independent review suite: **30/30 passed**, zero failures or skips.
- Focused existing sales tests for historical/current read failures, hidden older siblings, and pending/future exclusions: **5/5 passed**, zero failures or skips.
- Previously failing R05/R06/R27 (split-order boundary), R08 (future customer returns), R15/R30 (contradictory return chronology), and R22 (unsafe linked proposal quantity) all pass. Same-day ambiguity, the below-minimum R19 supplier fixture, and incomplete empty-state checks also pass.

The focused database tests confirm that an older failed read blocks price advice with explicit historical-incompleteness evidence, including when it hides a profitable or unknown sibling. Current-period totals remain unchanged. Pending-only and future-only read failures do not incorrectly block current sales alerts.

Commands executed:

```text
node --test --test-reporter=spec tests/insight-alerts-review.test.js
node --test --test-reporter=spec --test-name-pattern='historical-read guard|actual panorama read failure|pending/future read failures' tests/sales-alerts.test.js
```

This follow-up changed only this report. Implementation and tests were read/run without edits. Full-suite, browser, and deployment checks remain with the parent.

---


# Independent sales/stock intelligence review — 2026-10-04

**Verdict at last full run: changes required.** Added 30 independent adversarial cases in `tests/insight-alerts-review.test.js`. Only that file and this report were written. Implementation files remain owned by the parent/engine agents.

Validation: `node --test --test-reporter=spec tests/insight-alerts-review.test.js` — **23 passed, 7 failed**, no skips. The subsequent R19 fixture adjustment passed its isolated rerun (1/1). Concurrent implementation changes are in progress; these results describe the reviewed snapshot, not a claim about subsequent fixes.

Fixtures run the actual migrations in disposable in-memory SQLite, including performance/panorama, warehouse demand queries, pricing options, and authenticated worker permission checks. No real database, network, Git, deployment, or preview process was used.

| Priority | Reproduced finding | Evidence and required behavior |
| --- | --- | --- |
| **P1** | A split order becomes a false recurring loss at the 30-day boundary. | **R05, R06, R27 fail.** An older fragment contributes +101 cents and the current fragment −100, but the engine discards the older fragment and recommends increasing price. An older unknown fragment likewise becomes falsely known. `src/sales-alerts.js:66` filters packages before order aggregation. R27 reproduces this through actual panorama. Combine known sibling evidence before assessing an in-window order, or mark the boundary order incomplete. Owner: sales agent. |
| **P1** | Future customer returns are announced as current recurring returns. | **R08 fails:** three delivered sales with returns dated tomorrow produce one returns alert today. The authoritative `src/performance-api.js:172` sales/returns query has no return-date cutoff, and presentation aggregates those returns. Filter or flag chronology before consuming the aggregate; do not manufacture current return occurrences from future events. Owner: sales agent. |
| **P1** | The alert suppresses a purchase quantity but its linked replenishment plan restores it. | **R22 fails:** source-changed shipment evidence yields null days/quantity in the alert, yet `warehouseReplenishment().proposals` recommends **6000 milli (6 units)**. `src/warehouse-api.js:55` calls the legacy proposal formula with demand alone, losing history incompleteness. Apply the same evidence gate to the plan. Owner: stock agent. |
| **P2** | Returns predating their own physical sale are treated as usable history. | **R15, R30 fail:** both a genuine restock and a technical substitution reversal dated before their parent sale leave history `short` rather than incomplete, with calculable days/quantity. `src/stock-alerts.js:28` validates the stock movement but not this chronology. Flag contradictory dates and suppress projections. Owner: stock agent. |

**Same-day chronology:** R24–R26 now pass: mixed results on the latest delivery date, a sixth same-day large profit, and a mixed-result tie at the fifth-order boundary cannot use lexical order IDs as chronological evidence. No UUID/order-number chronology is assumed by these assertions.

**Other verified protections:** aggregate sales-item shape; cent-level loss; same-channel distinct orders; split-package recovery; unknown later orders; partial set-component returns; real pricing mapping/channel/unit identity; complete sales-alert removal for amount-denied staff over the worker API; non-restocking refunds; valid backdated return windows; future ordinary/technical stock returns; stale duplicate corrections; mixed-unit sets without duplicate consumption or transit subtraction; archived-product exclusion; and recommendation removal after a physical replenishment.

R19 now uses **1000 milli available against a 2000 milli minimum**, so its supplier/brand assertion requires a real shortage and does not restore plentiful-stock/no-history card spam. R20 checks the incomplete empty-state meaning and warning rather than exact notice wording; R20/R21 pass after concurrent parent UI updates. Browser interaction remains with the parent.

Adversarial set is ready. The seven red assertions remain executable regressions for the four findings above; no implementation fixes were applied here. Stop here and let the owning agents apply fixes, then rerun this same file.
