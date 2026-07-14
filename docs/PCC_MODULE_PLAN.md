# Preconception Care (PCC) — module plan

Source of truth: **National Preconception Care Guideline, FMOH Ethiopia, June 2024** (80 pp).
Status: **plan only — nothing built until you approve.**

---

## 1. What the guideline actually asks a health centre to do

The document contains two different jobs, and they need two different things in the tool. This is the single most important design point.

**Job A — deliver PCC to a woman who is not pregnant.**
Fifteen components (Table 4, job aid Table 9): family planning/reproductive life plan, nutrition, folic acid, chronic disease (DM, HTN, cardiac, CKD, epilepsy), substance use, physical activity, reproductive-organ anomalies & cervical cancer, sexual health/GBV/FGM, infectious disease, vaccine-preventable disease, genetic risk, teratogenic medicines, mental health, environmental/occupational exposure, dental health. Each component is *assess → intervene → refer/link*.

**Job B — measure PCC uptake in a woman who is already pregnant.**
Table 8: at ANC, ask the woman whether she received each of the 15 components *before* conceiving, verify against her LMP/GA, and classify her:

- **No uptake** — none of the 15
- **Partial uptake** — at least one of the 15
- **Optimal uptake** — folic acid **plus** at least one other

Job B is an ANC add-on, not a separate service. It also produces three of the five national indicators.

**Where PCC is delivered (Implementation Modalities).** Not a standalone clinic at primary level — it is integrated into the units we already have: ANC (the referral unit for PCC inside the facility), family planning, postnatal care, post-abortion care, adolescent & youth. "Every woman, every time." Standalone PCC units are for general/tertiary hospitals only.

**Level of care (Table 5).** Not every component is a primary-level job. Community and primary do FP, nutrition, folic acid, DM, HTN, cardiac, physical activity, GBV, STI/HIV/malaria/TB, VPD, teratogenic medicines, mental health, environmental exposure. CKD, epilepsy, alcohol/drug/medication misuse, FGM, hepatitis B, genetic risk and dental are **primary and above** (some secondary+). The form must therefore mark, per item, whether the health centre *manages* it or *refers* it — otherwise we would be prompting HEWs and midwives to do things the guideline does not ask of them.

---

## 2. Module shape

