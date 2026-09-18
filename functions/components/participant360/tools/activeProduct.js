/**
 * activeProduct — every product enrollment with its delivery position; the current one first.
 *
 * Reads: participant metadata (activeproduct/consumedproducts/unconsumedproducts ids) ·
 * participantsproduct · participantdeliverysequence (doc id == profileid, products[]) · deliverables
 * (by participantproductid) · products (names).
 * Product status (CF): not_started | ready | ongoing | completed.
 */
const { C, docsOf, docById, getAllByRef, stripHidden } = require("../collection");
const {
  PARTICIPANT_INPUT_SCHEMA, envelope, emptyEnvelope, parseOptions,
  toIso, refId, refPath, normalizeStatus, tally, tallyText, plural,
} = require("../envelope");

const ORDER = { ongoing: 0, ready: 1, not_started: 2, completed: 3 };

function nextActionFor(p) {
  if (p.status === "completed") return null;
  switch ((p.deliverymode || "").toLowerCase()) {
    case "appointment": return "book appointment";
    case "queue": return "in queue";
    case "event": return "awaiting event approval";
    case "content": return "consume content";
    default: return p.status === "not_started" ? "start product" : "continue product";
  }
}

function projectDeliverable(d) {
  return {
    deliverableid: d.id, type: d.type ?? null, status: normalizeStatus(d.status),
    deliveryref: refPath(d.deliveryref), fileref: Array.isArray(d.fileref) ? d.fileref.map(refPath) : [],
  };
}

/** participantdeliverysequence.products[] entry for this enrollment, matched by participantproductid or productref. */
function sequenceFor(seqDoc, psp) {
  const list = Array.isArray(seqDoc?.products) ? seqDoc.products : [];
  const pid = refId(psp.productref);
  return list.find((s) => s.participantproductid === psp.id || refId(s.productref) === pid || refId(s.sequenceref) === pid) || null;
}

function projectProduct(psp, names, seqDoc, deliverables, pmd) {
  const dls = deliverables.filter((d) => refId(d.participantproductid) === psp.id).map(projectDeliverable);
  const seq = sequenceFor(seqDoc, psp);
  // starlabs-test: products[] = [{ participantproductid, productref, delivery: [] }] — delivery[] holds the steps
  const steps = Array.isArray(seq?.delivery) ? seq.delivery : Array.isArray(seq?.sequence) ? seq.sequence : Array.isArray(seq?.deliverysequence) ? seq.deliverysequence : null;
  const totalSteps = steps ? steps.length : null;
  const currentStep = steps ? steps.filter((s) => normalizeStatus(s?.status) === "completed").length : (dls.length ? dls.filter((d) => d.status === "completed").length : null);
  const status = normalizeStatus(psp.status);
  const nameDoc = names.get(refPath(psp.productref));
  return {
    participantproductid: psp.id, productref: refPath(psp.productref), productname: nameDoc ? nameDoc.product || nameDoc.name || nameDoc.title || null : null,
    deliverymode: psp.deliverymode ?? null, deliverytype: psp.deliverytype ?? null, sequenceorder: psp.sequenceorder ?? null,
    status, statusdate: typeof psp.statusdate?.toDate === "function" ? toIso(psp.statusdate) : (psp.statusdate && typeof psp.statusdate === "object" ? toIso(psp.statusdate[psp.status]) : toIso(psp.statusdate)),
    isCurrent: false,
    isUnconsumed: Array.isArray(pmd?.unconsumedproducts) ? pmd.unconsumedproducts.includes(refId(psp.productref)) || pmd.unconsumedproducts.includes(psp.id) : false,
    delivery: {
      sequenceref: refPath(seq?.sequenceref), deliverypath: seq?.deliverypath ?? psp.deliverymode ?? null,
      currentStep, totalSteps, progressPct: totalSteps ? Math.round((currentStep / totalSteps) * 100) : (status === "completed" ? 100 : null),
    },
    counts: { deliverables: dls.length, completed: dls.filter((d) => d.status === "completed").length },
    deliverables: dls,
  };
}

/** Pure projection. raw = { pmd, psps[], names: Map, sequence, deliverables[] } */
function project(raw, opts = {}) {
  const { limit, now } = parseOptions(opts);
  const pmd = stripHidden(raw.pmd);
  let products = (raw.psps || []).map((p) => projectProduct(p, raw.names || new Map(), raw.sequence, raw.deliverables || [], pmd));
  products.sort((a, b) => (a.sequenceorder ?? 99) - (b.sequenceorder ?? 99));
  const current = products.find((p) => p.status === "ongoing") || products.find((p) => p.status === "ready") || products.find((p) => p.status === "not_started") || null;
  if (current) current.isCurrent = true;
  const total = products.length;
  const items = [...products].sort((a, b) => (a.isCurrent ? -1 : b.isCurrent ? 1 : (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || (a.sequenceorder ?? 99) - (b.sequenceorder ?? 99))).slice(0, limit);
  const t = tally(products, "status");
  const dls = products.flatMap((p) => p.deliverables);
  const nextAction = current ? nextActionFor(current) : null;
  return envelope({
    now,
    summary: {
      headline: total
        ? (current ? `Current product ${current.productname || current.participantproductid} (${current.deliverymode || "?"}, ${current.status}${current.delivery.totalSteps ? `, step ${current.delivery.currentStep}/${current.delivery.totalSteps}` : ""}) — ${nextAction}` : "All products completed") + ` · ${plural(total, "product")}: ${tallyText(t)}`
        : "No product enrollment on record for this profile.",
      currentParticipantproductid: current?.participantproductid ?? null, currentProductName: current?.productname ?? null,
      currentDeliverymode: current?.deliverymode ?? null, currentStatus: current?.status ?? null,
      currentStep: current?.delivery.currentStep ?? null, totalSteps: current?.delivery.totalSteps ?? null,
      nextAction, lastStatusChange: products.map((p) => p.statusdate).filter(Boolean).sort().pop() ?? null,
    },
    counts: {
      total, completed: t.completed || 0, ongoing: t.ongoing || 0, ready: t.ready || 0, not_started: t.not_started || 0, cancelled: t.cancelled || 0,
      unconsumed: products.filter((p) => p.isUnconsumed).length,
      deliverables: dls.length, deliverablesCompleted: dls.filter((d) => d.status === "completed").length,
    },
    items,
  });
}

async function load(profileid, opts = {}) {
  const [pmd, psps, sequence, deliverables] = await Promise.all([
    docById(C.PMD, profileid),
    docsOf(C.PSP, (c) => c.where("profileid", "==", profileid)),
    docById(C.DELIVERY_SEQUENCE, profileid),
    docsOf(C.DELIVERABLES, (c) => c.where("profileid", "==", profileid)),
  ]);
  if (!psps.length) return emptyEnvelope("No product enrollment on record for this profile.", parseOptions(opts).now);
  const names = await getAllByRef(psps.map((p) => p.productref));
  return project({ pmd, psps, names, sequence, deliverables }, opts);
}

module.exports = Object.freeze({
  name: "activeProduct",
  description: "The product the participant is on right now and every other enrollment: delivery mode, status (not_started | ready | ongoing | completed), step position in the delivery sequence, deliverables, and the next action. NOT for journey/subscription (use purchase).",
  input_schema: PARTICIPANT_INPUT_SCHEMA,
  sources: [C.PMD.name, C.PSP.name, C.DELIVERY_SEQUENCE.name, C.DELIVERABLES.name, C.PRODUCTS.name],
  handler: (input, ctx = {}) => load(input.profileid, { ...input, now: ctx.now }),
  load, project,
});
