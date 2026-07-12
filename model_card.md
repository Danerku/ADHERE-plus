# Model card — ADHERE+ risk models

Two on-device (JavaScript) gradient-boosted models power the clinical decision support:
1. **Maternal intrapartum risk** (`adhere-eth-3.0`) — green / amber / red stratification at each partograph examination.
2. **Newborn resuscitation-need** (`adhere-newborn-eth-3.0`) — likelihood the baby will need active resuscitation, from the intrapartum picture, so the team can prepare.

Both prompt — never replace — clinician assessment, run offline on-device, and pair with a deterministic clinical red-flag safety layer and a transparent MEOWS early-warning score.

---

## What changed in v3.0, and why it matters (July 2026)

An audit of the deployed tool found that **the model was not receiving the features it was trained
on.** This is the single most important fact about the previous version, and it is why v3.0 exists.

Three of the twenty-two features were dead:

| Feature | What was wrong |
|---|---|
| `prior_cs` | **No form ever wrote `women.prior_cs`**, and the column was not even in the query the scoring screen read. Previous caesarean — the strongest intrapartum predictor, and the reason scar rupture is a risk at all — was **0 for every woman the model ever scored**. |
| `pulse` | The database and API always accepted it; the partograph form never asked for it. Always the default (86). |
| `rom_hours` | The rupture time was recorded on the episode and never passed to the scorer. Always the default. |

In addition, the pre-eclampsia symptom cluster (headache, blurred vision, epigastric pain, clonus,
bleeding, proteinuria) was collected on a separate danger-signs screen and **never handed to the
model**, so it sat at zero. A woman with the full imminent-eclampsia picture was scored as
symptom-free.

All of these are now wired (ADHERE+ v3.9–v4.1). Because that changes what the model sees, the old
metrics no longer describe it — hence the retrain.

### The second, deeper problem: missingness
The previous cohort was **complete** — every simulated row had every feature. The field is not like
that. When a value is missing, the on-device scorer substitutes the model's default, which is a
clinically **normal** value. The old model was therefore trained to trust a number that, in the
field, often means *"nobody measured this"* rather than *"this was normal"*. It could not tell a
normal blood pressure from an unrecorded one.

**v3.0 is trained *and* validated under the same missingness the tool actually produces.** The
headline AUROC below is the number under realistic missingness — not the flattering complete-case
figure.

---

## Status — pre-clinical build; validate prospectively before clinical use
The models are trained on a **generated model-development cohort** whose complication prevalences
and risk-factor associations are calibrated to Ethiopia/SSA peer-reviewed meta-analyses. **It is
not patient data.** The retrain buys a model whose reported metrics correspond to the inputs the
tool actually supplies; it does **not** establish that the model discriminates in Ethiopian
facilities, and it must not be described as if it did. Only a prospective evaluation on real,
de-identified records can answer that, and only those metrics belong in a validation appendix.

## Cohort (v3.0)
12,000 labours → 54,061 examination rows (3–6 exams per labour). Signal is deliberately weaker at
early exams and stronger later, reflecting real detectability. Per-exam positive rate 23.6%.
A per-birth newborn outcome is derived from the intrapartum picture; resuscitation-need rate 13.5%.
New in v3.0: **uterine scar rupture** is modelled explicitly (0.27% overall; ~1.8% in women with a
previous caesarean) — rare, lethal, and the clinical reason `prior_cs` matters.

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

## Features — and the feature contract

**Maternal (22):** hours in active labour, cervix (cm), cervical rate, fetal heart rate,
contractions/10min, moulding, meconium, systolic/diastolic BP, urine protein, temperature,
pulse, vaginal bleeding, headache, blurred vision, epigastric pain, clonus, age, parity,
gestational age, previous caesarean, hours since ROM.

**Newborn (13):** gestational age, meconium, fetal heart rate, moulding, cervix, hours in
labour, contractions/10min, systolic BP, temperature, previous caesarean, age, parity, hours
since ROM.

### The feature contract — how often the tool actually supplies each feature

This table is the heart of the v3.0 retrain. **The model is trained under exactly these
availability rates**, so it learns not to over-trust a default. It is derived from what the
ADHERE+ screens collect, not from an abstract assumption about practice.

