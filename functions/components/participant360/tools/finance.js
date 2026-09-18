/**
 * finance — EMI plan, total paid, purchase value. Watson project (joined by EMAIL, never by profileid:
 * profileid != Watson participantid). Watson `Participants.pp_*` IS the EMI plan.
 *
 * Reads: watson Participants · ParticipantPurchases · ParticipantPayments · Payment Schedule
 * (all by Watson participantid). Requires the WATSON_SERVICE_ACCOUNT secret; without it the tool
 * returns an empty envelope whose headline says so.
 * Field names amount/mode on payments and amount/status on schedule are read defensively (not yet
 * observed on a real doc — see spec §7).
 */
const { C, docsOf, dbFor } = require("../collection");
const {
  PARTICIPANT_INPUT_SCHEMA, envelope, emptyEnvelope, parseOptions,
  toIso, toDay, daysUntil, refId, normalizeStatus, newestFirst, sinceFilter,
} = require("../envelope");

const num = (...vals) => { for (const v of vals) { const n = Number(v); if (v != null && v !== "" && Number.isFinite(n)) return n; } return 0; };
const first = (...vals) => vals.find((v) => v != null && v !== "") ?? null;

function projectPayment(p) {
  return {
    id: p.id,
    paymentdate: toIso(first(p.paymentdate, p.date, p.paidon, p.created)),
    amount: num(p.amount, p.paidamount, p.paymentamount),
    mode: first(p.paymentmode, p.mode, p.method),
    status: normalizeStatus(first(p.status, p.paymentstatus, "success")),
    installmentNo: first(p.installmentno, p.installmentNo, p.emino) ?? null,
    purchaseid: first(p.purchaseid, refId(p.purchaseref)),
  };
}

function projectSchedule(s, now) {
  const date = toIso(first(s.date, s.duedate, s.installmentdate));
  const raw = normalizeStatus(first(s.status, s.paymentstatus, ""));
  let status = raw;
  if (raw === "not_started" || raw === "pending" || raw === "scheduled") {
    status = date && new Date(date).getTime() < now.getTime() ? "overdue" : "upcoming";
  }
  return {
    date, amount: num(s.amount, s.installmentamount, s.emiamount),
    installmentNo: first(s.installmentno, s.installmentNo, s.emino) ?? null, status,
    purchaseid: first(s.purchaseid, refId(s.purchaseref)),
  };
}

function projectPurchase(pu, payments, schedule, now) {
  const pays = payments.filter((p) => !p.purchaseid || p.purchaseid === pu.id);
  const sch = schedule.filter((s) => !s.purchaseid || s.purchaseid === pu.id);
  const paid = pays.filter((p) => p.status === "success" || p.status === "paid").reduce((a, p) => a + p.amount, 0);
  const value = num(pu.totalPurchaseValue, pu.totalpurchasevalue, pu.purchasevalue, pu.amount);
  return {
    id: pu.id, purchasedate: toIso(pu.purchasedate), purchaselabel: pu.purchaselabel ?? null,
    journeytype: pu.journeytype ?? null, journey: pu.journey ?? null,
    status: pu.cancelled ? "cancelled" : normalizeStatus(first(pu.status, "active")), cancelled: pu.cancelled === true,
    addons: Array.isArray(pu.addons) ? pu.addons : [],
    purchaseValue: value, paid, balance: Math.max(0, value - paid),
    emi: pu.installmentstartdate || pu.installmentatend != null ? {
      installmentstartdate: toIso(pu.installmentstartdate), installmentatend: pu.installmentatend === true,
      installmentAmount: num(pu.installmentamount, pu.emiamount), installmentsPaid: pays.length,
      installmentsDue: sch.filter((s) => s.status === "upcoming" || s.status === "overdue").length,
    } : null,
    downgradeoweus: num(pu.downgradeoweus), upgradefromwatsonpurchaseid: pu.upgradefromwatsonpurchaseid ?? null,
    counts: { payments: pays.length, scheduleUpcoming: sch.filter((s) => s.status === "upcoming").length, schedulePaid: sch.filter((s) => s.status === "paid").length, scheduleOverdue: sch.filter((s) => s.status === "overdue").length },
    payments: newestFirst(pays, "paymentdate"),
    schedule: [...sch].sort((a, b) => (a.date || "").localeCompare(b.date || "")),
  };
}

