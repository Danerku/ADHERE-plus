-- =====================================================================
-- ADHERE+ migration v12 — Ethiopian MoH register alignment
--   ANC (register 3, 35 items) · Delivery (register 4, 66 items) · PNC (register 5, 42 items)
--
-- Design decisions applied:
--   * Target population uses the 9-code list A–I (instruction page), not the 7-code
--     list printed on the register footer. Captured ONCE per person (mother/partner),
--     not repeated at every encounter as the paper does.
--   * The HIV cascade (accepted -> result -> known positive -> linked) is split:
--       - the TEST EVENT is stored per encounter (anc_visits / delivery_summary / pnc_visits)
--       - the PERSON-LEVEL status + linkage lives on `women` (one truth, longitudinal)
--   * Mother's ART regimen is free text for now (no national code list supplied by MoH).
--   * Counselling is captured PER ANC CONTACT and rolled up to "ever counselled"
--     for the register export.
--   * Mutually-exclusive paper tick boxes are collapsed to single-choice fields
--     (maternal status; IPPFP acceptor type). Episiotomy is a procedure, not a mode.
--   * Nothing is dropped. This migration is strictly additive.
--
-- Idempotent — safe to re-run on a live database.
-- Run on the server:
--   docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml exec -T db \
--     mysql -uroot -p"$DB_ROOT_PASS" adhere < deploy/migration_v12.sql
-- =====================================================================
SET NAMES utf8mb4;

DELIMITER //
DROP PROCEDURE IF EXISTS adhere_addcol//
CREATE PROCEDURE adhere_addcol(IN p_tbl VARCHAR(64), IN p_col VARCHAR(64), IN p_def VARCHAR(255))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema=DATABASE() AND table_name=p_tbl AND column_name=p_col) THEN
    SET @s = CONCAT('ALTER TABLE `', p_tbl, '` ADD COLUMN `', p_col, '` ', p_def);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END//
DELIMITER ;

-- ---------------------------------------------------------------------
-- women — person-level identity, target population, HIV cascade, partner
-- (ANC 22/24/25/26/27/28/29 · Delivery 39/40/41/43/45/46/47/48 · PNC 18/19/20/21/22/23/24)
-- ---------------------------------------------------------------------
CALL adhere_addcol('women','woreda',                   "VARCHAR(80) NULL");
CALL adhere_addcol('women','target_pop_code',          "CHAR(1) NULL COMMENT 'A-I; A=FCSW B=Long distance drivers C=Mobile/Daily laborers D=Prisoners E=OVC F=Children of PLHIV G=Partners of PLHIV H=Other MARPS I=General population'");
CALL adhere_addcol('women','hiv_known_positive',       "TINYINT(1) NULL COMMENT 'Known HIV positive transferred/linked from ART'");
CALL adhere_addcol('women','hiv_linked_pmtct',         "TINYINT(1) NULL COMMENT 'ANC 24'");
CALL adhere_addcol('women','hiv_linked_pmtct_facility',"TINYINT NULL COMMENT 'Delivery 41: 1=same facility, 2=other facility'");
CALL adhere_addcol('women','hiv_linked_art',           "TINYINT(1) NULL COMMENT 'PNC 19'");
CALL adhere_addcol('women','art_regimen',              "VARCHAR(120) NULL COMMENT 'Delivery 43 — free text pending national ART regimen code list'");
CALL adhere_addcol('women','partner_hiv_accepted',     "TINYINT(1) NULL");
CALL adhere_addcol('women','partner_hiv_result',       "CHAR(1) NULL COMMENT 'P=positive N=negative I=indeterminate'");
CALL adhere_addcol('women','partner_target_pop_code',  "CHAR(1) NULL COMMENT 'A-I'");
CALL adhere_addcol('women','partner_linked_art',       "TINYINT(1) NULL");

