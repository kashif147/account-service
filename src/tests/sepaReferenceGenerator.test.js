import { describe, expect, test } from "@jest/globals";
import {
  assignUniqueEndToEndIds,
  buildMessageIdScopeKey,
  buildPmtInfScopeKey,
  buildRunNoScopeKey,
  derivePeriodKey,
  generateEndToEndId,
  generateMessageId,
  generatePaymentInformationId,
  generateRunNo,
  normalizeTenantCode,
  validateSepaReference,
  SEPA_MAX,
} from "../services/sepaReferenceGenerator.js";

describe("sepaReferenceGenerator", () => {
  test("normalizeTenantCode uppercases and strips invalid chars", () => {
    expect(normalizeTenantCode("inmo")).toBe("INMO");
    expect(normalizeTenantCode("gra-01")).toBe("GRA01");
    expect(normalizeTenantCode("", "tenant-abc-123")).toBe("TENANTAB");
  });

  test("derivePeriodKey monthly vs annual", () => {
    expect(derivePeriodKey("MONTHLY", "2026-05-31")).toBe("202605");
    expect(derivePeriodKey("BI_WEEKLY", "2026-05-15")).toBe("202605");
    expect(derivePeriodKey("ANNUAL", "2026-05-31")).toBe("2026");
  });

  test("generateRunNo format", () => {
    expect(generateRunNo({
      tenantCode: "INMO",
      runType: "MONTHLY",
      periodKey: "202605",
      sequence: 1,
    })).toBe("DD-INMO-MONTHLY-202605-001");

    expect(generateRunNo({
      tenantCode: "GRA",
      runType: "ANNUAL",
      periodKey: "2026",
      sequence: 1,
    })).toBe("DD-GRA-ANNUAL-2026-001");
  });

  test("run sequence scope keys separate tenants and periods", () => {
    const a = buildRunNoScopeKey("INMO", "MONTHLY", "202605");
    const b = buildRunNoScopeKey("GRA", "MONTHLY", "202605");
    const c = buildRunNoScopeKey("INMO", "MONTHLY", "202606");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  test("generateMessageId is alphanumeric and within max length", () => {
    const ts = new Date("2026-05-25T10:30:45Z");
    const id = generateMessageId({
      tenantCode: "INMO",
      utcTimestamp: ts,
      sequence: 1,
    });
    expect(id).toBe("MSGINMO20260525103045001");
    expect(id.length).toBeLessThanOrEqual(SEPA_MAX.MSG_ID);
    expect(id).not.toMatch(/\s/);
    expect(id).toMatch(/^[A-Z0-9]+$/);
  });

  test("message id scope key uses UTC day bucket", () => {
    expect(buildMessageIdScopeKey("INMO", new Date("2026-05-25T23:59:59Z"))).toBe(
      "INMO|20260525",
    );
  });

  test("generatePaymentInformationId format for AIB statement reference", () => {
    const id = generatePaymentInformationId({
      tenantCode: "INMO",
      collectionDate: new Date("2025-05-11T12:00:00Z"),
      sequence: 1,
    });
    expect(id).toBe("INMO-MAY25-01");
    expect(id.length).toBeLessThanOrEqual(15);
  });

  test("pmt inf scope key separates months", () => {
    expect(buildPmtInfScopeKey("INMO", new Date("2025-05-11T12:00:00Z"))).toBe("INMO|MAY25");
    expect(buildPmtInfScopeKey("INMO", new Date("2025-06-11T12:00:00Z"))).toBe("INMO|JUN25");
  });

  test("generateEndToEndId member format", () => {
    expect(
      generateEndToEndId({
        membershipNumber: "10245",
        periodKey: "202605",
        runSequence: 1,
        itemSequence: 1,
      }),
    ).toBe("MEM10245-202605");
  });

  test("generateEndToEndId fallback when no member number", () => {
    expect(
      generateEndToEndId({
        membershipNumber: null,
        periodKey: "202605",
        runSequence: 3,
        itemSequence: 12,
      }),
    ).toBe("DDTX-003-0012");
  });

  test("assignUniqueEndToEndIds prevents duplicates in batch", () => {
    const items = assignUniqueEndToEndIds({
      items: [
        { memberId: "10245" },
        { memberId: "10245" },
        { memberId: null },
      ],
      periodKey: "202605",
      runSequence: 1,
    });
    const ids = items.map((i) => i.endToEndId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("MEM10245-202605");
  });

  test("validateSepaReference rejects spaces and overlength", () => {
    expect(validateSepaReference("MSG WITH SPACE", {
      maxLength: 35,
      fieldName: "messageId",
    }).some((e) => e.includes("must not contain spaces"))).toBe(true);

    expect(validateSepaReference("A".repeat(40), {
      maxLength: 35,
      fieldName: "messageId",
    }).some((e) => e.includes("exceeds max length"))).toBe(true);
  });

  test("multi-tenant run numbers differ by tenant code", () => {
    const inmo = generateRunNo({
      tenantCode: "INMO",
      runType: "MONTHLY",
      periodKey: "202605",
      sequence: 1,
    });
    const gra = generateRunNo({
      tenantCode: "GRA",
      runType: "MONTHLY",
      periodKey: "202605",
      sequence: 1,
    });
    expect(inmo).not.toBe(gra);
  });

  test("collision suffix on message id via sequence increment", () => {
    const ts = new Date("2026-05-25T10:30:45Z");
    const first = generateMessageId({ tenantCode: "INMO", utcTimestamp: ts, sequence: 1 });
    const second = generateMessageId({ tenantCode: "INMO", utcTimestamp: ts, sequence: 2 });
    expect(first).not.toBe(second);
  });
});
