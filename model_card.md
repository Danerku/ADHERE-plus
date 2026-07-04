# Model card — ADHERE+ intrapartum risk model (synthetic-clinical-eth-1.1)

## Purpose
Decision-support risk stratification (green / amber / red) at each partograph
examination during labour, to prompt (not replace) clinician assessment.
Runs on-device (JavaScript) for offline use.

## Status — SYNTHETIC, for pipeline/UX and demo only
This model is trained on a **clinically-grounded synthetic cohort**. It must be
**retrained and revalidated on real, de-identified records** before any clinical
or evaluation use. Only the retrained model's metrics belong in the proposal's
validation appendix.

## Cohort
~3,500 simulated labours → ~15,700 examination rows (3–6 exams per labour).
Signal is deliberately weaker at early exams and stronger later, reflecting real
detectability. Per-exam positive rate ~24%; per-labour any-complication ~34%
(union of conditions; the Ethiopian source studies are facility/referral-weighted,
so the union is an upper bound for a primary-care population).

## Complication prevalences — anchored to Ethiopia/SSA evidence
| Condition | Simulated (per labour) | Literature anchor |
|---|---|---|
| Obstructed / prolonged labour | 10.0% | Ethiopia SR pooled 11.8% |
| Pre-eclampsia / eclampsia | 12.9% | Ethiopia 11.5%; Amhara 14.08% (study region) |
| Intrapartum fetal distress | 8.4% | Birth asphyxia SR 19.3–23.1% (neonatal, referral-weighted) → intrapartum set lower |
| Maternal / intrapartum sepsis | 4.8% | Puerperal sepsis SR 14.8% (postpartum) → intrapartum set lower |
| Antepartum haemorrhage | 3.3% | APH incidence ~3% |

Risk-factor associations in the simulator match the literature: obstructed labour
↑ with nulliparity, short stature, post-term, prior CS; birth asphyxia ↑ with
APH (OR 4.7), PROM (OR 4.0), prolonged labour (OR 4.2), meconium (OR 5.6);
pre-eclampsia ↑ with nulliparity, chronic hypertension, age extremes.

## Features (22)
hours in active labour, cervix (cm), cervical rate, fetal heart rate, contractions/10min,
moulding, meconium, systolic/diastolic BP, urine protein, temperature, pulse, vaginal
bleeding, headache, blurred vision, epigastric pain, clonus, age, parity, gestational age,
prior CS, hours since ROM.

## Performance (held-out, synthetic)
AUROC 0.868; Brier 0.107; sens 0.66 / spec 0.92 at amber (0.33); sens 0.56 / spec 0.95 at 0.50.
Subgroup AUROC: nullipara 0.865, multipara 0.867. Thresholds are tunable — a safety
tool would typically favour higher sensitivity.

## Intended use / limits
Support, not replace, clinical judgement; every alert requires clinician acknowledgement
or a documented override (logged). Not a substitute for the WHO alert/action cervicograph,
which is retained. Retrospective/synthetic validation ≠ prospective clinical validation.

## Sources (Ethiopia/SSA peer-reviewed)
- Obstructed labour burden — Ethiopia SR/MA: https://pubmed.ncbi.nlm.nih.gov/33581417/ ; https://pmc.ncbi.nlm.nih.gov/articles/PMC9524671/
- Pre-eclampsia — Ethiopia SR/MA (Amhara highest 14.08%): https://pmc.ncbi.nlm.nih.gov/articles/PMC10645334/ ; hypertensive disorders SR: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5774029/
- Birth asphyxia — Ethiopia SR/MA: https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0255488 ; https://bmcpregnancychildbirth.biomedcentral.com/articles/10.1186/s12884-025-08346-w
- Antepartum haemorrhage — Ethiopia SR/MA: https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0319512
- Maternal/puerperal sepsis — Ethiopia SR/MA: https://pmc.ncbi.nlm.nih.gov/articles/PMC8628469/ ; SSA maternal/neonatal sepsis: https://www.frontiersin.org/journals/public-health/articles/10.3389/fpubh.2024.1272193/full
- Maternal near miss — Ethiopia SR/MA (2015–2023): https://pmc.ncbi.nlm.nih.gov/articles/PMC10357694/
