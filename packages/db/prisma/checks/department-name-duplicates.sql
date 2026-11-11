-- Pre-deployment precheck for the department name uniqueness migration.
-- Run against the target database; any returned group must be resolved manually
-- (repoint employees and/or rename departments) before deploying. The migration
-- aborts instead of trimming, renaming or deleting department rows.
SELECT
  `org_id`,
  `enterprise_key`,
  `name`,
  COUNT(*) AS `duplicate_count`
FROM `business_departments`
GROUP BY `org_id`, `enterprise_key`, `name`
HAVING COUNT(*) > 1;
