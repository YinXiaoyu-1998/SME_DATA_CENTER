import type { Prisma } from "@prisma/client";
import { ResourceAttributesError } from "./business-authorization.js";
import { resolveFormalStore } from "./formal-store-directory.js";

interface FormalStoreInputLocation {
  field: string;
  rowNumber?: number;
  index?: number;
  receiptId?: string;
}

export class FormalStoreIntakeError extends ResourceAttributesError {
  readonly details: FormalStoreInputLocation & { storeName: string | null };

  constructor(
    code:
      | "FORMAL_STORE_NAME_INVALID"
      | "RESOURCE_DIRECTORY_RETIRED"
      | "PARTITION_STORE_IDENTITY_CONFLICT",
    submittedName: unknown,
    location: FormalStoreInputLocation
  ) {
    super(code);
    const storeName =
      typeof submittedName !== "string"
        ? null
        : submittedName.length <= 255
          ? submittedName
          : `${submittedName.slice(0, 255)}…`;
    this.details = { ...location, storeName };
    const position = location.receiptId
      ? `receipt ${JSON.stringify(location.receiptId.slice(0, 255))} `
      : location.rowNumber === undefined
        ? ""
        : `row ${location.rowNumber} `;
    const reason =
      code === "RESOURCE_DIRECTORY_RETIRED"
        ? "The store is retired. Use the authorized historical supplement procedure."
        : code === "PARTITION_STORE_IDENTITY_CONFLICT"
          ? "The source merchant and the existing partition belong to different store identities."
          : "Enter an exact, confirmed formal store name for this enterprise.";
    this.message = `${position}${location.field} ${JSON.stringify(storeName)}. ${reason}`;
  }
}

export async function requireFormalStoreForIntake(
  tx: Prisma.TransactionClient,
  input: {
    orgId: string;
    enterpriseKey: string;
    name: unknown;
    historicalSupplement?: boolean;
    location: FormalStoreInputLocation;
  }
) {
  const store =
    typeof input.name === "string" && input.name.length <= 255 && input.enterpriseKey
      ? await resolveFormalStore(tx, { ...input, name: input.name })
      : null;
  if (!store)
    throw new FormalStoreIntakeError("FORMAL_STORE_NAME_INVALID", input.name, input.location);
  if (store.retired && !input.historicalSupplement)
    throw new FormalStoreIntakeError("RESOURCE_DIRECTORY_RETIRED", input.name, input.location);
  return store;
}
