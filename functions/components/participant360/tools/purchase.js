/**
 * purchase — every journey the participant bought (active first), its subscription window, package,
 * and the products inside it with enrollment status.
 *
 * Reads: participant metadata (projection, first) · participantjourneyproduct (record of truth; its
 * participantproducts[] = [{participantproductid, productref}] links to enrollments — see
 * participantproduct.js:267) · participantsproduct · journey / products / package (names, one getAll).
 * journeystatus vocabulary (CF): initiated | ongoing | completed. Product status: not_started | ready | ongoing | completed.
 */
const { C, docsOf, docById, getAllByRef, stripHidden } = require("../collection");
const {
  PARTICIPANT_INPUT_SCHEMA, envelope, emptyEnvelope, parseOptions,
  toIso, toDay, daysUntil, refId, refPath, normalizeStatus, tally, tallyText, plural, sinceFilter,
} = require("../envelope");

const ACTIVE_JOURNEY_STATUS = new Set(["initiated", "ongoing"]);

function nameOf(names, ref) {
  const d = names.get(refPath(ref));
  return d ? d.journey || d.product || d.package || d.name || d.title || null : null;
}

/** statusdate is a Timestamp on some docs and a {status: Timestamp} map on others. */
function projectStatusDate(v) {
  if (v == null) return null;
  if (typeof v.toDate === "function" || v instanceof Date || typeof v.seconds === "number") return toIso(v);
  if (typeof v === "object") {
    const out = {};
    for (const [k, t] of Object.entries(v)) out[k] = toIso(t);
    return out;
  }
  return null;
}

function kindOf(productId, pmd) {
  if (!pmd) return "core";
  if ((pmd.addons || []).includes(productId)) return "addon";
  if ((pmd.gifts || []).includes(productId)) return "gift";
  if ((pmd.bonus || []).includes(productId)) return "bonus";
  return "core";
}

function projectProduct(psp, names, pmd, link = {}) {
  if (!psp) {
    return {
      participantproductid: link.participantproductid || null,
      productref: refPath(link.productref), productname: nameOf(names, link.productref),
      deliverymode: null, deliverytype: null, sequenceorder: null,
      status: "missing_enrollment", statusdate: null, unlimited: false, tentativestart: null,
      subscriptionstart: null, subscriptionend: null, queuevariationid: null, eventref: null, kind: "core",
    };
  }
  const productId = refId(psp.productref);
  return {
    participantproductid: psp.id,
    productref: refPath(psp.productref), productname: nameOf(names, psp.productref),
    deliverymode: psp.deliverymode ?? null, deliverytype: psp.deliverytype ?? null,
    sequenceorder: psp.sequenceorder ?? null,
    status: normalizeStatus(psp.status), statusdate: projectStatusDate(psp.statusdate),
    unlimited: psp.unlimited === true, tentativestart: toIso(psp.tentativestart),
    subscriptionstart: toIso(psp.subscriptionstart), subscriptionend: toIso(psp.subscriptionend),
    queuevariationid: psp.queuevariationid ?? null, eventref: refPath(psp.eventref),
    kind: kindOf(productId, pmd),
  };
}

function subscriptionStatus(startIso, endIso, now) {
  const s = startIso ? new Date(startIso).getTime() : null;
  const e = endIso ? new Date(endIso).getTime() : null;
  if (e != null && e < now.getTime()) return "expired";
  if (s != null && s > now.getTime()) return "future";
  return "active";
}

function projectJourney(pjp, enrollments, names, pmd, linked, now) {
  const products = (pjp.participantproducts || []).map((pp) => {
    const psp = enrollments.get(pp.participantproductid);
    if (psp) linked.add(psp.id);
    return projectProduct(psp, names, pmd, pp);
  }).sort((a, b) => (a.sequenceorder ?? 99) - (b.sequenceorder ?? 99));
  const t = tally(products, "status");
  const start = toIso(pjp.subscriptionstart), end = toIso(pjp.subscriptionend);
  const status = normalizeStatus(pjp.journeystatus);
  const pkgRef = (pjp.participantproducts || []).map((pp) => enrollments.get(pp.participantproductid)?.packageref).find(Boolean);
  return {
    participantjourneyproductid: pjp.id,
    journeyref: refPath(pjp.journeyref), journeyname: nameOf(names, pjp.journeyref),
    journeytype: pjp.journeytype ?? null, journeystatus: status, isActive: ACTIVE_JOURNEY_STATUS.has(status),
    onboarded: pjp.onboarded === true, onboardedtime: toIso(pjp.onboardedtime),
    purchasedate: toIso(pjp.purchasedate), purchaseref: refPath(pjp.purchaseref), salesleadsref: refPath(pjp.salesleadsref),
    paymentplan: pjp.paymentplan ?? null, salesperson: pjp.salesperson ?? null,
    subscriptionstart: start, subscriptionend: end,
    subscriptionStatus: subscriptionStatus(start, end, now), daysRemaining: Math.max(0, daysUntil(end, now) ?? 0),
    package: { packageref: refPath(pkgRef), packagename: nameOf(names, pkgRef) },
    counts: { products: products.length, completed: t.completed || 0, ongoing: t.ongoing || 0, ready: t.ready || 0, not_started: t.not_started || 0, cancelled: t.cancelled || 0, missing_enrollment: t.missing_enrollment || 0 },
    products,
  };
}

