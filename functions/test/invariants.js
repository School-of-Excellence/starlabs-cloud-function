/**
 * READ-ONLY data-invariant validation script for the firestore-atc database.
 *
 * CRITICAL: This script performs ONLY read operations (.get()/.count()/.select()).
 * It NEVER writes, updates, or deletes any Firestore document. It runs against
 * live PRODUCTION data.
 *
 * Run from the functions dir:  timeout 120 node test/invariants.js
 */

"use strict";

const path = require("path");
const admin = require("firebase-admin");

const DEFAULT_KEY_PATH =
  "/home/gokulhavinash/a_and_h_office_projects/ai_scripts_for_starlabs/starlabsprodwithatcaccess.json";

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || DEFAULT_KEY_PATH;

// Tunables (mirror production thresholds)
const stuckProcessingMinutes = 30;
const flushWaitMinutes = 120; // 2h (matches DEFAULT_FLUSH_WAIT_MINUTES in runpod_ai.js)

function toDateSafe(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") {
    try {
      return v.toDate();
    } catch (_) {
      return null;
    }
  }
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  if (typeof v === "string") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function minutesAgo(date, now) {
  return (now - date.getTime()) / 60000;
}

(async () => {
  const results = []; // { name, label, pass, detail }
  let hardFail = false;

  try {
    const sa = require(path.resolve(keyPath));
    admin.initializeApp({ credential: admin.credential.cert(sa) });

    const { getFirestore } = require("firebase-admin/firestore");
    const def = getFirestore();
    const atc = getFirestore("firestore-atc");

    // ---- Load the queue_atc_generation collection ONCE with a projection ----
    const snap = await atc
      .collection("queue_atc_generation")
      .select(
        "type",
        "profileid",
        "queue_token_id",
        "stage",
        "status",
        "startedAt",
        "createdAt",
        "queueref",
        "sourceref",
        "overall_verdict"
      )
      .get();

    const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    const now = Date.now();

    console.log(`Loaded ${docs.length} docs from queue_atc_generation (firestore-atc).\n`);

    // ---------------------------------------------------------------
    // INV.1 — rubrics scoring dedup on
    //         ${queueref.path}|${profileid}|${queue_token_id}|${stage}
    // ---------------------------------------------------------------
    {
      const groups = new Map(); // key -> [ids]
      for (const { id, data } of docs) {
        if (data.type !== "rubrics scoring") continue;
        const qrefPath =
          data.queueref && typeof data.queueref.path === "string"
            ? data.queueref.path
            : "";
        const key = `${qrefPath}|${data.profileid}|${data.queue_token_id}|${data.stage}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(id);
      }
      const dups = [...groups.entries()].filter(([, ids]) => ids.length > 1);
      const pass = dups.length === 0;
      let detail = "";
      if (!pass) {
        const sample = dups
          .slice(0, 10)
          .map(([k, ids]) => `[${k}] => ${ids.join(",")}`)
          .join("  ;  ");
        detail = `(${dups.length} duplicate groups): ${sample}`;
        hardFail = true;
      }
      results.push({ name: "INV.1", label: "rubrics dedup", pass, detail });
    }

    // ---------------------------------------------------------------
    // INV.2 — checkpoint report dedup on sourceref.path
    // ---------------------------------------------------------------
    {
      const groups = new Map();
      for (const { id, data } of docs) {
        if (data.type !== "checkpoint report") continue;
        const srefPath =
          data.sourceref && typeof data.sourceref.path === "string"
            ? data.sourceref.path
            : "";
        if (!srefPath) continue; // can't dedup on a missing key
        if (!groups.has(srefPath)) groups.set(srefPath, []);
        groups.get(srefPath).push(id);
      }
      const dups = [...groups.entries()].filter(([, ids]) => ids.length > 1);
      const pass = dups.length === 0;
      let detail = "";
      if (!pass) {
        const sample = dups
          .slice(0, 10)
          .map(([k, ids]) => `[${k}] => ${ids.join(",")}`)
          .join("  ;  ");
        detail = `(${dups.length} duplicate groups): ${sample}`;
        hardFail = true;
      }
      results.push({ name: "INV.2", label: "checkpoint dedup", pass, detail });
    }

    // ---------------------------------------------------------------
    // INV.3 — no processing doc with startedAt older than 30 min
    // ---------------------------------------------------------------
    {
      const offenders = [];
      for (const { id, data } of docs) {
        if (data.status !== "processing") continue;
        const started = toDateSafe(data.startedAt);
        if (!started) {
          // processing but no startedAt is itself suspicious -> treat as offender
          offenders.push(`${id}(no startedAt)`);
          continue;
        }
        if (minutesAgo(started, now) > stuckProcessingMinutes) {
          offenders.push(`${id}(${minutesAgo(started, now).toFixed(1)}m)`);
        }
      }
      const pass = offenders.length === 0;
      let detail = "";
      if (!pass) {
        detail = `(${offenders.length} stuck): ${offenders.slice(0, 10).join(", ")}`;
        hardFail = true;
      }
      results.push({ name: "INV.3", label: "no stuck processing", pass, detail });
    }

    // ---------------------------------------------------------------
    // INV.4 — queueref integrity (informational)
    // ---------------------------------------------------------------
    {
      const relevantTypes = new Set(["form", "zoom", "rubrics", "rubrics scoring"]);
      let total = 0;
      let withQueueref = 0;
      const missingRelevant = [];
      let samplePath = "";
      let sampleDbId = "";
      for (const { id, data } of docs) {
        total++;
        const qref = data.queueref;
        if (qref && typeof qref.path === "string" && qref.path) {
          withQueueref++;
          if (!samplePath) {
            samplePath = qref.path;
            try {
              const dbId =
                qref.firestore &&
                qref.firestore._databaseId &&
                String(qref.firestore._databaseId);
              if (dbId) sampleDbId = dbId;
            } catch (_) {
              /* ignore */
            }
          }
        } else if (relevantTypes.has(data.type)) {
          missingRelevant.push(id);
        }
      }
      // Informational invariant: PASS unless a relevant-type doc is missing queueref.
      const pass = missingRelevant.length === 0;
      let detail = `queueref present on ${withQueueref}/${total} docs; sample path="${samplePath}"`;
      if (sampleDbId) detail += `; sample db=${sampleDbId}`;
      if (!pass) {
        detail += ` | MISSING on relevant types (${missingRelevant.length}): ${missingRelevant
          .slice(0, 10)
          .join(", ")}`;
        // Informational per spec: do NOT mark hardFail.
      }
      results.push({
        name: "INV.4",
        label: "queueref integrity (info)",
        pass,
        detail,
        informational: true,
      });
    }

    // ---------------------------------------------------------------
    // INV.5 — completed rubrics scoring must have non-empty overall_verdict
    // ---------------------------------------------------------------
    {
      const offenders = [];
      for (const { id, data } of docs) {
        if (data.type !== "rubrics scoring") continue;
        if (data.status !== "completed") continue;
        const v = data.overall_verdict;
        const empty =
          v === undefined ||
          v === null ||
          (typeof v === "string" && v.trim() === "") ||
          (Array.isArray(v) && v.length === 0) ||
          (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
        if (empty) offenders.push(id);
      }
      const pass = offenders.length === 0;
      let detail = "";
      if (!pass) {
        detail = `(${offenders.length} missing overall_verdict): ${offenders
          .slice(0, 10)
          .join(", ")}`;
        hardFail = true;
      }
      results.push({ name: "INV.5", label: "completed rubrics verdict", pass, detail });
    }

    // ---------------------------------------------------------------
    // INV.6 — backlog drain check
    // ---------------------------------------------------------------
    {
      let oldestPending = null;
      let oldestId = null;
      for (const { id, data } of docs) {
        if (data.status !== "pending") continue;
        const c = toDateSafe(data.createdAt);
        if (!c) continue;
        if (oldestPending === null || c.getTime() < oldestPending.getTime()) {
          oldestPending = c;
          oldestId = id;
        }
      }

      if (oldestPending === null) {
        results.push({
          name: "INV.6",
          label: "backlog draining",
          pass: true,
          detail: "no pending docs",
        });
      } else {
        const ageMin = minutesAgo(oldestPending, now);
        let detail = `oldest pending=${oldestId} age=${ageMin.toFixed(1)}m`;

        if (ageMin <= flushWaitMinutes) {
          results.push({
            name: "INV.6",
            label: "backlog draining",
            pass: true,
            detail,
          });
        } else {
          // oldest pending exceeds flush wait -> inspect scheduler/pod
          const schedSnap = await def.collection("classify").doc("pod_scheduler").get();
          if (!schedSnap.exists) {
            detail += " | scheduler config absent — reporting backlog age only";
            results.push({
              name: "INV.6",
              label: "backlog draining (info)",
              pass: true,
              detail,
              informational: true,
            });
          } else {
            const sched = schedSnap.data() || {};
            const podtemplateid = sched.podtemplateid;
            let podid = null;
            if (podtemplateid) {
              const modelSnap = await def
                .collection("llmmodels")
                .doc(String(podtemplateid))
                .get();
              if (modelSnap.exists) {
                podid = (modelSnap.data() || {}).podid;
              }
            }
            detail += ` | podtemplateid=${podtemplateid || "(none)"} podid=${
              podid === undefined ? "(undefined)" : JSON.stringify(podid)
            }`;
            const podEmpty =
              !podid || podid === "__creating__" || String(podid).trim() === "";
            if (podEmpty) {
              detail = `BACKLOG NOT DRAINING: ${detail}`;
              hardFail = true;
              results.push({
                name: "INV.6",
                label: "backlog draining",
                pass: false,
                detail,
              });
            } else {
              detail += " (pod running)";
              results.push({
                name: "INV.6",
                label: "backlog draining",
                pass: true,
                detail,
              });
            }
          }
        }
      }
    }

    // ---------------------------- Output ----------------------------
    console.log("==================== INVARIANT RESULTS ====================");
    const labelWidth = 28;
    for (const r of results) {
      const left = `${r.name} ${r.label}`.padEnd(labelWidth + 6, " ");
      const status = r.pass ? "PASS" : "FAIL";
      const tag = r.informational ? " [info]" : "";
      const detail = r.detail ? ` ${r.detail}` : "";
      console.log(`${left}: ${status}${tag}${detail}`);
    }
    console.log("===========================================================");

    const overall = hardFail ? "OVERALL: FAIL — one or more hard invariants violated" : "OVERALL: PASS — all hard invariants hold";
    console.log(overall);

    process.exit(hardFail ? 1 : 0);
  } catch (err) {
    console.error("ERROR running invariant checks:", err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();
