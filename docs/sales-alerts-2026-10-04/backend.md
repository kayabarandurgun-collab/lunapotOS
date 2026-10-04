# Recurring sales alerts: backend contract (2026-10-04)

Implemented directly in `C:/Users/baran/Desktop/site/lunapot-panel`. Ownership: new `src/sales-alerts.js`, the import and response integration in `src/panorama-api.js`, new `tests/sales-alerts.test.js`, and this document. The user later extended ownership to a metadata-only addition in `src/performance-api.js`; its financial formulas are unchanged. UI, permission scrubbing, and warehouse alerts remain parent/other-agent work.

## Entry point and integration

```js
salesAlerts(rows, {today, partial = false, historyPartial = false, unallocatedFeeCents = 0})
```

Pure synchronous export; requires a real `YYYY-MM-DD` calendar date and an array. No clock, database, network, writes, external dependencies, or mutation of input rows. Input is the existing `performanceReport` package rows with canonical `sales_items`; no second financial formula.

Panorama returns this as top-level `sales_alerts`, using its already-loaded channel-filtered delivered/result rows. The alert window is always **today minus 29 days through today, inclusive**, independent of the custom date selection. Orders are grouped by channel and tagged order identity before window selection, using the latest eligible package result date (never a future package result). Every loaded historical sibling of an eligible order is retained, including one delivered before the 30-day boundary. An older profitable or unknown sibling cannot disappear and manufacture a recent loss. A failed delivered-result read marks alerts `partial` only when that read's inclusive interval intersects the alert window. Separately, **any failed historical delivered-result chunk blocks price alerts**, including a chunk wholly before the 30-day window: it could hide an older profitable or unknown sibling. Panorama supplies `historyPartial: eksik.some(x => x.from <= today)`, exposed as `coverage.history_partial` with reason `historical_read_failure`. The existing 30-day `partial` flag retains its original meaning. Pending-read and future-only read failures do not activate this historical guard. Existing period totals and their read-coverage rules are unchanged. No additional queries.

The existing unallocated-fee total is global to the workspace and has no reliable offering/channel/date allocation. Any nonzero value, including negative values, conservatively blocks price alerts even for a selected channel. Invalid/unsafe values also block them. This does not suppress known return/delivery repeats.

## Envelope

```js
{
  as_of, from, to,                     // YYYY-MM-DD; as_of === to === today
  window_days: 30, sample_limit: 5, min_occurrences: 3,
  partial,                            // boolean, read coverage only
  status,                             // complete | estimated | incomplete | empty
  unallocated_fee_cents,              // signed safe integer, or null if invalid
  price_blocked_reason_codes: [],      // partial_read / historical_read_failure / unallocated_fees / invalid_unallocated_fees
  coverage: {},
  alerts: []
}
```

`estimated` means some observed results contain an estimate, including profile cost VAT. `incomplete` takes precedence over other statuses. An empty alert list is **not** a statement that all sales are profitable. Complete coverage also does not mean there are enough orders to meet the recurrence threshold.

## Alert and sample contract

Every alert has:

```js
{
  id,                                 // stable sales-alert:v1: + JSON([type, channel, key])
  type: 'price' | 'returns' | 'delivery',
  channel: 'hepsiburada' | 'trendyol',
  key, name, kind, components,         // canonical sales_items identity, unchanged composition
  from, to,                           // full 30-day window, not just sample dates
  orders, occurrences,                 // distinct order counts; orders <= 5, occurrences >= 3
  loss_cents, net_cents, estimated,
  reason_codes: [],
  samples: [{order_no, package_ids, date, cash_cents, units_milli, kind}],
  package_ids: []
}
```

