# ADHERE+ (rebuild) — working project

Clean, standards-instrumented re-implementation of the ADHERE e-partograph / eMCH
platform, with an on-device AI risk score, offline (PWA) operation, audit logging,
and DHIS2/FHIR interoperability for MoH scale-up.

## Status
- [x] Database schema — canonical files in docker/init/ (schema + migrations)
- [x] AI risk model (app/model/risk_model.json) — SYNTHETIC but calibrated to Ethiopia/SSA
      meta-analyses (see model_card.md). AUROC 0.868. Retrain on real data before use.
- [x] JS on-device scorer (app/model/score.js) — matches Python model exactly
- [x] PHP + MySQL backend API (public/api) — auth, CRUD, audit, DHIS2 + FHIR export, sync
- [x] Front-end SPA + all screens: register → partograph (AI) → checklist → danger → delivery → PNC
- [x] Module 2 — rule-based adherence engine (rules_engine.js + mch_rules.json)
- [x] Module 3 — Bayesian longitudinal risk tracker (bayes_tracker.js) + trajectory chart
- [x] Module 4 — operational intelligence (/api/analytics) + dashboard, DHIS2/FHIR export
- [x] Visualisations (charts.js) — trajectory, adherence gauge, ops bars (offline SVG)
- [x] Offline PWA (manifest + service worker + queue/sync)
- [x] Docker/compose package + seed + deploy guide (DEPLOY.md)
- [x] Production server deploy (deploy/ — compose.prod + Caddy auto-HTTPS + RUNBOOK)
- [x] Android app project (android-app/ — Capacitor, offline bundle; see BUILD_ANDROID.md)
- [ ] Retrain model on real de-identified data + validation report (Appendix A)
- [ ] Security review, clinician sign-off, IRB/regulatory clearance

## Run
See DEPLOY.md — `cd docker && docker compose up --build` → http://localhost:8080

## Layout
- docker/init/*.sql — canonical database schema + migrations
- scripts/generate_and_train.py — reproducible simulated cohort + model training
- model_card.md — model provenance, parameters, citations
- app/model/ — model + JS scorer
- public/ — web root (SPA + PWA + PHP API under public/api)
- docker/ — Dockerfile, docker-compose.yml, DB init (schema + seed)
- data/simulated_sample.csv — 400-row sample


