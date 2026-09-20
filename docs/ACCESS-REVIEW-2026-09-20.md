# Security Assessment: trusted-device six-digit PIN access
Generated: 2026-09-20T18:12:42.941Z
Repository: C:/Users/baran/Desktop/site/lunapot-panel
Status: Final scoped sidecar review of the file snapshot below; later concurrent edits require rechecking.

## Executive Summary
- **Risk Level:** MEDIUM — remaining operational dependency: traffic must stay blocked throughout database restore and verified access cleanup.
- **Findings:** 0 critical; 2 high and 1 medium initially reproduced, all corrected and locally verified. No remaining reproduced defect in the scoped auth implementation.
- **Immediate Actions Required:** Enforce the recovery maintenance boundary; main owns HTTPS browser verification and final integration.
- **Validation:** 10 sidecar tests pass; 11 focused quick-access tests also pass. No full-suite run, live call, production write, deployment or agent spawning.
- Implementation changes were made by Wegener, not this read-only sidecar. Findings and results were sent directly to Wegener and main using internal thread messaging (`send_input` was unavailable).

## Question Space E(X,Q)
X = `src/quick-access.js`, `src/access-api.js`, `src/login-limits.js`, worker auth routes, migration0052, public quick/access flows, recovery orchestration and business exports.
Q = Does PIN access require its paired device? Are enrollment and session creation safe against concurrent reset/revocation? Are attempt budgets atomic? Are cookies and credentials protected? Do account identity, current permissions, Origin checks, headers, recovery and export boundaries hold?

## Threat Model
Unauthenticated remote attackers; an attacker with a copied device cookie but no PIN; mixed accounts in a shared browser; compromised old passwords/sessions during revocation; and restoration of a snapshot containing revoked access. Assets: owner authority, staff permissions, business data and device grants. Pairing uses a bearer cookie; it is not hardware binding or MFA.

## Findings and Remediation Verification

### HIGH R1 — FIXED: old-password login could survive concurrent reset
**Location:** `src/worker.js:125` and `src/worker.js:134` (initial unconditional insertion was line131).
**Vulnerability:** stale credential validation / session-revocation race.
**Risk:** an old owner password could mint a new authenticated seven-day session after the reset had revoked previous sessions.
**Evidence:** initial code verified a loaded salt/hash, then executed unconditional `INSERT INTO sessions ... VALUES(...)`. The synthetic test resets credentials immediately before insertion; initially its returned cookie still authenticated.
**Remediation implemented:** session insertion now uses `INSERT ... SELECT` with the exact verified salt/hash and current active state. Setup supplies the exact newly created credential snapshot too. No inserted row returns401.
**Verification:** sidecar owner reset and staff reset/deactivation tests pass; stale sessions are not minted.

### HIGH R2 — FIXED WITH OPERATIONAL CONDITION: restore resurrected revoked trusted access
**Location:** `scripts/recovery.mjs:26`, `scripts/recovery.mjs:31`, `scripts/recovery.mjs:36`.
**Vulnerability:** revoked grants/sessions restored from an earlier database state.
**Risk:** previously revoked cookies regain access because grants, sessions and matching credential versions return together.
**Evidence:** initial `applyRecovery()` restored and immediately returned. The regression restores a previously revoked grant/session into memory through the actual orchestrator; initially the old device became available again.
**Remediation implemented:** verify returned target and previous bookmarks, discover existing auth tables, delete restored sessions/grants, and verify zero remaining rows. Pre-device schemas skip the missing device table. Cancellation, cleanup errors and nonzero counts reject completion. The CLI requires an interactive terminal and explicit default-no confirmation before invoking JSON-mode restore.
**Verification:** actual recovery orchestration passes with a synthetic restore runner and real in-memory cleanup SQL. Separate tests cover cancellation, cleanup failure, nonzero remaining rows and pre-device schema.
**Required condition:** keep requests blocked for the whole restore-to-cleanup interval and until schema/permissions are verified. The script does not itself establish a traffic barrier; two remote operations cannot eliminate that interval. Restoring account passwords/permissions also requires operator review. No live D1 restore was attempted.

### MEDIUM R3 — FIXED: replacing a device deleted its own enrollment session
**Location:** `src/quick-access.js:76`, `src/quick-access.js:80`, `migrations/0052_trusted_device_access.sql:33`.
**Vulnerability:** destructive operation ordering.
**Risk:** a user signed in by PIN could supply the correct primary password to replace the PIN, receive409, and lose the old grant/session.
**Evidence:** initial enrollment deleted the old grant first; the deletion trigger removed the current bound session; the following insertion could no longer select that session.
**Remediation implemented:** insert the replacement with session/credential checks first, transfer the reauthenticated caller's bound session to the new grant, then remove the old grant conditionally within one batch.
**Verification:** replacement succeeds with all ten device slots occupied. The caller stays authenticated; sibling sessions from the old grant are revoked; forgetting the replacement also revokes the transferred caller. Concurrent session revocation still prevents enrollment.

