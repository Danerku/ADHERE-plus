# Model card — ADHERE+ risk models

Two on-device (JavaScript) gradient-boosted models power the clinical decision support:
1. **Maternal intrapartum risk** (`adhere-eth-2.0`) — green / amber / red stratification at each partograph examination.
2. **Newborn resuscitation-need** (`adhere-newborn-eth-1.0`) — likelihood the baby will need active resuscitation, from the intrapartum picture, so the team can prepare.

Both prompt — never replace — clinician assessment, run offline on-device, and pair with a deterministic clinical red-flag safety layer and a transparent MEOWS early-warning score.

## Status — pre-clinical build; revalidate on real records before clinical use
The models are trained on a **clinically-grounded model-development labour cohort** whose complication
prevalences and risk-factor associations are calibrated to Ethiopia/SSA peer-reviewed
meta-analyses. They are suitable for the pipeline, UX, and internal evaluation. They must be
**retrained and revalidated on real, de-identified facility records** before any clinical use;
only the retrained model's metrics belong in a validation appendix.

## Cohort
2,852 labours → 12,824 examination rows (3–6 exams per labour). Signal is
deliberately weaker at early exams and stronger later, reflecting real detectability.
Per-exam positive rate ~25%. A per-birth newborn outcome is derived from the intrapartum
picture (fetal distress, obstruction, sepsis, prematurity, APH, meconium, abnormal FHR);
resuscitation-need rate ~12.5%.

## Complication prevalences — anchored to Ethiopia/SSA evidence
| Condition | Design target (per labour) | Literature anchor |
|---|---|---|
| Obstructed / prolonged labour | 10.2% | Ethiopia SR pooled 11.8% |
| Pre-eclampsia / eclampsia | 12.3% | Ethiopia 11.5%; Amhara 14.08% (study region) |
| Intrapartum fetal distress | 8.3% | Birth asphyxia SR 19.3–23.1% (neonatal, referral-weighted) → intrapartum set lower |
| Maternal / intrapartum sepsis | 4.7% | Puerperal sepsis SR 14.8% (postpartum) → intrapartum set lower |
| Antepartum haemorrhage | 3.1% | APH incidence ~3% |

Risk-factor associations in the cohort match the literature: obstructed labour ↑ with
nulliparity, short stature, post-term, prior CS; birth asphyxia ↑ with APH, PROM, prolonged
labour, meconium; pre-eclampsia ↑ with nulliparity, chronic hypertension, age extremes.

## Features
**Maternal (22):** hours in active labour, cervix (cm), cervical rate, fetal heart rate,
contractions/10min, moulding, meconium, systolic/diastolic BP, urine protein, temperature,
pulse, vaginal bleeding, headache, blurred vision, epigastric pain, clonus, age, parity,
gestational age, prior CS, hours since ROM. Age, parity, and gestational age are now taken
from the woman's registration record (with neutral fallbacks); meconium is read from the
recorded amniotic-fluid finding.

**Newborn (13):** gestational age, meconium, fetal heart rate, moulding, cervix, hours in
labour, contractions/10min, systolic BP, temperature, prior CS, age, parity, hours since ROM.

## Performance (held-out)
**Maternal** — AUROC 0.809; Brier 0.141; calibrated across 10 probability deciles.
Subgroup AUROC: age<18 0.80, age≥35 0.83, primipara 0.80, grand-multipara 0.86, prior CS 0.77, preterm 0.82. Amber 0.33 / red 0.60 thresholds (tunable;
a safety tool typically favours higher sensitivity).
**Newborn** — AUROC 0.747; Brier 0.111. Amber 0.30 / red 0.55 thresholds.

**On-device parity:** the JavaScript evaluator reproduces the Python model to within
~1e-5 probability, confirming the exported tree JSON scores identically offline.

## Transparent MEOWS early-warning (deterministic, no ML)
Alongside the ML estimate, maternal vitals are scored with an aggregate-weighted Modified
Early Obstetric Warning Score (systolic/diastolic BP, pulse, respiratory rate, temperature,
SpO₂). Any single parameter scoring 3, or a total ≥5, triggers red (urgent review); 3–4
triggers amber. The score and the exact triggering parameters are shown to the provider —
fully auditable and independent of the ML model.

## Explainability
Each intrapartum estimate is accompanied by the specific contributing findings (e.g. slow
cervical progress, moulding, abnormal FHR, raised BP, fever, meconium, prolonged labour),
derived from the same clinical mechanisms the model was trained on.

## Intended use / limits
Support, not replace, clinical judgement; every alert requires clinician acknowledgement or a
documented override (logged). Not a substitute for the WHO alert/action cervicograph, which is
retained. Internal/technical validation ≠ prospective clinical validation.

## Reproducibility
Training pipeline: `scripts/train_v2.py` (data generation, training, held-out metrics,
calibration, subgroup AUROC, JS-parity check, JSON export). Prior baseline:
`scripts/generate_and_train.py`.

## Sources (Ethiopia/SSA peer-reviewed)
- Obstructed labour burden — Ethiopia SR/MA: https://pubmed.ncbi.nlm.nih.gov/33581417/ ; https://pmc.ncbi.nlm.nih.gov/articles/PMC9524671/
- Pre-eclampsia — Ethiopia SR/MA (Amhara highest 14.08%): https://pmc.ncbi.nlm.nih.gov/articles/PMC10645334/ ; hypertensive disorders SR: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5774029/
- Birth asphyxia — Ethiopia SR/MA: https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0255488 ; https://bmcpregnancychildbirth.biomedcentral.com/articles/10.1186/s12884-025-08346-w
- Antepartum haemorrhage — Ethiopia SR/MA: https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0319512
- Maternal/puerperal sepsis — Ethiopia SR/MA: https://pmc.ncbi.nlm.nih.gov/articles/PMC8628469/ ; SSA maternal/neonatal sepsis: https://www.frontiersin.org/journals/public-health/articles/10.3389/fpubh.2024.1272193/full
- Maternal near miss — Ethiopia SR/MA (2015–2023): https://pmc.ncbi.nlm.nih.gov/articles/PMC10357694/
- MEOWS (obstetric early warning) — validation literature (e.g. Singh et al.; Carle et al., aggregate-weighted obstetric EWS).
