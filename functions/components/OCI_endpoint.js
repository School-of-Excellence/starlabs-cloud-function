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

// OCI Object Storage S3-compat credentials for recording egress. The pair is the
// `openvidu-elastic-dev-s3-key` Customer Secret Key created by the Terraform stack —
// the same key the cluster's own EXTERNAL_S3_* config uses for this bucket.
const OCI_S3_ACCESS_KEY = defineSecret("OCI_S3_ACCESS_KEY");
const OCI_S3_SECRET = defineSecret("OCI_S3_SECRET");

// Spread into a handler's onRequest({ secrets: [...] }) binding.
exports.SECRETS = [LIVEKIT_URL_OCI, LIVEKIT_API_KEY_OCI, LIVEKIT_API_SECRET_OCI];
exports.RECORDING_SECRETS = [OCI_S3_ACCESS_KEY, OCI_S3_SECRET];

// LiveKit connection credentials for the OCI OpenVidu master.
exports.creds = () => ({
  url: LIVEKIT_URL_OCI.value(),
  key: LIVEKIT_API_KEY_OCI.value(),
  secret: LIVEKIT_API_SECRET_OCI.value(),
});

// S3Upload config for LiveKit EgressClient recording output (dev cluster's appdata
// bucket). OCI's S3-compat API requires path-style addressing (bucket in the path,
// namespace in the host). Prod storage is planned as Cloudflare R2 (Phase 6), so this
// stays dev-only until then.
exports.recordingStorage = () => ({
  endpoint: "https://bmx7corpjbkz.compat.objectstorage.ap-mumbai-1.oraclecloud.com",
  bucket: "openvidu-elastic-dev-appdata-d16985",
  region: "ap-mumbai-1",
  accessKey: OCI_S3_ACCESS_KEY.value(),
  secret: OCI_S3_SECRET.value(),
  forcePathStyle: true,
});
