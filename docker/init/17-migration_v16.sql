-- =====================================================================
-- ADHERE+ migration v16 — fixes from the independent audit
--
-- 1. babies.prob_jaundice — the "Jaundice" tick on the Newborn screen had NO column,
--    no allow-list entry and no payload key. The clinician ticked it, it drove the
--    phototherapy prompt, and then it was silently discarded on save. Data loss.
--
-- 2. delivery_summary UNIQUE(episode_id) — a delivery could be saved twice, which
--    double-counted deliveries, AMTSL and the partograph rate, and duplicated every
--    newborn row in the MoH Delivery register.
--
-- Idempotent. Run on the server:
--   cd ~/ADHERE-plus
--   docker exec -i deploy-db-1 sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" adhere' < deploy/migration_v16.sql
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

CALL adhere_addcol('babies','prob_jaundice', "TINYINT(1) NULL COMMENT 'Newborn jaundice — indicates phototherapy'");

DROP PROCEDURE IF EXISTS adhere_addcol;

-- ---------------------------------------------------------------------
-- One delivery per episode. De-duplicate first (keep the earliest row),
-- then add the constraint.
-- ---------------------------------------------------------------------
DELETE d1 FROM delivery_summary d1
  JOIN delivery_summary d2
    ON d1.episode_id = d2.episode_id AND d1.id > d2.id;

DELIMITER //
DROP PROCEDURE IF EXISTS adhere_v16_uk//
CREATE PROCEDURE adhere_v16_uk()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics
                  WHERE table_schema=DATABASE() AND table_name='delivery_summary' AND index_name='uk_ds_ep') THEN
    ALTER TABLE delivery_summary ADD UNIQUE KEY uk_ds_ep (episode_id);
  END IF;
END//
DELIMITER ;
CALL adhere_v16_uk();
DROP PROCEDURE IF EXISTS adhere_v16_uk;
