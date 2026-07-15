/**
 * Oracle Cloud Infrastructure (OCI) OpenVidu (Elastic) endpoint credentials.
 *
 * AWS / DO / OCI all run OpenVidu Elastic and speak the LiveKit protocol, so the shared
 * request handlers in openVidu.js do the actual work. This module only supplies the OCI
 * cluster's LiveKit connection credentials, selected at runtime when a request carries
 * `provider === 'oci'` (Design A: one function, provider param).
 *
 * NOTE: inert until wired. It is NOT required by index.js yet, and its LIVEKIT_*_OCI secrets
 * must exist in Secret Manager before any handler binds `SECRETS` and is deployed.
 */
const { defineSecret } = require("firebase-functions/params");

const LIVEKIT_URL_OCI = defineSecret("LIVEKIT_URL_OCI");
const LIVEKIT_API_KEY_OCI = defineSecret("LIVEKIT_API_KEY_OCI");
const LIVEKIT_API_SECRET_OCI = defineSecret("LIVEKIT_API_SECRET_OCI");

// Spread into a handler's onRequest({ secrets: [...] }) binding.
exports.SECRETS = [LIVEKIT_URL_OCI, LIVEKIT_API_KEY_OCI, LIVEKIT_API_SECRET_OCI];

// LiveKit connection credentials for the OCI OpenVidu master.
exports.creds = () => ({
  url: LIVEKIT_URL_OCI.value(),
  key: LIVEKIT_API_KEY_OCI.value(),
  secret: LIVEKIT_API_SECRET_OCI.value(),
});
