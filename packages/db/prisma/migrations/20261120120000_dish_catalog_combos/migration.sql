ALTER TABLE dish_catalog_entries
  ADD COLUMN dish_type VARCHAR(8) NULL,
  ADD COLUMN combo_composition JSON NULL;

CREATE TABLE dish_combo_references (
  org_id VARCHAR(64) NOT NULL,
  enterprise_key VARCHAR(128) NOT NULL,
  parent_sku VARCHAR(128) NOT NULL,
  child_sku VARCHAR(128) NOT NULL,
  PRIMARY KEY (org_id, enterprise_key, parent_sku, child_sku),
  INDEX dish_combo_child_idx (org_id, enterprise_key, child_sku),
  CONSTRAINT dish_combo_parent_fk FOREIGN KEY (org_id, enterprise_key, parent_sku)
    REFERENCES dish_catalog_entries (org_id, enterprise_key, sku_id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT dish_combo_child_fk FOREIGN KEY (org_id, enterprise_key, child_sku)
    REFERENCES dish_catalog_entries (org_id, enterprise_key, sku_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
