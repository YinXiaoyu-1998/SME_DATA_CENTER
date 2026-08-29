-- Extend structured-import datasets and make date metadata optional for undated imports.
ALTER TABLE `import_batches`
    MODIFY `dataset` ENUM('dishes', 'business', 'vip', 'dish_catalog', 'delivery_ledger', 'supplier_catalog') NOT NULL,
    MODIFY `start_date` DATE NULL,
    MODIFY `end_date` DATE NULL,
    ADD COLUMN `natural_key` VARCHAR(255) NULL,
    ADD COLUMN `applied_at` DATETIME(3) NULL,
    ADD UNIQUE INDEX `import_batches_org_dataset_natural_key_uq`(`org_id`, `dataset`, `natural_key`);

ALTER TABLE `import_window_claims`
    MODIFY `dataset` ENUM('dishes', 'business', 'vip', 'dish_catalog', 'delivery_ledger', 'supplier_catalog') NOT NULL;

CREATE TABLE `delivery_ledger_rows` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `source_document_id` VARCHAR(32) NOT NULL,
    `import_batch_id` VARCHAR(32) NOT NULL,
    `source_sheet_index` INTEGER NOT NULL DEFAULT 0,
    `source_sheet_name` VARCHAR(255) NOT NULL DEFAULT 'Sheet1',
    `source_row_number` INTEGER NOT NULL,
    `payload` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `delivery_ledger_rows_org_id_import_batch_id_idx`(`org_id`, `import_batch_id`),
    UNIQUE INDEX `delivery_ledger_rows_batch_sheet_row_uq`(`import_batch_id`, `source_sheet_index`, `source_row_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `delivery_ledger_rows`
    ADD CONSTRAINT `delivery_ledger_rows_org_id_fkey`
      FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `delivery_ledger_rows_source_document_id_fkey`
      FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `delivery_ledger_rows_import_batch_id_fkey`
      FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE `supplier_catalog_rows` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `source_document_id` VARCHAR(32) NOT NULL,
    `import_batch_id` VARCHAR(32) NOT NULL,
    `source_sheet_index` INTEGER NOT NULL DEFAULT 0,
    `source_sheet_name` VARCHAR(255) NOT NULL DEFAULT 'Sheet1',
    `source_row_number` INTEGER NOT NULL,
    `payload` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `supplier_catalog_rows_org_id_import_batch_id_idx`(`org_id`, `import_batch_id`),
    UNIQUE INDEX `supplier_catalog_rows_batch_sheet_row_uq`(`import_batch_id`, `source_sheet_index`, `source_row_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `supplier_catalog_rows`
    ADD CONSTRAINT `supplier_catalog_rows_org_id_fkey`
      FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `supplier_catalog_rows_source_document_id_fkey`
      FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `supplier_catalog_rows_import_batch_id_fkey`
      FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
