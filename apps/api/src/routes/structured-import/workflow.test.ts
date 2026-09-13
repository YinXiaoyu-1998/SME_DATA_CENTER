import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOriginalObjectKey } from "@enterprise-hub/storage";
import {
  canonicalStructuredImportFileName,
  structuredImportFingerprint,
  validateStructuredImportMetadata
} from "./workflow.js";

describe("structured import workflow metadata", () => {
  it("uses one normalized snapshotDate in the catalog fingerprint and canonical filename", () => {
    const input = {
      dataset: "dish_catalog" as const,
      enterpriseName: "Maijia",
      snapshotDate: "20260819",
      confidentialityLevel: 0,
      fileHash: "file-hash"
    };
    const expectedFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          dataset: "dish_catalog",
          enterpriseName: "Maijia",
          snapshotDate: "20260819",
          confidentialityLevel: 0,
          fileHash: "file-hash"
        })
      )
      .digest("hex");

    expect(structuredImportFingerprint(input)).toBe(expectedFingerprint);
    expect(
      canonicalStructuredImportFileName({
        dataset: "dish_catalog",
        enterpriseName: "Maijia",
        snapshotDate: "20260819",
        fileType: "xlsx"
      })
    ).toBe("m_a_i_j_i_a_dish_catalog_20260819.xlsx");
  });

  it.each(["delivery_ledger", "supplier_catalog"] as const)(
    "accepts %s without date metadata",
    (dataset) => {
      expect(
        validateStructuredImportMetadata({
          dataset,
          enterpriseName: "Maijia",
          idempotencyKey: "stable-key",
          confidentialityLevel: "0",
          confidentialityLevelFieldCount: 1,
          file: { fileName: `${dataset}.csv`, body: Buffer.from("synthetic") }
        })
      ).toMatchObject({
        ok: true,
        dataset,
        startDate: null,
        endDate: null
      });
    }
  );

  it.each(["startDate", "endDate", "snapshotDate"] as const)(
    "rejects %s for delivery and supplier uploads",
    (dateField) => {
      for (const dataset of ["delivery_ledger", "supplier_catalog"] as const) {
        const upload = {
          dataset,
          enterpriseName: "Maijia",
          idempotencyKey: `${dataset}-${dateField}`,
          confidentialityLevel: "0",
          confidentialityLevelFieldCount: 1,
          file: { fileName: `${dataset}.csv`, body: Buffer.from("synthetic") },
          [dateField]: "20260826"
        };

        expect(validateStructuredImportMetadata(upload)).toMatchObject({
          ok: false,
          code: "INVALID_DATE_WINDOW"
        });
      }
    }
  );

  it("uses receipt identity for delivery names and a content digest for supplier names", () => {
    expect(
      canonicalStructuredImportFileName({
        dataset: "delivery_ledger",
        enterpriseName: "Maijia",
        receiptId: "SH2608250117",
        startDate: "20260826",
        endDate: "20260826",
        fileType: "csv"
      })
    ).toBe("m_a_i_j_i_a_delivery_ledger_SH2608250117_20260826.csv");

    expect(
      canonicalStructuredImportFileName({
        dataset: "supplier_catalog",
        enterpriseName: "Maijia",
        contentDigest: "a".repeat(64),
        fileType: "csv"
      })
    ).toBe(`m_a_i_j_i_a_supplier_catalog_${"a".repeat(64)}.csv`);
  });

  it("includes receipt identity in delivery fingerprints but not supplier row values", () => {
    const deliveryInput = {
      dataset: "delivery_ledger" as const,
      enterpriseName: "Maijia",
      startDate: "20260826",
      endDate: "20260826",
      naturalKey: "SH2608250117",
      confidentialityLevel: 0,
      fileHash: "file-hash"
    };

    const expectedDeliveryFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          dataset: "delivery_ledger",
          enterpriseName: "Maijia",
          startDate: "20260826",
          endDate: "20260826",
          naturalKey: "SH2608250117",
          confidentialityLevel: 0,
          fileHash: "file-hash"
        })
      )
      .digest("hex");
    expect(structuredImportFingerprint(deliveryInput)).toBe(expectedDeliveryFingerprint);
    expect(structuredImportFingerprint({ ...deliveryInput, naturalKey: "SH2608250118" })).not.toBe(
      expectedDeliveryFingerprint
    );

    const supplierInput = {
      dataset: "supplier_catalog" as const,
      enterpriseName: "Maijia",
      startDate: null,
      endDate: null,
      confidentialityLevel: 0,
      fileHash: "file-hash"
    };
    const expectedSupplierFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          dataset: "supplier_catalog",
          enterpriseName: "Maijia",
          confidentialityLevel: 0,
          fileHash: "file-hash"
        })
      )
      .digest("hex");
    expect(structuredImportFingerprint(supplierInput)).toBe(expectedSupplierFingerprint);
  });

  it("bounds expanded receipt names and keeps long receipt values deterministically unique", () => {
    const receiptA = `${"收".repeat(254)}甲`;
    const receiptB = `${"收".repeat(254)}乙`;
    const input = {
      dataset: "delivery_ledger" as const,
      enterpriseName: "Maijia",
      startDate: "20260826",
      endDate: "20260826",
      fileType: "xlsx" as const
    };
    const nameA = canonicalStructuredImportFileName({ ...input, receiptId: receiptA });
    const nameARepeat = canonicalStructuredImportFileName({ ...input, receiptId: receiptA });
    const nameB = canonicalStructuredImportFileName({ ...input, receiptId: receiptB });
    const keyA = createOriginalObjectKey({
      orgId: "default-org",
      documentId: "doc_123456789012345678901234",
      fileName: nameA
    });

    expect(nameA).toBe(nameARepeat);
    expect(nameA).not.toBe(nameB);
    expect(nameA).toMatch(/\.xlsx$/);
    expect(nameA.length).toBeLessThanOrEqual(200);
    expect(keyA.length).toBeLessThan(512);
    expect(nameA).toContain("delivery_ledger");
    expect(nameA).toContain("u6536");
  });
});
