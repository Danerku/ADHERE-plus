-- =====================================================================
-- ADHERE+ migration v11 — security hardening
--   * idem_keys: idempotency ledger so an offline-replayed write can't double-commit
--   * users.must_change_password: force rotation of the shipped default admin password
-- Idempotent. Run on the server:
--   docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml exec -T db \
--     mysql -uroot -p"$DB_ROOT_PASS" adhere < deploy/migration_v11.sql
-- =====================================================================
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS idem_keys(
  k  VARCHAR(64) PRIMARY KEY,
  at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_idem_at(at)
) ENGINE=InnoDB;

DELIMITER //
DROP PROCEDURE IF EXISTS adhere_v11//
CREATE PROCEDURE adhere_v11()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='must_change_password') THEN
    ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) DEFAULT 0;
  END IF;
END//
DELIMITER ;
CALL adhere_v11();
DROP PROCEDURE IF EXISTS adhere_v11;

-- Force a change only for an admin still using the shipped default seed password.
UPDATE users SET must_change_password=1
 WHERE username='admin' AND password_hash='$2b$12$fV0mhozxBEiNcE7X/fXvCO8hAH2UWAvetYe1cbXtj5I6WRphUK8Qi';
