-- =====================================================================
-- ADHERE+ live-data cleanup — removes QA/test/demo records from a running DB.
-- Review before running. Back up first:
--   docker exec deploy-db-1 sh -c 'exec mysqldump --no-tablespaces -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' > ~/pre-cleanup.sql
-- Apply:
--   docker exec -i deploy-db-1 sh -c 'exec mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' < deploy/cleanup_qa.sql
-- =====================================================================
SET @mrns := "QA001,0555123";   -- QA test woman + the old 'Test Woman' demo patient

-- Delete every episode-scoped child record for those women, then episodes, then the women.
DELETE r  FROM reminders r          WHERE r.woman_id IN (SELECT id FROM women WHERE FIND_IN_SET(mrn,@mrns));
DELETE x  FROM risk_scores x        JOIN episodes e ON e.id=x.episode_id WHERE e.woman_id IN (SELECT id FROM women WHERE FIND_IN_SET(mrn,@mrns));
DELETE x  FROM partograph_obs x     JOIN episodes e ON e.id=x.episode_id WHERE e.woman_id IN (SELECT id FROM women WHERE FIND_IN_SET(mrn,@mrns));
DELETE x  FROM babies x             JOIN episodes e ON e.id=x.episode_id WHERE e.woman_id IN (SELECT id FROM women WHERE FIND_IN_SET(mrn,@mrns));
DELETE x  FROM delivery_summary x   JOIN episodes e ON e.id=x.episode_id WHERE e.woman_id IN (SELECT id FROM women WHERE FIND_IN_SET(mrn,@mrns));
DELETE x  FROM anc_visits x         JOIN episodes e ON e.id=x.episode_id WHERE e.woman_id IN (SELECT id FROM women WHERE FIND_IN_SET(mrn,@mrns));
DELETE x  FROM anc_risk_screening x JOIN episodes e ON e.id=x.episode_id WHERE e.woman_id IN (SELECT id FROM women WHERE FIND_IN_SET(mrn,@mrns));
DELETE x  FROM checklist_responses x JOIN episodes e ON e.id=x.episode_id WHERE e.woman_id IN (SELECT id FROM women WHERE FIND_IN_SET(mrn,@mrns));
DELETE x  FROM danger_signs x       JOIN episodes e ON e.id=x.episode_id WHERE e.woman_id IN (SELECT id FROM women WHERE FIND_IN_SET(mrn,@mrns));
DELETE x  FROM bemonc_care x        JOIN episodes e ON e.id=x.episode_id WHERE e.woman_id IN (SELECT id FROM women WHERE FIND_IN_SET(mrn,@mrns));
DELETE x  FROM referrals x          JOIN episodes e ON e.id=x.episode_id WHERE e.woman_id IN (SELECT id FROM women WHERE FIND_IN_SET(mrn,@mrns));
DELETE x  FROM maternal_vitals x    JOIN episodes e ON e.id=x.episode_id WHERE e.woman_id IN (SELECT id FROM women WHERE FIND_IN_SET(mrn,@mrns));
DELETE x  FROM handovers x          JOIN episodes e ON e.id=x.episode_id WHERE e.woman_id IN (SELECT id FROM women WHERE FIND_IN_SET(mrn,@mrns));
DELETE x  FROM pnc_visits x         JOIN episodes e ON e.id=x.episode_id WHERE e.woman_id IN (SELECT id FROM women WHERE FIND_IN_SET(mrn,@mrns));
DELETE    FROM episodes             WHERE woman_id IN (SELECT id FROM women WHERE FIND_IN_SET(mrn,@mrns));
DELETE    FROM women                WHERE FIND_IN_SET(mrn,@mrns);

-- Remove the demo seed staff accounts (keep your real admin).
DELETE FROM users WHERE username IN ('recorder1','provider1','observer1');

-- Remove the two 'Demo' facilities, but only if nothing references them.
DELETE FROM facilities
 WHERE name IN ('Demo Health Center','Demo Primary Hospital')
   AND id NOT IN (SELECT facility_id FROM users WHERE facility_id IS NOT NULL)
   AND id NOT IN (SELECT facility_id FROM women WHERE facility_id IS NOT NULL);

-- OPTIONAL: the sample patients seeded during earlier testing (MRN 101001–101020).
-- Uncomment the next block ONLY if you also want them gone.
-- SET @demo_mrns := "101001,101002,101003,101004,101005,101006,101007,101008,101009,101010,101011,101012,101013,101014,101015,101016,101017,101018,101019,101020";
-- (repeat the same DELETE cascade above, substituting @demo_mrns for @mrns)
