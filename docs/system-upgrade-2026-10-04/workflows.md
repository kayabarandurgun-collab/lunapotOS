# Workflows completion — 2026-10-04

Implemented in C:/Users/baran/Desktop/site/lunapot-panel. No commits, deployment, live database access, or external writes. Historical migrations and other agents' files were not changed.

## Touched files

- src/workbench-api.js
- migrations/0068_workbench.sql
- public/workbench-ui.js
- public/workbench.css
- tests/workbench.test.js
- tests/workbench-browser.test.js
- This report and workbench-artifacts/{tasks-390.png,tasks-1440.png,intake-1440.png}

## Functional result

Günlük işler lists individual source issues: received/stale report uploads, report review rows, stored/unlinked purchase documents, partially linked multi-invoice documents, draft purchase invoices, outstanding goods receipts, missing order mappings/amounts, and changed source orders. Staff can assign real active team members, set due dates, start tasks, add notes and explicitly snooze them. Custom tasks can also be completed and reopened.

Source task completion is derived on every read from the underlying record. The API and database reject marking source tasks done. Sources outside the first detected page are checked separately by identity; disappearing rows are never assumed resolved. Partially linked documents remain open while links are missing; unknown invoice totals never become zero or complete.

Belge yükle recognizes file bytes, rejects empty/unsupported/legacy XLS/HTML files, and retains the selected File. PDF/XML use mountPurchaseDocument; XLSX/CSV use mountReports. Ambiguous spreadsheet content asks orders versus finance before mapping. JPG/PNG are losslessly embedded into a PDF with original-image attachment and use the same PDF/OCR pipeline. Container bytes are deterministic even when the original image is renamed. Existing uploader confirmation/automatic posting behavior is explained before continuation.

Stored, wholly unlinked documents can be reconstructed from existing chunk endpoints and resumed through the original duplicate/reread protections. Invoice review embeds mountAccounting and waits for its search completion guard. Report review embeds the existing review screen; received reports use the existing preview and apply endpoints. Order actions deep-link using the actual ac package parameter. No new financial writer or customer-party creation was added.

## Integration contract

- Worker export: workbenchApi(request, env, path, body). Canonical path is /api/workbench after parent namespace routing. The shared body reader is invoked as body(request).
- Environment: authenticated USER, validated WORKSPACE (ec/lp), scoped DB, ROOT_DB for staff directory.
- GET /api/{ns}/workbench → as_of, namespace, tasks, exact source_counts, limited/limit_notice, allowed features.
- GET /api/{ns}/workbench/staff → active staff id/name and overlapping eligible feature keys only; no credentials or usernames.
- POST /api/{ns}/workbench/tasks → custom task. Fields: version:0, feature, title, optional notes/assignee_id/due_on/status/snooze_until.
- POST or PATCH /api/{ns}/workbench/tasks/:encodedKey → metadata update with exact version. Keys are source_kind:source_id or custom:uuid. Conflicts return 409.
- GET /api/{ns}/workbench/tasks/:encodedKey/audit → latest 100 immutable snapshots.
- Tables: ec_workbench_tasks, lp_workbench_tasks, ec_workbench_task_audit, lp_workbench_task_audit. Fixed server-selected prefixes are explicit; no central scopedDB registration is required. Other source queries still use scopedDB. Migration 0068 has no CASE within triggers and passes the Wrangler splitter.
- Audit triggers atomically store namespace, source identity, task values, actor and assignee name snapshots, version and timestamp. Deletion/history rewriting and invalid version transitions are blocked.
- Existing module permissions govern each task. Any non-amount module grants appropriate workbench entry; mutations require that task's module write permission. Embedded financial workflows/intake additionally require amounts. Read-only headers and source actions do not advertise denied intake.
- Public export: mountWorkbench(root, ns, user, mode='tasks'), returning disposer with onHash. Parent routes #workbench and #intake (mode='intake'), loads workbench.css and existing imported module CSS.
- Adapter contracts: existing data-pd-drop / data-rb-drop drop listeners; report source/mapping controls; accounting invoice-filter submitter reenable + data-ac=review-invoice controls. Existing upload/review/accounting modules were not edited.
- Uses parent --tone-sage/blue/lilac and shared button typography/radius tokens. Abort/disposal guards and escaped text; no sensitive localStorage.

## Verification

PowerShell:

```powershell
$env:WORKBENCH_BROWSER='1'
node --test tests/workbench.test.js tests/workbench-browser.test.js
```

13 tests passed (12 database/content tests plus one broad browser workflow). Coverage includes real SQLite migrations through the Wrangler splitter, ec/lp isolation, populated LP route, actual worker body reading, root staff authorization, immutable audit, competing edits, date validation, capped source lists, automatic source resolution/reopening, partial document links, file sniffing and image deduplication.

Browser coverage uses installed Chrome/Playwright, real modules, the real worker and in-memory SQLite in an isolated loopback server. It verifies PDF/XML/XLSX bytes reach original storage exactly; image/PDF/OCR reaches document storage; ambiguous CSV retains its file and selected type; custom assignments persist; real report apply/review actions run; existing invoice review opens; saved documents resume without duplication; cancelling during asynchronous mount recovers the picker; disposal stops requests; read-only intake/link controls; 390/1440 widths and no horizontal overflow. Worker external fetch is blocked. The parent's shared preview process was not touched.

Shared control normalization is complete. Parent confirmed all 13 arayuz-olcek checks pass, independent review passes, and integrated app routes pass at 320/390/1440 widths.

## Limits and parent follow-up

- Parent completed the final preview restart (PID 27636) and confirmed LP workbench returns 200. Both namespaces and the request-body contract are covered by fresh worker regressions. No outstanding workbench integration changes are required.
- Each source list displays its first 200 open issues and the latest 1000 persisted tasks; the UI explicitly reports caps and provides source links. Source counts themselves are exact. Audit endpoint shows the latest 100 versions.
- Partially linked multi-invoice documents stay visible and link to the existing document/accounting screen for completion; the existing uploader deliberately blocks rereading already page-linked documents. Only wholly unlinked stored documents use automatic file restoration.
- JPG/PNG images are supported; other image formats must be converted by the user. The existing OCR service still needs its deployment configuration; failed OCR keeps the original document and manual-review workflow.
- Same pending File lives only in the current mount. Navigating away before upload or refreshing requires reselection; already stored unlinked documents can be resumed from server bytes.
