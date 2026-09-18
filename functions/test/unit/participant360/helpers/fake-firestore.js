/* global jest */
/**
 * In-memory stand-ins for the slice of the Admin SDK that participant360 uses. No firebase package is
 * loaded anywhere: `installFirebaseMocks()` registers jest mocks for `firebase-admin`,
 * `firebase-admin/firestore`, `firebase-functions/v2/https` and `firebase-functions/params`, then the
 * module under test is required fresh (jest.resetModules) so collection.js caches start empty.
 *
 * Supported query surface (what the tools actually call):
 *   db.collection(name).where(f, "=="|"in"|"array-contains", v).orderBy(f, dir).limit(n).get()
 *   db.collection(name).doc(id).get() / .collection(sub)   db.doc(path)   db.getAll(...refs)
 * Seeds are keyed by collection path: { "profile_data": { id: data }, "notifications/uid1/logs": {...} }
 */
class FakeTimestamp {
  constructor(d) { this._ms = new Date(d).getTime(); this.seconds = Math.floor(this._ms / 1000); }
  toDate() { return new Date(this._ms); }
}
const ts = (iso) => new FakeTimestamp(iso);

function keyOf(v) {
  if (v == null) return v;
  if (v instanceof FakeTimestamp) return v._ms;
  if (typeof v === "object" && typeof v.path === "string") return "ref:" + v.path;
  return v;
}
const eq = (a, b) => keyOf(a) === keyOf(b);
const fieldOf = (data, f) => f.split(".").reduce((o, k) => (o == null ? undefined : o[k]), data);

function makeFirestore(seed = {}) {
  const store = new Map();
  for (const [c, docs] of Object.entries(seed)) store.set(c, new Map(Object.entries(docs)));
  const throwOn = new Map(); // collection path -> error message (simulates a failing query)
  const db = {};

  const snapOf = (colPath, id) => {
    const data = store.get(colPath)?.get(id);
    return { id, ref: docRef(`${colPath}/${id}`), exists: data != null, data: () => (data ? { ...data } : undefined), get: (f) => (data ? fieldOf(data, f) : undefined) };
  };
  function docRef(path) {
    const parts = path.split("/"); const id = parts.pop(); const colPath = parts.join("/");
    return { path, id, parent: { path: colPath }, get: async () => snapOf(colPath, id), collection: (sub) => makeQuery(`${path}/${sub}`, []) };
  }
  function makeQuery(colPath, ops) {
    return {
      path: colPath,
      where: (f, op, v) => makeQuery(colPath, [...ops, { t: "where", f, op, v }]),
      orderBy: (f, dir = "asc") => makeQuery(colPath, [...ops, { t: "orderBy", f, dir }]),
      limit: (n) => makeQuery(colPath, [...ops, { t: "limit", n }]),
      doc: (id) => docRef(`${colPath}/${id || "auto_" + Math.random().toString(36).slice(2, 8)}`),
      get: async () => {
        if (throwOn.has(colPath)) throw new Error(throwOn.get(colPath));
        let rows = [...(store.get(colPath) || new Map()).entries()].map(([id, data]) => ({ id, data }));
        for (const o of ops) {
          if (o.t === "where") {
            rows = rows.filter(({ data }) => {
              const val = fieldOf(data, o.f);
              if (o.op === "==") return eq(val, o.v);
              if (o.op === "in") return Array.isArray(o.v) && o.v.some((x) => eq(x, val));
              if (o.op === "array-contains") return Array.isArray(val) && val.some((x) => eq(x, o.v));
              throw new Error(`fake firestore: unsupported op ${o.op}`);
            });
          } else if (o.t === "orderBy") {
            rows.sort((a, b) => { const x = keyOf(fieldOf(a.data, o.f)), y = keyOf(fieldOf(b.data, o.f)); const c = x < y ? -1 : x > y ? 1 : 0; return o.dir === "desc" ? -c : c; });
          } else if (o.t === "limit") rows = rows.slice(0, o.n);
        }
        return { empty: rows.length === 0, size: rows.length, docs: rows.map((r) => snapOf(colPath, r.id)) };
      },
    };
  }
  db.collection = (name) => makeQuery(name, []);
  db.doc = (path) => docRef(path);
  db.getAll = async (...refs) => refs.map((r) => { const colPath = r.parent?.path ?? String(r.path).split("/").slice(0, -1).join("/"); return snapOf(colPath, r.id ?? String(r.path).split("/").pop()); });
  db._store = store;
  db._throwOn = throwOn;
  db._ref = (path) => docRef(path);
  return db;
}

/**
 * Registers the mocks and returns handles. Call BEFORE requiring any participant360 module.
 * @param {{ dbs?: { default?, forms?, watson? }, verifyIdToken?, getUser?, secrets?: Record<string,string> }} o
 */
function installFirebaseMocks(o = {}) {
  jest.resetModules();
  const dbs = { default: o.dbs?.default || makeFirestore(), forms: o.dbs?.forms || makeFirestore(), watson: o.dbs?.watson || makeFirestore() };
  const secrets = new Map(Object.entries(o.secrets || {}));
  const apps = [];
  const authApi = {
    verifyIdToken: o.verifyIdToken || jest.fn(async () => { throw new Error("verifyIdToken not mocked"); }),
    getUser: o.getUser || jest.fn(async () => { throw new Error("getUser not mocked"); }),
    getUserByEmail: o.getUserByEmail || jest.fn(async () => { throw new Error("getUserByEmail not mocked"); }),
  };
  const admin = {
    __fake: true, // marker: proves tests run against the in-memory mock, not the firebase-admin package
    apps,
    initializeApp: jest.fn((opts = {}, name = "[DEFAULT]") => { const app = { name, options: opts }; apps.push(app); return app; }),
    credential: { cert: jest.fn((json) => { if (!json || !json.project_id) throw new Error("cert: invalid service account"); return { __cert: json }; }) },
    auth: jest.fn(() => authApi),
    firestore: Object.assign(jest.fn(() => dbs.default), { FieldValue: { serverTimestamp: () => "SERVER_TS", increment: (n) => ({ __inc: n }) } }),
  };
  const getFirestore = jest.fn((arg) => {
    if (arg === undefined) return dbs.default;
    if (arg === "firestore-forms") return dbs.forms;
    if (arg && arg.name === "watson") return dbs.watson;
    return dbs.default;
  });
  const onRequest = jest.fn((opts, handler) => Object.assign(handler, { __opts: opts }));
  const defineSecret = jest.fn((name) => ({ name, value: () => { if (!secrets.has(name)) throw new Error(`secret ${name} has no value`); return secrets.get(name); } }));

  jest.doMock("firebase-admin", () => admin);
  jest.doMock("firebase-admin/firestore", () => ({ getFirestore }));
  jest.doMock("firebase-functions/v2/https", () => ({ onRequest }));
  jest.doMock("firebase-functions/params", () => ({ defineSecret }));
  return { admin, authApi, dbs, secrets, getFirestore, onRequest, defineSecret };
}

const MOD = "../../../../components/participant360";
const requireFresh = (rel) => require(`${MOD}/${rel}`);

/** Fake express req/res for the onRequest handler. */
function fakeReq({ method = "GET", path = "/", query = {}, body = undefined, headers = {} } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, path, query, body, get: (name) => h[name.toLowerCase()] };
}
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  res.set = jest.fn((k, v) => { res.headers[k] = v; return res; });
  return res;
}

module.exports = { FakeTimestamp, ts, makeFirestore, installFirebaseMocks, requireFresh, fakeReq, fakeRes };
