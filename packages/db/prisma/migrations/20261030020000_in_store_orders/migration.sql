-- Widen first so existing rows and the new public identifier can coexist during migration.
ALTER TABLE partition_import_jobs MODIFY COLUMN dataset ENUM('dishes','business','settled_orders','takeaway_orders','in_store_orders') NOT NULL;
ALTER TABLE structured_partitions MODIFY COLUMN dataset ENUM('dishes','business','settled_orders','takeaway_orders','in_store_orders') NOT NULL;
ALTER TABLE import_batches MODIFY COLUMN dataset ENUM('dishes','business','vip','dish_catalog','delivery_ledger','supplier_catalog','cost_cards','settled_orders','takeaway_orders','in_store_orders') NOT NULL;
ALTER TABLE import_window_claims MODIFY COLUMN dataset ENUM('dishes','business','vip','dish_catalog','delivery_ledger','supplier_catalog','cost_cards','settled_orders','takeaway_orders','in_store_orders') NOT NULL;

-- Run with API writes and workers stopped. Fail before data updates on collisions or live leases.
DROP TEMPORARY TABLE IF EXISTS in_store_order_migration_guard;
CREATE TEMPORARY TABLE in_store_order_migration_guard (guard_key TINYINT PRIMARY KEY);
INSERT INTO in_store_order_migration_guard VALUES (1);
INSERT INTO in_store_order_migration_guard
SELECT 1 FROM business_categories old_category JOIN business_categories new_category
  ON new_category.org_id=old_category.org_id AND new_category.`key`='in_store_orders'
WHERE old_category.`key`='settled_orders' LIMIT 1;
INSERT INTO in_store_order_migration_guard
SELECT 1 FROM structured_partitions old_partition JOIN structured_partitions new_partition
  ON new_partition.org_id=old_partition.org_id AND new_partition.enterprise_key=old_partition.enterprise_key
  AND new_partition.store_key=old_partition.store_key AND new_partition.business_date=old_partition.business_date
  AND new_partition.dataset='in_store_orders'
WHERE old_partition.dataset='settled_orders' LIMIT 1;
INSERT INTO in_store_order_migration_guard
SELECT 1 FROM import_batches old_batch JOIN import_batches new_batch
  ON new_batch.org_id=old_batch.org_id AND new_batch.natural_key=old_batch.natural_key
  AND new_batch.dataset='in_store_orders'
WHERE old_batch.dataset='settled_orders' AND old_batch.natural_key IS NOT NULL LIMIT 1;
INSERT INTO in_store_order_migration_guard
SELECT 1 FROM import_window_claims old_window JOIN import_window_claims new_window
  ON new_window.org_id=old_window.org_id AND new_window.start_date=old_window.start_date
  AND new_window.end_date=old_window.end_date AND new_window.dataset='in_store_orders'
WHERE old_window.dataset='settled_orders' LIMIT 1;
INSERT INTO in_store_order_migration_guard
SELECT 1 FROM processing_runs r
  LEFT JOIN partition_import_jobs j ON j.id=r.partition_import_job_id
  LEFT JOIN partition_download_requests d ON d.id=r.partition_download_request_id
  LEFT JOIN documents source ON source.id=r.document_id
WHERE r.status='running' AND r.locked_until>CURRENT_TIMESTAMP(3)
  AND (j.dataset='settled_orders' OR JSON_UNQUOTE(JSON_EXTRACT(d.scope,'$.dataset'))='settled_orders'
    OR JSON_UNQUOTE(JSON_EXTRACT(source.source_metadata,'$.dataset'))='settled_orders') LIMIT 1;
-- Only ZIP artifacts can be queued for cleanup. Current business CSVs are never migration garbage.
INSERT INTO in_store_order_migration_guard
SELECT 1 FROM partition_download_requests d
WHERE JSON_UNQUOTE(JSON_EXTRACT(d.scope,'$.dataset'))='settled_orders' AND d.object_key IS NOT NULL
  AND (d.object_key NOT LIKE 'partition-downloads/%'
    OR EXISTS (SELECT 1 FROM structured_partitions p WHERE BINARY p.object_key=BINARY d.object_key)
    OR EXISTS (SELECT 1 FROM storage_garbage g WHERE g.object_key_hash=SHA2(d.object_key,256)
      AND BINARY g.object_key<>BINARY d.object_key)) LIMIT 1;
DROP TEMPORARY TABLE in_store_order_migration_guard;

