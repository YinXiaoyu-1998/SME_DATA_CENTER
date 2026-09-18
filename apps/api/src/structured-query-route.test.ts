import { beforeEach, describe, expect, it, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { compileStructuredQuery, type AuthenticatedEmployee } from "@smedc/domain";
import { buildApiServer } from "./server.js";
import type { EmployeeRepository } from "./employees.js";
import type {
  ExecuteStructuredQueryResult,
  StructuredQueryRepository
} from "./structured-query.js";
import { createPrismaStructuredQueryRepository } from "./structured-query.js";

const prisma = vi.hoisted(() => ({
  $queryRawUnsafe: vi.fn(),
  $disconnect: vi.fn()
}));

vi.mock("@prisma/adapter-mariadb", () => ({
  PrismaMariaDb: class PrismaMariaDb {}
}));

vi.mock("@prisma/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@prisma/client")>();

  return {
    ...original,
    PrismaClient: class PrismaClient {
      constructor() {
        return prisma;
      }
    }
  };
});

const jwtSecret = "test-local-jwt-secret";
const officialTestTokens = new Map<string, AuthenticatedEmployee>();

async function authenticateTestAccessToken(token: string) {
  return officialTestTokens.get(token) ?? null;
}

const baoliEmployee: AuthenticatedEmployee = {
  id: "emp_baoli_employee",
  orgId: "default-org",
  organizationName: "Default Organization",
  displayName: "Baoli Employee",
  email: "baoli.employee@example.com",
  role: "employee",
  clearance: 1,
  disabled: false
};

const clearanceZeroEmployee: AuthenticatedEmployee = {
  id: "emp_clearance_zero",
  orgId: "default-org",
  organizationName: "Default Organization",
  displayName: "Clearance Zero Employee",
  email: "clearance.zero@example.com",
  role: "employee",
  clearance: 0,
  disabled: false
};

function createRepository(employees: AuthenticatedEmployee[]): EmployeeRepository {
  return {
    async findByEmail(email: string) {
      return employees.find((employee) => employee.email === email) ?? null;
    },
    async findById(id: string) {
      return employees.find((employee) => employee.id === id) ?? null;
    }
  };
}

async function accessTokenFor(employee: AuthenticatedEmployee) {
  const token = `eh_at_test_${employee.id}`;
  officialTestTokens.set(token, employee);
  return token;
}

describe("structured dataset discovery", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("lists registry-backed datasets and effective query limits for authenticated callers", async () => {
    app = buildApiServer({
      employeeRepository: createRepository([baoliEmployee]),
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/structured/datasets",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliEmployee)}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      limits: {
        defaultLimit: 50,
        maxRows: 200,
        maxAggregateGroups: 200,
        maxBooleanDepth: 3,
        maxConditions: 20,
        maxInValues: 100,
        maxSortFields: 2,
        maxGroupByFields: 4,
        maxAggregates: 12,
        maxSelectedFields: 50
      },
      datasets: expect.arrayContaining([
        expect.objectContaining({ dataset: "dishes", accessMode: "partition_extract" }),
        expect.objectContaining({ dataset: "business", accessMode: "partition_extract" }),
        expect.objectContaining({ dataset: "vip", accessMode: "row_query", rowTable: "vip_rows" })
      ])
    });
    const dishes = response
      .json()
      .datasets.find((dataset: { dataset: string }) => dataset.dataset === "dishes");
    expect(dishes).not.toHaveProperty("rowTable");
    const ledger = response
      .json()
      .datasets.find((dataset: { dataset: string }) => dataset.dataset === "delivery_ledger");
    expect(ledger?.presentation).toEqual({
      id: "food-purchase-ledger-cn-v2",
      title: "食品经营单位进货台帐",
      columns: [
        { canonicalName: "receipt_id", displayName: "收货单号" },
        { canonicalName: "item_name", displayName: "食品名称" },
        { canonicalName: "specification", displayName: "规格" },
        { canonicalName: "purchase_quantity", displayName: "进货数量" },
        { canonicalName: "purchase_amount", displayName: "进货金额" },
        { canonicalName: "production_date_or_batch", displayName: "生产日期或生产批号" },
        { canonicalName: "shelf_life", displayName: "保质期" },
        { canonicalName: "supplier_name", displayName: "供货单位名称" },
        { canonicalName: "supplier_unit_address", displayName: "供货单位地址" },
        { canonicalName: "supplier_contact_phone", displayName: "供货单位联系方式" },
        { canonicalName: "purchase_date", displayName: "进货日期" }
      ]
    });
  });
});

