-- =====================================================================
-- ADHERE+ migration v20 — close the breaks between modules
--
-- A journey audit traced every path a woman can take through the tool and found 19
-- places where she falls into a hole. Three of them need schema:
--
--   1. REFERRAL IS A ONE-WAY EXILE.
--      referralScreen overwrites episodes.status with 'referred'. The postnatal list
--      selects status='delivered' and the high-risk list selects status IN
--      ('laboring','active') — so a woman referred for postpartum haemorrhage, the
--      highest-risk postnatal patient in the building, vanishes from BOTH, her patient
--      hub loses its postnatal tiles, and NOTHING in the application can ever put her
--      back. Referral is not a clinical state that replaces "delivered"; it is a fact
--      that happens TO a woman who is still delivered, still postpartum, still at risk.
--      So it becomes a flag alongside the status, not a replacement for it.
--
--   2. A PREGNANCY TEST HAS NO RESULT YET WHEN SHE IS REGISTERED.
--      She is registered, she walks to the lab, the strip is read later. The tool
--      currently refuses to save a test without a result, so she cannot be registered
--      at all until it is known — and there is no way to add the result afterwards.
--      'pending' is the state the real workflow is in most of the time.
--
--   3. A REFERRAL POINTS AT A STRING.
--      referrals.referred_to is free text, so the receiving facility can never see her.
--      Give it a real facility id (keeping the text for out-of-network destinations).
--
-- Idempotent. Run on the server:
--   cd ~/ADHERE-plus
--   docker exec -i deploy-db-1 sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" adhere' < deploy/migration_v20.sql
-- =====================================================================
SET NAMES utf8mb4;

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

-- ---------------------------------------------------------------------
-- 1. Referral becomes a FLAG, not a status that erases her clinical state
-- ---------------------------------------------------------------------
CALL adhere_addcol('episodes','referred',    "TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'She has been referred out. This does NOT replace her clinical status: a woman referred after delivery is still delivered and still postpartum.'");
CALL adhere_addcol('episodes','referred_at', "DATETIME NULL");
CALL adhere_addcol('episodes','returned_at', "DATETIME NULL COMMENT 'She came back / the referral was completed'");

-- Rescue everyone currently exiled by status='referred'. Restore the clinical status the
-- record actually supports, and record the referral as the flag it should always have been.
UPDATE episodes e
   SET e.referred = 1,
       e.referred_at = COALESCE(e.referred_at, e.created_at),
       e.status = CASE
         WHEN EXISTS (SELECT 1 FROM delivery_summary d WHERE d.episode_id = e.id) THEN 'delivered'
         WHEN e.service_category = 'labour' THEN 'laboring'
         ELSE 'active'
       END
 WHERE e.status = 'referred';

-- ---------------------------------------------------------------------
-- 2. A pregnancy test may legitimately have no result yet
-- ---------------------------------------------------------------------
-- `result` is a short VARCHAR/ENUM; widen it so 'pending' fits regardless of which.
ALTER TABLE pregnancy_tests MODIFY COLUMN result VARCHAR(10) NULL
  COMMENT 'pending | positive | negative — pending is the normal state between the desk and the lab';
CALL adhere_addcol('pregnancy_tests','resulted_at', "DATETIME NULL COMMENT 'When the result came back'");

-- Anything already recorded with no result at all was, in effect, pending.
UPDATE pregnancy_tests SET result='pending' WHERE result IS NULL OR result='';

-- ---------------------------------------------------------------------
-- 3. A referral should point at a facility, not at a string
-- ---------------------------------------------------------------------
CALL adhere_addcol('referrals','referred_to_facility_id', "INT NULL COMMENT 'The receiving facility, when it is one of ours. referred_to stays for out-of-network destinations.'");
CALL adhere_addcol('referrals','feedback_at',             "DATETIME NULL COMMENT 'When the receiving facility reported back — closes the loop'");

-- ---------------------------------------------------------------------
-- 4. Person-level risk factors: make sure every column the model and the high-risk
--    rule READ actually exists on `women`, so ANC screening can write back to them.
--    (Most already exist from earlier migrations; this makes the set complete and the
--    intent explicit — these are the features the risk model consumes.)
-- ---------------------------------------------------------------------
CALL adhere_addcol('women','prior_cs',            "VARCHAR(4) NULL COMMENT 'yes|no — previous caesarean. Consumed by the intrapartum risk model.'");
CALL adhere_addcol('women','prior_stillbirth',    "VARCHAR(4) NULL");
CALL adhere_addcol('women','prior_pph',           "VARCHAR(4) NULL");
CALL adhere_addcol('women','prior_preeclampsia',  "VARCHAR(4) NULL");
CALL adhere_addcol('women','prior_obstructed',    "VARCHAR(4) NULL");
CALL adhere_addcol('women','chronic_htn',         "VARCHAR(4) NULL");
CALL adhere_addcol('women','diabetes',            "VARCHAR(4) NULL");
CALL adhere_addcol('women','cardiac_renal',       "VARCHAR(4) NULL");

