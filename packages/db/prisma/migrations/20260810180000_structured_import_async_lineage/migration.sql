-- AlterTable
ALTER TABLE `import_batches`
    ADD COLUMN `validation_error_count` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `dish_rows`
    ADD COLUMN `source_sheet_index` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `source_sheet_name` VARCHAR(255) NOT NULL DEFAULT 'Sheet1',
    DROP INDEX `dish_rows_import_batch_id_source_row_number_key`,
    ADD UNIQUE INDEX `dish_rows_import_batch_id_source_sheet_index_source_row_number_key`(`import_batch_id`, `source_sheet_index`, `source_row_number`);

-- AlterTable
ALTER TABLE `business_rows`
    ADD COLUMN `source_sheet_index` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `source_sheet_name` VARCHAR(255) NOT NULL DEFAULT 'Sheet1',
    DROP INDEX `business_rows_import_batch_id_source_row_number_key`,
    ADD UNIQUE INDEX `business_rows_import_batch_id_source_sheet_index_source_row_number_key`(`import_batch_id`, `source_sheet_index`, `source_row_number`);
