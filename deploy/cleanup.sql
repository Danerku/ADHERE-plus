-- =====================================================================
-- One-time cleanup of QA / verification test records.
-- Safe: targets only the test data created during verification.
-- Apply once (from the ADHERE-plus folder, after git pull):
--   docker exec -i deploy-db-1 sh -c 'exec mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' < deploy/cleanup.sql
-- =====================================================================
DELETE FROM babies          WHERE episode_id=21;
DELETE FROM maternal_vitals WHERE episode_id=21;
DELETE FROM pnc_visits      WHERE episode_id=21;
DELETE FROM handovers       WHERE episode_id=21 AND note='QA handover';
DELETE FROM referrals       WHERE episode_id=21 AND referred_to='QA Hospital';

DELETE FROM anc_visits         WHERE episode_id IN (SELECT id FROM episodes WHERE woman_id IN (SELECT id FROM women WHERE mrn='ANC-TEST-1'));
DELETE FROM anc_risk_screening WHERE episode_id IN (SELECT id FROM episodes WHERE woman_id IN (SELECT id FROM women WHERE mrn='ANC-TEST-1'));
DELETE FROM episodes           WHERE woman_id IN (SELECT id FROM women WHERE mrn='ANC-TEST-1');
DELETE FROM women              WHERE mrn='ANC-TEST-1';
