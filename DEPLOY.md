# ADHERE+ (rebuild) — run & deploy

## Run locally (one command)
Requires Docker Desktop.
```
cd docker
docker compose up --build
```
- App:  http://localhost:8080
- DB:   MySQL on localhost:3307 (schema + seed auto-loaded on first run)

Demo logins (password `demo1234`): `recorder1`, `provider1`, `observer1`, `admin`.

Try the flow: sign in as `provider1` → Labour ward → open the seeded woman →
Partograph → Record & score (AI band updates) → Checklist / Danger / Delivery.
Register new women as `recorder1`.

## What it includes
- PHP 8 + MySQL 8 backend (REST API under /api): auth (bcrypt, role-based), women,
  episodes, partograph observations, risk scores, WHO checklist, danger signs,
  delivery, ANC screening, handover, messages, audit log, offline sync,
  DHIS2 indicator export (/api/dhis2), FHIR Encounter export (/api/fhir/{id}).
- PWA front-end (installable, offline): register → partograph (WHO alert/action +
  on-device AI band) → checklist → danger-sign → delivery → PNC.
- On-device AI model (app/model/risk_model.json) scored in the browser (offline).

## Deploy to an Epic subdomain / small VM
1. Provision a small Linux VM with Docker (or any PHP 8 + MySQL host).
2. Copy this folder up;  `cd docker && docker compose up -d --build`.
3. Point a subdomain (e.g. partograph-dev.epichealthsystems.org) at the host; put
   Nginx/Caddy in front for TLS (Let's Encrypt) → proxy to port 8080.
4. Change all default passwords; set strong DB credentials via the compose env.
5. Keep the DEV instance to synthetic / de-identified data only. Real patient data
   must stay in an Ethiopian-compliant environment (data residency).

## Standards / scale-up hooks (already wired)
- DHIS2 indicator export endpoint + facilities.dhis2_org_unit (Master Facility Registry id).
- FHIR Encounter export endpoint (extend to full FHIR resources as needed).
- audit_log (evaluation evidence);  sync_queue (offline).
- Designed to interoperate with Ethiopia's national DHIS2/FHIR stack, or be
  re-platformed onto DHIS2 Tracker later without discarding the model.

## Before real use
- Retrain the model on real de-identified data; regenerate model_card + validation.
- Independent security review; clinician sign-off; IRB/regulatory clearance.
