-- =================================================================================================
-- ADHERE+ migration v31 — INTRAPARTUM CARE: THE LABOUR CARE GUIDE REPLACES THE PARTOGRAPH
--
-- Ethiopia's endorsed Intrapartum Care Guideline replaces the national partograph with the WHO
-- Labour Care Guide (LCG). This is not a rename. What changes, and why this needs its own table:
--
--   * The 1 cm/hour alert line and its action line are GONE. They are replaced by a time limit at
--     each centimetre of dilatation — 5 cm >=6 h, 6 cm >=5 h, 7 cm >=3 h, 8 cm >=2.5 h, 9 cm >=2 h,
--     and in the second stage >=3 h nulliparous / >=2 h multiparous. Poor progress is now a fact
--     about how long she has stood still, not about where a pen mark sits relative to a diagonal.
--   * Active first stage starts at 5 cm, not 4.
--   * New observations the partograph never carried: supportive care (companion, pain relief, oral
--     fluid, posture), FHR deceleration type, fetal position, DURATION of contractions, a real
--     second-stage section, medication (oxytocin, other medicines, IV fluids), and the shared
--     decision-making record (assessment, plan, initials).
--   * Contraction STRENGTH is dropped by the guideline — it cannot be quantified reliably.
--
-- The old `partograph_obs` table is left exactly as it is: 33 observations on 17 episodes that are
-- part of real women's records. They stay readable, printable and countable. They are NOT migrated
-- into the LCG table and NOT relabelled — a partograph observation is not an LCG observation, and
-- pretending otherwise would put words in a clinician's mouth years after the fact. New labour
-- monitoring is written here.
--
-- Idempotent and guarded: safe to run more than once.
-- =================================================================================================

CREATE TABLE IF NOT EXISTS schema_fixups (
  name       VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME    NOT NULL,
  note       VARCHAR(255)
);

-- ---------- 1. Section 1: identifying information and labour characteristics at admission --------
-- These belong to the ADMISSION, not to an observation: they are recorded once, when active labour
-- is diagnosed. `ruptured_datetime` already exists on episodes and is reused — the guideline asks
-- for the date AND time of rupture, and allows "unknown", which is what rom_unknown records.
SET @has1 := (SELECT COUNT(*) FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='episodes' AND COLUMN_NAME='labour_onset');
SET @sql1 := IF(@has1=0,
  "ALTER TABLE episodes
     ADD COLUMN labour_onset     ENUM('spontaneous','induced') NULL COMMENT 'LCG s1: spontaneous or artificially stimulated',
     ADD COLUMN active_labour_dx DATETIME NULL COMMENT 'LCG s1: when active first stage (>=5cm) was diagnosed — the LCG clock starts here',
     ADD COLUMN rom_unknown      TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'LCG s1: membranes ruptured but she cannot say when (U)',
     ADD COLUMN risk_factors     VARCHAR(255) NULL COMMENT 'LCG s1: obstetric/medical/social risk factors carried into labour'",
  "SELECT 'episodes already has the LCG section-1 columns' AS note");
PREPARE s1 FROM @sql1; EXECUTE s1; DEALLOCATE PREPARE s1;

