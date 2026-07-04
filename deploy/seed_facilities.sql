-- ADHERE+ Amhara pilot facilities (from PBF Quantity Data.xlsx)
-- Bahir Dar City + West Gojjam (Semen Achefer). 16 facilities.
-- Re-run manually only if rebuilding the DB from scratch:
--   docker exec -i deploy-db-1 sh -lc 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' < seed_facilities.sql

INSERT INTO facilities (name, facility_type, woreda, zone, region) VALUES ('Abay Health Center', 'health_center', 'Bahir Dar City', 'Bahir Dar City', 'Amhara');
INSERT INTO facilities (name, facility_type, woreda, zone, region) VALUES ('Addis Alem Primary Hospital', 'primary_hospital', 'Bahir Dar City', 'Bahir Dar City', 'Amhara');
INSERT INTO facilities (name, facility_type, woreda, zone, region) VALUES ('Bahir Dar Health Center', 'health_center', 'Bahir Dar City', 'Bahir Dar City', 'Amhara');
INSERT INTO facilities (name, facility_type, woreda, zone, region) VALUES ('Dagmawi Minilik Health Center', 'health_center', 'Bahir Dar City', 'Bahir Dar City', 'Amhara');
INSERT INTO facilities (name, facility_type, woreda, zone, region) VALUES ('Han Health Center', 'health_center', 'Bahir Dar City', 'Bahir Dar City', 'Amhara');
INSERT INTO facilities (name, facility_type, woreda, zone, region) VALUES ('Shimbit Health Center', 'health_center', 'Bahir Dar City', 'Bahir Dar City', 'Amhara');
INSERT INTO facilities (name, facility_type, woreda, zone, region) VALUES ('Shumabo Health Center', 'health_center', 'Bahir Dar City', 'Bahir Dar City', 'Amhara');
INSERT INTO facilities (name, facility_type, woreda, zone, region) VALUES ('Anbesa Kolanbo Health Center', 'health_center', 'Semen Achefer', 'West Gojjam', 'Amhara');
INSERT INTO facilities (name, facility_type, woreda, zone, region) VALUES ('Belen Health Center', 'health_center', 'Semen Achefer', 'West Gojjam', 'Amhara');
INSERT INTO facilities (name, facility_type, woreda, zone, region) VALUES ('Forhie Sankra Health Center', 'health_center', 'Semen Achefer', 'West Gojjam', 'Amhara');
INSERT INTO facilities (name, facility_type, woreda, zone, region) VALUES ('Gug Health Center', 'health_center', 'Semen Achefer', 'West Gojjam', 'Amhara');
INSERT INTO facilities (name, facility_type, woreda, zone, region) VALUES ('Kunzila Health Center', 'health_center', 'Semen Achefer', 'West Gojjam', 'Amhara');
INSERT INTO facilities (name, facility_type, woreda, zone, region) VALUES ('Legdia Health Center', 'health_center', 'Semen Achefer', 'West Gojjam', 'Amhara');
INSERT INTO facilities (name, facility_type, woreda, zone, region) VALUES ('Liben Health Center', 'health_center', 'Semen Achefer', 'West Gojjam', 'Amhara');
INSERT INTO facilities (name, facility_type, woreda, zone, region) VALUES ('Liben Primary Hospital', 'primary_hospital', 'Semen Achefer', 'West Gojjam', 'Amhara');
INSERT INTO facilities (name, facility_type, woreda, zone, region) VALUES ('Yismala Health Center', 'health_center', 'Semen Achefer', 'West Gojjam', 'Amhara');