- Alert `kind` is `single`, `multipack`, or `bundle`. Components are metadata about the sold offering; set components never become standalone recommendations. Same offering on different channels is evaluated separately. Names do not define identity.
- **`loss_cents` is signed negative (or zero/null), never an absolute positive loss.** Price loss is the sum of negative order results in the displayed sample. For returns/delivery it is the sum of the negative corresponding exception effects per order, using existing `return_cash_cents`. A partial return's effect is not confused with the full offering's cash result.
- `net_cents` sums the full offering cash result across all sampled orders, including normal orders in exception samples. It is not a target price, margin, or proposed price increase.
- Sample `cash_cents` is that order's entire offering contribution, across its relevant packages. It is not necessarily the exception effect. Nullable amounts remain null; never display them as zero.
- Sample `kind` is **`returns`**, **`delivery`**, or **`sale`**. Kind classifies the event, independent of whether its money is known. For a split order containing both return and delivery events, the matching alert type takes precedence. Normal orders remain visible in exception samples.
- `units_milli` is the existing remaining offering quantity summed across its packages. Full returns can be zero; partial component returns can be null. No fractional complete sets are manufactured.
- At most five samples, newest result date first, then tagged order identity for deterministic display. A split order's date is its latest eligible package result date across its loaded siblings; package IDs and money still refer to the specific offering being evaluated. Sample package IDs are unique/sorted; alert package IDs are their union. There can be multiple package IDs per sample; no real evidence IDs are truncated.
- Missing/blank `order_no` is returned as null. Internally, package fallback identities are tagged separately from real order numbers; a matching order number and package ID never collide. Package replays and repeated identical line IDs are deduplicated. Conflicting duplicate evidence blocks price analysis and is not counted as a known return/delivery event.
- Unsafe input integers or overflowed exact sums do not produce rounded financial totals. The engine sums with BigInt internally and returns only safe integer numbers or null, never BigInt/Infinity/NaN.

## Decision rules

**Price:** select up to the latest five distinct clean orders for the same channel and canonical offering. At least three must have `cash_cents < 0` (one kuruş counts), the latest must be negative, and the recent net must be negative. One/two isolated losses, a latest recovery including zero, or nonnegative recent net do not qualify.

A customer return, failed delivery, or technical correction excludes the **whole package** from price evidence because shared shipping can distort companion offerings. If one of an offering's packages in an order is excluded, that offering/order is excluded. Unknown/estimated normal orders remain in the recent clean window; they are never filtered away to resurrect older losses. An older unknown outside the recent sample still appears in overall coverage but need not block a newer adequately supported trend.

**Day-only ties:** package results have no trustworthy intraday sequence. The engine inspects the whole latest/cutoff day before selecting five display samples. It blocks price alerts if the latest day mixes a loss with an unknown/nonnegative/ineligible result, or if a tie straddles the fifth-order boundary and financial/provenance evidence differs. An unknown or ineligible candidate on that boundary always blocks the recommendation. Three known losses on the same day still qualify; identical all-loss boundary ties may qualify. The output retains at most five samples. Reversing/rotating input cannot change the decision.

**Evidence:** `fees_from_history`, `assumptions_source`, `cost_estimated`, unexplained estimated fees/offerings, or estimated shipping/commission/other metadata are insufficient for a price alert. `cost_vat_estimated` (including the existing profile-VAT fallback metadata) and withholding-only estimates are allowed, with `estimated: true` and explicit reason codes. A withholding flag does not excuse any separate fee/cost estimate. Partial current-window reads, any incomplete historical delivered read, and unallocated fees block price alerts. Unmapped/ambiguous packages conservatively block their channel because their offering cannot be safely excluded from a recent history.

**Returns/delivery:** evaluate the latest five distinct orders **including normals**; three matching events suffice, even if the latest order is normal or the recent net is positive. Read both item booleans and `return_packages`, `failed_delivery_packages`, `partial_returns` aggregates. Failed delivery takes priority over the same package's return flags. Technical correction packages/orders are excluded from both recurrence windows. If the fifth-order cutoff straddles a date with mixed statuses for that exception type, the engine suppresses the ambiguous exception window, increments `ambiguous_exception_windows`, and marks affected orders ineligible. A latest normal order by itself does not suppress a known repeat. Known event repeats may still surface with incomplete monetary amounts, clearly flagged by coverage and reason codes. Customer returns use the existing package-result date convention; this is not a new return-event-date query.


**Future customer-return evidence:** the sole shared-result change is `latest_customer_return_on`, calculated from already-loaded non-`DUZELTME-` return entries, before early exits. No financial calculation or query changes. When this date exceeds the supplied `today`, all offerings in that package are unusable current evidence: their order remains an unknown slot in price and exception histories, their future return/delivery flags do not count, and alert cash is null. Other legitimate return flags in that same offering/order are also withheld because the combined result is contaminated. This prevents both announcing tomorrow's return today and removing the row to resurrect stale price losses. `coverage.future_customer_return_packages`, `unknown_orders`, and `ineligible_orders` disclose the gap. Pure callers may equivalently supply `future_customer_return: true`.