**Name:** Preconception Care. Entry points: home tile, patient hub card, and a "Start preconception care" action from Family planning, PNC, and post-abortion care (the guideline's integration points).

**One PCC contact = one `pcc_assessment` row**, structured as the job aid: 15 sections, each with the guideline's assessment items and its interventions, plus a per-section outcome (`managed here` / `referred` / `declined` / `not applicable`).

**Progressive disclosure.** Fifteen sections is a long form and long forms get half-filled. So: a short **triage block** first (reproductive life plan + intention to conceive within 3 months, height/weight → BMI, BP, and prior adverse pregnancy outcome), then the 15 sections open collapsed, each showing a one-line status. Only the sections the guideline requires at this level are mandatory. Everything already known about the woman is **pre-filled from her existing record** — last BP, last Hb, HIV status, current FP method, Td doses from immunization, HBsAg from labs — so we are not asking her the same questions twice.

**Reproductive life plan is the spine.** "Do you plan to become pregnant in the next 3 months?" drives everything downstream: if yes → the folic-acid clock and the optimize-before-conception pathway; if no → the FP pathway; if she has a defer-conception condition → effective contraception *until* the condition is optimized.

---

## 3. Decision rules — deterministic, straight from the guideline

No new ML model. This module is a rules module, and I will say so plainly. Every rule below is quoted from the guideline, with a page-anchored comment in the code, and the whole table goes to a clinician for sign-off before it goes live — the same way the LCG thresholds were handled.

| Trigger | Rule |
|---|---|
| Routine, planning pregnancy | Iron 30–60 mg elemental + folic acid **0.4 mg** daily, ≥3 months before conception |
| Prior NTD, diabetes, epilepsy on AEDs, prior adverse pregnancy outcome | **5 mg** folic acid daily, ≥3 months before conception |
| BMI < 18.5 | Underweight — nutrition counselling |
| BMI 25–29.9 / ≥30 | Counsel on risks incl. infertility; diet + activity strategies; screen for DM |
| BP ≥140/90 | Hypertension pathway; contraception until BP optimized |
| FBS >110 mg/dL (target 80–110) or HbA1c outside 5–7% | Diabetes not optimized → contraception until control achieved; 5 mg folic acid |
| WHO cardiac risk class III / IV (Table 2) | Pregnancy high-risk / contraindicated — refer, initiate FP if cardiac function not optimized |
| Creatinine ≥2.5 mg/dL (severe CKD) | Counsel to avoid pregnancy until treated; refer |
| Epilepsy | 5 mg folic acid; flag valproate — avoid teratogenic AEDs; refer for medication review |
| Teratogenic medicine on the list | Flag + refer for switch before conception |
| Td incomplete | Schedule per Table 3 (Td1 → +4 wk → +6 mo) |
| HBsAg negative | 3-dose HBV vaccine. Positive → link to treatment |
| GBV screen positive | Private room, safety, referral pathway |
| HIV positive | Link to PMTCT (module exists) |
| Alcohol / khat / cigarette / >3 cups coffee | Cessation counselling; refer at primary+ for alcohol & drugs |
| Physical activity | ≥150 min moderate aerobic/week + strengthening 2 d/wk |

**Output = a "preconception readiness" statement, not a percentage.** Three states, with the reasons listed: *ready to conceive*, *optimize first* (with the specific items and the target: e.g. "FBS 142 — contraception until fasting glucose 80–110"), or *defer/avoid pregnancy — refer* (WHO cardiac III/IV, severe CKD). A printable care plan, plain layout, like the rest.

**Folic acid clock.** Once high-dose or routine folic acid is started, the tool holds a 3-month countdown and shows "conception advised from <date>" on the patient hub, with an adherence follow-up at 1 and 3 months on the existing reminders table.

**Why no ML here.** The guideline's logic is fully specified and the outcomes it targets (NTD, congenital anomaly) are too rare and too far downstream for anything we could honestly train on. A score would add nothing a clinician could act on and would be a claim we could not defend. If we ever want prediction here, the honest version is a later study, not this build.

---

## 4. ANC uptake checklist (Job B)

At ANC first contact: the Table 8 checklist, 15 yes/no + remark, with the LMP/GA verification prompt the guideline asks for. Auto-derives **No / Partial / Optimal**. Where the woman has a PCC assessment in ADHERE+ already, the items pre-tick from her own record and the provider only confirms — this is the payoff of holding both halves in one tool.

Feeds: the ANC register, the supervisor dashboard, and the national indicators.

---

## 5. Indicators (Table 7) and reporting

| Indicator | Where it comes from |
|---|---|
| Facility providing PCC | Service-started flag (first PCC assessment recorded) |
| Pregnant women with a **planned** pregnancy | ANC intake — already captured |
| Pregnant women who received **IFA before this pregnancy** | Uptake checklist item 3 |
| Pregnant women who received **PCC** | Uptake status ≠ none |
| Women who received **couple counselling** | New field on the PCC assessment |

Plus PCC uptake status distribution and components-delivered counts on the supervisor dashboard, and a `pcc` export type alongside the existing ANC/Delivery/PNC/labour exports. The guideline says MoH will define PCC formats and indicators "to be tracked through DHIS2" — so the aggregates are shaped as period × facility × indicator, ready to map to DHIS2 data elements when MoH publishes them. (Same governance caveat as before: the integration itself is gated on MoH, and hosting location is still the open legal question.)

---

## 6. Build tranches

| # | Tranche | Content |
|---|---|---|
| P1 | Spec + migration **v32** | `pcc_assessments` (~70 cols, 15 sections + triage + outcomes), `pcc_uptake` (15 items + status + verification), `episodes.pcc` type, `reminders` rows for the folic-acid clock. Fresh-install copy. |
| P2 | Rules engine | `public/model/pcc.js` — the single threshold table above, `readiness()`, `folateDose()`, `deferReasons()`, `dueNow()`. Shared by screen, care plan and export. Clinician sign-off before deploy. |
| P3 | Backend | `GET/POST/PATCH /pcc`, `/pcc-uptake`; allow-lists declared once and reused by `/sync` (the drift trap I hit on LCG); ranges added to `ranges()`; void cascade; `/export` gains `pcc`; `CREATES` map gains `pcc`. |
| P4 | PCC screen | Triage + 15 collapsible sections, pre-fill from the existing record, per-item level-of-care badge (manage / refer), live readiness panel, printable care plan. |
| P5 | ANC uptake + reporting | Table 8 checklist on ANC contact 1, uptake status on the patient hub and ANC register, supervisor dashboard tiles, indicator export. |
| P6 | Verify | Live demo patients (MRN 96xxx, voided after), offline queue test, regression across all endpoints, Android `www` resync, model/rules parity check. |

Roughly the size of the LCG build. P1–P3 are the load-bearing part; P4 is the biggest surface.

---

## 7. Risks I want to name up front

**Scope.** Fifteen components is a *lot* to put in front of a midwife who has eight minutes. If we render it as a flat 70-field form, it will be skipped. Progressive disclosure and pre-fill are not polish here, they are the whole viability of the module.

**Level of care.** If the form asks a health centre to manage epilepsy, CKD or genetic risk, we are contradicting Table 5. Every item carries its level, and the primary-level default set is smaller than the full 15.

**Labs we may not have.** HbA1c, creatinine, HBsAg and syphilis are assessment inputs the guideline assumes. Where a facility cannot run them, the readiness output must say "cannot assess — refer", not silently pass her as ready. I will not let an absent test read as a normal test.

**Sign-off.** Same as LCG: the threshold table is mine, transcribed from the guideline; it needs a clinician's name against it before it drives advice in a live facility.

---

## 8. What I need from you

1. Approve or trim the tranche list.
2. Confirm PCC is a **health-centre-level** module (primary default set), not a hospital standalone clinic.
3. Confirm the ANC uptake checklist goes on **ANC contact 1** (not every contact).
4. Confirm: rules only, no ML score in this module.
