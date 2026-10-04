# Cari dossier — completed 2026-10-04

Implemented in `C:/Users/baran/Desktop/site/lunapot-panel` (base HEAD `9282b24`). No commits, deployment, live database or external writes. Parent-owned integration files and existing migrations through 0065 were not edited.

## Touched files

- `src/party-profile-api.js`
- `migrations/0066_party_profiles.sql`
- `public/party-profile-ui.js`
- `public/party-profile.css`
- `public/business-ui.js` — one surgical link; existing “Hesabı incele”, edit, archive, payment and ledger actions remain.
- `tests/party-profile-api.test.js`
- `tests/party-profile-browser.test.js`
- This report.

## Functional result

Six tabs: Özet / Bilgiler / Faturalar / Ödemeler / Ürünler / Belgeler ve notlar. Existing supplier ID is the sole identity; the module never creates a supplier or financial entry. Optional legal/trade names, tax office, multiple contacts/addresses/banks, validated IBAN, payment/lead days, discount basis points, integer minimum-order cents, tags and active workspace staff are editable. Notes include reminder dates and completion/reopen actions.

Full-ledger balances, active-allocation open amounts, overdue debts, uncashed cheques, last payment, invoices and original posted purchase-price history are real DB queries. Detail lists paginate in stable order without limiting summary totals. Invoice totals and ledger balances remain distinct; missing links/unknown fields remain null. Existing payment, invoice and statement screens open via links.

Files are stored as immutable D1 base64 chunks. Uploads resume by party+SHA256; sealing checks exact size, digest and PDF/PNG/JPEG signatures. MIME must match the filename extension. Raw reads require a sealed file. PDF uses the existing `object-src blob:` policy; raster previews use validated image data URLs. Blob URLs are revoked on close/disposal, requests are aborted on disposal, stale responses are ignored, text is escaped, and no dossier data enters localStorage.

## Integration contract

- API export: `partyProfileApi(request, env, path, readBody)`. Worker public path `/api/{ec|lp}/party-profiles`, handler path `/api/party-profiles`. Requires authenticated `USER`, validated fixed `WORKSPACE`, scoped `DB`; `ROOT_DB` supports staff selection. New table names are explicitly prefixed by the validated workspace, so central scopedDB registration is unnecessary.
- UI export: `mountPartyProfile(root, ns, user)` returns a disposer. Route `#party?id=...`; stylesheet `party-profile.css` in both workspaces. Parent confirmed handler/router/permissions/CSS/SW integration.
- Tables in BOTH namespaces: `party_profiles`, `party_profile_notes`, `party_profile_files`, `party_profile_file_chunks`. Supplier foreign keys preserve identity and block accidental deletion. Parent handles backup metadata and excludes file chunks.
- Permissions: dossier uses ledger read/write. Invoice/product/provisional details additionally require EC invoices or LP accounts read. Bank metadata, discount/minimum-order terms, all notes, file metadata and file bytes require amounts access. Other monetary response fields are nulled internally and by the worker. Staff directory returns only eligible IDs/names; API and SQL triggers validate active workspace access on assignment.
- `GET /staff`: eligible staff. `GET /:id`: party/profile/summary/capabilities. `POST /:id`: incremental optional-field patch, mandatory `expected_revision` (0 for first save).
- `GET /:id/invoices|payments|products|provisional?page=N`: lists, 50 rows/page and `has_more`.
- `GET/POST /:id/notes`; `POST /:id/notes/:noteId`: mandatory revision, reminder/status updates. Duplicate supplied note IDs conflict.
- `GET/POST /:id/attachments`; `POST /:id/attachments/:fileId/chunk|seal`; `GET /:id/attachments/:fileId/part?index=N`. Metadata POST accepts filename/mime/size_bytes/sha256/chunk_count and returns uploaded indices for resume. Chunks accept expected_revision/index/data; sealing accepts expected_revision. Compare-and-swap plus transactional chunk writes reject stale concurrent writers without partial data.

## Verification

Final focused run: **51 passed, 0 failed, 0 skipped**:

```powershell
$env:PARTY_PROFILE_BROWSER='1'
node --test tests/party-profile-api.test.js tests/party-profile-browser.test.js tests/ledger-history.test.js tests/ledger.test.js tests/amount-permission.test.js tests/arayuz-olcek.test.js
```

19 new real SQLite API/migration tests cover both namespaces, concurrent initial/update saves, SQL-level staff access, complete ledger aggregates, allocation reversals, cheque cash settlement, invoice/price pagination and permissions, unknown values, note races, archived cards, chunk races, wrong digest/MIME/extension, cross-party/workspace files, sealed immutability and resume at quota. Migration runs through Wrangler's actual SQL splitter and preserves existing supplier rows.

Five browser checks (parent test plus four subtests) use a standalone loopback HTTP server, actual authenticated worker and fresh in-memory appFixture; no shared preview is changed. EC and LP edit/save/reopen, stale edits retaining drafts, notes/reminders, PNG and PDF upload/view/reopen, restricted staff, 320/390 layout and disposal pass. Parent independently confirmed whole-app layouts at 320/390/1440. All 13 shared CSS token policy tests pass without exemptions.

## Limits / remaining work

- Existing LP has no provisional-receipt subsystem; API returns `supported:false` and UI states that explicitly.
- Files: PDF/PNG/JPEG only, 5 MiB/file, 32 KiB raw chunks (under existing 64KB request limit), 100 files/50 MiB per party. Incomplete files are retained for resume; this module provides no delete/purge action.
- Purchase history shows original posted invoice-line unit prices, with later returns/adjustments remaining in the existing ledgers.
- Basic supplier name/tax/contact editing remains in the existing cari list. Reminder dates/status are stored and shown in the dossier.
- No module work remains. Parent owns final whole-app verification and restarting its synthetic preview to load the final API source. No live migration was applied here.

## Continuity

```yaml
session: lunapot-panel
date: 2026-10-04
status: complete
outcome: SUCCEEDED
goal: Rich cari dossier in ec and lp with real financial reads and safe metadata/files
now: Parent final integration verification; no further module edits required
test: PARTY_PROFILE_BROWSER=1 node --test tests/party-profile*.test.js
done_this_session:
  - task: API, additive schema, six UI tabs, upload/view, concurrency and permission tests
    files: [src/party-profile-api.js, migrations/0066_party_profiles.sql, public/party-profile-ui.js, public/party-profile.css]
blockers: []
questions: []
decisions:
  - identity: Reuse existing suppliers; never create duplicate financial parties
findings:
  - lp: Provisional receipts are not implemented in the existing LP schema
worked: [Real SQLite tests, standalone authenticated browser fixture, actual Wrangler splitter]
failed: [Initial incomplete UI write rejected; proved file absent and created complete validated module]
next: [Parent final whole-app verification]
files:
  created: [src/party-profile-api.js, migrations/0066_party_profiles.sql, public/party-profile-ui.js, public/party-profile.css, tests/party-profile-api.test.js, tests/party-profile-browser.test.js]
  modified: [public/business-ui.js]
```
