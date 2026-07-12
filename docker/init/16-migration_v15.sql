-- =====================================================================
-- ADHERE+ migration v15 — collaborator review round
--
-- 1. Newborn HIV exposure is a PATHWAY, not a yes/no drug field.
--    "Newborn ARV needs revision — either exposed or not; for exposed the next
--     intervention is needed, like sending DBS."
--    So: hiv_exposed -> ARV prophylaxis -> DBS (early infant diagnosis).
--
-- 2. Vitamin K TIMING is critical (not just given/not given).
--
-- 3. "Other" must always allow free text (cord care, and elsewhere).
--
-- 4. IPPFP: most facilities give IUCD at delivery. Timing matters clinically —
--    immediate post-placental (within 10 min) vs within 48 hrs.
--
-- 5. A woman already on ART who becomes pregnant is NOT a testing candidate.
--    Her ANC records ART CONTINUATION and viral load, not an HIV test.
--
-- 6. Pregnancy test done in OPD -> must be linkable to the ANC room.
--
-- 7. PNC is for mother AND newborn — each PNC newborn assessment must attach to
--    a specific baby, so a baby (and each twin) can be followed across visits.
--
-- Idempotent. Run on the server:
--   cd ~/ADHERE-plus
--   docker exec -i deploy-db-1 sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" adhere' < deploy/migration_v15.sql
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
-- babies — HIV exposure pathway, Vit K timing, free-text "other"
-- ---------------------------------------------------------------------
CALL adhere_addcol('babies','hiv_exposed',       "TINYINT(1) NULL COMMENT 'Is the newborn HIV-exposed (mother positive)? Drives ARV + DBS'");
CALL adhere_addcol('babies','arv_prophylaxis',   "VARCHAR(20) NULL COMMENT 'If exposed: given | not_given | declined'");
CALL adhere_addcol('babies','dbs_sample',        "VARCHAR(20) NULL COMMENT 'Early infant diagnosis: sent | not_sent | pending'");
CALL adhere_addcol('babies','dbs_date',          "DATE NULL COMMENT 'Date DBS sample sent'");
CALL adhere_addcol('babies','dbs_result',        "VARCHAR(20) NULL COMMENT 'positive | negative | pending'");
-- If the DBS comes back POSITIVE the infant must be linked to the ART clinic.
-- The pathway is: exposed -> ARV prophylaxis -> DBS -> if positive -> ART clinic.
CALL adhere_addcol('babies','art_linked',        "TINYINT(1) NULL COMMENT 'DBS positive: infant linked to ART clinic'");
CALL adhere_addcol('babies','art_linked_date',   "DATE NULL");
CALL adhere_addcol('babies','vitamin_k_time',    "VARCHAR(20) NULL COMMENT 'TIMING is critical: within_1h | 1_24h | after_24h | not_given'");
CALL adhere_addcol('babies','cord_care_other',   "VARCHAR(80) NULL COMMENT 'Free text when cord care = Other'");
CALL adhere_addcol('babies','apgar_flag',        "VARCHAR(10) NULL COMMENT 'DERIVED: normal (>=7 at 5 min) | low (<7 at 5 min)'");

-- Newborn CARE PATHWAYS. Each is prompted by the condition that indicates it, so a
-- recorded problem cannot be left without a recorded response:
--   low birth weight / prematurity -> KMC
--   jaundice                       -> phototherapy
--   severe illness                 -> NICU / referral
CALL adhere_addcol('babies','kmc',               "VARCHAR(20) NULL COMMENT 'Indicated by LBW/prematurity: initiated | not_initiated | not_indicated'");
CALL adhere_addcol('babies','phototherapy',      "VARCHAR(20) NULL COMMENT 'Indicated by jaundice: given | not_given | not_indicated | referred'");
CALL adhere_addcol('babies','nicu',              "VARCHAR(20) NULL COMMENT 'admitted | referred_out | not_indicated | referred_declined'");
CALL adhere_addcol('babies','nicu_facility',     "VARCHAR(80) NULL COMMENT 'Where the newborn was referred/admitted'");
CALL adhere_addcol('babies','antibiotics',       "VARCHAR(20) NULL COMMENT 'Indicated by sepsis/VSD: given | not_given | not_indicated'");
CALL adhere_addcol('babies','oxygen',            "VARCHAR(20) NULL COMMENT 'Indicated by respiratory distress: given | not_given | not_indicated'");

