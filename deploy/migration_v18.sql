-- =====================================================================
-- ADHERE+ migration v18 — PMTCT (MoH register 6, 47 items + cohort grid)
--
-- This register is NOT like the others. It is a COHORT register: the mother and her
-- HIV-exposed infant (HEI) are each followed month by month from enrolment, and the
-- point of it is the outcome at the end — is she retained on ART with a suppressed
-- viral load, and did the infant end up HIV-negative and discharged?
--
-- Three tables, because there are genuinely three things:
--   pmtct_mothers   — one row per mother per pregnancy (items 1-36, 45-47)
--   pmtct_infants   — one row per HIV-exposed infant (items 37-44). Twins get a row each.
--   pmtct_followup  — the monthly cohort grid. One row per subject per month.
--
-- Clinical rules the register encodes, which the app enforces:
--   * Infant ARV prophylaxis = AZT + NVP for the first 6 weeks, then NVP alone for the
--     next 6 weeks — 12 weeks in total.
--   * DNA/PCR (early infant diagnosis) is recorded as the infant's AGE IN WEEKS, because
--     the whole point is whether it happened at ~6 weeks or far too late.
--   * Viral load at 3 months after ART initiation, then every 6 months.
--     <1,000 copies/ml = undetectable; >1,000 = detectable (needs action).
--   * LTF (lost to follow-up) = the client missed an appointment by more than two months.
--   * "Clients coming from ART clinics are NOT transfer-ins" — they count as newly
--     enrolled to the PMTCT cohort for the current pregnancy. (MoH note, verbatim.)
--
-- Idempotent. Run on the server:
--   cd ~/ADHERE-plus
--   docker exec -i deploy-db-1 sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" adhere' < deploy/migration_v18.sql
-- =====================================================================
SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- MOTHER — PMTCT register items 1-36, 45-47
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pmtct_mothers (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  facility_id   INT NOT NULL,
  woman_id      INT NULL COMMENT 'Linked maternity record when she is one of our women',
  name          VARCHAR(150) NULL,
  mrn           VARCHAR(40) NULL,
  art_number    VARCHAR(40) NULL COMMENT 'MoH 4: region/facility-type/facility/patient, e.g. 03/09/001/00001',
  age           INT NULL,
  booking_date  DATE NULL COMMENT 'MoH 6: first date of enrolment in PMTCT',
  -- entry point
  newly_diagnosed TINYINT NULL COMMENT 'MoH 7: 1=ANC 2=L&D 3=postpartum',
  known_positive  TINYINT NULL COMMENT 'MoH 8: 1=on ART at entry, 2=not on ART',
  -- ANC block
  lnmp          DATE NULL,
  edd           DATE NULL,
  ga_weeks      INT NULL,
  ifa_provided  CHAR(1) NULL COMMENT 'MoH 12: Y/N',
  syphilis_result VARCHAR(3) NULL COMMENT 'MoH 13: R | NR | ND',
  feeding_option  VARCHAR(4) NULL COMMENT 'MoH 14: EBF | ERF | MF',
  -- delivery block
  delivery_date DATE NULL,
  infant_sex    CHAR(1) NULL,
  place_of_delivery TINYINT NULL COMMENT 'MoH 17: 1=same facility 2=other facility 3=home',
  delivery_outcome VARCHAR(2) NULL COMMENT 'MoH 18: LB | SB',
  art_during_labour CHAR(1) NULL COMMENT 'MoH 19: Y/N',
  infant_arv_prophylaxis CHAR(1) NULL COMMENT 'MoH 20: AZT+NVP 6wks then NVP 6wks = 12 wks',
  -- family planning (MoH 21-24)
  fp_counselled CHAR(1) NULL,
  fp_acceptor   VARCHAR(10) NULL COMMENT 'new | repeat',
  fp_method     VARCHAR(10) NULL,
  -- partner (MoH 25-28)
  partner_accepted TINYINT(1) NULL,
  partner_result   VARCHAR(3) NULL COMMENT 'P | N | ND',
  partner_target_pop CHAR(1) NULL,
  partner_linked_art TINYINT(1) NULL,
  -- TB and HIV care (MoH 29-36)
  tb_screening  VARCHAR(3) NULL COMMENT 'MoH 29: P | N | ND',
  inh_start_date DATE NULL COMMENT 'MoH 30',
  tb_rx_date    DATE NULL COMMENT 'MoH 31',
  tb_unit_number VARCHAR(30) NULL,
  cd4_count     VARCHAR(20) NULL COMMENT 'MoH 32: value or ND',
  who_stage     TINYINT NULL COMMENT 'MoH 33: 1-4',
  cpt_started   CHAR(1) NULL COMMENT 'MoH 34: Y/N',
  art_start_date DATE NULL COMMENT 'MoH 35',
  art_regimen   VARCHAR(60) NULL COMMENT 'MoH 36 — free text, no national code list supplied',
  -- counselling (MoH 45-47)
  cnsl_ccd      CHAR(1) NULL COMMENT 'MoH 45: care for child development',
  cnsl_nutrition CHAR(1) NULL COMMENT 'MoH 46',
  remark        VARCHAR(255) NULL,
  cohort_month0 CHAR(7) NULL COMMENT 'YYYY-MM of enrolment — the shared event for cohort analysis',
  recorded_by   INT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pm_fac (facility_id),
  INDEX idx_pm_woman (woman_id),
  INDEX idx_pm_cohort (cohort_month0)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- HIV-EXPOSED INFANT (HEI) — items 37-44. One row per infant (twins get one each).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pmtct_infants (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  mother_id      INT NOT NULL,
  baby_id        INT NULL COMMENT 'Link to the delivery newborn record when she delivered here',
  mrn            VARCHAR(40) NULL COMMENT 'MoH 37',
  hei_enrol_date DATE NULL COMMENT 'MoH 38: enrolment into the HEI cohort',
  arv_start_date DATE NULL COMMENT 'MoH 39',
  feeding_6m     VARCHAR(4) NULL COMMENT 'MoH 40: EBF | ERF | MF — recorded at 6 months of age',
  cpt_age_weeks  INT NULL COMMENT 'MoH 41: age in weeks when cotrimoxazole started',
  pcr_age_weeks  INT NULL COMMENT 'MoH 42: age in weeks the DNA/PCR was done — should be ~6 weeks',
  pcr_result     CHAR(1) NULL COMMENT 'MoH 43: P | N',
  rapid_ab_result CHAR(1) NULL COMMENT 'MoH 44: P | N — the confirmatory antibody test at 18 months',
  outcome        VARCHAR(20) NULL COMMENT 'discharged_negative | positive_on_art | ltf | transferred_out | died',
  recorded_by    INT NULL,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pi_mother (mother_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- COHORT FOLLOW-UP — the monthly grid on the right-hand page.
-- One row per subject (mother or infant) per month from enrolment.
-- This is what answers the only question that matters at the end: was she retained
-- and suppressed, and did the infant end up negative?
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pmtct_followup (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  mother_id   INT NOT NULL,
  subject     VARCHAR(6) NOT NULL COMMENT 'mother | infant',
  infant_id   INT NULL COMMENT 'which infant, when subject=infant',
  month_no    INT NOT NULL COMMENT '0 = enrolment month',
  visit_date  DATE NULL,
  status      VARCHAR(24) NULL COMMENT 'mother: on_art | ltf | transferred_out | transferred_in | malnourished | died
                                        infant: exposed_bf | positive | discharged_negative | ltf | transferred_out | died',
  viral_load  VARCHAR(20) NULL COMMENT 'MoH: <1000 = undetectable, >1000 = detectable. Due at 3 months of ART, then every 6 months.',
  vl_value    INT NULL COMMENT 'copies/ml when a number is known',
  note        VARCHAR(180) NULL,
  recorded_by INT NULL,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_fu (mother_id, subject, infant_id, month_no),
  INDEX idx_fu_mother (mother_id),
  INDEX idx_fu_month (month_no)
) ENGINE=InnoDB;
