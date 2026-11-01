/**
 * Phase B / P4: account-service's ledger of provisioning step results it has PRODUCED (one per step key +
 * attempt). It makes redelivery converge: the first execution's result (counts / failure code) is stored before
 * the result event is published, and every redelivery of the same request re-publishes exactly that stored
 * result (same eventId, same counts) instead of a recomputed one (a re-run of the idempotent ensure would
 * report inserted 0 / skipped 1, which the orchestrator correctly treats as a CONFLICT, not a duplicate).
 * Bookkeeping only: ids, counts and fixed codes; no tenant business data. Never deleted.
 */
const mongoose = require("mongoose");

const ID = /^[0-9a-f]{24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STEP_KEY = /^psk2:[0-9a-f-]{36}:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+$/;
const RESULT_TYPES = ["tenant.provisioning.step.completed.v1", "tenant.provisioning.step.failed.v1"];

const dataSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, match: UUID },
    tenantId: { type: String, required: true, match: ID },
    stepKey: { type: String, required: true, match: STEP_KEY },
    service: { type: String, required: true, enum: ["account-service"] },
    component: { type: String, required: true, maxlength: 100 },
    attempt: { type: Number, required: true, min: 1 },
    manifestSha256: { type: String, required: true, match: SHA256 },
    insertedCount: { type: Number, min: 0 },
    skippedCount: { type: Number, min: 0 },
    failureCode: { type: String },
  },
  { _id: false, strict: "throw" }
);

const schema = new mongoose.Schema(
  {
    stepKey: { type: String, required: true, match: STEP_KEY, immutable: true },
    attempt: { type: Number, required: true, min: 1, immutable: true },
    tenantId: { type: String, required: true, match: ID, immutable: true },
    requestEventId: { type: String, required: true, maxlength: 128, immutable: true },
    resultEventType: { type: String, required: true, enum: RESULT_TYPES, immutable: true },
    resultEventId: { type: String, required: true, match: /^prov_[0-9a-f]{40}$/, immutable: true },
    data: { type: dataSchema, required: true, immutable: true },
  },
  { timestamps: true, strict: "throw", collection: "provisioningstepresults" }
);
schema.index({ stepKey: 1, attempt: 1 }, { unique: true, name: "uniq_step_attempt_result" });
for (const op of ["deleteOne", "deleteMany", "findOneAndDelete", "updateOne", "updateMany", "findOneAndUpdate", "replaceOne"]) {
  schema.pre(op, function guard(next) {
    // the only allowed write path is the $setOnInsert upsert below (first result wins)
    if (op === "updateOne" && this.getOptions && this.getOptions().upsert && Object.keys(this.getUpdate() || {}).every((k) => k === "$setOnInsert")) return next();
    return next(new Error("provisioning step results are immutable"));
  });
}

module.exports = mongoose.models.ProvisioningStepResult || mongoose.model("ProvisioningStepResult", schema);
