# Code Review: Historical sold-offering presentation
Generated: 2026-09-20T21:20:02+03:00
Reviewer: critic-agent

## Summary
**Overall Assessment:** Approve within the bounded review scope
**Critical Issues:** 0 outstanding; 2 reproduced and fixed after source ownership handoff
**Suggestions:** 0 additional changes requested

The two pending-allocation failures are fixed. Package totals stay authoritative while listing commissions remain attached to their own offering and component revenue rounding stays within its original listing. The final targeted run passed **37/37 tests**.

Initial review reproduced both failures before source edits: 3 controls passed and 2 regression tests failed. The user subsequently handed over src/sales-presentation.js and bounded src/performance-api.js ownership and explicitly requested implementation. Main received the failing cases and then the completed fix/test handoff through task messaging.

## Review Questions — E(X,Q)
**X:** The sales presentation helper and its performance, panorama, product-profitability and public UI consumers, against docs/SALES-MODEL-2026-09-20.md.

**Q and final results:**
- Correct package totals versus correct offering shares: two counterexamples fixed; assertions now verify individual shares as well as totals.
- Full/failed returns and partial components: controls preserve residual expenses, exact component returns and unknown complete-offering counts.
- Technical corrections: controls exclude them from actual-return counts.
- Historical mapping/name changes: composition identity remains stable.
- Penny reconciliation: listing boundaries are established before component allocation; odd component/VAT cents and shared-expense cents are covered.
- Unknown fees: controls keep them null and exclude them from rankings.
- Existing patterns: the presentation remains read-only; quote data passes privately to the helper, and public response fields are unchanged.
- Test quality: real in-memory API fixtures reproduce the original faults; tests assert expected economics rather than just duplicating the allocation implementation.

## Files Reviewed
- src/sales-presentation.js (233 final lines)
- src/performance-api.js (402 final lines; relevant valuation, integration and pending paths)
- src/panorama-api.js (209 lines; period, returns and pending integrations)
- src/urun-karlilik-api.js (84 lines)
- public/performance-ui.js (269 lines when reviewed; relevant aggregation and rendering)
- public/panorama-ui.js (222 lines when reviewed; rankings and summaries)
- docs/SALES-MODEL-2026-09-20.md
- Supporting quote, fixture and existing test code was read as needed.

Line numbers reflect the reviewed snapshot; other agents can subsequently change them.

## Critical Issues (Must Fix)
None outstanding in the bounded scope.

## Resolved Findings

### Finding 1: [P1] Known listing commissions were replaced with a blended rate
**Location:** src/sales-presentation.js:88-118; src/performance-api.js:226,355,383
**Category:** Logic Error
**Regression:** tests/sales-review.test.js:38

Two draft offerings each have 10000 cents revenue and 1000 cents cost. Their tariff commissions are 1000 and 3000 cents. With no other deductions, the correct offering cash results are 8000 and 6000 cents.

Before the fix, the helper redistributed all 4000 commission cents by revenue and showed 7000/7000. The package total remained 14000 and the UI reconciliation check passed.

**Implemented fix:**
- performanceReport retains the quote's historical line IDs, commission and withholding values in a local pendingLineQuotes map.
- The map is passed into buildSalesPresentation without exposing quote internals in the public response.
- Known line commission plus withholding stays with that line. Only the remaining parcel deduction is shared between offerings.
- Single-line quotes are normalized to the same private input shape.

**Relevant implementation:**
~~~js
const shared = allocate(
  [row.cash_cents, cost, revenue, fixed].every(money)
    ? revenue - cost - row.cash_cents - fixed : null,
  weights
);
~~~

The regression also verifies the compact endpoint and a nonzero shared-expense/withholding case: five packaging cents split 3/2 while 17 withholding cents stay on each listing, producing 7980/5981 and a reconciled 13961-cent parcel.

### Finding 2: [P2] Component rounding transferred a penny between known offering revenues
**Location:** src/sales-presentation.js:68-72,88-105
**Category:** Logic Error
**Regression:** tests/sales-review.test.js:72

A bundle listing has 10001 cents revenue split 50/50 between two components; a separate standalone listing has 10000 cents revenue. The old code independently rounded component amounts and normalized all components across the parcel. It showed 10002/9999 while still totaling 20001.

**Implemented fix:**
- Pending allocations establish listing gross amounts first, using tariff quote gross or saved listing gross, with the existing net/VAT fallback when gross is absent.
- Any difference from the authoritative parcel total is reconciled between listings before component subdivision.
- Each listing amount is split only among its own components, using saved component shares or linked shipment revenue weights.
- Component-rounding residues cannot change another known listing's boundary.

**Relevant implementation:**
~~~js
const lineRevenue = allocate(
  row.revenue_gross_cents,
  groups.map(g => Math.max(0, g.gross_cents ?? 0))
);
groups.forEach((g, i) => {
  const shares = allocate(lineRevenue[i], g.weights);
  g.pieces.forEach((p, j) => { p.revenue_gross_cents = shares[j]; });
});
~~~

The regression now verifies revenue 10001/10000 and cash 8001/9000. At 20% line VAT it also verifies exact gross boundaries 12001/12000 and unchanged parcel reconciliation.

## Suggestions (Should Consider)
None beyond retaining the regression tests.

## Nitpicks (Optional)
None raised.

## Positive Observations
- Historical identity uses saved quantities, units and product IDs instead of mutable names or mapping-version IDs.
- Failed full returns retain zero-unit offering rows and residual cash expenses.
- Partial component returns do not fabricate complete offerings.
- Unknown values propagate through the new fields and rankings.
- The UI consumes server allocations rather than introducing another valuation formula.

## Testing Assessment
**Coverage:** Adequate for the bounded changes.

Final command:
~~~text
node --test tests/sales-review.test.js tests/sales-presentation.test.js tests/order-estimate.test.js tests/codex-kar-ortak.test.js tests/codex-kar-stopaj.test.js tests/panorama.test.js tests/performance-tools.test.js
~~~

**Result:** 37 tests passed, 0 failed, 0 skipped, approximately 3.20 seconds.

Included:
- All 5 independent review tests, strengthened with compact-response, shared packaging, withholding and VAT assertions.
- All 9 existing sales-presentation regressions.
- Pending tariff/source-change and shipment-cost regressions.
- Cross-view valuation, withholding/twin correction, panorama and performance consumer checks.

The initial red run is evidence that the two tests detected the original behavior. The final run is green after the bounded source changes.

No full suite, browser/auth/cari investigation, network/live writes, or Git commands were performed. Main owns integration and its full-suite snapshot. Synthetic tests use only in-memory migrated SQLite and local API calls.

## Pattern Compliance
- [x] Existing fixture, scopedDB and API patterns reused.
- [x] Stable signed integer-cent allocation and explicit null handling retained.
- [x] Parcel totals and the established cost basis remain authoritative.
- [x] Quote information passes privately; no public API field additions.
- [x] Source edits limited to the two handed-off files.
- [x] Other agents' source, UI, browser/auth/cari work preserved.

## Artifacts and Scope
Changed source:
- src/sales-presentation.js
- src/performance-api.js

Owned test/report:
- tests/sales-review.test.js (138 lines)
- docs/SALES-REVIEW-2026-09-20.md

A required critic report copy is saved under .Codex/cache/agents/critic/output-20260920T212002.md. The earlier timestamped review records the pre-fix findings.

## Questions for Author
None outstanding for these two fixes.
