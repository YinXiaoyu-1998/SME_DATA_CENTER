-- Keep the dataset and its stored objects. Move the partition authorization
-- records to dishes and derive no dishes grants from the old combo grants.
START TRANSACTION;

UPDATE business_authorization_states s
JOIN business_categories combo ON combo.org_id = s.org_id AND combo.`key` = 'combo_sales'
SET s.version = s.version + 1;

INSERT INTO business_categories (org_id, id, `key`, name, kind, confidentiality_level, allow_group, allow_store, retired)
SELECT combo.org_id, REPLACE(UUID(), '-', ''), 'dishes', 'dishes', 'fixed', NULL, false, true, false
FROM business_categories combo
LEFT JOIN business_categories dishes ON dishes.org_id = combo.org_id AND dishes.`key` = 'dishes'
WHERE combo.`key` = 'combo_sales' AND dishes.id IS NULL;

UPDATE business_resources r
JOIN business_categories combo ON combo.org_id = r.org_id AND combo.id = r.category_id AND combo.`key` = 'combo_sales'
JOIN business_categories dishes ON dishes.org_id = r.org_id AND dishes.`key` = 'dishes'
SET r.category_id = dishes.id, r.authorization_version = r.authorization_version + 1
WHERE r.kind = 'structured' AND BINARY r.resource_key LIKE BINARY 'partition:%';

DELETE g FROM business_grants g
JOIN business_grant_categories gc ON gc.org_id = g.org_id AND gc.grant_id = g.id
JOIN business_categories combo ON combo.org_id = gc.org_id AND combo.id = gc.category_id AND combo.`key` = 'combo_sales'
LEFT JOIN business_grant_categories other ON other.org_id = g.org_id AND other.grant_id = g.id AND other.category_id <> combo.id
WHERE other.category_id IS NULL;

DELETE gc FROM business_grant_categories gc
JOIN business_categories combo ON combo.org_id = gc.org_id AND combo.id = gc.category_id AND combo.`key` = 'combo_sales';

DELETE cd FROM business_category_dimensions cd
JOIN business_categories combo ON combo.org_id = cd.org_id AND combo.id = cd.category_id AND combo.`key` = 'combo_sales';

DELETE FROM business_categories WHERE `key` = 'combo_sales';

COMMIT;
