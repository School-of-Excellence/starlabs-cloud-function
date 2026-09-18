/**
 * communication — every WhatsApp (WATI), email (Postmark), push (FCM) and in-app message sent to the
 * participant, with delivery status where the system records it.
 *
 * Reads:
 *   wati logs          — keyed by WhatsApp number (waId / number), NOT profileid  -> matched on phone digits
 *   email archive      — one doc per email sent (profileid; subject, broadcastname, date, sent/delivery/open flags)
 *   email logs         — one row per Postmark EVENT (profileid, emailarchiveid, RecordType Open|Delivery|"", msgstatus, time)
 *   notificationrecord — push audit; profileid[] array-contains                     -> matched on profileid
 *   notifications/{uid}/logs — in-app inbox, subcollection keyed by Firebase uid    -> matched on uid
 *   FCM_token          — devices (profile_ref == profile_data/{profileid})
 * Statuses beyond sent/failed (delivered / read / opened / clicked) exist only where a provider
 * webhook writes them back; they are read if present and never invented.
 */
const { C, col, docsOf } = require("../collection");
const {
  withFilter, envelope, emptyEnvelope, parseOptions,
  toIso, refId, normalizeStatus, plural, newestFirst, sinceFilter, tally, tallyText,
} = require("../envelope");

const first = (...vals) => vals.find((v) => v != null && v !== "") ?? null;
const digits = (s) => String(s || "").replace(/\D/g, "");

function watiStatus(d) {
  const s = normalizeStatus(first(d.status, d.eventtype, d.event, d.laststatus, ""));
  if (/read|seen/.test(s)) return "read";
  if (/deliver/.test(s)) return "delivered";
  if (/fail|error|undeliver/.test(s) || d.failed === true) return "failed";
  return "sent";
}

function emailStatus(d) {
  const s = normalizeStatus(first(d.status, d.recordtype, d.event, ""));
  if (/click/.test(s) || d.clicked === true) return "clicked";
  if (/open/.test(s) || d.opened === true) return "opened";
  if (/bounce|fail|error|reject/.test(s) || d.failed === true) return "failed";
  if (/deliver/.test(s)) return "delivered";
  return "sent";
}

function projectWati(d) {
  return {
    kind: "whatsapp", id: d.id, title: first(d.templateName, d.template_name, d.template, d.broadcastname), message: first(d.text, d.message),
    broadcastname: first(d.broadcastname, d.broadcastName), sentAt: toIso(first(d.sentAt, d.created, d.timestamp, d.date)),
    status: watiStatus(d), statusAt: toIso(first(d.statusAt, d.updated, d.timestamp)),
    totalSent: d.totalSent ?? null, totalFailed: d.totalFailed ?? null, landingpage: null,
  };
}

const EMAIL_RANK = { sent: 0, delivered: 1, opened: 2, clicked: 3, failed: 4 };

/** One email = one `email archive` doc; its `email logs` events (by emailarchiveid) refine status + statusAt. */
function projectEmail(d, events = []) {
  const mine = events.filter((e) => e.emailarchiveid === d.id || (d.postmark_msgid && e.postmark_msgid === d.postmark_msgid));
  let status = emailStatus(d);
  if (d.open === true) status = "opened";
  else if (d.delivery === true && status === "sent") status = "delivered";
  let statusAt = null;
  for (const e of mine) {
    const s = emailStatus({ status: first(e.msgstatus, e.RecordType) });
    if ((EMAIL_RANK[s] ?? 0) >= (EMAIL_RANK[status] ?? 0)) { status = s; statusAt = toIso(first(e.time, e.ReceivedAt)) ?? statusAt; }
  }
  return {
    kind: "email", id: d.id, title: first(d.subject, d.broadcastname, d.templatename, d.templateid), message: null,
    broadcastname: first(d.broadcastname), emailid: first(d.emailid, d.email, d.to, d.Recipient), sentAt: toIso(first(d.date, d.sentAt, d.created, d.time, d.ReceivedAt)),
    status, statusAt, templateid: first(d.templateid, d.postmarktemplateid), events: mine.length,
    createdby: d.createdby ?? null, attachments: Array.isArray(d.attachments) ? d.attachments.map((a) => (typeof a === "string" ? a : a?.name ?? a?.filename ?? null)).filter(Boolean) : [],
  };
}

