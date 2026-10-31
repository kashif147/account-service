import mongoose from "mongoose";

const { Schema } = mongoose;

// Transactional-outbox row: written next to the state change it announces, published by
// services/outbox.service.js. eventKey is deterministic (e.g. "pay:{paymentId}:{status}"), so
// re-enqueueing the same fact is a no-op and consumers can dedupe on data.eventKey.
const OutboxEventSchema = new Schema(
  {
    eventKey: { type: String, required: true },
    tenantId: { type: String, required: true },
    routingKey: { type: String, required: true },
    data: { type: Schema.Types.Mixed, required: true },
    correlationId: { type: String },
    status: { type: String, enum: ["PENDING", "PUBLISHED"], default: "PENDING" },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lastError: { type: String },
    publishedAt: { type: Date },
  },
  { timestamps: true, collection: "outboxEvents" },
);

OutboxEventSchema.index({ eventKey: 1 }, { unique: true });
OutboxEventSchema.index({ status: 1, nextAttemptAt: 1 });
// Published rows are kept 30 days for diagnostics.
OutboxEventSchema.index(
  { publishedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 3600, partialFilterExpression: { status: "PUBLISHED" } },
);

export const OutboxEvent =
  mongoose.models.OutboxEvent || mongoose.model("OutboxEvent", OutboxEventSchema);
export default OutboxEvent;
