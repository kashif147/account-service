// scripts/lib/migrationTargetGuard.js: migrations run only against approved DEV databases.
import test from "node:test";
import assert from "node:assert";
import { assertMigrationTarget } from "../../scripts/lib/migrationTargetGuard.js";

const quiet = () => { const o = console.log; console.log = () => {}; return () => { console.log = o; }; };

test("DEV database passes (dry run without --expect-db, apply with matching --expect-db)", () => {
  const r = quiet();
  try {
    assert.equal(assertMigrationTarget("account-service-dev", []), "account-service-dev");
    assert.equal(assertMigrationTarget("audit_db-dev", ["--apply", "--expect-db=audit_db-dev"]), "audit_db-dev");
    assert.equal(assertMigrationTarget("reporting_dev", []), "reporting_dev");
  } finally { r(); }
});

test("UAT database names are refused even in a dry run", () => {
  const r = quiet();
  try {
    for (const db of ["account-service", "Profile-Service", "User-Service", "reporting_db", "audit_db", "dev-tools"]) {
      assert.throws(() => assertMigrationTarget(db, []), /not a DEV database/, db);
    }
  } finally { r(); }
});

test("--apply needs --expect-db, and it must match the connected database", () => {
  const r = quiet();
  try {
    assert.throws(() => assertMigrationTarget("account-service-dev", ["--apply"]), /requires --expect-db/);
    assert.throws(() => assertMigrationTarget("account-service-dev", ["--apply", "--expect-db=profile-service-dev"]), /--expect-db/);
    assert.throws(() => assertMigrationTarget("account-service-dev", ["--expect-db=account-service"]), /--expect-db/);
  } finally { r(); }
});

test("only target-env dev is approved", () => {
  const r = quiet();
  try {
    assert.throws(() => assertMigrationTarget("account-service-dev", ["--target-env=uat"]), /requires DEPLOYMENT_ENV=uat/);
  } finally { r(); }
});
