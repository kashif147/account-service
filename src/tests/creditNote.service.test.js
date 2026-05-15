import { describe, expect, test, beforeAll, afterAll, beforeEach } from "@jest/globals";
import mongoose from "mongoose";
import GL from "../models/glTransaction.model.js";
import CreditNote from "../models/creditNote.model.js";
import CoA from "../models/coa.model.js";
import MaterializedBalance from "../models/materializedBalance.model.js";
import {
  createCreditNoteDraft,
  approveCreditNote,
  cancelCreditNote,
} from "../services/creditNote.service.js";

const MEMBER = "CN-TEST-MEMBER";
const INV_DOC = "INV-CN-001";
const CN_DOC = "CN-001";

async function seedCoa() {
  const accounts = [
    { code: "1400", description: "AR Members", type: "Asset", isMemberTracked: true },
    { code: "2020", description: "Member credits", type: "Liability", isMemberTracked: true },
    { code: "4000", description: "Subscription income", type: "Income", isRevenue: true },
    { code: "4900", description: "Adjustments", type: "ContraIncome", isContraRevenue: true },
  ];
  for (const a of accounts) {
    await CoA.updateOne({ code: a.code }, { $set: a }, { upsert: true });
  }
}

async function seedInvoice() {
  await GL.create({
    date: new Date("2025-06-01"),
    docType: "Invoice",
    docNo: INV_DOC,
    memo: "Test invoice",
    entries: [
      {
        accountCode: "1400",
        dc: "D",
        amount: 30_000,
        memberId: MEMBER,
        periodBucket: "current",
      },
      {
        accountCode: "4000",
        dc: "C",
        amount: 30_000,
        revenueSubType: "fee",
        categoryName: "General",
      },
    ],
  });
}

describe("creditNote.service", () => {
  beforeAll(async () => {
    const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/account-service-test";
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(uri);
    }
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await GL.deleteMany({
      docNo: { $in: [INV_DOC, `CN-${CN_DOC}`, `${CN_DOC}-2020`] },
    });
    await CreditNote.deleteMany({ docNo: CN_DOC });
    await MaterializedBalance.deleteMany({ memberId: MEMBER });
    await seedCoa();
    await seedInvoice();
  });

  test("draft does not create GL", async () => {
    const { creditNote } = await createCreditNoteDraft({
      docNo: CN_DOC,
      memberId: MEMBER,
      invoiceDocNo: INV_DOC,
      amount: 10_000,
      effectiveDate: "2025-06-15",
      createdBy: "tester",
    });
    expect(creditNote.status).toBe("Draft");
    expect(creditNote.incomeCode).toBe("4000");
    const gl = await GL.findOne({ docNo: `CN-${CN_DOC}` }).lean();
    expect(gl).toBeNull();
  });

  test("approve reverses 4000 not 4900", async () => {
    await createCreditNoteDraft({
      docNo: CN_DOC,
      memberId: MEMBER,
      invoiceDocNo: INV_DOC,
      amount: 10_000,
      effectiveDate: "2025-06-15",
    });
    const { gl } = await approveCreditNote({
      docNo: CN_DOC,
      approvedBy: "approver",
      userId: "approver",
    });
    expect(gl.docType).toBe("CreditNote");
    const dr = gl.entries.find((e) => e.dc === "D");
    expect(dr.accountCode).toBe("4000");
    expect(gl.entries.some((e) => e.accountCode === "4900")).toBe(false);
  });

  test("cancelled draft does not post", async () => {
    await createCreditNoteDraft({
      docNo: CN_DOC,
      memberId: MEMBER,
      invoiceDocNo: INV_DOC,
      amount: 5_000,
      effectiveDate: "2025-06-15",
    });
    const cancelled = await cancelCreditNote({
      docNo: CN_DOC,
      cancelledBy: "user",
    });
    expect(cancelled.status).toBe("Cancelled");
    await expect(
      approveCreditNote({ docNo: CN_DOC, approvedBy: "x", userId: "x" }),
    ).rejects.toThrow();
  });
});
