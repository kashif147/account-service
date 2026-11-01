// Source guard: grid "Save View" system defaults are tenant-owned and are only ever inserted by
// explicit-tenant, insert-only tooling. The retired seed path created shared tenantless defaults and
// overwrote existing (incl. tenant-customised) defaults with --force straight through Mongoose, outside
// the A14 freeze. It must not come back.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
const scriptFiles = walk(path.join(ROOT, "scripts")).filter((f) => /\.(c|m)?js$/.test(f));
const read = (f) => fs.readFileSync(f, "utf8");
const rel = (f) => path.relative(ROOT, f);

test("retired template seed script stays retired", () => {
  expect(fs.existsSync(path.join(ROOT, "scripts/seed-grid-system-default-template.js"))).toBe(false);
});

test("no script uses the tenantless root grid-default seed library or wrapper", () => {
  const offenders = scriptFiles.filter((f) => /seed-grid-system-default-lib|seed-grid-system-defaults\.c?js/.test(read(f)));
  expect(offenders.map(rel)).toEqual([]);
});

test("no script deletes every template (unfiltered deleteMany on templates)", () => {
  const offenders = scriptFiles.filter((f) =>
    /Template\.deleteMany\(\s*\{\s*\}\s*\)|collection\(\s*["']templates["']\s*\)\.deleteMany\(\s*\{\s*\}\s*\)/.test(read(f)),
  );
  expect(offenders.map(rel)).toEqual([]);
});

test("package.json has no template seed script (root wrapper, --force seeding)", () => {
  const scripts = JSON.parse(read(path.join(ROOT, "package.json"))).scripts || {};
  const offenders = Object.entries(scripts).filter(
    ([name, cmd]) => /seed-grid-system-default/.test(cmd) || (/seed/i.test(name) && /--force/.test(cmd)),
  );
  expect(offenders).toEqual([]);
});
