import { describe, expect, it, vi } from "vitest";
import {
  cleanupPdfAcceptanceRun,
  createPdfAcceptanceManifest,
  validatePdfAcceptanceManifest,
  assertPdfInventory,
  parsePdfAcceptanceArgs,
  assertPdfCredentialProfile,
  type PdfAcceptanceDependencies,
  type PdfAcceptanceInventory
} from "./pdf-acceptance-support.js";

function fixture() {
  const manifest = createPdfAcceptanceManifest("test7");
  manifest.employeeIds = ["employee-a", "employee-b"];
  manifest.documentIds = ["doc-a"];
  manifest.objectKeys = [`org/${manifest.orgIds[0]}/documents/doc-a/original/test.pdf`];
  manifest.pointIds = ["point-a"];
  manifest.collection = "test_collection";
  const inventory: PdfAcceptanceInventory = {
    orgs: manifest.orgIds.map((id) => ({
      id,
      name: `PDF acceptance test7 ${id.endsWith("-a") ? "a" : "b"}`
    })),
    employees: [
      {
        id: "employee-a",
        orgId: manifest.orgIds[0]!,
        email: "manual-acceptance-pdf-test7-a-admin@example.invalid",
        role: "admin",
        clearance: 0
      },
      {
        id: "employee-b",
        orgId: manifest.orgIds[1]!,
        email: "manual-acceptance-pdf-test7-b-reader@example.invalid",
        role: "employee",
        clearance: 3
      }
    ],
    documents: [
      {
        id: "doc-a",
        orgId: manifest.orgIds[0]!,
        uploaderId: "employee-a",
        fileType: "pdf",
        sourceSystem: "pdf_acceptance_test7",
        storageObjectKey: manifest.objectKeys[0]!
      }
    ],
    attempts: [],
    points: [
      {
        id: "point-a",
        orgId: manifest.orgIds[0]!,
        documentId: "doc-a",
        collection: manifest.collection
      }
    ],
    objectKeys: [...manifest.objectKeys],
    unexpected: []
  };
  const dependencies: PdfAcceptanceDependencies = {
    inventory: vi.fn(async () => inventory),
    preventClaims: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    reconcile: vi.fn(async () => {}),
    deleteObjects: vi.fn(async () => {
      inventory.objectKeys = [];
    }),
    deletePoints: vi.fn(async () => {
      inventory.points = [];
    }),
    removeRows: vi.fn(async () => {
      inventory.orgs = [];
      inventory.employees = [];
      inventory.documents = [];
      inventory.attempts = [];
    }),
    save: vi.fn(async () => {})
  };
  return { manifest, inventory, dependencies };
}

