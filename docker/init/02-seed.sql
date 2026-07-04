-- demo seed (password for all demo users: demo1234)
INSERT INTO facilities (name,facility_type,woreda,region,dhis2_org_unit) VALUES
 ('Demo Health Center','health_center','Bahir Dar Zuria','Amhara','DEMO001'),
 ('Demo Primary Hospital','primary_hospital','Bahir Dar','Amhara','DEMO002');
INSERT INTO users (username,password_hash,full_name,role,cadre,facility_id) VALUES
 ('recorder1','$2b$12$fV0mhozxBEiNcE7X/fXvCO8hAH2UWAvetYe1cbXtj5I6WRphUK8Qi','Demo Recorder','recorder','clerk',1),
 ('provider1','$2b$12$fV0mhozxBEiNcE7X/fXvCO8hAH2UWAvetYe1cbXtj5I6WRphUK8Qi','Demo Provider','provider','midwife',1),
 ('observer1','$2b$12$fV0mhozxBEiNcE7X/fXvCO8hAH2UWAvetYe1cbXtj5I6WRphUK8Qi','Demo Observer','observer','supervisor',1),
 ('admin','$2b$12$fV0mhozxBEiNcE7X/fXvCO8hAH2UWAvetYe1cbXtj5I6WRphUK8Qi','System Admin','admin','admin',1);
INSERT INTO women (mrn,first_name,father_name,grandfather_name,age,gravida,para,facility_id,created_by) VALUES
 ('0555123','Test','Woman','Demo',24,2,1,1,1);
INSERT INTO episodes (woman_id,service_category,status,provider_id,admission_datetime,facility_id,created_by) VALUES
 (1,'labour','laboring',2,NOW(),1,1);
