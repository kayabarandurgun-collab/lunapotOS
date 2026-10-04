# Warehouse and product dossier — completed 2026-10-04

Implemented in `C:/Users/baran/Desktop/site/lunapot-panel`; no commits, deployment, live database, or external writes. Existing migrations through 0065 and parent integration files untouched. `public/product-list.js` changed on two lines only.

## Delivered

- Saved multi-product EC physical counts: named server sessions, browser/phone resume URL, per-row saves, counted/uncounted/conflict/search filters, current physical/reserved/transit figures, editable drafts, explicit recount, persisted review, atomic/idempotent apply. Uncounted and equal rows produce no stock movement. Unsaved edits in other rows survive saving one row.
- Count inserts use existing immutable stock ledger, count-loss expenses, stock/reservation checks and FIFO dirty queue. Any counted product's intervening stock/value generation or unit change blocks review/apply, including net-zero movements. Reservations created after review also block apply. Every row posts together or none post.
- Gains require an explicitly supplied KDV-exclusive integer-cent unit cost; null is unknown and blocks at the database layer. Explicit zero is known. Losses proportionally consume recorded stock value, rounded once to cents. Quantity-only edits preserve existing hidden costs; staff without amounts permission cannot change/clear costs.
- Read-only replenishment proposals use minimum stock and last-30-calendar-day net dispatch demand, manual lead time, configurable target days and pack sizes. Set demand uses existing component sales once; set capacities use the limiting component. Shared-component capacities are alternatives, never a summed promise.
- Read-only product dossier for EC/LP: physical stock, searchable/paginated complete movement history, supplier identities, recent posted purchase lines and corrected unit costs, permitted mapping/set relations and EC reorder data. No customer records, balances, contacts or sales revenue fields are selected.
- White-canvas responsive UI using parent sage/blue/lilac variables; labelled actions, escaped strings, abort/disposal guards, no localStorage. Product list links to dossier and EC saved counts.

## Integration contract

Parent already added handlers, permissions, routes, stylesheet and service-worker assets; final parent preview restart must include final 0067/API changes.

Exports:

- `warehouseApi(request, env, path, readBody)` in `src/warehouse-api.js`.
- `productProfileApi(request, env, path)` in `src/product-profile-api.js`.
- `mountWarehouse(root, ns, user)` and `mountProductProfile(root, ns, user)` both return disposers.
- Routes: EC `#warehouse`, resume `#warehouse?session=<id>`, both namespaces `#product?id=<id>`.
- Styles: `public/warehouse.css` (parent loads it).
- Environment: `env.DB = scopedDB(rawDB, ns)`, `env.WORKSPACE`, `env.USER`. Existing tables remain unprefixed/scoped; new warehouse tables are fixed `ec_` names, only accessible after EC checks. No central scoped table registration needed.
- Permissions: EC warehouse/dossier -> `stock`; LP dossier -> `accounts`. GET reads, POST writes. Cost entry additionally requires `amounts`. Purchase details require EC `invoices` / LP `accounts`; mapping/set relations require `catalog`. Amounts are scrubbed within handlers and again by parent. Lead/pack settings need stock write, not amount access.

All URLs below are under `/api/ec`; handler paths omit `/ec`:

| Method / path | Body / behavior |
| --- | --- |
| GET `/warehouse` | Stock, recent sessions, replenishment and set capacities; no writes |
| POST `/warehouse/sessions` | `{request_key, title, product_ids?}`; repeat request key returns same session; differing content conflicts |
| GET `/warehouse/sessions/:id` | Session, snapshot/current lines, differences, unknown costs and conflicts |
| POST `/warehouse/sessions/:id/lines` | `{revision, lines:[{product_id,counted_milli,unit_cost_cents?,notes?,recount?}]}`; milli units; null count means uncounted; absent cost preserves it; explicit null clears it with permission |
| POST `/warehouse/sessions/:id/review` | `{revision}`; validates and persists new revision/token and Istanbul operation day |
| POST `/warehouse/sessions/:id/apply` | `{revision, review_token}`; only reviewed state; token-matched retry after success returns `repeated:true` |
| POST `/warehouse/settings/:productId` | `{revision,lead_days,cover_days,pack_milli,notes?}`; lead can be null; optimistic edit |
| GET `/product-profile?id=...` | Also LP. Optional `q`, `page`, `direction`, `from`, `to` use existing stock-history validation |

## Verification

Final run: **34 passed, zero failed/skipped**, using actual migration-chain SQLite, actual Worker and installed Chrome. Includes:

