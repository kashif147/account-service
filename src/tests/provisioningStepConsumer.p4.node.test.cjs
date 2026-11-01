// Phase B / P4 - account-service provisioning step consumer (tenant.provisioning.step.requested.v1), REAL throwaway
// mongod (MONGOD_BIN or `mongod` on PATH; skipped otherwise). Broker = stub publishConfirmed.
// Run: node --test src/tests/provisioningStepConsumer.p4.node.test.cjs
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const mongoose = require("mongoose");
const g = require("../services/tenantGridDefaults.cjs");
const StepResult = require("../models/provisioningStepResult.model.cjs");
const L = require("../rabbitMQ/listeners/provisioning.step.listener.cjs");

const RUN = "11111111-2222-4333-8444-555555555555";
const KEY = `psk2:${RUN}:account-service:grid-system-defaults:ensure-defaults`;
const LOCAL = L.localManifest();
const TYPES = ["creditnotes", "journaladjustments", "onlinepayment", "reconciliation"];
const mongodBin = process.env.MONGOD_BIN || (spawnSync("sh", ["-c", "command -v mongod"], { encoding: "utf8" }).stdout || "").trim();
const quiet = () => { const o = console.info; console.info = () => {}; return () => { console.info = o; }; };

test("the local manifest is the reviewed account v1 (registry pin f2290277...)", () => {
  assert.deepStrictEqual(LOCAL, { version: 1, sha256: "f229027749c8e37185d7828126da1847588b69e593236b5b3aba4514d7c7fd2f" });
  assert.deepStrictEqual(Object.keys(g.loadCanonical().templates).sort(), TYPES);
});

test("consumer gate: nothing is created or bound unless PROVISIONING_CONSUMER=on", async () => {
  const mk = () => { const calls = []; return { calls, createQueue: async (q) => calls.push(["createQueue", q]), bindQueue: async (q, ex, k) => calls.push(["bindQueue", q, ex, k]), registerHandler: (t) => calls.push(["registerHandler", t]), consume: async (q) => calls.push(["consume", q]) }; };
  const probes = [];
  const assertBindable = async (ex) => probes.push(ex);
  for (const v of [undefined, "true", "1", "ON"]) {
    if (v === undefined) delete process.env.PROVISIONING_CONSUMER; else process.env.PROVISIONING_CONSUMER = v;
    const c = mk();
    assert.deepStrictEqual(await L.setupProvisioningStepConsumer(c, assertBindable), { bound: false });
    assert.deepStrictEqual(c.calls, []);
  }
  assert.deepStrictEqual(probes, []);
  process.env.PROVISIONING_CONSUMER = "on";
  const c = mk();
  assert.deepStrictEqual(await L.setupProvisioningStepConsumer(c, assertBindable), { bound: true, queue: "accounts.provisioning.events" });
  assert.deepStrictEqual(probes, ["provisioning.events"]);
  assert.deepStrictEqual(c.calls, [["createQueue", "accounts.provisioning.events"], ["bindQueue", "accounts.provisioning.events", "provisioning.events", ["tenant.provisioning.step.requested.v1"]], ["registerHandler", "tenant.provisioning.step.requested.v1"], ["consume", "accounts.provisioning.events"]]);
  delete process.env.PROVISIONING_CONSUMER;
});

