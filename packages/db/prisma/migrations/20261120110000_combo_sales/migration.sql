ALTER TABLE partition_import_jobs MODIFY COLUMN dataset ENUM('dishes','business','in_store_orders','takeaway_orders','combo_sales') NOT NULL;
ALTER TABLE structured_partitions MODIFY COLUMN dataset ENUM('dishes','business','in_store_orders','takeaway_orders','combo_sales') NOT NULL;
ALTER TABLE import_batches MODIFY COLUMN dataset ENUM('dishes','business','vip','dish_catalog','delivery_ledger','supplier_catalog','cost_cards','in_store_orders','takeaway_orders','combo_sales') NOT NULL;
ALTER TABLE import_window_claims MODIFY COLUMN dataset ENUM('dishes','business','vip','dish_catalog','delivery_ledger','supplier_catalog','cost_cards','in_store_orders','takeaway_orders','combo_sales') NOT NULL;

-- Register the new store category. Fresh tenants are initialized by the same fixed-category registry.
START TRANSACTION;
INSERT INTO business_authorization_states (org_id, version)
SELECT o.id, 1 FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM business_categories c WHERE c.org_id=o.id AND c.`key`='combo_sales')
ON DUPLICATE KEY UPDATE version = version + 1;

INSERT INTO business_categories (org_id, id, `key`, name, kind, confidentiality_level, allow_group, allow_store, retired)
SELECT o.id, REPLACE(UUID(), '-', ''), 'combo_sales', '套餐子菜销售明细', 'fixed', NULL, false, true, false
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM business_categories c WHERE c.org_id=o.id AND c.`key`='combo_sales');
COMMIT;