describe("isolated PDF acceptance", () => {
  it.each([
    {},
    { runId: "x", orgIds: [] },
    { ...createPdfAcceptanceManifest("x"), orgIds: ["default-org", "pdf-acceptance-x-b"] }
  ])("rejects missing/default organizations", (value) => {
    expect(() => validatePdfAcceptanceManifest(value)).toThrow();
  });
  it("rejects absent organization records before mutation", async () => {
    const f = fixture();
    f.inventory.orgs = [];
    await expect(cleanupPdfAcceptanceRun(f.manifest, f.dependencies)).rejects.toThrow(/missing/i);
    expect(f.dependencies.preventClaims).not.toHaveBeenCalled();
  });
  it("rejects ambiguous file prefixes and forged ownership before any mutation", async () => {
    const f = fixture();
    f.manifest.objectKeys[0] += "*";
    await expect(cleanupPdfAcceptanceRun(f.manifest, f.dependencies)).rejects.toThrow();
    expect(f.dependencies.preventClaims).not.toHaveBeenCalled();
    const g = fixture();
    g.inventory.documents[0]!.orgId = "outside";
    await expect(cleanupPdfAcceptanceRun(g.manifest, g.dependencies)).rejects.toThrow(/ownership/i);
    expect(g.dependencies.preventClaims).not.toHaveBeenCalled();
  });
  it.each(["account", "object", "document", "point"])("rejects unregistered %s", (kind) => {
    const f = fixture();
    if (kind === "account")
      f.inventory.employees.push({ ...f.inventory.employees[0]!, id: "extra" });
    if (kind === "object")
      f.inventory.objectKeys.push(f.manifest.objectKeys[0]!.replace("test.pdf", "extra.pdf"));
    if (kind === "document")
      f.inventory.documents.push({ ...f.inventory.documents[0]!, id: "extra" });
    if (kind === "point") f.inventory.points.push({ ...f.inventory.points[0]!, id: "extra" });
    expect(() => assertPdfInventory(f.manifest, f.inventory)).toThrow(/unregistered/i);
  });
  it("saves exact resources before detaching and verifies no residue", async () => {
    const f = fixture();
    await expect(cleanupPdfAcceptanceRun(f.manifest, f.dependencies)).resolves.toMatchObject({
      documents: 0,
      storageObjects: 0,
      qdrantPoints: 0
    });
    expect(vi.mocked(f.dependencies.save).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.dependencies.detach).mock.invocationCallOrder[0] ?? 0
    );
  });
  it("retains recovery state on interrupted deletion and retries", async () => {
    const f = fixture();
    vi.mocked(f.dependencies.deleteObjects).mockRejectedValueOnce(new Error("unavailable"));
    await expect(cleanupPdfAcceptanceRun(f.manifest, f.dependencies)).rejects.toThrow(
      "unavailable"
    );
    expect(f.dependencies.removeRows).not.toHaveBeenCalled();
    await expect(cleanupPdfAcceptanceRun(f.manifest, f.dependencies)).resolves.toMatchObject({
      storageObjects: 0
    });
  });
  it("resumes after final DB removal when writing the completion receipt was interrupted", async () => {
    const f = fixture();
    f.manifest.attemptIds = ["confirmed"];
    f.inventory.attempts = [
      { id: "confirmed", orgId: f.manifest.orgIds[0]!, documentId: "doc-a", settled: true }
    ];
    vi.mocked(f.dependencies.save).mockImplementation(async (m) => {
      if (m.phase === "complete") throw new Error("receipt interrupted");
    });
    await expect(cleanupPdfAcceptanceRun(f.manifest, f.dependencies)).rejects.toThrow(
      "receipt interrupted"
    );
    f.manifest.phase = "cleanup";
    vi.mocked(f.dependencies.save).mockResolvedValue();
    await expect(cleanupPdfAcceptanceRun(f.manifest, f.dependencies)).resolves.toMatchObject({
      organizations: 0,
      attempts: 0
    });
  });
  it("does not delete final manifests for unknown late writes even after delete succeeds", async () => {
    const f = fixture();
    f.inventory.attempts = [
      { id: "attempt", orgId: f.manifest.orgIds[0]!, documentId: "doc-a", settled: false }
    ];
    f.manifest.attemptIds = ["attempt"];
    await expect(cleanupPdfAcceptanceRun(f.manifest, f.dependencies)).rejects.toThrow(
      /recovery required/i
    );
    expect(f.dependencies.removeRows).not.toHaveBeenCalled();
    f.inventory.objectKeys = [...f.manifest.objectKeys]; // late write lands
    await expect(cleanupPdfAcceptanceRun(f.manifest, f.dependencies)).rejects.toThrow(
      /recovery required/i
    );
    expect(f.inventory.objectKeys).toEqual([]);
  });
  it("rejects PDF routing without explicit manifest and named profile", () => {
    expect(() => parsePdfAcceptanceArgs(["--profile=pdf", "--run-id=x"])).toThrow();
    expect(() => parsePdfAcceptanceArgs(["--profile=unknown"])).toThrow();
    expect(() =>
      assertPdfCredentialProfile("x", "a-admin", { credentialProfile: "default" })
    ).toThrow();
    expect(() =>
      assertPdfCredentialProfile("x", "a-admin", {
        credentialProfile: "pdf-x-a-admin",
        serviceOrigin: "https://api.smedatacenter.xyz",
        launcherVersion: "0.7.0",
        ok: true
      })
    ).not.toThrow();
  });
});