| Feature(s) | Supplied | Why |
|---|---|---|
| hours, cervix, fetal heart rate | ~100% | **Required** on the partograph — the save is blocked without them |
| contractions, moulding | 90% | Optional fields on the same form |
| amniotic fluid → meconium | 72% | Optional |
| systolic / diastolic BP | 68% / 65% | Optional; not taken at every examination |
| temperature | 62% | Optional |
| **pulse** | 55% | **New in v4.1** — the field never existed before |
| urine protein | 35% | Optional |
| headache, blurred vision, epigastric pain, clonus, bleeding | 25% | Live on a **separate danger-signs screen**, opened for a minority of women — so usually *absent*, not usually *negative* |
| age, parity | 95% / 90% | From registration |
| gestational age | 62% | Derived from LNMP, which is often not recorded |
| **previous caesarean** | 45% | Requires the ANC risk screening to have been done |
| **hours since ROM** | 42% | **New in v4.1** — derived from the rupture time on the episode |

A missing feature is replaced with the model's own default. **"Not measured" is therefore not
distinguishable from "normal" in the current feature space** — a known limitation, and the reason
the deterministic red-flag layer (which fires only on values that *were* measured) sits above the
model and can only escalate it, never lower it.

## Performance (held-out, v3.0)

**Two numbers are reported, and the smaller one is the honest one.** The *complete-record* AUROC
is what the model achieves when every feature was measured. The *field* AUROC is what it achieves
under the missingness the tool actually produces — features the provider did not record are
substituted with the defaults, exactly as the on-device scorer does. **The field number is the
headline.** Quoting the complete-record figure alone would describe a situation that does not
occur in a real facility.

| Model | Complete records | **Under realistic missingness (field)** | Brier (field) |
|---|---|---|---|
| Maternal `adhere-eth-3.0` | 0.861 | **0.828** (95% CI 0.819–0.835) | 0.119 |
| Newborn `adhere-newborn-eth-3.0` | 0.769 | **0.747** (95% CI 0.719–0.771) | 0.098 |

The ~0.03 gap between the two columns is the measured cost of incomplete recording. It is not a
defect to be hidden; it is the reason the tool now refuses to pre-fill a fetal heart rate.

**Maternal subgroup AUROC (field):** nullipara 0.825, multipara 0.828, age <19 0.831,
age 19–34 0.828, age ≥35 0.811, previous caesarean 0.830, no previous caesarean 0.827.
Discrimination is stable across subgroups; the ≥35 group is the weakest and the smallest (n=770).

**Thresholds:** maternal amber 0.33 / red 0.60; newborn amber 0.30 / red 0.55. Tunable — a safety
tool typically favours sensitivity.

**Calibration (field, maternal):** close to the diagonal across eight bins
(0.10→0.08, 0.17→0.17, 0.30→0.35, 0.44→0.48, 0.56→0.61, 0.69→0.75, 0.82→0.81, 0.92→0.88).
**Known weakness:** the *newborn* model is over-confident in its top bin (predicted 0.92 →
observed 0.56). It should not be relied on as a precise probability at the extreme; the banded
output (amber / red) and the deterministic red-flag layer are what the interface acts on.

### Comparison with v2.0 — read carefully
v2.0 reported **AUROC 0.809**. That figure is **not comparable** to the 0.828 above, and the
difference must not be presented as an improvement:
- it was measured on **complete records**, whereas 0.828 is measured under field missingness;
- it was measured on a **smaller cohort** (6,000 labours vs 12,000);
- above all, it described a model that was being fed **`prior_cs` = 0, `pulse` = default and
  `rom_hours` = default for every single patient**, and no pre-eclampsia symptoms at all.

The correct statement is: *v3.0 is the first version whose reported metrics describe the inputs the
tool actually supplies.* (The repository README previously quoted **0.868**, which matched neither
model and has been corrected.)

**On-device parity:** the JavaScript evaluator reproduces the Python model to within
~1e-6 probability (max difference over 200 held-out rows: 9.5e-07 maternal, 1.2e-06 newborn),
confirming the exported tree JSON scores identically offline.

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
