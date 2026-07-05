-- =====================================================================
-- ADHERE+ init 04 — BEmONC "care given" capture (folded in from migration_v3)
-- Ensures a fresh deployment includes the bemonc_care table.
-- CREATE TABLE IF NOT EXISTS — safe and idempotent.
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
