-- =====================================================================
-- ADHERE+ init 08 — Wave 2 (folded in from migration_v7)
-- AMTSL fields on delivery_summary; immediate newborn care (ENC) on babies.
-- Idempotent — safe on fresh install and re-runs.
-- =====================================================================
SET NAMES utf8mb4;

DELIMITER //
DROP PROCEDURE IF EXISTS adhere_v7//
CREATE PROCEDURE adhere_v7()
BEGIN
  DECLARE db VARCHAR(64); SET db = DATABASE();
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=db AND table_name='delivery_summary' AND column_name='amtsl_uterotonic') THEN
    ALTER TABLE delivery_summary
      ADD COLUMN amtsl_uterotonic VARCHAR(20) NULL,
      ADD COLUMN amtsl_uterotonic_type VARCHAR(20) NULL,
      ADD COLUMN amtsl_cct VARCHAR(30) NULL,
      ADD COLUMN amtsl_uterine_tone VARCHAR(20) NULL,
      ADD COLUMN amtsl_massage VARCHAR(20) NULL,
      ADD COLUMN amtsl_placenta VARCHAR(20) NULL,
      ADD COLUMN blood_loss_ml INT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=db AND table_name='babies' AND column_name='enc_dried') THEN
    ALTER TABLE babies
      ADD COLUMN enc_dried VARCHAR(20) NULL,
      ADD COLUMN enc_breathing VARCHAR(20) NULL,
      ADD COLUMN enc_vitamin_k VARCHAR(20) NULL,
      ADD COLUMN enc_eye_ointment VARCHAR(20) NULL,
      ADD COLUMN enc_cord_care VARCHAR(20) NULL,
      ADD COLUMN enc_arv VARCHAR(20) NULL;
  END IF;
END//
DELIMITER ;
CALL adhere_v7();
DROP PROCEDURE IF EXISTS adhere_v7;
