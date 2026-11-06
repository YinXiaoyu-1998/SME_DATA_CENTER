import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getWebApiRoute } from "@smedc/web-api-contract";
import {
  BrowserSessions,
  BROWSER_SESSION_COOKIE,
  type BrowserPrincipal,
  type BrowserSessionRepository
} from "../auth/browser-session.js";
import { csrfTokenForSecret } from "../auth/http-contract.js";
import {
  createBusinessAuthorizationService,
  type BusinessAuthorizationRepository
} from "../business-authorization.js";
import { registerApiErrorHandler } from "../request-errors.js";

const origin = "https://app.smedatacenter.example";
const fingerprint = "a".repeat(64);
const BASE = "/api/web/v1/orgs/org_a/permissions";
const WORKFLOW_BASE = "/api/web/v1/orgs/org_a/workflows";
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const businessCategoryRule = {
  id: "cat_business",
  key: "business",
  kind: "fixed" as const,
  confidentialityLevel: 1,
  ownerships: ["store" as const],
  requiredDimensionIds: ["dim_brand"]
};
const evidenceCategoryRule = {
  id: "cat_evidence",
  kind: "evidence" as const,
  confidentialityLevel: null,
  ownerships: ["group" as const, "store" as const],
  requiredDimensionIds: []
};
const categoryRow = {
  orgId: "org_a",
  id: "cat_business",
  key: "business",
  name: "营业数据",
  kind: "fixed" as const,
  confidentialityLevel: 1,
  allowGroup: false,
  allowStore: true,
  retired: false,
  dimensions: [{ orgId: "org_a", categoryId: "cat_business", dimensionId: "dim_brand" }]
};
const evidenceCategoryRow = {
  orgId: "org_a",
  id: "cat_evidence",
  key: null,
  name: "证据",
  kind: "evidence" as const,
  confidentialityLevel: null,
  allowGroup: true,
  allowStore: true,
  retired: false,
  dimensions: []
};
const storeRow = { orgId: "org_a", enterpriseKey: "business-a", name: "门店甲", retired: false };
const dimensionRow = { orgId: "org_a", id: "dim_brand", name: "品牌", retired: false };
const dimensionValueRow = {
  orgId: "org_a",
  dimensionId: "dim_brand",
  id: "value_a",
  name: "甲品牌",
  retired: false
};
const enterpriseRow = { orgId: "org_a", enterpriseKey: "business-a", enterpriseName: "业务企业甲" };
const resourceRow = {
  orgId: "org_a",
  id: "res_1",
  kind: "evidence" as const,
  resourceKey: "doc_1",
  categoryId: "cat_evidence",
  valid: true,
  fileConfidentialityLevel: 2,
  contentVersion: "1",
  authorizationVersion: "1",
  documentId: "doc_1",
  sourceDocumentId: null,
  scopes: [
    {
      orgId: "org_a",
      resourceId: "res_1",
      id: "scope_1",
      enterpriseKey: "business-a",
      ownership: "store" as const,
      storeName: "门店甲",
      dimensions: []
    }
  ]
};

function snapshotFor(employeeId: string) {
  return {
    orgId: "org_a",
    employeeId,
    role: "admin" as const,
    disabled: false,
    clearance: 3,
    mode: "legacy" as const,
    authorizationVersion: "7",
    categories: [businessCategoryRule, evidenceCategoryRule],
    grants: []
  };
}

