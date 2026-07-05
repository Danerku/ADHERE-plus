-- =====================================================================
-- ADHERE+ migration v4 — Supervision & scale + SMS reminders
--   * users.role gains 'supervisor'
--   * users.scope (facility | woreda | zone | region) for cross-facility read
--   * women.sms_consent (opt-in for reminders)
--   * reminders table (scheduler queue; actual send behind an app stub)
-- Idempotent and safe on a live database (guarded ADD COLUMN, IF NOT EXISTS).
-- Apply:
--   docker exec -i deploy-db-1 sh -c 'exec mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' < deploy/migration_v4.sql
-- =====================================================================
SET NAMES utf8mb4;

-- Reminder queue (idempotent) -----------------------------------------
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

-- Add 'supervisor' to the role enum (MODIFY is idempotent) ------------
ALTER TABLE users MODIFY role ENUM('recorder','provider','observer','supervisor','admin') NOT NULL;

-- users.scope — how wide a supervisor may read (guarded add) ----------
SET @has_scope := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='scope');
SET @sql_scope := IF(@has_scope=0,
  "ALTER TABLE users ADD COLUMN scope ENUM('facility','woreda','zone','region') NOT NULL DEFAULT 'facility'",
  "SELECT 'users.scope already present'");
PREPARE s1 FROM @sql_scope; EXECUTE s1; DEALLOCATE PREPARE s1;

-- women.sms_consent — opt-in for reminders (guarded add) -------------
SET @has_consent := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='women' AND COLUMN_NAME='sms_consent');
SET @sql_consent := IF(@has_consent=0,
  "ALTER TABLE women ADD COLUMN sms_consent TINYINT(1) NOT NULL DEFAULT 0",
  "SELECT 'women.sms_consent already present'");
PREPARE s2 FROM @sql_consent; EXECUTE s2; DEALLOCATE PREPARE s2;
