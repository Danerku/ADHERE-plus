# The four modules — build status (rebuild)

| Module | What it is | Implementation | Status |
|---|---|---|---|
| 1 — ML e-partograph risk stratification | Gradient-boosted intrapartum risk → green/amber/red | Real GBM (Ethiopia-calibrated synthetic, AUROC 0.868), exported to JSON, scored on-device (score.js), human-in-the-loop; partograph screen | Built (synthetic; retrain on real data) |
| 2 — Rule-based guideline-adherence engine | FMOH/WHO MCH rules → real-time prompts + adherence score | rules_engine.js + mch_rules.json; evaluates recorded fields, flags unmet steps, adherence gauge | Built (representative rule subset; needs clinical authoring to full 147 + sign-off) |
| 3 — Bayesian longitudinal risk tracking | Cumulative maternal risk across ANC→labour→PNC | bayes_tracker.js — sequential Bayesian log-odds updating; likelihood ratios per finding; posterior + credible band; trajectory chart | Built |
| 4 — Operational intelligence + DHIS2 | Facility time-series + anomaly detection + DHIS2/FHIR export | /api/analytics (monthly indicators + EWMA/2-sigma anomaly flags), /api/dhis2, /api/fhir; dashboard screen with charts | Built (basic analytics; extend indicators/anomaly methods as needed) |

## Visualisation
Dependency-free SVG charts (charts.js): risk-trajectory line with green/amber/red zones
and credible band, adherence gauge, and operational bar charts with anomaly highlighting.
All render offline in the PWA/Android app.

## Honest notes
- Module 1 model is SYNTHETIC (Ethiopia/SSA-calibrated) — retrain on real de-identified data.
- Module 2 ships a representative, structured subset of rules; the full FMOH rule set needs
  clinical authoring and sign-off.
- Module 3 likelihood ratios are clinically-informed approximations (see below) — calibrate
  on real data before clinical use.
- These modules exist in the REBUILD; the originally piloted tool had only the rule-based
  partograph + checklist + risk screening. Keep the proposal's tool description matched to
  what is genuinely deployed vs. newly built.

## Module 3 — likelihood-ratio basis
Findings' likelihood ratios reflect published obstetric associations (pre-eclampsia signs,
obstructed-labour markers, non-reassuring FHR/meconium, fever/ROM, APH) consistent with the
Ethiopia/SSA evidence cited in model_card.md. Values are approximations for demonstration and
must be calibrated against real outcomes before clinical use.