/** Fallback when there is no archive row: group raw Postmark events by message. */
function emailsFromEvents(events) {
  const byMsg = new Map();
  for (const e of events) {
    const k = e.emailarchiveid || e.postmark_msgid || e.MessageID || e.id;
    if (!byMsg.has(k)) byMsg.set(k, { id: k, templateid: e.templateid, Recipient: e.Recipient, email: e.email, time: e.time, ReceivedAt: e.ReceivedAt, postmark_msgid: e.postmark_msgid, status: "sent" });
  }
  return [...byMsg.values()].map((d) => projectEmail(d, events));
}

function projectPush(d, profileid) {
  // starlabs-test notificationrecord: profilesuccess[] / profilefailed[] (profile ids) + appFCM*/webFCM*/voip* device-level lists
  const arr = (v) => (Array.isArray(v) ? v : []);
  const ok = [...arr(d.profilesuccess), ...arr(d.FCMsuccess), ...arr(d.fcmsuccess), ...arr(d.appFCMSuccess), ...arr(d.webFCMSuccess)];
  const bad = [...arr(d.profilefailed), ...arr(d.FCMfailed), ...arr(d.fcmfailed), ...arr(d.appFCMFailed), ...arr(d.webFCMFailed), ...arr(d.failedlist)];
  const mine = (a) => a.filter((x) => (typeof x === "string" ? x === profileid : refId(x?.profileid ?? x?.profile_ref ?? x) === profileid)).length;
  const hasProfileLists = arr(d.profilesuccess).length || arr(d.profilefailed).length;
  const failedForMe = hasProfileLists ? mine(arr(d.profilefailed)) > 0 && mine(arr(d.profilesuccess)) === 0 : bad.length ? mine(bad) > 0 : d.success === false;
  return {
    kind: "push", id: d.id, title: d.title ?? null, message: d.message ?? null, broadcastname: null,
    sentAt: toIso(d.date), status: failedForMe ? "failed" : "sent", statusAt: null,
    fcmSuccess: ok.length ? mine(ok) : (d.success === true ? 1 : 0), fcmFailed: bad.length ? mine(bad) : (d.success === false ? 1 : 0),
    notificationtype: d.notificationtype ?? null, landingpage: d.landingpage ?? null,
  };
}

function projectInApp(d) {
  return {
    kind: "inApp", id: d.id, title: d.title ?? null, subtitle: d.subtitle ?? null, message: d.message ?? null,
    sentAt: toIso(d.date), status: d.seen === true || d.read === true ? "seen" : "unseen", statusAt: toIso(first(d.seenAt, d.readAt)),
    type: d.type ?? null, sticky: d.sticky === true, notificationimage: d.notificationimage ?? null, landingpage: d.landingpage ?? null,
  };
}

function projectDevice(d) {
  return { FCM_id: d.FCM_id ? String(d.FCM_id).slice(0, 8) + "…" : null, device_os: d.device_os ?? null, active: d.active === true, last_modified: toIso(d.last_modified) };
}

/** Pure projection. raw = { wati[], emailArchive[], emailEvents[], email[] (legacy per-message rows), push[], inApp[], devices[], profileid } */
function project(raw, opts = {}) {
  const { limit, since, now } = parseOptions(opts);
  const channel = opts.channel ? String(opts.channel) : null;
  const events = raw.emailEvents || [];
  const emails = (raw.emailArchive || []).length ? raw.emailArchive.map((d) => projectEmail(d, events)) : (raw.email || []).length ? raw.email.map((d) => projectEmail(d, events)) : emailsFromEvents(events);
  const all = newestFirst([
    ...(raw.wati || []).map(projectWati), ...emails,
    ...(raw.push || []).map((d) => projectPush(d, raw.profileid)), ...(raw.inApp || []).map(projectInApp),
  ], "sentAt");
  let items = channel ? all.filter((i) => i.kind === channel) : all;
  const total = items.length;
  items = sinceFilter(items, "sentAt", since).slice(0, limit);
  const devices = (raw.devices || []).map(projectDevice);
  const byKind = tally(all, "kind"), byStatus = tally(all, "status");
  const lastFailed = all.find((i) => i.status === "failed") || null;
  return envelope({
    now,
    summary: {
      headline: all.length
        ? `${plural(all.length, "message")} (${tallyText(byKind)}); status: ${tallyText(byStatus)}` + (all[0] ? ` · last ${all[0].kind} "${all[0].title || ""}" on ${all[0].sentAt?.slice(0, 10)}` : "") + ` · ${devices.filter((d) => d.active).length} active device(s)`
        : "No communication on record for this profile.",
      lastSentAt: all[0]?.sentAt ?? null, lastChannel: all[0]?.kind ?? null, lastTitle: all[0]?.title ?? null, lastFailedAt: lastFailed?.sentAt ?? null,
      activeDevices: devices.filter((d) => d.active).length, devices,
    },
    counts: {
      total, whatsapp: byKind.whatsapp || 0, email: byKind.email || 0, push: byKind.push || 0, inApp: byKind.inApp || 0,
      sent: all.filter((i) => i.status !== "failed").length, delivered: byStatus.delivered || 0, read: byStatus.read || 0, opened: byStatus.opened || 0, clicked: byStatus.clicked || 0,
      failed: byStatus.failed || 0, unseen: byStatus.unseen || 0,
    },
    items,
  });
}

