/**
 * forms — every form submitted (firestore-forms / formsByClient) and still in draft, plus quizzes.
 *
 * The Flutter FillForm writes submissions to the NAMED database "firestore-forms", collection
 * formsByClient (see journal 2026-06-11). Field names on those docs have not been confirmed on a
 * real document, so the projection reads the common spellings defensively. A submission is a
 * "draft" when status/submitted says so; anything else counts as submitted.
 */
const { C, docsOf } = require("../collection");
const {
  withFilter, envelope, emptyEnvelope, parseOptions,
  toIso, refPath, normalizeStatus, plural, newestFirst, sinceFilter,
} = require("../envelope");

const first = (...vals) => vals.find((v) => v != null && v !== "") ?? null;

function isDraft(d) {
  const s = normalizeStatus(first(d.status, d.formstatus));
  if (["draft", "inprogress", "in_progress", "saved", "partial"].includes(s)) return true;
  if (d.submitted === false || d.isdraft === true || d.draft === true) return true;
  return false;
}

function answersCount(d) {
  const a = first(d.answers, d.formdata, d.responses, d.data);
  if (Array.isArray(a)) return a.length;
  if (a && typeof a === "object") return Object.keys(a).length;
  return 0;
}

function projectForm(d) {
  const draft = isDraft(d);
  return {
    kind: "form", docid: d.id,
    formname: first(d.formname, d.formName, d.title, d.name, d.form),
    formref: refPath(first(d.formref, d.deliveryformref, d.deliveryref)),
    status: draft ? "draft" : "submitted",
    productref: refPath(first(d.productref, d.productid)), participantproductid: first(d.participantproductid, d.participantproductref?.id),
    submittedAt: draft ? null : toIso(first(d.submittedon, d.submittedAt, d.submitteddate, d.date, d.created, d.timestamp)),
    lastSavedAt: toIso(first(d.updated, d.updatedAt, d.lastsaved, d.modified, d.submittedon, d.date, d.created)),
    answersCount: answersCount(d), fileref: Array.isArray(d.fileref) ? d.fileref.map(refPath) : [],
  };
}

function projectQuiz(q) {
  return {
    kind: "quiz", docid: q.id,
    formname: first(q.title, q.quizname, q.name), formref: refPath(first(q.quizref, q.quizid)),
    status: "submitted", productref: refPath(q.productref), participantproductid: first(q.participantproductid),
    submittedAt: toIso(first(q.submittedon, q.date, q.created)), lastSavedAt: toIso(first(q.submittedon, q.date, q.created)),
    answersCount: answersCount(q), fileref: [],
    score: q.score ?? null, maxScore: first(q.maxscore, q.maxScore, q.total),
  };
}

/** Pure projection. raw = { forms[], quizzes[] } */
function project(raw, opts = {}) {
  const { limit, since, now } = parseOptions(opts);
  const statusFilter = opts.status ? String(opts.status).toLowerCase() : null;
  let items = [...(raw.forms || []).map(projectForm), ...(raw.quizzes || []).map(projectQuiz)];
  const all = items;
  items = newestFirst(items, "lastSavedAt");
  if (statusFilter) items = items.filter((i) => i.status === statusFilter);
  const total = items.length;
  items = sinceFilter(items, "lastSavedAt", since).slice(0, limit);
  const submitted = all.filter((i) => i.status === "submitted"), drafts = all.filter((i) => i.status === "draft");
  const lastSub = newestFirst(submitted, "submittedAt")[0] || null, lastDraft = newestFirst(drafts, "lastSavedAt")[0] || null;
  const week = now.getTime() - 7 * 86_400_000;
  return envelope({
    now,
    summary: {
      headline: all.length ? `${plural(submitted.length, "form")} submitted, ${plural(drafts.length, "draft")}` + (lastSub ? ` · last submitted ${lastSub.formname || lastSub.docid} on ${lastSub.submittedAt?.slice(0, 10)}` : "") + (lastDraft ? ` · draft ${lastDraft.formname || lastDraft.docid} saved ${lastDraft.lastSavedAt?.slice(0, 10)}` : "") : "No forms on record for this profile.",
      database: "firestore-forms",
      lastSubmittedAt: lastSub?.submittedAt ?? null, lastSubmittedForm: lastSub?.formname ?? null,
      lastDraftSavedAt: lastDraft?.lastSavedAt ?? null, lastDraftForm: lastDraft?.formname ?? null,
      pendingDraftsOlderThan7d: drafts.filter((d) => d.lastSavedAt && new Date(d.lastSavedAt).getTime() < week).length,
    },
    counts: { total, submitted: submitted.length, drafts: drafts.length, quizzes: all.filter((i) => i.kind === "quiz").length, withAttachments: all.filter((i) => i.fileref.length).length },
    items,
  });
}

async function load(profileid, opts = {}) {
  const [forms, quizzes] = await Promise.all([
    docsOf(C.FORMS_BY_CLIENT, (c) => c.where("profileid", "==", profileid)),
    docsOf(C.QUIZ_BY_CLIENTS, (c) => c.where("profileid", "==", profileid)),
  ]);
  if (!forms.length && !quizzes.length) return emptyEnvelope("No forms on record for this profile.", parseOptions(opts).now, { database: "firestore-forms" });
  return project({ forms, quizzes }, opts);
}

module.exports = Object.freeze({
  name: "forms",
  description: "All forms the participant submitted and the ones still in draft (firestore-forms), plus quizzes. Filter status=submitted|draft.",
  input_schema: withFilter("status", { type: "string", enum: ["submitted", "draft"] }),
  sources: [C.FORMS_BY_CLIENT.name, C.QUIZ_BY_CLIENTS.name],
  handler: (input, ctx = {}) => load(input.profileid, { ...input, now: ctx.now }),
  load, project,
});
