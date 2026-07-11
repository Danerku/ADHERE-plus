-- =====================================================================
-- ADHERE+ migration v13 — gestational age at first ANC contact
--
-- Reviewer point: GA at the FIRST ANC contact is an important predictor.
-- It separates early bookers from late comers, and lets us ask whether women
-- who face labour complications are the ones who started ANC late.
--
-- Why a pregnancy-level column and not just anc_visits.ga_weeks:
--   * many women arrive in labour with no ANC contact recorded in ADHERE+
--     (booked elsewhere / on paper), so there is no contact-1 row to read;
--   * reading it back as MIN(ga_weeks) is wrong if contacts are entered
--     out of order or a contact is missed.
-- So we store it once on `women`, auto-filled from ANC contact 1 when we have it,
-- and enterable directly when we do not.
--
-- late_anc_initiation is DERIVED (booking after 12 completed weeks = after the
-- first trimester, per WHO ANC guidance) and stored so it can be reported and,
-- later, used as a model feature.
--
-- Idempotent — safe to re-run.
-- Run on the server (read the password INSIDE the container — $DB_ROOT_PASS is
-- not set in the host shell and mysql will silently no-op with an empty password):
--   cd ~/ADHERE-plus
--   docker exec -i deploy-db-1 sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" adhere' < deploy/migration_v13.sql
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

CALL adhere_addcol('women','ga_first_contact',      "INT NULL COMMENT 'Gestational age in weeks at the FIRST ANC contact (booking GA)'");
CALL adhere_addcol('women','first_contact_date',    "DATE NULL COMMENT 'Date of the first ANC contact'");
CALL adhere_addcol('women','late_anc_initiation',   "TINYINT(1) NULL COMMENT 'Derived: booked after 12 completed weeks (i.e. after the first trimester)'");

DROP PROCEDURE IF EXISTS adhere_addcol;

-- ---------------------------------------------------------------------
-- Backfill from ANC contact 1 where we already have it.
-- ---------------------------------------------------------------------
UPDATE women w
  JOIN (
    SELECT e.woman_id, MIN(a.visit_date) AS d
      FROM anc_visits a JOIN episodes e ON e.id=a.episode_id
     WHERE a.contact_no='1' AND a.ga_weeks IS NOT NULL
     GROUP BY e.woman_id
  ) f ON f.woman_id=w.id
  JOIN anc_visits a2 ON a2.visit_date=f.d
  JOIN episodes e2 ON e2.id=a2.episode_id AND e2.woman_id=w.id AND a2.contact_no='1'
   SET w.ga_first_contact = a2.ga_weeks,
       w.first_contact_date = a2.visit_date
 WHERE w.ga_first_contact IS NULL;

-- Derive the late-initiation flag from whatever booking GA we now hold.
UPDATE women SET late_anc_initiation = CASE WHEN ga_first_contact > 12 THEN 1 ELSE 0 END
 WHERE ga_first_contact IS NOT NULL AND late_anc_initiation IS NULL;
