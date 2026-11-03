// P5 decision (a): payment-link membership-fee rows are subscriptionFee + applicationBinding.
// Application authority comes from the binding, never the label; historical applicationFee rows
// keep working and an unbound subscriptionFee row with only an applicationId never qualifies.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { hasAuthoritativeApplicationBinding } from "../helpers/applicationBinding.js";

const APP = "a00000000000000000000001";

test("new payment-link row (subscriptionFee + applicationBinding) is an authoritative application payment", () => {
  assert.equal(
    hasAuthoritativeApplicationBinding({ purpose: "subscriptionFee", applicationId: APP, applicationBinding: APP }),
    true,
  );
});

test("historical payment-link row (applicationFee) still qualifies; no relabelling needed", () => {
  assert.equal(hasAuthoritativeApplicationBinding({ purpose: "applicationFee", applicationId: APP }), true);
});

test("subscriptionFee with only an applicationId (no binding) never qualifies", () => {
  assert.equal(hasAuthoritativeApplicationBinding({ purpose: "subscriptionFee", applicationId: APP }), false);
  assert.equal(
    hasAuthoritativeApplicationBinding({ purpose: "subscriptionFee", applicationId: APP, applicationBinding: "a00000000000000000000002" }),
    false,
  );
});

test("payment-link source writes subscriptionFee on the row and in Stripe metadata, and keeps the binding", () => {
  const src = fs.readFileSync(new URL("../services/paymentLink.service.js", import.meta.url), "utf8");
  assert.equal((src.match(/purpose: "applicationFee"/g) || []).length, 0);
  assert.equal((src.match(/purpose: "subscriptionFee"/g) || []).length, 2);
  assert.match(src, /applicationBinding: String\(link\.applicationId\)/);
});
