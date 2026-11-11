-- Department names are unique per business enterprise across active and retired rows.
-- Run packages/db/prisma/checks/department-name-duplicates.sql first and resolve every
-- returned group manually (repoint employees and/or rename) before deploying. This migration
-- never trims, renames or deletes department rows: the guard below aborts when duplicates exist.
CREATE TEMPORARY TABLE `_business_departments_name_guard` (
  `org_id` VARCHAR(64) NOT NULL,
  `enterprise_key` VARCHAR(128) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  UNIQUE KEY `_business_departments_name_guard_uq` (`org_id`, `enterprise_key`, `name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `_business_departments_name_guard` (`org_id`, `enterprise_key`, `name`)
SELECT `org_id`, `enterprise_key`, `name` FROM `business_departments`;

DROP TEMPORARY TABLE `_business_departments_name_guard`;

-- Add the collation-based index before retiring the byte-exact legacy index so at least one
-- unique constraint protects the table throughout the migration.
ALTER TABLE `business_departments`
  ADD UNIQUE INDEX `business_departments_org_enterprise_name_uq` (`org_id`, `enterprise_key`, `name`);

ALTER TABLE `business_departments`
  DROP INDEX `business_departments_name_uq`;

ALTER TABLE `business_departments`
  DROP COLUMN `name_key`;
