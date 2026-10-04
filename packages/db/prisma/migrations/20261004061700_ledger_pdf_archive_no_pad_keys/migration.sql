-- MySQL 8 binary NO PAD collation also preserves trailing whitespace in opaque keys.
-- This is separate because the preceding migration was already exercised locally.
ALTER TABLE `ledger_artifact_requests`
    MODIFY `idempotency_key` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;
