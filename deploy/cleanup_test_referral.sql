-- Remove the referral I created on episode 74 while testing the referral feedback loop.
-- It is fabricated: I invented the reason ("Severe pre-eclampsia") and the feedback
-- ("caesarean done"). Invented clinical data must not stay on a patient record, even a
-- placeholder one — it is indistinguishable from something a clinician actually recorded.
--
-- Run:
--   cd /root/ADHERE-plus/deploy && set -a && . .env && set +a
--   docker compose --env-file .env -f docker-compose.prod.yml -f /root/epic-hub/compose.hub.yml \
--     exec -T db mysql -u root -p"$DB_ROOT_PASS" "$DB_NAME" < cleanup_test_referral.sql

SELECT id, episode_id, referred_to, reason, feedback, recorded_at
  FROM referrals WHERE id = 3;                       -- look at it before deleting it

DELETE FROM referrals
 WHERE id = 3
   AND referred_to = 'Felege Hiwot Referral Hospital'
   AND reason = 'Severe pre-eclampsia';              -- guarded: deletes only that exact row

SELECT ROW_COUNT() AS rows_deleted;
SELECT COUNT(*) AS referrals_left_on_episode_74 FROM referrals WHERE episode_id = 74;
