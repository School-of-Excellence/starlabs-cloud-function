/**
 * crmParticipantSnapshot — SalesCRM webhook (read-only). The CRM web app's lead screen asks for a participant's
 * current products, mode and open support tickets, and saves them on its `person` doc.
 *
 *   POST { email, profileids: [] }
 *   auth  Authorization: Bearer <SalesCRM Firebase ID token>   — the signed-in rep, from the browser
 *     or  x-webhook-secret: SALESCRM_WEBHOOK_SECRET             — server to server
 *   → { found, matchedby, profileid, participantmode, customerstatus,
 *       activeproduct: [id], consumedproducts: [id], unconsumedproducts: [id],
 *       products: { ongoing, consumed, unconsumed: [{ product, journey, journeyname, status, statusdate, productdate }] },
 *       opentickets: [...] }
 *
 * Paired CRM: starlabs-test ↔ salescrm-test-19, fir-sample-aae4a ↔ salesleadcrm (tokens of any other project fail).
 * Match: the email when exactly one profile has it (a real profile beats test users), else the first existing
 * profileid. Tickets come from `clientissue` (not `participant metadata.customersupport`, which misses new tickets).
 * `products` reads `participantsproduct` and groups it the way productsdata_to_pmd fills participant metadata's lists;
 * each entry is shaped like SalesCRM's `person.activeproduct` (journey = package id), plus the package name.
 */
const admin = require("firebase-admin");
const crypto = require("crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const WEBHOOK_SECRET = defineSecret("SALESCRM_WEBHOOK_SECRET");
const CRM_PROJECT = { "starlabs-test": "salescrm-test-19", "fir-sample-aae4a": "salesleadcrm" }[process.env.GCLOUD_PROJECT];
const CRM_ORIGINS = CRM_PROJECT
  ? [new RegExp(`^https://${CRM_PROJECT}\\.(web\\.app|firebaseapp\\.com)$`), /^http:\/\/localhost:\d+$/]
  : false;
// Production keeps one instance warm: a cold start loads every Breakthroughs function (~15 s) while a rep waits.
const MIN_INSTANCES = process.env.GCLOUD_PROJECT === "fir-sample-aae4a" ? 1 : 0;
const PM = "participant metadata";

const ids = (list) => (Array.isArray(list) ? list.filter((id) => typeof id === "string" && id) : []);
const iso = (t) => (t && typeof t.toDate === "function" ? t.toDate().toISOString() : null);
const refId = (v) => (typeof v === "string" ? v.split("/").pop() : v && v.id) || null;

// SalesCRM's Firebase Auth, only to verify its sign-in tokens (needs no credentials of that project).
let crmAuth;
const verifyCrmToken = (token) => (crmAuth ||= admin.initializeApp({ projectId: CRM_PROJECT }, "salescrm").auth()).verifyIdToken(token);

async function authorized(req, secret = WEBHOOK_SECRET.value(), verify = verifyCrmToken) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
  if (bearer) return CRM_PROJECT ? verify(bearer[1]).then(() => true, () => false) : false;
  const got = Buffer.from(String(req.get("x-webhook-secret") || ""));
  const want = Buffer.from(String(secret || ""));
  return want.length > 0 && got.length === want.length && crypto.timingSafeEqual(got, want);
}

async function findProfile(db, { email, profileids }) {
  if (typeof email === "string" && email.includes("@")) {
    const snap = await db.collection(PM).where("email", "in", [...new Set([email, email.toLowerCase()])]).limit(10).get();
    const real = snap.docs.filter((d) => d.get("testuser") !== true);
    const hits = real.length ? real : snap.docs;
    if (hits.length === 1) return { doc: hits[0], matchedby: "email" };
  }
  const list = ids(profileids).slice(0, 5);
  if (!list.length) return null;
  const doc = (await db.getAll(...list.map((id) => db.collection(PM).doc(id)))).find((d) => d.exists);
  return doc ? { doc, matchedby: "profileid" } : null;
}

