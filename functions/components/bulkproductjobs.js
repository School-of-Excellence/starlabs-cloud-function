const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");

/**
 * Bulk Add Products queue processor.
 *
 * The Angular dialog writes chunk docs into `bulkProductJobs/{docid}` (<=100 profileids each,
 * `retry:true`). This trigger attaches the job's single product to every eligible participant,
 * server-side, with one Firestore transaction per participant, then writes the result arrays
 * back to the job doc once at the end.
 *
 * Design: specs/plans/2026-09-22-bulk-add-products-queue.md (in the starlabs-angular repo).
 * - `retry` is the run signal + refire guard: created true, flipped false in the final write.
 * - `processing` + `claimedAt` = a transactional claim so at-least-once delivery can't double-run,
 *   and a crashed run (stale claim) can be re-claimed / manually Reset.
 * - Deterministic participantsproduct id `${jobId}_${profileid}` → attaching is idempotent, so a
 *   retry (or a crash-then-reprocess) never creates a duplicate product.
 */

const STALE_CLAIM_MS = 10 * 60 * 1000;
const ACTIVE_JOURNEY_STATUSES = ["initiated", "ongoing", "completed"];
const PARTICIPANT_CONCURRENCY = 25;

/** Attach the job's product to one participant, atomically. Throws with `.reason` on ineligibility. */
async function attachProductToParticipant(db, job, profileid) {
  const productRef = db.doc(`products/${job.productref}`);
  const packageRef = job.packageref ? db.doc(`package/${job.packageref}`) : null;
  const minimumpayment = job.minimumpayment != null ? job.minimumpayment : 0;
  const ppId = `${job.docid}_${profileid}`; // deterministic → idempotent on retry/reprocess
  const ppRef = db.collection("participantsproduct").doc(ppId);
  const seqRef = db.doc(`participantdeliverysequence/${profileid}`);
  const pmdRef = db.doc(`participant metadata/${profileid}`);

  await db.runTransaction(async (tx) => {
    // ---- READS (all before any write, as Firestore transactions require) ----
    const journeysSnap = await tx.get(
      db
        .collection("participantjourneyproduct")
        .where("profileid", "==", profileid)
        .where("journeystatus", "in", ACTIVE_JOURNEY_STATUSES)
    );
    if (journeysSnap.size === 0) throw reason("no-journey");
    if (journeysSnap.size > 1) throw reason("multiple-journeys");
    const pjpDoc = journeysSnap.docs[0];
    const pjpData = pjpDoc.data();

    // PMD must exist, else the downstream productsdata_to_pmd trigger would throw.
    const pmdSnap = await tx.get(pmdRef);
    if (!pmdSnap.exists) throw reason("no-pmd");

    let jppDoc = null;
    if (pjpData.purchaseref) jppDoc = await tx.get(pjpData.purchaseref);

    const existingPPSnap = await tx.get(
      db.collection("participantsproduct").where("profileid", "==", profileid)
    );
    const seqSnap = await tx.get(seqRef);

    // ---- BUILD ----
    const newProductData = {
      docid: ppId,
      journeyref: pjpData.journeyref || null,
      productref: productRef,
      packageref: packageRef,
      tentativestart: null,
      minimumpayment,
      status: null,
      sequenceorder: existingPPSnap.size,
      subscriptionstart: pjpData.subscriptionstart || null,
      subscriptionend: pjpData.subscriptionend || null,
      unlimited: false,
      profileid,
      deliverytype: null,
    };

    // Delivery sequence: full rebuild from the participant's whole product set (idempotent),
    // preserving any existing per-product `delivery[]` schedule by participantproductid.
    const existingDelivery = {};
    if (seqSnap.exists) {
      for (const item of seqSnap.data().products || []) {
        existingDelivery[item.participantproductid] = item.delivery || [];
      }
    }
    const byId = {};
    existingPPSnap.docs.forEach((d) => {
      const x = d.data();
      byId[x.docid || d.id] = x;
    });
    byId[ppId] = newProductData; // add/overwrite our product — no double-count on reprocess
    const seqProducts = Object.values(byId)
      .sort((a, b) => (a.sequenceorder || 0) - (b.sequenceorder || 0))
      .map((x) => ({
        participantproductid: x.docid,
        productref: x.productref || productRef,
        delivery: existingDelivery[x.docid] || [],
      }));

    // ---- WRITES ----
    tx.set(ppRef, newProductData);

    // participantjourneyproduct: add our product once (dedupe our own id → idempotent)
    const pProducts = (pjpData.participantproducts || []).filter(
      (e) => e.participantproductid !== ppId
    );
    pProducts.push({ participantproductid: ppId, productref: productRef });
    const pRefs = (pjpData.productref || []).slice();
    if (!pRefs.some((r) => r && r.path === productRef.path)) pRefs.push(productRef);
    tx.set(pjpDoc.ref, { participantproducts: pProducts, productref: pRefs }, { merge: true });

    // journeyproductpurchase: mirror the productref list
    if (jppDoc && jppDoc.exists) {
      const jRefs = (jppDoc.data().productref || []).slice();
      if (!jRefs.some((r) => r && r.path === productRef.path)) jRefs.push(productRef);
      tx.set(jppDoc.ref, { productref: jRefs }, { merge: true });
    }

    tx.set(seqRef, { profileid, products: seqProducts }, { merge: true });
  });
}

