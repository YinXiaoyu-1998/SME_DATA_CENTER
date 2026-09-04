ALTER TABLE `import_batches`
  ADD COLUMN `registry_version` VARCHAR(128) NULL;

UPDATE `import_batches`
SET `registry_version` = CASE `dataset`
  WHEN 'dishes' THEN 'dishes.2026-07-11.v1'
  WHEN 'business' THEN 'business.2026-07-11.v1'
  WHEN 'vip' THEN 'vip.2026-08-12.v1'
  WHEN 'dish_catalog' THEN 'dish_catalog.2026-08-22.v1'
  WHEN 'delivery_ledger' THEN 'delivery_ledger.2026-08-29.v1'
  WHEN 'supplier_catalog' THEN 'supplier_catalog.2026-08-29.v1'
END
WHERE `registry_version` IS NULL;

ALTER TABLE `import_batches`
  MODIFY COLUMN `registry_version` VARCHAR(128) NOT NULL;