async function load(profileid, opts = {}, ctx = {}) {
  const p = ctx.participant || {};
  const phone = digits(p.phone);
  const profileRef = col(C.PROFILE).doc(profileid);
  const [wati, emailData, push, devices, inApp] = await Promise.all([
    phone ? Promise.all([
      docsOf(C.WATI_LOGS, (c) => c.where("waId", "==", phone)),
      docsOf(C.WATI_LOGS, (c) => c.where("number", "==", phone)),
    ]).then(([a, b]) => { const s = new Set(); return [...a, ...b].filter((x) => (s.has(x.id) ? false : s.add(x.id))); }) : [],
    Promise.all([
      docsOf(C.EMAIL_ARCHIVE, (c) => c.where("profileid", "==", profileid)).catch(() => []),
      docsOf(C.EMAIL_LOGS, (c) => c.where("profileid", "==", profileid)).catch(() => []),
      p.email ? docsOf(C.EMAIL_LOGS, (c) => c.where("email", "==", p.email)).catch(() => []) : [],
    ]).then(([archive, byPid, byEmail]) => { const s = new Set(); return { archive, events: [...byPid, ...byEmail].filter((x) => (s.has(x.id) ? false : s.add(x.id))) }; }),
    docsOf(C.NOTIFICATION_RECORD, (c) => c.where("profileid", "array-contains", profileid).orderBy("date", "desc").limit(200)).catch(() => docsOf(C.NOTIFICATION_RECORD, (c) => c.where("profileid", "array-contains", profileid))),
    Promise.all([
      docsOf(C.FCM_TOKEN, (c) => c.where("profile_ref", "==", profileRef)),
      p.uid ? docsOf(C.FCM_TOKEN, (c) => c.where("uid", "==", p.uid)) : [],
    ]).then(([a, b]) => { const s = new Set(); return [...a, ...b].filter((x) => (s.has(x.id) ? false : s.add(x.id))); }),
    p.uid ? col(C.NOTIFICATIONS).doc(p.uid).collection("logs").orderBy("date", "desc").limit(200).get().then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))).catch(() => []) : [],
  ]);
  const { archive: emailArchive, events: emailEvents } = emailData;
  if (!wati.length && !emailArchive.length && !emailEvents.length && !push.length && !inApp.length) return emptyEnvelope("No communication on record for this profile.", parseOptions(opts).now, { activeDevices: devices.filter((d) => d.active).length, devices: devices.map(projectDevice) });
  return project({ wati, emailArchive, emailEvents, push, inApp, devices, profileid }, opts);
}

module.exports = Object.freeze({
  name: "communication",
  description: "Every WhatsApp (WATI), email, push notification and in-app message sent to the participant with status (sent | delivered | read | opened | clicked | failed | unseen) and registered devices. Filter channel=whatsapp|email|push|inApp.",
  input_schema: withFilter("channel", { type: "string", enum: ["whatsapp", "email", "push", "inApp"] }),
  sources: [C.WATI_LOGS.name, C.EMAIL_ARCHIVE.name, C.EMAIL_LOGS.name, C.NOTIFICATION_RECORD.name, C.NOTIFICATIONS.name, C.FCM_TOKEN.name],
  handler: (input, ctx = {}) => load(input.profileid, { ...input, now: ctx.now }, ctx),
  load, project,
});
