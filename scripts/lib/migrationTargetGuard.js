// Migration target guard (Phase 2B-PARALLEL-2). DEV and UAT share the Atlas cluster /
// Postgres server but use separate databases, so the hostname proves nothing: every
// migration prints the database it actually connected to and refuses to run unless it is
// an approved DEV database. Only --target-env=dev is approved in this phase.
//
//   --expect-db=<name>   required with --apply; must equal the connected database name
//   --target-env=dev     default; anything else is refused
const DEV_DB_PATTERN = /(^|[-_])dev$/i;

function parseTargetArgs(argv) {
  const get = (k) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3).trim() : "";
  };
  return { expectDb: get("expect-db"), targetEnv: (get("target-env") || "dev").toLowerCase() };
}

function assertMigrationTarget(actualDb, argv = process.argv.slice(2), { apply = argv.includes("--apply") } = {}) {
  const db = String(actualDb || "");
  const { expectDb, targetEnv } = parseTargetArgs(argv);
  console.log(`[db-guard] target database: ${db || "<unknown>"} (target-env=${targetEnv}, mode=${apply ? "APPLY" : "DRY-RUN"})`);
  if (targetEnv !== "dev") {
    throw new Error(`[db-guard] refusing: target-env "${targetEnv}" is not approved (DEV only)`);
  }
  if (!DEV_DB_PATTERN.test(db)) {
    throw new Error(`[db-guard] refusing: "${db}" is not a DEV database (expected a name ending in -dev/_dev)`);
  }
  if (apply && !expectDb) {
    throw new Error("[db-guard] refusing: --apply requires --expect-db=<database name>");
  }
  if (expectDb && expectDb !== db) {
    throw new Error(`[db-guard] refusing: connected to "${db}" but --expect-db="${expectDb}"`);
  }
  return db;
}

export { DEV_DB_PATTERN, parseTargetArgs, assertMigrationTarget };
