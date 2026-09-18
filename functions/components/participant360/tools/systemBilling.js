/**
 * systemBilling — past payments and upcoming instalments as one ledger (variant (a): the
 * participant-side ledger derived from Watson). Variant (b) — org-side vendor bills — has no data
 * source in either repo; DECISION PENDING with the operator (spec §7).
 *
 * Reads the same Watson collections as finance and reuses its raw loader.
 */
const { C, dbFor } = require("../collection");
const finance = require("./finance");
const {
  PARTICIPANT_INPUT_SCHEMA, envelope, emptyEnvelope, parseOptions, toDay, daysUntil, newestFirst, sinceFilter, tally,
} = require("../envelope");

const inr = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");

/** Pure projection. raw = same as finance.project input */
function project(raw, opts = {}) {
  const { limit, since, now } = parseOptions(opts);
  const fin = finance.project(raw, { ...opts, limit: 1000, since: null }).data;
  const purchases = fin.items;
  const rows = [];
  for (const pu of purchases) {
    for (const p of pu.payments) rows.push({ kind: "payment", id: p.id, date: p.paymentdate, amount: p.amount, installmentNo: p.installmentNo, purchaseid: pu.id, purchaselabel: pu.purchaselabel, mode: p.mode, status: p.status === "failed" ? "failed" : "paid", paidAt: p.paymentdate, paymentId: p.id });
    for (const s of pu.schedule) if (s.status !== "paid") rows.push({ kind: "payment", id: `sch_${pu.id}_${s.installmentNo ?? s.date}`, date: s.date, amount: s.amount, installmentNo: s.installmentNo, purchaseid: pu.id, purchaselabel: pu.purchaselabel, mode: fin.summary.paymentCommitment, status: s.status, paidAt: null, paymentId: null });
  }
  const all = newestFirst(rows, "date");
  const total = all.length;
  const items = sinceFilter(all, "date", since).slice(0, limit);
  const t = tally(all, "status");
  const upcoming = all.filter((r) => r.status === "upcoming").sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const next = upcoming[0] || null;
  const overdue = all.filter((r) => r.status === "overdue").reduce((a, r) => a + r.amount, 0);
  const lastPaid = all.find((r) => r.status === "paid") || null;
  return envelope({
    now,
    summary: {
      headline: total ? `Paid ${inr(fin.summary.totalPaid)} of ${inr(fin.summary.totalPurchaseValue)}, balance ${inr(fin.summary.balance)}` + (next ? ` · next due ${toDay(next.date)} ${inr(next.amount)} (${daysUntil(next.date, now)} days)` : " · nothing scheduled") + (overdue ? ` · OVERDUE ${inr(overdue)}` : "") : "No billing ledger on record for this participant.",
      currency: "INR", totalPurchaseValue: fin.summary.totalPurchaseValue, totalPaid: fin.summary.totalPaid, balance: fin.summary.balance,
      nextDueDate: next?.date ?? null, nextDueAmount: next?.amount ?? null, daysUntilNextDue: next ? daysUntil(next.date, now) : null,
      overdueAmount: overdue, lastPaidAt: lastPaid?.date ?? null, paymentMode: fin.summary.paymentCommitment ?? lastPaid?.mode ?? null,
      variant: "a:participant-ledger",
    },
    counts: { total, paid: t.paid || 0, upcoming: t.upcoming || 0, overdue: t.overdue || 0, failed: t.failed || 0 },
    items,
  });
}

async function load(profileid, opts = {}, ctx = {}) {
  const { now } = parseOptions(opts);
  if (!dbFor(C.W_PARTICIPANTS)) return emptyEnvelope("Billing unavailable: Watson service account not configured.", now, { variant: "a:participant-ledger" });
  const raw = await finance.loadRaw(ctx.participant || { profileid, email: null });
  if (!raw) return emptyEnvelope("No billing ledger on record for this participant.", now, { variant: "a:participant-ledger" });
  return project(raw, opts);
}

module.exports = Object.freeze({
  name: "systemBilling",
  description: "Billing ledger for the participant: past payments (paid | failed) and upcoming / overdue instalments in one list, with balance and next due. Variant (a) participant ledger — org-side vendor billing (b) is not implemented (no data source).",
  input_schema: PARTICIPANT_INPUT_SCHEMA,
  sources: [C.W_PARTICIPANTS.name, C.W_PURCHASES.name, C.W_PAYMENTS.name, C.W_SCHEDULE.name],
  handler: (input, ctx = {}) => load(input.profileid, { ...input, now: ctx.now }, ctx),
  load, project,
});