function headline(active, past, unlinked, totalJourneys, shown) {
  if (!active.length && !past.length && !unlinked) return "No journey purchase on record for this profile.";
  const parts = [];
  for (const j of active) {
    const sub = j.subscriptionend ? `${toDay(j.subscriptionstart) || "?"} → ${toDay(j.subscriptionend)}, ${j.daysRemaining} days left` : "subscription window unknown";
    parts.push(`Active journey ${j.journeyname || "(unknown)"} (${j.journeystatus}; ${sub}; ${j.products.length ? plural(j.products.length, "product") + ": " + tallyText(tally(j.products, "status")) : "no products"})`);
  }
  if (!active.length) parts.push("No active journey");
  if (past.length) parts.push(`${plural(past.length, "past journey")}: ${tallyText(tally(past, "journeystatus"))}`);
  if (totalJourneys > shown) parts.push(`${totalJourneys - shown} older not shown`);
  if (unlinked) parts.push(`${plural(unlinked, "product enrollment")} not linked to any journey`);
  return parts.join(" · ");
}

/** Pure projection. raw = { pmd, pjps[], psps[], names: Map(path -> doc) } */
function project(raw, opts = {}) {
  const { limit, since, now } = parseOptions(opts);
  const pmd = stripHidden(raw.pmd);
  const enrollments = new Map((raw.psps || []).map((p) => [p.id, p]));
  const linked = new Set();
  let journeys = (raw.pjps || []).map((j) => projectJourney(j, enrollments, raw.names || new Map(), pmd, linked, now));
  journeys.sort((a, b) => (a.isActive !== b.isActive ? (a.isActive ? -1 : 1) : (b.subscriptionstart || "").localeCompare(a.subscriptionstart || "")));
  const total = journeys.length;
  journeys = sinceFilter(journeys, "subscriptionstart", since).slice(0, limit);
  const unlinked = [...enrollments.values()].filter((e) => !linked.has(e.id)).length;
  const active = journeys.filter((j) => j.isActive), past = journeys.filter((j) => !j.isActive);
  const allProducts = journeys.flatMap((j) => j.products);
  const tj = tally(journeys, "journeystatus"), tp = tally(allProducts, "status");
  const a = active[0] || null;

  return envelope({
    now,
    summary: {
      headline: headline(active, past, unlinked, total, journeys.length),
      activeJourneyId: a ? a.participantjourneyproductid : null, activeJourneyName: a ? a.journeyname : null,
      journeystatus: a ? a.journeystatus : null, subscriptionStatus: a ? a.subscriptionStatus : null,
      subscriptionstart: a ? a.subscriptionstart : null, subscriptionend: a ? a.subscriptionend : null,
      daysRemaining: a ? a.daysRemaining : null, packagename: a ? a.package.packagename : null,
      customerstatus: pmd?.customerstatus ?? null, onboarded: a ? a.onboarded : null,
      lastsubscribedjourney: pmd?.lastsubscribedjourney ?? null, lastcompletedjourney: pmd?.lastcompletedjourney ?? null,
      higherorderpurchase: pmd?.higherorderpurchase ?? null,
    },
    counts: {
      total, initiated: tj.initiated || 0, ongoing: tj.ongoing || 0, completed: tj.completed || 0, upgraded: tj.upgraded || 0, cancelled: tj.cancelled || 0,
      expired: journeys.filter((j) => j.subscriptionStatus === "expired").length,
      products: allProducts.length, productsCompleted: tp.completed || 0, productsOngoing: tp.ongoing || 0,
      productsReady: tp.ready || 0, productsNotStarted: tp.not_started || 0, productsCancelled: tp.cancelled || 0,
      addons: allProducts.filter((p) => p.kind === "addon").length,
      unlinkedProducts: unlinked, missingEnrollments: tp.missing_enrollment || 0,
    },
    items: journeys,
  });
}

async function load(profileid, opts = {}) {
  const [pmd, pjps, psps] = await Promise.all([
    docById(C.PMD, profileid),
    docsOf(C.PJP, (c) => c.where("profileid", "==", profileid)),
    docsOf(C.PSP, (c) => c.where("profileid", "==", profileid)),
  ]);
  if (!pjps.length && !psps.length) return emptyEnvelope("No journey purchase on record for this profile.", parseOptions(opts).now);
  const refs = [];
  for (const j of pjps) { refs.push(j.journeyref); for (const pp of j.participantproducts || []) refs.push(pp.productref); }
  for (const e of psps) refs.push(e.productref, e.packageref);
  const names = await getAllByRef(refs);
  return project({ pmd, pjps, psps, names }, opts);
}

module.exports = Object.freeze({
  name: "purchase",
  description: "Every journey the participant bought (active first): subscription window and status, package, and the products in it with enrollment status (not_started | ready | ongoing | completed). NOT for amounts paid or EMI (use finance) or the delivery steps of the running product (use activeProduct).",
  input_schema: PARTICIPANT_INPUT_SCHEMA,
  sources: [C.PMD.name, C.PJP.name, C.PSP.name, C.JOURNEY.name, C.PRODUCTS.name, C.PACKAGE.name],
  handler: (input, ctx = {}) => load(input.profileid, { ...input, now: ctx.now }),
  load, project, ACTIVE_JOURNEY_STATUS,
});