async function fixture(overrides: { workflows?: boolean } = {}) {
  const principals = new Map<string, BrowserPrincipal>([
    [
      "identity_a",
      {
        identityId: "identity_a",
        id: "admin_a",
        orgId: "org_a",
        organizationName: "企业甲保密名称",
        displayName: "管理员甲",
        email: "a@example.invalid",
        role: "admin",
        clearance: 3,
        disabled: false
      }
    ],
    [
      "identity_b",
      {
        identityId: "identity_b",
        id: "admin_b",
        orgId: "org_b",
        organizationName: "企业乙",
        displayName: "管理员乙",
        email: "b@example.invalid",
        role: "admin",
        clearance: 3,
        disabled: false
      }
    ],
    [
      "identity_employee",
      {
        identityId: "identity_employee",
        id: "employee_a",
        orgId: "org_a",
        organizationName: "企业甲保密名称",
        displayName: "员工甲",
        email: "employee@example.invalid",
        role: "employee",
        clearance: 0,
        disabled: false
      }
    ]
  ]);
  const records = new Map<
    string,
    { identityId: string; expiresAt: Date; revokedAt: Date | null }
  >();
  const repository: BrowserSessionRepository = {
    async create(input) {
      records.set(input.secretHash, {
        identityId: input.identityId,
        expiresAt: input.expiresAt,
        revokedAt: null
      });
      return true;
    },
    async find(hash) {
      const row = records.get(hash);
      const principal = row && principals.get(row.identityId);
      return row && principal
        ? {
            ...row,
            principal,
            credentialFingerprint: fingerprint,
            currentCredentialFingerprint: fingerprint
          }
        : null;
    },
    async revoke(hash, at) {
      const row = records.get(hash);
      if (row) row.revokedAt = at;
    }
  };
  const sessions = new BrowserSessions(repository);
  const audit = { requestId: "req_ui", sourceIp: "127.0.0.1", launcherVersion: null };
  const issue = async (identityId: string) =>
    (await sessions.issue(
      {
        identityId,
        employeeId: principals.get(identityId)!.id,
        orgId: principals.get(identityId)!.orgId,
        credentialFingerprint: fingerprint
      },
      null,
      audit
    ))!;
  const secretA = await issue("identity_a");
  const secretB = await issue("identity_b");
  const secretEmployee = await issue("identity_employee");

  const permissionsRepository = {
    loadPermissionCard: vi.fn(async (employeeId: string) => ({
      ...snapshotFor(employeeId),
      storeReviewEnterprises: {
        complete: true as const,
        write: [{ enterpriseKey: "business-a", enterpriseName: "业务企业甲" }],
        read: []
      }
    })),
    loadAuthorizationSnapshot: vi.fn(async (employeeId: string) => snapshotFor(employeeId)),
    listAccounts: vi.fn(async () => [
      {
        orgId: "org_a",
        mode: "legacy" as const,
        authorizationVersion: "7",
        categories: [businessCategoryRule, evidenceCategoryRule],
        displayName: "员工甲",
        email: "employee@example.invalid",
        role: "employee" as const,
        disabled: false,
        clearance: 0,
        id: "employee_a",
        employeeId: "employee_a",
        grants: []
      }
    ]),
    listCategories: vi.fn(async () => [categoryRow, evidenceCategoryRow]),
    listDimensions: vi.fn(async () => [{ ...dimensionRow, values: [dimensionValueRow] }]),
    listStores: vi.fn(async () => [storeRow]),
    initializeFixedCategories: vi.fn(async () => ({
      authorizationVersion: "8",
      value: { createdCount: 1 }
    })),
    configureAccount: vi.fn(async () => ({
      authorizationVersion: "8",
      value: { clearance: 1, grants: [] }
    })),
    configureCategory: vi.fn(async () => ({
      authorizationVersion: "8",
      value: evidenceCategoryRow
    })),
    configureEvidenceDocument: vi.fn(async () => ({
      authorizationVersion: "8",
      value: resourceRow
    })),
    defineDimension: vi.fn(async () => ({ authorizationVersion: "8", value: dimensionRow })),
    defineDimensionValue: vi.fn(async () => ({
      authorizationVersion: "8",
      value: dimensionValueRow
    })),
    putStore: vi.fn(async () => ({
      authorizationVersion: "8",
      value: { ...storeRow, enterpriseName: "业务企业甲" }
    })),
    declareEnterpriseIdentity: vi.fn(async () => ({
      authorizationVersion: "8",
      value: enterpriseRow
    })),
    inspectAuthorizationCutover: vi.fn(async () => ({
      authorizationVersion: "7",
      mode: "legacy" as const,
      inspection: {
        ready: false,
        missing: [{ code: "FIXED_CATEGORY_CLEARANCE_REQUIRED", targetId: "business" }],
        accountsWithoutGrants: ["employee_a"]
      }
    })),
    activateAuthorizationCutover: vi.fn(async () => ({
      authorizationVersion: "8",
      value: { mode: "enabled" }
    })),
    suspendAuthorizationReads: vi.fn(async () => ({
      authorizationVersion: "8",
      value: { mode: "suspended" }
    }))
  };
  const permissions = createBusinessAuthorizationService(
    permissionsRepository as unknown as BusinessAuthorizationRepository
  );
  const metadata = {
    listEnterprises: vi.fn(async () => [
      { enterpriseKey: "business-a", enterpriseName: "业务企业甲" }
    ]),
    listDocuments: vi.fn(async () => ({
      documents: [
        {
          id: "doc_1",
          title: "证据一",
          status: "active",
          categoryId: "cat_evidence",
          fileConfidentialityLevel: 2,
          valid: true,
          scopes: [
            {
              enterpriseKey: "business-a",
              ownership: "store" as const,
              storeName: "门店甲",
              dimensions: {}
            }
          ]
        }
      ],
      nextCursor: null
    }))
  };
  const workflows = {
    execute: vi.fn(async (tool: string) => workflowResponse(tool))
  };
  const app = Fastify({ logger: false });
  apps.push(app);
  registerApiErrorHandler(app);
  (await import("./routes.js")).registerAdminPermissionsRoutes(app, {
    auth: { verifyLogin: vi.fn() } as never,
    browserSessions: sessions,
    permissions: () => permissions,
    metadata: () => metadata,
    webOrigin: origin,
    ...(overrides.workflows === false ? {} : { workflows: () => workflows as never })
  });
  await app.ready();
  const cookie = (secret: string) => BROWSER_SESSION_COOKIE + "=" + secret;
  return {
    app,
    sessions,
    principals,
    permissionsRepository,
    metadata,
    workflows,
    secretA,
    secretB,
    secretEmployee,
    cookie,
    writeHeaders: (secret: string) => ({
      cookie: cookie(secret),
      origin,
      "x-csrf-token": csrfTokenForSecret(secret)
    })
  };
}

