const admin = require('firebase-admin');
const { onRequest } = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
//components imports

const cors = require("cors");
const corsHandler = cors({origin: true});

const db = admin.firestore()

// ── Secrets ──
const runpodApiKey = defineSecret("RUNPOD_API_KEY");
const sharedSecret = defineSecret("FUNCTIONS_SHARED_SECRET");
const {logger} = require("firebase-functions");
const {FieldValue} = require("firebase-admin/firestore");
const BATCH_LIMIT = 400;
const {getAuth} = require("firebase-admin/auth");

// =============================================================================
// Helpers
// =============================================================================
async function requireAuth(req, res) {
  // Server-to-server: X-Api-Key must match the Firebase-stored secret
  const apiKey = req.get("X-Api-Key");
  if (apiKey && apiKey === sharedSecret.value()) {
    return {type: "server"};
  }

  // Frontend (Angular) user: Firebase Auth ID token
  const authHeader = req.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token) {
    try {
      const decoded = await getAuth().verifyIdToken(token);
      return {type: "user", uid: decoded.uid, email: decoded.email || null};
    } catch (err) {
      logger.warn("invalid ID token", {error: err.message});
    }
  }

  res.status(401).json({success: false, error: "unauthorized"});
  return null;
}

function handleOptions(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

// =============================================================================
// Merged cloud functions for the RunPod-backed job pipeline.
//
// Functions exported:
//   - run_jobrequest   : ensure a pod exists for a template; trigger drain
//   - getJobRequest    : pod fetches pending jobs and claims them
//   - submitJobResult  : pod submits results; dispatch /process or terminate
//   - terminatePod     : delete the RunPod pod and clear llmmodels.podid
//
// Single source of truth on llmmodels/{TEMPLATEID}: only `podid` field is
// written by this code (set on create, cleared on terminate). No `status`.
// =============================================================================

const TRIGGER_TIMEOUT_MS = 10000;

// ─────────────────────────────────────────────────────────────────────────────
// 1) run_jobrequest
// ─────────────────────────────────────────────────────────────────────────────
// exports.run_jobrequest = onRequest({secrets: [runpodApiKey, sharedSecret]},
//   (req, res) => {
//     corsHandler(req, res, async () => {
//       if (handleOptions(req, res)) return;
//       const auth = await requireAuth(req, res);
//       if (!auth) return;

//       const payload = req.body || {};
//       const slackUrl = payload.SLACK_WEBHOOK_URL || "";

//       try {
//         const required = [
//           "TEMPLATEID",
//           "SLACK_WEBHOOK_URL",
//           "FIREBASE_FETCH_URL",
//           "FIREBASE_SUBMIT_URL",
//           "FIREBASE_COLLECTION_NAME",
//         ];
//         for (const k of required) {
//           if (!payload[k]) {
//             return res.status(400).json({success: false, error: `payload field '${k}' is required`});
//           }
//         }

//         const apiKey = runpodApiKey.value();
//         if (!apiKey) return res.status(500).json({success: false, error: "RunPod API key not configured"});

//         const templateRef = db.collection("llmmodels").doc(payload.TEMPLATEID);
//         const templateSnap = await templateRef.get();
//         if (!templateSnap.exists) return res.status(404).json({success: false, error: "Template not found"});

//         const docData = templateSnap.data();
//         const runpodTemplateId = docData.templateid;

//         // ── (a) Reuse path: ask RunPod if a pod with this template is up ──
//         const listResp = await fetch("https://rest.runpod.io/v1/pods", {
//           method: "GET",
//           headers: {"Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json"},
//           signal: AbortSignal.timeout(30000),
//         });
//         if (!listResp.ok) {
//           const errorData = await listResp.json().catch(() => ({}));
//           return res.status(listResp.status).json({success: false, error: `RunPod list error: ${listResp.status}`, details: errorData});
//         }
//         const listData = await listResp.json();
//         const pods = Array.isArray(listData) ? listData : (listData.pods || listData.data || []);
//         const existing = pods.find((p) => p.templateId === runpodTemplateId);

//         if (existing) {
//           // Pod already running. Trigger a drain so it picks up new pending jobs.
//           await triggerProcess(existing.id).catch((e) =>
//             logger.warn("trigger /process failed (pod may still be booting)", {podId: existing.id, error: e.message}));
//           return res.status(200).json({success: true, alreadyRunning: true, podid: existing.id});
//         }

//         // ── (b) Race guard: atomically reserve the slot before creating ──
//         const reserved = await db.runTransaction(async (tx) => {
//           const s = await tx.get(templateRef);
//           const d = s.data() || {};
//           if (d.podid) return {raceLost: true, podid: d.podid};
//           tx.update(templateRef, {podid: "__creating__"});
//           return {raceLost: false};
//         });
//         if (reserved.raceLost) {
//           return res.status(200).json({success: true, alreadyRunning: true, podid: reserved.podid});
//         }

//         // ── (c) Build env once; GPU choice changes per attempt ──
//         const env = {
//           MODEL_PATH: docData.path,
//           MODEL_NAME: docData.name,
//           TEMPLATE_ID: runpodTemplateId,
//           GIT_REPO: docData.git_repo,
//           REPO_ID: docData.repo_id,
//           D_TYPE: docData.dtype,
//           SLACK_WEBHOOK_URL: payload.SLACK_WEBHOOK_URL,
//           FIREBASE_FETCH_URL: payload.FIREBASE_FETCH_URL,
//           FIREBASE_SUBMIT_URL: payload.FIREBASE_SUBMIT_URL,
//           FIREBASE_COLLECTION_NAME: payload.FIREBASE_COLLECTION_NAME,
//           DOC_ID: payload.DOC_ID || "",
//           FUNCTIONS_API_KEY: sharedSecret.value(),
//         };

//         const gpupriority = Array.isArray(docData.gpupriority) ? docData.gpupriority : [];
//         if (gpupriority.length === 0) {
//           await templateRef.update({podid: ""});
//           return res.status(400).json({success: false, error: "llmmodels doc missing gpupriority[]"});
//         }

//         // ── (d) Try each GPU option in order ──
//         const attempts = [];
//         let created = null;
//         for (const choice of gpupriority) {
//           const runpodPayload = {
//             name: `${docData.name}_${new Date().toISOString()}`,
//             cloudType: "SECURE",
//             computeType: "GPU",
//             containerDiskInGb: docData.tempvolumesize,
//             gpuCount: choice.count,
//             gpuTypeIds: [choice.gpu],
//             gpuTypePriority: "availability",
//             templateId: runpodTemplateId,
//             volumeInGb: 0,
//             env: {...env, GPU_COUNT: String(choice.count)},
//           };
//           const createResp = await fetch("https://rest.runpod.io/v1/pods", {
//             method: "POST",
//             headers: {"Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json"},
//             body: JSON.stringify(runpodPayload),
//             signal: AbortSignal.timeout(45000),
//           });
//           if (createResp.ok) {
//             created = await createResp.json();
//             break;
//           }
//           const errorData = await createResp.json().catch(() => ({}));
//           attempts.push({gpu: choice.gpu, count: choice.count, status: createResp.status, errorData});
//           logger.warn("runpod create attempt failed", {gpu: choice.gpu, status: createResp.status});
//         }

//         if (!created) {
//           await templateRef.update({podid: ""}); // release reservation
//           await notifySlack(slackUrl, {
//             text: `:rotating_light: Pod create failed for *${payload.TEMPLATEID}* (${docData.name}). All GPU options exhausted.`,
//             attempts,
//           });
//           return res.status(502).json({success: false, error: "All GPU options failed", attempts});
//         }

//         await templateRef.update({podid: created.id});
//         logger.info("pod created", {podId: created.id, templateId: runpodTemplateId});
//         return res.status(200).json({success: true, created: true, podid: created.id, data: created});
//       } catch (err) {
//         logger.error("run_jobrequest crashed", {error: err.message, stack: err.stack});
//         await notifySlack(slackUrl, {text: `:rotating_light: run_jobrequest crashed for *${payload.TEMPLATEID}*: ${err.message}`});
//         return res.status(500).json({success: false, error: err.message});
//       }
//     });
//   },
// );

// ─────────────────────────────────────────────────────────────────────────────
// 1) run_jobrequest  (DEBUG build)
// ─────────────────────────────────────────────────────────────────────────────
exports.run_jobrequest = onRequest({secrets: [runpodApiKey, sharedSecret]},
  (req, res) => {
    corsHandler(req, res, async () => {
      if (handleOptions(req, res)) return;
      const auth = await requireAuth(req, res);
      if (!auth) return;

      const payload = req.body || {};
      const slackUrl = payload.SLACK_WEBHOOK_URL || "";
      const dbg = (step, extra = {}) => console.log(`DEBUG run_jobrequest :: ${step}`, JSON.stringify(extra));


      dbg("ENTER", {payload});

      try {
        const required = [
          "TEMPLATEID",
          "SLACK_WEBHOOK_URL",
          "FIREBASE_FETCH_URL",
          "FIREBASE_SUBMIT_URL",
          "FIREBASE_COLLECTION_NAME",
        ];
        for (const k of required) {
          if (!payload[k]) {
            dbg("MISSING_FIELD", {field: k});
            return res.status(400).json({success: false, error: `payload field '${k}' is required`});
          }
        }
        dbg("REQUIRED_FIELDS_OK");

        const apiKey = runpodApiKey.value();
        if (!apiKey) {
          dbg("NO_API_KEY");
          return res.status(500).json({success: false, error: "RunPod API key not configured"});
        }
        dbg("API_KEY_LOADED", {len: apiKey.length});

        const templateRef = db.collection("llmmodels").doc(payload.TEMPLATEID);
        const templateSnap = await templateRef.get();
        if (!templateSnap.exists) {
          dbg("TEMPLATE_NOT_FOUND", {TEMPLATEID: payload.TEMPLATEID});
          return res.status(404).json({success: false, error: "Template not found"});
        }
        const docData = templateSnap.data();
        const runpodTemplateId = docData.templateid;
        dbg("TEMPLATE_LOADED", {runpodTemplateId, name: docData.name, gpupriority: docData.gpupriority, podidField: docData.podid});

        // ── (a) Reuse path ──
        dbg("LIST_PODS_START");
        const listResp = await fetch("https://rest.runpod.io/v1/pods", {
          method: "GET",
          headers: {"Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json"},
          signal: AbortSignal.timeout(30000),
        });
        dbg("LIST_PODS_STATUS", {status: listResp.status, ok: listResp.ok});
        if (!listResp.ok) {
          const errorData = await listResp.json().catch(() => ({}));
          dbg("LIST_PODS_ERROR_BODY", {errorData});
          return res.status(listResp.status).json({success: false, error: `RunPod list error: ${listResp.status}`, details: errorData});
        }
        const listData = await listResp.json();
        const pods = Array.isArray(listData) ? listData : (listData.pods || listData.data || []);
        dbg("LIST_PODS_COUNT", {count: pods.length});
        const existing = pods.find((p) => p.templateId === runpodTemplateId);

        if (existing) {
          dbg("REUSE_EXISTING_POD", {podId: existing.id});
          await triggerProcess(existing.id).catch((e) =>
            logger.warn("trigger /process failed (pod may still be booting)", {podId: existing.id, error: e.message}));
          return res.status(200).json({success: true, alreadyRunning: true, podid: existing.id});
        }

        // ── (b) Race guard ──
        dbg("RACE_GUARD_TX_START");
        const reserved = await db.runTransaction(async (tx) => {
          const s = await tx.get(templateRef);
          const d = s.data() || {};
          if (d.podid) return {raceLost: true, podid: d.podid};
          tx.update(templateRef, {podid: "__creating__"});
          return {raceLost: false};
        });
        dbg("RACE_GUARD_RESULT", reserved);
        if (reserved.raceLost) {
          return res.status(200).json({success: true, alreadyRunning: true, podid: reserved.podid});
        }

        // ── (c) Build env ──
        const env = {
          MODEL_PATH: docData.path,
          MODEL_NAME: docData.name,
          TEMPLATE_ID: runpodTemplateId,
          GIT_REPO: docData.git_repo,
          REPO_ID: docData.repo_id,
          D_TYPE: docData.dtype,
          SLACK_WEBHOOK_URL: payload.SLACK_WEBHOOK_URL,
          FIREBASE_FETCH_URL: payload.FIREBASE_FETCH_URL,
          FIREBASE_SUBMIT_URL: payload.FIREBASE_SUBMIT_URL,
          FIREBASE_COLLECTION_NAME: payload.FIREBASE_COLLECTION_NAME,
          DOC_ID: payload.DOC_ID || "",
          FUNCTIONS_API_KEY: sharedSecret.value(),
        };
        dbg("ENV_BUILT", {envKeys: Object.keys(env)});

        const gpupriority = Array.isArray(docData.gpupriority) ? docData.gpupriority : [];
        if (gpupriority.length === 0) {
          dbg("GPU_PRIORITY_EMPTY");
          await templateRef.update({podid: ""});
          return res.status(400).json({success: false, error: "llmmodels doc missing gpupriority[]"});
        }
        dbg("GPU_PRIORITY_LIST", {gpupriority});

        // ── (d) Try each GPU ──
        const attempts = [];
        let created = null;
        for (const choice of gpupriority) {
          const runpodPayload = {
            name: `${docData.name}_${new Date().toISOString()}`,
            cloudType: "SECURE",
            computeType: "GPU",
            containerDiskInGb: docData.tempvolumesize,
            gpuCount: choice.count,
            gpuTypeIds: [choice.gpu],
            gpuTypePriority: "availability",
            templateId: runpodTemplateId,
            volumeInGb: 0,
            env: {...env, GPU_COUNT: String(choice.count)},
          };
          dbg("CREATE_POD_ATTEMPT", {gpu: choice.gpu, count: choice.count, runpodPayload});
          const createResp = await fetch("https://rest.runpod.io/v1/pods", {
            method: "POST",
            headers: {"Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json"},
            body: JSON.stringify(runpodPayload),
            signal: AbortSignal.timeout(45000),
          });
          dbg("CREATE_POD_STATUS", {gpu: choice.gpu, status: createResp.status, ok: createResp.ok});
          if (createResp.ok) {
            created = await createResp.json();
            dbg("CREATE_POD_OK", {gpu: choice.gpu, created});
            break;
          }
          const errorData = await createResp.json().catch(() => ({}));
          dbg("CREATE_POD_FAIL_BODY", {gpu: choice.gpu, status: createResp.status, errorData});
          attempts.push({gpu: choice.gpu, count: choice.count, status: createResp.status, errorData});
        }

        if (!created) {
          dbg("ALL_GPU_FAILED", {attempts});
          await templateRef.update({podid: ""});
          await notifySlack(slackUrl, {
            text: `:rotating_light: Pod create failed for *${payload.TEMPLATEID}* (${docData.name}). All GPU options exhausted.`,
            attempts,
          });
          return res.status(502).json({success: false, error: "All GPU options failed", attempts});
        }

        await templateRef.update({podid: created.id});
        dbg("PODID_PERSISTED", {podId: created.id});
        return res.status(200).json({success: true, created: true, podid: created.id, data: created});
      } catch (err) {
        logger.error("DEBUG run_jobrequest :: CRASH", {error: err.message, stack: err.stack});
        await notifySlack(slackUrl, {text: `:rotating_light: run_jobrequest crashed for *${payload.TEMPLATEID}*: ${err.message}`});
        return res.status(500).json({success: false, error: err.message, stack: err.stack});
      }
    });
  },
);


// ─────────────────────────────────────────────────────────────────────────────
// 2) getJobRequest — fixed: removed `attempts` and `type` fields
// ─────────────────────────────────────────────────────────────────────────────
exports.getJobRequest = onRequest({secrets: [sharedSecret]}, (req, res) => {
  corsHandler(req, res, async () => {
    if (handleOptions(req, res)) return;
    const auth = await requireAuth(req, res);
    if (!auth) return;

    try {
      const {collectionName, podId} = req.body || {};
      if (!collectionName) return res.status(400).json({error: "collectionName is required"});

      const snapshot = await db.collection(collectionName).where("status", "==", "pending").get();
      if (snapshot.empty) return res.status(200).json({jobs: []});

      const jobs = [];
      let batch = db.batch();
      let opCount = 0;

      for (const doc of snapshot.docs) {
        const data = doc.data();
        batch.update(doc.ref, {
          status: "processing",
          claimedBy: podId || "unknown",
          startedAt: FieldValue.serverTimestamp(),
          lastupdatedat: FieldValue.serverTimestamp(),
        });
        opCount++;
        jobs.push({
          jobId: doc.id,
          path: doc.ref.path,
          profileid: data.profileid || "",
          prompt: data.prompt || "",
          systemPrompt: data.systemPrompt || "",
        });
        if (opCount % BATCH_LIMIT === 0) {
          await batch.commit();
          batch = db.batch();
          opCount = 0;
        }
      }
      if (opCount > 0) await batch.commit();

      logger.info("jobs claimed", {collectionName, count: jobs.length, podId});
      return res.status(200).json({jobs});
    } catch (error) {
      logger.error("getJobRequest failed", {error: error.message, stack: error.stack});
      return res.status(500).json({success: false, error: error.message});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) submitJobResult — writes results, then dispatches /process or terminate
// ─────────────────────────────────────────────────────────────────────────────
// exports.submitJobResult = onRequest({secrets: [sharedSecret, runpodApiKey]}, (req, res) => {
//   corsHandler(req, res, async () => {
//     if (handleOptions(req, res)) return;
//     const auth = await requireAuth(req, res);
//     if (!auth) return;

//     try {
//       const {results, model, podId, templateId} = req.body || {};
//       if (!Array.isArray(results) || results.length === 0) {
//         return res.status(400).json({error: "results array is required"});
//       }
//       if (!podId) return res.status(400).json({error: "podId is required"});

//       const modelName = model || "unknown";
//       let batch = db.batch();
//       let opCount = 0;
//       let committed = 0;

//       for (const result of results) {
//         if (!result.path) {
//           logger.warn("skipping result missing path", {jobId: result.jobId});
//           continue;
//         }
//         batch.set(db.doc(result.path), {
//           raw_output: result.raw_output || "",
//           output: result.output || "",
//           status: result.status || "completed",
//           tokensGenerated: result.tokensGenerated || 0,
//           finishReason: result.finishReason || "unknown",
//           error: result.error || null,
//           model: modelName,
//           completedAt: FieldValue.serverTimestamp(),
//           lastupdatedat: FieldValue.serverTimestamp(),
//         }, {merge: true});
//         opCount++;
//         if (opCount % BATCH_LIMIT === 0) {
//           await batch.commit();
//           committed += opCount;
//           batch = db.batch();
//           opCount = 0;
//         }
//       }
//       if (opCount > 0) {
//         await batch.commit();
//         committed += opCount;
//       }

//       // ── Lifecycle dispatch ──
//       const collectionName = results[0].path.split("/")[0];
//       const pendingSnap = await db.collection(collectionName)
//         .where("status", "==", "pending").limit(1).get();

//       let dispatch;
//       if (!pendingSnap.empty) {
//         triggerProcess(podId).catch((e) =>
//           logger.warn("trigger /process failed", {podId, error: e.message}));
//         dispatch = {action: "process", podId};
//       } else {
//         triggerTerminate(podId, templateId).catch((e) =>
//           logger.warn("trigger terminate failed", {podId, error: e.message}));
//         dispatch = {action: "terminate", podId, templateId};
//       }

//       logger.info("results submitted", {count: committed, model: modelName, dispatch});
//       return res.status(200).json({success: true, count: committed, dispatch});
//     } catch (error) {
//       logger.error("submitJobResult failed", {error: error.message, stack: error.stack});
//       return res.status(500).json({success: false, error: error.message});
//     }
//   });
// });

exports.submitJobResult = onRequest({secrets: [sharedSecret]}, (req, res) => {
  corsHandler(req, res, async () => {
    if (handleOptions(req, res)) return;
    const auth = await requireAuth(req, res);
    if (!auth) return;

    try {
      const {results, model, podId} = req.body || {};
      if (!Array.isArray(results) || results.length === 0) {
        return res.status(400).json({error: "results array is required"});
      }
      if (!podId) return res.status(400).json({error: "podId is required"});

      const modelName = model || "unknown";
      let batch = db.batch();
      let opCount = 0;
      let committed = 0;

      for (const result of results) {
        if (!result.path) {
          logger.warn("skipping result missing path", {jobId: result.jobId});
          continue;
        }
        batch.set(db.doc(result.path), {
          raw_output: result.raw_output || "",
          output: result.output || "",
          status: result.status || "completed",
          tokensGenerated: result.tokensGenerated || 0,
          finishReason: result.finishReason || "unknown",
          error: result.error || null,
          model: modelName,
          completedAt: FieldValue.serverTimestamp(),
          lastupdatedat: FieldValue.serverTimestamp(),
        }, {merge: true});
        opCount++;
        if (opCount % BATCH_LIMIT === 0) {
          await batch.commit();
          committed += opCount;
          batch = db.batch();
          opCount = 0;
        }
      }
      if (opCount > 0) {
        await batch.commit();
        committed += opCount;
      }

      logger.info("results submitted", {count: committed, model: modelName, podId});
      return res.status(200).json({success: true, count: committed});
    } catch (error) {
      logger.error("submitJobResult failed", {error: error.message, stack: error.stack});
      return res.status(500).json({success: false, error: error.message});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────
// async function triggerProcess(podId) {
//   const url = `https://${podId}-8000.proxy.runpod.net/process`;
//   return fetch(url, {
//     method: "POST",
//     headers: {"X-Api-Key": sharedSecret.value(), "Content-Type": "application/json"},
//     signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
//   });
// }

// async function triggerTerminate(podId, templateId) {
//   const url = "https://us-central1-fir-sample-aae4a.cloudfunctions.net/terminatePod";
//   return fetch(url, {
//     method: "POST",
//     headers: {"X-Api-Key": sharedSecret.value(), "Content-Type": "application/json"},
//     body: JSON.stringify({podId, templateId}),
//     signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
//   });
// }

// ─────────────────────────────────────────────────────────────────────────────
// 4) terminatePod — DELETE pod, sweep orphans, clear llmmodels.podid
// ─────────────────────────────────────────────────────────────────────────────
exports.terminatePod = onRequest({secrets: [runpodApiKey, sharedSecret]}, (req, res) => {
  corsHandler(req, res, async () => {
    if (handleOptions(req, res)) return;
    const auth = await requireAuth(req, res);
    if (!auth) return;

    try {
      const {podId, templateId, collectionName} = req.body || {};
      if (!podId) return res.status(400).json({error: "podId is required"});

      const apiResponse = await fetch(`https://rest.runpod.io/v1/pods/${podId}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${runpodApiKey.value()}`,
          "Content-Type": "application/json",
        },
      });

      // Treat 404 as already-gone (idempotent).
      if (!apiResponse.ok && apiResponse.status !== 404) {
        let errorData = {};
        const ct = apiResponse.headers.get("content-type") || "";
        if (ct.includes("application/json")) errorData = await apiResponse.json().catch(() => ({}));
        logger.warn("runpod terminate failed", {status: apiResponse.status, errorData});
        return res.status(apiResponse.status).json({
          success: false,
          error: `RunPod API error: ${apiResponse.status}`,
          details: errorData,
        });
      }

      // ── Sweep orphans: any docs still 'processing' under this pod → 'pending' ──
      if (collectionName) {
        const stuck = await db.collection(collectionName)
          .where("status", "==", "processing")
          .where("claimedBy", "==", podId)
          .get();
        if (!stuck.empty) {
          let batch = db.batch();
          let n = 0;
          for (const d of stuck.docs) {
            batch.update(d.ref, {
              status: "pending",
              claimedBy: FieldValue.delete(),
              startedAt: FieldValue.delete(),
              lastupdatedat: FieldValue.serverTimestamp(),
            });
            n++;
            if (n % BATCH_LIMIT === 0) { await batch.commit(); batch = db.batch(); }
          }
          if (n % BATCH_LIMIT !== 0) await batch.commit();
          logger.info("orphans requeued", {podId, count: stuck.size});
        }
      }

      if (templateId) {
        await db.collection("llmmodels").doc(templateId).update({podid: ""});
      }

      logger.info("pod terminated", {podId, templateId});
      return res.status(200).json({success: true, message: `Pod ${podId} terminated`});
    } catch (error) {
      logger.error("terminatePod crashed", {error: error.message});
      return res.status(500).json({success: false, error: error.message});
    }
  });
});

async function notifySlack(slackUrl, body) {
  if (!slackUrl) return;
  try {
    const text = body.attempts
      ? `${body.text}\n\`\`\`${JSON.stringify(body.attempts, null, 2)}\`\`\``
      : body.text;
    await fetch(slackUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({text}),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    logger.warn("slack notify failed", {error: e.message});
  }
}
