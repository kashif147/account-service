// RabbitMQ target for the node:test suite (used by scripts/test-node-complete.mjs and
// scripts/test/node-test-setup.mjs). The suite never needs a real broker. Every file that asserts on
// publishing stubs `publisher.publish` (or injects `publishConfirmed`) itself. Without a target,
// though, rabbitmq-middleware falls back to amqp://localhost:5672, and a URL inherited from the
// shell could point at a shared broker. So:
//   - if RABBIT_URL / RABBITMQ_URL is set to anything that is not a loopback amqp(s) URL, the run
//     fails before any test starts;
//   - otherwise RABBIT_URL is pinned to PINNED_TEST_RABBIT_URL (loopback, port 1: nothing listens
//     there), so the middleware's localhost:5672 default is never used.
// The preload also blocks the middleware's connect() outright, so no broker is ever contacted.
export const RABBIT_URL_VARS = ["RABBIT_URL", "RABBITMQ_URL"];
export const PINNED_TEST_RABBIT_URL = "amqp://127.0.0.1:1/account-service-node-test";

const isLoopbackHost = (h) => {
  const host = h.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
};

/** Problems with the RabbitMQ env for a test run. Never echoes the URL (it may carry credentials). */
export function rabbitEnvProblems(env = process.env) {
  const problems = [];
  for (const name of RABBIT_URL_VARS) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    let u;
    try {
      u = new URL(value);
    } catch {
      problems.push(`${name} is set but is not a parseable URL`);
      continue;
    }
    if (u.protocol !== "amqp:" && u.protocol !== "amqps:") problems.push(`${name} must be an amqp(s) URL (got scheme ${u.protocol})`);
    else if (!isLoopbackHost(u.hostname)) problems.push(`${name} points at non-loopback host "${u.hostname}"`);
  }
  return problems;
}

export function rabbitEnvMessage(problems) {
  return [
    "account-service node:test: refusing to run with a non-loopback RabbitMQ target.",
    ...problems.map((p) => `  - ${p}`),
    "  Tests must never reach a shared or remote broker. Unset RABBIT_URL / RABBITMQ_URL for the test",
    `  run (the runner pins ${PINNED_TEST_RABBIT_URL}), or point them at a loopback URL.`,
  ].join("\n");
}

/** Returns a copy of env with RABBIT_URL pinned (only when neither variable is set). */
export function pinnedRabbitEnv(env = process.env) {
  const out = { ...env };
  if (!RABBIT_URL_VARS.some((n) => out[n])) out.RABBIT_URL = PINNED_TEST_RABBIT_URL;
  return out;
}
