// scripts/lib/migrationTargetGuard.js: DEV exactly as before; UAT only with --target-env=uat,
// DEPLOYMENT_ENV=uat and an explicitly approved database name; anything else (production included) refused.
import test from "node:test";
import assert from "node:assert";
import { assertMigrationTarget, UAT_DATABASES } from "../../scripts/lib/migrationTargetGuard.js";

const quiet = (fn) => { const o = console.log; console.log = () => {}; try { return fn(); } finally { console.log = o; } };
const ok = (db, argv, deploymentEnv) => quiet(() => assertMigrationTarget(db, argv, { apply: argv.includes("--apply"), deploymentEnv }));
const refused = (db, argv, deploymentEnv, re) => quiet(() => assert.throws(() => assertMigrationTarget(db, argv, { apply: argv.includes("--apply"), deploymentEnv }), re));
const UAT = "account-service", DEV = "account-service-dev";

test("approved UAT database list is exactly this service's UAT database", () => {
  assert.deepStrictEqual([...UAT_DATABASES], [UAT]);
});
test("DEV approved database -> allowed (DEPLOYMENT_ENV unset, as before, or dev)", () => {
  assert.strictEqual(ok(DEV, [], undefined), DEV);
  assert.strictEqual(ok(DEV, ["--target-env=dev"], "dev"), DEV);
  assert.strictEqual(ok(DEV, ["--apply", `--expect-db=${DEV}`], undefined), DEV);
});
test("UAT approved database + --target-env=uat + DEPLOYMENT_ENV=uat -> allowed (dry run and apply)", () => {
  assert.strictEqual(ok(UAT, ["--target-env=uat"], "uat"), UAT);
  assert.strictEqual(ok(UAT, ["--target-env=uat", "--apply", `--expect-db=${UAT}`], "uat"), UAT);
});
test("UAT database while target/env is dev -> denied", () => {
  refused(UAT, [], undefined, /not a DEV database/);
  refused(UAT, ["--target-env=dev"], "dev", /not a DEV database/);
  refused(UAT, ["--target-env=uat"], "dev", /requires DEPLOYMENT_ENV=uat/);
});
test("DEV database while env is uat -> denied", () => {
  refused(DEV, ["--target-env=uat"], "uat", /not an approved UAT database/);
  refused(DEV, [], "uat", /target-env dev but DEPLOYMENT_ENV="uat"/);
});
test("unknown database -> denied in both modes", () => {
  for (const db of ["", "test", "admin", "some-other-service"]) {
    refused(db, [], undefined, /not a DEV database/);
    refused(db, ["--target-env=uat"], "uat", /not an approved UAT database/);
  }
});
test("production-looking database or target -> denied, never implicitly approved", () => {
  for (const db of [`${UAT}-prod`, `${UAT}-Production`, "production", "prod", `${UAT}_prod`]) {
    refused(db, [], undefined, /not a DEV database/);
    refused(db, ["--target-env=uat"], "uat", /not an approved UAT database/);
  }
  for (const t of ["prod", "production", "live", "staging"]) refused(UAT, [`--target-env=${t}`], t, /not approved \(dev or uat only\)/);
});
test("no substring or case-insensitive matching for UAT", () => {
  for (const db of [`${UAT}-uat`, `x-${UAT}`, `${UAT} `, UAT.toLowerCase() === UAT ? `${UAT.toUpperCase()}` : UAT.toLowerCase(), "uat", `${DEV}-uat`]) {
    if (db === UAT) continue;
    refused(db, ["--target-env=uat"], "uat", /not an approved UAT database/);
  }
});
test("missing or other DEPLOYMENT_ENV with --target-env=uat -> denied", () => {
  for (const e of [undefined, "", "  ", "UAT ", "prod", "dev"]) {
    if (e === "UAT ") { refused(UAT, ["--target-env=uat"], e, /requires DEPLOYMENT_ENV=uat|not an approved/); continue; }
    refused(UAT, ["--target-env=uat"], e, /requires DEPLOYMENT_ENV=uat/);
  }
});
test("UAT --apply still requires a matching --expect-db", () => {
  refused(UAT, ["--target-env=uat", "--apply"], "uat", /requires --expect-db/);
  refused(UAT, ["--target-env=uat", "--apply", `--expect-db=${DEV}`], "uat", /--expect-db/);
});
