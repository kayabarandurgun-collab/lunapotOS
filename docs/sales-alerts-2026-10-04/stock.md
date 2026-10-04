# Replenishment intelligence — 2026-10-04

`GET /api/ec/warehouse` now adds `replenishment.alerts`, `coverage`, `notices` and `notice`. The dashboard can fetch this independently; no panorama query or financial-ledger dependency is introduced. Existing `warehousePermission` and amount scrubbing apply. No orders, notifications, migrations or GET writes are added.

## Parent UI contract

Each alert includes:

- Identity: `product_id`, `name`, `sku`, `stock_unit`.
- Presentation: `type: 'reorder' | 'low' | 'unknown'`, `urgency: 'urgent' | 'soon' | null`, `reason_codes: string[]`, **`alert_notice: string`** (readable Turkish explanations; no client translation required).
- Supplier: `supplier_id`, **`supplier_name`**, `supplier_source: 'product.supplier_id' | null`. Only an explicit product link joined to an unarchived supplier is used. An archived supplier is treated as unavailable: replenishment supplier fields become null and `unknown_supplier` is reported; the stored product link is unchanged. Brand, invoice history and the name Tropikal never imply a confirmed supplier. Missing supplier fields are null.
- Stock: `available_milli`, `on_hand_milli`, `reserved_milli`, `min_stock_milli`.
- Forecast: `daily_demand_milli`, `weekly_demand_milli`, `days_remaining`, `projection_basis: 'max_7_30' | 'average_30'`, `recent_rate_eligible`.
- Actual history: `demand_7_milli`, `previous_7_milli`, `demand_30_milli`; rates `daily_7_milli`, `daily_previous_7_milli`, `daily_30_milli`; gross and restocked quantities for those three windows (`gross_previous_7_milli`, `restocked_previous_7_milli` for the previous week); `nonrestocked_30_milli`.
- Configuration: `lead_days`, `cover_days`, `pack_milli`, `target_milli`, `suggested_milli`. **Missing lead always means `target_milli` and `suggested_milli` are null, never a fabricated zero.** Unknown availability or incomplete evidence also makes the suggestion null. A real calculated zero is possible when the configured target is already met.
- Caveats: `history_status: 'incomplete' | 'none' | 'short' | 'recorded'`, `history_completeness: 'unverified'`, `history_days`, `first_sale_on`, `last_sale_on`, `active_sales_days_7`, `active_sales_days_previous_7`, `active_sales_days_30`.

All `_milli` values are quantities in thousandths of `stock_unit`, not money. Rates and days are rounded to three decimals for presentation; thresholds and order quantities use the unrounded rate. Divide quantities by 1,000 for units. `weekly_demand_milli` is projected daily demand × 7; `demand_7_milli` is recorded recent net consumption. Example: seven units over seven active days and five available units yields daily 1, weekly 7, and five days remaining.

`coverage` includes `status: 'incomplete' | 'limited' | 'empty'`, `as_of`, inclusive `windows` boundaries, evaluated/alert/excluded-archived counts, counts of unknown availability, incomplete/no/short history, sparse activity, no recent demand, unknown supplier, unknown lead, and unmapped shipments. `coverage.notice` is a Turkish string, identical to `replenishment.notice`. `notices` supplies `{code,message,product_count?}` objects. Completeness remains unverified because the database has no authoritative complete import-window marker. An empty warehouse has null window dates; response-level `as_of` still exists.

**No-spam rule:** known plentiful stock does not get an unknown card solely for short, sparse, absent or zero-demand history, missing supplier or missing lead. Those limitations remain in coverage counts/notices. Unknown availability and data-integrity problems that prevent a usable forecast do emit cards. Thus 70 units / ~233 days, 75 / ~562 days and 170 units with no sales do not generate standalone history-warning cards.

## Demand and stock semantics

Windows use Istanbul calendar dates: today through today−6, today−13 through today−7, and today through today−29. Zero-sales days remain in the denominator. No 14-day values are inferred from 30-day data.