-- Registration hardening (field feedback): emergency-contact address, and obstetric
-- history captured at registration so age/parity risk is visible from the first screen.
CALL adhere_addcol('women','kin_address',             "VARCHAR(150) NULL COMMENT 'Address of husband / emergency contact'");
CALL adhere_addcol('women','prev_pregnancy_outcome',  "VARCHAR(30) NULL COMMENT 'first | live_birth | stillbirth | abortion | neonatal_death | caesarean'");

-- ---------------------------------------------------------------------
-- anc_visits — per ANC contact (MoH items 10-23 + counselling 30-34 + remark 35)
-- ---------------------------------------------------------------------
CALL adhere_addcol('anc_visits','ultrasound_lt24w',       "CHAR(1) NULL COMMENT 'MoH 10: Y/N — ultrasound within 24 weeks GA'");
CALL adhere_addcol('anc_visits','syphilis_result',        "VARCHAR(4) NULL COMMENT 'MoH 11: R/NR/ND'");
CALL adhere_addcol('anc_visits','syphilis_treated',       "TINYINT(1) NULL COMMENT 'MoH 12'");
CALL adhere_addcol('anc_visits','hepb_result',            "VARCHAR(4) NULL COMMENT 'MoH 13: R/NR/ND'");
CALL adhere_addcol('anc_visits','hepb_treated',           "TINYINT(1) NULL COMMENT 'MoH 14'");
CALL adhere_addcol('anc_visits','hepb_prophylaxis',       "TINYINT(1) NULL COMMENT 'MoH 15'");
CALL adhere_addcol('anc_visits','td_dose_no',             "TINYINT NULL COMMENT 'MoH 16: actual Td dose number'");
CALL adhere_addcol('anc_visits','ifa_tabs',               "INT NULL COMMENT 'MoH 17: number of IFA tablets provided'");
CALL adhere_addcol('anc_visits','deworming',              "TINYINT(1) NULL COMMENT 'MoH 18: 2nd/3rd trimester'");
CALL adhere_addcol('anc_visits','hiv_test_accepted',      "TINYINT(1) NULL COMMENT 'MoH 20'");
CALL adhere_addcol('anc_visits','hiv_test_result',        "CHAR(1) NULL COMMENT 'MoH 21: P/N'");
CALL adhere_addcol('anc_visits','hiv_posttest_counselled',"TINYINT(1) NULL COMMENT 'MoH 23'");
CALL adhere_addcol('anc_visits','cnsl_danger_signs',      "TINYINT(1) NULL COMMENT 'MoH 30'");
CALL adhere_addcol('anc_visits','cnsl_nutrition',         "TINYINT(1) NULL COMMENT 'MoH 31: maternal nutrition'");
CALL adhere_addcol('anc_visits','cnsl_ecd',               "TINYINT(1) NULL COMMENT 'MoH 32: early childhood development'");
CALL adhere_addcol('anc_visits','cnsl_infant_feeding',    "TINYINT(1) NULL COMMENT 'MoH 33: breast/infant feeding'");
CALL adhere_addcol('anc_visits','cnsl_family_planning',   "TINYINT(1) NULL COMMENT 'MoH 34'");
CALL adhere_addcol('anc_visits','remark',                 "VARCHAR(255) NULL COMMENT 'MoH 35'");

