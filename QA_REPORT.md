# QA report — ADHERE+ rebuild (end-to-end, second pass)

## Method
- Static validation (syntax/JSON/SQL/PHP structure)
- Headless-browser end-to-end drive of every screen with a mocked, auth-enforcing API
- Unit tests of all four module logics + on-device-model exactness vs Python
- Independent adversarial code review by a separate reviewer agent (Fable model)

## Independent review — 14 findings, all triaged and the real ones FIXED
| Sev | Issue | Fix |
|---|---|---|
| Critical | GET read routes (women/episodes/observations/checklist/danger/delivery/fhir) had no auth → PHI exposure | Single `require_auth()` gate applied to every route after login/logout/me |
| High | `moulding` sent as integer into a MySQL ENUM('0','+1','+2','+3') → wrong/failed inserts | Front-end now maps numeric→enum string before POST (verified sends `+2`) |
| High | Override posted `band:'override'` violating the NOT NULL enum | Override now posts a valid band + `override_reason` + `provider_ack` (verified) |
| High | Service worker never invalidated cache → stale app after deploys | Bumped cache to v2, deletes old caches on activate, network-first for the shell |
| Medium | Offline flush dropped server-rejected items (no `res.ok` check) → data loss | flush() now checks `res.ok` and re-queues on failure |
| Medium | Bayesian tracker re-added persistent findings each observation → risk inflated | Per-episode applied-findings set; only newly-appeared findings update (verified: repeat obs → no change) |
| Medium | Stored XSS via unescaped names/MRN in innerHTML | Added `esc()` and escaped all interpolated DB text (verified name escaped) |
| Medium | Observers could write (episodes PATCH, clinical POSTs) | Clinical writes gated to `require_role(['provider','admin'])`; PATCH to recorder/provider/admin |
| Medium | Episodes/women not facility-scoped (multi-tenant leak) | Queries filtered by session `facility_id` |
| Medium | CSRF on cookie session | Session cookie set `HttpOnly` + `SameSite=Lax` |
| Medium | Orphan `/api/sync` route inserted un-whitelisted payload | Added per-table column whitelist to the sync route |
| Low | Partograph x-axis not clamped past 12 h | Clamp hours to axis max |
| Low | Empty PWA icons → not installable | Added 192px + 512px maskable icons + manifest entries |
| Low | Adherence prompts fired before any data | Suppressed until the first observation is recorded |

## Results after fixes
- Static validation: PASS (JS/JSON/SQL/PHP)
- End-to-end drive (auth-enforced): 17/17 PASS, no runtime errors on any screen
- Module logic: PASS (M1 ordering/range/band; M3 monotonic + no double-count; M2 adherence/prompts; charts SVG)
- On-device model vs Python: exact (2e-7)

## Still requires host / real inputs (unchanged)
- Live PHP+MySQL run: `cd docker && docker compose up --build`
- Real-device offline sync round-trip
- Retrain model on real de-identified data + validation appendix
- Full CSRF tokens, security review, clinician/IRB sign-off before real use
- Known minor: a woman registered while offline queues without her episode (re-create episode on reconnect)

---

## Independent (ChatGPT) review punch-list — resolved
The ChatGPT review tested an earlier snapshot, so several items (unauth GETs, XSS,
flush res.ok, override band) were already fixed. The genuinely-outstanding items it
caught are now fixed and re-verified (14/14 post-fix E2E checks pass):

