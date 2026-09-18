/**
 * participant360/collection.js — the ONLY file in this module allowed to touch Firestore handles.
 *
 * Frozen allow-list of collections with the database each one lives in. Collection names with
 * spaces and the multi-database split exist only here; no tool file names a collection directly
 * and no tool accepts a free-text collection/path argument.
 *
 * Databases:
 *   default  — StarLabs (fir-sample-aae4a)
 *   forms    — named database "firestore-forms" (form submissions written by the Flutter app)
 *   watson   — the Watson finance project, opened as a secondary admin app from the
 *              WATSON_SERVICE_ACCOUNT secret (JSON). Absent secret => Watson reads are skipped.
 *
 * There is deliberately NO "atc" branch. `firestore-atc` / atc_* collections are off-limits for
 * anything automated (operator rule) — adding a branch here is a review-blocking change.
 */
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { defineSecret } = require("firebase-functions/params");

/** Declared here, listed in index.js onRequest({ secrets }); .value() is only readable inside a request. */
const WATSON_SERVICE_ACCOUNT = defineSecret("WATSON_SERVICE_ACCOUNT");

if (!admin.apps.length) admin.initializeApp();

const WATSON_APP_NAME = "watson";
let _default = null;
let _forms = null;
let _watson = null;
let _watsonUnavailable = null;

function watsonDb() {
  if (_watson) return _watson;
  if (_watsonUnavailable) return null;
  let raw = null;
  try { raw = WATSON_SERVICE_ACCOUNT.value(); } catch { raw = null; }
  if (!raw) {
    _watsonUnavailable = "WATSON_SERVICE_ACCOUNT secret not set";
    console.warn("[participant360] " + _watsonUnavailable + " — finance/systemBilling return empty");
    return null;
  }
  try {
    const existing = admin.apps.find((a) => a && a.name === WATSON_APP_NAME);
    const app =
      existing ||
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) }, WATSON_APP_NAME);
    _watson = getFirestore(app);
    return _watson;
  } catch (err) {
    _watsonUnavailable = "WATSON_SERVICE_ACCOUNT invalid: " + err.message;
    console.error("[participant360] " + _watsonUnavailable);
    return null;
  }
}

/** Firestore instance for a registry entry, or null when that database is unavailable. */
function dbFor(entry) {
  switch (entry.db) {
    case "forms":
      if (!_forms) _forms = getFirestore("firestore-forms");
      return _forms;
    case "watson":
      return watsonDb();
    default:
      if (!_default) _default = getFirestore();
      return _default;
  }
}

/** CollectionReference for a registry entry, or null when its database is unavailable. */
function col(entry) {
  const db = dbFor(entry);
  return db ? db.collection(entry.name) : null;
}

/** Runs a query built by `build(colRef)`; returns [] when the database is unavailable. */
async function docsOf(entry, build = (c) => c) {
  const c = col(entry);
  if (!c) return [];
  const snap = await build(c).get();
  return snap.docs.map((d) => ({ id: d.id, _path: d.ref.path, ...d.data() }));
}

/** Single document by id; null when missing or database unavailable. */
async function docById(entry, id) {
  const c = col(entry);
  if (!c || !id) return null;
  const snap = await c.doc(String(id)).get();
  return snap.exists ? { id: snap.id, _path: snap.ref.path, ...snap.data() } : null;
}

/**
 * Batch-resolve DocumentReferences (or "collection/id" paths on the default db) in one getAll().
 * @returns {Map<string, object|null>} path -> {id, ...data} | null
 */
async function getAllByRef(refs) {
  const byPath = new Map();
  for (const r of refs) {
    if (!r) continue;
    if (typeof r === "string") {
      if (!byPath.has(r)) byPath.set(r, dbFor(C.PROFILE).doc(r));
    } else if (r.path && !byPath.has(r.path)) {
      byPath.set(r.path, r);
    }
  }
  const out = new Map();
  if (byPath.size === 0) return out;
  const paths = [...byPath.keys()];
  const snaps = await dbFor(C.PROFILE).getAll(...byPath.values());
  snaps.forEach((s, i) => out.set(paths[i], s.exists ? { id: s.id, _path: s.ref.path, ...s.data() } : null));
  return out;
}

