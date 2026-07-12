-- =====================================================================
-- ADHERE+ migration v19 — PMTCT audit fixes
--
-- An independent audit of the v18 PMTCT build found that infant follow-up was
-- anchored to the MOTHER's date of delivery. That is wrong for the majority of the
-- register's own categories: the MoH register explicitly records place of delivery as
-- 1=this facility, 2=another facility, 3=home. For 2 and 3 there is often no delivery
-- date in our record at all — so the infant's age could not be computed, and the
-- "DNA/PCR due at 6 weeks" alert could never fire. An 8-month-old exposed, untested
-- infant was silently invisible.
--
-- The infant needs her own date of birth. That is the fix.
--
-- Idempotent. Run on the server:
--   cd ~/ADHERE-plus
--   docker exec -i deploy-db-1 sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" adhere' < deploy/migration_v19.sql
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

-- The infant's own date of birth — the anchor for every age-based EID rule.
CALL adhere_addcol('pmtct_infants','infant_dob',
  "DATE NULL COMMENT 'Infant date of birth — the anchor for DNA/PCR timing. Independent of the mother delivery_date, which is absent for home and other-facility births.'");

-- Backfill from the mother's delivery date where we already have it, so existing
-- records start working immediately rather than waiting to be re-entered.
UPDATE pmtct_infants i
  JOIN pmtct_mothers m ON m.id = i.mother_id
   SET i.infant_dob = m.delivery_date
 WHERE i.infant_dob IS NULL AND m.delivery_date IS NOT NULL;

DROP PROCEDURE IF EXISTS adhere_addcol;