An eligible sale must have its matching physical stock movement. Linked packages must be shipped/delivered with a nonfuture ship date and consistent component product, quantity and unit. Legacy order-line links and live webshop links are checked too. Standalone manual ledger sales with a matching stock movement count. Future sales, unshipped/cancelled package sales and missing/inconsistent movement links are excluded and surfaced as incomplete evidence. Future physical returns are excluded and marked incomplete because their posting already changes current stock. A customer or technical return dated before its parent sale is contradictory chronology and marks history incomplete; both alerts and public proposals then return null days, target and suggested quantity. A legitimately backdated return after an older parent sale remains valid.

- **Gross:** eligible physical sales after subtracting `DUZELTME-CIFT-*` / `DUZELTME-IKAME-*` technical reversals from the original sale date, including reversals recorded later than that window. Technical reversals do not become customer returns or inflate distinct sales-day counts. Partial corrections retain only the remainder.
- **Net:** gross minus ordinary customer returns that actually restored stock (`restock=1` plus matching return movement), on the return date, floored at zero for each window independently. A restock from an older sale can reduce this period's consumption; an old technical reversal cannot. `net_demand_clamped` explains periods where returns exceed gross.
- **Nonrestocked returns:** reported separately; they do not reduce physical demand. `DUZELTME-EK-*` replacement/additional physical sales count even with zero revenue. Financial totals never determine demand.
- Set components already exist in the sales ledger and are counted once. Catalog set definitions only provide existing capacity information, never additional demand.
- Available = on hand − active marketplace/webshop reservations. Customer stock in transit has already left; it is not subtracted again. Missing balance rows remain visible with unknown availability. Archived products remain available for existing count workflows when applicable, but are excluded from replenishment proposals and alerts.

`history_days` is the capped 30-day span since the first eligible positive corrected sale, not proof that every day was imported. Active-sales-day counts are distinct corrected gross-sale dates. Regular restocks do not erase a historical active sale date.

## Forecast and classification

With at least seven days of history and three distinct active sale days in the last seven, daily demand = max(net 30 / 30, net 7 / 7). Otherwise the conservative 30-day average is retained, with caveats. Sparse one-day bulk sales do not establish a faster recent rate.

- `reorder` / urgent: remaining days strictly below known lead time, or exhausted stock with known lead.
- `low` / soon: remaining days ≤ lead + cover; with unknown lead, ≤ seven days. A positive minimum-stock threshold also alerts at or below equality. Exhausted stock without lead is `low` / urgent.
- `unknown`: availability cannot be established, or integrity problems prevent a usable forecast and there is no independently observed stock threshold alert.
- Days are null with zero demand, unknown stock or integrity issues; known depleted stock with positive usable demand has zero days.
- Target = max(minimum, ceil(daily × (lead + cover))); suggestion is positive target shortfall rounded up to the configured pack. Lead/configuration can be completed in the existing warehouse settings. Incomplete evidence suppresses alert order estimates.
- Sort by remaining days, unknown days last, then Turkish product name and product ID. Open purchase arrivals are not deducted because confirmed arrival dates are unavailable.

Reason codes: `unknown_available`, `incomplete_history`, `no_history`, `short_history`, `sparse_activity`, `no_recent_demand`, `unknown_supplier`, `unknown_lead`, `net_demand_clamped`, `out_of_stock`, `below_lead`, `within_seven_days`, `within_lead_and_cover`, `minimum_reached`. Codes stay machine readable; use `alert_notice` for text.

## Compatibility, security and verification

`reorderProposal` remains a backwards-compatible standalone pure export with its original 30-day formula and existing tests. **The public endpoint no longer uses that helper for proposals.** `replenishment.proposals` and `alerts` now reuse the same evaluated `stockAlert` result, including daily/weekly rates, days remaining, target, suggested quantity, supplier and history metadata. Proposals cover all evaluated active products (so their `type` can be null); alerts retain the risk-only filter. Existing proposal fields `config_revision`, `notes`, `min_gap_milli`, `lead_days`, `cover_days` and `pack_milli` remain. Proposal `reason` explains the selected intelligence basis, target formula and readable caveats. `demand_30_milli` still means measured 30-day net history, regardless of the forecast basis. A regression fixture demonstrates the original bug: 10 sold, 2 restocked and 3 returned without restock previously reported 5 units of demand; correct physical net consumption is 8.

