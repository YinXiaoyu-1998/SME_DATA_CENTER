ALTER TABLE import_batches
  MODIFY COLUMN dataset ENUM(
    'dishes', 'business', 'vip', 'dish_catalog',
    'delivery_ledger', 'supplier_catalog', 'cost_cards'
  ) NOT NULL,
  ADD COLUMN publication_summary JSON NULL,
  ADD UNIQUE KEY uq_import_batches_org_id_document
    (org_id, id, source_document_id);

CREATE TABLE cost_cards (
  id VARCHAR(32) NOT NULL,
  org_id VARCHAR(64) NOT NULL,
  enterprise_key VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  enterprise_name VARCHAR(255) NOT NULL,
  source_namespace VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  spu_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  sku_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  dish_name VARCHAR(512) NOT NULL,
  base_category_name VARCHAR(255) NULL,
  specification_name VARCHAR(255) NULL,
  sale_price DECIMAL(20,6) NULL,
  has_cost_card BOOLEAN NOT NULL,
  source_dish_deleted BOOLEAN NOT NULL,
  object_key VARCHAR(512) NOT NULL,
  checksum_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  canonicalization_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  csv_schema_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  byte_size BIGINT UNSIGNED NOT NULL,
  item_row_count BIGINT UNSIGNED NOT NULL,
  recipe_count INT UNSIGNED NOT NULL,
  source_document_id VARCHAR(32) NOT NULL,
  import_batch_id VARCHAR(32) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  archived_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_cost_cards_identity
    (org_id, enterprise_key, source_namespace, spu_id, sku_id),
  UNIQUE KEY uq_cost_cards_object (object_key),
  KEY idx_cost_cards_name (org_id, enterprise_key, dish_name),
  KEY idx_cost_cards_sku (org_id, enterprise_key, source_namespace, sku_id),
  KEY idx_cost_cards_source (org_id, source_document_id),
  KEY idx_cost_cards_batch_source (org_id, import_batch_id, source_document_id),
  CONSTRAINT fk_cost_cards_source FOREIGN KEY (org_id, source_document_id)
    REFERENCES documents (org_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_cost_cards_batch_source
    FOREIGN KEY (org_id, import_batch_id, source_document_id)
    REFERENCES import_batches (org_id, id, source_document_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE import_window_claims MODIFY COLUMN dataset ENUM('dishes','business','vip','dish_catalog','delivery_ledger','supplier_catalog','cost_cards') NOT NULL;
ALTER TABLE business_resources MODIFY COLUMN kind ENUM('evidence','structured','quarantine_certificate','ledger_pdf','source_fragment','cost_card') NOT NULL;
ALTER TABLE cost_cards ADD CONSTRAINT fk_cost_cards_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
