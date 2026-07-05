-- Bootstrap seed for a fresh install: one facility + one administrator so the
-- system can be signed into. Create your real facilities and staff from the
-- Admin screens after first login.
-- SECURITY: change the admin password immediately after the first sign-in.
INSERT INTO facilities (name,facility_type,woreda,zone,region) VALUES
 ('Bahir Dar Health Center','health_center','Bahir Dar','West Gojjam','Amhara');
INSERT INTO users (username,password_hash,full_name,role,cadre,facility_id) VALUES
 ('admin','$2b$12$fV0mhozxBEiNcE7X/fXvCO8hAH2UWAvetYe1cbXtj5I6WRphUK8Qi','System Administrator','admin','admin',1);