-- ---------------------------------------------------------------------
-- delivery_summary — mother-level (MoH 7, 11-24, 36-38, 42, 49-51, 66)
-- ---------------------------------------------------------------------
CALL adhere_addcol('delivery_summary','partograph_used',      "CHAR(1) NULL COMMENT 'MoH 7: Y only if maternal + fetal + progress all monitored (derived, stored)'");
CALL adhere_addcol('delivery_summary','episiotomy',           "TINYINT(1) NULL COMMENT 'MoH 11 — a procedure, not a mode of delivery'");
CALL adhere_addcol('delivery_summary','mode_other_text',      "VARCHAR(80) NULL COMMENT 'MoH 12: assisted breech, destructive, etc.'");
CALL adhere_addcol('delivery_summary','maternal_status',      "VARCHAR(20) NULL COMMENT 'MoH 15/16/17 collapsed: stable | unstable_referred | died'");
CALL adhere_addcol('delivery_summary','maternal_death_cause', "TINYINT NULL COMMENT 'MoH 18: 1=Hemorrhage 2=PE/Eclampsia 3=Obstructed labour 4=Sepsis 5=Anemia 6=Other'");
CALL adhere_addcol('delivery_summary','comp_preeclampsia',    "TINYINT(1) NULL COMMENT 'MoH 19'");
CALL adhere_addcol('delivery_summary','comp_eclampsia',       "TINYINT(1) NULL COMMENT 'MoH 20'");
CALL adhere_addcol('delivery_summary','comp_aph',             "TINYINT(1) NULL COMMENT 'MoH 21'");
CALL adhere_addcol('delivery_summary','comp_pph',             "TINYINT(1) NULL COMMENT 'MoH 22'");
CALL adhere_addcol('delivery_summary','comp_other',           "TINYINT(1) NULL COMMENT 'MoH 23'");
CALL adhere_addcol('delivery_summary','referred',             "TINYINT(1) NULL COMMENT 'MoH 24'");
CALL adhere_addcol('delivery_summary','hiv_test_accepted',    "TINYINT(1) NULL COMMENT 'MoH 36'");
CALL adhere_addcol('delivery_summary','hiv_retest_accepted',  "TINYINT(1) NULL COMMENT 'MoH 37'");
CALL adhere_addcol('delivery_summary','hiv_test_result',      "CHAR(1) NULL COMMENT 'MoH 38: P/N'");
CALL adhere_addcol('delivery_summary','cnsl_feeding_options', "TINYINT(1) NULL COMMENT 'MoH 42'");
CALL adhere_addcol('delivery_summary','ippfp_acceptor',       "VARCHAR(10) NULL COMMENT 'MoH 49/50 collapsed: new | repeat'");
CALL adhere_addcol('delivery_summary','ippfp_method',         "VARCHAR(10) NULL COMMENT 'MoH 51 (0-48hrs): POP | Imp | IUCD | TL | Oth'");
CALL adhere_addcol('delivery_summary','remark',               "VARCHAR(255) NULL COMMENT 'MoH 66'");