Supplier reads select only ID/name, with no contact, tax, balance, price or financial-ledger data. Stock-only staff retain quantities while existing amount fields are scrubbed. The alert fixture verifies at most six SELECT/WITH queries for the warehouse read, `PRAGMA query_only=ON`, unchanged `total_changes()`, permission denial without stock access, and no panorama/financial query dependency.

Validation uses real `node:sqlite` in-memory databases and existing repository schema/fixtures, never a live database. The 26 new tests cover normal pace, acceleration guards, exact boundaries, thresholds, pack rounding, negative/zero/unknown stock, mixed sets, reservations/transit, ordinary and technical returns, supplier provenance, archives, incomplete/short history, future/unshipped records, ordering, permission safety, no-spam filtering, Turkish notices, identical public proposal forecasts, impossible return chronology and archived suppliers.

Final focused command:

```sh
node --test tests/stock-alerts.test.js tests/warehouse-safety.test.js tests/warehouse-workflows.test.js tests/stock-availability.test.js tests/orders-components.test.js
```

Result: **49/49 passed**, including **26 new alert tests**, after proposal unification, chronology validation and archived-supplier handling (2026-10-04). Independent R15/R22 passed first (**2/2**), followed by all stock-specific review cases R13–R19, R22–R23 and R28–R30 (**12/12**). Existing order-component fixtures print nonfatal `price_profiles` diagnostics from their limited namespace adapter; Node also prints its SQLite experimental warning.

Integration evidence: a surge with 21 units consumed in seven days, 22 in thirty days, eight available units, lead 4 + cover 3 and pack 3 now suggests **15 units in both views**; the preserved standalone legacy helper suggests zero. Missing shipment evidence with a configured 10-unit minimum now keeps target and suggested quantities null in both views while retaining the known minimum gap.

Independent stock-review command:

```sh
node --test --test-name-pattern 'R(13|14|15|16|17|18|19|22|23|28|29|30) ' tests/insight-alerts-review.test.js
```

Read-only SQLite `EXPLAIN QUERY PLAN` confirmed stock-movement checks use the existing unique `(kind,reference,product_id)` index (`sqlite_autoindex_ec_stock_movements_2`); the supplier join uses its primary-key index. History aggregation still scans ledger/component rows to establish first-sale history and corrections. This is an index-plan check, not a production latency benchmark; no schema/index changes were made.

## Handoff / continuity

Kept here to respect the exclusive four-file write scope; no separate continuity or handoff file is created.

```yaml
---
session: replenishment-intelligence
date: 2026-10-04
status: complete
outcome: SUCCEEDED
---
goal: Add quantity-only replenishment intelligence to the existing warehouse read endpoint.
now: Parent renders alerts and warehouse proposals from the same forecast; readable notices and no-spam coverage remain available.
test: node --test tests/stock-alerts.test.js tests/warehouse-safety.test.js tests/warehouse-workflows.test.js tests/stock-availability.test.js tests/orders-components.test.js
done_this_session:
  - task: Add shared alert/proposal forecasts, demand windows, return chronology checks, active supplier provenance and no-spam alerts.
    files: [src/stock-alerts.js, src/warehouse-api.js]
  - task: Add real SQLite regression coverage and parent contract.
    files: [tests/stock-alerts.test.js, docs/sales-alerts-2026-10-04/stock.md]
blockers: []
questions: []
decisions:
  - supplier: Only explicit unarchived product supplier links; no brand or invoice inference.
  - proposals: Public proposals reuse the evaluated stockAlert forecast; the pure legacy helper remains compatible.
  - unknown_cards: Reserve for unavailable stock or unusable integrity evidence; history limitations stay in coverage.
findings:
  - returns: Only physical customer restocks reduce demand; technical corrections restate their original sale.
worked: [Existing SQLite fixtures, query-only GET check, preserving reorderProposal]
failed: [Initial fixture setup attempted guarded negative stock and edited a locked shipped set; corrected fixture sequence]
next: [Parent integrates UI text and supplier actions within its own scope]
files:
  created: [src/stock-alerts.js, tests/stock-alerts.test.js, docs/sales-alerts-2026-10-04/stock.md]
  modified: [src/warehouse-api.js]
```
