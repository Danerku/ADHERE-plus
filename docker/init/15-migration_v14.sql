-- =====================================================================
-- ADHERE+ migration v14 — National ANC Guideline (MoH, Feb 2022) compliance
--
-- Closes the gaps found auditing ADHERE+ against the guideline, in particular
-- Annex 6 (the four-page ANC card), which is the guideline's own data-capture
-- instrument.
--
-- Adds:
--   * women      — blood group + Rh, pregnancy intention, abortion/ectopic/GTD,
--                  residence, occupation  (all PERSON-level: asked once, reused)
--   * anc_visits — calcium, IFA consumed, Anti-D, pallor, urine gram stain, OGTT,
--                  mental health, IPV, substance use, lifestyle + BPCR counselling,
--                  and the DERIVED classifications (BMI, anaemia grade, MUAC flag)
--   * lab_orders — laboratory REQUESTS and RESULTS per contact (new table)
--
-- Clinical rules encoded (guideline refs):
--   * Anaemia   : Hb <11 g/dl.  ≥11 normal · 9–10.9 mild · 7–8.9 moderate · <7 severe
--                 (Section 5.2.2 / Table 7 — the operative clinical table.
--                  The Annex 6 card says "<11.5 or Hct <36%"; the guideline
--                  contradicts itself. We follow Table 7. MoH to confirm.)
--   * MUAC      : <23 cm = acute malnutrition (5.2.2d)
--   * BMI       : <18.5 underweight, >25 overweight/obese (Table 4, Annex 7)
--
-- Idempotent. Run on the server (read the password INSIDE the container):
--   cd ~/ADHERE-plus
--   docker exec -i deploy-db-1 sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" adhere' < deploy/migration_v14.sql
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
-- women — person-level. Asked ONCE, carried forward into every ANC contact,
-- the delivery and the PNC visits. Never re-asked.
-- ---------------------------------------------------------------------
CALL adhere_addcol('women','blood_group',       "VARCHAR(3) NULL COMMENT 'Guideline 4.2.2a: A | B | AB | O'");
CALL adhere_addcol('women','rh_factor',         "VARCHAR(8) NULL COMMENT 'Guideline 4.2.2a: pos | neg. Rh-negative drives Anti-D'");
CALL adhere_addcol('women','pregnancy_planned', "TINYINT(1) NULL COMMENT 'Annex 6. Table 4: unplanned/unwanted pregnancy is a high-risk condition'");
CALL adhere_addcol('women','abortions',         "INT NULL COMMENT 'Annex 6 item 4'");
CALL adhere_addcol('women','ectopic',           "INT NULL COMMENT 'Annex 6 item 4'");
CALL adhere_addcol('women','gtd',               "INT NULL COMMENT 'Annex 6 item 4: gestational trophoblastic disease'");
CALL adhere_addcol('women','residence',         "VARCHAR(10) NULL COMMENT 'Annex 6: urban | rural'");
CALL adhere_addcol('women','occupation',        "VARCHAR(60) NULL COMMENT 'Annex 6'");

