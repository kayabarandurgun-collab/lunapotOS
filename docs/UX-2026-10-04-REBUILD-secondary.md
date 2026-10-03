# Secondary workspace rebuild · 2026-10-04

Implemented in `C:\Users\baran\Desktop\site\lunapot-panel`. Scope stayed within the six assigned secondary UI files, one targeted browser test, and this evidence folder. No Git, deployment, or live writes were performed. Concurrent foundation and other agents' files were preserved.

## Changes

- `public/production-ui.js` and `public/production-design.css`: permission-filtered local navigation; compact factual summaries; product and batch together in the first production column; explicit record section headings; mobile two-column quantity/cost rows and full-width material actions. Barcode lookup is an expandable tool. Record tables use the existing `data-list-tools="off"` contract because their search/status controls are already provided, avoiding a second injected toolbar. No production queue or projected figures were invented.
- `public/access.js` and `public/access-design.css`: focused sections for employees, account/devices, recovery, and access history; a dedicated employee editor and explicit return without saving; cancel restores opener focus; same-tab navigation works while editing. Role presets, separate amount/deletion permissions, employee activation, and setup links retain their existing behavior. Shared account controls remain mounted while their section is hidden.
- `public/webshop.js` and `public/webshop.css`: operational overview with actual new-order and open-request counts, catalog action, and a separate test-record summary; shared palette aliases; responsive administrative rows. Missing overview counts display `Bilinmiyor`. Existing test banner, sale restrictions, permissions, request ownership, abort handling, stale response protection, dialogs, and write-refresh behavior are retained. There is no new control to enable real sales.

## Verification

- Syntax checks passed for all three modified JavaScript modules.
- **46/46 browser tests passed** across `tests/ui-secondary-workspaces-browser.test.js`, `tests/ui-webshop-browser.test.js`, and new `tests/ui-secondary-rebuild-browser.test.js`.
- Existing browser coverage verifies production read-only permissions, unknown stock/cost values, mobile production forms, staff role permissions, webshop stale async responses, form recovery, and late-write reconciliation. Requests representing writes are fulfilled in isolated browser mocks; none are forwarded to the preview or live services.
- New targeted coverage verifies employee section switching, same-tab return from editing, cancel focus restoration, new-employee navigation, test-only webshop operations, and document width at 360 and 1440 pixels.
- Browser evidence uses the pre-existing isolated synthetic preview at `http://127.0.0.1:18731`, confirmed `synthetic=true`, `local_preview=true`, `network=blocked`. All external requests and unmocked writes are blocked.

## Screenshots and logs

Folder: `docs/ux-rebuild-2026-10-04/secondary/`

- `production-360.png`, `production-1440.png`
- `materials-360.png`, `materials-1440.png`
- `team-360.png`, `team-1440.png`
- `team-edit-360.png`, `team-edit-1440.png`
- `webshop-360.png`, `webshop-1440.png`
- `webshop-orders-360.png`, `webshop-orders-1440.png`
- `layout.json`: all captured document widths fit their viewport.
- `browser-tests.txt`: complete 46-test passing run.

Visually inspected production desktop, materials mobile before/after refinement, team mobile, team editor desktop, and webshop desktop/mobile. Other captures are available for the parent integration review. Full-page captures show the fixed mobile dock at the viewport boundary; page content remains scrollable beneath it. Browser checks are synthetic and do not claim live data or end-to-end payment validation.

## Reproduce

From this repository in PowerShell, with synthetic preview 18731 already running:

```powershell
$env:UI_SECONDARY_REBUILD_BROWSER='1'
$env:UI_SECONDARY_WORKSPACES_BROWSER='1'
$env:UI_SECONDARY_WORKSPACES_PREVIEW='http://127.0.0.1:18731'
$env:UI_WEBSHOP_BROWSER='1'
$env:UI_WEBSHOP_PREVIEW='http://127.0.0.1:18731'
node --test tests/ui-secondary-rebuild-browser.test.js tests/ui-secondary-workspaces-browser.test.js tests/ui-webshop-browser.test.js
```

Status: implementation and local verification complete; ready for parent integration. No changes were made to `app.js`, HTML entry points, workspace foundation, APIs, or production data.
