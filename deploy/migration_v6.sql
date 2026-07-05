-- =====================================================================
-- ADHERE+ migration v6 — Wave 2 (postnatal structured mother items)
-- Adds to pnc_visits: uterine_tone, perineum, mother_breastfeeding, pp_fp,
-- ifa_continued. Idempotent — safe to run more than once.
-- =====================================================================
SET NAMES utf8mb4;

DELIMITER //
DROP PROCEDURE IF EXISTS adhere_v6//
CREATE PROCEDURE adhere_v6()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='pnc_visits' AND column_name='uterine_tone') THEN
    ALTER TABLE pnc_visits ADD COLUMN uterine_tone VARCHAR(20) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='pnc_visits' AND column_name='perineum') THEN
    ALTER TABLE pnc_visits ADD COLUMN perineum VARCHAR(20) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='pnc_visits' AND column_name='mother_breastfeeding') THEN
    ALTER TABLE pnc_visits ADD COLUMN mother_breastfeeding VARCHAR(20) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='pnc_visits' AND column_name='pp_fp') THEN
    ALTER TABLE pnc_visits ADD COLUMN pp_fp VARCHAR(20) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='pnc_visits' AND column_name='ifa_continued') THEN
    ALTER TABLE pnc_visits ADD COLUMN ifa_continued VARCHAR(10) NULL;
  END IF;
END//
DELIMITER ;
CALL adhere_v6();
DROP PROCEDURE IF EXISTS adhere_v6;