// 自动任务响应固定样本：形状取自 enterprise-workflows 服务层真实返回结构。
const workflowView = {
  capability: {
    id: "enterprise-workflows-v1",
    version: "1.0.0",
    configurationSchemaVersion: 1,
    minimumLauncherVersion: "0.16.0"
  },
  workflowId: "wf_1",
  enterpriseKey: "business-a",
  workflowType: "weekly-business-report" as const,
  version: 3,
  controlVersion: 2,
  controlState: "paused" as const,
  assignmentEpoch: 1,
  assignedInstallationId: null,
  lease: { runId: null, expiresAt: null },
  configuration: {
    schemaVersion: 1 as const,
    type: "weekly-business-report" as const,
    storeNames: ["门店甲"],
    notificationPolicy: "action_required" as const,
    groups: [],
    delivery: { enabled: false, recipients: [] as string[] },
    cleanupPolicy: "retain_final_report" as const
  },
  integration: {
    orgId: "org_a",
    enterpriseKey: "business-a",
    version: 2,
    schemaVersion: 1,
    configuration: {
      schemaVersion: 1 as const,
      timezone: "Asia/Shanghai" as const,
      sourceAccounts: [],
      storeMappings: [],
      exclusions: []
    },
    orderScopeRequired: false,
    updatedBy: "admin_a",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z"
  },
  authorizations: [
    {
      authorizationId: "auth_1",
      scope: {
        kind: "review_sync" as const,
        channels: ["meituan" as const],
        storeNames: ["门店甲"]
      },
      configurationVersion: 3,
      controlVersion: 2,
      grantedBy: "admin_a",
      grantedAt: "2026-11-01T00:00:00.000Z",
      revokedAt: null
    }
  ]
};

const installationRow = {
  orgId: "org_a",
  workflowId: "wf_1",
  installationId: "install_1",
  employeeId: "admin_a",
  version: 2,
  deviceAlias: "开发机",
  host: "codex",
  platform: "macos",
  launcherVersion: "0.16.0",
  workflowPackageVersion: "1.0.0",
  state: "pending" as const,
  hostSnapshot: null,
  readinessChecks: null,
  firstRunVerification: "not_run",
  lastCheckedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z"
};

