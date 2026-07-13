# ADHERE+ — maternal & newborn health clinical decision support

An e-partograph and MCH record for Ethiopian health centres and primary hospitals, with an
on-device AI risk score, full offline operation, MoH-aligned registers, audit logging, and
DHIS2/FHIR export.

Live at `adheretool.epichealthsystems.org`.

---

## Status — pre-clinical

In use for evaluation, **not yet validated prospectively**. Read "The models" below, and
`model_card.md`, before quoting any performance figure anywhere.

| | |
|---|---|
| Clinical | ANC · Labour & partograph · Delivery · Newborn · PNC · Danger signs · BEmONC · Referral · Handover |
| Continuum | Pregnancy test → ANC / FP routing · Family planning · LAFP removal · Immunisation (Td / HPV) · PMTCT mother–infant cohort |
| Registers | MoH ANC / Delivery / PNC register export |
| Reporting | Facility dashboard · supervisor dashboard · DHIS2 indicators · FHIR Encounter export |
| Offline | Reads, writes **and new-patient registration** all work with no connection |
| Outstanding | Prospective clinical validation · clinician sign-off · IRB / regulatory clearance |

---

## The models

Two gradient-boosted models run **on the device**, in JavaScript, with no network call.

| Model | File | Field AUROC | 95% CI | Brier |
|---|---|---|---|---|
| Maternal intrapartum risk | `public/model/risk_model.json` — `adhere-eth-3.0` | **0.828** | 0.819–0.835 | 0.119 |
| Newborn resuscitation need | `public/model/newborn_model.json` — `adhere-newborn-eth-3.0` | **0.747** | 0.719–0.771 | 0.098 |

**Read those numbers carefully.**

- They are **field** AUROC — measured under the missingness the tool actually produces, with
  unrecorded features replaced by the model's defaults, exactly as the on-device scorer does. The
  complete-record figures are higher (0.861 / 0.769) but describe a situation that does not occur in
  a real facility. **The field number is the one to quote.**
- The models are trained on a **generated model-development cohort** whose complication prevalences
  and risk-factor associations are calibrated to Ethiopia/SSA peer-reviewed meta-analyses.
  **It is not patient data.** These figures say the model behaves sensibly on data built to resemble
  Ethiopian obstetrics. They say nothing about whether it discriminates in an Ethiopian facility.
  Only a prospective evaluation on real, de-identified records can answer that, and only those
  metrics belong in a validation appendix.
- **Known weakness:** the newborn model is over-confident in its top bin (predicted 0.92 → observed
  0.56). Do not read it as a precise probability at the extreme; the banded output and the
  deterministic red-flag layer are what the interface acts on.
- A deterministic clinical red-flag layer sits **above** the model and can only ever *raise* the
  band, never lower it. The model is not the safety net.

Provenance, the feature contract, calibration, subgroup performance and sources: **`model_card.md`**.

---

## Run it

```
cd docker && docker compose up --build      # → http://localhost:8080
```

Production: **`DEPLOY.md`** (compose.prod + Caddy auto-HTTPS + runbook).

Before every push:

```
bash scripts/check.sh     # truncation guard · JS + PHP parse · SQL balance
```

---

## Layout

```
public/                web root — the SPA, the PWA, and the PHP API under public/api
public/model/          the two models, the JS scorer, the rules engine, the Bayesian tracker,
                       the charts, and the Ethiopian-calendar helper
docker/init/*.sql      canonical schema + every migration in order — the fresh-install path
deploy/                production compose, Caddyfile, migrations, backup + uptime scripts
scripts/train_v3.py    the current training pipeline (cohort generation, training, held-out
                       metrics, calibration, subgroup AUROC, JS-parity check, JSON export)
scripts/check.sh       pre-push checks
android-app/           Capacitor wrapper around the same offline bundle
model_card.md          model provenance, parameters, limitations, citations
MODULES.md             what each module does
data/sample_cohort.csv a small sample of the model-development cohort
```

`docker/init/` is the **only** canonical schema. `deploy/migration_v*.sql` are the same migrations
for an existing database; each one is guarded so it cannot double-apply.

---

## Two things that will bite you

**The Ethiopian calendar is not the Gregorian one.** Pagume, the thirteenth month, has 5 days — 6 in
a leap year (EC year mod 4 == 3), not 30. Dates are entered in the UI in Ethiopian and stored as
Gregorian. `public/model/ethiopian.js` owns that conversion and refuses a date that does not exist.

**Time is Addis Ababa, everywhere.** The browser (`window.ADHERE_TZ`), PHP (`APP_TZ`) and the MySQL
session are all pinned to `Africa/Addis_Ababa`. Timestamps are written as clinic wall-clock, derived
from the absolute instant — so a tablet with a wrong or foreign time zone still writes the right
time. Never reintroduce `toISOString()` for a clinical timestamp: it emits UTC, and Ethiopia is
UTC+3.
