/**
 * crmParticipantSnapshot — SalesCRM webhook (read-only). The CRM web app's lead screen asks for a participant's
 * current products, mode and open support tickets, and saves them on its `person` doc.
 *
 *   POST { email, profileids: [] }
 *   auth  Authorization: Bearer <SalesCRM Firebase ID token>   — the signed-in rep, from the browser
 *     or  x-webhook-secret: SALESCRM_WEBHOOK_SECRET             — server to server
 *   → { found, matchedby, profileid, participantmode, customerstatus,
 *       activeproduct: [id], consumedproducts: [id], unconsumedproducts: [id], opentickets: [...] }
 *
 * Paired CRM: starlabs-test ↔ salescrm-test-19, fir-sample-aae4a ↔ salesleadcrm (tokens of any other project fail).
 * Match: the email when exactly one profile has it (a real profile beats test users), else the first existing
 * profileid. Tickets come from `clientissue` (not `participant metadata.customersupport`, which misses new tickets).
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

async function snapshot(db, body) {
  const hit = await findProfile(db, body || {});
  if (!hit) return { found: false };
  const pm = hit.doc.data() || {};
  return {
    found: true,
    matchedby: hit.matchedby,
    profileid: hit.doc.id,
    participantmode: pm.participantmode || null,
    customerstatus: pm.customerstatus || null,
    activeproduct: ids(pm.activeproduct),
    consumedproducts: ids(pm.consumedproducts),
    unconsumedproducts: ids(pm.unconsumedproducts),
    opentickets: await openTickets(db, hit.doc.id),
  };
}

exports.crmParticipantSnapshot = onRequest(
  { secrets: [WEBHOOK_SECRET], cors: CRM_ORIGINS, timeoutSeconds: 30, memory: "256MiB", maxInstances: 10 },
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