const runRow = {
  id: "run_1",
  orgId: "org_a",
  workflowId: "wf_1",
  installationId: "install_1",
  employeeId: "admin_a",
  configurationVersion: 3,
  integrationVersion: 2,
  controlVersion: 2,
  assignmentEpoch: 1,
  workflowPackageVersion: "1.0.0",
  startDate: "2026-10-26T00:00:00.000Z",
  endDate: "2026-11-01T00:00:00.000Z",
  mode: "scheduled",
  phase: "preparing",
  status: "running" as const,
  snapshot: {
    workflowType: "weekly-business-report" as const,
    window: { startDate: "2026-10-26", endDate: "2026-11-01" },
    integrationVersion: 2,
    configurationVersion: 3,
    workflowPackageVersion: "1.0.0",
    integration: workflowView.integration.configuration,
    configuration: workflowView.configuration
  },
  summary: null,
  startedAt: "2026-11-02T00:00:00.000Z",
  renewedAt: "2026-11-02T00:00:00.000Z",
  finishedAt: null,
  retainUntil: "2027-01-31T00:00:00.000Z",
  runId: "run_1"
};

function workflowResponse(tool: string): unknown {
  if (tool === "list_enterprise_workflows")
    return {
      capability: workflowView.capability,
      needsConfiguration: false,
      setupUrl: "/admin/permissions/org_a/workflows/business-a",
      workflows: [workflowView],
      nextCursor: null
    };
  if (tool === "get_enterprise_workflow" || tool === "save_enterprise_workflow")
    return workflowView;
  if (tool === "prepare_enterprise_workflow_change")
    return {
      enterpriseKey: "business-a",
      workflowType: "weekly-business-report",
      expectedVersion: 3,
      expectedIntegrationVersion: 2,
      expectedControlVersion: 2,
      change: {
        kind: "control",
        state: "active",
        reason: "启用周报"
      },
      previewId: "preview_1",
      confirmationDigest: "b".repeat(64),
      expiresAt: "2026-11-02T00:15:00.000Z"
    };
  if (tool === "manage_workflow_installation") return installationRow;
  if (tool === "manage_workflow_run") return { allowed: true, intentRequired: true };
  if (tool === "record_workflow_action") return { actions: [] };
  return {
    ...workflowView,
    observedAt: "2026-11-02T00:00:00.000Z",
    expectedWindow: { startDate: "2026-10-26", endDate: "2026-11-01" },
    possibleMissedWindow: false,
    pendingActions: [],
    nextActionCursor: null,
    migrations: [],
    nextMigrationCursor: null,
    installations: [installationRow],
    runs: [runRow],
    nextCursor: null
  };
}

const readCases: Array<[string, string]> = [
  ["permissions.me.read", BASE + "/me"],
  ["permissions.accounts.list", BASE + "/accounts"],
  ["permissions.accounts.read", BASE + "/accounts/employee_a"],
  ["permissions.stores.list", BASE + "/stores"],
  ["permissions.categories.list", BASE + "/categories"],
  ["permissions.dimensions.list", BASE + "/dimensions"],
  ["permissions.documents.list", BASE + "/documents"],
  ["permissions.enterprises.list", BASE + "/enterprises"],
  ["permissions.cutover.read", BASE + "/cutover"]
];

