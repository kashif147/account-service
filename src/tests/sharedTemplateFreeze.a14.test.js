// Phase A / A14 - shared (null-tenant) grid default templates are write-frozen (423 GLOBAL_DATA_FROZEN):
// content edits (SU/ASU of any tenant included), pins and deletes. The per-user isDefault preference keeps
// working without saving the shared row; tenant-owned defaults and user templates are unaffected.
// REAL template service; the Template model is an in-memory fake. Run: node --test src/tests/<this file>
import test from "node:test";
import assert from "node:assert";
import Template from "../models/template.model.js";
import service from "../services/grid.filter.template.service.js";
const TEMPLATE_TYPE = "creditnotes";
const UPDATE = (id, data, allow) => service.updateTemplate(id, USER, data, A, allow);
const DELETE = (id) => service.deleteTemplate(id, USER, A);

const A = "68cbf7806080b4621d469d34";
const SHARED = "600000000000000000000001";
const TENANT_DEFAULT = "600000000000000000000002";
const USER_TPL = "600000000000000000000003";
const USER = "700000000000000000000001";

const writes = [];
function mkDoc(fields) {
  const doc = {
    templateType: TEMPLATE_TYPE,
    name: "System default",
    filters: { status: { operator: "equal_to", values: ["Active"] } },
    columns: ["a", "b"],
    columnLabels: { a: "A" },
    visibleFilters: ["status"],
    pinned: false,
    isDefault: false,
    meta: { deleted: false },
    ...fields,
  };
  Object.defineProperty(doc, "toObject", { value() { const o = { ...this }; return JSON.parse(JSON.stringify(o)); } });
  Object.defineProperty(doc, "save", { value: async function () { writes.push(["save", String(this._id)]); return this; } });
  return doc;
}
let store = [];
const reset = () => {
  writes.length = 0;
  store = [
    mkDoc({ _id: SHARED, systemDefault: true, tenantId: null, userId: USER }),
    mkDoc({ _id: TENANT_DEFAULT, systemDefault: true, tenantId: A, userId: USER }),
    mkDoc({ _id: USER_TPL, systemDefault: false, tenantId: A, userId: USER, name: "Mine" }),
  ];
};
const match = (q, d) =>
  (q._id === undefined || String(q._id) === String(d._id)) &&
  (q.systemDefault !== true || d.systemDefault === true) &&
  (q.userId === undefined ||
    (q.userId && Array.isArray(q.userId.$in) ? q.userId.$in.map(String).includes(String(d.userId)) : String(q.userId) === String(d.userId)));
Template.findOne = async (q) => store.find((d) => match(q || {}, d)) || null;
Template.updateMany = async (q, u) => (writes.push(["updateMany(user rows)", JSON.stringify(u)]), { modifiedCount: 0 });
Template.exists = async () => null;

const update = (id, data, allow) => UPDATE(id, data, allow);
const remove = (id) => DELETE(id);
const frozen = async (p) => {
  await assert.rejects(p, (e) => e && e.status === 423 && e.code === "GLOBAL_DATA_FROZEN");
};
const saves = () => writes.filter((w) => w[0] === "save");

test("A14 shared (null-tenant) default: SU content edit -> 423, nothing saved", async () => {
  delete process.env.GLOBAL_DATA_WRITES;
  reset();
  await frozen(update(SHARED, { filters: { status: { operator: "equal_to", values: ["Lapsed"] } } }, true));
  await frozen(update(SHARED, { columns: ["a"] }, true));
  await frozen(update(SHARED, { name: "Renamed" }, true));
  assert.deepStrictEqual(saves(), []);
});

test("A14 shared default: pin / unpin by any user -> 423 (pinned lives on the shared row)", async () => {
  reset();
  await frozen(update(SHARED, { pinned: true }, false));
  await frozen(update(SHARED, { pinned: true }, true));
  assert.deepStrictEqual(saves(), []);
});

test("A14 shared default: per-user isDefault still works; the shared row is never saved", async () => {
  reset();
  const out = await update(SHARED, { isDefault: true }, false);
  assert.strictEqual(out.isDefault, true);
  const outSu = await update(SHARED, { isDefault: true, templateType: TEMPLATE_TYPE.toUpperCase(), pinned: false }, true);
  assert.strictEqual(outSu.isDefault, true);
  assert.deepStrictEqual(saves(), []);
  assert.strictEqual(store[0].isDefault, false, "shared row isDefault unchanged");
});

test("A14 shared default: delete -> 423", async () => {
  reset();
  await frozen(remove(SHARED));
  assert.strictEqual(store[0].meta.deleted, false);
  assert.deepStrictEqual(saves(), []);
});

test("A14 tenant-owned default and user templates keep normal behaviour", async () => {
  reset();
  await update(TENANT_DEFAULT, { columns: ["x"] }, true);
  await update(USER_TPL, { name: "Mine 2", pinned: true }, false);
  await remove(USER_TPL);
  assert.deepStrictEqual(saves().map((w) => w[1]), [TENANT_DEFAULT, USER_TPL, USER_TPL]);
});

test("A14 only GLOBAL_DATA_WRITES=open (exact) reopens the shared row", async () => {
  for (const v of ["", "OPEN", "true", " open"]) {
    reset();
    process.env.GLOBAL_DATA_WRITES = v;
    await frozen(update(SHARED, { columns: ["z"] }, true));
  }
  reset();
  process.env.GLOBAL_DATA_WRITES = "open";
  try {
    await update(SHARED, { columns: ["z"] }, true);
    assert.deepStrictEqual(saves().map((w) => w[1]), [SHARED]);
  } finally {
    delete process.env.GLOBAL_DATA_WRITES;
  }
});
