// node:test reporter for scripts/test-node-complete.mjs: one JSON line per reported test
// result, with the file it came from. Written to a file (--test-reporter-destination), not
// stdout, so the completeness check reads exactly what the parent runner received.
export default async function* eventsReporter(source) {
  for await (const ev of source) {
    if (ev.type !== "test:pass" && ev.type !== "test:fail") continue;
    const d = ev.data;
    const err = d.details?.error;
    yield JSON.stringify({
      k: ev.type === "test:pass" ? "pass" : "fail",
      file: d.file,
      name: d.name,
      nesting: d.nesting,
      suite: d.details?.type === "suite",
      skip: d.skip !== undefined && d.skip !== false,
      todo: d.todo !== undefined && d.todo !== false,
      failureType: err?.failureType,
    }) + "\n";
  }
}