const writeCases: Array<[string, "POST" | "PATCH", string, Record<string, unknown>]> = [
  [
    "permissions.accounts.update",
    "PATCH",
    BASE + "/accounts/employee_a",
    { expectedVersion: "7", clearance: 1, grants: [] }
  ],
  [
    "permissions.stores.upsert",
    "POST",
    BASE + "/stores",
    { expectedVersion: "7", enterpriseKey: "business-a", name: "门店乙", retired: false }
  ],
  [
    "permissions.categories.create",
    "POST",
    BASE + "/categories",
    {
      expectedVersion: "7",
      id: "cat_new",
      name: "新证据类别",
      kind: "evidence",
      ownerships: ["store"],
      requiredDimensionIds: []
    }
  ],
  [
    "permissions.categories.update",
    "PATCH",
    BASE + "/categories/cat_business",
    { expectedVersion: "7", name: "营业数据", confidentialityLevel: 2 }
  ],
  [
    "permissions.categories.initialize",
    "POST",
    BASE + "/categories/initialize",
    { expectedVersion: "7" }
  ],
  [
    "permissions.dimensions.create",
    "POST",
    BASE + "/dimensions",
    { expectedVersion: "7", id: "dim_new", name: "新维度" }
  ],
  [
    "permissions.dimensions.update",
    "PATCH",
    BASE + "/dimensions/dim_brand",
    { expectedVersion: "7", name: "品牌", retired: false }
  ],
  [
    "permissions.dimensions.valueCreate",
    "POST",
    BASE + "/dimensions/dim_brand/values",
    { expectedVersion: "7", id: "value_b", name: "乙品牌" }
  ],
  [
    "permissions.dimensions.valueUpdate",
    "PATCH",
    BASE + "/dimensions/dim_brand/values/value_a",
    { expectedVersion: "7", name: "甲品牌", retired: false }
  ],
  [
    "permissions.documents.update",
    "PATCH",
    BASE + "/documents/doc_1",
    {
      expectedVersion: "7",
      categoryId: "cat_evidence",
      fileConfidentialityLevel: 2,
      scopes: [
        { enterpriseKey: "business-a", ownership: "store", storeName: "门店甲", dimensions: {} }
      ]
    }
  ],
  [
    "permissions.enterprises.declare",
    "POST",
    BASE + "/enterprises",
    { expectedVersion: "7", name: "示例 小馆 A" }
  ],
  [
    "permissions.enterprises.preview",
    "POST",
    BASE + "/enterprises/preview",
    { name: "示例 小馆 A" }
  ],
  [
    "permissions.cutover.activate",
    "POST",
    BASE + "/cutover/activate",
    { expectedVersion: "7", confirm: true }
  ],
  [
    "permissions.cutover.suspend",
    "POST",
    BASE + "/cutover/suspend",
    { expectedVersion: "7", confirm: true }
  ]
];