| # | Item | Fix |
|---|---|---|
| 1 | Docker seed/schema duplicate usernames → first-run failure | Removed all seed inserts from schema.sql / 01-schema.sql; test seed lives only in 02-seed.sql (0 vs 1 verified) |
| 3 | PHP API bundled inside Android web assets | Deleted android-app/www/api; added sync-web.sh that excludes api; workflow runs it |
| 6 | Model non-monotonic / no clinical guardrails / feature subset | Added deterministic clinical red-flag layer that can only ESCALATE the AI band (severe BP, severe/abnormal FHR, moulding, fever, arrested/protracted labour); neutral defaults for uncollected features; "pre-clinical — not for clinical use" banner in the UI |
| 7 | Acknowledge not persisted | Added PATCH /risk_scores/{id} (sets provider_ack); front-end captures the score id and persists the acknowledgement |
| 8 | Android packaging | applicationId + namespace = et.epichealthsystems.adhere; app_name = "ADHERE+ MCH"; removed duplicate/mis-packaged MainActivity; fixed MainActivity package; chmod +x gradlew; corrected CI workflow paths (repo root = android-app) |
| 5 | Offline login | Identity cached in localStorage; restored on offline restart with an "offline" indicator; writes still queue |

Verdict alignment: both reviews agree this is a strong prototype/rebuild, not a
clinical/production release. Remaining before real use: live stack smoke test, real-data
model retraining + external validation, full CSRF tokens, security review, clinician/IRB sign-off.

---

## Second independent review (Fable) — remaining issues fixed
Fable confirmed punch-list items A,B,D,E,F,H fully closed; C and G had residual gaps; and it
found 3 still-broken things. All now fixed and re-verified (11/11 E2E incl. hash-id XSS blocked):

| Sev | Issue | Fix |
|---|---|---|
| Critical (CI) | `sync-web.sh` referenced `../public` (outside repo when android-app is repo root) → APK CI build failed | Guarded: skips web-sync when `../public` absent (uses committed www/) |
| High | Web PWA offline broken: SW precached `./config.js` which didn't exist → install failed | Added `public/config.js` (loaded before app.js) |
| High | Android APK couldn't reach the API (no CORS/OPTIONS; SameSite=Lax blocks cross-origin credentialed) | Added CORS allowlist (`https://localhost`, `capacitor://localhost`, site domain) + credentials + OPTIONS preflight; cookie now `SameSite=None; Secure` on HTTPS, `Lax` on local http |
| High | `/sync` batch route writable by observers/recorders | Gated to `require_role(['provider','admin'])` |
| Medium | DOM XSS via episode id from `location.hash` into innerHTML | `esc(id)` in partograph/checklist/danger/delivery headers (verified blocked) |
| Medium | Cross-facility ID reads/writes (women/{id}, episodes PATCH, obs/checklist/danger/delivery, fhir) | `require_ep()` facility guard on all episode-keyed routes; women/{id} facility-scoped |
| Medium | Offline list screens (labour/pnc) threw unhandled rejection offline | `.catch(()=>[])` |
| Medium | 500 handler leaked exception/SQL text | Logs server-side, returns generic error |
| Low | Session fixation; `flush()` retried 4xx forever; action-line rule never fired; no DB healthcheck | `session_regenerate_id(true)` on login; drop 4xx from queue; feed `past_action_line`; MySQL healthcheck + `depends_on: service_healthy` (dev + prod) |

Deferred (documented, non-blocking for the preview): offline registration episode linkage; per-user
offline queue namespacing; facility-filtered analytics; full CSRF tokens. Real-data retraining,
security review, and clinician/IRB sign-off remain required before any real use.

---

## Third Fable pass — confirmation + final closure
Fable confirmed items 1,2,4,5,6,7,8,9,10 CLOSED and the build "functionally CLEAN for the
Docker preview and the APK build" (nothing blocks `docker compose up`, the happy path, or CI APK).
It correctly caught that facility-scoping item 3/3b was incomplete (an earlier replace was a
silent no-op). Now closed:
- `$simple` POST batch: `require_ep()` validates every row's facility before any insert.
- `/sync` loop: `require_ep()` per queued item.
- `risk_scores` PATCH (ack): resolves the score's episode and facility-checks it.
- Nit: `require_ep($_GET['episode']??0)` avoids an undefined-key warning on a param-less GET.
Braces/parens balanced; JS clean. No blocking bugs remain for a Docker preview or APK build.
Deferred (non-blocking, documented): facility-scoped analytics counts, per-user offline queue,
full CSRF tokens. Real-data retraining, security review, and clinician/IRB sign-off remain
required before any real clinical use.
