import {
  isBusinessClearance,
  validateBusinessGrant,
  type AuthorizationSnapshot,
  type BusinessCategoryRule,
  type BusinessGrant
} from "@smedc/domain";

/** Registered mapping: business_resources AS r. No client-provided SQL identifiers. */
export type AuthorizedScopeTarget = "resource";
export interface AuthorizedScopeSql {
  sql: string;
  params: Array<string | number>;
}
export function compileAuthorizedScope(
  snapshot: AuthorizationSnapshot,
  target: AuthorizedScopeTarget
): AuthorizedScopeSql {
  if (target !== "resource") throw new Error("UNKNOWN_AUTHORIZATION_TARGET");
  const params: Array<string | number> = [];
  const bind = (value: string | number) => {
    params.push(value);
    return "?";
  };
  const exact = (column: string, value: string) =>
    `CAST(${column} AS BINARY) = CAST(${bind(value)} AS BINARY)`;
  if (snapshot.disabled || snapshot.mode !== "enabled" || !isBusinessClearance(snapshot.clearance))
    return { sql: "0 = 1", params };
  const grants = snapshot.grants.filter(
    (grant) =>
      grant.orgId === snapshot.orgId &&
      validateBusinessGrant(grant, snapshot.categories).length === 0
  );
  function grantSql(grant: BusinessGrant, category: BusinessCategoryRule): string {
    const conditions = [
      exact("s.enterprise_key", grant.enterpriseKey),
      exact("s.ownership", grant.ownership)
    ];
    if (grant.ownership === "store" && grant.stores?.kind === "fixed")
      conditions.push(
        `(${grant.stores.values.map((name) => exact("s.store_name", name)).join(" OR ")})`
      );
    for (const id of category.requiredDimensionIds) {
      const selection = grant.dimensions[id]!;
      conditions.push(
        `EXISTS (SELECT 1 FROM business_scope_dimensions d WHERE d.org_id = s.org_id AND d.resource_id = s.resource_id AND d.scope_id = s.id AND ${exact("d.dimension_id", id)}${selection.kind === "fixed" ? ` AND (${selection.values.map((value) => exact("d.value_id", value)).join(" OR ")})` : ""})`
      );
    }
    return `(${conditions.join(" AND ")})`;
  }
  const organization = exact("r.org_id", snapshot.orgId);
  const categories = snapshot.categories.flatMap((category) => {
    if (
      category.kind === "fixed" &&
      (!isBusinessClearance(category.confidentialityLevel) ||
        category.confidentialityLevel > snapshot.clearance)
    )
      return [];
    const relevant = grants.filter((grant) => grant.categoryIds.includes(category.id));
    if (relevant.length === 0) return [];
    const categoryCondition = exact("r.category_id", category.id);
    const clearance =
      category.kind === "evidence"
        ? `r.file_confidentiality_level BETWEEN 0 AND ${bind(snapshot.clearance)}`
        : "1 = 1";
    const ownerships =
      category.ownerships.map((ownership) => exact("s.ownership", ownership)).join(" OR ") ||
      "0 = 1";
    const shape = [
      `(${ownerships})`,
      `((s.ownership = 'group' AND s.store_name IS NULL) OR (s.ownership = 'store' AND s.store_name IS NOT NULL AND REGEXP_LIKE(s.store_name, ${bind("\\S")})))`,
      `CHAR_LENGTH(s.enterprise_key) > 0`,
      `(SELECT COUNT(*) FROM business_scope_dimensions d WHERE d.org_id = s.org_id AND d.resource_id = s.resource_id AND d.scope_id = s.id) = ${bind(category.requiredDimensionIds.length)}`
    ];
    for (const id of category.requiredDimensionIds)
      shape.push(
        `EXISTS (SELECT 1 FROM business_scope_dimensions d WHERE d.org_id = s.org_id AND d.resource_id = s.resource_id AND d.scope_id = s.id AND ${exact("d.dimension_id", id)} AND CHAR_LENGTH(d.value_id) > 0)`
      );
    const matching = relevant.map((grant) => grantSql(grant, category)).join(" OR ");
    return [
      `(${categoryCondition} AND ${clearance} AND NOT EXISTS (SELECT 1 FROM business_resource_scopes s WHERE s.org_id = r.org_id AND s.resource_id = r.id AND (NOT (${shape.join(" AND ")}) OR NOT (${matching}))))`
    ];
  });
  return {
    sql: `${organization} AND r.valid = 1 AND EXISTS (SELECT 1 FROM business_resource_scopes s WHERE s.org_id = r.org_id AND s.resource_id = r.id) AND (${categories.join(" OR ") || "0 = 1"})`,
    params
  };
}

/** Only registered server targets can choose correlation columns. */
export function compileStructuredReadScope(
  snapshot: AuthorizationSnapshot,
  target: "row" | "coverage" | "partition" | "cost_card" | "store_review",
  dataset: string
): AuthorizedScopeSql {
  if (!["row", "coverage", "partition", "cost_card", "store_review"].includes(target))
    throw new Error("UNKNOWN_AUTHORIZATION_TARGET");
  if (target === "store_review" && dataset !== "store_reviews")
    throw new Error("UNKNOWN_AUTHORIZATION_TARGET");
  const compiled = compileAuthorizedScope(snapshot, "resource");
  const predicate = compiled.sql.replaceAll("r.", "ar.");
  const correlation =
    target === "store_review"
      ? "ar.kind = 'store_review' AND ar.org_id = v.org_id AND CAST(ar.resource_key AS BINARY) = CAST(CONCAT('store-review:', v.id) AS BINARY) AND EXISTS (SELECT 1 FROM business_resource_scopes vs WHERE vs.org_id = ar.org_id AND vs.resource_id = ar.id AND vs.ownership = 'store' AND CAST(vs.enterprise_key AS BINARY) = CAST(v.enterprise_key AS BINARY) AND CAST(vs.store_name AS BINARY) = CAST(v.store_name AS BINARY)) AND (SELECT COUNT(*) FROM business_resource_scopes vs WHERE vs.org_id = ar.org_id AND vs.resource_id = ar.id) = 1"
      : target === "cost_card"
        ? "ar.kind = 'cost_card' AND ar.org_id = c.org_id AND CAST(ar.resource_key AS BINARY) = CAST(CONCAT('cost-card:', c.id) AS BINARY)"
        : target === "partition"
          ? "ar.kind = 'structured' AND CAST(ar.resource_key AS BINARY) = CAST(CONCAT('partition:', structured_partitions.id) AS BINARY)"
          : `ar.kind = 'source_fragment' AND ar.source_document_id = ${target === "row" ? "r" : "ib"}.source_document_id`;
  return {
    sql: `EXISTS (SELECT 1 FROM business_resources ar JOIN business_categories ac ON ac.org_id = ar.org_id AND ac.id = ar.category_id WHERE ${correlation} AND CAST(ac.\`key\` AS BINARY) = CAST(? AS BINARY) AND (${predicate}))`,
    params: [dataset, ...compiled.params]
  };
}
