PRAGMA foreign_keys = ON;
INSERT OR IGNORE INTO companies(id,name,code,allow_gst_purchase,allow_cash_purchase,allow_gst_sale,allow_cash_sale,active,created_at,updated_at)
VALUES (1,'FirstTech Machine LLP','FML',1,0,1,0,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
       (2,'Aditya International','AI',1,1,1,1,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO users(id,name,email,password_hash,company_id,role,active,force_password_change,created_at,updated_at)
VALUES (1,'Local Administrator','admin@local.invalid','pbkdf2:sha256:1000000$fastockflow-local-only$7135119fcada03d7f5e907e1191fc7ab83132192716746824c3d82e413dd6403',NULL,'ADMIN',1,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO stock_books(id,company_id,name,code,book_type,active,created_at,updated_at) VALUES
 (1,1,'FML GST Stock','FML_GST','GST',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
 (2,2,'AI GST Stock','AI_GST','GST',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
 (3,2,'AI Cash Stock','AI_CASH','CASH',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
 (4,1,'FML Cash Stock','FML_CASH','CASH',0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO items(id,code,name,unit,gst_basis_points,minimum_stock_milliunits,active,created_at,updated_at) VALUES
 (1,'1','FF510 Red Wax 1.5kg','kg',1800,2000,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
 (2,'2','FF510 Support Wax 1.5kg','kg',1800,2000,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
 (3,'3','FF530 Red Wax 3kg','kg',1800,2000,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO suppliers(id,code,name,default_credit_days,active,created_at,updated_at) VALUES
 (1,'NC','Navbharat Carbon Company',30,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
 (2,'DD','DOIT DIGIFABB INDIA PVT LTD',30,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
 (3,'CS','Cascade Star India Pvt Ltd',30,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO customers(id,code,name,customer_type,default_credit_days,active,created_at,updated_at)
VALUES (1,'LOCAL001','Local Test Customer','CASH_AND_BILL',30,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO payment_modes(id,code,name,active,created_at,updated_at) VALUES
 (1,'CASH','Cash',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),(2,'BANK','Bank',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
 (3,'UPI','Upi',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),(4,'CHEQUE','Cheque',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
 (5,'RTGS','Rtgs',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),(6,'NEFT','Neft',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
 (7,'OTHER','Other',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO data_versions(namespace,company_id,version,updated_at) VALUES
 ('masters',0,1,'2026-01-01T00:00:00.000Z'),('companies',0,1,'2026-01-01T00:00:00.000Z');
