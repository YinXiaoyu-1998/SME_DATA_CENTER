-- Exact item names: case, width and trailing whitespace are all significant.
CREATE TABLE `shelf_life_catalog_entries` (
    `id` VARCHAR(64) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `item_name` VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
    `shelf_life` VARCHAR(255) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`),
    UNIQUE INDEX `shelf_life_catalog_entries_org_id_item_name_key` (`org_id`, `item_name`),
    CONSTRAINT `shelf_life_catalog_entries_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