Core reason codes: `recurring_loss`, `latest_order_loss`, `negative_recent_net`, `recurring_returns`, `recurring_failed_delivery`; provenance codes: `cost_vat_estimated`, `withholding_estimated`, `fees_from_history`, `assumptions_source`, `cost_estimated`, `fees_estimated`, `offering_estimated`; coverage codes on exception alerts: `unknown_result`, `insufficient_evidence`, `incomplete_amounts`, `future_customer_return`, plus applicable global price-block codes. No money text, exact new-price formula, or URL is embedded. Parent UI provides advice and calculator/order links.

## Coverage fields for parent UI

All order totals below use unique **channel + tagged order identity** across offerings, not a sum of package counts or per-offering counts. These categories can overlap and must not be added together.

| Field | Meaning |
| --- | --- |
| `complete` | Overall evidence completeness, including malformed/overflowed/unallocated/partial cases. |
| `history_partial` | Any attempted historical delivered-result chunk failed. Suppresses all price alerts, sets complete=false and status=incomplete, and marks all observed orders ineligible even if the last 30 days were read successfully. |
| `packages`, `orders`, `offerings` | Unique orders whose latest eligible result is within the 30-day window, their channel/offerings, and all loaded packages supporting those orders (including older siblings). |
| `unknown_packages` | Packages with unknown results/required quantities or exception effects, unmapped offerings, conflicting duplicates, unsafe values, or invalid package identity. |
| `unknown_orders` | Distinct orders affected by the above, or by an unsafe/unknown offering-order sum. |
| `ineligible_orders` | Distinct observed orders with unknown or insufficient evidence, or affected by a blocked recent sample/channel/global guard, ambiguous date ordering, or an incomplete exception total. Includes known orders whose sample cannot be evaluated safely. |
| `unknown_recent_orders` | Distinct unknown clean orders in a latest-five candidate window, including orders tied on its cutoff day. |
| `excluded_price_packages`, `excluded_price_orders` | Known return/delivery/technical exclusions. These alone do not mean evidence is incomplete and do not increment `ineligible_orders`. |
| `unmapped_packages`, `insufficient_evidence_packages`, `estimated_packages` | Separate mapping gaps, disallowed estimates, and all estimate-labelled packages. VAT/withholding-only estimates do not by themselves make orders ineligible. |
| `return_packages`, `failed_delivery_packages`, `technical_correction_packages` | Observed exception package flags; return and failed-delivery counts are mutually exclusive at package level. Technical count is separate. |
| `price_blocked_offerings`, `price_evaluable_offerings`, `insufficient_orders_offerings` | Per-channel offering counts by blocked evidence, sufficient evaluable recent history, or fewer than three clean orders. |
| `ambiguous_ordering_offerings` | Offerings blocked because date-only latest/cutoff ties can change the recommendation. |
| `ambiguous_exception_windows` | Per-offering/type exception windows suppressed because mixed statuses straddle a same-day fifth-order cutoff. |
| `historical_sibling_packages` | Retained supporting packages dated before the window, belonging to an order whose latest result is in the window. |
| `future_customer_return_packages` | Supporting packages contaminated by a customer return dated after today; counted as unknown evidence, not as current return events. |
| `price_blocked_channels` | Channels conservatively blocked by unassigned/ambiguous/invalid package evidence. |
| `duplicate_packages`, `duplicate_items`, `ambiguous_packages` | Replay diagnostics and conflicting evidence counts. |
| `unsafe_packages`, `unsafe_totals` | Invalid integer inputs and detected unsafe sums; not a fabricated money subtotal. |
| `invalid_date_packages`, `invalid_identity_packages`, `unsupported_channel_packages` | Input-quality diagnostics. Invalid dates cannot be assigned to a window or an invented missing order count. |
| `outside_window_packages`, `pending_packages` | Skipped-input diagnostics; they do not mark the current window incomplete. |