-- ---------------------------------------------------------------------
-- babies — one row per newborn (MoH: "if twin or triple delivery occurs
-- use consecutive rows for each newborn"). MoH 31, 35, 44, 52-64.
-- ---------------------------------------------------------------------
CALL adhere_addcol('babies','mrn',                  "VARCHAR(40) NULL COMMENT 'MoH 31: newborn MRN'");
CALL adhere_addcol('babies','vacc_bcg',             "TINYINT(1) NULL COMMENT 'MoH 35 code 1'");
CALL adhere_addcol('babies','vacc_opv0',            "TINYINT(1) NULL COMMENT 'MoH 35 code 2'");
CALL adhere_addcol('babies','vacc_hbv',             "TINYINT(1) NULL COMMENT 'MoH 35 code 3'");
CALL adhere_addcol('babies','prob_prematurity',     "TINYINT(1) NULL COMMENT 'MoH 52'");
CALL adhere_addcol('babies','prob_sepsis_vsd',      "TINYINT(1) NULL COMMENT 'MoH 53: sepsis / very severe disease'");
CALL adhere_addcol('babies','prob_resp_distress',   "TINYINT(1) NULL COMMENT 'MoH 54: respiratory distress / asphyxia'");
CALL adhere_addcol('babies','prob_lbw',             "TINYINT(1) NULL COMMENT 'MoH 55 (derived: weight_g < 2500, stored)'");
CALL adhere_addcol('babies','prob_congenital',      "TINYINT(1) NULL COMMENT 'MoH 56'");
CALL adhere_addcol('babies','prob_other',           "TINYINT(1) NULL COMMENT 'MoH 57'");
CALL adhere_addcol('babies','prob_other_text',      "VARCHAR(120) NULL COMMENT 'MoH 57: specify'");
CALL adhere_addcol('babies','breastfeed_initiated', "TINYINT NULL COMMENT 'MoH 58: 1=<1hr 2=1-2hr 3=>3hrs 4=Not at all 5=Other milk'");
CALL adhere_addcol('babies','resuscitated_survived',"TINYINT(1) NULL COMMENT 'MoH 60'");
CALL adhere_addcol('babies','death_age_days',       "INT NULL COMMENT 'MoH 62'");
CALL adhere_addcol('babies','death_age_hours',      "INT NULL COMMENT 'MoH 62'");
CALL adhere_addcol('babies','death_cause',          "TINYINT NULL COMMENT 'MoH 63: 1=Prematurity 2=Infection 3=Asphyxia 4=Other (printed register skips 4; renumbered 1-4)'");
CALL adhere_addcol('babies','birth_notification',   "TINYINT(1) NULL COMMENT 'MoH 64: birth notification given to mother'");

-- ---------------------------------------------------------------------
-- pnc_visits — MoH 10, 12-17, 25-40, 42
-- ---------------------------------------------------------------------
CALL adhere_addcol('pnc_visits','visit_period',          "VARCHAR(10) NULL COMMENT 'MoH 10: 24h | 25-48h | 49-72h | 73h-7d | 8-42d'");
CALL adhere_addcol('pnc_visits','maternal_condition',    "TINYINT NULL COMMENT 'MoH 12: 1=Normal 2=Complicated and managed 3=Complicated and referred 4=Died'");
CALL adhere_addcol('pnc_visits','pph',                   "TINYINT(1) NULL COMMENT 'MoH 13'");
CALL adhere_addcol('pnc_visits','other_obs_complication',"VARCHAR(10) NULL COMMENT 'MoH 14: PE | E | SEP | OTH'");
CALL adhere_addcol('pnc_visits','hiv_test_accepted',     "TINYINT(1) NULL COMMENT 'MoH 15'");
CALL adhere_addcol('pnc_visits','hiv_retest_accepted',   "TINYINT(1) NULL COMMENT 'MoH 16'");
CALL adhere_addcol('pnc_visits','hiv_test_result',       "CHAR(1) NULL COMMENT 'MoH 17: P/N'");
CALL adhere_addcol('pnc_visits','cnsl_danger_signs',     "TINYINT(1) NULL COMMENT 'MoH 25'");
CALL adhere_addcol('pnc_visits','cnsl_breastfeeding',    "TINYINT(1) NULL COMMENT 'MoH 26: breast feeding / nutrition'");
CALL adhere_addcol('pnc_visits','cnsl_newborn_care',     "TINYINT(1) NULL COMMENT 'MoH 27: incl. cord care'");
CALL adhere_addcol('pnc_visits','cnsl_family_planning',  "TINYINT(1) NULL COMMENT 'MoH 28'");
CALL adhere_addcol('pnc_visits','cnsl_epi',              "TINYINT(1) NULL COMMENT 'MoH 29'");
CALL adhere_addcol('pnc_visits','cnsl_ecd',              "TINYINT(1) NULL COMMENT 'MoH 30'");
CALL adhere_addcol('pnc_visits','nb_weight_g',           "INT NULL COMMENT 'MoH 31: newborn weight at this visit'");
CALL adhere_addcol('pnc_visits','nb_problems',           "VARCHAR(60) NULL COMMENT 'MoH 33 CSV codes: 1=Normal 2=Prematurity 3=Sepsis/VSD 4=Respiratory distress 5=Perinatal asphyxia 6=LBW 7=Congenital malformation 8=Absence of reflex 9=Jaundice 10=HC<33cm 11=Other'");
CALL adhere_addcol('pnc_visits','nb_problem_other',      "VARCHAR(120) NULL COMMENT 'MoH 33 code 11: specify'");
CALL adhere_addcol('pnc_visits','nb_treatment',          "VARCHAR(40) NULL COMMENT 'MoH 34 CSV codes: 1=Oxygen resuscitation 2=KMC 3=Antibiotic 4=Chlorhexidine 5=Blood transfusion 6=Other'");
CALL adhere_addcol('pnc_visits','nb_treatment_outcome',  "TINYINT NULL COMMENT 'MoH 35: 1=Improved 2=No change 3=Died 4=Referral 5=Unknown 6=Resuscitated and survived'");
CALL adhere_addcol('pnc_visits','nb_death_age_days',     "INT NULL COMMENT 'MoH 36'");
CALL adhere_addcol('pnc_visits','nb_death_cause',        "TINYINT NULL COMMENT 'MoH 37: 1=Prematurity 2=Infection 3=Asphyxia 4=Other'");
CALL adhere_addcol('pnc_visits','ippfp_acceptor',        "VARCHAR(10) NULL COMMENT 'MoH 38/39 collapsed: new | repeat'");
CALL adhere_addcol('pnc_visits','ippfp_method',          "VARCHAR(10) NULL COMMENT 'MoH 40 (0-48hrs): POP | Imp | IUCD | TL | Oth'");
CALL adhere_addcol('pnc_visits','remark',                "VARCHAR(255) NULL COMMENT 'MoH 42'");

-- ---------------------------------------------------------------------
-- episodes — PNC identification for women who delivered elsewhere
-- (MoH PNC 6 infant DOB, 7 place of delivery). Derived from the delivery
-- record when she delivered with us; captured when she did not.
-- ---------------------------------------------------------------------
CALL adhere_addcol('episodes','place_of_delivery', "TINYINT NULL COMMENT 'MoH PNC 7: 1=Same facility 2=Other facility 3=Home'");
CALL adhere_addcol('episodes','infant_dob',        "DATE NULL COMMENT 'MoH PNC 6'");

DROP PROCEDURE IF EXISTS adhere_addcol;

-- ---------------------------------------------------------------------
-- Backfill what can be derived from data already captured.
-- ---------------------------------------------------------------------
-- MoH 55: low birth weight
UPDATE babies SET prob_lbw = 1 WHERE weight_g IS NOT NULL AND weight_g < 2500 AND prob_lbw IS NULL;
UPDATE babies SET prob_lbw = 0 WHERE weight_g IS NOT NULL AND weight_g >= 2500 AND prob_lbw IS NULL;

-- MoH 15/16/17: maternal status from the existing maternal_outcome enum
UPDATE delivery_summary SET maternal_status='stable'
  WHERE maternal_status IS NULL AND maternal_outcome IN ('well','near_miss');
UPDATE delivery_summary SET maternal_status='unstable_referred'
  WHERE maternal_status IS NULL AND maternal_outcome='referred';
UPDATE delivery_summary SET maternal_status='died'
  WHERE maternal_status IS NULL AND maternal_outcome='death';
UPDATE delivery_summary SET referred=1
  WHERE referred IS NULL AND maternal_outcome='referred';

-- MoH PNC 10: map any existing free-integer pnc_day onto the five MoH visit periods
UPDATE pnc_visits SET visit_period='24h'     WHERE visit_period IS NULL AND pnc_day IS NOT NULL AND pnc_day <= 1;
UPDATE pnc_visits SET visit_period='25-48h'  WHERE visit_period IS NULL AND pnc_day = 2;
UPDATE pnc_visits SET visit_period='49-72h'  WHERE visit_period IS NULL AND pnc_day = 3;
UPDATE pnc_visits SET visit_period='73h-7d'  WHERE visit_period IS NULL AND pnc_day BETWEEN 4 AND 7;
UPDATE pnc_visits SET visit_period='8-42d'   WHERE visit_period IS NULL AND pnc_day >= 8;
