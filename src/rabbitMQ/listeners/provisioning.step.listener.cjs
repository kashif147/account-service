/**
 * Phase B / P4 - account-service consumer for tenant.provisioning.step.requested.v1. IMPLEMENTED, NOT ACTIVE:
 * it is bound only when PROVISIONING_CONSUMER=on (src/rabbitMQ/index.js -> setupProvisioningStepConsumer); default off.
 *
 * Scope is exactly ONE step type: service account-service, component account-service:grid-system-defaults, action
 * ensure-defaults - not a generic executor. Grid / default configuration ONLY (the templates collection): no finance
 * or business record (payments, journals, credit notes, ledgers) is read or written. Steps of other services are ignored (no write, no result: their own
 * consumer answers them).
 *
 * Before any write ALL must match: envelope tenantId = data.tenantId = x-tenant-id header (internal 24-hex id),
 * stepKeyVersion 2 + canonical psk2 key whose runId / service / component / action equal the payload, and the
 * LOCAL committed manifest: version AND sha256 of its raw bytes. A manifest mismatch never calls
 * ensureTenantDefaults: it answers failed MANIFEST_DIGEST_MISMATCH. On success it calls only
 * ensureTenantDefaults(tenantId, manifestVersion) (insert missing only, skip existing, never update, never
 * tenantless) and answers completed { insertedCount, skippedCount }.
 *
 * Idempotency (not relying on broker exactly-once): the result is first stored in the step-result ledger
 * (first result wins, unique step key + attempt), then published with publishConfirmed using a deterministic
 * eventId; every redelivery re-publishes the STORED result (same id, same counts). Requests that cannot be
 * answered safely (bad tenant / malformed or legacy key: nothing to address a result to) are dropped with a log
 * line - never a write. Only infrastructure failures (DB / broker) throw, so the middleware redelivers.
 * Result payloads: ids, digest, counts or a fixed failure code - never stack traces, error text, tokens, emails,
 * organisation codes, Entra tids or business data.
 */
const fs = require("fs");
const crypto = require("crypto");
const g = require("../../services/tenantGridDefaults.cjs");
const StepResult = require("../../models/provisioningStepResult.model.cjs");

const REQUESTED = "tenant.provisioning.step.requested.v1";
const COMPLETED = "tenant.provisioning.step.completed.v1";
const FAILED = "tenant.provisioning.step.failed.v1";
const SERVICE = "account-service";
const COMPONENT = "account-service:grid-system-defaults";
const ACTION = "ensure-defaults";
const INTERNAL_TENANT_ID = /^[0-9a-f]{24}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STEP_KEY_V2 = /^psk2:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([a-z0-9-]+):([a-z0-9-]+):([a-z0-9-]+)$/;
const DATA_FIELDS = ["runId", "tenantId", "stepKey", "stepKeyVersion", "service", "component", "action", "manifestVersion", "manifestSha256", "attempt", "templateKey", "templateVersion"].sort();

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const resultEventId = (type, stepKey, attempt) => `prov_${sha256(`${type}|${stepKey}|${attempt}`).slice(0, 40)}`;
const log = (event, extra) => console.info("[provisioning-step]", JSON.stringify({ event, ...extra }));

/** The LOCAL committed manifest: version + sha256 of its raw bytes (never the version alone). */
function localManifest(file = g.CANONICAL_PATH) {
  const raw = fs.readFileSync(file);
  return { version: JSON.parse(raw.toString("utf8")).version, sha256: sha256(raw) };
}

const drop = (reason) => { log("provisioning.step.dropped", { reason }); return { outcome: "dropped", reason }; };

/**
 * @param payload  middleware envelope { eventId, eventType, tenantId, data, ... }
 * @param context  { headers, routingKey, ... }
 * @param deps     { publishConfirmed, ensureTenantDefaults, manifest } (injectable for tests)
 */
