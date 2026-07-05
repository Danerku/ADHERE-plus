-- =====================================================================
-- ADHERE+ init 03 — workflow-parity modules (folded in from migration_v2)
-- Ensures a fresh deployment includes: referrals, ANC follow-up visits,
-- PNC follow-up visits, newborn records (multiple births), maternal vitals.
-- CREATE TABLE IF NOT EXISTS — safe and idempotent.
-- =====================================================================
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS referrals (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  episode_id    INT NOT NULL,
  referred_to   VARCHAR(150),
  reason        VARCHAR(255),
  urgency       ENUM('routine','urgent','emergency') DEFAULT 'urgent',
  transport     VARCHAR(60),
  feedback      VARCHAR(255),
  recorded_by   INT,
  recorded_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ref_ep (episode_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS anc_visits (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  episode_id       INT NOT NULL,
  visit_date       DATE,
  ga_weeks         INT,
  weight_kg        DECIMAL(5,1),
  bp_systolic      INT,
  bp_diastolic     INT,
  fundal_height_cm INT,
  fetal_heart_rate INT,
  presentation     VARCHAR(30),
  urine_protein    VARCHAR(20),
  hgb              DECIMAL(4,1),
  danger_note      VARCHAR(255),
  next_appointment DATE,
  recorded_by      INT,
  recorded_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ancv_ep (episode_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pnc_visits (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  episode_id    INT NOT NULL,
  visit_date    DATE,
  pnc_day       INT,
  m_temp        DECIMAL(3,1),
  m_bp_systolic INT,
  m_bp_diastolic INT,
  m_pulse       INT,
  bleeding      VARCHAR(20),
  breast        VARCHAR(20),
  mood          VARCHAR(20),
  nb_temp       DECIMAL(3,1),
  nb_feeding    VARCHAR(20),
  cord          VARCHAR(20),
  danger_note   VARCHAR(255),
  recorded_by   INT,
  recorded_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pncv_ep (episode_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS babies (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  episode_id    INT NOT NULL,
  birth_order   INT DEFAULT 1,
  sex           ENUM('male','female','ambiguous'),
  weight_g      INT,
  apgar_1min    INT,
  apgar_5min    INT,
  resuscitated  TINYINT(1) DEFAULT 0,
  outcome       ENUM('live_birth','fresh_stillbirth','macerated_stillbirth','neonatal_death'),
  note          VARCHAR(255),
  recorded_by   INT,
  recorded_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_baby_ep (episode_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS maternal_vitals (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  episode_id    INT NOT NULL,
  obs_datetime  DATETIME,
  bp_systolic   INT,
  bp_diastolic  INT,
  pulse         INT,
  temperature   DECIMAL(3,1),
  resp_rate     INT,
  spo2          INT,
  note          VARCHAR(255),
  recorded_by   INT,
  recorded_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_mv_ep (episode_id)
) ENGINE=InnoDB;
