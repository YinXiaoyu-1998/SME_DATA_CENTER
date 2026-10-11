-- Release-time fixed registration snapshot. No default clearance, grants or tenant activation.
-- Invalidate prepared versions while preserving every existing mode and tenant choice.
INSERT INTO business_authorization_states (org_id, version)
SELECT id, 1 FROM organizations
ON DUPLICATE KEY UPDATE version = version + 1;

INSERT INTO business_categories
  (org_id, id, `key`, name, kind, confidentiality_level, allow_group, allow_store, retired)
SELECT o.id, REPLACE(UUID(), '-', ''), registered.`key`, registered.`key`, 'fixed', NULL,
       registered.ownership = 'group', registered.ownership = 'store', false
FROM organizations o
CROSS JOIN (
  SELECT 'business' AS `key`, 'store' AS ownership
  UNION ALL SELECT 'dishes', 'store'
  UNION ALL SELECT 'vip', 'group'
  UNION ALL SELECT 'dish_catalog', 'group'
  UNION ALL SELECT 'supplier_catalog', 'group'
  UNION ALL SELECT 'delivery_ledger', 'store'
  UNION ALL SELECT 'quarantine_certificate', 'store'
  UNION ALL SELECT 'ledger_pdf', 'store'
) registered
LEFT JOIN business_categories existing ON existing.org_id = o.id AND existing.`key` = registered.`key`
WHERE existing.id IS NULL;
