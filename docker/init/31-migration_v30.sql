-- =============================================================================================
-- ADHERE+ migration v30 — SHE CAME FROM SOMEWHERE, AND THE BABY GOES SOMEWHERE
--
-- 1. TRANSFER IN. `admitted_from` knew three things: 'new', 'from_anc', 'from_highrisk'. All three
--    are internal. A woman who was booked at another health centre and arrives here in labour, or
--    who is referred IN from a health post, was recorded as 'new' — as if she had never been seen
--    by anyone. Her ANC contacts, her blood group, her HIV status, the reason she was sent, all of
--    it silently became "no history". The tool then screened her as unbooked, which is a different
--    woman with a different risk.
--
-- 2. THE NEWBORN WHO IS REFERRED OUT. The baby's record could say `nicu = referred_out` — and that
--    was the end of it. There was no referral, so there was no letter to send with him, nothing on
--    the referral list, and no way to ever record what happened. A sick newborn left the facility
--    and the facility never learned whether he lived.
--
-- Idempotent and guarded: safe to run more than once.
-- =============================================================================================

CREATE TABLE IF NOT EXISTS schema_fixups (
  name       VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME    NOT NULL,
  note       VARCHAR(255)
);

-- ---------- 1. where she came from -----------------------------------------------------------
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='episodes'
                AND COLUMN_NAME='admitted_from' AND COLUMN_TYPE LIKE '%transfer_in%');
SET @sql := IF(@has=0,
  "ALTER TABLE episodes MODIFY admitted_from ENUM('new','from_anc','from_highrisk','transfer_in','referred_in') DEFAULT 'new'",
  "SELECT 'admitted_from already has transfer_in' AS note");
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @has2 := (SELECT COUNT(*) FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='episodes' AND COLUMN_NAME='came_from_facility');
SET @sql2 := IF(@has2=0,
  "ALTER TABLE episodes
     ADD COLUMN came_from_facility VARCHAR(120) NULL,   -- the health centre / post / hospital she came from
     ADD COLUMN came_with_records  TINYINT(1) NOT NULL DEFAULT 0,   -- did she bring her card or a letter?
     ADD COLUMN transfer_reason    VARCHAR(255) NULL",
  "SELECT 'came_from_facility already exists' AS note");
PREPARE s2 FROM @sql2; EXECUTE s2; DEALLOCATE PREPARE s2;

-- ---------- 2. the newborn who is referred out ------------------------------------------------
-- The referral belongs to the EPISODE (the mother's admission), which is where every other
-- referral already lives — so it appears on the referral list and in the feedback loop like any
-- other. What was missing was the ability to say WHO is being referred.
SET @has3 := (SELECT COUNT(*) FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='referrals' AND COLUMN_NAME='subject');
SET @sql3 := IF(@has3=0,
  "ALTER TABLE referrals
     ADD COLUMN subject   ENUM('mother','newborn') NOT NULL DEFAULT 'mother',
     ADD COLUMN baby_id   INT NULL,
     ADD INDEX idx_ref_subject (subject)",
  "SELECT 'referrals.subject already exists' AS note");
PREPARE s3 FROM @sql3; EXECUTE s3; DEALLOCATE PREPARE s3;

INSERT IGNORE INTO schema_fixups (name, applied_at, note)
  VALUES ('transfer_and_newborn_referral_v30', NOW(), 'episodes.admitted_from += transfer_in/referred_in + came_from_facility; referrals.subject/baby_id');

-- ---- what was applied -----------------------------------------------------------------------
SELECT COLUMN_TYPE AS admitted_from FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='episodes' AND COLUMN_NAME='admitted_from';
SELECT COLUMN_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('episodes','referrals')
   AND COLUMN_NAME IN ('came_from_facility','came_with_records','transfer_reason','subject','baby_id')
 ORDER BY TABLE_NAME, COLUMN_NAME;
-- Nothing existing changes: every current episode keeps its admitted_from, and every existing
-- referral is a referral of the MOTHER, which is what they all were.
SELECT (SELECT COUNT(*) FROM episodes WHERE admitted_from IN ('transfer_in','referred_in')) AS transfers_in,
       (SELECT COUNT(*) FROM referrals WHERE subject='newborn') AS newborn_referrals;
