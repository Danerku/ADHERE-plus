-- =====================================================================
-- ADHERE+ migration v10 — ANC risk screening: care-plan capture
-- Widen anc_risk_screening.item_group and .response from tight ENUMs to
-- VARCHAR so the graded "care plan" rows (PLAN_DECISION / PLAN_NOTE, and
-- item_group='care_plan') persist alongside the yes/no/unknown items.
-- MODIFY COLUMN is idempotent — safe to run repeatedly.
-- Run on the existing server:
--   docker exec -i adhere-db mysql -uroot -p"$MYSQL_ROOT_PASSWORD" adhere < deploy/migration_v10.sql
-- =====================================================================
SET NAMES utf8mb4;

ALTER TABLE anc_risk_screening MODIFY COLUMN item_group VARCHAR(30) NOT NULL;
ALTER TABLE anc_risk_screening MODIFY COLUMN response   VARCHAR(255) NOT NULL;
