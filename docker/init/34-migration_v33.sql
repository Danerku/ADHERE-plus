-- =================================================================================================
-- ADHERE+ migration v33 — "REVIEWED" IS A FACT, AND IT HAS TO BE RECORDED AS ONE
--
-- Caught in the live check of v8.4, on an EMPTY form: the readiness panel said "7 of 15 components
-- recorded" before the provider had touched anything.
--
-- Why: seven of the fifteen components are recorded only with checkboxes (chronic disease, GBV/FGM,
-- genetic risk, medicines, mental health, environmental exposure, dental). An unticked checkbox reads
-- 0, and the completeness test asked `is it not null?` — so 0 ("no") was indistinguishable from
-- untouched. The tool would have told a supervisor that half of a preconception assessment had been
-- delivered when nobody had asked the woman a single question.
--
-- The honest fix is not a cleverer inference. It is to record the thing we actually need to know:
-- did the provider GO THROUGH this component? A negative finding (no diabetes, no violence, no
-- teratogenic medicine) is a real clinical finding and must be recordable as one — but it must be
-- recorded, not assumed from an empty box.
--
-- sections_reviewed holds the component keys the provider explicitly went through, comma-separated.
-- A component counts as delivered if it carries data OR appears here. Nothing else counts.
-- =================================================================================================

CREATE TABLE IF NOT EXISTS schema_fixups (
  name       VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME    NOT NULL,
  note       VARCHAR(255)
);

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pcc_assessments' AND COLUMN_NAME='sections_reviewed');
SET @sql := IF(@has=0,
  "ALTER TABLE pcc_assessments
     ADD COLUMN sections_reviewed VARCHAR(255) NULL
     COMMENT 'component keys the provider explicitly went through (fp,nutrition,folate,chronic,...). A negative finding is a finding; an empty checkbox is not.'",
  "SELECT 'pcc_assessments already has sections_reviewed' AS note");
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

INSERT IGNORE INTO schema_fixups (name, applied_at, note) VALUES
 ('v33_pcc_reviewed', NOW(), 'sections_reviewed: an empty checkbox no longer counts as a component delivered');

SELECT 'v33 applied' AS status,
       (SELECT COUNT(*) FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pcc_assessments' AND COLUMN_NAME='sections_reviewed') AS col_present;
