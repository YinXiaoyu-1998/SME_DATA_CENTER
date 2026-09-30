import { createHash } from "node:crypto";
import path from "node:path";

export type PdfAccount = "a-admin" | "a-reader" | "b-reader";
export const PDF_ACCOUNTS: PdfAccount[] = ["a-admin", "a-reader", "b-reader"];
export interface PdfAcceptanceManifest {
  schemaVersion: 1;
  runId: string;
  orgIds: [string, string];
  employeeIds: string[];
  documentIds: string[];
  pointIds: string[];
  objectKeys: string[];
  attemptIds: string[];
  collection: string;
  phase: "setup" | "registered" | "cleanup" | "complete";
  settledAttemptIds: string[];
}
export interface PdfAcceptanceInventory {
  orgs: Array<{ id: string; name: string }>;
  employees: Array<{ id: string; orgId: string; email: string; role: string; clearance: number }>;
  documents: Array<{
    id: string;
    orgId: string;
    uploaderId: string;
    fileType: string | null;
    sourceSystem: string | null;
    storageObjectKey: string;
  }>;
  attempts: Array<{ id: string; orgId: string; documentId: string; settled: boolean }>;
  points: Array<{ id: string; orgId: string; documentId: string; collection: string }>;
  objectKeys: string[];
  unexpected: string[];
}
export interface PdfCleanupCounts {
  organizations: number;
  employees: number;
  documents: number;
  attempts: number;
  storageObjects: number;
  qdrantPoints: number;
}
export interface PdfAcceptanceDependencies {
  inventory(): Promise<PdfAcceptanceInventory>;
  preventClaims(): Promise<void>;
  detach(): Promise<void>;
  reconcile(): Promise<void>;
  deleteObjects(keys: string[]): Promise<void>;
  deletePoints(ids: string[], collection: string): Promise<void>;
  removeRows(): Promise<void>;
  save(manifest: PdfAcceptanceManifest): Promise<void>;
}
export function createPdfAcceptanceManifest(runId: string): PdfAcceptanceManifest {
  assertRunId(runId);
  return {
    schemaVersion: 1,
    runId,
    orgIds: [`pdf-acceptance-${runId}-a`, `pdf-acceptance-${runId}-b`],
    employeeIds: [],
    documentIds: [],
    pointIds: [],
    objectKeys: [],
    attemptIds: [],
    settledAttemptIds: [],
    collection: "",
    phase: "setup"
  };
}
function assertRunId(runId: string) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(runId))
    throw new Error("PDF acceptance requires a safe explicit run ID (1–32 characters).");
}
export function pdfAccountEmail(runId: string, account: PdfAccount) {
  assertRunId(runId);
  return `manual-acceptance-pdf-${runId}-${account}@example.invalid`;
}
export function pdfObjectPrefixes(orgIds: string[]): string[] {
  return orgIds.flatMap((id) => [
    `org/${id}/`,
    `org/${createHash("sha256").update(id).digest("hex")}/`
  ]);
}
export function validatePdfAcceptanceManifest(value: unknown): PdfAcceptanceManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid PDF acceptance manifest.");
  const m = value as PdfAcceptanceManifest;
  if (typeof m.runId !== "string") throw new Error("Missing PDF run ID.");
  const expected = createPdfAcceptanceManifest(m.runId);
  const allowed = new Set(Object.keys(expected));
  if (
    Object.keys(m).some((k) => !allowed.has(k)) ||
    m.schemaVersion !== 1 ||
    JSON.stringify(m.orgIds) !== JSON.stringify(expected.orgIds)
  )
    throw new Error(
      "PDF acceptance requires its two dedicated organizations; default-org is forbidden."
    );
  for (const key of [
    "employeeIds",
    "documentIds",
    "pointIds",
    "objectKeys",
    "attemptIds",
    "settledAttemptIds"
  ] as const) {
    const list = m[key];
    if (
      !Array.isArray(list) ||
      list.length > 10000 ||
      new Set(list).size !== list.length ||
      !list.every(
        (v) =>
          typeof v === "string" && v.length > 0 && v.length <= (key === "objectKeys" ? 1024 : 128)
      )
    )
      throw new Error(`Invalid PDF manifest ${key}.`);
  }
  if (
    typeof m.collection !== "string" ||
    m.collection.length > 255 ||
    !["setup", "registered", "cleanup", "complete"].includes(m.phase) ||
    m.settledAttemptIds.some((id) => !m.attemptIds.includes(id))
  )
    throw new Error("Invalid PDF manifest state.");
  for (const key of m.objectKeys) {
    const segments = key.split("/");
    if (
      key.includes("\\") ||
      key.includes("*") ||
      key.includes("?") ||
      path.isAbsolute(key) ||
      segments.some((s) => ["", ".", ".."].includes(s)) ||
      !pdfObjectPrefixes(m.orgIds).some((prefix) => key.startsWith(prefix))
    )
      throw new Error("Invalid exact PDF object ownership; prefixes are not deletion selectors.");
  }
  return m;
}
export function assertPdfInventory(m: PdfAcceptanceManifest, i: PdfAcceptanceInventory) {
  validatePdfAcceptanceManifest(m);
  if (i.unexpected.length)
    throw new Error("Unregistered organization resources; PDF cleanup refused.");
  if (!["cleanup", "complete"].includes(m.phase) && i.orgs.length !== 2) {
    throw new Error("Missing dedicated PDF organizations; cleanup ownership unavailable.");
  }
  if (i.orgs.length === 1) throw new Error("Missing dedicated PDF organization.");
  for (const org of i.orgs) {
    if (
      !m.orgIds.includes(org.id) ||
      org.name !== `PDF acceptance ${m.runId} ${org.id.endsWith("-a") ? "a" : "b"}`
    )
      throw new Error("PDF organization ownership does not match.");
  }
  for (const employee of i.employees) {
    const account = PDF_ACCOUNTS.find((a) => employee.email === pdfAccountEmail(m.runId, a));
    if (!m.employeeIds.includes(employee.id)) throw new Error("Unregistered PDF account.");
    if (
      !account ||
      employee.orgId !== m.orgIds[account.startsWith("a-") ? 0 : 1] ||
      employee.role !== (account === "a-admin" ? "admin" : "employee") ||
      employee.clearance !== (account === "a-admin" ? 0 : 3)
    )
      throw new Error("PDF employee ownership does not match.");
  }
  for (const doc of i.documents) {
    if (!m.documentIds.includes(doc.id)) throw new Error("Unregistered PDF document.");
    if (
      !m.orgIds.includes(doc.orgId) ||
      !m.employeeIds.includes(doc.uploaderId) ||
      doc.fileType !== "pdf" ||
      doc.sourceSystem !== `pdf_acceptance_${m.runId}` ||
      !m.objectKeys.includes(doc.storageObjectKey)
    )
      throw new Error("PDF document ownership does not match.");
  }
  for (const attempt of i.attempts) {
    if (!m.attemptIds.includes(attempt.id)) throw new Error("Unregistered PDF attempt.");
    if (!m.orgIds.includes(attempt.orgId) || !m.documentIds.includes(attempt.documentId))
      throw new Error("PDF attempt ownership does not match.");
  }
  for (const point of i.points) {
    if (!m.pointIds.includes(point.id)) throw new Error("Unregistered PDF point.");
    if (
      !m.orgIds.includes(point.orgId) ||
      !m.documentIds.includes(point.documentId) ||
      point.collection !== m.collection
    )
      throw new Error("PDF point ownership does not match.");
  }
  if (i.objectKeys.some((key) => !m.objectKeys.includes(key)))
    throw new Error("Unregistered PDF storage object.");
}
export async function cleanupPdfAcceptanceRun(
  value: PdfAcceptanceManifest,
  d: PdfAcceptanceDependencies
): Promise<PdfCleanupCounts> {
  const m = validatePdfAcceptanceManifest(value);
  let inventory = await d.inventory();
  assertPdfInventory(m, inventory);
  // A committed final DB removal may precede a lost completion receipt. Re-inventory
  // all exact external IDs and dedicated orgs; unknown attempts retain DB rows and
  // therefore cannot enter this already-empty recovery path.
  if (
    ["cleanup", "complete"].includes(m.phase) &&
    inventory.orgs.length === 0 &&
    inventory.employees.length === 0 &&
    inventory.documents.length === 0 &&
    inventory.attempts.length === 0 &&
    inventory.objectKeys.length === 0 &&
    inventory.points.length === 0
  ) {
    m.phase = "complete";
    await d.save(m);
    return {
      organizations: 0,
      employees: 0,
      documents: 0,
      attempts: 0,
      storageObjects: 0,
      qdrantPoints: 0
    };
  }
  await d.preventClaims(); // Only this run; running/ambiguous workers must not be declared settled.
  inventory = await d.inventory();
  assertPdfInventory(m, inventory);
  m.settledAttemptIds = [
    ...new Set([
      ...m.settledAttemptIds,
      ...inventory.attempts.filter((a) => a.settled).map((a) => a.id)
    ])
  ];
  m.phase = "cleanup";
  await d.save(m); // Persist before removing authoritative index references.
  await d.detach();
  await d.reconcile();
  await d.deletePoints(m.pointIds, m.collection);
  await d.deleteObjects(m.objectKeys);
  inventory = await d.inventory();
  assertPdfInventory(m, inventory);
  if (inventory.objectKeys.length || inventory.points.length)
    throw new Error("PDF cleanup left external residue; recovery required.");
  if (
    inventory.attempts.some((a) => !a.settled) ||
    m.attemptIds.some((id) => !inventory.attempts.some((a) => a.id === id && a.settled))
  )
    throw new Error(
      "PDF cleanup recovery required: unknown late writes remain possible; retain attempt records and private manifest."
    );
  await d.removeRows();
  inventory = await d.inventory();
  assertPdfInventory(m, inventory);
  const counts = {
    organizations: inventory.orgs.length,
    employees: inventory.employees.length,
    documents: inventory.documents.length,
    attempts: inventory.attempts.length,
    storageObjects: inventory.objectKeys.length,
    qdrantPoints: inventory.points.length
  };
  if (Object.values(counts).some((n) => n !== 0))
    throw new Error("PDF cleanup left residue; recovery required.");
  m.phase = "complete";
  await d.save(m);
  return counts;
}
export interface PdfAcceptanceArgs {
  command: "setup" | "register" | "verify" | "cleanup";
  runId: string;
  manifestPath: string;
  documentId?: string;
}
export function parsePdfAcceptanceArgs(args: string[]): PdfAcceptanceArgs | null {
  if (!args.some((a) => a.startsWith("--profile"))) return null;
  const options = new Map<string, string>();
  let command = "verify";
  for (const arg of args) {
    if (!arg.startsWith("--")) {
      if (["setup", "register", "verify", "cleanup"].includes(arg) && command === "verify") {
        command = arg;
        continue;
      }
      throw new Error("Invalid PDF acceptance command.");
    }
    const match = /^(--[^=]+)=(.+)$/.exec(arg);
    if (
      !match ||
      !["--profile", "--run-id", "--manifest", "--document-id"].includes(match[1]!) ||
      options.has(match[1]!)
    )
      throw new Error("Invalid PDF acceptance option.");
    options.set(match[1]!, match[2]!);
  }
  if (options.get("--profile") !== "pdf")
    throw new Error("Unknown acceptance profile; no legacy fallback.");
  const runId = options.get("--run-id") ?? "";
  assertRunId(runId);
  const manifestPath = options.get("--manifest") ?? "";
  if (!path.isAbsolute(manifestPath))
    throw new Error("PDF acceptance requires an explicit absolute private manifest path.");
  if (command === "register" && !options.get("--document-id"))
    throw new Error("Register requires an exact returned document ID.");
  return {
    command: command as PdfAcceptanceArgs["command"],
    runId,
    manifestPath,
    ...(options.get("--document-id") ? { documentId: options.get("--document-id")! } : {})
  };
}
export function assertPdfCredentialProfile(runId: string, account: PdfAccount, check: unknown) {
  const c = check as Record<string, unknown> | null;
  if (
    !c ||
    c["credentialProfile"] !== `pdf-${runId}-${account}` ||
    c["serviceOrigin"] !== "https://api.smedatacenter.xyz" ||
    c["ok"] !== true ||
    typeof c["launcherVersion"] !== "string" ||
    !/^0\.(?:[7-9]|[1-9]\d+)\.\d+$/.test(c["launcherVersion"])
  )
    throw new Error(
      "PDF acceptance requires a verified compatible launcher with this task's dedicated credential profile."
    );
}