-- ---------- 2. The Labour Care Guide observation ------------------------------------------------
-- One row per ASSESSMENT — the same shape the provider works in (assess -> record -> check -> plan).
-- The grid on screen and on paper is drawn from these rows; the row is the truth, the grid is a view.
CREATE TABLE IF NOT EXISTS lcg_obs (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  episode_id          INT NOT NULL,
  obs_datetime        DATETIME NOT NULL,
  hours_since_active  DECIMAL(4,1) NULL COMMENT 'hours since active first stage (>=5cm) was diagnosed',
  stage               ENUM('first','second') NOT NULL DEFAULT 'first',
  guide_no            TINYINT NOT NULL DEFAULT 1 COMMENT 'labour beyond 12h continues on a second guide',

  -- Section 2: supportive care.  Alert: N (companion / pain relief / oral fluid), SP (posture)
  companion           ENUM('Y','N','D') NULL COMMENT 'D = she declines',
  pain_relief         ENUM('Y','N','D') NULL,
  oral_fluid          ENUM('Y','N','D') NULL,
  posture             ENUM('SP','MO') NULL COMMENT 'SP = supine (alert), MO = mobile/upright/lateral',

  -- Section 3: care of the baby.  Alert: FHR <110 or >=160; L; M+++ or B; P or T; caput +++; moulding +++
  fhr_baseline        INT NULL COMMENT 'counted over 1 full minute',
  fhr_decel           ENUM('N','E','L','V') NULL COMMENT 'none / early / LATE (alert) / variable',
  amniotic_fluid      ENUM('I','C','M+','M++','M+++','B') NULL COMMENT 'intact / clear / meconium graded / blood-stained',
  fetal_position      ENUM('A','P','T') NULL COMMENT 'occiput anterior / POSTERIOR / TRANSVERSE',
  caput               ENUM('0','+','++','+++') NULL,
  moulding            ENUM('0','+','++','+++') NULL COMMENT '+++ = sutures overlapped and not reducible',

  -- Section 4: care of the woman.  Alert: pulse <60 or >=120; SBP <80 or >=140; DBP >=90;
  --            temp <35.0 or >=37.5; urine P++ or A++
  pulse               INT NULL,
  bp_systolic         INT NULL,
  bp_diastolic        INT NULL,
  temperature         DECIMAL(3,1) NULL,
  urine_protein       ENUM('-','trace','+','++','+++','++++') NULL,
  urine_acetone       ENUM('-','+','++','+++','++++') NULL,

  -- Section 5: labour progress.  Alert: contractions <2 or >5 per 10 min; duration <20 s or >60 s;
  --            cervix — the lag time for the current dilatation exceeded with no progress.
  contractions_per10  INT NULL,
  contraction_dur_sec INT NULL COMMENT 'NEW under the LCG — the partograph never recorded this',
  cervix_cm           DECIMAL(3,1) NULL,
  descent_fifths      TINYINT NULL COMMENT 'fifths of the head palpable above the symphysis: 5..0',
  pushing_started     TINYINT(1) NOT NULL DEFAULT 0 COMMENT "second stage: the 'P' on the paper guide",

  -- Section 6: medication
  oxytocin            ENUM('N','Y') NULL,
  oxytocin_units      DECIMAL(4,1) NULL COMMENT 'U/L',
  oxytocin_drops      INT NULL COMMENT 'drops per minute',
  medicine            VARCHAR(255) NULL COMMENT 'name, dose, route',
  iv_fluids           ENUM('N','Y') NULL,

  -- Section 7: shared decision-making — what was found, what was agreed WITH HER, and who wrote it.
  assessment          VARCHAR(500) NULL,
  plan                VARCHAR(500) NULL,
  initials            VARCHAR(16)  NULL,

  -- What the alert column said AT THE TIME. Stored, not recomputed: thresholds may be revised, and
  -- a record must show what the provider was actually shown when she made the decision.
  alerts              VARCHAR(255) NULL COMMENT 'comma-separated alert codes that fired on this row',

  recorded_by         INT NULL,
  recorded_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_lcg_ep_time (episode_id, obs_datetime),
  CONSTRAINT fk_lcg_episode FOREIGN KEY (episode_id) REFERENCES episodes(id),
  CONSTRAINT fk_lcg_user    FOREIGN KEY (recorded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 3. the AI score can hang off an LCG observation too ---------------------------------
-- risk_scores.obs_id points at partograph_obs. A score computed from an LCG assessment needs to
-- point at the row it was computed from, or the record cannot answer "what did it see?".
SET @has3 := (SELECT COUNT(*) FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='risk_scores' AND COLUMN_NAME='lcg_obs_id');
SET @sql3 := IF(@has3=0,
  "ALTER TABLE risk_scores ADD COLUMN lcg_obs_id INT NULL COMMENT 'the LCG assessment this score was computed from'",
  "SELECT 'risk_scores already has lcg_obs_id' AS note");
PREPARE s3 FROM @sql3; EXECUTE s3; DEALLOCATE PREPARE s3;

INSERT IGNORE INTO schema_fixups (name, applied_at, note) VALUES
 ('v31_lcg', NOW(), 'Labour Care Guide: lcg_obs + episodes section-1 fields; partograph_obs retained read-only');

SELECT 'v31 applied' AS status,
       (SELECT COUNT(*) FROM information_schema.TABLES  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lcg_obs') AS lcg_table,
       (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lcg_obs') AS lcg_columns,
       (SELECT COUNT(*) FROM partograph_obs) AS legacy_partograph_rows_kept;