The existing UI checks `partial`, `unknown_orders`, `unknown_packages`, and `ineligible_orders`. **Also use `coverage.complete === false` (or `status === 'incomplete'`)** as the authoritative incomplete guard: with zero readable orders, an invalid unallocated value or malformed undated input cannot honestly be expressed as a positive missing-order count. Do not invent missing orders for failed reads.

Parent permission guard should continue scrubbing the entire `sales_alerts` value to null for no-amount access; alert existence/type is itself financial information. No permission-policy changes belong to this implementation.

## Verification and handoff

Final command (all synthetic, disposable in-memory fixtures):

```text
node --test tests/sales-alerts.test.js tests/sales-presentation.test.js tests/panorama.test.js tests/redesign-analytics.test.js tests/dashboard-financials.test.js
```

**Prior shared verification: 83 passed, 0 failed (39 alert tests and 44 shared regressions), before the final historical-read guard.** Initial contract tests failed before the engine/integration existed. Later coverage/tie regressions were also observed failing before fixes. Fixtures exercise the real panorama and performance implementations, including channel/custom dates, read failures, actual returns/delivery/technical records, fee history, and nonzero VAT/withholding estimates. The test harness loads existing schema only into `:memory:`; no local/live database migration, network, git operation, server restart, or deployment was performed. Node reports its existing experimental SQLite warning.


Final historical-read guard verification: **41/41 focused backend tests passed** via `node --test tests/sales-alerts.test.js`. Regressions cover both profitable and unknown older siblings hidden by an old failed chunk, unchanged current-period totals/coverage, zero observed rows, and future/pending failures remaining independent. Independent reviewer file was read and executed, never edited. After the stock agent completed its changes and before the final historical-read guard, the **full independent review passed 30/30**, including R05/R06 (older profitable/unknown sibling), R08 (future customer return), R24-R26 (date ties), R27 (real panorama split-order boundary), and real permission/UI checks:

```text
node --test tests/insight-alerts-review.test.js
```

The owned tests additionally cover exception-status cutoff ties and ensure future-return metadata cannot resurrect older price losses. Warehouse changes remain the other agent's ownership; all of their independent review cases are green in this final assembled run.

Handoff kept in this owned report instead of creating an out-of-scope file:

```yaml
---
session: sales-alerts-2026-10-04
date: 2026-10-04
status: complete
outcome: SUCCEEDED
---
goal: Implement pure recurring-sales alerts and panorama integration with synthetic regression evidence.
now: Ready for parent final assembled UI checks and local restart; no backend blockers remain.
test: node --test tests/sales-alerts.test.js tests/sales-presentation.test.js tests/panorama.test.js tests/redesign-analytics.test.js tests/dashboard-financials.test.js
done_this_session:
  - task: Implemented pure offering/order recurrence and safe evidence coverage.
    files: [src/sales-alerts.js, tests/sales-alerts.test.js]
  - task: Integrated loaded panorama rows and documented the UI contract.
    files: [src/panorama-api.js, src/performance-api.js, docs/sales-alerts-2026-10-04/backend.md]
blockers: []
questions: []
decisions:
  - identity: Use canonical sales_items and tagged order/package identity; never split sets.
  - ties: Inspect the whole cutoff day and block mixed or unknown price/exception evidence without enlarging samples.
  - chronology: Retain older order siblings; future customer-return metadata keeps contaminated orders as unknown evidence slots.
  - historical_completeness: Any failed historical delivered-read chunk blocks price advice; existing current-period totals and partial scope stay unchanged.
findings:
  - provenance: Profile cost VAT and withholding-only estimates need labels; history/cost estimates block price advice.
  - coverage: Distinct-order unknown/ineligible counts support the UI; complete remains the authoritative guard.
worked: [Failure-first tests, real in-memory panorama fixtures, exact integer sums]
failed: [Original lexical day-tie selection could hide unknown or profitable orders; regression-fixed]
next:
  - Parent consumes the documented contract and completes its independent UI and permission work.
  - Parent performs final local app verification and restart after other owned changes are ready.
files:
  created: [src/sales-alerts.js, tests/sales-alerts.test.js, docs/sales-alerts-2026-10-04/backend.md]
  modified: [src/panorama-api.js, src/performance-api.js]
```