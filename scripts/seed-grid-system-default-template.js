/**
 * Seed or update a system-default grid template from grid-column-defaults.json.
 *
 * Usage (staging):
 *   node scripts/seed-grid-system-default-template.js --type=creditnotes --env=staging
 *   node scripts/seed-grid-system-default-template.js --type=creditnotes --env=staging --force
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { loadManifest, upsertSystemDefaultTemplate } = require(
  "../../../scripts/seed-grid-system-default-lib.cjs",
);
const Template = (await import("../src/models/template.model.js")).default;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (prefix) => {
    const hit = args.find((a) => a.startsWith(`${prefix}=`));
    return hit ? hit.slice(prefix.length + 1).trim() : "";
  };
  return {
    type: get("--type"),
    tenantId: get("--tenant") || process.env.TENANT_ID || "",
    envName: get("--env") || "staging",
    force: args.includes("--force"),
  };
}

function loadEnv(envName) {
  const envFile = path.join(__dirname, "..", `.env.${envName}`);
  if (!fs.existsSync(envFile)) {
    console.error(`Env file not found: ${envFile}`);
    process.exit(1);
  }
  dotenv.config({ path: envFile, override: true });
  console.log(`Loaded env: ${envFile}`);
}

const { type, tenantId, envName, force } = parseArgs();

if (!type) {
  console.error("Pass --type=<pageKey> (e.g. creditnotes)");
  process.exit(1);
}

loadEnv(envName);

const mongoUri =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.DATABASE_URL ||
  "";

if (!mongoUri) {
  console.error("Set MONGO_URI (or MONGODB_URI) in the env file");
  process.exit(1);
}

const manifest = loadManifest();
const page = manifest.pages?.[type];
if (!page) {
  console.error(
    `Unknown --type=${type}. Keys: ${Object.keys(manifest.pages || {}).join(", ")}`,
  );
  process.exit(1);
}

if (page.service && page.service !== "account-service") {
  console.error(
    `Page ${type} is owned by ${page.service}. Run: node scripts/seed-grid-system-defaults.cjs --type=${type} --env=${envName}${force ? " --force" : ""}`,
  );
  process.exit(1);
}

await mongoose.connect(mongoUri);
console.log("Connected to MongoDB");

try {
  const result = await upsertSystemDefaultTemplate({
    Template,
    page,
    tenantId,
    force,
  });

  console.log(`${result.action} system default template:`, result.id);
  console.log("  templateType:", result.templateType);
  if (page.columns?.length) {
    console.log(
      "  columns:",
      page.columns.filter((c) => c.isGride).length,
    );
  }
} finally {
  await mongoose.disconnect();
}
