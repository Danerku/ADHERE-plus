-- =================================================================================================
-- ADHERE+ migration v35 — THREE HOLES A COLD-READ AUDIT FOUND, AND ONE THE OWNER FOUND HIMSELF
--
-- 1. abortion_care.legal_indication
--    Ethiopian law permits induced abortion on stated grounds, and the MoH register records WHICH.
--    The tool captured what was done (MVA, misoprostol, doxycycline) and never why it was lawful to
--    do it. A safe-abortion service that cannot say the ground it acted on cannot report, cannot be
--    audited, and cannot defend itself. Recorded as a coded list so it can be counted — not free text.
--
-- 2. women.sms_consent must DEFAULT TO 0.
--    Registration hard-coded sms_consent=1 for every woman. There is no consent widget anywhere in
--    the tool, so "consent" was being asserted on her behalf, at the door, for all of them — and the
--    reminder sender attaches her phone number only when sms_consent=1, which was always. The comment
--    in the code says "CONSENT IS NOT OPTIONAL AND IS NOT INFERRED". It was inferred. Default 0, and
--    the screen now has to ask.
--    EXISTING ROWS ARE LEFT ALONE: a woman already flagged consented is not silently un-consented in
--    her record — but no NEW woman is consented without being asked.
--
-- 3. episodes gains the PER-PREGNANCY booking facts.
--    ga_first_contact / late_anc_initiation / pregnancy_planned live on `women` — one value per WOMAN.
--    They are facts about a PREGNANCY. So a woman who booked late last year came back for a new
--    pregnancy and the tool told every provider "Late ANC initiation — first contact at 20 weeks"
--    before she had had a single contact, fired the LATE_ANC and UNPLANNED risk codes on her, and put
--    her on the high-risk worklist for something that happened in a pregnancy that is over.
--
-- Idempotent and guarded.
-- =================================================================================================

CREATE TABLE IF NOT EXISTS schema_fixups (
  name VARCHAR(64) NOT NULL PRIMARY KEY, applied_at DATETIME NOT NULL, note VARCHAR(255)
);

-- ---------- 1. the ground on which a lawful abortion was performed --------------------------------
SET @h1 := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='abortion_care' AND COLUMN_NAME='legal_indication');
SET @s1 := IF(@h1=0,
  "ALTER TABLE abortion_care
     ADD COLUMN legal_indication VARCHAR(32) NULL
       COMMENT 'ground for a lawful induced abortion: rape|incest|life_health|fetal_impairment|disability|minor|other',
     ADD COLUMN indication_note VARCHAR(255) NULL",
  "SELECT 'abortion_care already has legal_indication' AS note");
PREPARE p1 FROM @s1; EXECUTE p1; DEALLOCATE PREPARE p1;

-- ---------- 2. consent is asked for, not assumed ---------------------------------------------------
SET @h2 := (SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='women' AND COLUMN_NAME='sms_consent');
SET @s2 := IF(@h2 IS NULL OR @h2 <> '0',
  "ALTER TABLE women MODIFY COLUMN sms_consent TINYINT(1) NOT NULL DEFAULT 0
     COMMENT 'she was ASKED and said yes. Never inferred, never defaulted on.'",
  "SELECT 'women.sms_consent already defaults to 0' AS note");
PREPARE p2 FROM @s2; EXECUTE p2; DEALLOCATE PREPARE p2;

-- ---------- 3. booking facts belong to the pregnancy, not to the woman ------------------------------
SET @h3 := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='episodes' AND COLUMN_NAME='ga_first_contact');
SET @s3 := IF(@h3=0,
  "ALTER TABLE episodes
     ADD COLUMN ga_first_contact    INT NULL      COMMENT 'GA in weeks at HER FIRST CONTACT IN THIS PREGNANCY',
     ADD COLUMN late_anc_initiation TINYINT(1) NULL COMMENT 'first contact after 12 weeks, IN THIS PREGNANCY',
     ADD COLUMN pregnancy_planned   TINYINT(1) NULL COMMENT 'THIS pregnancy was planned',
     ADD COLUMN first_contact_date  DATE NULL",
  "SELECT 'episodes already carries the booking facts' AS note");
PREPARE p3 FROM @s3; EXECUTE p3; DEALLOCATE PREPARE p3;

-- Backfill from the woman onto her CURRENT (most recent, open) pregnancy only. Older episodes keep
-- NULL: we do not know what her booking GA was in a pregnancy that closed before this column existed,
-- and inventing one would be worse than admitting it.
UPDATE episodes e
  JOIN women w ON w.id = e.woman_id
   SET e.ga_first_contact    = w.ga_first_contact,
       e.late_anc_initiation = w.late_anc_initiation,
       e.pregnancy_planned   = w.pregnancy_planned,
       e.first_contact_date  = w.first_contact_date
 WHERE e.ga_first_contact IS NULL
   AND e.voided = 0
   AND e.service_category IN ('anc','labour','pnc','highrisk')
   AND e.id = (SELECT * FROM (SELECT MAX(e2.id) FROM episodes e2
                               WHERE e2.woman_id = e.woman_id AND e2.voided = 0) x);

INSERT IGNORE INTO schema_fixups (name, applied_at, note) VALUES
 ('v35_gaps', NOW(), 'abortion legal_indication; sms_consent defaults to 0; booking facts moved onto the episode');

SELECT 'v35 applied' AS status,
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='abortion_care' AND COLUMN_NAME='legal_indication') AS legal_indication,
  (SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='women' AND COLUMN_NAME='sms_consent') AS consent_default,
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='episodes' AND COLUMN_NAME='ga_first_contact') AS episode_booking;
