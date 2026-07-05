-- =====================================================================
-- ADHERE+ migration v8 — Wave 2 (ANC screening/preventive + IMNCI newborn)
--   anc_visits: muac, fetal_movement, hiv_status, syphilis, tetanus_td,
--               iron_folic, malaria_assessed
--   pnc_visits: nb_convulsions, nb_fast_breathing, nb_chest_indrawing,
--               nb_lethargy, nb_jaundice, nb_kmc, nb_immunization, nb_eid
-- Idempotent — safe to run more than once.
-- =====================================================================
SET NAMES utf8mb4;

DELIMITER //
DROP PROCEDURE IF EXISTS adhere_v8//
CREATE PROCEDURE adhere_v8()
BEGIN
  DECLARE db VARCHAR(64); SET db = DATABASE();
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=db AND table_name='anc_visits' AND column_name='muac') THEN
    ALTER TABLE anc_visits
      ADD COLUMN muac DECIMAL(4,1) NULL,
      ADD COLUMN fetal_movement VARCHAR(20) NULL,
      ADD COLUMN hiv_status VARCHAR(20) NULL,
      ADD COLUMN syphilis VARCHAR(20) NULL,
      ADD COLUMN tetanus_td VARCHAR(10) NULL,
      ADD COLUMN iron_folic VARCHAR(20) NULL,
      ADD COLUMN malaria_assessed VARCHAR(10) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=db AND table_name='pnc_visits' AND column_name='nb_convulsions') THEN
    ALTER TABLE pnc_visits
      ADD COLUMN nb_convulsions VARCHAR(5) NULL,
      ADD COLUMN nb_fast_breathing VARCHAR(5) NULL,
      ADD COLUMN nb_chest_indrawing VARCHAR(5) NULL,
      ADD COLUMN nb_lethargy VARCHAR(5) NULL,
      ADD COLUMN nb_jaundice VARCHAR(5) NULL,
      ADD COLUMN nb_kmc VARCHAR(20) NULL,
      ADD COLUMN nb_immunization VARCHAR(20) NULL,
      ADD COLUMN nb_eid VARCHAR(20) NULL;
  END IF;
END//
DELIMITER ;
CALL adhere_v8();
DROP PROCEDURE IF EXISTS adhere_v8;
