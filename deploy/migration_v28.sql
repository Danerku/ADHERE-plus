-- =============================================================================================
-- ADHERE+ migration v28 — WHAT SHE WANTS TO DO ABOUT THE PREGNANCY
--
-- A positive pregnancy test in ADHERE+ had exactly one door out of it: "Open her ANC episode now".
-- The tool assumed every woman with a positive test is continuing the pregnancy and wants antenatal
-- care. Some do not. A woman who does not want to continue, and is offered nothing but an ANC
-- booking, is a woman the facility has just failed — and in this country the alternative to safe
-- care is the unsafe abortion that used to account for roughly a third of maternal deaths.
--
-- Safe abortion care IS provided at health-centre level in Ethiopia, by trained midwives, clinical
-- nurses and health officers, under the FMOH Technical and Procedural Guideline. So the pathway is:
-- continue -> ANC · does not want to continue -> abortion care here, or referral if this facility
-- does not provide it · undecided -> counselling and a follow-up date. Recording it is what makes
-- the follow-up possible.
--
-- Idempotent and guarded: safe to run more than once.
-- =============================================================================================

CREATE TABLE IF NOT EXISTS schema_fixups (
  name       VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME    NOT NULL,
  note       VARCHAR(255)
);

DROP PROCEDURE IF EXISTS adhere_v28;
DELIMITER $$
CREATE PROCEDURE adhere_v28()
BEGIN
  DECLARE n INT;

  SELECT COUNT(*) INTO n FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pregnancy_tests' AND COLUMN_NAME='intent';
  IF n = 0 THEN
    ALTER TABLE pregnancy_tests
      -- what she decided, in her own terms
      ADD COLUMN intent          ENUM('continue','not_continue','undecided') NULL,
      -- if she is not continuing: was the care given here, or was she referred, or did she decline?
      ADD COLUMN abortion_care   ENUM('here','referred','declined') NULL,
      ADD COLUMN referred_to     VARCHAR(120) NULL,
      -- undecided is not a dead end: it is a date to see her again
      ADD COLUMN followup_date   DATE NULL,
      ADD COLUMN counselled      TINYINT(1) NOT NULL DEFAULT 0,
      ADD INDEX idx_pt_intent (intent);
  END IF;
END$$
DELIMITER ;

CALL adhere_v28();
DROP PROCEDURE IF EXISTS adhere_v28;

INSERT IGNORE INTO schema_fixups (name, applied_at, note)
  VALUES ('preg_intent_v28', NOW(), 'pregnancy_tests: intent / abortion_care / referred_to / followup_date / counselled');

SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pregnancy_tests'
   AND COLUMN_NAME IN ('intent','abortion_care','referred_to','followup_date','counselled')
 ORDER BY COLUMN_NAME;

-- Nothing is changed for any existing row: every historical test keeps NULL intent.
SELECT COUNT(*) AS tests_total, SUM(intent IS NULL) AS intent_not_recorded FROM pregnancy_tests;
