/**
 * profileAuthentication — the complete profile + authentication history.
 *
 * Reads: admin.auth().getUser(uid) (Admin SDK only — providers, verified, created / last sign-in) ·
 * profile_data · user_data (uid) · new_user_data (registration) · emailOTPs (by email) · timeline log ·
 * firestore_audit_log (rows about this profile) · FCM_token (devices). uid comes from
 * profile_data.user_ref, else new_user_data.uid.
 */
const { C, col, docsOf, docById, stripHidden, admin } = require("../collection");
const {
  PARTICIPANT_INPUT_SCHEMA, envelope, emptyEnvelope, parseOptions,
  toIso, refId, plural, newestFirst, sinceFilter, tally,
} = require("../envelope");

const first = (...vals) => vals.find((v) => v != null && v !== "") ?? null;

function projectAuth(u) {
  if (!u) return null;
  const md = u.metadata || {};
  return {
    uid: u.uid, email: u.email ?? null, emailVerified: u.emailVerified === true, phoneNumber: u.phoneNumber ?? null,
    providers: (u.providerData || []).map((p) => p.providerId), disabled: u.disabled === true,
    createdAt: toIso(md.creationTime), lastSignInAt: toIso(md.lastSignInTime), lastRefreshAt: toIso(md.lastRefreshTime),
  };
}

function projectHistory(rows, source) {
  return (rows || []).map((r) => ({
    kind: "history", at: toIso(first(r.date, r.created, r.timestamp, r.at, r.activitydate)),
    field: first(r.field, r.fieldpath, r.activityname, r.activity, r.type, r.label), from: r.before ?? r.from ?? r.oldvalue ?? null, to: r.after ?? r.to ?? r.newvalue ?? r.notes ?? null,
    by: first(r.by, r.updatedby, r.source, r.triggerdoc, r.changedby), source,
  }));
}

/** Pure projection. raw = { profile, auth, registration, otps[], timeline[], audit[], devices[] } */
function project(raw, opts = {}) {
  const { limit, since, now } = parseOptions(opts);
  const p = stripHidden(raw.profile) || {};
  const auth = projectAuth(raw.auth);
  const history = [...projectHistory(raw.timeline, "timeline log"), ...projectHistory(raw.audit, "firestore_audit_log"),
    ...(p.created ? [{ kind: "history", at: toIso(p.created), field: "created", from: null, to: toIso(p.created), by: "user_registration", source: "profile_data" }] : [])];
  const otps = (raw.otps || []).map((o) => ({ kind: "otp", at: toIso(first(o.created, o.sentAt, o.date, o.timestamp)), channel: o.channel ?? "email", verified: o.verified === true || o.used === true, verifiedAt: toIso(first(o.verifiedAt, o.usedAt)) }));
  const devices = (raw.devices || []).map((d) => ({ kind: "device", at: toIso(d.last_modified), FCM_id: d.FCM_id ? String(d.FCM_id).slice(0, 8) + "…" : null, device_os: d.device_os ?? null, active: d.active === true }));
  const all = newestFirst([...history, ...otps, ...devices], "at");
  const total = all.length;
  const items = sinceFilter(all, "at", since).slice(0, limit);
  const reg = raw.registration || null;
  const tk = tally(all, "kind");
  return envelope({
    now,
    summary: {
      headline: raw.profile
        ? `${p.name || "(no name)"} <${p.email || "?"}> · uid ${auth?.uid ?? refId(p.user_ref) ?? "?"}${auth ? ` · ${auth.providers.join("/") || "no provider"}${auth.emailVerified ? ", verified" : ", unverified"}${auth.disabled ? ", DISABLED" : ""} · last sign-in ${auth.lastSignInAt?.slice(0, 10) ?? "never"}` : " · no Firebase Auth user"} · profile created ${toIso(p.created)?.slice(0, 10) ?? "?"} · ${devices.filter((d) => d.active).length} active device(s)`
        : "No profile on record for this profileid.",
      uid: auth?.uid ?? refId(p.user_ref) ?? null, profileid: p.profileid ?? p.id ?? null, email: p.email ?? null,
      emailVerified: auth?.emailVerified ?? null, phoneNumber: first(auth?.phoneNumber, p.phonenumber, p.number), providers: auth?.providers ?? [], disabled: auth?.disabled ?? null,
      createdAt: auth?.createdAt ?? toIso(p.created), lastSignInAt: auth?.lastSignInAt ?? null, lastRefreshAt: auth?.lastRefreshAt ?? null,
      registrationStatus: reg?.status ?? null, subscriber: reg?.subscriber ?? null,
      participantmode: p.participantmode ?? null, testuser: p.testuser === true, profileimg: p.profileimg ?? null,
      name: p.name ?? null, countrycode: p.countrycode ?? null, dateofbirth: toIso(p.dateofbirth), activeDevices: devices.filter((d) => d.active).length,
    },
    counts: { total, history: tk.history || 0, otp: tk.otp || 0, otpVerified: otps.filter((o) => o.verified).length, devices: devices.length, devicesActive: devices.filter((d) => d.active).length, providers: auth?.providers.length ?? 0 },
    items,
  });
}

async function load(profileid, opts = {}) {
  const profile = await docById(C.PROFILE, profileid);
  if (!profile) return emptyEnvelope("No profile on record for this profileid.", parseOptions(opts).now);
  const regRows = await docsOf(C.NEW_USER_DATA, (c) => c.where("profileid", "==", profileid).limit(1)).catch(() => []);
  let uid = refId(profile.user_ref) || regRows[0]?.uid || null;
  // test/legacy profiles often have user_ref: null and no new_user_data row — fall back to the Auth user by email
  let authByEmail = null;
  if (!uid && profile.email) { authByEmail = await admin.auth().getUserByEmail(String(profile.email).trim()).catch(() => null); uid = authByEmail?.uid ?? null; }
  const profileRef = col(C.PROFILE).doc(profileid);
  const [auth, otps, timeline, audit, devices] = await Promise.all([
    authByEmail ? authByEmail : uid ? admin.auth().getUser(uid).catch(() => null) : null,
    profile.email ? docsOf(C.EMAIL_OTPS, (c) => c.where("email", "==", profile.email)).catch(() => []) : [],
    docsOf(C.TIMELINE_LOG, (c) => c.where("profileid", "==", profileid)).catch(() => []),
    docsOf(C.AUDIT_LOG, (c) => c.where("profileid", "==", profileid)).catch(() => []),
    Promise.all([
      docsOf(C.FCM_TOKEN, (c) => c.where("profile_ref", "==", profileRef)),
      uid ? docsOf(C.FCM_TOKEN, (c) => c.where("uid", "==", uid)) : [],
    ]).then(([a, b]) => { const s = new Set(); return [...a, ...b].filter((x) => (s.has(x.id) ? false : s.add(x.id))); }),
  ]);
  return project({ profile, auth, registration: regRows[0] || null, otps, timeline, audit, devices }, opts);
}

module.exports = Object.freeze({
  name: "profileAuthentication",
  description: "Complete profile and authentication history: Firebase Auth record (providers, verified, disabled, created, last sign-in), profile_data fields, registration status, OTPs, profile change history and registered devices.",
  input_schema: PARTICIPANT_INPUT_SCHEMA,
  sources: ["auth.getUser", C.PROFILE.name, C.USER_DATA.name, C.NEW_USER_DATA.name, C.EMAIL_OTPS.name, C.TIMELINE_LOG.name, C.AUDIT_LOG.name, C.FCM_TOKEN.name],
  handler: (input, ctx = {}) => load(input.profileid, { ...input, now: ctx.now }),
  load, project,
});
