import mongoose from "mongoose";

const { Schema } = mongoose;

// P5 S3 signed service authority: replay store for x-svc-nonce (middlewares/serviceAuth.middleware.js).
// One row per (caller, nonce), inserted atomically AFTER the signature verifies; the unique index
// makes a second use of the same nonce a duplicate-key error (= replay). Rows expire via the TTL
// index well after the +/-60 s timestamp window, so an expired nonce can never be reused inside the
// window. Holds no secret, signature or request payload - only the caller id, nonce and time.
const ServiceAuthNonceSchema = new Schema(
  {
    caller: { type: String, required: true },
    nonce: { type: String, required: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { collection: "serviceAuthNonces", strict: "throw", versionKey: false },
);
ServiceAuthNonceSchema.index({ caller: 1, nonce: 1 }, { unique: true });
ServiceAuthNonceSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

export default mongoose.models.ServiceAuthNonce || mongoose.model("ServiceAuthNonce", ServiceAuthNonceSchema);
