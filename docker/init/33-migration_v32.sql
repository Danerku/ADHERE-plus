-- =================================================================================================
-- ADHERE+ migration v32 — PRECONCEPTION CARE (PCC)
-- Source: National Preconception Care Guideline, FMOH Ethiopia, June 2024.
--
-- The guideline asks for two different things, and they are two different tables here.
--
--   1. pcc_assessments — DELIVERING preconception care to a woman who is NOT pregnant.
--      Fifteen components (Table 4; job aid Table 9), each one assess -> intervene -> refer.
--      This is deliberately NOT an `episodes` row. An episode in this system is a PREGNANCY
--      (anc / labour / pnc / highrisk). Preconception care happens BEFORE there is a pregnancy to
--      have an episode of, and a woman may receive it many times across many years without ever
--      conceiving. Forcing it into the episode model would either invent a pregnancy that does not
--      exist or bury her PCC record inside a pregnancy she had later. It hangs off the WOMAN.
--
--   2. pcc_uptake — MEASURING preconception care in a woman who IS pregnant. Table 8: at ANC, ask
--      whether she received each of the 15 components BEFORE she conceived, verify the timing
--      against her LMP/GA, and classify her: none / partial / optimal (folic acid PLUS at least one
--      other). This is an ANC observation, so it hangs off the ANC EPISODE. Three of the five
--      national indicators (Table 7) come from this table and from nowhere else.
--
-- Level of care (Table 5) is NOT stored per row. It is a property of the intervention, not of the
-- woman, so it lives in the rules engine (public/model/pcc.js) where a single edit changes it
-- everywhere. What IS stored per component is what the provider actually DID with it: managed it
-- here, referred it, she declined, or it did not apply.
--
-- Idempotent and guarded: safe to run more than once.
-- =================================================================================================

CREATE TABLE IF NOT EXISTS schema_fixups (
  name       VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME    NOT NULL,
  note       VARCHAR(255)
);

