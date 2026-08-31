import { beforeEach, describe, expect, it, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { compileStructuredQuery, type AuthenticatedEmployee } from "@enterprise-hub/domain";
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

const baoliManagerEmployee: AuthenticatedEmployee = {
  id: "emp_baoli_manager",
  orgId: "default-org",
  email: "baoli.manager@example.com",
  role: "manager",
  disabled: false,
  labels: ["all_staff", "person:baoli.manager", "store:baoli"]
};

const labelLessEmployee: AuthenticatedEmployee = {
  id: "emp_label_less",
  orgId: "default-org",
  email: "label.less@example.com",
  role: "employee",
  disabled: false,
  labels: []
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
      employeeRepository: createRepository([baoliManagerEmployee]),
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/structured/datasets",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      limits: {
        defaultLimit: 50,
        maxRows: 200,
        maxAggregateGroups: 100,
        maxBooleanDepth: 3,
        maxConditions: 20,
        maxInValues: 100,
        maxSortFields: 2,
        maxGroupByFields: 1,
        maxAggregates: 5,
        maxSelectedFields: 50
      },
      datasets: expect.arrayContaining([
        expect.objectContaining({
          dataset: "dishes",
          registryVersion: "dishes.2026-07-11.v1",
          rowTable: "dish_rows",
          fields: expect.arrayContaining([
            expect.objectContaining({
              canonicalName: "business_date",
              sourceColumn: "营业日",
              type: "date",
              operators: ["eq", "between", "gte", "lte", "in"],
              capabilities: {
                filter: true,
                sort: true,
                group: true,
                aggregate: false
              },
              storage: {
                table: "dish_rows",
                column: "payload",
                jsonPath: "$.business_date"
              }
            })
          ])
        })
      ])
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
          matched_product_name: "肉夹馍",
          dish_sales_quantity: "12"
        }
      ],
      hasMore: true
    });
    app = buildApiServer({
      employeeRepository: createRepository([baoliManagerEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      },
      payload: {
        dataset: "dishes",
        registryVersion: "dishes.2026-07-11.v1",
        select: ["business_date", "matched_product_name", "dish_sales_quantity"],
        filter: {
          field: "matched_product_name",
          op: "contains",
          value: "肉夹馍"
        },
        sort: [{ field: "business_date", direction: "asc" }],
        page: { limit: 1 }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      dataset: "dishes",
      registryVersion: "dishes.2026-07-11.v1",
      mode: "detail",
      rows: [
        {
          business_date: "2026-07-01",
          matched_product_name: "肉夹馍",
          dish_sales_quantity: "12"
        }
      ],
      nextCursor: expect.any(String)
    });
    expect(structuredQueryRepository.calls).toHaveLength(1);
    expect(structuredQueryRepository.calls[0]).toMatchObject({
      authorizationScope: {
        orgId: "default-org",
        employee: {
          id: baoliManagerEmployee.id,
          role: baoliManagerEmployee.role,
          labels: baoliManagerEmployee.labels
        }
      }
    });
  });

  it("rejects invalid controlled-query input before repository execution", async () => {
    const structuredQueryRepository = createStructuredRepository({ rows: [], hasMore: false });
    app = buildApiServer({
      employeeRepository: createRepository([baoliManagerEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      },
      payload: {
        dataset: "dishes",
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
      employeeRepository: createRepository([baoliManagerEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      },
      payload: {
        dataset: "dishes",
        filter: {
          field: "matched_product_name",
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

  it("executes the all_staff scope for an employee with no labels", async () => {
    const structuredQueryRepository = createStructuredRepository({ rows: [], hasMore: false });
    app = buildApiServer({
      employeeRepository: createRepository([labelLessEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(labelLessEmployee)}`
      },
      payload: {
        dataset: "dishes",
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
      employeeRepository: createRepository([baoliManagerEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      },
      payload: {
        dataset: "dishes",
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
      employeeRepository: createRepository([baoliManagerEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      },
      payload: {
        dataset: "business",
        groupBy: ["business_date"],
        aggregates: [
          { op: "count", as: "row_count" },
          { op: "sum", field: "gross_sales_amount", as: "gross_sales" }
        ],
        page: { limit: 100 }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      dataset: "business",
      registryVersion: "business.2026-07-11.v1",
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

  it("rejects cursor query-shape changes before repository execution", async () => {
    const structuredQueryRepository = createStructuredRepository({
      rows: [{ business_date: "2026-07-01" }],
      hasMore: true
    });
    app = buildApiServer({
      employeeRepository: createRepository([baoliManagerEmployee]),
      structuredQueryRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });
    const accessToken = await accessTokenFor(baoliManagerEmployee);

    const firstPage = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: {
        authorization: `Bearer ${accessToken}`
      },
      payload: {
        dataset: "dishes",
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
        dataset: "dishes",
        select: ["matched_product_name"],
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
        role: "admin",
        labels: []
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