describe("structured query API", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function createStructuredRepository(
    result: ExecuteStructuredQueryResult
  ): StructuredQueryRepository & { calls: unknown[] } {
    const calls: unknown[] = [];

    return {
      calls,
      async execute(compiled) {
        calls.push(compiled);
        return result;
      }
    };
  }

  it("executes a valid controlled query and returns an opaque next cursor", async () => {
    const structuredQueryRepository = createStructuredRepository({
      rows: [
        {
          business_date: "2026-07-01",
          member_id: "肉夹馍",
          member_phone: "12"
        }
      ],
      hasMore: true
    });
    app = buildApiServer({
      employeeRepository: createRepository([baoliEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliEmployee)}`
      },
      payload: {
        dataset: "vip",
        select: ["business_date", "member_id", "member_phone"],
        filter: {
          field: "member_id",
          op: "contains",
          value: "肉夹馍"
        },
        sort: [{ field: "business_date", direction: "asc" }],
        page: { limit: 1 }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      dataset: "vip",
      mode: "detail",
      rows: [
        {
          business_date: "2026-07-01",
          member_id: "肉夹馍",
          member_phone: "12"
        }
      ],
      nextCursor: expect.any(String)
    });
    expect(structuredQueryRepository.calls).toHaveLength(1);
    expect(structuredQueryRepository.calls[0]).toMatchObject({
      authorizationScope: {
        orgId: "default-org",
        employee: {
          id: baoliEmployee.id,
          clearance: baoliEmployee.clearance
        }
      }
    });
  });

  it("rejects invalid controlled-query input before repository execution", async () => {
    const structuredQueryRepository = createStructuredRepository({ rows: [], hasMore: false });
    app = buildApiServer({
      employeeRepository: createRepository([baoliEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliEmployee)}`
      },
      payload: {
        dataset: "vip",
        rawSql: "select * from dish_rows"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "INVALID_QUERY",
        retryable: false,
        requestId: expect.any(String)
      }
    });
    expect(structuredQueryRepository.calls).toHaveLength(0);
  });

  it("rejects structured string scalars larger than an imported cell", async () => {
    const structuredQueryRepository = createStructuredRepository({ rows: [], hasMore: false });
    app = buildApiServer({
      employeeRepository: createRepository([baoliEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliEmployee)}`
      },
      payload: {
        dataset: "vip",
        filter: {
          field: "member_id",
          op: "contains",
          value: "v".repeat(32_768)
        }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "LIMIT_EXCEEDED",
        requestId: expect.any(String)
      }
    });
    expect(structuredQueryRepository.calls).toHaveLength(0);
  });

  it("executes the level-zero scope for a clearance-zero employee", async () => {
    const structuredQueryRepository = createStructuredRepository({ rows: [], hasMore: false });
    app = buildApiServer({
      employeeRepository: createRepository([clearanceZeroEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(clearanceZeroEmployee)}`
      },
      payload: {
        dataset: "vip",
        select: ["business_date"]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ rows: [], nextCursor: null });
    expect(structuredQueryRepository.calls).toHaveLength(1);
  });

  it("returns an empty 200 response when no authorized rows are visible", async () => {
    const structuredQueryRepository = createStructuredRepository({ rows: [], hasMore: false });
    app = buildApiServer({
      employeeRepository: createRepository([baoliEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliEmployee)}`
      },
      payload: {
        dataset: "vip",
        select: ["business_date"]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      rows: [],
      nextCursor: null
    });
  });

  it("returns explicit mechanical aggregate rows without analysis text", async () => {
    const structuredQueryRepository = createStructuredRepository({
      rows: [
        {
          business_date: "2026-07-01",
          row_count: 2,
          gross_sales: "128.50"
        }
      ],
      hasMore: false
    });
    app = buildApiServer({
      employeeRepository: createRepository([baoliEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliEmployee)}`
      },
      payload: {
        dataset: "vip",
        groupBy: ["business_date"],
        aggregates: [
          { op: "count", as: "row_count" },
          { op: "sum", field: "recharge_consumption_amount_total", as: "gross_sales" }
        ],
        page: { limit: 100 }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      dataset: "vip",
      mode: "aggregate",
      rows: [
        {
          business_date: "2026-07-01",
          row_count: 2,
          gross_sales: "128.50"
        }
      ],
      nextCursor: null
    });
    expect(JSON.stringify(response.json())).not.toMatch(/analysis|trend|summary|insight/i);
  });

  it("returns the food-purchase ledger presentation for delivery-ledger detail queries", async () => {
    const structuredQueryRepository = createStructuredRepository({
      rows: [
        {
          item_name: "冻品",
          purchase_date: "2026-09-16"
        }
      ],
      hasMore: false
    });
    app = buildApiServer({
      employeeRepository: createRepository([baoliEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliEmployee)}`
      },
      payload: {
        dataset: "delivery_ledger",
        select: ["item_name", "purchase_date"],
        page: { limit: 1 }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      dataset: "delivery_ledger",
      mode: "detail",
      presentation: {
        id: "food-purchase-ledger-cn-v2",
        title: "食品经营单位进货台帐"
      }
    });
    expect(response.json().presentation.columns).toEqual([
      { canonicalName: "receipt_id", displayName: "收货单号" },
      { canonicalName: "item_name", displayName: "食品名称" },
      { canonicalName: "specification", displayName: "规格" },
      { canonicalName: "purchase_quantity", displayName: "进货数量" },
      { canonicalName: "purchase_amount", displayName: "进货金额" },
      { canonicalName: "production_date_or_batch", displayName: "生产日期或生产批号" },
      { canonicalName: "shelf_life", displayName: "保质期" },
      { canonicalName: "supplier_name", displayName: "供货单位名称" },
      { canonicalName: "supplier_unit_address", displayName: "供货单位地址" },
      { canonicalName: "supplier_contact_phone", displayName: "供货单位联系方式" },
      { canonicalName: "purchase_date", displayName: "进货日期" }
    ]);
  });

  it("omits presentation metadata from aggregate query results", async () => {
    const structuredQueryRepository = createStructuredRepository({
      rows: [{ supplier_name: "Supplier A", rows: 2 }],
      hasMore: false
    });
    app = buildApiServer({
      employeeRepository: createRepository([baoliEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliEmployee)}`
      },
      payload: {
        dataset: "delivery_ledger",
        groupBy: ["supplier_name"],
        aggregates: [{ op: "count", as: "rows" }],
        page: { limit: 1 }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      dataset: "delivery_ledger",
      mode: "aggregate",
      rows: [{ supplier_name: "Supplier A", rows: 2 }],
      nextCursor: null
    });
  });

  it("preserves the enriched generic aggregate query body through the HTTP route", async () => {
    const structuredQueryRepository = createStructuredRepository({
      rows: [
        {
          store_name: "Baoli",
          payment_method: "dine-in",
          member_card_level_name: "lunch",
          business_date: "2026-07-01",
          revenue: "256.00",
          weighted_discount: "0.125"
        }
      ],
      hasMore: false
    });
    app = buildApiServer({
      employeeRepository: createRepository([baoliEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliEmployee)}`
      },
      payload: {
        dataset: "vip",
        groupBy: ["store_name", "payment_method", "member_card_level_name", "business_date"],
        aggregates: [
          { op: "sum", field: "recharge_consumption_amount_total", as: "revenue" },
          {
            op: "weightedAvg",
            field: "net_recharge_consumption_amount_total",
            weightField: "recharge_consumption_amount_total",
            as: "weighted_discount"
          }
        ],
        sort: [{ field: "weighted_discount", direction: "desc" }],
        page: { limit: 200 }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      dataset: "vip",
      mode: "aggregate",
      rows: [
        {
          store_name: "Baoli",
          payment_method: "dine-in",
          member_card_level_name: "lunch",
          business_date: "2026-07-01",
          revenue: "256.00",
          weighted_discount: "0.125"
        }
      ],
      nextCursor: null
    });
    expect(structuredQueryRepository.calls).toHaveLength(1);
    expect(structuredQueryRepository.calls[0]).toMatchObject({
      dataset: "vip",
      mode: "aggregate",
      limit: 200,
      selectedFields: [
        "store_name",
        "payment_method",
        "member_card_level_name",
        "business_date",
        "revenue",
        "weighted_discount"
      ],
      aggregateAliases: ["revenue", "weighted_discount"]
    });
    const compiledSql = String((structuredQueryRepository.calls[0] as { sql?: unknown }).sql ?? "");
    expect(compiledSql).toContain("SUM(");
    expect(compiledSql).toContain("NULLIF(SUM(");
    expect(compiledSql).toContain("GROUP BY");
    expect(compiledSql).toContain("ORDER BY `weighted_discount` DESC");
  });

  it("rejects cursor query-shape changes before repository execution", async () => {
    const structuredQueryRepository = createStructuredRepository({
      rows: [{ business_date: "2026-07-01" }],
      hasMore: true
    });
    app = buildApiServer({
      employeeRepository: createRepository([baoliEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });
    const accessToken = await accessTokenFor(baoliEmployee);

    const firstPage = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${accessToken}`
      },
      payload: {
        dataset: "vip",
        select: ["business_date"],
        page: { limit: 1 }
      }
    });
    const cursor = firstPage.json().nextCursor;
    structuredQueryRepository.calls.length = 0;

    const changedShape = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${accessToken}`
      },
      payload: {
        dataset: "vip",
        select: ["member_id"],
        page: { limit: 1, cursor }
      }
    });

    expect(changedShape.statusCode).toBe(400);
    expect(changedShape.json()).toMatchObject({
      error: {
        code: "INVALID_CURSOR"
      }
    });
    expect(structuredQueryRepository.calls).toHaveLength(0);
  });
});

describe("structured query supplier enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function compiledDeliveryQuery(
    select = ["receipt_id", "supplier_name", "supplier_contact_phone", "supplier_unit_address"]
  ) {
    return compileStructuredQuery({
      orgId: "default-org",
      employee: {
        id: "emp_admin",
        clearance: 3
      },
      query: { dataset: "delivery_ledger", select },
      cursorSecret: jwtSecret
    });
  }

  async function executeEnrichedQuery(input: {
    select?: string[];
    latest?: { id: string; source_document_id: string } | null;
    catalogRows?: Array<Record<string, unknown>>;
    baseRows?: Array<Record<string, unknown>>;
  }) {
    const repository = createPrismaStructuredQueryRepository("mysql://test");
    const select = input.select ?? [
      "receipt_id",
      "supplier_name",
      "supplier_contact_phone",
      "supplier_unit_address"
    ];
    const baseRow: Record<string, unknown> = {
      receipt_id: "R-1",
      structured_query_supplier_name: "Supplier A"
    };
    if (select.includes("supplier_name")) {
      baseRow.supplier_name = "Supplier A";
    }
    const compiled = compiledDeliveryQuery(select);
    prisma.$queryRawUnsafe.mockResolvedValueOnce(input.baseRows ?? [baseRow]);
    prisma.$queryRawUnsafe.mockResolvedValueOnce(input.latest ? [input.latest] : []);
    if (input.latest) {
      prisma.$queryRawUnsafe.mockResolvedValueOnce(input.catalogRows ?? []);
    }

    return {
      result: await repository.execute(compiled),
      calls: prisma.$queryRawUnsafe.mock.calls as Array<[string, ...unknown[]]>
    };
  }

  it("enriches an admin page from the unique current catalog match", async () => {
    const { result, calls } = await executeEnrichedQuery({
      latest: { id: "batch_current", source_document_id: "doc_current" },
      catalogRows: [
        { supplier_name: "Supplier A", contact_phone: "13800138000", unit_address: "Address A" }
      ]
    });

    expect(result).toEqual({
      rows: [
        {
          receipt_id: "R-1",
          supplier_name: "Supplier A",
          supplier_contact_phone: "13800138000",
          supplier_unit_address: "Address A"
        }
      ],
      hasMore: false
    });
    expect(calls).toHaveLength(3);
    expect(calls[1]?.[0]).not.toContain("document_labels");
    expect(calls[2]?.[0]).toContain("IN (?)");
  });

  it("preserves interleaved stored and dynamic select order and omits unrequested fields", async () => {
    const { result } = await executeEnrichedQuery({
      select: ["supplier_contact_phone", "receipt_id", "supplier_unit_address", "supplier_name"],
      baseRows: [
        {
          structured_query_supplier_name: "Supplier A",
          receipt_id: "R-1",
          supplier_name: "Supplier A",
          item_name: "not selected"
        }
      ],
      latest: { id: "batch_current", source_document_id: "doc_current" },
      catalogRows: [{ supplier_name: "Supplier A", contact_phone: "138", unit_address: "Address" }]
    });

    expect(Object.keys(result.rows[0]!)).toEqual([
      "supplier_contact_phone",
      "receipt_id",
      "supplier_unit_address",
      "supplier_name"
    ]);
    expect(result.rows[0]).not.toHaveProperty("item_name");
  });

  it("returns null dynamic values when no current catalog exists", async () => {
    const { result, calls } = await executeEnrichedQuery({ latest: null });

    expect(result.rows[0]).toEqual({
      receipt_id: "R-1",
      supplier_name: "Supplier A",
      supplier_contact_phone: null,
      supplier_unit_address: null
    });
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["supplier_contact_phone", { contact_phone: "   " }, { supplier_contact_phone: null }],
    ["supplier_unit_address", { unit_address: "" }, { supplier_unit_address: null }]
  ])("returns null for a blank %s", async (field, catalogRow, expected) => {
    const { result } = await executeEnrichedQuery({
      select: ["receipt_id", field],
      latest: { id: "batch_current", source_document_id: "doc_current" },
      catalogRows: [{ supplier_name: "Supplier A", ...catalogRow }]
    });

    expect(result.rows[0]).toEqual({ receipt_id: "R-1", ...expected });
  });

  it("returns null when the current catalog has no matching supplier", async () => {
    const { result } = await executeEnrichedQuery({
      latest: { id: "batch_current", source_document_id: "doc_current" },
      catalogRows: [{ supplier_name: "Supplier B", contact_phone: "138", unit_address: "Address" }]
    });

    expect(result.rows[0]).toMatchObject({
      supplier_contact_phone: null,
      supplier_unit_address: null
    });
  });

  it("returns null when the current catalog has an ambiguous supplier name", async () => {
    const { result } = await executeEnrichedQuery({
      latest: { id: "batch_current", source_document_id: "doc_current" },
      catalogRows: [
        { supplier_name: "Supplier A", contact_phone: "138", unit_address: "Address 1" },
        { supplier_name: "Supplier A", contact_phone: "139", unit_address: "Address 2" }
      ]
    });

    expect(result.rows[0]).toMatchObject({
      supplier_contact_phone: null,
      supplier_unit_address: null
    });
  });
});
