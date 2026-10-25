// Migration target guard. DEV and UAT share the Atlas cluster / Postgres server but use
// separate databases, so the hostname proves nothing: every migration prints the database it
// actually connected to and refuses to run unless it is an approved database for the target.
//
//   --target-env=dev     default. The database must be a DEV database (name ending in -dev/_dev),
//                        exactly as before; DEPLOYMENT_ENV, when set, must be "dev".
//   --target-env=uat     DEPLOYMENT_ENV must be exactly "uat" AND the database must be one of
//                        UAT_DATABASES below (exact, case-sensitive names for THIS service; never a
//                        pattern or substring match).
//   --expect-db=<name>   required with --apply; must equal the connected database name
// Any other target (production included) is refused: there is no implicit approval.
const DEV_DB_PATTERN = /(^|[-_])dev$/i;
// Approved UAT database(s) of this service (UAT MONGO_URI database name).
const UAT_DATABASES = Object.freeze(["account-service"]);
const TARGET_ENVS = Object.freeze(["dev", "uat"]);

function parseTargetArgs(argv) {
  const get = (k) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3).trim() : "";
  };
  return { expectDb: get("expect-db"), targetEnv: (get("target-env") || "dev").toLowerCase() };
}

function assertMigrationTarget(
  actualDb,
  argv = process.argv.slice(2),
  { apply = argv.includes("--apply"), deploymentEnv = process.env.DEPLOYMENT_ENV } = {}
) {
  const db = String(actualDb || "");
  const { expectDb, targetEnv } = parseTargetArgs(argv);
  const depEnv = deploymentEnv == null ? "" : String(deploymentEnv).trim();
  console.log(`[db-guard] target database: ${db || "<unknown>"} (target-env=${targetEnv}, deployment-env=${depEnv || "<unset>"}, mode=${apply ? "APPLY" : "DRY-RUN"})`);
  if (!TARGET_ENVS.includes(targetEnv)) {
    throw new Error(`[db-guard] refusing: target-env "${targetEnv}" is not approved (dev or uat only)`);
  }
  if (targetEnv === "dev") {
    if (depEnv && depEnv !== "dev") {
      throw new Error(`[db-guard] refusing: target-env dev but DEPLOYMENT_ENV="${depEnv}"`);
    }
    if (!DEV_DB_PATTERN.test(db)) {
      throw new Error(`[db-guard] refusing: "${db}" is not a DEV database (expected a name ending in -dev/_dev)`);
    }
  } else {
    if (depEnv !== "uat") {
      throw new Error(`[db-guard] refusing: target-env uat requires DEPLOYMENT_ENV=uat (got "${depEnv || "<unset>"}")`);
    }
    if (!UAT_DATABASES.includes(db)) {
      throw new Error(`[db-guard] refusing: "${db}" is not an approved UAT database for this service`);
    }
  }
  if (apply && !expectDb) {
    throw new Error("[db-guard] refusing: --apply requires --expect-db=<database name>");
  }
  if (expectDb && expectDb !== db) {
    throw new Error(`[db-guard] refusing: connected to "${db}" but --expect-db="${expectDb}"`);
  }
  return db;
}

export { DEV_DB_PATTERN, UAT_DATABASES, parseTargetArgs, assertMigrationTarget };
