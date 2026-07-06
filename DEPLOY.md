# ADHERE+ (rebuild) — run & deploy

## Run locally (one command)
Requires Docker Desktop.
```
cd docker
docker compose up --build
```
- App:  http://localhost:8080
- DB:   MySQL on localhost:3307 (schema + seed auto-loaded on first run)

First sign-in: username `admin` (bootstrap account created by the seed). **Change this password immediately after first login.** Then create your facilities and staff from the Admin screens.

Try the flow: Register a woman → Labour ward → open her → Partograph →
Record & score (AI band updates) → Checklist / Danger / Delivery.

## What it includes
- PHP 8 + MySQL 8 backend (REST API under /api): auth (bcrypt, role-based), women,
  episodes, partograph observations, risk scores, WHO checklist, danger signs,
  delivery, ANC screening, handover, messages, audit log, offline sync,
  DHIS2 indicator export (/api/dhis2), FHIR Encounter export (/api/fhir/{id}).
- PWA front-end (installable, offline): register → partograph (WHO alert/action +
  on-device AI band) → checklist → danger-sign → delivery → PNC.
- On-device AI model (app/model/risk_model.json) scored in the browser (offline).

## Deploy to a small VM (production)
Use the production compose under `deploy/` (Caddy auto-HTTPS, env-based DB
credentials) — NOT the `docker/` dev compose (default creds, MySQL on 3307,
for local development only).
1. Provision a small Linux VM with Docker + Docker Compose.
2. Clone the repo; `cd deploy && cp .env.example .env` and set `SITE_DOMAIN`
   and strong DB passwords.
3. `docker compose --env-file .env -f docker-compose.prod.yml up -d --build`.
   Caddy issues a Let's Encrypt certificate for `SITE_DOMAIN` automatically.
4. Sign in as `admin`, change the password immediately, create real users.
5. Keep any pre-production instance to test / de-identified data only.
   Real patient data must stay in an Ethiopia-compliant, data-resident
   environment.

## Standards / scale-up hooks (already wired)
- DHIS2 indicator export endpoint + facilities.dhis2_org_unit (Master Facility Registry id).
- FHIR Encounter export endpoint (extend to full FHIR resources as needed).
- audit_log (evaluation evidence);  sync_queue (offline).
- Designed to interoperate with Ethiopia's national DHIS2/FHIR stack, or be
  re-platformed onto DHIS2 Tracker later without discarding the model.

## Before real use
- Retrain the model on real de-identified data; regenerate model_card + validation.
- Independent security 