- Concurrent saves and applies; immutable/repeated apply; review invalidation; transaction rollback on later-row failure; insert arriving between review and apply; value-only and net-zero changes; late reservations; unknown versus explicit-zero cost; cost permission preservation; real EC/LP scoping; readonly total_changes checks.
- Rounded loss, generated expense and FIFO reconciliation. Independent R1 fixed by promoting loss numerator before division; independent R2 fixed with current-unit recount validation plus transactional line/apply guards. Concurrent unit change during recount also tested.
- Populated 0065 -> 0067 using Wrangler's actual SQL splitter; unchanged legacy balances; foreign-key check clean.
- 390px real-browser create/save/reload/filter/review/apply and dossier navigation, missing-cost rejection, unsaved row preservation, manual replenishment config, readonly controls, disposal and empty localStorage. Additional 320px/1440px overflow checks. Standalone synthetic server; shared parent preview untouched.
- Existing stock-history and stock UI regressions still pass.

```powershell
$env:WAREHOUSE_BROWSER='1'
node --test tests/warehouse-workflows.test.js tests/warehouse-safety.test.js tests/warehouse-browser.test.js tests/product-profile-api.test.js tests/business-workflows-review.test.js tests/stock-availability-ui.test.js tests/stock-history.test.js
```

Screenshots: `warehouse-artifacts/count-review-390.png`, `warehouse-artifacts/product-390.png`, `warehouse-artifacts/replenishment-390.png`. Visually inspected count/dossier screenshots.

## Files

Created: `src/warehouse-api.js`, `src/product-profile-api.js`, `migrations/0067_warehouse_workflows.sql`, `public/warehouse-ui.js`, `public/warehouse.css`, `public/product-profile-ui.js`, `tests/warehouse-fixture.test.js` (shared test-only fixture), `tests/warehouse-workflows.test.js`, `tests/warehouse-safety.test.js`, `tests/warehouse-browser.test.js`, `tests/product-profile-api.test.js`, this report and warehouse-artifacts screenshots.

Modified: `public/product-list.js` — dossier link plus EC warehouse link only. Independent reviewer owns their tests/report; not modified here.

## Scope limits

- Saved count and replenishment workflow is EC only. LP dossier reads its actual receiving/stock ledger; untracked reservations/transit stay null, and no LP replenishment is fabricated.
- Counts support up to 3,000 physical cards, 200 line edits per request, 20 displayed rows per page. Recent-session list shows 200; older bookmarked session URLs still work. Dossier purchase list is most recent 50, supplier list 100, with truncation flags. Movement search covers all history in pages of 50.
- Replenishment is a proposal, not purchase/assembly execution. Missing manual lead time yields an unknown recommendation plus a separate known minimum gap. Unconfirmed future deliveries are not subtracted. Historical 30-day demand and default seven target days are explicitly labelled assumptions.
- Existing parent FIFO runner drains eight dirty products per mutation; additional products retain normal deferred FIFO processing. A later value change correctly makes an unfinished count stale. No new FIFO engine or ledger replacement introduced.

## Handoff state

```yaml
---
session: system-upgrade-2026-10-04-warehouse
date: 2026-10-04
status: complete
outcome: SUCCEEDED
---
goal: Saved warehouse counts, replenishment and scoped product dossiers implemented and verified.
now: Parent final preview restart and all-module integration run.
test: WAREHOUSE_BROWSER=1 node --test tests/warehouse-browser.test.js tests/warehouse-workflows.test.js tests/warehouse-safety.test.js tests/product-profile-api.test.js
done_this_session:
  - task: Built functional endpoints and responsive UI; repaired independent R1/R2.
    files: [src/warehouse-api.js, src/product-profile-api.js, migrations/0067_warehouse_workflows.sql, public/warehouse-ui.js, public/product-profile-ui.js]
blockers: []
questions: []
decisions:
  - ec_only_counts: LP has a different production/material workflow; actual LP dossier remains supported.
findings:
  - fifo: Existing count movements correctly mark FIFO and post loss expenses.
worked: [Atomic SQL trigger, optimistic session revision, stock generation, real Worker SQLite browser fixture]
failed: [Initial loss integer division and stale-unit recount were found and fixed by independent regressions]
next: [Parent final integrated preview refresh and suite]
files:
  created: [migrations/0067_warehouse_workflows.sql, src/warehouse-api.js, src/product-profile-api.js, public/warehouse-ui.js, public/product-profile-ui.js, public/warehouse.css]
  modified: [public/product-list.js]
```