START TRANSACTION;
UPDATE business_authorization_states state SET version=version+1
WHERE EXISTS (SELECT 1 FROM business_categories c WHERE c.org_id=state.org_id AND c.`key`='settled_orders')
  OR EXISTS (SELECT 1 FROM structured_partitions p WHERE p.org_id=state.org_id AND p.dataset='settled_orders')
  OR EXISTS (SELECT 1 FROM partition_import_jobs j WHERE j.org_id=state.org_id AND j.dataset='settled_orders')
  OR EXISTS (SELECT 1 FROM import_batches b WHERE b.org_id=state.org_id AND b.dataset='settled_orders')
  OR EXISTS (SELECT 1 FROM import_window_claims w WHERE w.org_id=state.org_id AND w.dataset='settled_orders')
  OR EXISTS (SELECT 1 FROM partition_download_requests d WHERE d.org_id=state.org_id AND JSON_UNQUOTE(JSON_EXTRACT(d.scope,'$.dataset'))='settled_orders')
  OR EXISTS (SELECT 1 FROM documents d WHERE d.org_id=state.org_id AND (JSON_UNQUOTE(JSON_EXTRACT(d.source_metadata,'$.dataset'))='settled_orders'
    OR JSON_UNQUOTE(JSON_EXTRACT(d.source_metadata,'$.parsedBusinessScopes.dataset'))='settled_orders'));

UPDATE business_categories
SET `key`='in_store_orders', name=CASE WHEN BINARY name IN ('settled_orders','店内已结账订单明细') THEN '店内订单明细' ELSE name END
WHERE `key`='settled_orders';
UPDATE partition_import_jobs SET dataset='in_store_orders' WHERE dataset='settled_orders';
UPDATE structured_partitions SET dataset='in_store_orders' WHERE dataset='settled_orders';
UPDATE import_batches SET dataset='in_store_orders' WHERE dataset='settled_orders';
UPDATE import_window_claims SET dataset='in_store_orders' WHERE dataset='settled_orders';
UPDATE documents SET source_metadata=JSON_SET(source_metadata,'$.dataset','in_store_orders')
WHERE JSON_UNQUOTE(JSON_EXTRACT(source_metadata,'$.dataset'))='settled_orders';
UPDATE documents SET source_metadata=JSON_SET(source_metadata,'$.parsedBusinessScopes.dataset','in_store_orders')
WHERE JSON_UNQUOTE(JSON_EXTRACT(source_metadata,'$.parsedBusinessScopes.dataset'))='settled_orders';

-- Existing ZIP bytes and their historical scope/fingerprints are not relabelled as a new artifact.
-- Keep any already-issued URL usable through its TTL by delaying exact-key cleanup at least 24 hours.
INSERT INTO storage_garbage (id,object_key,object_key_hash,reason,available_at,created_at,updated_at)
SELECT REPLACE(UUID(),'-',''),d.object_key,SHA2(d.object_key,256),'PARTITION_DOWNLOAD_EXPIRED',
  GREATEST(d.expires_at,DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY)),CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3)
FROM partition_download_requests d
WHERE JSON_UNQUOTE(JSON_EXTRACT(d.scope,'$.dataset'))='settled_orders' AND d.object_key IS NOT NULL
ON DUPLICATE KEY UPDATE available_at=GREATEST(storage_garbage.available_at,VALUES(available_at)),reason=VALUES(reason);
UPDATE processing_runs r JOIN partition_download_requests d ON d.id=r.partition_download_request_id AND d.org_id=r.org_id
SET r.status='failed',r.error_code='PARTITION_DOWNLOAD_EXPIRED',r.error_summary='PARTITION_DOWNLOAD_EXPIRED',
  r.locked_by=NULL,r.locked_until=NULL,r.finished_at=CURRENT_TIMESTAMP(3)
WHERE JSON_UNQUOTE(JSON_EXTRACT(d.scope,'$.dataset'))='settled_orders'
  AND r.status IN ('queued','running','retry_scheduled');
UPDATE partition_download_requests
SET status='expired',error_code='PARTITION_DOWNLOAD_EXPIRED',expires_at=LEAST(expires_at,CURRENT_TIMESTAMP(3))
WHERE JSON_UNQUOTE(JSON_EXTRACT(scope,'$.dataset'))='settled_orders' AND status IN ('queued','running','succeeded');
UPDATE partition_download_requests SET object_key=NULL,byte_size=NULL,checksum_sha256=NULL
WHERE JSON_UNQUOTE(JSON_EXTRACT(scope,'$.dataset'))='settled_orders';
COMMIT;

-- Physical table names, partition IDs, CSV object keys/checksums, grants and request fingerprints stay intact.
ALTER TABLE partition_import_jobs MODIFY COLUMN dataset ENUM('dishes','business','in_store_orders','takeaway_orders') NOT NULL;
ALTER TABLE structured_partitions MODIFY COLUMN dataset ENUM('dishes','business','in_store_orders','takeaway_orders') NOT NULL;
ALTER TABLE import_batches MODIFY COLUMN dataset ENUM('dishes','business','vip','dish_catalog','delivery_ledger','supplier_catalog','cost_cards','in_store_orders','takeaway_orders') NOT NULL;
ALTER TABLE import_window_claims MODIFY COLUMN dataset ENUM('dishes','business','vip','dish_catalog','delivery_ledger','supplier_catalog','cost_cards','in_store_orders','takeaway_orders') NOT NULL;
