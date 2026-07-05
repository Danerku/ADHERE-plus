-- =====================================================================
-- ADHERE+ init 05 — Supervision & scale + SMS reminders (folded in from migration_v4)
-- Ensures a fresh deployment includes supervisor role/scope, sms_consent, reminders.
-- Idempotent (guarded ADD COLUMN, IF NOT EXISTS, MODIFY).
-- =====================================================================
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS reminders (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  woman_id    INT,
  episode_id  INT,
  facility_id INT,
  kind        ENUM('anc','pnc','custom') DEFAULT 'anc',
  due_date    DATE,
  phone       VARCHAR(40),
  message     VARCHAR(320),
  status      ENUM('pending','sent','failed','skipped') DEFAULT 'pending',
  provider_note VARCHAR(120),
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  sent_at     DATETIME,
  INDEX idx_rem_status (status),
  INDEX idx_rem_due (due_date),
  INDEX idx_rem_fac (facility_id)
) ENGINE=InnoDB;

ALTER TABLE users MODIFY role ENUM('recorder','provider','observer','supervisor','admin') NOT NULL;

SET @has_scope := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='scope');
SET @sql_scope := IF(@has_scope=0,
  "ALTER TABLE users ADD COLUMN scope ENUM('facility','woreda','zone','region') NOT NULL DEFAULT 'facility'",
  "SELECT 'users.scope already present'");
PREPARE s1 FROM @sql_scope; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @has_consent := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='women' AND COLUMN_NAME='sms_consent');
SET @sql_consent := IF(@has_consent=0,
  "ALTER TABLE women ADD COLUMN sms_consent TINYINT(1) NOT NULL DEFAULT 0",
  "SELECT 'women.sms_consent already present'");
PREPARE s2 FROM @sql_consent; EXECUTE s2; DEALLOCATE PREPARE s2;
