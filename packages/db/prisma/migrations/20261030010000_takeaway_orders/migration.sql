-- Add a current CSV partition dataset; no order-level rows are persisted.
ALTER TABLE partition_import_jobs MODIFY COLUMN dataset ENUM('dishes','business','settled_orders','takeaway_orders') NOT NULL;
ALTER TABLE structured_partitions MODIFY COLUMN dataset ENUM('dishes','business','settled_orders','takeaway_orders') NOT NULL;
ALTER TABLE import_batches MODIFY COLUMN dataset ENUM('dishes','business','vip','dish_catalog','delivery_ledger','supplier_catalog','cost_cards','settled_orders','takeaway_orders') NOT NULL;
ALTER TABLE import_window_claims MODIFY COLUMN dataset ENUM('dishes','business','vip','dish_catalog','delivery_ledger','supplier_catalog','cost_cards','settled_orders','takeaway_orders') NOT NULL;
