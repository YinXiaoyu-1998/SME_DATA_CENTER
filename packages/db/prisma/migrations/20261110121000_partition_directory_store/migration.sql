-- Existing partitions keep their identifiers and source keys. A successful
-- publication records the confirmed store UUID without rewriting other history.
ALTER TABLE `structured_partitions`
  ADD COLUMN `directory_store_id` VARCHAR(36) NULL,
  ADD UNIQUE INDEX `structured_partitions_directory_store_day_uq`
    (`org_id`, `enterprise_key`, `dataset`, `directory_store_id`, `business_date`);
