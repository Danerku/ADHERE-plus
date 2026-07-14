-- =================================================================================================
-- ADHERE+ migration v36 — LATENT-PHASE LABOUR HAS NOWHERE TO BE RECORDED
--
-- A woman admitted at 3 cm is in the latent first stage. The Labour Care Guide is timed from ACTIVE
-- labour (>=5 cm), so the intrapartum screen would not let anything be saved until active labour was
-- diagnosed — which meant her fetal heart, her cervix, her contractions and her liquor, in the hours
-- before she reached 5 cm, could be recorded NOWHERE in ADHERE+. The provider's only options were to
-- write on paper, or to enter a FALSE active-labour time (which then starts the lag-time clock early
-- and makes normal latent progress look like arrested labour).
--
-- The fix is to let an assessment be recorded in the latent phase, marked as such: hours_since_active
-- is NULL (there is no active-labour clock yet), and stage='latent'. The lag-time cervix alerts do
-- not fire — correctly, she is not in active labour — but the fetal heart, the vitals, the meconium
-- and the temperature alerts all still apply, because those matter from the moment she arrives.
--
-- This only widens the enum. It changes no existing row. Idempotent.
-- =================================================================================================

CREATE TABLE IF NOT EXISTS schema_fixups (
  name VARCHAR(64) NOT NULL PRIMARY KEY, applied_at DATETIME NOT NULL, note VARCHAR(255)
);

SET @t := (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lcg_obs' AND COLUMN_NAME='stage');
SET @sql := IF(@t IS NOT NULL AND @t NOT LIKE '%latent%',
  "ALTER TABLE lcg_obs MODIFY COLUMN stage ENUM('latent','first','second') NOT NULL DEFAULT 'first'
     COMMENT 'latent = recorded before active labour (>=5cm) was diagnosed; the lag-time clock has not started'",
  "SELECT 'lcg_obs.stage already allows latent' AS note");
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

INSERT IGNORE INTO schema_fixups (name, applied_at, note) VALUES
 ('v36_latent', NOW(), 'lcg_obs.stage gains latent — labour below 5cm can be recorded');

SELECT 'v36 applied' AS status,
  (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lcg_obs' AND COLUMN_NAME='stage') AS stage_type;