-- -------------------------------------------------------------------------------------------------
-- 1. THE PRECONCEPTION CARE CONTACT
-- -------------------------------------------------------------------------------------------------
-- One row per contact. A woman can have many, and the guideline positively wants her to ("every
-- woman, every time" — PCC is offered at FP, at PNC, at post-abortion care, at the youth clinic).
CREATE TABLE IF NOT EXISTS pcc_assessments (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  woman_id           INT NOT NULL,
  facility_id        INT NULL,
  contact_date       DATE NOT NULL,
  entry_point        ENUM('pcc','fp','pnc','post_abortion','ayh','anc','other') NOT NULL DEFAULT 'pcc'
                     COMMENT 'the guideline integrates PCC into existing units — which door she came through',

  -- ---------- TRIAGE: the reproductive life plan is the spine of the whole assessment ----------
  -- Everything downstream turns on this. Planning to conceive -> optimise + start the folic-acid
  -- clock. Not planning -> family planning. A defer-conception condition -> effective contraception
  -- UNTIL the condition is optimised. Without this answer the rest of the form has no direction.
  plans_pregnancy    ENUM('within_3m','within_1y','no','unsure') NULL COMMENT 'RLP: "do you plan to become pregnant?"',
  couple_counselled  TINYINT(1) NULL COMMENT 'Table 7 indicator 5: couple counselling on PCC',
  partner_present    TINYINT(1) NULL,
  parity             TINYINT NULL,
  prior_apo          VARCHAR(255) NULL COMMENT 'adverse pregnancy outcomes: NTD, stillbirth, abortion, preterm, LBW, unintended — drives the 5 mg folate indication',

  -- ---------- 1. Family planning / reproductive life plan --------------------------------------
  fp_current_method  VARCHAR(20) NULL,
  fp_counselled      TINYINT(1) NULL,
  birth_interval_ok  TINYINT(1) NULL COMMENT 'guideline: at least 24 months between births',
  infertility_screen ENUM('no','suspected','known') NULL COMMENT '>=12 months of unprotected intercourse without conception',
  disability          VARCHAR(120) NULL COMMENT 'hearing/visual/physical/intellectual — special-needs counselling',

  -- ---------- 2. Nutrition (Table 1: <18.5 under / 18.5-24.9 normal / 25-29.9 over / >=30 obese) --
  height_cm          DECIMAL(5,1) NULL,
  weight_kg          DECIMAL(5,1) NULL,
  bmi                DECIMAL(4,1) NULL COMMENT 'derived and stored so the record shows what she was told',
  hgb                DECIMAL(4,1) NULL COMMENT 'g/dL — anaemia screen',
  diet_counselled    TINYINT(1) NULL,
  iodized_salt       TINYINT(1) NULL,
  dewormed           TINYINT(1) NULL,

  -- ---------- 3. Iron-folic acid ---------------------------------------------------------------
  -- 0.4 mg routine; 5 mg where there is a prior NTD, diabetes, epilepsy on AEDs or a prior adverse
  -- pregnancy outcome. Both for AT LEAST THREE MONTHS before conception — hence folate_start_date:
  -- it is the clock that tells her when it is safe to try.
  folate_dose        ENUM('none','0.4mg','5mg') NULL,
  folate_start_date  DATE NULL COMMENT 'the 3-month countdown to "conception advised from" runs from here',
  iron_supplied      TINYINT(1) NULL COMMENT 'elemental iron 30-60 mg daily',
  folate_adherence   ENUM('good','partial','poor','na') NULL,

  -- ---------- 4. Chronic disease ---------------------------------------------------------------
  dm_known           TINYINT(1) NULL,
  dm_fbs             INT NULL COMMENT 'mg/dL — preconception target 80-110',
  dm_hba1c           DECIMAL(3,1) NULL COMMENT '% — target 5-7',
  htn_known          TINYINT(1) NULL,
  bp_systolic        INT NULL,
  bp_diastolic       INT NULL,
  cardiac_symptoms   VARCHAR(180) NULL COMMENT 'cough, SOB, orthopnoea, chest pain, palpitation, easy fatigability',
  cardiac_who_class  ENUM('I','II','II-III','III','IV','unknown') NULL COMMENT 'modified WHO maternal cardiovascular risk (Table 2)',
  ckd_known          TINYINT(1) NULL,
  creatinine         DECIMAL(4,2) NULL COMMENT 'mg/dL — mild 0.9-1.4, moderate 1.4-2.5, severe >=2.5',
  epilepsy           TINYINT(1) NULL,
  epilepsy_drug      VARCHAR(120) NULL COMMENT 'valproate is the one to catch',

  -- ---------- 5. Substance use ------------------------------------------------------------------
  alcohol            ENUM('none','occasional','frequent') NULL,
  khat               ENUM('none','occasional','frequent') NULL,
  tobacco            ENUM('none','occasional','frequent') NULL,
  other_substance    VARCHAR(120) NULL COMMENT 'recreational drugs, street medication',
  coffee_cups        TINYINT NULL COMMENT 'guideline: fewer than 3 cups per day',

  -- ---------- 6. Physical activity ---------------------------------------------------------------
  activity_min_week  INT NULL COMMENT 'guideline: >=150 min moderate aerobic per week + strengthening 2 days/week',

  -- ---------- 7. Reproductive organ anomalies and cervical cancer -------------------------------
  cxca_screened      ENUM('yes','no','due','unknown') NULL,
  cxca_result        VARCHAR(60) NULL,
  hpv_vaccinated     ENUM('yes','no','unknown') NULL,
  repro_anomaly      VARCHAR(120) NULL,

  -- ---------- 8. Sexual health, GBV and FGM ------------------------------------------------------
  -- Asked in private, or not asked at all. gbv_screened records that the QUESTION was put to her;
  -- gbv_positive records her answer. Those are not the same fact and must not collapse into one.
  gbv_screened       TINYINT(1) NULL,
  gbv_positive       TINYINT(1) NULL,
  gbv_referred       TINYINT(1) NULL,
  fgm                ENUM('none','yes','unknown') NULL,
  fgm_counselled     TINYINT(1) NULL,
  sexual_dysfunction TINYINT(1) NULL,

  -- ---------- 9. Infectious disease --------------------------------------------------------------
  hiv_status         ENUM('negative','positive','unknown','declined') NULL,
  syphilis           ENUM('negative','positive','not_done') NULL,
  hbsag              ENUM('negative','positive','not_done') NULL,
  tb_screen          ENUM('negative','presumptive','on_treatment','not_done') NULL,
  malaria_risk       TINYINT(1) NULL,
  sti_history        VARCHAR(120) NULL,

  -- ---------- 10. Vaccine-preventable disease (Table 3: Td1 -> +4 wk -> +6 mo) --------------------
  td_doses           TINYINT NULL COMMENT '0-5',
  td_given_today     TINYINT(1) NULL,
  td_next_due        DATE NULL,
  hbv_vaccine_doses  TINYINT NULL COMMENT '3 doses if HBsAg negative',

  -- ---------- 11. Genetic risk -------------------------------------------------------------------
  consanguinity      TINYINT(1) NULL,
  family_hx_genetic  VARCHAR(180) NULL COMMENT '3-generation history of both parents-to-be',
  prior_ntd          TINYINT(1) NULL COMMENT 'the single strongest 5 mg folate indication',

  -- ---------- 12. Medicines with adverse pregnancy effect ----------------------------------------
  current_medicines  VARCHAR(255) NULL COMMENT 'prescribed, over-the-counter, herbal, weight-loss',
  teratogenic_flag   TINYINT(1) NULL,
  teratogenic_named  VARCHAR(180) NULL,

  -- ---------- 13. Mental health ------------------------------------------------------------------
  mh_depression      TINYINT(1) NULL,
  mh_anxiety         TINYINT(1) NULL,
  mh_known_illness   VARCHAR(120) NULL,
  mh_referred        TINYINT(1) NULL,

  -- ---------- 14. Environmental / occupational exposure ------------------------------------------
  exposure_pets      TINYINT(1) NULL,
  exposure_radiation TINYINT(1) NULL,
  exposure_chemicals TINYINT(1) NULL COMMENT 'heavy metals, pesticides, solvents',
  exposure_counselled TINYINT(1) NULL,

  -- ---------- 15. Dental / oral health -----------------------------------------------------------
  dental_problem     TINYINT(1) NULL COMMENT 'bleeding/swollen gums, pain on chewing, loose teeth',
  dental_referred    TINYINT(1) NULL,

  -- ---------- What was concluded, and what she was told -------------------------------------------
  -- readiness is STORED, not recomputed on read. Thresholds get revised; a record must be able to
  -- show what the provider was actually shown on the day she counselled this woman.
  readiness          ENUM('ready','optimize','defer','incomplete') NULL,
  readiness_reasons  VARCHAR(500) NULL COMMENT 'the specific items that produced it — never a bare label',
  cannot_assess      VARCHAR(255) NULL COMMENT 'tests the facility could not run. An absent test must never read as a normal test.',
  referred_to        VARCHAR(180) NULL,
  care_plan          VARCHAR(800) NULL,
  next_visit         DATE NULL,

  voided             TINYINT(1) NOT NULL DEFAULT 0,
  voided_at          DATETIME NULL,
  voided_by          INT NULL,
  void_reason        VARCHAR(255) NULL,

  recorded_by        INT NULL,
  recorded_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_pcc_woman (woman_id, contact_date),
  INDEX idx_pcc_fac (facility_id, contact_date),
  INDEX idx_pcc_voided (voided),
  CONSTRAINT fk_pcc_woman FOREIGN KEY (woman_id)    REFERENCES women(id),
  CONSTRAINT fk_pcc_fac   FOREIGN KEY (facility_id) REFERENCES facilities(id),
  CONSTRAINT fk_pcc_user  FOREIGN KEY (recorded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------------------------------
-- 2. PCC UPTAKE AT ANC  (Table 8 — the national measurement instrument)
-- -------------------------------------------------------------------------------------------------
-- One row per ANC episode. Fifteen yes/no items, asked at the first contact, each one about the
-- period BEFORE she conceived this pregnancy — which is why verified_against exists: the guideline
-- explicitly requires the provider to check the timing she claims against her LMP or GA. An
-- unverified "yes" is not the same fact as a verified one, and the indicator should be able to
-- tell them apart.
CREATE TABLE IF NOT EXISTS pcc_uptake (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  episode_id       INT NOT NULL,
  woman_id         INT NOT NULL,
  facility_id      INT NULL,
  asked_date       DATE NOT NULL,
  verified_against ENUM('lmp','ga','not_verified') NULL,

  i1_family_planning     TINYINT(1) NULL,
  i2_nutrition_bmi       TINYINT(1) NULL,
  i3_folic_acid          TINYINT(1) NULL COMMENT 'the item that makes uptake OPTIMAL rather than partial',
  i4_chronic_disease     TINYINT(1) NULL COMMENT 'DM, HTN, kidney, cardiac, epilepsy',
  i5_substance_use       TINYINT(1) NULL,
  i6_physical_activity   TINYINT(1) NULL,
  i7_repro_cxca          TINYINT(1) NULL,
  i8_sexual_gbv_fgm      TINYINT(1) NULL,
  i9_infectious          TINYINT(1) NULL COMMENT 'syphilis, HIV, TB, hep B, malaria',
  i10_vaccine            TINYINT(1) NULL COMMENT 'hep B and Td',
  i11_genetic            TINYINT(1) NULL,
  i12_medication         TINYINT(1) NULL,
  i13_mental_health      TINYINT(1) NULL,
  i14_environmental      TINYINT(1) NULL,
  i15_dental             TINYINT(1) NULL,

  -- none = none of the 15 · partial = at least one · optimal = folic acid PLUS at least one other.
  -- Derived by the rules engine and stored, so the register and the indicator agree with what the
  -- provider saw on the screen.
  status           ENUM('none','partial','optimal') NULL,
  planned_pregnancy TINYINT(1) NULL COMMENT 'Table 7 indicator 2 — asked here, not inferred',
  remark           VARCHAR(255) NULL,

  voided           TINYINT(1) NOT NULL DEFAULT 0,
  voided_at        DATETIME NULL,
  voided_by        INT NULL,
  void_reason      VARCHAR(255) NULL,

  recorded_by      INT NULL,
  recorded_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_pcc_uptake_episode (episode_id),
  INDEX idx_pccu_fac (facility_id, asked_date),
  INDEX idx_pccu_woman (woman_id),
  CONSTRAINT fk_pccu_episode FOREIGN KEY (episode_id)  REFERENCES episodes(id),
  CONSTRAINT fk_pccu_woman   FOREIGN KEY (woman_id)    REFERENCES women(id),
  CONSTRAINT fk_pccu_fac     FOREIGN KEY (facility_id) REFERENCES facilities(id),
  CONSTRAINT fk_pccu_user    FOREIGN KEY (recorded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------------------------------
-- 3. The folic-acid clock reuses the reminders table that already exists.
-- -------------------------------------------------------------------------------------------------
-- Nothing to add: reminders(woman_id, due_date, kind, ...) already carries what we need. This block
-- only widens `kind` if it is an ENUM that does not yet know about PCC.
SET @kindtype := (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='reminders' AND COLUMN_NAME='kind');
SET @needs := IF(@kindtype IS NOT NULL AND @kindtype LIKE 'enum%' AND @kindtype NOT LIKE '%pcc%', 1, 0);
SET @sqlk := IF(@needs=1,
  "ALTER TABLE reminders MODIFY COLUMN kind VARCHAR(32) NOT NULL COMMENT 'anc/pnc/imm/fp/pcc_folate/pcc_followup'",
  "SELECT 'reminders.kind already accepts PCC' AS note");
PREPARE sk FROM @sqlk; EXECUTE sk; DEALLOCATE PREPARE sk;

INSERT IGNORE INTO schema_fixups (name, applied_at, note) VALUES
 ('v32_pcc', NOW(), 'Preconception care: pcc_assessments (woman-level, 15 components) + pcc_uptake (ANC, Table 8)');

SELECT 'v32 applied' AS status,
       (SELECT COUNT(*) FROM information_schema.TABLES  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pcc_assessments') AS pcc_table,
       (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pcc_assessments') AS pcc_columns,
       (SELECT COUNT(*) FROM information_schema.TABLES  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pcc_uptake')      AS uptake_table,
       (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pcc_uptake')      AS uptake_columns;
