-- Existing names remain the stable authorization and historical reference keys.
ALTER TABLE `business_stores`
  ADD COLUMN `store_id` VARCHAR(36) NULL,
  ADD COLUMN `official_name` VARCHAR(255) NULL,
  ADD COLUMN `confirmation` ENUM('pending', 'confirmed', 'historical') NOT NULL DEFAULT 'pending',
  ADD COLUMN `version` BIGINT UNSIGNED NOT NULL DEFAULT 0;
UPDATE `business_stores` SET `store_id` = UUID(), `official_name` = `name`;
ALTER TABLE `business_stores`
  MODIFY `store_id` VARCHAR(36) NOT NULL,
  MODIFY `official_name` VARCHAR(255) NOT NULL,
  ADD COLUMN `official_name_key` VARBINARY(1020) GENERATED ALWAYS AS (CAST(`official_name` AS BINARY)) STORED,
  ADD UNIQUE INDEX `business_stores_store_id_uq` (`store_id`),
  ADD UNIQUE INDEX `business_stores_org_enterprise_store_uq` (`org_id`, `enterprise_key`, `store_id`),
  ADD UNIQUE INDEX `business_stores_official_name_uq` (`org_id`, `enterprise_key`, `official_name_key`);

CREATE TABLE `business_departments` (
  `org_id` VARCHAR(64) NOT NULL,
  `enterprise_key` VARCHAR(128) NOT NULL,
  `department_id` VARCHAR(36) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `name_key` VARBINARY(1020) GENERATED ALWAYS AS (CAST(`name` AS BINARY)) STORED,
  `retired` BOOLEAN NOT NULL DEFAULT FALSE,
  `version` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`department_id`),
  UNIQUE INDEX `business_departments_org_enterprise_id_uq` (`org_id`, `enterprise_key`, `department_id`),
  UNIQUE INDEX `business_departments_name_uq` (`org_id`, `enterprise_key`, `name_key`),
  CONSTRAINT `business_departments_enterprise_fk` FOREIGN KEY (`org_id`, `enterprise_key`)
    REFERENCES `business_enterprise_identities` (`org_id`, `enterprise_key`) ON DELETE RESTRICT ON UPDATE RESTRICT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `employee_directory_profiles` (
  `employee_uid` VARCHAR(36) NOT NULL,
  `org_id` VARCHAR(64) NOT NULL,
  `enterprise_key` VARCHAR(128) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `department_id` VARCHAR(36) NOT NULL,
  `store_id` VARCHAR(36) COLLATE utf8mb4_0900_bin NULL,
  `status` ENUM('active', 'departed') NOT NULL DEFAULT 'active',
  `version` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`employee_uid`),
  INDEX `employee_directory_enterprise_status_idx` (`org_id`, `enterprise_key`, `status`, `employee_uid`),
  INDEX `employee_directory_department_idx` (`org_id`, `enterprise_key`, `department_id`, `status`),
  INDEX `employee_directory_store_idx` (`org_id`, `enterprise_key`, `store_id`, `status`),
  CONSTRAINT `employee_directory_enterprise_fk` FOREIGN KEY (`org_id`, `enterprise_key`)
    REFERENCES `business_enterprise_identities` (`org_id`, `enterprise_key`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `employee_directory_department_fk` FOREIGN KEY (`org_id`, `enterprise_key`, `department_id`)
    REFERENCES `business_departments` (`org_id`, `enterprise_key`, `department_id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `employee_directory_store_fk` FOREIGN KEY (`store_id`)
    REFERENCES `business_stores` (`store_id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Add the fixed category without granting it or choosing a tenant clearance.
INSERT INTO `business_categories` (`org_id`, `id`, `key`, `name`, `kind`, `confidentiality_level`, `allow_group`, `allow_store`, `retired`)
SELECT s.`org_id`, REPLACE(UUID(), '-', ''), 'employee_profiles', '员工档案', 'fixed', NULL, TRUE, TRUE, FALSE
FROM `business_authorization_states` s
WHERE NOT EXISTS (SELECT 1 FROM `business_categories` c WHERE c.`org_id` = s.`org_id` AND c.`key` = 'employee_profiles');
