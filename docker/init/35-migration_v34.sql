-- =================================================================================================
-- ADHERE+ migration v34 — TWO INTEGRITY HOLES FOUND BY THE POST-BUILD AUDIT
--
-- 1. pcc_assessments.client_uuid — A REPLAYED BATCH COULD DUPLICATE A PRECONCEPTION ASSESSMENT.
--
--    Every offline write is queued on the tablet and replayed later. `pcc_uptake` is protected by its
--    UNIQUE(episode_id): a second attempt corrects the row. `pcc_assessments` had NO key of any kind,
--    so a batch that was re-sent — which happens whenever one item in it fails and the client rebuilds
--    the batch — inserted every PCC row in it a SECOND time. The facility's caseload double-counts, and
--    the woman's chart shows the same contact twice with two readiness verdicts that need not agree.
--
--    The client already mints a uuid per queued item. That uuid is the identity of the write. Storing
--    it, uniquely, means a replay can only ever land once, however many times it is attempted.
--
-- 2. pcc_uptake voided flag on a voided EPISODE.
--
--    Voiding an EPISODE (as opposed to the woman) did not touch its pcc_uptake row, and the dashboard
--    and supervisor counters read pcc_uptake without joining episodes. So a removed ANC episode left
--    its uptake row in the numerator while dropping out of the denominator — and `pcc_asked_pct` could
--    exceed 100%. Three of the five national indicators come from this table. The query fix is in
--    index.php; this backfills any row whose episode is ALREADY voided, so the two agree from today.
--
-- Idempotent and guarded: safe to run more than once.
-- =================================================================================================

CREATE TABLE IF NOT EXISTS schema_fixups (
  name       VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME    NOT NULL,
  note       VARCHAR(255)
);

-- ---------- 1. the identity of an offline write --------------------------------------------------
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pcc_assessments' AND COLUMN_NAME='client_uuid');
SET @sql := IF(@has=0,
  "ALTER TABLE pcc_assessments
     ADD COLUMN client_uuid VARCHAR(64) NULL COMMENT 'the id the tablet gave this write. A replay can only land once.',
     ADD UNIQUE KEY uq_pcc_client_uuid (client_uuid)",
  "SELECT 'pcc_assessments already has client_uuid' AS note");
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---------- 2. an uptake row on a voided episode is not part of the record ------------------------
UPDATE pcc_uptake x
  JOIN episodes e ON e.id = x.episode_id
   SET x.voided = 1,
       x.voided_at = COALESCE(x.voided_at, NOW()),
       x.void_reason = COALESCE(x.void_reason, 'the episode of care was removed')
 WHERE e.voided = 1 AND x.voided = 0;

INSERT IGNORE INTO schema_fixups (name, applied_at, note) VALUES
 ('v34_pcc_integrity', NOW(), 'pcc_assessments.client_uuid (replay safety) + pcc_uptake voided with its episode');

SELECT 'v34 applied' AS status,
       (SELECT COUNT(*) FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pcc_assessments' AND COLUMN_NAME='client_uuid') AS client_uuid_col,
       (SELECT COUNT(*) FROM pcc_uptake x JOIN episodes e ON e.id=x.episode_id WHERE e.voided=1 AND x.voided=0) AS uptake_on_voided_episodes_left;