const C = Object.freeze({
  // identity / access
  PROFILE: { db: "default", name: "profile_data" },
  USER_DATA: { db: "default", name: "user_data" },
  NEW_USER_DATA: { db: "default", name: "new_user_data" },
  USERS_ROLES: { db: "default", name: "users_roles" },
  EIS_ROLES: { db: "default", name: "eisroles" },
  DASHBOARD: { db: "default", name: "dashboard" },
  FCM_TOKEN: { db: "default", name: "FCM_token" },
  EMAIL_OTPS: { db: "default", name: "emailOTPs" },
  TIMELINE_LOG: { db: "default", name: "timeline log" },
  AUDIT_LOG: { db: "default", name: "firestore_audit_log" },

  // projection
  PMD: { db: "default", name: "participant metadata" },
  PMD_EXCEPTION: { db: "default", name: "participantmetadata exception" },

  // journey / products
  PJP: { db: "default", name: "participantjourneyproduct" },
  PSP: { db: "default", name: "participantsproduct" },
  JOURNEY: { db: "default", name: "journey" },
  PRODUCTS: { db: "default", name: "products" },
  PACKAGE: { db: "default", name: "package" },
  DELIVERY_SEQUENCE: { db: "default", name: "participantdeliverysequence" },
  DELIVERABLES: { db: "default", name: "deliverables" },
  PRODUCT_TO_SEQUENCE: { db: "default", name: "productToDeliverySequence" },
  MODES: { db: "default", name: "modes" },
  HOME_WIDGETS: { db: "default", name: "eiflixhomewidgets" },

  // scheduling
  APPOINTMENTS: { db: "default", name: "appointments" },
  APPOINTMENT_TYPE: { db: "default", name: "appointmenttype" },
  OPENVIDU_ROOM: { db: "default", name: "openviduroom" },

  // queue (token level only — never expands into ATC)
  QUEUE_TOKEN: { db: "default", name: "queue_token" },
  QUEUE_STAGE_LOG: { db: "default", name: "queue stage log" },
  QUEUE_ACTIVITY_LOG: { db: "default", name: "queue activity log" },
  QUEUE_GENERATION: { db: "default", name: "queue generation" },
  QUEUE_VARIATION: { db: "default", name: "queue variation" },
  LIVE_ASSIGNMENT: { db: "default", name: "live assignment" },
  QUEUE_PLANNER: { db: "default", name: "cohorts queue planner" },

  // events
  EVENT_REQUEST: { db: "default", name: "event participation request" },
  EVENT_COLLECTION: { db: "default", name: "event collection" },
  ARENA_EVENTS: { db: "default", name: "arena events" },
  EVENT_ZONES: { db: "default", name: "event zones" },
  ETICKET: { db: "default", name: "e-ticket eligibility" },
  BIG_INVITATION: { db: "default", name: "biginvitation" },
  ARENA_PARTICIPANT: { db: "default", name: "arena participant" },

  // communication
  WATI_LOGS: { db: "default", name: "wati logs" },
  EMAIL_LOGS: { db: "default", name: "email logs" },
  EMAIL_ARCHIVE: { db: "default", name: "email archive" },
  NOTIFICATION_RECORD: { db: "default", name: "notificationrecord" },
  NOTIFICATIONS: { db: "default", name: "notifications" }, // notifications/{uid}/logs/{id}

  // content / recommendation
  CONTENT_ANALYTICS: { db: "default", name: "content analytics" },
  RECOMMENDED_PLAYLIST: { db: "default", name: "recommended mix playlist" },
  PROCEDURE_RECOMMEND: { db: "default", name: "procedure_recommend" },
  PROCEDURES: { db: "default", name: "procedures" },
  EPISODES: { db: "default", name: "episodes" },
  PARTICIPANT_WORKSHOP: { db: "default", name: "participant workshop" },
  TIER_ACCESS: { db: "default", name: "tier access config" },

  // videoask / evolution
  PARTICIPANT_VIDEOASK: { db: "default", name: "participantvideoask" },
  ARENA_VIDEOASK: { db: "default", name: "arenavideoask" },
  LIVE_EVOLUTION: { db: "default", name: "liveevolutionmapping" },
  EVOLUTION_VIDEO: { db: "default", name: "evolutionmappingvideo" },
  AEL_LEVELS: { db: "default", name: "accelerated evolution level" },
  PARTICIPANT_AEL: { db: "default", name: "participant AEL" },
  WISHLIST_LOG: { db: "default", name: "evolutionwishlistlog" },

  // forms (named database)
  FORMS_BY_CLIENT: { db: "forms", name: "formsByClient" },
  QUIZ_BY_CLIENTS: { db: "default", name: "quizbyclients" },

  // finance (Watson project)
  W_PARTICIPANTS: { db: "watson", name: "Participants" },
  W_PURCHASES: { db: "watson", name: "ParticipantPurchases" },
  W_PAYMENTS: { db: "watson", name: "ParticipantPayments" },
  W_SCHEDULE: { db: "watson", name: "Payment Schedule" },
});

/**
 * Keys that must never leave through a tool: the dead Tier-C derived fields on profile_data and
 * everything `atcdata_to_pmd` copies into participant metadata from the ATC database.
 */
const HIDDEN_KEYS = Object.freeze([
  "currentjourney",
  "currentjourneystatus",
  "currentproductstatus",
  "atc",
  "atcdata",
  "atc_alpha",
  "atcsummary",
  "atcstatus",
  "atcmodeltobiglevel",
  "mapatcmodeltobiglevel",
]);

function stripHidden(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  for (const k of Object.keys(out)) {
    if (HIDDEN_KEYS.includes(k) || /^atc/i.test(k)) delete out[k];
  }
  return out;
}

module.exports = { C, col, dbFor, docsOf, docById, getAllByRef, stripHidden, HIDDEN_KEYS, admin, WATSON_SERVICE_ACCOUNT };