-- BACKFILL FROM THE SCREENING THAT WAS ALREADY DONE.
-- Until now these person-level risk factors lived ONLY in anc_risk_screening, keyed to an
-- episode. When a woman moved from her ANC episode to a labour episode, the high-risk rule
-- and the risk model both looked at the NEW episode — which has no screening rows — and she
-- arrived on the labour ward with no risk flag at all. Her previous caesarean was in the
-- database the whole time, attached to an episode nobody was reading any more.
-- Lift every "yes" onto the woman, where it belongs and where it follows her.
-- Item codes are the ones the ANC screening screen actually writes (app.js SCREEN_ITEMS).
UPDATE women w
   SET w.prior_cs = COALESCE(w.prior_cs, (
         SELECT 'yes' FROM anc_risk_screening a JOIN episodes e ON e.id=a.episode_id
          WHERE e.woman_id=w.id AND a.response='yes' AND a.item_code='OBS_PREV_CS' LIMIT 1)),
       w.prior_stillbirth = COALESCE(w.prior_stillbirth, (
         SELECT 'yes' FROM anc_risk_screening a JOIN episodes e ON e.id=a.episode_id
          WHERE e.woman_id=w.id AND a.response='yes' AND a.item_code='OBS_PREV_STILLBIRTH' LIMIT 1)),
       w.prior_pph = COALESCE(w.prior_pph, (
         SELECT 'yes' FROM anc_risk_screening a JOIN episodes e ON e.id=a.episode_id
          WHERE e.woman_id=w.id AND a.response='yes' AND a.item_code='OBS_PREV_PPH' LIMIT 1)),
       w.prior_preeclampsia = COALESCE(w.prior_preeclampsia, (
         SELECT 'yes' FROM anc_risk_screening a JOIN episodes e ON e.id=a.episode_id
          WHERE e.woman_id=w.id AND a.response='yes' AND a.item_code='OBS_PREV_PREECLAMPSIA' LIMIT 1)),
       w.prior_obstructed = COALESCE(w.prior_obstructed, (
         SELECT 'yes' FROM anc_risk_screening a JOIN episodes e ON e.id=a.episode_id
          WHERE e.woman_id=w.id AND a.response='yes' AND a.item_code='OBS_PREV_OBSTRUCTED' LIMIT 1)),
       w.chronic_htn = COALESCE(w.chronic_htn, (
         SELECT 'yes' FROM anc_risk_screening a JOIN episodes e ON e.id=a.episode_id
          WHERE e.woman_id=w.id AND a.response='yes' AND a.item_code='MED_CHRONIC_HTN' LIMIT 1)),
       w.diabetes = COALESCE(w.diabetes, (
         SELECT 'yes' FROM anc_risk_screening a JOIN episodes e ON e.id=a.episode_id
          WHERE e.woman_id=w.id AND a.response='yes' AND a.item_code='MED_DIABETES' LIMIT 1)),
       w.cardiac_renal = COALESCE(w.cardiac_renal, (
         SELECT 'yes' FROM anc_risk_screening a JOIN episodes e ON e.id=a.episode_id
          WHERE e.woman_id=w.id AND a.response='yes' AND a.item_code='MED_CARDIAC_RENAL' LIMIT 1));

-- ---------------------------------------------------------------------
-- 5. Screening must be RETRACTABLE. Today it is append-only: a mis-clicked "yes" flags
--    her high-risk forever, while the screen she is looking at shows "no".
--    One row per (episode, item) — the latest answer is the answer.
-- ---------------------------------------------------------------------
DELETE a FROM anc_risk_screening a
  JOIN anc_risk_screening b
    ON a.episode_id = b.episode_id AND a.item_code = b.item_code AND a.id < b.id;

SET @has_uk := (SELECT COUNT(*) FROM information_schema.statistics
                 WHERE table_schema=DATABASE() AND table_name='anc_risk_screening' AND index_name='uk_screen');
SET @s := IF(@has_uk=0,'ALTER TABLE anc_risk_screening ADD UNIQUE KEY uk_screen (episode_id, item_code)','SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------
-- 6. Link the free-floating LAFP removal back to a person
-- ---------------------------------------------------------------------
CALL adhere_addcol('lafp_removals','wants_pregnancy_followup', "TINYINT(1) NULL COMMENT 'Removal reason c = wants to conceive. She should come back for a pregnancy test.'");

DROP PROCEDURE IF EXISTS adhere_addcol;