async function handleProvisioningStepRequested(payload, context = {}, deps = {}) {
  const publishConfirmed = deps.publishConfirmed || ((t, d, o) => require("@projectShell/rabbitmq-middleware").publisher.publishConfirmed(t, d, o));
  const ensure = deps.ensureTenantDefaults || g.ensureTenantDefaults;
  const eventType = payload && payload.eventType;
  if (eventType !== REQUESTED) return drop("not_a_step_request");
  const d = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : null;
  if (!d) return drop("malformed");
  if (d.service !== SERVICE) return { outcome: "ignored", reason: "other_service" }; // another service's step
  if (JSON.stringify(Object.keys(d).sort()) !== JSON.stringify(DATA_FIELDS)) return drop("malformed");
  // tenant triple: envelope = data = header, internal ids only (no fallback, no inference)
  const header = context.headers ? context.headers["x-tenant-id"] : undefined;
  if (![payload.tenantId, d.tenantId].every((t) => typeof t === "string" && INTERNAL_TENANT_ID.test(t)) || payload.tenantId !== d.tenantId || header !== d.tenantId) return drop("tenant_mismatch");
  const key = STEP_KEY_V2.exec(String(d.stepKey));
  if (d.stepKeyVersion !== 2 || !key || key[1] !== d.runId) return drop("invalid_step_key");
  if (!Number.isInteger(d.attempt) || d.attempt < 1 || !Number.isInteger(d.manifestVersion) || typeof d.manifestSha256 !== "string" || !SHA256.test(d.manifestSha256)) return drop("malformed");

  const tenantId = d.tenantId;
  const base = { runId: d.runId, tenantId, stepKey: d.stepKey, service: SERVICE, component: d.component, attempt: d.attempt, manifestSha256: d.manifestSha256 };
  let result;
  // 1. a redelivery re-publishes exactly the stored first result
  const stored = await StepResult.findOne({ stepKey: d.stepKey, attempt: d.attempt }).lean();
  if (stored) {
    if (stored.tenantId !== tenantId) return drop("tenant_mismatch");
    result = { type: stored.resultEventType, eventId: stored.resultEventId, data: stored.data, replay: true };
  } else {
    let type;
    let data;
    if (d.component !== COMPONENT || key[2] !== SERVICE || `${key[2]}:${key[3]}` !== d.component || d.action !== ACTION || key[4] !== ACTION) {
      type = FAILED;
      data = { ...base, failureCode: "STEP_ERROR" }; // addressed to account-service but not the one supported step
    } else {
      const local = (deps.manifest || localManifest)();
      if (d.manifestVersion !== local.version || d.manifestSha256 !== local.sha256) {
        type = FAILED;
        data = { ...base, failureCode: "MANIFEST_DIGEST_MISMATCH" }; // ensureTenantDefaults is NOT called
      } else {
        try {
          const r = await ensure(tenantId, d.manifestVersion);
          type = COMPLETED;
          data = { ...base, insertedCount: r.insertedCount, skippedCount: r.skippedCount };
        } catch (e) {
          const msg = String((e && e.message) || "");
          if (/MongoDB is not connected|ECONN|topology|timed out/i.test(msg)) throw e; // infrastructure: redeliver
          type = FAILED;
          data = { ...base, failureCode: /^refusing:/.test(msg) ? "ANOMALY_REFUSED" : /invalid internal tenant id/.test(msg) ? "TENANT_ID_REJECTED" : /manifest version/.test(msg) ? "MANIFEST_VERSION_UNSUPPORTED" : "STEP_ERROR" };
        }
      }
    }
    const eventId = resultEventId(type, d.stepKey, d.attempt);
    // 2. store before publishing; first result wins (a concurrent delivery reads the winner)
    await StepResult.updateOne(
      { stepKey: d.stepKey, attempt: d.attempt },
      { $setOnInsert: { stepKey: d.stepKey, attempt: d.attempt, tenantId, requestEventId: String(payload.eventId || ""), resultEventType: type, resultEventId: eventId, data, createdAt: new Date(), updatedAt: new Date() } },
      { upsert: true, timestamps: false }
    );
    const winner = await StepResult.findOne({ stepKey: d.stepKey, attempt: d.attempt }).lean();
    result = { type: winner.resultEventType, eventId: winner.resultEventId, data: winner.data, replay: winner.resultEventId !== eventId };
  }
  // 3. confirmed publish; a broker failure throws -> redelivery -> step 1 re-publishes the stored result
  const pub = await publishConfirmed(result.type, result.data, { eventId: result.eventId, tenantId, correlationId: d.stepKey, metadata: { service: SERVICE } });
  if (!pub || pub.success !== true) throw new Error("provisioning result not confirmed by the broker");
  log("provisioning.step.answered", { resultType: result.type, eventId: result.eventId, replay: !!result.replay, failureCode: result.data.failureCode || null });
  return { outcome: result.type === COMPLETED ? "completed" : "failed", eventId: result.eventId, data: result.data, replay: !!result.replay };
}

const QUEUE = "accounts.provisioning.events";

/**
 * Binds the consumer ONLY with PROVISIONING_CONSUMER=on (default / any other value: nothing is created or bound).
 * assertExchangeBindable (src/rabbitMQ/exchangeGuard.js) probes provisioning.events first, so a missing exchange can
 * never close the shared consumer channel.
 */
async function setupProvisioningStepConsumer(consumer, assertExchangeBindable) {
  if (process.env.PROVISIONING_CONSUMER !== "on") return { bound: false };
  await assertExchangeBindable("provisioning.events");
  await consumer.createQueue(QUEUE, { durable: true });
  await consumer.bindQueue(QUEUE, "provisioning.events", [REQUESTED]);
  consumer.registerHandler(REQUESTED, (payload, context) => handleProvisioningStepRequested(payload, context));
  await consumer.consume(QUEUE, { prefetch: 1 });
  return { bound: true, queue: QUEUE };
}

module.exports = { handleProvisioningStepRequested, setupProvisioningStepConsumer, localManifest, resultEventId, QUEUE, EVENT_TYPES: { REQUESTED, COMPLETED, FAILED } };
