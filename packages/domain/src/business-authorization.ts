export type BusinessOwnership = "group" | "store";
// Developer-owned registration; tenant configuration supplies levels, never category identity.
export const FIXED_BUSINESS_CATEGORY_OWNERSHIP = {
  business: "store",
  dishes: "store",
  vip: "group",
  dish_catalog: "group",
  supplier_catalog: "group",
  delivery_ledger: "store",
  quarantine_certificate: "store",
  ledger_pdf: "store"
} as const satisfies Record<string, BusinessOwnership>;
export type FixedBusinessCategoryKey = keyof typeof FIXED_BUSINESS_CATEGORY_OWNERSHIP;
export const FIXED_BUSINESS_CATEGORY_KEYS = Object.keys(
  FIXED_BUSINESS_CATEGORY_OWNERSHIP
) as FixedBusinessCategoryKey[];
export type BusinessSelection = { kind: "all" } | { kind: "fixed"; values: string[] };
export interface BusinessScopeItem {
  enterpriseKey: string;
  ownership: BusinessOwnership;
  storeName?: string;
  /** Stable dimension ID -> stable value ID. */
  dimensions: Record<string, string>;
}
export interface BusinessCategoryRule {
  id: string;
  key?: string;
  kind: "fixed" | "evidence";
  confidentialityLevel: number | null;
  ownerships: BusinessOwnership[];
  requiredDimensionIds: string[];
}
export interface BusinessGrant {
  id: string;
  orgId: string;
  enterpriseKey: string;
  categoryIds: string[];
  ownership: BusinessOwnership;
  stores?: BusinessSelection;
  dimensions: Record<string, BusinessSelection>;
}
export interface ResourceReadRequirement {
  orgId: string;
  categoryId: string;
  valid: boolean;
  fileConfidentialityLevel?: number | null;
  scopes: BusinessScopeItem[];
}
export interface AuthorizationSnapshot {
  orgId: string;
  employeeId: string;
  role: "admin" | "employee";
  disabled: boolean;
  clearance: number;
  mode: "legacy" | "preparing" | "enabled" | "suspended";
  authorizationVersion: string;
  categories: BusinessCategoryRule[];
  grants: BusinessGrant[];
}
export type AccessDenialReason =
  | "account_disabled"
  | "organization_mismatch"
  | "authorization_not_enabled"
  | "resource_invalid"
  | "attributes_not_ready"
  | "clearance_insufficient"
  | "grant_missing";
export type AccessDecision = { allowed: true } | { allowed: false; reason: AccessDenialReason };
export function isBusinessClearance(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 3;
}
function validSelection(selection: BusinessSelection | undefined): boolean {
  return (
    selection?.kind === "all" ||
    (selection?.kind === "fixed" &&
      selection.values.length > 0 &&
      selection.values.every((value) => typeof value === "string" && value.trim().length > 0))
  );
}
export function validateBusinessGrant(
  grant: BusinessGrant,
  categories: BusinessCategoryRule[]
): string[] {
  const errors: string[] = [];
  if (!grant.orgId || !grant.enterpriseKey || grant.categoryIds.length === 0)
    errors.push("grant_identity_required");
  if (
    grant.ownership === "store"
      ? !validSelection(grant.stores)
      : grant.ownership !== "group" || grant.stores !== undefined
  )
    errors.push("invalid_store_selection");
  for (const id of grant.categoryIds) {
    const rule = categories.find((category) => category.id === id);
    if (!rule || !rule.ownerships.includes(grant.ownership)) {
      errors.push("category_ownership_mismatch");
      continue;
    }
    if (
      Object.keys(grant.dimensions).length !== rule.requiredDimensionIds.length ||
      rule.requiredDimensionIds.some((dimension) => !validSelection(grant.dimensions[dimension]))
    )
      errors.push("dimension_selection_mismatch");
  }
  return errors;
}
export function validateBusinessScope(
  scope: BusinessScopeItem,
  category: BusinessCategoryRule
): boolean {
  return (
    typeof scope.enterpriseKey === "string" &&
    scope.enterpriseKey.length > 0 &&
    category.ownerships.includes(scope.ownership) &&
    (scope.ownership === "store"
      ? typeof scope.storeName === "string" && scope.storeName.trim().length > 0
      : scope.storeName === undefined) &&
    Object.keys(scope.dimensions).length === category.requiredDimensionIds.length &&
    category.requiredDimensionIds.every(
      (id) => typeof scope.dimensions[id] === "string" && scope.dimensions[id]!.length > 0
    )
  );
}
function selected(selection: BusinessSelection | undefined, value: string): boolean {
  return (
    selection?.kind === "all" || (selection?.kind === "fixed" && selection.values.includes(value))
  );
}
export function canReadResource(
  snapshot: AuthorizationSnapshot,
  requirement: ResourceReadRequirement
): AccessDecision {
  const deny = (reason: AccessDenialReason): AccessDecision => ({ allowed: false, reason });
  if (snapshot.disabled) return deny("account_disabled");
  if (snapshot.orgId !== requirement.orgId) return deny("organization_mismatch");
  if (snapshot.mode !== "enabled") return deny("authorization_not_enabled");
  if (!requirement.valid) return deny("resource_invalid");
  const category = snapshot.categories.find((rule) => rule.id === requirement.categoryId);
  if (
    !category ||
    requirement.scopes.length === 0 ||
    requirement.scopes.some((scope) => !validateBusinessScope(scope, category))
  )
    return deny("attributes_not_ready");
  const level =
    category.kind === "evidence"
      ? requirement.fileConfidentialityLevel
      : category.confidentialityLevel;
  if (!isBusinessClearance(level) || !isBusinessClearance(snapshot.clearance))
    return deny("attributes_not_ready");
  if (snapshot.clearance < level) return deny("clearance_insufficient");
  const grants = snapshot.grants.filter(
    (grant) =>
      grant.orgId === snapshot.orgId &&
      validateBusinessGrant(grant, snapshot.categories).length === 0
  );
  return requirement.scopes.every((scope) =>
    grants.some(
      (grant) =>
        grant.enterpriseKey === scope.enterpriseKey &&
        grant.categoryIds.includes(category.id) &&
        grant.ownership === scope.ownership &&
        (scope.ownership === "group" || selected(grant.stores, scope.storeName!)) &&
        category.requiredDimensionIds.every((id) =>
          selected(grant.dimensions[id], scope.dimensions[id]!)
        )
    )
  )
    ? { allowed: true }
    : deny("grant_missing");
}
