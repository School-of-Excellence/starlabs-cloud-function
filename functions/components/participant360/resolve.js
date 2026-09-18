/**
 * participant360/resolve.js — profileid | email | phone -> { profileid, email, name, uid }.
 * Reads profile_data only. Email is the join key to Watson; uid comes from profile_data.user_ref.
 */

const { C, col, docById } = require("./collection");
const { refId } = require("./envelope");

function project(doc) {
  if (!doc) return null;
  return {
    profileid: doc.profileid || doc.id,
    email: doc.email ? String(doc.email).trim().toLowerCase() : null,
    name: doc.name || null,
    phone: doc.phonenumber || doc.number || null,
    uid: refId(doc.user_ref),
  };
}

function looksLikeEmail(s) {
  return typeof s === "string" && /\S+@\S+\.\S+/.test(s);
}

function digits(s) {
  return String(s || "").replace(/\D/g, "");
}

async function byProfileId(profileid) {
  return project(await docById(C.PROFILE, profileid));
}

async function byEmail(email) {
  const c = col(C.PROFILE);
  const snap = await c.where("email", "==", String(email).trim().toLowerCase()).limit(1).get();
  if (snap.empty) {
    // profile_data.email is not always lower-cased in production.
    const raw = await c.where("email", "==", String(email).trim()).limit(1).get();
    if (raw.empty) return null;
    return project({ id: raw.docs[0].id, ...raw.docs[0].data() });
  }
  return project({ id: snap.docs[0].id, ...snap.docs[0].data() });
}

async function byPhone(phone) {
  const c = col(C.PROFILE);
  const d = digits(phone);
  for (const field of ["phonenumber", "number"]) {
    for (const value of [phone, d, "+" + d]) {
      const snap = await c.where(field, "==", value).limit(1).get();
      if (!snap.empty) return project({ id: snap.docs[0].id, ...snap.docs[0].data() });
    }
  }
  return null;
}

/** Tries profileid, then email, then phone. */
async function resolveParticipant(key) {
  if (!key) return null;
  const k = String(key).trim();
  if (looksLikeEmail(k)) return byEmail(k);
  const direct = await byProfileId(k);
  if (direct) return direct;
  if (digits(k).length >= 8) return byPhone(k);
  return null;
}

/** Tool definition so an AI agent can call it like any other tool. */
const resolveTool = Object.freeze({
  name: "resolve",
  description: "Find a participant by profileid, email or phone. Returns { profileid, email, name }. Call this first when you only have an email or phone.",
  input_schema: {
    type: "object",
    properties: { key: { type: "string", description: "profileid, email address or phone number" } },
    required: ["key"],
    additionalProperties: false,
  },
  handler: async ({ key }) => {
    const p = await resolveParticipant(key);
    if (!p) return { ok: false, error: "participant_not_found", key };
    return { ok: true, profileid: p.profileid, email: p.email, name: p.name };
  },
});

module.exports = { resolveParticipant, byProfileId, byEmail, byPhone, resolveTool, project };
