-- =====================================================================
-- ADHERE+ (rebuild) — MySQL schema
-- Clean re-implementation of the ADHERE e-partograph / eMCH platform
-- with AI risk scoring, offline sync, audit logging and DHIS2 export.
-- Charset utf8mb4. Engine InnoDB. Author: Epic Health Systems (rebuild).
-- =====================================================================
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------- Facilities & Users -------------------------------------
CREATE TABLE facilities (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(150) NOT NULL,
  facility_type ENUM('primary_hospital','health_center','general_hospital','other') DEFAULT 'health_center',
  kebele        VARCHAR(120),
  woreda        VARCHAR(120),
  zone          VARCHAR(120),
  region        VARCHAR(120) DEFAULT 'Amhara',
  dhis2_org_unit VARCHAR(64),
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(80)  NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,            -- bcrypt/argon2, never plaintext
  full_name     VARCHAR(150) NOT NULL,
  role          ENUM('recorder','provider','observer','admin') NOT NULL,
  cadre         VARCHAR(80),                       -- midwife, health officer, IESO, MD, nurse
  facility_id   INT,
  phone         VARCHAR(40),
  is_active     TINYINT(1) DEFAULT 1,
  last_login    DATETIME,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (facility_id) REFERENCES facilities(id)
) ENGINE=InnoDB;

-- ---------- Women (patients) ---------------------------------------
CREATE TABLE women (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  mrn            VARCHAR(40) NOT NULL,
  first_name     VARCHAR(80),
  father_name    VARCHAR(80),
  grandfather_name VARCHAR(80),
  age            INT,
  phone          VARCHAR(40),
  kebele         VARCHAR(120),
  house_no       VARCHAR(40),
  marital_status ENUM('single','married','divorced','widowed','other'),
  next_of_kin    VARCHAR(150),
  kin_phone      VARCHAR(40),
  gravida        INT,
  para           INT,
  children_alive INT,
  lnmp           DATE,
  edd            DATE,
  facility_id    INT,
  created_by     INT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mrn_facility (mrn, facility_id),
  FOREIGN KEY (facility_id) REFERENCES facilities(id),
  FOREIGN KEY (created_by)  REFERENCES users(id)
) ENGINE=InnoDB;

-- ---------- Care episodes (an admission into a service) -------------
CREATE TABLE episodes (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  woman_id         INT NOT NULL,
  service_category ENUM('anc','labour','pnc','highrisk') NOT NULL,
  status           ENUM('wait','active','laboring','delivered','discharged','referred','closed') DEFAULT 'wait',
  provider_id      INT,                             -- assigned provider (nullable = unassigned)
  admitted_from    ENUM('new','from_anc','from_highrisk') DEFAULT 'new',
  ruptured_membrane TINYINT(1),
  ruptured_datetime DATETIME,
  admission_datetime DATETIME,
  closed_datetime   DATETIME,
  facility_id      INT,
  created_by       INT,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (woman_id)    REFERENCES women(id),
  FOREIGN KEY (provider_id) REFERENCES users(id),
  FOREIGN KEY (facility_id) REFERENCES facilities(id),
  FOREIGN KEY (created_by)  REFERENCES users(id),
  INDEX idx_episode_status (status, service_category)
) ENGINE=InnoDB;

-- ---------- ANC risk screening (the 19-item checklist) -------------
CREATE TABLE anc_risk_screening (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  episode_id  INT NOT NULL,
  item_code   VARCHAR(30) NOT NULL,   -- e.g. OBS_PREV_STILLBIRTH, CUR_MULTIPLE, MED_DIABETES
  item_group  ENUM('obstetric_history','current_pregnancy','general_medical') NOT NULL,
  response    ENUM('yes','no','unknown') NOT NULL,
  recorded_by INT,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_id)  REFERENCES episodes(id),
  FOREIGN KEY (recorded_by) REFERENCES users(id),
  INDEX idx_anc_ep (episode_id)
) ENGINE=InnoDB;

-- ---------- Partograph observations (time series) ------------------
CREATE TABLE partograph_obs (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  episode_id         INT NOT NULL,
  obs_datetime       DATETIME NOT NULL,
  hours_since_active DECIMAL(4,1),        -- x-axis position
  fetal_heart_rate   INT,                 -- bpm
  amniotic_fluid     ENUM('I','C','M','B','A'),   -- Intact, Clear, Meconium, Blood, Absent
  moulding           ENUM('0','+1','+2','+3'),
  cervix_cm          DECIMAL(3,1),        -- plotted X
  descent_head       INT,                 -- 0-5, plotted O
  contractions_per10 INT,
  contraction_strength ENUM('mild','moderate','strong'),
  oxytocin_units     DECIMAL(4,1),
  oxytocin_drops     INT,
  drugs_iv_fluids    VARCHAR(255),
  bp_systolic        INT,
  bp_diastolic       INT,
  pulse              INT,
  temperature        DECIMAL(3,1),
  urine_protein      VARCHAR(20),
  urine_acetone      VARCHAR(20),
  urine_volume       INT,
  recorded_by        INT,
  recorded_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_id)  REFERENCES episodes(id),
  FOREIGN KEY (recorded_by) REFERENCES users(id),
  INDEX idx_obs_ep_time (episode_id, obs_datetime)
) ENGINE=InnoDB;