-- ---------------------------------------------------------------------
-- anc_visits — per contact
-- ---------------------------------------------------------------------
CALL adhere_addcol('anc_visits','calcium_given',     "TINYINT(1) NULL COMMENT 'Guideline 5.2.2e: 1.5-2.0 g elemental calcium daily (pre-eclampsia prevention)'");
CALL adhere_addcol('anc_visits','ifa_tabs_consumed', "INT NULL COMMENT 'Annex 6 + 5.2.1c: adherence — tabs actually consumed'");
CALL adhere_addcol('anc_visits','anti_d_given',      "TINYINT(1) NULL COMMENT 'Annex 6: Anti-D for Rh-negative, indirect Coombs negative'");
CALL adhere_addcol('anc_visits','pallor',            "VARCHAR(10) NULL COMMENT 'Annex 6: palm and conjunctiva colour — pink | pale'");
CALL adhere_addcol('anc_visits','urine_gramstain',   "VARCHAR(30) NULL COMMENT 'Guideline 4.2.2a: urine analysis incl. gram stain'");
CALL adhere_addcol('anc_visits','ogtt_result',       "VARCHAR(30) NULL COMMENT 'Table 3: 75g 2-hr OGTT for high-risk women'");
CALL adhere_addcol('anc_visits','mental_health',     "VARCHAR(20) NULL COMMENT 'Box 3 + Table 5 (20 & 36 wks): normal | concern | referred | declined'");
CALL adhere_addcol('anc_visits','ipv_screen',        "VARCHAR(20) NULL COMMENT 'Box 3 + Table 5 (20 wks): no | disclosed | referred | declined'");
CALL adhere_addcol('anc_visits','substance_use',     "VARCHAR(60) NULL COMMENT 'Box 3 + Annex 6. CSV: none,alcohol,tobacco,khat,caffeine,other'");
CALL adhere_addcol('anc_visits','cnsl_lifestyle',    "TINYINT(1) NULL COMMENT 'Guideline 5.1.1 + Annex 6: lifestyle modification'");
CALL adhere_addcol('anc_visits','cnsl_bpcr',         "TINYINT(1) NULL COMMENT 'Guideline 5.1.3 + Annex 6: birth preparedness & complication readiness'");
-- Derived and stored so they are reportable and auditable (never hand-entered)
CALL adhere_addcol('anc_visits','bmi',               "DECIMAL(4,1) NULL COMMENT 'DERIVED from height + weight. <18.5 underweight, >25 overweight (Table 4)'");
CALL adhere_addcol('anc_visits','anaemia_grade',     "VARCHAR(10) NULL COMMENT 'DERIVED from Hb (Table 7): normal | mild | moderate | severe'");
CALL adhere_addcol('anc_visits','muac_flag',         "TINYINT(1) NULL COMMENT 'DERIVED: MUAC <23 cm = acute malnutrition (5.2.2d)'");

-- ---------------------------------------------------------------------
-- lab_orders — laboratory REQUESTS and RESULTS, per ANC contact.
-- The guideline treats investigations as ordered-then-resulted, not as a single
-- field. This lets a test be requested at one contact and resulted at the next.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lab_orders (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  episode_id     INT NOT NULL,
  anc_visit_id   INT NULL,
  test_code      VARCHAR(30) NOT NULL,
  requested      TINYINT(1) DEFAULT 1,
  requested_date DATE NULL,
  result         VARCHAR(60) NULL,
  result_date    DATE NULL,
  note           VARCHAR(180) NULL,
  recorded_by    INT NULL,
  recorded_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lab_ep (episode_id),
  INDEX idx_lab_visit (anc_visit_id),
  INDEX idx_lab_code (test_code)
) ENGINE=InnoDB;

DROP PROCEDURE IF EXISTS adhere_addcol;

-- ---------------------------------------------------------------------
-- Backfill the derived classifications for rows already captured.
-- ---------------------------------------------------------------------
-- Anaemia (Table 7). Hb is stored in anc_visits.hgb (g/dl).
UPDATE anc_visits SET anaemia_grade =
  CASE WHEN hgb >= 11              THEN 'normal'
       WHEN hgb >= 9  AND hgb < 11 THEN 'mild'
       WHEN hgb >= 7  AND hgb < 9  THEN 'moderate'
       WHEN hgb <  7               THEN 'severe' END
 WHERE hgb IS NOT NULL AND anaemia_grade IS NULL;

-- Acute malnutrition (5.2.2d)
UPDATE anc_visits SET muac_flag = CASE WHEN muac < 23 THEN 1 ELSE 0 END
 WHERE muac IS NOT NULL AND muac_flag IS NULL;

-- BMI from the woman's height and the weight recorded at the contact
UPDATE anc_visits a
  JOIN episodes e ON e.id = a.episode_id
  JOIN women    w ON w.id = e.woman_id
   SET a.bmi = ROUND(a.weight_kg / POW(w.height_cm/100, 2), 1)
 WHERE a.bmi IS NULL AND a.weight_kg IS NOT NULL AND w.height_cm IS NOT NULL AND w.height_cm > 0;
