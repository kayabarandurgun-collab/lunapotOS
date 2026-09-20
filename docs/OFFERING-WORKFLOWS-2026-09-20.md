# Offering workflows — 2026-09-20

## Scope and integration

Owned changes only:

- `public/orders-ui.js`
- `public/catalog-ui.js`
- `public/fiyat-hesap-ui.js`
- `public/offering-workflows.css` (new, loaded once by the owned mounts)
- `src/fiyat-hesap-api.js`
- `tests/offering-price.test.js` (new)
- This document.

No changes to the shared shell/commerce CSS, fee-history helper, accounting ledgers, persisted mappings, migrations, or preview harness. No git, deployment, or remote data writes. Existing product-query behavior is preserved. Other agents own stock and sales aggregation.

Backend integration point: `kesintiTahmincisi` still receives the **whole component array**. The mapped quote applies its own conservative gate because the shared helper may choose a single component's history for a mixed set. No helper change or cross-owner API change is required. The local preview owner should restart the existing server after integrating the final API file; a second server is not needed. The final API-only rounding guard bounds safe-integer floor calculation and does not change the UI contract.

## UI contract

### Orders

- List and detail start with each actual sold line's name and quantity. Multiple sold lines in one parcel remain recognizable, including a set plus a standalone item using the same stock product.
- Single/multipack/bundle classification comes from recorded component quantity divided by sold-line quantity. Names containing “set” are not evidence of composition. Generic source names fall back to a quantity-bearing component description.
- “Depodan düşen ürünler” is a native, keyboard-accessible collapsed details element. Opening it in the list does not open the order modal or change route state.
- Draft/reserved content is explicitly **planned/allocated**, physically consumed only on shipment. Shipped cash is marked “Teslim bekliyor”. Fully returned failed deliveries show “İade ile kapandı”, without claiming delivery.
- Partial/full return is evaluated against each original component sale. Each expanded component shows returned and actually restocked quantities separately (`restock === 1`). A return does not imply every item physically returned or that the entire order was refunded.
- Cash is displayed only from server `cash_result_cents` / `cash_cents`; no UI fallback treats net contribution as cash. Gross breakdown uses server `cash_breakdown`; otherwise recorded net costs remain explicitly net. Component sale costs are shown as recorded net shipment costs rather than multiplying by the sold line's potentially different VAT.
- Existing status/channel/search/date/watch/profit/sort/page filters, modal history, order actions, mapping, invoice draft, and tariff quote routes remain.

### Catalog

The screen explains **Satılan ürün / İçindeki stok ürünleri**. Count physical products, not separate set stock. For example, two sets containing three bottles consume six bottles. Purchase mappings retain their supplier/unit workflow. Historical composition remains immutable through the existing versioning API.

`revenue_share_bps` remains the existing internal bookkeeping allocation: the form explicitly labels it “İç kayıt dağıtım payı”, requires a total of 100%, and explains that it is not standalone product profitability and does not determine the set price. No mapping data was rewritten.

### Price calculator

Two explicit modes share the existing price screen:

1. Stock product: the existing product query and profile behavior.
2. Sold offering: active channel-specific mappings, visible component quantities, and sold units per **one shipment parcel**.

Mapped quote sale price and target are totals for all selected sold units. Packaging and other expenses are gross totals for this one parcel; they are not multiplied by sold units and never sum component profile package expenses. Empty package expenses are visibly an absent-zero scenario; entering 0 means known zero. Mixed input VAT never silently becomes a sale VAT assumption. The UI asks for an optional, explicitly labeled sale VAT scenario if necessary.

## Read-only API contract

Canonical handler path `/api/fiyat-hesap`; external workspace path `/api/ec/fiyat-hesap`. GET only, EC only, authorized through the existing **pricing** permission. Catalog permission is not required. Permission/redaction policy is unchanged.

### Options

`GET /api/ec/fiyat-hesap?mode=options[&channel=trendyol|hepsiburada]`

Returns `{offerings, truncated}`. Each offering includes `id`, `name`, `external_code`, `channel`, `version`, `kind` and `components`. Each component includes `mapping_id`, `product_id`, `product_name`, `sku`, `stock_unit`, `quantity_milli` per one sold unit. Active marketplace mappings only; deterministic limit 1,000 with `truncated`. No monetary fields or allocation shares are exposed by this endpoint.

### Mapped quote

`GET /api/ec/fiyat-hesap?mapping_id=...&channel=trendyol&qty=1&price=299&target=50&packaging=10&other=0[&sale_vat_rate=20]`

