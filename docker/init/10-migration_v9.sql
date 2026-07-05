-- =====================================================================
-- ADHERE+ init 10 — Wave 2 (folded in from migration_v9)
-- Registration risk-history flags on women.
-- Idempotent — safe on fresh install and re-runs.
-- =====================================================================
SET NAMES utf8mb4;

DELIMITER //
DROP PROCEDURE IF EXISTS adhere_v9//
CREATE PROCEDURE adhere_v9()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='women' AND column_name='prior_cs') THEN
    ALTER TABLE women
      ADD COLUMN height_cm INT NULL,
      ADD COLUMN prior_cs VARCHAR(10) NULL,
      ADD COLUMN prior_stillbirth VARCHAR(10) NULL,
      ADD COLUMN prior_pph VARCHAR(10) NULL,
      ADD COLUMN prior_preeclampsia VARCHAR(10) NULL,
      ADD COLUMN prior_obstructed VARCHAR(10) NULL,
      ADD COLUMN chronic_htn VARCHAR(10) NULL,
      ADD COLUMN diabetes VARCHAR(10) NULL,
      ADD COLUMN cardiac_renal VARCHAR(10) NULL;
  END IF;
END//
DELIMITER ;
CALL adhere_v9();
DROP PROCEDURE IF EXISTS adhere_v9;