function reason(code) {
  const e = new Error(code);
  e.reason = code;
  return e;
}

exports.processBulkProductJobs = onDocumentWritten(
  {
    document: "bulkProductJobs/{docid}",
    region: "asia-south1",
    memory: "1GiB",
    timeoutSeconds: 540,
    concurrency: 1,
  },
  async (event) => {
    if (!event.data.after.exists) return null;
    const after = event.data.after.data() || {};
    if (after.retry !== true) return null; // refire guard: only a requested run proceeds

    const db = admin.firestore();
    const jobRef = event.data.after.ref;
    const docid = event.params.docid;

    // ---- CLAIM: exactly one runner; steal a stale (crashed) claim ----
    let claimed = false;
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(jobRef);
        if (!snap.exists) return;
        const j = snap.data();
        if (j.retry !== true) return;
        const claimedMs =
          j.claimedAt && typeof j.claimedAt.toMillis === "function" ? j.claimedAt.toMillis() : 0;
        const isStale = claimedMs > 0 && Date.now() - claimedMs > STALE_CLAIM_MS;
        if (j.processing === true && !isStale) return; // another runner is active
        tx.set(
          jobRef,
          { processing: true, claimedAt: FieldValue.serverTimestamp() },
          { merge: true }
        );
        claimed = true;
      });
    } catch (err) {
      console.error(`processBulkProductJobs claim failed for ${docid}:`, err.message);
      return null;
    }
    if (!claimed) return null;

    // ---- WORK ----
    const jobSnap = await jobRef.get();
    const job = jobSnap.data() || {};
    const profiles = Array.isArray(job.profiles) ? job.profiles : [];
    const failures = Array.isArray(job.failures) ? job.failures : [];
    // profiles non-empty → first run; else drain failures → retry run.
    const isRetryRun = profiles.length === 0 && failures.length > 0;
    const workset = isRetryRun ? failures.map((f) => f.profileid) : profiles;
    const baseSuccess = isRetryRun ? job.success || [] : [];

    const okList = [];
    const failList = [];
    for (let i = 0; i < workset.length; i += PARTICIPANT_CONCURRENCY) {
      const slice = workset.slice(i, i + PARTICIPANT_CONCURRENCY);
      const results = await Promise.all(
        slice.map(async (pid) => {
          try {
            await attachProductToParticipant(db, job, pid);
            return { pid, ok: true };
          } catch (err) {
            return { pid, ok: false, reason: err.reason || String(err.message || err) };
          }
        })
      );
      for (const r of results) {
        if (r.ok) okList.push(r.pid);
        else failList.push({ profileid: r.pid, reason: r.reason });
      }
    }

    // Lean job doc: success holds profileids only; failures hold {profileid, reason} only.
    // No participant metadata and no "createdbyname" are stored — the History UI resolves those
    // at display time from `participant metadata`.
    const finalSuccess = Array.from(new Set([...baseSuccess, ...okList])); // profileids
    const finalFailures = failList; // [{ profileid, reason }]

    await jobRef.set(
      {
        success: finalSuccess,
        failures: finalFailures,
        profiles: [],
        retry: false,
        processing: false,
        claimedAt: null,
      },
      { merge: true }
    );
    console.log(
      `processBulkProductJobs ${docid}: ${okList.length} ok, ${failList.length} failed (retryRun=${isRetryRun})`
    );
    return null;
  }
);
