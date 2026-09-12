import { describe, expect, test } from "@jest/globals";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cheap, durable regression guard: the automatic event-cancellation refund
// path must NEVER cap the refund against a member's credit balance the way
// createRefund()'s assertRefundWithinCredit does - an organizer-cancelled
// event reimburses a real captured payment in full, on the organizer's
// decision, an unrelated concept from limiting a refund against 2020 credit.
//
// Deliberately a plain fs.readFileSync check with NO import of the service
// module itself - eventCancellationRefund.service.js imports the real
// Payment/Refund mongoose models, and this jest install (25.5.4, no
// jest.unstable_mockModule) fails to load mongoose at all under
// --experimental-vm-modules (ENOENT on node:-prefixed core requires - see
// this repo's CLAUDE.md and the 15/20-suite failure it documents). This test
// stays in the passing bucket precisely by never touching that import graph;
// see eventCancellationRefund.service.test.js for the behavioral tests this
// environment currently can't run, and account-service/CLAUDE.md for why.
test("never imports assertRefundWithinCredit (mentioning it in comments explaining why not is fine)", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../services/eventCancellationRefund.service.js"),
    "utf8",
  );
  // ESM only: there is no way to call assertRefundWithinCredit without an
  // import/require of it somewhere - checking specifically for that (rather
  // than any mention of the name) lets the file keep an explanatory comment
  // about why it's deliberately NOT used, without this test tripping on the
  // comment's own prose.
  expect(source).not.toMatch(/(?:import|require)[^;\n]*assertRefundWithinCredit/);
});