async function openTickets(db, profileid) {
  const snap = await db.collection("clientissue").where("clientid", "==", profileid).get();
  const open = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((t) => String((t.status && t.status.status) || "").toLowerCase() !== "closed")
    .sort((a, b) => (b.reporteddate?.toMillis?.() || 0) - (a.reporteddate?.toMillis?.() || 0))
    .slice(0, 50);

  const journeyIds = [...new Set(open.map((t) => refId(t.journey)).filter(Boolean))];
  const journeys = journeyIds.length ? await db.getAll(...journeyIds.map((id) => db.collection("journey").doc(id))) : [];
  const journeyName = Object.fromEntries(journeys.filter((j) => j.exists).map((j) => [j.id, j.get("journey") || null]));

  return open.map((t) => ({
    id: t.id,
    ticketno: t.issueno ?? null,
    category: t.category || null,
    subcategory: t.subcategory || null,
    issue: t.issue ? String(t.issue).slice(0, 500) : null,
    status: (t.status && t.status.status) || null,
    chatstatus: t.chatstatus || null,
    priority: t.priority || null,
    reporteddate: iso(t.reporteddate),
    lastupdated: iso(t.last_modification),
    journey: journeyName[refId(t.journey)] || null,
  }));
}

/** participantsproduct status → participant metadata list (null: not listed there, e.g. cancelled or shifted). */
const productGroup = (status) =>
  status == null ? "unconsumed" : status === "completed" ? "consumed" : ["initiated", "ongoing"].includes(status) ? "ongoing" : null;

async function productDetails(db, profileid) {
  const snap = await db.collection("participantsproduct").where("profileid", "==", profileid).get();
  const docs = snap.docs.slice().sort((a, b) => (a.get("sequenceorder") ?? 0) - (b.get("sequenceorder") ?? 0));

  const packageIds = [...new Set(docs.map((d) => refId(d.get("packageref"))).filter(Boolean))];
  const packages = packageIds.length ? await db.getAll(...packageIds.map((id) => db.collection("package").doc(id))) : [];
  const packageName = Object.fromEntries(packages.filter((p) => p.exists).map((p) => [p.id, p.get("package") || null]));

  const out = { ongoing: [], consumed: [], unconsumed: [] };
  for (const d of docs) {
    const p = d.data();
    const group = productGroup(p.status);
    const product = refId(p.productref);
    if (!group || !product) continue;
    const statusdate = Object.fromEntries(
      Object.entries(p.statusdate || {}).map(([k, v]) => [k, iso(v) || (typeof v === "string" ? v : null)]),
    );
    const latest = Object.values(statusdate).filter(Boolean).sort().pop() || null;
    out[group].push({
      product,
      journey: refId(p.packageref),
      journeyname: packageName[refId(p.packageref)] || null,
      status: p.status ?? null,
      statusdate,
      // When the current status was set; else the latest status change; else when the product was added.
      productdate: statusdate[p.status] || latest || iso(d.createTime),
    });
  }
  return out;
}

async function snapshot(db, body) {
  const hit = await findProfile(db, body || {});
  if (!hit) return { found: false };
  const pm = hit.doc.data() || {};
  const [products, opentickets] = await Promise.all([productDetails(db, hit.doc.id), openTickets(db, hit.doc.id)]);
  return {
    found: true,
    matchedby: hit.matchedby,
    profileid: hit.doc.id,
    participantmode: pm.participantmode || null,
    customerstatus: pm.customerstatus || null,
    activeproduct: ids(pm.activeproduct),
    consumedproducts: ids(pm.consumedproducts),
    unconsumedproducts: ids(pm.unconsumedproducts),
    products,
    opentickets,
  };
}

exports.crmParticipantSnapshot = onRequest(
  { secrets: [WEBHOOK_SECRET], cors: CRM_ORIGINS, timeoutSeconds: 30, memory: "256MiB", minInstances: MIN_INSTANCES, maxInstances: 10 },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    if (!(await authorized(req))) return res.status(401).json({ error: "Unauthorized" });
    try {
      res.json(await snapshot(admin.firestore(), req.body));
    } catch (e) {
      console.error("crmParticipantSnapshot", e);
      res.status(500).json({ error: "Failed" });
    }
  },
);

exports._snapshot = snapshot;
exports._authorized = authorized;
