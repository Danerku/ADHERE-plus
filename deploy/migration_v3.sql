-- =====================================================================
-- ADHERE+ migration v3 — BEmONC "care given" capture (7 signal functions).
-- Safe: CREATE TABLE IF NOT EXISTS, no changes to existing data.
--   docker exec -i deploy-db-1 sh -c 'exec mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' < deploy/migration_v3.sql
-- =====================================================================
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS bemonc_care (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  episode_id  INT NOT NULL,
  item_code   VARCHAR(40) NOT NULL,   -- BEM_ANTIBIOTICS, BEM_UTEROTONIC, ...
  response    VARCHAR(20) NOT NULL,   -- given / not_needed / referred
  note        VARCHAR(255),
  recorded_by INT,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_bem_ep (episode_id)
) ENGINE=InnoDB;