-- ---------------------------------------------------------------------
-- delivery_summary — IPPFP timing (IUCD is the commonest method at delivery)
-- ---------------------------------------------------------------------
CALL adhere_addcol('delivery_summary','ippfp_timing', "VARCHAR(20) NULL COMMENT 'post_placental (within 10 min) | within_48h | not_given'");

-- ---------------------------------------------------------------------
-- anc_visits — the already-on-ART pathway (no re-testing)
-- ---------------------------------------------------------------------
CALL adhere_addcol('anc_visits','art_continued',   "TINYINT(1) NULL COMMENT 'Known HIV positive already on ART: ART continued at this contact'");
CALL adhere_addcol('anc_visits','viral_load',      "VARCHAR(20) NULL COMMENT 'suppressed | unsuppressed | pending | not_done'");
CALL adhere_addcol('anc_visits','viral_load_date', "DATE NULL");
-- An UNSUPPRESSED viral load must trigger linkage back to the ART clinic.
CALL adhere_addcol('anc_visits','art_clinic_linked', "TINYINT(1) NULL COMMENT 'Unsuppressed viral load: woman linked back to ART clinic'");

-- ---------------------------------------------------------------------
-- pnc_visits — attach each newborn assessment to a SPECIFIC baby, so twins
-- and each individual infant can be followed across the five PNC contacts.
-- ---------------------------------------------------------------------
CALL adhere_addcol('pnc_visits','baby_id', "INT NULL COMMENT 'Which newborn this assessment is for (supports twins)'");

-- ---------------------------------------------------------------------
-- pregnancy_tests — OPD pregnancy test, and the link into the ANC room.
-- A positive test creates/links a woman and opens an ANC episode, closing the
-- OPD -> ANC handoff that previously did not exist.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pregnancy_tests (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  facility_id       INT NOT NULL,
  woman_id          INT NULL,
  test_date         DATE NULL,
  result            VARCHAR(10) NULL COMMENT 'positive | negative',
  linked_episode_id INT NULL COMMENT 'ANC episode created when positive and linked',
  linked_at         DATETIME NULL,
  note              VARCHAR(180) NULL,
  recorded_by       INT NULL,
  recorded_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pt_fac (facility_id),
  INDEX idx_pt_woman (woman_id),
  INDEX idx_pt_result (result)
) ENGINE=InnoDB;

DROP PROCEDURE IF EXISTS adhere_addcol;

-- ---------------------------------------------------------------------
-- Backfill.
-- ---------------------------------------------------------------------
-- APGAR flag: <7 at five minutes is the clinically meaningful cut-off.
UPDATE babies SET apgar_flag = CASE WHEN apgar_5min < 7 THEN 'low' ELSE 'normal' END
 WHERE apgar_5min IS NOT NULL AND apgar_flag IS NULL;

-- Carry the old free-text ARV field onto the new pathway where we can.
UPDATE babies SET arv_prophylaxis='given', hiv_exposed=1 WHERE enc_arv='given' AND arv_prophylaxis IS NULL;
UPDATE babies SET arv_prophylaxis='not_given', hiv_exposed=1 WHERE enc_arv='not' AND arv_prophylaxis IS NULL;

-- Single-baby episodes: attach existing PNC visits to that baby.
UPDATE pnc_visits p
  JOIN (SELECT episode_id, MIN(id) AS bid, COUNT(*) AS n FROM babies GROUP BY episode_id HAVING n=1) b
    ON b.episode_id = p.episode_id
   SET p.baby_id = b.bid
 WHERE p.baby_id IS NULL;
