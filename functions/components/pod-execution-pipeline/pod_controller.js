/**
 * pod_controller.js — client for the external vLLM pod controller
 * (project ai-project-4e149). The controller owns pod creation, the RunPod API
 * key, the inference bearer, and server-side termination. This repo drives it
 * through three Firebase **callable** functions, all gated on a Firebase ID
 * token carrying custom claims `approved:true` + role `poddeployer`/`admin`:
 *
 *   launchPod({config_id})  -> {pod_id, public_url, gpu_used}
 *   getPodBearer({pod_id})  -> {bearer_token}
 *   terminatePod({pod_id})  -> {pod_id, cost_usd}
 *   getPodStatus({pod_id})  -> {status, termination_reason, terminated_by, ready,
 *                               public_url, failed_stage}  (durable Firestore doc;
 *                               survives termination — used to fast-fail a bad boot)
 *
 * Auth (KEYLESS — no service-account key stored anywhere):
 *   The functions runtime SA *impersonates* a dedicated, role-less signer SA in
 *   ai-project-4e149 (POD_CONTROLLER_SIGNER_SA) to sign a custom token via the
 *   IAM signBlob API. The runtime SA needs roles/iam.serviceAccountTokenCreator
 *   on that signer SA (a cross-project IAM binding). We embed the deployer claims
 *   in the custom token, exchange it for an ID token via Identity Toolkit, and
 *   cache it for its ~1h lifetime. Blast radius of the binding = "can mint
 *   controller tokens"; it grants NO other access to ai-project-4e149.
 *
 * Callable wire format: request body MUST be {"data": {...}}; success is
 * {"result": {...}}; errors are {"error": {status, message}}.
 */
"use strict";

const admin = require("firebase-admin");
const { logger } = require("firebase-functions");

// Dedicated role-less signer SA in ai-project-4e149 the runtime impersonates.
const SIGNER_SA = process.env.POD_CONTROLLER_SIGNER_SA ||
  "pod-token-minter@ai-project-4e149.iam.gserviceaccount.com";

// Public web API key for ai-project-4e149 (a client key, safe to embed — it is
// gated by Firebase Auth claims, not a secret). Override via env if it rotates.
const WEB_API_KEY = process.env.POD_CONTROLLER_WEB_API_KEY ||
  "AIzaSyCcFsUTvOtWeyDX-nufBt8o6mRjot9WYAA";
const BASE_URL = process.env.POD_CONTROLLER_BASE_URL ||
  "https://us-central1-ai-project-4e149.cloudfunctions.net";
// Synthetic uid the minted token authenticates as (no user record needed — the
// claims are embedded directly in the custom token).
const DEPLOYER_UID = process.env.POD_CONTROLLER_DEPLOYER_UID || "starlabs-pod-deployer";

let _app = null;          // named admin app that signs via signBlob as SIGNER_SA
let _token = null;        // { idToken, expMs }

// A SEPARATE named admin app so we never clobber the repo's default app. It uses
// the runtime ADC credential but signs custom tokens AS SIGNER_SA (keyless).
function controllerApp() {
  if (_app) return _app;
  try {
    _app = admin.app("podController");
  } catch (_) {
    _app = admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      serviceAccountId: SIGNER_SA,
    }, "podController");
  }
  return _app;
}

// Mint (or reuse) a deployer ID token. Cached until ~60s before expiry.
async function getControllerIdToken() {
  const now = Date.now();
  if (_token && _token.expMs - 60000 > now) return _token.idToken;

  // Keyless sign: Admin SDK calls IAM signBlob on SIGNER_SA using runtime ADC.
  const customToken = await controllerApp().auth()
    .createCustomToken(DEPLOYER_UID, { approved: true, role: "poddeployer" });

  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.idToken) {
    throw new Error(`signInWithCustomToken failed: HTTP ${resp.status} ${JSON.stringify(data).slice(0, 200)}`);
  }
  const ttlSec = Number(data.expiresIn || 3600);
  _token = { idToken: data.idToken, expMs: now + ttlSec * 1000 };
  logger.info("pod_controller: minted deployer ID token (keyless)", { signer: SIGNER_SA, ttlSec });
  return _token.idToken;
}

// POST a callable, unwrap {result}, throw a tagged Error on {error}/non-2xx.
async function callController(fnName, data) {
  const idToken = await getControllerIdToken();
  const resp = await fetch(`${BASE_URL}/${fnName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${idToken}` },
    body: JSON.stringify({ data: data || {} }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await resp.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }

  if (!resp.ok || parsed.error) {
    const ce = parsed.error || {};
    const err = new Error(`controller ${fnName} failed: ${ce.message || ce.status || `HTTP ${resp.status}`}`);
    err.httpStatus = resp.status;
    err.controllerStatus = ce.status || null; // e.g. NOT_FOUND, FAILED_PRECONDITION, RESOURCE_EXHAUSTED
    throw err;
  }
  return parsed.result;
}

// ── Public API (mirrors the controller's three callables) ────────────────────
const launchPod = (configId) => callController("launchPod", { config_id: configId });
const terminatePod = (podId) => callController("terminatePod", { pod_id: podId });
async function getPodBearer(podId) {
  const r = await callController("getPodBearer", { pod_id: podId });
  return r && r.bearer_token;
}
// Durable, Firestore-backed pod status — resolves even after the pod is gone, so
// the lifecycle can distinguish a failed/crashed boot from "still loading".
const getPodStatus = (podId) => callController("getPodStatus", { pod_id: podId });

module.exports = {
  getControllerIdToken,
  launchPod,
  getPodBearer,
  terminatePod,
  getPodStatus,
  callController,
  SIGNER_SA,
  BASE_URL,
};
