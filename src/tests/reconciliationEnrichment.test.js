import { describe, expect, test } from "@jest/globals";
import {
  enrichReconciliationRecord,
} from "../helpers/reconciliationEnrichment.js";

describe("reconciliationEnrichment", () => {
  test("enrich GL row with expected amount and high confidence when matched", () => {
    const gl = {
      docNo: "REC-001",
      docType: "Receipt",
      entries: [
        {
          accountCode: "1220",
          dc: "D",
          amount: 5000,
          memberId: "M-100",
        },
      ],
    };
    const glMap = new Map([[gl.docNo, gl]]);
    const rec = {
      glDocNo: "REC-001",
      clearingAccountCode: "1220",
      amount: 5000,
      reconciliationStatus: "auto_matched",
      matchedGlDocNo: "REC-001",
    };
    const out = enrichReconciliationRecord(rec, glMap);
    expect(out.memberId).toBe("M-100");
    expect(out.expectedAmount).toBe(5000);
    expect(out.amountDifference).toBe(0);
    expect(out.matchConfidence).toBe("high");
    expect(out.suggestedAction).toBe("settle");
  });

  test("suggests suspense when amount difference is large", () => {
    const gl = {
      docNo: "REC-002",
      entries: [{ accountCode: "1220", dc: "D", amount: 5000, memberId: "M-1" }],
    };
    const glMap = new Map([[gl.docNo, gl]]);
    const rec = {
      glDocNo: "REC-002",
      clearingAccountCode: "1220",
      amount: 6000,
      reconciliationStatus: "unmatched",
      sourceType: "bank",
      externalReference: "BANK-XYZ",
    };
    const out = enrichReconciliationRecord(rec, glMap);
    expect(out.amountDifference).toBe(1000);
    expect(out.suggestedAction).toBe("suspense");
    expect(out.matchConfidence).toBe("low");
  });
});
