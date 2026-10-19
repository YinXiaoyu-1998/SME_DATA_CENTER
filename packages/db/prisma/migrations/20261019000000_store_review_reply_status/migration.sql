ALTER TABLE `store_reviews`
  ADD COLUMN `reply_status` ENUM('replied', 'unreplied_no_content', 'unreplied_with_content', 'needs_verification') NOT NULL DEFAULT 'needs_verification';