test("account consumer against a real mongod", { skip: !mongodBin && "no mongod binary (set MONGOD_BIN)" }, async (t) => {
  const port = await new Promise((resolve, reject) => { const srv = net.createServer(); srv.listen(0, "127.0.0.1", () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); }); srv.on("error", reject); });
  const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "acc-p4-"));
  const mongod = spawn(mongodBin, ["--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  const restore = quiet();
  try {
    for (let i = 0; i < 160 && mongoose.connection.readyState !== 1; i += 1) {
      try { await mongoose.connect(`mongodb://127.0.0.1:${port}/acc-p4-test`, { serverSelectionTimeoutMS: 500 }); } catch (_) { await new Promise((r) => setTimeout(r, 250)); }
    }
    assert.strictEqual(mongoose.connection.readyState, 1, "throwaway mongod did not start");
    await StepResult.init();
    const db = mongoose.connection.db;
    const tpl = () => db.collection("templates");
    let tenantId;
    let published;
    const pub = async (type, data, opts) => { published.push({ type, data, opts }); return { success: true, eventId: opts.eventId }; };
    const reset = async () => {
      for (const c of ["templates", "provisioningstepresults"]) await db.collection(c).deleteMany({});
      // the shared tenantless rows and another tenant's customised rows must never be touched
      await tpl().insertMany(TYPES.map((type) => ({ templateType: type, systemDefault: true, tenantId: null, columns: ["shared"], meta: { deleted: false } })));
      tenantId = String(new mongoose.Types.ObjectId());
      published = [];
    };
    const req = (dOver = {}, envOver = {}) => {
      const data = { runId: RUN, tenantId, stepKey: KEY, stepKeyVersion: 2, service: "account-service", component: "account-service:grid-system-defaults", action: "ensure-defaults", manifestVersion: LOCAL.version, manifestSha256: LOCAL.sha256, attempt: 1, templateKey: "standard-tenant", templateVersion: 1, ...dOver };
      const header = envOver.header !== undefined ? envOver.header : data.tenantId;
      delete envOver.header;
      return { payload: { eventId: `prov_${"a".repeat(40)}`, eventType: L.EVENT_TYPES.REQUESTED, tenantId: data.tenantId, data, ...envOver }, context: { headers: { "x-tenant-id": header } } };
    };
    const run = (r, deps = {}) => L.handleProvisioningStepRequested(r.payload, r.context, { publishConfirmed: pub, ...deps });
    const allHash = async () => crypto.createHash("md5").update(JSON.stringify(await tpl().find({}).sort({ _id: 1 }).toArray())).digest("hex");
    const tenantRows = () => tpl().find({ tenantId }).toArray();

    await t.test("clean tenant: all 4 reviewed defaults inserted for the target only; strict completed payload", async () => {
      await reset();
      const before = await tpl().find({ tenantId: null }).toArray();
      const r = await run(req());
      assert.strictEqual(r.outcome, "completed");
      assert.deepStrictEqual([r.data.insertedCount, r.data.skippedCount], [4, 0]);
      const rows = await tenantRows();
      assert.deepStrictEqual(rows.map((x) => x.templateType).sort(), TYPES);
      assert.ok(rows.every((x) => x.systemDefault === true && x.tenantId === tenantId));
      assert.deepStrictEqual(await tpl().find({ tenantId: null }).toArray(), before); // shared rows untouched
      assert.strictEqual(await tpl().countDocuments({ $or: [{ tenantId: null }, { tenantId: { $exists: false } }] }), 4); // no new tenantless row
      assert.strictEqual(published.length, 1);
      assert.strictEqual(published[0].type, L.EVENT_TYPES.COMPLETED);
      assert.deepStrictEqual(Object.keys(published[0].data).sort(), ["attempt", "component", "insertedCount", "manifestSha256", "runId", "service", "skippedCount", "stepKey", "tenantId"]);
      assert.ok(!/columns|filters|stack|Error|eyJ|@|mongodb/.test(JSON.stringify(published[0])));
      // the ONLY collections touched: templates (the 4 rows) + the result ledger
      const nonEmpty = [];
      for (const c of await db.listCollections().toArray()) if (await db.collection(c.name).countDocuments()) nonEmpty.push(c.name);
      assert.deepStrictEqual(nonEmpty.sort(), ["provisioningstepresults", "templates"]);
    });

    await t.test("existing tenant defaults (incl. a customised one) are skipped, never overwritten", async () => {
      await reset();
      await g.ensureTenantDefaults(tenantId, 1);
      await tpl().updateOne({ tenantId, templateType: "creditnotes" }, { $set: { columns: ["custom"], columnLabels: { custom: "Mine" } } });
      const before = await allHash();
      const r = await run(req());
      assert.deepStrictEqual([r.outcome, r.data.insertedCount, r.data.skippedCount], ["completed", 0, 4]);
      assert.strictEqual(await allHash(), before);
    });

    await t.test("duplicate delivery replays the ORIGINAL stored result (4/0, same eventId) - never 0/4", async () => {
      await reset();
      const first = await run(req());
      const second = await run(req());
      assert.strictEqual(second.replay, true);
      assert.strictEqual(second.eventId, first.eventId);
      assert.deepStrictEqual(published.map((p) => [p.opts.eventId, p.data.insertedCount, p.data.skippedCount]), [[first.eventId, 4, 0], [first.eventId, 4, 0]]);
      assert.strictEqual((await tenantRows()).length, 4);
      assert.strictEqual(await StepResult.countDocuments(), 1);
    });

    await t.test("crash after write, before publish (broker refuses) -> throws for redelivery; redelivery publishes the stored 4/0", async () => {
      await reset();
      await assert.rejects(run(req(), { publishConfirmed: async () => ({ success: false, error: "broker nack" }) }), /not confirmed/);
      assert.strictEqual((await tenantRows()).length, 4);
      const again = await run(req());
      assert.deepStrictEqual([again.replay, again.data.insertedCount, again.data.skippedCount], [true, 4, 0]);
      assert.strictEqual((await tenantRows()).length, 4);
    });

    await t.test("crash before write (DB unavailable) -> throws, nothing stored or published", async () => {
      await reset();
      await assert.rejects(run(req(), { ensureTenantDefaults: async () => { throw new Error("MongoDB is not connected"); } }), /not connected/);
      assert.strictEqual(await StepResult.countDocuments(), 0);
      assert.strictEqual(published.length, 0);
    });

    await t.test("manifest version or digest mismatch -> failed MANIFEST_DIGEST_MISMATCH, ensure NOT called, nothing written", async () => {
      await reset();
      let called = 0;
      for (const over of [{ manifestSha256: "0".repeat(64) }, { manifestVersion: 2 }]) {
        await db.collection("provisioningstepresults").deleteMany({});
        published = [];
        const r = await run(req(over), { ensureTenantDefaults: async () => { called += 1; } });
        assert.deepStrictEqual([r.outcome, r.data.failureCode], ["failed", "MANIFEST_DIGEST_MISMATCH"]);
        assert.deepStrictEqual(Object.keys(published[0].data).sort(), ["attempt", "component", "failureCode", "manifestSha256", "runId", "service", "stepKey", "tenantId"]);
      }
      assert.strictEqual(called, 0);
      assert.strictEqual((await tenantRows()).length, 0);
    });

    await t.test("tenant triple: envelope / header / payload mismatch, placeholder or org code -> dropped, nothing written", async () => {
      await reset();
      const other = String(new mongoose.Types.ObjectId());
      for (const c of [req({}, { tenantId: other }), req({}, { header: other }), req({}, { header: "" }), req({ tenantId: "DEVPROV1" }), req({ tenantId: "default" })]) {
        const r = await run(c);
        assert.deepStrictEqual([r.outcome, r.reason], ["dropped", "tenant_mismatch"]);
      }
      assert.strictEqual(await tpl().countDocuments({ tenantId: { $ne: null } }), 0);
      assert.strictEqual(published.length, 0);
    });

    await t.test("other service ignored; wrong component / action of this service -> failed STEP_ERROR without ensure", async () => {
      await reset();
      assert.strictEqual((await run(req({ service: "events-service", component: "events-service:grid-system-defaults", stepKey: `psk2:${RUN}:events-service:grid-system-defaults:ensure-defaults` }))).outcome, "ignored");
      assert.strictEqual(published.length, 0);
      let called = 0;
      const ensure = async () => { called += 1; };
      const wc = await run(req({ component: "account-service:journals", stepKey: `psk2:${RUN}:account-service:journals:ensure-defaults` }), { ensureTenantDefaults: ensure });
      assert.deepStrictEqual([wc.outcome, wc.data.failureCode], ["failed", "STEP_ERROR"]);
      await db.collection("provisioningstepresults").deleteMany({});
      const wa = await run(req({ action: "rebuild-ledger", stepKey: `psk2:${RUN}:account-service:grid-system-defaults:rebuild-ledger` }), { ensureTenantDefaults: ensure });
      assert.deepStrictEqual([wa.outcome, wa.data.failureCode], ["failed", "STEP_ERROR"]);
      assert.strictEqual(called, 0);
      assert.strictEqual(await tpl().countDocuments({ tenantId: { $ne: null } }), 0);
    });

    await t.test("malformed / legacy / foreign keys, bad attempt, extra or missing fields, wrong event type -> dropped", async () => {
      await reset();
      const legacy = `${tenantId}:standard-tenant@1:account-service:account-service:grid-system-defaults`;
      const missing = req(); delete missing.payload.data.manifestSha256;
      const cases = [req({ stepKey: legacy }), req({ stepKeyVersion: 1 }), req({ stepKey: KEY.replace(RUN, "22222222-2222-4333-8444-555555555555") }), req({ runId: "not-a-uuid" }), req({ attempt: 0 }), req({ extra: "x" }), missing, { payload: { ...req().payload, eventType: "tenant.provisioning.step.completed.v1" }, context: req().context }];
      for (const c of cases) assert.strictEqual((await run(c)).outcome, "dropped");
      assert.strictEqual(await tpl().countDocuments({ tenantId: { $ne: null } }), 0);
      assert.strictEqual(published.length, 0);
    });

    await t.test("the result ledger is insert-only and never replays another tenant's result", async () => {
      await reset();
      await run(req());
      await assert.rejects(StepResult.updateOne({ stepKey: KEY }, { $set: { "data.insertedCount": 9 } }), /immutable/);
      await assert.rejects(StepResult.deleteOne({ stepKey: KEY }), /immutable/);
      const other = String(new mongoose.Types.ObjectId());
      assert.deepStrictEqual((await run(req({ tenantId: other }))).reason, "tenant_mismatch");
    });
  } finally {
    restore();
    await mongoose.disconnect();
    { const exited = new Promise((r) => mongod.once("exit", r)); mongod.kill(); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); }
    try { if (dbPath.startsWith(os.tmpdir())) fs.rmSync(dbPath, { recursive: true, force: true }); } catch (_) { /* best-effort temp cleanup */ }
  }
});
