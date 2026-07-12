-- =====================================================================
-- ADHERE+ migration v17 — the rest of the MCH continuum
--
-- Family planning (MoH register 1, 21 items)
-- Long-acting FP removal (MoH register 2, 19 items)
-- Immunization: Td (register 10) and HPV (register 9)
-- Pregnancy test: the negative -> family planning exit
--
-- WHY SEPARATE CLIENT TABLES (and not `women`):
--   * The FP register has a Sex (M/F) column — FP clients include MEN (condoms,
--     vasectomy). `women` cannot hold them.
--   * The HPV register is for GIRLS aged ~9-14 in school — they are not maternity
--     patients and have no obstetric record.
--   * The Td register covers pregnant AND non-pregnant women.
--   Each module therefore has its own client identity, with an OPTIONAL woman_id so a
--   maternity patient is linked rather than duplicated.
--
-- Idempotent. Run on the server:
--   cd ~/ADHERE-plus
--   docker exec -i deploy-db-1 sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" adhere' < deploy/migration_v17.sql
-- =====================================================================
SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- FAMILY PLANNING — client (MoH FP register items 1-16)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fp_clients (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  facility_id    INT NOT NULL,
  woman_id       INT NULL COMMENT 'Linked maternity record, when she is one of our women',
  mrn            VARCHAR(40) NULL,
  name           VARCHAR(150) NULL,
  age            INT NULL,
  sex            CHAR(1) NULL COMMENT 'M | F — the FP register serves men too',
  reg_date       DATE NULL,
  acceptor       VARCHAR(10) NULL COMMENT 'MoH 7/8 collapsed: new | repeat',
  -- HIV testing and counselling (MoH 9-13)
  hiv_offered    TINYINT(1) NULL,
  hiv_performed  TINYINT(1) NULL,
  hiv_result     CHAR(1) NULL COMMENT 'P | N',
  hiv_counselled TINYINT(1) NULL COMMENT 'HIV-specific contraceptive counselling offered',
  hiv_linked_art TINYINT(1) NULL,
  target_pop_code CHAR(1) NULL COMMENT 'A-I',
  td_checked     TINYINT(1) NULL COMMENT 'MoH 15: Td status checked',
  iud_contraindicated TINYINT(1) NULL COMMENT 'MoH 16',
  iud_contra_detail   VARCHAR(180) NULL,
  from_preg_test_id   INT NULL COMMENT 'Came from a NEGATIVE pregnancy test — the missed-opportunity conversion',
  recorded_by    INT NULL,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_fpc_fac (facility_id),
  INDEX idx_fpc_woman (woman_id),
  INDEX idx_fpc_mrn (mrn)
) ENGINE=InnoDB;

-- FP visits (MoH 17-21) — up to 5 in the current year
CREATE TABLE IF NOT EXISTS fp_visits (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  fp_client_id  INT NOT NULL,
  visit_no      TINYINT NULL COMMENT 'MoH 17: 1-5 in the current year',
  visit_date    DATE NULL,
  method        VARCHAR(10) NULL COMMENT 'MoH 19: MaC FeC OC Inj EC Diaph IUCD Imp TL V Oth',
  appointment_date DATE NULL,
  remark        VARCHAR(180) NULL,
  recorded_by   INT NULL,
  recorded_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_fpv_client (fp_client_id),
  INDEX idx_fpv_date (visit_date)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- LONG-ACTING FP REMOVAL (MoH register 2, 19 items)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lafp_removals (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  facility_id    INT NOT NULL,
  woman_id       INT NULL,
  fp_client_id   INT NULL,
  mrn            VARCHAR(40) NULL,
  name           VARCHAR(150) NULL,
  age            INT NULL,
  reg_date       DATE NULL,
  insertion_date DATE NULL,
  lafp_type      VARCHAR(20) NULL COMMENT 'MoH 7: Implanon | Sino-Implant | Jadelle | IUD | Other',
  place_code     VARCHAR(4) NULL COMMENT 'MoH 8: WI=within facility, 1=Hospital, 2=Health center, 3=Health post, 4=Private clinic',
  removal_date   DATE NULL,
  duration_months INT NULL COMMENT 'MoH 10',
  removal_reason CHAR(1) NULL COMMENT 'MoH 11: a=on recommended time, b=side effect, c=want to get pregnant, d=misconception, e=other',
  hiv_offered    TINYINT(1) NULL,
  hiv_performed  TINYINT(1) NULL,
  hiv_result     CHAR(1) NULL,
  hiv_counselled TINYINT(1) NULL,
  hiv_linked_art TINYINT(1) NULL,
  target_pop_code CHAR(1) NULL,
  post_removal_method VARCHAR(10) NULL COMMENT 'MoH 18',
  remark         VARCHAR(180) NULL,
  recorded_by    INT NULL,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lafp_fac (facility_id),
  INDEX idx_lafp_removal (removal_date)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- IMMUNIZATION — Td (register 10) and HPV (register 9) share one shape:
-- a client, and a set of dated doses.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS immunization_clients (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  facility_id   INT NOT NULL,
  woman_id      INT NULL,
  programme     VARCHAR(4) NOT NULL COMMENT 'Td | HPV',
  mrn           VARCHAR(40) NULL,
  name          VARCHAR(150) NULL,
  age           INT NULL,
  dob           DATE NULL COMMENT 'HPV register asks for date of birth',
  pregnant      TINYINT(1) NULL COMMENT 'Td register has separate schedules for pregnant / non-pregnant women',
  in_school_grade VARCHAR(10) NULL COMMENT 'HPV: grade if she is a student',
  out_of_school TINYINT(1) NULL COMMENT 'HPV',
  woreda        VARCHAR(80) NULL,
  kebele        VARCHAR(80) NULL,
  ketena        VARCHAR(80) NULL,
  house_no      VARCHAR(40) NULL,
  reg_date      DATE NULL,
  remark        VARCHAR(180) NULL,
  recorded_by   INT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_imc_fac (facility_id),
  INDEX idx_imc_prog (programme),
  INDEX idx_imc_woman (woman_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS immunization_doses (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  client_id   INT NOT NULL,
  dose_no     TINYINT NOT NULL COMMENT 'Td 1-5, HPV 1-2',
  dose_date   DATE NULL,
  recorded_by INT NULL,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_dose (client_id, dose_no),
  INDEX idx_imd_client (client_id),
  INDEX idx_imd_date (dose_date)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- PREGNANCY TEST — the NEGATIVE exit.
-- A negative test is the highest-yield moment to offer contraception: she is in the
-- building, thinking about her fertility, with a provider in front of her. Until now
-- a negative result was a dead end. These columns close that loop and make the
-- conversion measurable.
-- ---------------------------------------------------------------------
DELIMITER //
DROP PROCEDURE IF EXISTS adhere_addcol//
CREATE PROCEDURE adhere_addcol(IN p_tbl VARCHAR(64), IN p_col VARCHAR(64), IN p_def VARCHAR(255))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema=DATABASE() AND table_name=p_tbl AND column_name=p_col) THEN
    SET @s = CONCAT('ALTER TABLE `', p_tbl, '` ADD COLUMN `', p_col, '` ', p_def);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END//
DELIMITER ;

CALL adhere_addcol('pregnancy_tests','fp_offered',        "TINYINT(1) NULL COMMENT 'Negative test: family planning offered'");
CALL adhere_addcol('pregnancy_tests','linked_fp_client_id',"INT NULL COMMENT 'Negative test that converted into an FP client'");

DROP PROCEDURE IF EXISTS adhere_addcol;