## Security Controls Assessed
| Area | Result and evidence |
|---|---|
| Primary password | Minimum12 characters remains for setup/invite/password change. Six-digit strings are accepted only by quick routes. Self-password short input rejected. |
| Enrollment | Primary reauthentication plus a still-valid session and credential snapshot in the insertion; concurrent session deletion blocks creation. |
| Brute force | `src/login-limits.js:17`: atomic pre-verification reservation, five/device and30/IP per fixed15-minute window, saturated counters, no success reset. Reauthentication10/account and30/IP. Parallel tests pass. |
| Cookie | `__Host-lunapot_device`; Secure, HttpOnly, SameSite=Strict, Path=/, no Domain, Max-Age2592000 and matching30-day DB expiry. Browser acceptance remains main's HTTPS check. |
| Revocation | Final grant/version/active check at quick session mint; credential/deactivation triggers revoke grants/sessions; grant deletion revokes bound sessions. Logout intentionally retains device pairing; the UI explains this. |
| Account isolation | Anonymous quick status contains only an availability boolean. Mixed-account quick login/enrollment denied. Device list/revoke scoped to authenticated identity. No prior user's name/device label exposed by status. |
| Permissions | Existing0020/0022 triggers revoke sessions when roles change. A new PIN session reads current roles; denied workspace access stays denied. Deactivation/re-activation does not restore the old grant. Main's separate barcode/lot OR-helper fix is outside sidecar ownership. |
| Self endpoint | Exact `/api/auth/password` bypasses workspace permissions only. Zero-role staff can change their own password; supplied owner/staff IDs do not change target identity. Admin endpoints remain denied. |
| CSRF / headers | Same-origin Origin and JSON guards precede auth mutations. Success/errors retain no-store, nosniff, no-referrer, frame denial, CSP and HTTPS HSTS. |
| Injection / storage | Auth SQL values are bound; UI labels/names escaped. PIN/password forms are cleared after submissions; no PIN logging or local/session storage appears in the reviewed flow. |
| Exports | Both workspaces pass: at most40 tables, fewer than45 prepared statements, no trusted grants, sessions, primary credentials or integration-secret tables. Filter: `src/settings-api.js:39`. |

## Dependency Vulnerabilities
The feature adds no dependency/lock changes. Static lock inventory: wrangler4.130.0, undici7.29.0, esbuild0.28.1, pdf-lib1.17.1, @pdf-lib/fontkit1.1.1. Current advisory lookup/npm audit was not run under the local-only/no-live-calls scope; dependency CVE clearance is not asserted.

| Package | Version | CVE | Severity | Fixed In |
|---|---|---|---|---|
| Existing dependencies | Inventory above | Live advisory check not performed | Unknown | Not asserted |

## Secrets Exposure Check
- `.env` files: ignored through `.env*`; `.dev.vars` also ignored.
- Hardcoded production secrets: none identified in scoped auth changes; tests use synthetic values only.
- Secret management: device tokens stored as SHA-256 hashes; PINs use independent random salts and PBKDF2; cookies HttpOnly. No secret values reproduced in this report.

## Recommendations
### Immediate
1. Keep traffic blocked during restore and cleanup; treat cleanup failure as an operational stop. This is a release/runbook condition, not a claim that the script blocks traffic itself.
2. Main completes actual HTTPS cookie/UI validation and integration checks; no deployed behavior is certified here.
### Short-term
1. Retain the ten sidecar regressions; rerun only affected tests if auth/recovery files change after this snapshot.
### Long-term
1. Validate the restore/maintenance sequence in an isolated D1 environment before any production restoration. In-memory SQLite verifies request logic and SQL, not Cloudflare operational guarantees.

## Validation Record
- `node --test tests/quick-access-review.test.js`:10 passed,0 failed.
- `tests/quick-access.test.js`:11 focused cases passed, including concurrent wrong/correct PIN budget reservation, Origin checks, cookie attributes, expiry and revocation.
- Sidecar initially reproduced R1/R2/R3 before fixes. Final tests retain those exploit paths and now pass.
- Native execution used explicit Desktop workdir and required escalation per requested ACL workflow. Only the review report, required agent-cache mirror and `tests/quick-access-review.test.js` were authored by this sidecar.

## Reviewed Snapshot SHA-256
- `src/quick-access.js`: `c2e6fbdccee7963c27d08732c43ef10c5da6329f0194d1f3e82b1522e6ccdfee`
- `src/access-api.js`: `c8b8a161b96fb704b7503e44380ea79d44ec6282134316c5cc35ad6256af80a8`
- `src/login-limits.js`: `8e1fe5eab0ed90fbc3f51e61f699ae1c1aa1c84b847d321cb461ce3f7a1270d6`
- `src/worker.js`: `54bca4a8c9344fe5bfedf14407d5f4ba600e27b034d67ec14116feadb337a6ff`
- `migrations/0052_trusted_device_access.sql`: `6a553829c4bb811233910df37f106c580d15b6bc9617e8f325927b99ddace88a`
- `scripts/recovery.mjs`: `a2cf1b6f263eade9e8583bc1ca4f873d96aaa6abad6ac43a88e792ad43acf3df`
- `public/quick-access-ui.js`: `6e8ad091d02533b8c0f6ba7c2ab331c0bf65db85a86055339e9d3cb3060abd9b`
- `public/access.js`: `96a4004ad8c9470943bbf04a7c75e0a02ebfcd9addd3eb488cc9ab2693268fdf`
- `tests/quick-access-review.test.js`: `1d1b7d76d8965e1911dff4f1baceb7701ca924c2074a14b0c7cc948ac132e23b`
