/**
 * DigitalOcean OpenVidu (Elastic) endpoint credentials.
 *
 * AWS / DO / OCI all run OpenVidu Elastic and speak the LiveKit protocol, so the shared
 * request handlers in openVidu.js do the actual work. This module only supplies the DO
 * cluster's LiveKit connection credentials, selected at runtime when a request carries
 * `provider === 'do'` (Design A: one function, provider param).
 *
 * NOTE: inert until wired. It is NOT required by index.js yet, and its LIVEKIT_*_DO secrets
 * must exist in Secret Manager before any handler binds `SECRETS` and is deployed.
 */
const { defineSecret } = require("firebase-functions/params");

const LIVEKIT_URL_DO = defineSecret("LIVEKIT_URL_DO");
const LIVEKIT_API_KEY_DO = defineSecret("LIVEKIT_API_KEY_DO");
const LIVEKIT_API_SECRET_DO = defineSecret("LIVEKIT_API_SECRET_DO");

// Spread into a handler's onRequest({ secrets: [...] }) binding.
exports.SECRETS = [LIVEKIT_URL_DO, LIVEKIT_API_KEY_DO, LIVEKIT_API_SECRET_DO];

// LiveKit connection credentials for the DigitalOcean OpenVidu master.
exports.creds = () => ({
  url: LIVEKIT_URL_DO.value(),
  key: LIVEKIT_API_KEY_DO.value(),
  secret: LIVEKIT_API_SECRET_DO.value(),
});
