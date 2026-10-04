-- Track submitted and reused exact generations without changing request ownership.
CREATE TABLE `ledger_pdf_reconciliation_targets` (
  `id` VARCHAR(32) NOT NULL,
  `org_id` VARCHAR(64) NOT NULL,
  `reconciliation_run_id` VARCHAR(32) NOT NULL,
  `request_item_id` VARCHAR(32) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `ledger_reconciliation_target_uq` (`reconciliation_run_id`, `request_item_id`),
  INDEX `ledger_pdf_reconciliation_targets_org_id_request_item_id_idx` (`org_id`, `request_item_id`),
  CONSTRAINT `ledger_reconciliation_target_run_fk` FOREIGN KEY (`org_id`, `reconciliation_run_id`) REFERENCES `ledger_pdf_reconciliation_runs` (`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `ledger_reconciliation_target_item_fk` FOREIGN KEY (`org_id`, `request_item_id`) REFERENCES `ledger_artifact_request_items` (`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
