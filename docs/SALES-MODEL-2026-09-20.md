# Sales read-model — 2026-09-20

Implemented in the active `C:/Users/baran/Desktop/site/lunapot-panel` shared checkout. Write scope: `src/performance-api.js`, `src/panorama-api.js`, `src/urun-karlilik-api.js`, new `src/sales-presentation.js`, new `tests/sales-presentation.test.js`, this report. No schema, worker, accounting, permission-policy, public, inventory, preview-script, or ledger writes. No commit/push/deploy/live access. Uses Carson's read-only `pendingPackageScopeSql` from `src/stock-availability.js` without editing that file. Pascal received the contract through task messaging (internal `send_input` is unavailable).

## Public contract

Every performance package row has `sales_items`. These are actual historical order-line offerings, grouped within the package by their composition, independently of legacy `urunler` stock-component contributions.

```js
{
  key, name, kind: 'single' | 'multipack' | 'bundle',
  units_milli, sold_units_milli, returned_units_milli, partial_return,
  components: [{product_id, name, quantity_milli, stock_unit}],
  component_returns: [{product_id, quantity_milli, stock_unit}],
  revenue_gross_cents, cost_gross_cents, cash_cents,
  sold_cash_cents, return_cash_cents, withholding_cents,
  line_ids, package_ids, packages, estimated, missing,
  has_returns, failed_delivery, technical_correction,
  return_packages, failed_delivery_packages, allocation_note,
  calculated_cash_cents, per_unit_cents
}
```

- `components.quantity_milli` is the composition of **one sold offering unit**, from saved `order_line_components` divided by historical line units. Quantity, product ID and saved stock unit determine identity. The key stores a sorted reduced rational representation, avoiding rounded identity collisions. Current catalog mapping IDs/versions and mutable display names are excluded. Names are generated server-side from composition and current product labels; a product rename can change the label, never the key. Unmapped lines keep distinct line-scoped keys and unknown money.
- One product at one `adet` is `single`; one product at more than one `adet` is `multipack`; multiple distinct product/unit components are `bundle`. A measured stock unit such as litre remains `single`, with its measure preserved in composition.
- `sold_units_milli` is the original ordered offering quantity, including later returns/failed delivery. `units_milli` is the remaining complete offering quantity. It is **null** when component returns do not establish an integral number of whole offerings. No fractional complete set is fabricated. `returned_units_milli` is similarly null for unbalanced/fragmentary returns. The original sold units and exact `component_returns` remain visible. For pending rows these are ordered units, not completed sales.
- Complete returns retain a zero-unit offering row and all residual expenses. `partial_return` also identifies the return of some whole offerings from a larger line; `per_unit_cents` is suppressed for partial returns. Aggregation propagates unknown net units.
- `cash_cents = sold_cash_cents + return_cash_cents` when known. For a fully returned line, its entire sale-plus-return residual moves to `return_cash_cents`, and `sold_cash_cents` is zero. Partial returns expose signed ledger return effects; they are not absolute expenses. Technical `DUZELTME-CIFT` corrections are flagged and excluded from real-return counts. Existing economic twin resolution occurs before presentation.
- All money uses `*_cents` and the existing recursive amount scrubber. Unknown remains null, including aggregate total/rank and known subtotal when nothing is calculated. Zero fees are known zero. Cost follows the existing package VAT/FIFO basis, not a new accounting valuation.
- Known `sales_items` gross revenue, gross cost, withholding and cash sum exactly to their authoritative package totals. Fees stay with the linked sale/return entries. Existing product-level withholding allocation is preserved with explicit stable SQL order; subdivision between historical lines uses signed largest-remainder cents in stable component order. Pending package estimates are reconciled independently for revenue, cost and deductions.

