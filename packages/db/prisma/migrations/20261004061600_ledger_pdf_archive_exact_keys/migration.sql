-- Request keys are exact opaque strings, not case/accent-insensitive text.
ALTER TABLE `ledger_artifact_requests`
    MODIFY `idempotency_key` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;
