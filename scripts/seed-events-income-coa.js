/**
 * Seed the Chart-of-Accounts row for events/courses registration income.
 * Per-tenant existing codes are reused for everything else (assets, clearing,
 * liabilities - see account-service.coas.md): 1210/1220 clearing, 1400 AR,
 * 2020 Payment on Account, 4900 contra-income (comp write-offs). Only Income
 * needs a new code, since 4000-4090 is reserved for membership subscription
 * categories.
 *
 * Usage:
 *   node scripts/seed-events-income-coa.js --env=staging
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CoA = (await import("../src/models/coa.model.js")).default;

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

const EVENTS_INCOME_ROW = {
  code: "4500",
  description: "Events & Courses registration income",
  type: "Income",
  isCash: false,
  isClearing: false,
  isMemberTracked: false,
  isRevenue: true,
  isContraRevenue: false,
};

async function main() {
  const { envName } = parseArgs();
  loadEnv(envName);

  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error("MONGODB_URI (or MONGO_URI) is not set");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");

  const result = await CoA.findOneAndUpdate(
    { code: EVENTS_INCOME_ROW.code },
    { $setOnInsert: EVENTS_INCOME_ROW },
    { upsert: true, new: true },
  );
  console.log("CoA row ensured:", result.toObject());

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Failed to seed events income CoA row:", err);
  process.exit(1);
});
