/**
 * One-off migration for Payment's two sparse compound unique indexes (see
 * payment.model.js): {tenantId, "stripe.paymentIntentId"} and {tenantId,
 * idempotencyKey}. Both were `sparse: true` only, which excludes documents
 * where the field is MISSING but not documents where it's explicitly
 * `null` - once any single Payment ends up with e.g. idempotencyKey: null
 * stored literally, every subsequent Payment insert that also omits an
 * idempotency key (the normal case for events/course registration payments,
 * which never send one) collides with that same null value under the
 * unique constraint. Fixed by adding partialFilterExpression requiring the
 * field to actually be a string, so multiple missing/null values never
 * collide - see the updated index definitions in payment.model.js.
 *
 * Usage:
 *   node scripts/migrate-payment-idempotency-index.js --env=staging
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const Payment = (await import("../src/models/payment.model.js")).default;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (prefix) => {
    const hit = args.find((a) => a.startsWith(`${prefix}=`));
    return hit ? hit.slice(prefix.length + 1).trim() : "";
  };
  return { envName: get("--env") || "staging" };
}

function loadEnv(envName) {
  const envFile = path.join(__dirname, "..", `.env.${envName}`);
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile, override: true });
    console.log(`Loaded env: ${envFile}`);
  } else {
    console.warn(`Env file not found: ${envFile} (relying on process env)`);
  }
}

async function main() {
  const { envName } = parseArgs();
  loadEnv(envName);

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DATABASE_URL || "";
  if (!mongoUri) {
    console.error("Set MONGO_URI (or MONGODB_URI) in the env file");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");

  const collection = Payment.collection;
  const existing = await collection.indexes();
  for (const spec of existing) {
    const keys = Object.keys(spec.key || {});
    const isPaymentIntentIdx = keys.join(",") === "tenantId,stripe.paymentIntentId";
    const isIdempotencyIdx = keys.join(",") === "tenantId,idempotencyKey";
    if (isPaymentIntentIdx || isIdempotencyIdx) {
      console.log(`Dropping index ${spec.name}`);
      await collection.dropIndex(spec.name);
    }
  }

  // Recreate from the current schema definition (already updated to use
  // partialFilterExpression instead of plain sparse).
  await Payment.syncIndexes();
  console.log("Recreated indexes from current schema");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