describe("browser permission routes", () => {
  it("answers 401 for every route without a browser session", async () => {
    const { app } = await fixture();
    for (const [, url] of readCases) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json().error.code).toBe("BROWSER_SIGN_IN_REQUIRED");
    }
    for (const [, method, url, payload] of writeCases) {
      const response = await app.inject({ method, url, payload });
      expect(response.statusCode, url).toBe(401);
      expect(response.json().error.code).toBe("BROWSER_SIGN_IN_REQUIRED");
    }
  });

  it("does not accept a launcher bearer token as a browser session", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      url: BASE + "/accounts",
      headers: { authorization: "Bearer eh_at_launcher" }
    });
    expect(response.statusCode).toBe(401);
  });

  it("denies ordinary employees and cross-organization administrators without leaking metadata", async () => {
    const { app, cookie, secretEmployee, secretB, permissionsRepository, metadata } =
      await fixture();
    for (const secret of [secretEmployee, secretB]) {
      for (const [, url] of readCases) {
        const response = await app.inject({ url, headers: { cookie: cookie(secret) } });
        expect(response.statusCode, url).toBe(403);
        expect(response.json().error.code).toBe("BROWSER_ACCESS_DENIED");
        expect(response.body).not.toContain("企业甲保密名称");
        expect(response.body).not.toContain("业务企业甲");
      }
    }
    const write = await app.inject({
      method: "PATCH",
      url: BASE + "/accounts/employee_a",
      headers: { cookie: cookie(secretB), origin, "x-csrf-token": csrfTokenForSecret(secretB) },
      payload: { expectedVersion: "7", clearance: 3, grants: [] }
    });
    expect(write.statusCode).toBe(403);
    expect(permissionsRepository.configureAccount).not.toHaveBeenCalled();
    expect(permissionsRepository.loadAuthorizationSnapshot).not.toHaveBeenCalled();
    expect(metadata.listEnterprises).not.toHaveBeenCalled();
  });

  it("requires a same-origin Origin and a matching CSRF token for writes", async () => {
    const { app, cookie, secretA, permissionsRepository } = await fixture();
    for (const headers of [
      { cookie: cookie(secretA) },
      {
        cookie: cookie(secretA),
        origin: "https://attacker.invalid",
        "x-csrf-token": csrfTokenForSecret(secretA)
      },
      { cookie: cookie(secretA), origin, "x-csrf-token": "wrong" }
    ]) {
      const response = await app.inject({
        method: "PATCH",
        url: BASE + "/accounts/employee_a",
        headers,
        payload: { expectedVersion: "7", clearance: 1, grants: [] }
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("BROWSER_SECURITY_CHECK_FAILED");
    }
    expect(permissionsRepository.configureAccount).not.toHaveBeenCalled();
  });

  it("parses every success response with its registered contract schema", async () => {
    const { app, writeHeaders, secretA } = await fixture();
    for (const [id, url] of readCases) {
      const response = await app.inject({
        url,
        headers: { cookie: writeHeaders(secretA).cookie }
      });
      expect(response.statusCode, id).toBe(200);
      expect(() => getWebApiRoute(id).response.parse(response.json()), id).not.toThrow();
    }
    for (const [id, method, url, payload] of writeCases) {
      const response = await app.inject({ method, url, headers: writeHeaders(secretA), payload });
      expect(response.statusCode, id).toBe(200);
      expect(() => getWebApiRoute(id).response.parse(response.json()), id).not.toThrow();
    }
  });

  it("keeps fixed-category initialization versioned and CSRF-guarded", async () => {
    const { app, secretA, writeHeaders, permissionsRepository } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: BASE + "/categories/initialize",
      headers: writeHeaders(secretA),
      payload: { expectedVersion: "7" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authorizationVersion: "8", value: { createdCount: 1 } });
    expect(permissionsRepository.initializeFixedCategories).toHaveBeenCalledExactlyOnceWith({
      orgId: "org_a",
      actorId: "admin_a",
      expectedVersion: "7"
    });
  });

  it("reports stale writes as 409 and keeps the requested shape", async () => {
    const { app, writeHeaders, secretA, permissionsRepository } = await fixture();
    permissionsRepository.configureAccount.mockRejectedValueOnce(
      new Error("AUTHORIZATION_VERSION_CONFLICT")
    );
    const response = await app.inject({
      method: "PATCH",
      url: BASE + "/accounts/employee_a",
      headers: writeHeaders(secretA),
      payload: { expectedVersion: "6", clearance: 1, grants: [] }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("AUTHORIZATION_VERSION_CONFLICT");
  });

  it("rejects a payload that does not match the contract and a malformed organization id", async () => {
    const { app, writeHeaders, secretA } = await fixture();
    const invalidBody = await app.inject({
      method: "PATCH",
      url: BASE + "/accounts/employee_a",
      headers: writeHeaders(secretA),
      payload: { expectedVersion: "7", clearance: 9, grants: [] }
    });
    expect(invalidBody.statusCode).toBe(400);
    expect(invalidBody.json().error.code).toBe("WEB_API_INVALID_REQUEST");
    const invalidOrg = await app.inject({
      url: "/api/web/v1/orgs/bad%20org/permissions/accounts",
      headers: { cookie: writeHeaders(secretA).cookie }
    });
    expect(invalidOrg.statusCode).toBe(400);
    expect(invalidOrg.json().error.code).toBe("WEB_API_INVALID_REQUEST");
  });

  it("rejects an evidence category update that targets a fixed category", async () => {
    const { app, writeHeaders, secretA } = await fixture();
    const response = await app.inject({
      method: "PATCH",
      url: BASE + "/categories/cat_business",
      headers: writeHeaders(secretA),
      payload: {
        expectedVersion: "7",
        name: "营业数据",
        ownerships: ["store"],
        requiredDimensionIds: []
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_PERMISSION_CONFIGURATION");
  });

  it("keeps the browser surface JSON-only: page and login routes are gone", async () => {
    const { app, cookie, secretA } = await fixture();
    for (const url of [
      "/admin/permissions/org_a",
      "/admin/permissions/org_a/login",
      "/admin/permissions/org_a/logout",
      "/admin/permissions/org_a/workflows",
      "/admin/permissions/org_a/workflows/business-a"
    ]) {
      const response = await app.inject({ url, headers: { cookie: cookie(secretA) } });
      expect(response.statusCode, url).toBe(404);
    }
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: "/admin/permissions/org_a/login",
        headers: { cookie: cookie(secretA), origin },
        payload: {}
      });
      expect(response.statusCode, method).toBe(404);
    }
  });
});

const workflowCases: Array<[string, string, Record<string, unknown>]> = [
  [
    "workflows.listEnterpriseWorkflows",
    "list_enterprise_workflows",
    { enterpriseKey: "business-a" }
  ],
  [
    "workflows.getEnterpriseWorkflow",
    "get_enterprise_workflow",
    { enterpriseKey: "business-a", workflowType: "weekly-business-report" }
  ],
  [
    "workflows.manageWorkflowInstallation",
    "manage_workflow_installation",
    {
      workflowId: "wf_1",
      operation: {
        kind: "record_checks",
        installationId: "install_1",
        checks: [],
        firstRunVerification: "not_run"
      }
    }
  ],
  [
    "workflows.manageWorkflowRun",
    "manage_workflow_run",
    {
      workflowId: "wf_1",
      operation: {
        kind: "check_actions",
        installationId: "install_1",
        runId: "run_1",
        assignmentEpoch: 1,
        controlVersion: 2,
        actions: [
          {
            actionId: "action_1",
            identity: {
              kind: "upload",
              storeNames: ["门店甲"],
              window: { startDate: "2026-10-26", endDate: "2026-10-26" },
              dataset: "business",
              sourceHash: "c".repeat(64),
              metadataHash: "d".repeat(64)
            }
          }
        ]
      }
    }
  ],
  [
    "workflows.recordWorkflowAction",
    "record_workflow_action",
    { workflowId: "wf_1", operation: { kind: "get", actionIds: ["action_1"] } }
  ],
  ["workflows.getWorkflowStatus", "get_workflow_status", { workflowId: "wf_1" }]
];

describe("browser workflow routes", () => {
  it("requires a browser session with write checks", async () => {
    const { app, cookie, secretA, workflows } = await fixture();
    for (const [, tool, payload] of workflowCases) {
      const url = WORKFLOW_BASE + "/" + tool;
      expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers: { cookie: cookie(secretA), origin },
            payload
          })
        ).statusCode
      ).toBe(403);
    }
    expect(workflows.execute).not.toHaveBeenCalled();
  });

  it("binds the URL organization to the session and parses every tool response", async () => {
    const { app, secretA, secretB, writeHeaders, workflows } = await fixture();
    for (const [id, tool, payload] of workflowCases) {
      const url = WORKFLOW_BASE + "/" + tool;
      const response = await app.inject({
        method: "POST",
        url,
        headers: writeHeaders(secretA),
        payload
      });
      expect(response.statusCode, id).toBe(200);
      expect(() => getWebApiRoute(id).response.parse(response.json()), id).not.toThrow();
      expect(workflows.execute).toHaveBeenCalledWith(
        tool,
        payload,
        expect.objectContaining({ id: "admin_a", orgId: "org_a" })
      );
    }
    const crossTenant = await app.inject({
      method: "POST",
      url: WORKFLOW_BASE + "/get_enterprise_workflow",
      headers: writeHeaders(secretB),
      payload: { enterpriseKey: "business-a", workflowType: "weekly-business-report" }
    });
    expect(crossTenant.statusCode).toBe(403);
    expect(crossTenant.json().error.code).toBe("BROWSER_ACCESS_DENIED");
  });

  it("maps workflow service errors onto their contract codes", async () => {
    const { app, writeHeaders, secretA, workflows } = await fixture();
    workflows.execute.mockRejectedValueOnce(new Error("WORKFLOW_VERSION_CONFLICT"));
    const conflict = await app.inject({
      method: "POST",
      url: WORKFLOW_BASE + "/get_workflow_status",
      headers: writeHeaders(secretA),
      payload: { workflowId: "wf_1" }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("WORKFLOW_VERSION_CONFLICT");
    workflows.execute.mockRejectedValueOnce(new Error("WORKFLOW_CONFIGURATION_REQUIRED"));
    const missing = await app.inject({
      method: "POST",
      url: WORKFLOW_BASE + "/get_workflow_status",
      headers: writeHeaders(secretA),
      payload: { workflowId: "wf_1" }
    });
    expect(missing.statusCode).toBe(404);
    workflows.execute.mockRejectedValueOnce(new Error("WORKFLOW_PERMISSION_DENIED"));
    const denied = await app.inject({
      method: "POST",
      url: WORKFLOW_BASE + "/get_workflow_status",
      headers: writeHeaders(secretA),
      payload: { workflowId: "wf_1" }
    });
    expect(denied.statusCode).toBe(403);
  });
});
