ALTER TABLE business_resources MODIFY kind ENUM('evidence', 'structured', 'quarantine_certificate', 'ledger_pdf', 'source_fragment', 'cost_card', 'store_review') NOT NULL;
CREATE TABLE store_reviews (
  id VARCHAR(32) COLLATE utf8mb4_0900_bin NOT NULL,
  org_id VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  enterprise_key VARCHAR(128) COLLATE utf8mb4_0900_bin NOT NULL,
  source VARCHAR(32) COLLATE utf8mb4_0900_bin NOT NULL,
  store_name VARCHAR(255) COLLATE utf8mb4_0900_bin NOT NULL,
  reviewed_at DATETIME(0) NOT NULL,
  reviewer_name VARCHAR(255) COLLATE utf8mb4_0900_bin NOT NULL,
  content MEDIUMTEXT NULL,
  scores JSON NULL,
  merchant_reply MEDIUMTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_store_reviews_identity (org_id, enterprise_key, source, store_name, reviewed_at, reviewer_name),
  KEY idx_store_reviews_store_time (org_id, enterprise_key, store_name, reviewed_at, id),
  KEY idx_store_reviews_time (org_id, enterprise_key, reviewed_at, id),
  CONSTRAINT fk_store_reviews_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT ON UPDATE RESTRICT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