- `mapping_id` is an active marketplace mapping; channel may be omitted to use its channel, or must match. Combining nonempty `product_id` and `mapping_id` is rejected.
- `qty` is integer 1–100 sold units. Each expanded component must fit the existing 1,000,000,000 milli-unit bound and its stock unit; invalid quantities fail before fee/cost work.
- `price`, `target`, `packaging`, `other` are TL inputs, comma decimal accepted. The latter two are already VAT-inclusive **parcel totals**.
- `sale_vat_rate` is optional percent (0–100, at most two decimal places). Supplying it always labels the output a scenario.
- Component cost: positive replacement profile cost with that component's own known VAT, otherwise its latest posted product purchase's actual net + tax proportion. Missing evidence stays null. A zero replacement profile is not taken as proof of a free product; a posted zero-cost purchase is usable evidence.
- Sale VAT: a single consistent known rate from delivered lines with the same mapping identity AND matching historical component ratio; ambiguous/missing values stay null. It is never inferred from the component VAT mix.
- Fee VAT: one consistent known finance-profile fee VAT rate, otherwise unknown. Kargo/hizmet apply to the entire composition once. The existing commission and withholding model is retained.
- Same-composition history can produce a normal estimate. For mixed sets any fallback to single-product/other-channel/channel history is **scenario-only**, even if helper `adet_uyumu` says `ayni`. `kesinti.composition_match` communicates the distinction. Single-product multipacks retain the helper's strict observed quantity/interpolation rules; out-of-range history remains scenario-only.

Existing result fields `fiyatla`, `basabas`, `hedef`, `guven`, `uyari`, `senaryo`, `kesinti`, `gider` remain familiar. New metadata:

- `offering`: mapping identity, name, version, type and component evidence.
- `offering.components[]`: quantities, `cost_vat_bps`, `cost_source`, `unit_cost_gross_cents`, `cost_gross_cents`.
- `cost_gross_cents`: total component cost for the entire quote.
- `quote_unit: "whole_parcel"`, `sale_vat_bps`, `sale_vat_source` (`mapped_delivered_lines`, `scenario`, `unknown`), `missing`, `assumptions`.

All new money fields end in `_cents`. Result/breakdown monetary and fee-rate fields reuse existing scrubbed names. Unknown amounts are never inserted into descriptive strings. A user with pricing access and no amounts access receives null financial fields, including nested scenario/component fields.

When inputs are complete and history appropriate, `guven=tahmini` with normal results. Known-but-assumed inputs return `guven=belirsiz`, null normal results and a labeled `senaryo`. Missing cost, sale VAT, fee VAT or history produces null result/scenario fields and explicit `missing` reasons, while known component evidence can still be displayed. These are planning estimates, not posted accounting changes.

## Verification

Final combined local run: **67 tests passed, 0 failed**, covering:

`node --test tests/offering-price.test.js tests/codex-fiyat-r23.test.js tests/orders-components.test.js tests/orders-siralama.test.js tests/orders.test.js tests/orders-tracking.test.js tests/catalog.test.js tests/amount-permission.test.js tests/nakit-sonuc.test.js`

11 new tests cover component-summed mixed VAT costs, revenue-share invariance, shipping/service and package expenses once, strict quantity bounds, whole-composition gating, absent-zero expenses, missing/ambiguous VAT/cost/history, posted-purchase fallback, pricing-without-catalog permission, recursive money redaction, archive/channel guards, actual sold identity and partial returns. Existing component/order fixture suites emit their preexisting lightweight-fixture `no such table: price_profiles` diagnostics; their assertions pass.

Existing local synthetic preview `http://127.0.0.1:8791`, headless Chrome, 1440px and 390px:

- Real API seeded three-product orchid set plus standalone line in the same parcel: both sold identities visible, expanded set contains three components.
- Details expansion does not open modal; opening/closing modal preserves channel, status, search and sort hash.
- Failed-delivery four-bottle return displays closure and “İade: 4 · Stoğa dönen: 4”.
- Catalog and mapped price quote render; channel switch clears incompatible selection/results.
- No browser page errors. Document width matches viewport for orders, modal, catalog and pricing at both widths.

Browser evidence (temporary local artifacts): `C:\Users\baran\AppData\Local\Temp\lunapot-offering-workflows-20260920\verification.json` and ten adjacent screenshots. Preview script/server ownership stayed with main. No external network or live services were used.
