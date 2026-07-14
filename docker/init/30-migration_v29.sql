-- =============================================================================================
-- ADHERE+ migration v29 — THE PREGNANCY THAT ENDS EARLY, AND THE WOMAN WHO DIES BEFORE LABOUR
--
-- Two holes, both of them where the deaths are.
--
-- 1. ABORTION / MISCARRIAGE / ECTOPIC. ADHERE+ had three episode types: antenatal, labour, and
--    postnatal. A pregnancy that ends before viability fitted none of them. So a woman who
--    miscarried at 14 weeks, a woman treated for an incomplete abortion, a woman with an ectopic
--    pregnancy — none of them could be recorded as what they were. Either she was left on the ANC
--    worklist as if still pregnant, or her record was quietly abandoned. Abortion complications and
--    ectopic pregnancy are direct obstetric killers, and post-abortion contraception is the single
--    most effective thing a facility can do to prevent the next one. None of it was captured.
--
-- 2. MATERNAL DEATH BEFORE DELIVERY. A maternal death could only be recorded in two places: the
--    delivery record (maternal_status = died) and the postnatal visit (condition = died). A woman
--    who died antenatally — of eclampsia at 30 weeks, of a ruptured ectopic, of sepsis after an
--    unsafe abortion — could not be recorded as having died AT ALL. She simply stopped appearing.
--    That is not a missing feature; it is the definition of an unreported maternal death, in a
--    country whose maternal death surveillance depends on facilities reporting them.
--
-- Idempotent and guarded: safe to run more than once.
-- =============================================================================================

CREATE TABLE IF NOT EXISTS schema_fixups (
  name       VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME    NOT NULL,
  note       VARCHAR(255)
);

-- ---------- 1. a new kind of episode ---------------------------------------------------------
-- MySQL cannot ADD to an ENUM without restating it, so the whole list is restated. The existing
-- four values keep their exact spelling and order — anything else would rewrite live data.
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='episodes'
                AND COLUMN_NAME='service_category' AND COLUMN_TYPE LIKE '%abortion%');
SET @sql := IF(@has=0,
  "ALTER TABLE episodes MODIFY service_category ENUM('anc','labour','pnc','highrisk','abortion') NOT NULL",
  "SELECT 'service_category already has abortion' AS note");
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---------- 2. the care she was given --------------------------------------------------------
CREATE TABLE IF NOT EXISTS abortion_care (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  episode_id     INT NOT NULL,
  care_date      DATE,
  ga_weeks       INT,
  -- WHAT HAPPENED. 'induced' is safe abortion care, which is legal and provided at health-centre
  -- level here; 'unsafe' is a woman arriving with the complications of one done elsewhere. They are
  -- not the same event and must never be counted as the same thing.
  loss_type      ENUM('spontaneous','induced','unsafe','ectopic','molar','unknown') NOT NULL,
  presentation   ENUM('complete','incomplete','inevitable','threatened','missed','septic','ruptured') NULL,
  -- WHAT WAS DONE
  procedure_done ENUM('mva','medical','evacuation','expectant','laparotomy','referred','none') NULL,
  procedure_note VARCHAR(160) NULL,
  -- WHAT SHE PRESENTED WITH (the killers)
  comp_haemorrhage    TINYINT(1) NOT NULL DEFAULT 0,
  comp_sepsis         TINYINT(1) NOT NULL DEFAULT 0,
  comp_perforation    TINYINT(1) NOT NULL DEFAULT 0,
  comp_shock          TINYINT(1) NOT NULL DEFAULT 0,
  comp_anaemia        TINYINT(1) NOT NULL DEFAULT 0,
  -- WHAT SHE WAS TREATED WITH
  tx_uterotonic       TINYINT(1) NOT NULL DEFAULT 0,
  tx_antibiotics      TINYINT(1) NOT NULL DEFAULT 0,
  tx_iv_fluids        TINYINT(1) NOT NULL DEFAULT 0,
  tx_blood            TINYINT(1) NOT NULL DEFAULT 0,
  anti_d_given        TINYINT(1) NOT NULL DEFAULT 0,   -- Rh negative: it matters for every pregnancy after this one
  hgb                 DECIMAL(4,1) NULL,
  blood_loss_ml       INT NULL,
  -- POST-ABORTION CONTRACEPTION — the single most effective thing the facility can do next
  pac_fp_counselled   TINYINT(1) NOT NULL DEFAULT 0,
  pac_fp_method       VARCHAR(24) NULL,
  outcome        ENUM('recovered','referred','died','absconded') NULL,
  referred_to    VARCHAR(120) NULL,
  remark         VARCHAR(255) NULL,
  recorded_by    INT,
  recorded_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ab_ep (episode_id),
  FOREIGN KEY (episode_id) REFERENCES episodes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 3. a maternal death, wherever it happens ------------------------------------------
CREATE TABLE IF NOT EXISTS maternal_deaths (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  woman_id       INT NOT NULL,
  episode_id     INT NULL,
  facility_id    INT NOT NULL,
  death_datetime DATETIME NOT NULL,
  -- WHEN in the continuum. This is the axis maternal death surveillance is reported on, and the
  -- tool could previously only record two of the five.
  phase          ENUM('antenatal','abortion_related','intrapartum','postpartum','unknown') NOT NULL,
  ga_weeks       INT NULL,
  place          ENUM('this_facility','in_transit','at_home','other_facility','unknown') NOT NULL DEFAULT 'this_facility',
  cause          ENUM('haemorrhage','hypertensive','sepsis','obstructed','abortion_complication','ectopic','embolism','indirect','other','unknown') NOT NULL DEFAULT 'unknown',
  cause_note     VARCHAR(255) NULL,
  contributing   VARCHAR(255) NULL,          -- delay in seeking / reaching / receiving care, free text
  reported_mdsr  TINYINT(1) NOT NULL DEFAULT 0,   -- notified into Maternal Death Surveillance and Response
  recorded_by    INT,
  recorded_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_md_fac (facility_id, death_datetime),
  INDEX idx_md_woman (woman_id),
  FOREIGN KEY (woman_id)    REFERENCES women(id),
  FOREIGN KEY (facility_id) REFERENCES facilities(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO schema_fixups (name, applied_at, note)
  VALUES ('loss_and_death_v29', NOW(), 'episodes.service_category += abortion; abortion_care; maternal_deaths');

-- ---- what was applied -----------------------------------------------------------------------
SELECT COLUMN_TYPE AS episode_categories FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='episodes' AND COLUMN_NAME='service_category';
SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('abortion_care','maternal_deaths');
-- Nothing existing is touched: no episode changes category, and no death is invented.
SELECT (SELECT COUNT(*) FROM episodes WHERE service_category='abortion') AS abortion_episodes,
       (SELECT COUNT(*) FROM abortion_care)   AS abortion_care_rows,
       (SELECT COUNT(*) FROM maternal_deaths) AS maternal_deaths_rows;
