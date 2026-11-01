// Tenant-owned grid system defaults: insert-only migration + ensureTenantDefaults, against a REAL
// throwaway mongod (skipped when no mongod binary: set MONGOD_BIN). Suite: src/tests/helpers/tenantGridDefaultsSuite.cjs
// node:test (not jest): mongoose cannot be loaded under this package's ESM jest setup on current Node.
// Run: node --test src/tests/tenantGridDefaults.node.test.cjs
const { describe, test, before, after, beforeEach } = require("node:test");
const g = require("../services/tenantGridDefaults.cjs");
const cli = require("../../scripts/migrate-grid-defaults-to-tenants.cjs");
const { registerTenantGridDefaultsSuite, mongodBin } = require("./helpers/tenantGridDefaultsSuite.cjs");

describe("tenant-owned grid system defaults (real mongod)", { skip: !mongodBin() && "no mongod binary (set MONGOD_BIN)" }, () => {
  registerTenantGridDefaultsSuite(
    { test, beforeAll: before, afterAll: after, beforeEach },
    { g, cli, types: ["creditnotes", "journaladjustments", "onlinepayment", "reconciliation"] },
  );
});
