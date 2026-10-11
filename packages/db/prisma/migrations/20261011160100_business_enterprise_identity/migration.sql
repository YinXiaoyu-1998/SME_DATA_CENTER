-- Explicit org-scoped display names; no grants or tenant-mode changes.
CREATE TABLE `business_enterprise_identities` (
  `org_id` VARCHAR(64) NOT NULL,
  `enterprise_key` VARCHAR(128) NOT NULL,
  `enterprise_name` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`org_id`, `enterprise_key`),
  CONSTRAINT `business_enterprise_identities_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
