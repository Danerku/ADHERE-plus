-- =====================================================================
-- One-time finalisation: remove the two "Demo" facilities and the demo admin.
-- The demo Health Center (id 1) holds kept patients + users, so this
-- REASSIGNS them to a real facility (Bahir Dar Health Center) first, then
-- deletes both demo facilities, and deactivates the demo admin login.
-- Apply once (from the ADHERE-plus folder, after git pull):
--   docker exec -i deploy-db-1 sh -c 'exec mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' < deploy/finalize.sql
-- =====================================================================
SET @target := (SELECT id FROM facilities WHERE name='Bahir Dar Health Center' ORDER BY id LIMIT 1);

UPDATE users    SET facility_id=@target WHERE facility_id IN (1,2) AND @target IS NOT NULL;
UPDATE women    SET facility_id=@target WHERE facility_id IN (1,2) AND @target IS NOT NULL;
UPDATE episodes SET facility_id=@target WHERE facility_id IN (1,2) AND @target IS NOT NULL;

DELETE FROM facilities WHERE id IN (1,2);
-- (demo 'admin' login is deactivated as the final step of the build, not here)
