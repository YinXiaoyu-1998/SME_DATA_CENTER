CREATE INDEX `partition_import_jobs_finished_at_status_idx`
    ON `partition_import_jobs` (`finished_at`, `status`);

CREATE INDEX `ledger_artifact_requests_kind_zip_expires_at_idx`
    ON `ledger_artifact_requests` (`kind`, `zip_expires_at`);
