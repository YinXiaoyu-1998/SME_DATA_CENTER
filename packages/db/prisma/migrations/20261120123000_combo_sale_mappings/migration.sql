-- An exact source name and specification (including name-wide NULL) have one deterministic id.
-- Keep the original SKU row identity after deletion so a recreated SKU needs a new confirmation.
CREATE TABLE combo_sale_mappings (
  id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL,
  enterprise_key VARCHAR(128) COLLATE utf8mb4_0900_bin NOT NULL,
  store_id VARCHAR(36) COLLATE utf8mb4_0900_bin NOT NULL,
  source_name VARCHAR(512) NOT NULL,
  specification VARCHAR(255) NULL,
  target_sku_id VARCHAR(128) NULL,
  target_entry_id VARCHAR(32) NULL,
  target_department_id VARCHAR(36) NULL,
  basis VARCHAR(512) NOT NULL,
  INDEX combo_sale_mappings_scope_idx (org_id, enterprise_key, store_id, id),
  CONSTRAINT combo_sale_mappings_store_fk FOREIGN KEY (org_id, enterprise_key, store_id)
    REFERENCES business_stores (org_id, enterprise_key, store_id),
  CONSTRAINT combo_sale_mappings_department_fk FOREIGN KEY (target_department_id)
    REFERENCES business_departments (department_id),
  CONSTRAINT combo_sale_mappings_one_target CHECK (
    (target_department_id IS NULL AND target_entry_id IS NOT NULL AND target_sku_id IS NOT NULL) OR
    (target_department_id IS NOT NULL AND target_entry_id IS NULL AND target_sku_id IS NULL)
  )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
