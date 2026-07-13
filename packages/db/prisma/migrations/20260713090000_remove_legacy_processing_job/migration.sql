DELETE FROM `processing_runs`
WHERE `job_type` = 'legacy_text_extract';

ALTER TABLE `processing_runs`
  MODIFY `job_type` ENUM('evidence_document_index', 'structured_import') NOT NULL;