/** Pure projection. raw = { participant (Watson doc), purchases[], payments[], schedule[] } */
function project(raw, opts = {}) {
  const { limit, since, now } = parseOptions(opts);
  const w = raw.participant || {};
  const payments = (raw.payments || []).map(projectPayment);
  const schedule = (raw.schedule || []).map((s) => projectSchedule(s, now));
  let purchases = (raw.purchases || []).map((pu) => projectPurchase(pu, payments, schedule, now));
  purchases = newestFirst(purchases, "purchasedate");
  const total = purchases.length;
  purchases = sinceFilter(purchases, "purchasedate", since).slice(0, limit);

  const upcoming = schedule.filter((s) => s.status === "upcoming").sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const totalValue = num(w.pp_totalpurchasevalue, purchases.reduce((a, p) => a + p.purchaseValue, 0));
  const totalPaid = num(w.pp_totalpaid, payments.reduce((a, p) => a + (p.status === "success" || p.status === "paid" ? p.amount : 0), 0));
  const balance = num(w.pp_balance, Math.max(0, totalValue - totalPaid));
  const next = upcoming[0] || null;
  const head = raw.participant
    ? `Purchase value ₹${totalValue.toLocaleString("en-IN")}, paid ₹${totalPaid.toLocaleString("en-IN")}, balance ₹${balance.toLocaleString("en-IN")}` +
      (w.pp_status ? ` · EMI ${w.pp_status} (${w.pp_frequency || "?"}, ₹${num(w.pp_installmentamount).toLocaleString("en-IN")}, ${num(w.pp_installmentspaid)} paid / ${num(w.pp_installmentsdue)} due)` : " · no EMI plan") +
      (next ? ` · next due ${toDay(next.date)} ₹${next.amount.toLocaleString("en-IN")}` : "")
    : "No Watson finance record for this email.";

  return envelope({
    now,
    summary: {
      headline: head,
      watsonparticipantid: w.id ?? null, customerstatus: w.customerstatus ?? null, currency: "INR",
      totalPurchaseValue: totalValue, totalPaid, balance,
      emiStatus: w.pp_status ?? null, emiFrequency: w.pp_frequency ?? null,
      installmentAmount: num(w.pp_installmentamount), installmentsPaid: num(w.pp_installmentspaid), installmentsDue: num(w.pp_installmentsdue),
      currentEmi: num(w.currentemi), paymentDay: w.pp_paymentday ?? null,
      nextDueDate: next ? next.date : null, nextDueAmount: next ? next.amount : null, daysUntilNextDue: next ? daysUntil(next.date, now) : null,
      lastPaymentDate: toIso(first(w.lastpaymentdate, w.pp_lastpayment)),
      nachReceived: w.nachrecieved === true, paymentCommitment: w.paymentcommitment ?? null, paymentCommitmentUpdatedAt: toIso(w.paymentcommitmentupdateddate),
      firstpurchasedate: toIso(w.firstpurchasedate), recentpurchasedate: toIso(w.recentpurchasedate),
      billingname: w.billingname ?? null, billingemail: w.billingemail ?? null, billingnumber: w.billingnumber ?? null,
      billingaddress: w.billingaddress ?? null, gstno: w.gstno ?? null, tdsenabled: w.tdsenabled === true,
    },
    counts: {
      total,
      purchasesActive: purchases.filter((p) => p.status === "active").length,
      purchasesCompleted: purchases.filter((p) => p.status === "completed").length,
      purchasesCancelled: purchases.filter((p) => p.cancelled).length,
      payments: payments.length,
      paymentsSuccess: payments.filter((p) => p.status === "success" || p.status === "paid").length,
      paymentsFailed: payments.filter((p) => p.status === "failed").length,
      scheduleUpcoming: upcoming.length,
      schedulePaid: schedule.filter((s) => s.status === "paid").length,
      scheduleOverdue: schedule.filter((s) => s.status === "overdue").length,
    },
    items: purchases,
  });
}

/** Finds the Watson participant by email (then profileid) — returns raw doc or null. */
async function findWatsonParticipant(participant) {
  if (!dbFor(C.W_PARTICIPANTS)) return null;
  if (participant.email) {
    const byEmail = await docsOf(C.W_PARTICIPANTS, (c) => c.where("email", "==", participant.email).limit(1));
    if (byEmail.length) return byEmail[0];
  }
  const byPid = await docsOf(C.W_PARTICIPANTS, (c) => c.where("profileid", "==", participant.profileid).limit(1));
  return byPid[0] || null;
}

async function loadRaw(participant) {
  const w = await findWatsonParticipant(participant);
  if (!w) return null;
  const [purchases, payments, schedule] = await Promise.all([
    docsOf(C.W_PURCHASES, (c) => c.where("participantid", "==", w.id)),
    docsOf(C.W_PAYMENTS, (c) => c.where("participantid", "==", w.id)),
    docsOf(C.W_SCHEDULE, (c) => c.where("participantid", "==", w.id)),
  ]);
  return { participant: w, purchases, payments, schedule };
}

async function load(profileid, opts = {}, ctx = {}) {
  const { now } = parseOptions(opts);
  if (!dbFor(C.W_PARTICIPANTS)) return emptyEnvelope("Finance unavailable: Watson service account not configured.", now);
  const participant = ctx.participant || { profileid, email: null };
  const raw = await loadRaw(participant);
  if (!raw) return emptyEnvelope("No Watson finance record for this participant.", now);
  return project(raw, opts);
}

module.exports = Object.freeze({
  name: "finance",
  description: "EMI plan, total paid, purchase value, balance, next due date and the full purchase / payment / schedule ledger from Watson (finance system). Joined by email. NOT for what products are in the package (use purchase).",
  input_schema: PARTICIPANT_INPUT_SCHEMA,
  sources: [C.W_PARTICIPANTS.name, C.W_PURCHASES.name, C.W_PAYMENTS.name, C.W_SCHEDULE.name],
  handler: (input, ctx = {}) => load(input.profileid, { ...input, now: ctx.now }, ctx),
  load, loadRaw, project, findWatsonParticipant,
});
