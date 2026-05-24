import { describe, expect, test } from "@jest/globals";
import {
  buildEndToEndId,
  computeCollectibleAmountEur,
  resolveSeqTp,
} from "../helpers/directDebitAmount.helper.js";
import {
  buildPain008Xml,
  groupItemsForPain008,
} from "../services/pain008.service.js";
import {
  matchPain002ToItems,
  parsePain002Xml,
} from "../services/pain002.service.js";
import { computeRunTotals } from "../services/directDebitEligibility.service.js";

const creditor = {
  name: "Test Creditor Ltd",
  oin: "IE12SDD345678",
  iban: "IE08AIBK93101212345678",
  bic: "AIBKIE2DXXX",
};

function sampleItem(overrides = {}) {
  return {
    _id: "507f1f77bcf86cd799439011",
    endToEndId: "E2E-MBR1001-202605-0001",
    amountEur: 45.0,
    mandateSnapshot: {
      umr: "UMR-001",
      signedDate: new Date("2023-01-10"),
      debtorName: "Joe Bloggs",
      debtorIban: "IE12AIBK93101212345678",
      debtorBic: "AIBKIE2DXXX",
      debtorCity: "Dublin",
      debtorCountry: "IE",
      seqTp: "RCUR",
    },
    remittanceInfo: "Membership MBR1001",
    ...overrides,
  };
}

describe("directDebitAmount.helper", () => {
  test("computeCollectibleAmountEur monthly from category", () => {
    const amt = computeCollectibleAmountEur({
      runType: "MONTHLY",
      membershipCategory: "FULL_TIME",
      paymentFrequency: "Monthly",
    });
    expect(amt).toBe(45);
  });

  test("resolveSeqTp returns FRST without prior collections", () => {
    expect(resolveSeqTp({ successfulCollectionCount: 0 })).toBe("FRST");
    expect(resolveSeqTp({ successfulCollectionCount: 2 })).toBe("RCUR");
  });

  test("buildEndToEndId max 35 chars no spaces", () => {
    const id = buildEndToEndId({
      membershipNumber: "MBR 1001",
      periodEndDate: "2026-05-31",
      runNo: "DD-2026-0001",
    });
    expect(id.length).toBeLessThanOrEqual(35);
    expect(id).not.toMatch(/\s/);
  });
});

describe("pain008.service", () => {
  test("groupItemsForPain008 validates totals", () => {
    const items = [sampleItem(), sampleItem({ endToEndId: "E2E-2", amountEur: 35 })];
    const blocks = groupItemsForPain008(items, creditor, "2026-05-11");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].nbOfTxs).toBe(2);
    expect(blocks[0].ctrlSum).toBe("80.00");
  });

  test("buildPain008Xml header matches block totals", () => {
    const items = [sampleItem()];
    const blocks = groupItemsForPain008(items, creditor, "2026-05-11");
    const built = buildPain008Xml({
      msgId: "SDD-DD-2026-0001-123",
      creDtTm: "2026-01-31T15:53:40",
      oin: creditor.oin,
      blocks,
    });
    expect(built.xml).toContain("pain.008.001.08");
    expect(built.xml).toContain("<PmtMtd>DD</PmtMtd>");
    expect(built.xml).toContain("<Cd>SEPA</Cd>");
    expect(built.xml).toContain("<SeqTp>RCUR</SeqTp>");
    expect(built.nbOfTxs).toBe(1);
    expect(built.ctrlSum).toBe("45.00");
    expect(built.fileHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("buildPain008 MsgId has no spaces", () => {
    const items = [sampleItem()];
    const blocks = groupItemsForPain008(items, creditor, "2026-05-11");
    const built = buildPain008Xml({
      msgId: "SDD DD 2026",
      creDtTm: "2026-01-31T15:53:40",
      oin: creditor.oin,
      blocks,
    });
    expect(built.msgId).not.toMatch(/\s/);
  });
});

describe("pain002.service", () => {
  const pain002Sample = `<?xml version="1.0" encoding="utf-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.10">
<CstmrPmtStsRpt>
<GrpHdr><MsgId>AIB-002-1</MsgId></GrpHdr>
<OrgnlGrpInfAndSts>
<OrgnlMsgId>SDD-DD-2026-0001</OrgnlMsgId>
</OrgnlGrpInfAndSts>
<OrgnlPmtInfAndSts>
<OrgnlPmtInfId>PMTID-BLOCK-1</OrgnlPmtInfId>
<TxInfAndSts>
<OrgnlEndToEndId>E2E-MBR1001-202605-0001</OrgnlEndToEndId>
<TxSts>RJCT</TxSts>
<StsRsnInf><Rsn><Cd>AM04</Cd></Rsn></StsRsnInf>
<OrgnlTxRef><Amt><InstdAmt Ccy="EUR">45.00</InstdAmt></Amt></OrgnlTxRef>
</TxInfAndSts>
</OrgnlPmtInfAndSts>
</CstmrPmtStsRpt>
</Document>`;

  test("parsePain002Xml extracts reject", () => {
    const parsed = parsePain002Xml(pain002Sample);
    expect(parsed.originalMsgId).toBe("SDD-DD-2026-0001");
    expect(parsed.transactions[0].reasonCode).toBe("AM04");
  });

  test("matchPain002ToItems by EndToEndId", () => {
    const parsed = parsePain002Xml(pain002Sample);
    const items = [sampleItem()];
    const { matches, unmatched } = matchPain002ToItems(parsed, items, {
      collectionDate: "2026-05-11",
      receivedDate: "2026-05-10",
    });
    expect(matches).toHaveLength(1);
    expect(unmatched).toHaveLength(0);
    expect(matches[0].settlementPhase).toBe("pre_settlement");
  });
});

describe("computeRunTotals", () => {
  test("sums included and excluded", () => {
    const totals = computeRunTotals([
      { status: "INCLUDED", amountEur: 45 },
      { status: "INCLUDED", amountEur: 35 },
      { status: "EXCLUDED", amountEur: 0 },
      { status: "REJECTED", amountEur: 45 },
    ]);
    expect(totals.includedCount).toBe(3);
    expect(totals.excludedCount).toBe(1);
    expect(totals.includedAmountEur).toBe(125);
    expect(totals.rejectedCount).toBe(1);
  });
});