`aggregateSales(packageRows, {limit=5, channel=null, from=null, to=null})` returns `{rows, top, bottom, revenue_top, count, missing_packages, return_packages, failed_delivery_packages, return_cash_cents}`. `rows` contains all offerings, including zero-quantity returned offerings and unknown totals. The rankings contain only known values, with stable key ties. Top/bottom can overlap in a small assortment; they are independent rankings, not a partition. Rows retain package/line IDs for drilldown and source flags; package counts are deduplicated per offering. Summing counts across offerings can double-count packages; use the package summary for global counts.

- `panorama.periods[*].sales` and `selected_period.sales` use this helper. Legacy `period.products` stays present with `role:'stock_component_contribution'`.
- `period.returns = {failed_count, returned_count, failed_cash_cents, returned_cash_cents}`. Mutually exclusive package sets: failed means `teslim_edilemedi`; returned means other packages with real returns. Amounts are sums of signed `return_cash_cents`. Applicable unknown amounts remain null; an empty category is zero. Incomplete period reads yield null return summary values.
- `/urun-karlilik.sales` is the same **delivered/result-date** aggregate, with `scope:'delivered'`. Its `pending.sales` is separate. Legacy `rows` retain stock-component quantities, with `role`, `single_cash_cents`, `multipack_cash_cents`, `bundle_cash_cents`, `return_cash_cents`; these four contributions sum to known legacy component cash. The legacy rows still include both delivered and pending scope. Unknown legacy revenue/profit totals now stay null, with `hesaplanan_*_cents` known subtotals.
- `/performance?mode=pending`, `panorama.pending`, and `/urun-karlilik.pending` expose `preparing` and `shipped`, each `{packages, calculated, missing, cash_cents, calculated_cash_cents, revenue_gross_cents}`. Preparing is draft/reserved; shipped is genuinely outstanding shipment after shared full-return/twin exclusions. Legacy total pending scope remains. `/urun-karlilik.rows` also provides `preparing_packages`, `shipped_packages`, `preparing_cash_cents`, `shipped_cash_cents`. Unavailable pending sections expose null subgroup values. Shipped estimates with unknown purchase costs are no longer treated as free stock.
- The shared pending predicate runs **before pagination**, avoiding empty/truncated pending pages caused by excluding rows afterward. `awaiting_delivery` also uses this predicate.
- All three APIs accept `channel=trendyol|hepsiburada`. Dates preserve established semantics: delivered/result date for concluded packages (including later recorded returns), order date for pending. Panorama pending remains its legacy all-current-pending scope; `/urun-karlilik` pending respects an explicit date interval. Current inventory is unchanged by these filters.

## Synthetic evidence and verification

Nine new regressions cover historical identity/name/mapping changes, singles, four-packs, mixed three-item sets, extra standalone lines sharing a product, same offering on multiple lines, full/partial returns, odd VAT/withholding cents, zero fees, unknown costs/fees, real API channel/date filters, recursive amount hiding, pending scope and delivered twins.

The user example is reproduced exactly: 25 net bottles, 121558 cents revenue, -3059 cents cash = five four-packs +6722, five mixed sets' bottle component -4533, failed four-bottle delivery -5248. The mixed offering's complete cash is -15413; its package with an extra standalone line is -10413. No package amount is mislabeled as that offering's profit. Pending regression reproduces 125 stored shipped minus 3 full returns minus 6 delivered twins = 116 shipped, plus 8 preparing = 124 pending.

Final targeted command:

```text
node --test tests/sales-presentation.test.js tests/panorama.test.js tests/performance-tools.test.js tests/codex-kar-stopaj.test.js tests/codex-duz-kesinti.test.js tests/codex-kar-kapsam.test.js tests/codex-rapor-sonuc.test.js tests/amount-permission.test.js tests/codex-kargoda-kapsam.test.js tests/codex-kar-ortak.test.js tests/redesign-analytics.test.js
```

Result: **61/61 tests passed**, including **9 new synthetic regressions** (11.4 seconds). Full-suite/integration/browser/publishing remains with main. Preview server at 127.0.0.1:8791 was not restarted or modified by this agent; main must restart its backend snapshot to consume these changes.