-- ---------- AI risk scores (model output, auditable) ---------------
CREATE TABLE risk_scores (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  episode_id    INT NOT NULL,
  obs_id        INT,                     -- observation that triggered the score
  scored_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  model_version VARCHAR(40),
  probability   DECIMAL(5,4),            -- 0.0000 - 1.0000
  band          ENUM('green','amber','red') NOT NULL,
  features_json JSON,                    -- exact inputs used (reproducibility)
  provider_ack  TINYINT(1) DEFAULT 0,    -- clinician acknowledged
  override_reason VARCHAR(255),          -- human-in-the-loop override
  FOREIGN KEY (episode_id) REFERENCES episodes(id),
  FOREIGN KEY (obs_id)     REFERENCES partograph_obs(id),
  INDEX idx_score_ep (episode_id, scored_at)
) ENGINE=InnoDB;

-- ---------- WHO Safe Childbirth Checklist (4 pause points) ----------
CREATE TABLE checklist_responses (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  episode_id    INT NOT NULL,
  pause_point   ENUM('admission','before_birth','after_birth','before_discharge') NOT NULL,
  item_code     VARCHAR(40) NOT NULL,
  response      VARCHAR(60) NOT NULL,    -- e.g. 'no','yes_given','no_will_start_ge4cm'
  recorded_by   INT,
  recorded_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_id)  REFERENCES episodes(id),
  FOREIGN KEY (recorded_by) REFERENCES users(id),
  INDEX idx_chk_ep (episode_id, pause_point)
) ENGINE=InnoDB;

-- ---------- Danger / warning sign sheet -----------------------------
CREATE TABLE danger_signs (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  episode_id     INT NOT NULL,
  obs_datetime   DATETIME NOT NULL,
  headache       TINYINT(1),
  blurred_vision TINYINT(1),
  epigastric_pain TINYINT(1),
  dtr_grade      ENUM('0','+1','+2','+3','+4'),   -- reflexes / clonus
  vaginal_bleeding TINYINT(1),
  remark         VARCHAR(255),
  recorded_by    INT,
  recorded_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_id)  REFERENCES episodes(id),
  FOREIGN KEY (recorded_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- ---------- Delivery summary / outcome ------------------------------
CREATE TABLE delivery_summary (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  episode_id     INT NOT NULL,
  delivery_datetime DATETIME,
  mode           ENUM('svd','assisted','caesarean','other'),
  baby_weight_g  INT,
  baby_sex       ENUM('male','female','ambiguous'),
  apgar_1min     INT,
  apgar_5min     INT,
  outcome        ENUM('live_birth','fresh_stillbirth','macerated_stillbirth','neonatal_death'),
  maternal_outcome ENUM('well','near_miss','referred','death'),
  complications  VARCHAR(255),
  recorded_by    INT,
  recorded_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_id)  REFERENCES episodes(id),
  FOREIGN KEY (recorded_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- ---------- Provider handovers --------------------------------------
CREATE TABLE handovers (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  episode_id       INT NOT NULL,
  from_provider_id INT,
  to_provider_id   INT,
  note             VARCHAR(255),
  handover_datetime DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_id)       REFERENCES episodes(id),
  FOREIGN KEY (from_provider_id) REFERENCES users(id),
  FOREIGN KEY (to_provider_id)   REFERENCES users(id)
) ENGINE=InnoDB;

-- ---------- Provider <-> Observer messaging ------------------------
CREATE TABLE messages (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  episode_id  INT,
  from_user_id INT,
  to_user_id  INT,
  body        TEXT,
  sent_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  read_at     DATETIME,
  FOREIGN KEY (episode_id)   REFERENCES episodes(id),
  FOREIGN KEY (from_user_id) REFERENCES users(id),
  FOREIGN KEY (to_user_id)   REFERENCES users(id)
) ENGINE=InnoDB;

-- ---------- Audit / event log (evaluation evidence) ----------------
CREATE TABLE audit_log (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT,
  action      VARCHAR(60),            -- login, create_obs, alert_raised, override, view, export
  entity      VARCHAR(60),
  entity_id   INT,
  detail_json JSON,
  ip_address  VARCHAR(45),
  event_time  DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_time (event_time),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ---------- Offline sync queue (tablet entries) --------------------
CREATE TABLE sync_queue (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  client_uuid   VARCHAR(64),           -- id generated on device
  device_id     VARCHAR(64),
  entity        VARCHAR(60),
  payload_json  JSON,
  status        ENUM('pending','applied','conflict','rejected') DEFAULT 'pending',
  created_on_device DATETIME,
  synced_at     DATETIME,
  INDEX idx_sync_status (status)
) ENGINE=InnoDB;

-- ---------- DHIS2 indicator export snapshots -----------------------
CREATE TABLE dhis2_export (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  facility_id   INT,
  period        VARCHAR(10),           -- e.g. 2026-07
  indicator     VARCHAR(80),           -- deliveries, partograph_completion, referrals...
  value         DECIMAL(12,2),
  generated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  exported      TINYINT(1) DEFAULT 0,
  FOREIGN KEY (facility_id) REFERENCES facilities(id),
  INDEX idx_dhis_period (facility_id, period)
) ENGINE=InnoDB;

SET FOREIGN_KEY_CHECKS = 1;
