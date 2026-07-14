-- =============================================================================================
-- ADHERE+ migration v27 — SOFT DELETE (void)
--
-- Nothing in ADHERE+ could ever be removed. Not a woman registered twice by mistake, not an episode
-- opened on the wrong patient. (This is why deleting three test patients needed hand-written SQL
-- against 16 tables.) A facility that mis-registers a woman has been stuck with her for ever, and she
-- keeps appearing in worklists, registers and counts.
--
-- A clinical record is NEVER destroyed. It is VOIDED:
--   * it disappears from every worklist, search, register, dashboard count and export;
--   * the row survives, with WHO voided it, WHEN, and WHY;
--   * an admin can see everything that has been voided, and can restore it.
--
-- Providers, admins and super-admins may void. When a PROVIDER voids something, admins and
-- super-admins are notified (the app surfaces it on the admin screen).
--
-- Voiding a WOMAN voids her episodes with her — otherwise her episodes would linger in the labour
-- ward with no patient attached.
--
-- Idempotent and guarded: safe to run more than once.
-- =============================================================================================

CREATE TABLE IF NOT EXISTS schema_fixups (
  name       VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME    NOT NULL,
  note       VARCHAR(255)
);

DROP PROCEDURE IF EXISTS adhere_v27;
DELIMITER $$
CREATE PROCEDURE adhere_v27()
BEGIN
  DECLARE n INT;

  -- ---------- women ---------------------------------------------------------------------------
  SELECT COUNT(*) INTO n FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='women' AND COLUMN_NAME='voided';
  IF n = 0 THEN
    ALTER TABLE women
      ADD COLUMN voided      TINYINT(1)   NOT NULL DEFAULT 0,
      ADD COLUMN voided_at   DATETIME     NULL,
      ADD COLUMN voided_by   INT          NULL,
      ADD COLUMN void_reason VARCHAR(255) NULL,
      ADD INDEX idx_women_voided (voided);
  END IF;

  -- ---------- episodes ------------------------------------------------------------------------
  SELECT COUNT(*) INTO n FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='episodes' AND COLUMN_NAME='voided';
  IF n = 0 THEN
    ALTER TABLE episodes
      ADD COLUMN voided      TINYINT(1)   NOT NULL DEFAULT 0,
      ADD COLUMN voided_at   DATETIME     NULL,
      ADD COLUMN voided_by   INT          NULL,
      ADD COLUMN void_reason VARCHAR(255) NULL,
      ADD INDEX idx_episodes_voided (voided);
  END IF;

  -- ---------- the notification an admin sees when a PROVIDER voids something -------------------
  SELECT COUNT(*) INTO n FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='void_notices';
  IF n = 0 THEN
    CREATE TABLE void_notices (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      facility_id  INT          NOT NULL,
      entity       ENUM('woman','episode') NOT NULL,
      entity_id    INT          NOT NULL,
      label        VARCHAR(120) NULL,          -- her name + MRN, so the notice reads without a join
      reason       VARCHAR(255) NULL,
      voided_by    INT          NOT NULL,
      voided_at    DATETIME     NOT NULL,
      acknowledged TINYINT(1)   NOT NULL DEFAULT 0,
      ack_by       INT          NULL,
      ack_at       DATETIME     NULL,
      INDEX idx_vn_fac (facility_id, acknowledged),
      FOREIGN KEY (facility_id) REFERENCES facilities(id),
      FOREIGN KEY (voided_by)   REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  END IF;

END$$
DELIMITER ;

CALL adhere_v27();
DROP PROCEDURE IF EXISTS adhere_v27;

INSERT IGNORE INTO schema_fixups (name, applied_at, note)
  VALUES ('soft_delete_v27', NOW(), 'voided/voided_at/voided_by/void_reason on women + episodes; void_notices table');

-- ---- what was applied -------------------------------------------------------------------------
SELECT 'columns' AS what, TABLE_NAME, COLUMN_NAME
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME IN ('voided','voided_at','voided_by','void_reason')
 ORDER BY TABLE_NAME, COLUMN_NAME;

SELECT 'table' AS what, TABLE_NAME
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='void_notices';

-- Nothing is voided by this migration. Every existing row stays exactly as it is.
SELECT (SELECT COUNT(*) FROM women    WHERE voided=1) AS women_voided,
       (SELECT COUNT(*) FROM episodes WHERE voided=1) AS episodes_voided;
