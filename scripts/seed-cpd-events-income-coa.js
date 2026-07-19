/**
 * Seed the Chart-of-Accounts income rows for the two event/course ledger
 * categories (Event Category on the Event form maps 1:1 to these): CPD
 * ("CONTINUOUS_PROFESSIONAL_DEVELOPMENT" ProductType) posts to 4510,
 * Professional Events ("EVENTS" ProductType) posts to 4520. These replace the
 * shared fallback code 4500 (seed-events-income-coa.js) for any Product that
 * events-service auto-links to a category-tagged event - 4500 remains the
 * fallback for products with no incomeAccountCode at all.
 *
 * Usage:
 *   node scripts/seed-cpd-events-income-coa.js --env=staging
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

const CPD_EVENTS_INCOME_ROWS = [
  {
    code: "4510",
    description: "CPD registration income",
    type: "Income",
    isCash: false,
    isClearing: false,
    isMemberTracked: false,
    isRevenue: true,
    isContraRevenue: false,
  },
  {
    code: "4520",
    description: "Professional Events registration income",
    type: "Income",
    isCash: false,
    isClearing: false,
    isMemberTracked: false,
    isRevenue: true,
    isContraRevenue: false,
  },
];

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

  for (const row of CPD_EVENTS_INCOME_ROWS) {
    const result = await CoA.findOneAndUpdate(
      { code: row.code },
      { $setOnInsert: row },
      { upsert: true, new: true },
    );
    console.log("CoA row ensured:", result.toObject());
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Failed to seed CPD/Events income CoA rows:", err);
  process.exit(1);
});
