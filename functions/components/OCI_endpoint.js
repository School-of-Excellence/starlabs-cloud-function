/**
 * Oracle Cloud Infrastructure (OCI) OpenVidu (Elastic) endpoint credentials.
 *
 * AWS / DO / OCI all run OpenVidu Elastic and speak the LiveKit protocol, so the shared
 * request handlers in openVidu.js do the actual work. This module only supplies the OCI
 * cluster's LiveKit connection credentials, selected at runtime when a request carries
 * `provider === 'oci'` (Design A: one function, provider param).
 *
 * All OCI_* secrets must exist in Secret Manager before any handler binding them is deployed.
 */
const admin = require("firebase-admin");
const { defineSecret } = require("firebase-functions/params");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const cors = require("cors")({ origin: true });
const AWS_ClientS3 = require("@aws-sdk/client-s3");
const AWS_S3Request = require("@aws-sdk/s3-request-presigner");
const ociCommon = require("oci-common");
const ociCore = require("oci-core");
const livekitServer = require("livekit-server-sdk");
const axios = require("axios");
const commonService = require("./service");

const LIVEKIT_URL_OCI = defineSecret("LIVEKIT_URL_OCI");
const LIVEKIT_API_KEY_OCI = defineSecret("LIVEKIT_API_KEY_OCI");
const LIVEKIT_API_SECRET_OCI = defineSecret("LIVEKIT_API_SECRET_OCI");

// OCI Object Storage S3-compat credentials for recording egress. The pair is the
// `openvidu-elastic-dev-s3-key` Customer Secret Key created by the Terraform stack —
// the same key the cluster's own EXTERNAL_S3_* config uses for this bucket.
const OCI_S3_ACCESS_KEY = defineSecret("OCI_S3_ACCESS_KEY");
const OCI_S3_SECRET = defineSecret("OCI_S3_SECRET");

// OCI control-plane API credentials (API signing key of the ~/.oci/config user) plus the
// dev stack's resource OCIDs — twin of AWS's AWS_ACCESS_KEY/AWS_SECRET + MASTER_INSTANCE_ID/
// MEDIA_ASG_NAME. Used by the status poller and (Phase 4) the pool controller.
const OCI_TENANCY_OCID = defineSecret("OCI_TENANCY_OCID");
const OCI_USER_OCID = defineSecret("OCI_USER_OCID");
const OCI_KEY_FINGERPRINT = defineSecret("OCI_KEY_FINGERPRINT");
const OCI_API_PRIVATE_KEY = defineSecret("OCI_API_PRIVATE_KEY");
const OCI_MASTER_INSTANCE_ID = defineSecret("OCI_MASTER_INSTANCE_ID");
const OCI_MEDIA_POOL_ID = defineSecret("OCI_MEDIA_POOL_ID");

// Spread into a handler's onRequest({ secrets: [...] }) binding.
exports.SECRETS = [LIVEKIT_URL_OCI, LIVEKIT_API_KEY_OCI, LIVEKIT_API_SECRET_OCI];
exports.RECORDING_SECRETS = [OCI_S3_ACCESS_KEY, OCI_S3_SECRET];
exports.API_SECRETS = [OCI_TENANCY_OCID, OCI_USER_OCID, OCI_KEY_FINGERPRINT, OCI_API_PRIVATE_KEY, OCI_MASTER_INSTANCE_ID, OCI_MEDIA_POOL_ID];

// Shared by BOTH stacks: the dev and prod clusters live in the same tenancy, the same
// compartment and the same region, so these are environment-independent. The master and
// pool OCIDs, which DO differ per stack, arrive as secrets (see API_SECRETS above), and
// the recording bucket is resolved per environment below.
const COMPARTMENT_ID = "ocid1.compartment.oc1..aaaaaaaahjgkgr2isamqfnk57wpqhcspchezpvo6jgwwbv2tfgn74o45nxca";
const OCI_REGION = "ap-mumbai-1";
// Caps pool growth — OCI pools have no native max. NOTE: the tenancy limit is 13 E5 OCPUs
// (≈3 media nodes at 3 OCPU each, fewer while the other environment is running), so this
// value currently over-promises. Lower it, or raise the service limit, before relying on it.
const MAX_MEDIA_NODES = 5;

// One-room-one-node, same as AWS (CONFIG.maxRoomsPerInstance = 1 there).
const CONFIG = { maxRoomsPerInstance: 1 };

// A pool instance is "ready" (media software installed, joined the cluster, can take a call)
// this long after Oracle created it. OpenVidu 3 has no media-node readiness API, so readiness
// is time-based (2026-11-14 plan item 3.1, Option A). 8 min = the 5–8 min bootstrap seen on
// 2026-07-16 (journal 2026-07-16-oci-recording-and-webhook.md). TUNE after measuring a few boots
// in Grafana ("OpenVidu Cluster Nodes Logs"); Option B (boot-script callback) if this is not enough.
const MEDIA_NODE_READY_AFTER_MS = 8 * 60 * 1000;

function isMediaNodeReady(poolInstance, now = Date.now()) {
  if ((poolInstance.state || "") !== "Running" || !poolInstance.timeCreated) return false;
  const created = new Date(poolInstance.timeCreated).getTime();
  return !isNaN(created) && now - created >= MEDIA_NODE_READY_AFTER_MS;
}

// Wake-on-join window: a room opened within this time while the server is stopped wakes it,
// and a room the server was woken for is kept out of housekeeping for this long.
const WAKE_WINDOW_MS = 30 * 60 * 1000;

// LiveKit connection credentials for the OCI OpenVidu master.
exports.creds = () => ({
  url: LIVEKIT_URL_OCI.value(),
  key: LIVEKIT_API_KEY_OCI.value(),
  secret: LIVEKIT_API_SECRET_OCI.value(),
});

// The Object Storage namespace is per-TENANCY, so the S3-compat endpoint is the same for
// dev and prod. Only the appdata bucket differs (each stack auto-creates its own,
// `<stackName>-appdata-<random>`), so that is the one value resolved per environment.
//
// Resolution order: OCI_RECORDING_BUCKET env var (set it in functions/.env.<projectId>;
// `verify-oci-stack.sh <env>` prints the exact name after an apply) → the dev bucket.
// On the production project a missing value THROWS rather than falling back: silently
// writing prod recordings into the dev bucket is far worse than a loud failure.
const DEV_RECORDING_BUCKET = "openvidu-elastic-dev-appdata-d16985";
function recordingBucket() {
  const configured = (process.env.OCI_RECORDING_BUCKET || "").trim();
  if (configured) return configured;
  if (commonService.production) {
    throw new Error(
      "OCI_RECORDING_BUCKET is not set for the production project. Add it to " +
      "functions/.env.fir-sample-aae4a (verify-oci-stack.sh prod prints the value). " +
      "Refusing to fall back to the dev bucket."
    );
  }
  return DEV_RECORDING_BUCKET;
}

// S3Upload config for LiveKit EgressClient recording output. OCI's S3-compat API requires
// path-style addressing (bucket in the path, namespace in the host).
exports.recordingStorage = () => ({
  endpoint: "https://bmx7corpjbkz.compat.objectstorage.ap-mumbai-1.oraclecloud.com",
  bucket: recordingBucket(),
  region: OCI_REGION,
  accessKey: OCI_S3_ACCESS_KEY.value(),
  secret: OCI_S3_SECRET.value(),
  forcePathStyle: true,
});

// Presigned playback URL for a recording in OCI Object Storage — twin of
// AWS_endpoint.getSignedUrlAWS ({ videoKey } in, { url } out, 10-min expiry). The AWS SDK
// v3 client works against OCI's S3-compat endpoint with path-style addressing.
exports.getSignedUrlOci = onRequest({ secrets: [OCI_S3_ACCESS_KEY, OCI_S3_SECRET] }, async (req, res) => {
  cors(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed. Only POST allowed" });
    }

    const { videoKey } = req.body;
    if (!videoKey) {
      return res.status(400).json({
        error: "Video Key is required",
      });
    }

    try {
      const storage = exports.recordingStorage();
      const s3 = new AWS_ClientS3.S3Client({
        region: storage.region,
        endpoint: storage.endpoint,
        forcePathStyle: storage.forcePathStyle,
        credentials: {
          accessKeyId: storage.accessKey,
          secretAccessKey: storage.secret,
        },
      });

      const command = new AWS_ClientS3.GetObjectCommand({
        Bucket: storage.bucket,
        Key: videoKey,
      });

      const url = await AWS_S3Request.getSignedUrl(s3, command, { expiresIn: 600 }); // 10 min
      res.status(200).json({ url });
    } catch (error) {
      console.error("Unable to Get Signed URL (OCI):", error);
      return res.status(500).json({ error: error.message || error.toString() });
    }
  });
});


// ---- OCI control-plane clients (compute / pool / network) ----

// Explicit-value auth (no ~/.oci/config on Cloud Functions). Arg order verified against
// the live tenancy: tenancy, user, fingerprint, privateKey, passphrase, region.
function getOciClients() {
  const provider = new ociCommon.SimpleAuthenticationDetailsProvider(
    OCI_TENANCY_OCID.value(),
    OCI_USER_OCID.value(),
    OCI_KEY_FINGERPRINT.value(),
    OCI_API_PRIVATE_KEY.value(),
    null,
    ociCommon.Region.fromRegionId(OCI_REGION)
  );
  return {
    compute: new ociCore.ComputeClient({ authenticationDetailsProvider: provider }),
    mgmt: new ociCore.ComputeManagementClient({ authenticationDetailsProvider: provider }),
    vnet: new ociCore.VirtualNetworkClient({ authenticationDetailsProvider: provider }),
  };
}

// OCI lifecycle states → the client's MasterNodeStatus.state vocabulary (twin of AWS
// mapMasterState; same output values so the monitor UI is shared).
function mapOciMasterState(ociState) {
  const stateMap = {
    'RUNNING': 'running',
    'STOPPED': 'stopped',
    'STOPPING': 'stopping',
    'STARTING': 'starting',
    'PROVISIONING': 'starting',
    'TERMINATING': 'stopping',
    'TERMINATED': 'terminated'
  };
  return stateMap[ociState] || 'unknown';
}

// ---- Status collection (shared by the scheduler, the event webhook and the HTTP controls) ----

// Read master + pool truth from the OCI API. Never trusts event payloads for state.
async function collectOciStatus(clients) {
  const { compute, mgmt, vnet } = clients;

  // 1. Master instance state (+ IPs/shape when running)
  const { instance } = await compute.getInstance({ instanceId: OCI_MASTER_INSTANCE_ID.value() });
  const masterState = mapOciMasterState(instance.lifecycleState);
  console.log(`OCI master: ${instance.lifecycleState} → ${masterState}`);

  const master = {
    state: masterState,
    status: instance.lifecycleState,
    instanceId: instance.id,
    instanceType: instance.shape || null,
    launchTime: instance.timeCreated ? new Date(instance.timeCreated).toISOString() : null,
    publicIp: null,
    privateIp: null,
  };

  if (instance.lifecycleState === "RUNNING") {
    try {
      const attachments = await compute.listVnicAttachments({ compartmentId: COMPARTMENT_ID, instanceId: instance.id });
      if (attachments.items.length > 0) {
        const { vnic } = await vnet.getVnic({ vnicId: attachments.items[0].vnicId });
        master.publicIp = vnic.publicIp || null;
        master.privateIp = vnic.privateIp || null;
      }
    } catch (vnicErr) {
      console.log("OCI master VNIC lookup failed:", vnicErr.message);
    }
  }

  // 2. Media pool state
  const { instancePool } = await mgmt.getInstancePool({ instancePoolId: OCI_MEDIA_POOL_ID.value() });
  const poolInstances = await mgmt.listInstancePoolInstances({ compartmentId: COMPARTMENT_ID, instancePoolId: OCI_MEDIA_POOL_ID.value() });

  // healthy = VM running (media software may still be installing); ready = can take a call
  // (isMediaNodeReady). The call tab waits for ready, not healthy (plan item 3.1).
  const instanceStates = { healthy: 0, ready: 0, unhealthy: 0, pending: 0, terminating: 0, total: poolInstances.items.length };
  const now = Date.now();
  const instances = poolInstances.items.map(i => {
    const state = i.state || "";
    const isHealthy = state === "Running";
    const isReady = isMediaNodeReady(i, now);
    if (isReady) instanceStates.ready++;
    if (isHealthy) instanceStates.healthy++;
    else if (state === "Provisioning" || state === "Starting" || state === "Scaling") instanceStates.pending++;
    else if (state === "Terminating" || state === "Stopping") instanceStates.terminating++;
    else instanceStates.unhealthy++;
    return {
      instanceId: i.id,
      healthStatus: state,
      lifecycleState: state,
      availabilityZone: i.availabilityDomain || "",
      isHealthy: isHealthy,
      isReady: isReady,
    };
  });

  let scalingStatus = 'stable';
  if (instancePool.size > instanceStates.healthy) scalingStatus = 'scaling-up';
  else if (instanceStates.terminating > 0) scalingStatus = 'scaling-down';

  console.log(`OCI pool: size=${instancePool.size} healthy=${instanceStates.healthy} ready=${instanceStates.ready} status=${scalingStatus}`);

  return {
    master,
    media: {
      asgName: instancePool.displayName || "media-pool",
      desiredCapacity: instancePool.size,
      minSize: 0,
      maxSize: MAX_MEDIA_NODES,
      instanceStates: instanceStates,
      instances: instances,
      scalingStatus: scalingStatus,
    },
  };
}

// Collect + write OCI_System/instance_status (twin of AWS_System/instance_status; `asgName`
// carries the pool name so the monitor UI reuses InfrastructureStatus). Returns the status.
// `known`: a status this caller already collected in the same run and has not changed since —
// written as-is instead of asking Oracle again (fewer API calls; prod saw "Too many requests").
async function refreshOciStatus(clients, known) {
  const status = known || await collectOciStatus(clients);
  await admin.firestore().doc('OCI_System/instance_status').set({
    master: status.master,
    media: status.media,
    lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log('OCI_System/instance_status updated');
  return status;
}

// ---- Lifecycle actions (twin of AWS start/stopMasterNode + ASG desired-capacity) ----

async function setPoolSize(mgmt, size) {
  await mgmt.updateInstancePool({
    instancePoolId: OCI_MEDIA_POOL_ID.value(),
    updateInstancePoolDetails: { size: size },
  });
  console.log(`OCI media pool size set to ${size}`);
}

async function startOciMaster(clients, poolSize = 1) {
  // Fire-and-forget START — no waiters (scheduled runs stay well under timeout; boot
  // progress is visible via the event webhook / next ticks). The media pool is ordered at the
  // same time so media nodes boot alongside the master. `poolSize` = how many calls are about
  // to need a node (upcoming meetings + rooms waiting), so a burst of meetings does not wait
  // for nodes to be added one at a time (2026-11-14 plan item 1.5). Manual start keeps 1.
  const size = Math.min(Math.max(poolSize, 1), MAX_MEDIA_NODES);
  await clients.compute.instanceAction({ instanceId: OCI_MASTER_INSTANCE_ID.value(), action: "START" });
  console.log('OCI master START issued');
  await setPoolSize(clients.mgmt, size);
}

// How many media nodes the calls in sight need: rooms already active + upcoming meetings whose
// room is not active yet (a pre-created meeting room is in both lists — count it once).
// One call per node (CONFIG.maxRoomsPerInstance = 1), capped at MAX_MEDIA_NODES.
function mediaNodesNeeded(activeRoomIds, meetings) {
  const pending = meetings.filter(m => !activeRoomIds.has(m.id)).length;
  const nodes = Math.ceil((activeRoomIds.size + pending) / CONFIG.maxRoomsPerInstance);
  return Math.min(Math.max(nodes, 1), MAX_MEDIA_NODES);
}

async function stopOciMaster(clients) {
  // Pool to 0 first (pre-drain daemon on each node handles graceful egress shutdown),
  // then SOFTSTOP the master (graceful OS shutdown — protects mongo/redis; OCI falls back
  // to a hard stop after 15 min). Ephemeral IP survives stop/start (verified 2026-07-16).
  await setPoolSize(clients.mgmt, 0);
  await clients.compute.instanceAction({ instanceId: OCI_MASTER_INSTANCE_ID.value(), action: "SOFTSTOP" });
  console.log('OCI master SOFTSTOP issued');
}

// ---- Capacity gate (twin of AWS checkCapacity/scaleUp/prepareRoom) ----

// Capacity is measured by OTHER active rooms — never the target room the caller is about to
// occupy. Without excluding it, two people joining the SAME brand-new room race: the first
// creates the room, the second's check then counts that room as "capacity used" and scales
// up a node nobody needs (observed 2026-07-18: pool 1→2 on a single 2-person call). The
// caller occupies the target room whether it creates or joins it, so it must not count.
//
// Ready vs ordered (2026-11-14 plan item 3.1): a room is allowed only on a READY node
// (isMediaNodeReady). Counting ORDERED nodes let a second call in while its node was still
// booting, so it landed on node 1 next to the first call (laggy video for both).
// `needsNode` = even the ordered nodes are not enough → the caller orders one more. When it is
// false but `allowed` is false, a node is already on its way: answer "please wait", order nothing.
async function checkOciCapacity(mgmt, roomClient, targetRoomName) {
  const { instancePool } = await mgmt.getInstancePool({ instancePoolId: OCI_MEDIA_POOL_ID.value() });
  const totalInstances = instancePool.size;
  if (totalInstances === 0) {
    return { allowed: false, needsNode: true, activeRooms: 0, maxRooms: 0, totalInstances: 0, readyInstances: 0, reason: 'No instances running' };
  }
  const poolInstances = await mgmt.listInstancePoolInstances({ compartmentId: COMPARTMENT_ID, instancePoolId: OCI_MEDIA_POOL_ID.value() });
  const now = Date.now();
  const readyInstances = Math.min(poolInstances.items.filter(i => isMediaNodeReady(i, now)).length, totalInstances);
  const rooms = await roomClient.listRooms();
  const otherRoomCount = rooms.filter(r => r.name !== targetRoomName).length;
  const maxRooms = readyInstances * CONFIG.maxRoomsPerInstance;
  const orderedRooms = totalInstances * CONFIG.maxRoomsPerInstance;
  const allowed = otherRoomCount < maxRooms;
  const needsNode = otherRoomCount >= orderedRooms;
  console.log(`OCI capacity: ${otherRoomCount} other room(s) / ${maxRooms} ready max (${readyInstances} ready of ${totalInstances} ordered), allowed=${allowed} needsNode=${needsNode}, target=${targetRoomName}`);
  return { allowed, needsNode, activeRooms: otherRoomCount, maxRooms, totalInstances, readyInstances };
}

async function scaleOciUp(mgmt) {
  const { instancePool } = await mgmt.getInstancePool({ instancePoolId: OCI_MEDIA_POOL_ID.value() });
  if (instancePool.size >= MAX_MEDIA_NODES) {
    console.log(`OCI pool already at max capacity (${MAX_MEDIA_NODES})`);
    return false;
  }
  await setPoolSize(mgmt, instancePool.size + 1);
  return true;
}

// Capacity gate + room creation for the OCI pool-backed cluster — same contract as
// AWS_endpoint.prepareRoom: { scaling:true, ... } signals a 503, { scaling:false } means
// the room is ready to join.
exports.prepareRoom = async ({ roomName, url, key, secret }) => {
  const { mgmt } = getOciClients();
  const roomClient = new livekitServer.RoomServiceClient(url, key, secret);

  let roomExists = false;
  try {
    const existingRooms = await roomClient.listRooms([roomName]);
    roomExists = existingRooms.length > 0;
    console.log(`[${roomName}] Room exists (oci): ${roomExists}`);
  } catch (error) {
    console.log(`[${roomName}] Could not check room existence (oci):`, error.message);
    roomExists = false;
  }

  if (!roomExists) {
    let canCreateRoom;
    try {
      canCreateRoom = await checkOciCapacity(mgmt, roomClient, roomName);
    } catch (error) {
      // Cluster unreachable (master booting / node not registered) → scaling contract.
      console.log(`[${roomName}] OCI capacity check failed:`, error.message);
      return { scaling: true, activeRooms: 0, maxRooms: 0, totalInstances: 0 };
    }
    if (!canCreateRoom.allowed) {
      if (canCreateRoom.needsNode) {
        console.log(`[${roomName}] At OCI capacity - scaling up`);
        await scaleOciUp(mgmt).catch(e => console.error('OCI scaleUp failed:', e.message));
      } else {
        console.log(`[${roomName}] Media node still booting - asking the caller to wait`);
      }
      return { scaling: true, activeRooms: canCreateRoom.activeRooms, maxRooms: canCreateRoom.maxRooms, totalInstances: canCreateRoom.totalInstances };
    }
    try {
      await roomClient.createRoom({ name: roomName, emptyTimeout: 300, maxParticipants: 50 });
      console.log(`[${roomName}] New room created (oci)`);
    } catch (createError) {
      if (createError.message && (createError.message.includes('already exists') || createError.message.includes('RoomExists'))) {
        console.log(`[${roomName}] Room was created by another request - continuing`);
      } else {
        console.error(`[${roomName}] Room creation error (oci):`, createError);
        throw createError;
      }
    }
    return { scaling: false, totalInstances: canCreateRoom.totalInstances };
  }
  console.log(`[${roomName}] Joining existing room (oci, no capacity check)`);
  return { scaling: false, totalInstances: null };
};

// ---- Controller helpers (twins of AWS houseKeepRooms / getActiveRoomsCount) ----

// Inactivate OCI rooms that are empty AND idle > 15 min. Scoped to mediaProvider == 'oci'
// only — AWS/livekit-cloud rooms are other controllers' responsibility, and this cluster's
// listRooms() can't see them (they would always look empty).
async function houseKeepOciRooms() {
  const INACTIVE_MS = 15 * 60 * 1000;

  let liveCounts = null;
  try {
    const roomClient = new livekitServer.RoomServiceClient(
      LIVEKIT_URL_OCI.value(), LIVEKIT_API_KEY_OCI.value(), LIVEKIT_API_SECRET_OCI.value()
    );
    const rooms = await roomClient.listRooms();
    liveCounts = {};
    for (const r of rooms) liveCounts[r.name] = r.numParticipants || 0;
  } catch (e) {
    console.error('houseKeepOciRooms: LiveKit listRooms unavailable, using participantlive only:', e && e.message);
    liveCounts = null;
  }

  const snap = await admin.firestore().collection('openviduroom')
    .where('active', '==', true).where('mediaProvider', '==', 'oci').get();
  const nowMs = Date.now();

  for (const docSnap of snap.docs) {
    try {
      const room = docSnap.data();
      const ghost = room.participantghost;
      const liveReal = (room.participantlive || []).filter(id => id !== ghost);

      const isEmpty = liveCounts !== null
        ? (liveCounts[docSnap.id] || 0) === 0
        : liveReal.length === 0;

      const updatedMs = docSnap.updateTime
        ? docSnap.updateTime.toMillis()
        : (room.createddate && room.createddate.toMillis ? room.createddate.toMillis() : nowMs);
      const ageMs = nowMs - updatedMs;

      // A room the controller just woke the server for: its people are waiting through a cold
      // boot (≤5 min to the next tick + ~10 min boot), so it looks empty and idle. Don't close
      // it before WAKE_WINDOW_MS has passed, or the server would stop just as it comes up.
      const wokeMs = room.wokeServerAt && room.wokeServerAt.toMillis ? room.wokeServerAt.toMillis() : 0;
      if (wokeMs && nowMs - wokeMs < WAKE_WINDOW_MS) continue;

      if (isEmpty && ageMs > INACTIVE_MS) {
        await docSnap.ref.update({
          active: false,
          roomstatus: 'finished',
          closedReason: 'auto-inactive',
          closedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`houseKeepOciRooms: inactivated ${docSnap.id} (empty + idle ${Math.round(ageMs / 60000)}m)`);
      }
    } catch (roomErr) {
      console.error(`houseKeepOciRooms: skipping room ${docSnap.id}:`, roomErr && roomErr.message);
    }
  }
}

// Active OCI rooms in Firestore (twin of AWS getActiveRoomsCount, scoped to this cloud).
async function getOciActiveRoomsCount() {
  try {
    const snap = await admin.firestore().collection('openviduroom')
      .where('active', '==', true).where('mediaProvider', '==', 'oci').get();
    console.log(`Active OCI sessions in Firestore: ${snap.size}`);
    return snap.size;
  } catch (error) {
    console.error('Error checking Firestore for active OCI sessions:', error);
    return 1; // fail safe: assume busy so we never stop a cluster we can't assess
  }
}

// Ids of the active OCI rooms (same query as the count). null when Firestore can't be read —
// callers then treat the cluster as busy and take no stop / size-down decision.
async function getOciActiveRoomIds() {
  try {
    const snap = await admin.firestore().collection('openviduroom')
      .where('active', '==', true).where('mediaProvider', '==', 'oci').get();
    console.log(`Active OCI sessions in Firestore: ${snap.size}`);
    return new Set(snap.docs.map(d => d.id));
  } catch (error) {
    console.error('Error reading active OCI rooms:', error);
    return null;
  }
}

// Wake-on-join (2026-11-14 plan item 1.2 / decision D2). Rooms someone opened recently while
// the OCI server is stopped: active, hosted on OCI (or not yet marked — the active cloud is
// OCI whenever this controller acts), and created / reactivated within WAKE_WINDOW_MS.
// The freshness test matters: prod holds old rooms still flagged active (e.g. cancelled
// meetings); waking for those would keep the server on all day.
async function findRoomsWaitingForServer() {
  const snap = await admin.firestore().collection('openviduroom').where('active', '==', true).get();
  const nowMs = Date.now();
  return snap.docs.filter(d => {
    const provider = d.get('mediaProvider');
    if (provider && provider !== 'oci') return false;
    const updatedMs = d.updateTime ? d.updateTime.toMillis() : 0;
    return nowMs - updatedMs <= WAKE_WINDOW_MS;
  });
}

// Full pre-create for an upcoming meeting — twin of AWS createRoomForMeeting: ensures the
// LiveKit room on the OCI cluster AND creates/reactivates the openviduroom doc (title from
// profiles) stamped mediaProvider:'oci'. Only the ACTIVE provider's controller runs this
// (activeprovider gate), so exactly one cloud creates each meeting's room. Unlike AWS, no
// long in-function waits: if the cluster/capacity isn't ready we defer — the flag stays
// unset so the next 5-min tick retries.
async function createOciRoomForMeeting(meeting, clients) {
  const roomName = meeting.id;
  console.log(`[Pre-create oci] Creating room for meeting ${meeting.id}`);

  const roomClient = new livekitServer.RoomServiceClient(
    LIVEKIT_URL_OCI.value(), LIVEKIT_API_KEY_OCI.value(), LIVEKIT_API_SECRET_OCI.value()
  );

  // STEP 1: room exists? (cluster unreachable → defer to next tick)
  let roomExists = false;
  try {
    const existingRooms = await roomClient.listRooms([roomName]);
    roomExists = existingRooms.length > 0;
    console.log(`[Pre-create oci] Room ${roomName} exists: ${roomExists}`);
  } catch (error) {
    console.log(`[Pre-create oci] LiveKit not ready (${error && error.message}) - deferring ${roomName}`);
    return;
  }

  // STEP 2: create if missing (capacity-gated; at capacity → grow pool and defer)
  if (!roomExists) {
    let capacity;
    try {
      capacity = await checkOciCapacity(clients.mgmt, roomClient, roomName);
    } catch (error) {
      console.error(`[Pre-create oci] Capacity check failed: ${error.message}`);
      capacity = { allowed: false, needsNode: false };
    }
    if (!capacity.allowed) {
      if (capacity.needsNode) {
        console.log(`[Pre-create oci] At capacity - scaling up and deferring ${roomName}`);
        await scaleOciUp(clients.mgmt).catch(e => console.error('OCI scaleUp failed:', e.message));
      } else {
        console.log(`[Pre-create oci] Media node not ready yet - deferring ${roomName}`);
      }
      return;
    }
    try {
      await roomClient.createRoom({
        name: roomName,
        emptyTimeout: 300,
        maxParticipants: 50,
        metadata: JSON.stringify({
          meetingId: meeting.id,
          startTime: meeting.starttime && meeting.starttime.toDate ? meeting.starttime.toDate().toISOString() : null,
          createdAt: new Date().toISOString()
        })
      });
      console.log(`[Pre-create oci] Room ${roomName} created in LiveKit`);
    } catch (createError) {
      if (createError.message && createError.message.includes('already exists')) {
        console.log(`[Pre-create oci] Room ${roomName} already exists - continuing`);
      } else {
        throw createError;
      }
    }
  }

  // STEP 3: Firestore openviduroom doc (create or reactivate) — verbatim AWS field logic
  // plus the mediaProvider stamp (restamped on reactivate: the room is hosted HERE now).
  const hostIds = meeting.hosts ? meeting.hosts.map(ref => {
    return ref.path ? ref.path.split('/').pop() : ref.id;
  }) : [];
  const participantid = (meeting.bookedby && meeting.bookedby.id) || meeting.bookedby || null;

  // Read only the participant + hosts named in the title. This used to load the WHOLE
  // profile_data collection once per meeting, which pushed this 5-minute job past its memory
  // limit mid pre-create (prod, 2026-11-12 14:55 and 17:25 IST). The openviduroom doc was
  // then never written, so the 15:00 / 17:30 ticks counted 0 rooms and stopped the server
  // at meeting start.
  const mapProfile = {};
  const profileIds = [...new Set([participantid, ...hostIds].filter(id => typeof id === 'string' && id))];
  if (profileIds.length > 0) {
    const profileDocs = await admin.firestore().getAll(
      ...profileIds.map(id => admin.firestore().collection('profile_data').doc(id))
    );
    profileDocs.forEach(doc => {
      if (doc.exists) mapProfile[doc.id] = doc.data().name || 'Unknown';
    });
  }

  let appointmentTypeName = 'Appointment';
  if (meeting.appointment && meeting.appointment.id) {
    const appointmentDoc = await admin.firestore().collection('appointmenttype').doc(meeting.appointment.id).get();
    if (appointmentDoc.exists) {
      appointmentTypeName = appointmentDoc.data().appointmenttype || 'Appointment';
    }
  }

  const participantName = mapProfile[participantid] || 'Guest';
  const hostNames = hostIds.map(hostId => mapProfile[hostId] || 'Unknown').join(', ');
  const title = `${participantName} - ${appointmentTypeName} (${hostNames})`;

  const roomRef = admin.firestore().collection('openviduroom').doc(meeting.id);
  const roomDoc = await roomRef.get();

  if (!roomDoc.exists) {
    await roomRef.set({
      active: true,
      createddate: admin.firestore.FieldValue.serverTimestamp(),
      sessiontype: "appointment",
      sessionid: meeting.id,
      roomid: meeting.id,
      hosts: hostIds,
      participantid: participantid,
      title: title,
      metadata: { appointmentid: meeting.id },
      mediaProvider: 'oci',
    });
    console.log(`[Pre-create oci] Firestore room document created: ${meeting.id}`);
  } else if (!roomDoc.data().active) {
    await roomRef.update({
      active: true,
      mediaProvider: 'oci',
      metadata: { ...roomDoc.data().metadata, title: title }
    });
    console.log(`[Pre-create oci] Firestore room document reactivated: ${meeting.id}`);
  } else {
    console.log(`[Pre-create oci] Firestore room document already active: ${meeting.id}`);
  }

  // STEP 4: mark the appointment pre-created
  await admin.firestore().collection('appointments').doc(meeting.id).update({
    livekitRoomPreCreated: true,
    livekitRoomName: roomName,
    livekitRoomCreatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log(`[Pre-create oci] Appointment marked as pre-created: ${meeting.id}`);
}

// Which cloud is allowed to act right now. Written by the monitor screen's selector
// (developer role). STRICTLY the DB value (openvidu server/mediaprovider) — no hardcoded
// fallback (operator decision 2026-08-14): if the doc/field is missing or unreadable,
// return null so this controller takes NO lifecycle actions this tick.
async function getActiveProvider() {
  try {
    const snap = await admin.firestore().doc('openvidu server/mediaprovider').get();
    return (snap.exists && snap.data().activeprovider) || null;
  } catch (e) {
    console.error('getActiveProvider failed — OCI controller will idle:', e && e.message);
    return null;
  }
}

// ---- Scheduled controller (twin of AWS CheckMasternodeStatus) ----
// Auto-start for upcoming meetings, housekeeping, DC-safe pool right-sizing, and
// stop-to-zero when idle. Always finishes by refreshing the status doc.
// activeprovider gate: when OCI is not the active provider this tick only refreshes the
// status doc (keeps the monitor's inactive-server alert truthful) and takes NO lifecycle
// actions — so even with both schedulers running, exactly one cloud creates rooms.
// memory: 512MiB — the default 256MiB was exceeded in prod (OCI SDK clients + room pre-create).
exports.CheckOciNodeStatus = onSchedule({ schedule: "*/5 * * * *", timeZone: "Asia/Kolkata", region: "asia-south1", timeoutSeconds: 300, memory: "512MiB", secrets: [OCI_TENANCY_OCID, OCI_USER_OCID, OCI_KEY_FINGERPRINT, OCI_API_PRIVATE_KEY, OCI_MASTER_INSTANCE_ID, OCI_MEDIA_POOL_ID, LIVEKIT_URL_OCI, LIVEKIT_API_KEY_OCI, LIVEKIT_API_SECRET_OCI] }, async (event) => {
  const clients = getOciClients();

  try {
    const activeProvider = await getActiveProvider();
    if (activeProvider !== 'oci') {
      console.log(`activeprovider=${activeProvider} — OCI controller idle (status refresh only)`);
      await refreshOciStatus(clients);
      return null;
    }

    // 1. Current master state. Collected once; reused for the final status write when this
    // run changes nothing on the Oracle side (2026-11-14 plan item 1.4).
    const status = await collectOciStatus(clients);
    const masterState = status.master.state;
    const masterRunning = masterState === 'running';
    let changed = false;
    console.log(`OCI master is currently: ${masterRunning ? 'RUNNING' : 'NOT RUNNING'} (${masterState})`);

    // 2. Upcoming meetings (same query as AWS — platform openvidu, next 15 min)
    const now = admin.firestore.Timestamp.now();
    const fifteenMinutesFromNow = admin.firestore.Timestamp.fromMillis(Date.now() + 15 * 60 * 1000);
    const meetingsSnapshot = await admin.firestore()
      .collection('appointments')
      .where('platform', '==', 'openvidu')
      .where('starttime', '>', now)
      .where('starttime', '<=', fifteenMinutesFromNow)
      .where('cancelled', '==', false)
      .where('attended', '==', false)
      .get();

    let meetings = [];
    if (!meetingsSnapshot.empty) {
      meetings = meetingsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      console.log(`Found ${meetings.length} upcoming meeting(s)`);
    }

    // 3. Server not running → start it for upcoming meetings OR for rooms people just opened
    // (wake-on-join, plan item 1.2 / D2). Only from a clean 'stopped' state: while it is
    // starting or stopping, wait for the next run instead of issuing another action.
    if (!masterRunning) {
      if (masterState !== 'stopped') {
        console.log(`OCI master is ${masterState} - no lifecycle action this run`);
        await refreshOciStatus(clients, status);
        return null;
      }
      const waiting = await findRoomsWaitingForServer();
      if (meetings.length === 0 && waiting.length === 0) {
        await refreshOciStatus(clients, status);
        return null;
      }
      const waitingIds = new Set(waiting.map(d => d.id));
      const poolSize = mediaNodesNeeded(waitingIds, meetings);
      console.log(`Starting OCI master: ${meetings.length} upcoming meeting(s), ${waiting.length} room(s) waiting [${[...waitingIds].join(', ')}] -> ${poolSize} media node(s)`);
      await startOciMaster(clients, poolSize);
      // Mark the rooms the server was woken for: stamp the cloud (so they are counted as
      // active OCI rooms and the next runs keep the server on) and wokeServerAt (so
      // housekeeping leaves them alone while their people wait for the boot).
      await Promise.all(waiting.map(d => d.ref.update({
        mediaProvider: 'oci',
        wokeServerAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(e => console.error(`Wake mark failed for ${d.id}:`, e && e.message))));
      await refreshOciStatus(clients);
      return null;
    }

    // 4. Pre-create rooms for upcoming meetings (may grow the pool when at capacity)
    if (meetings.length > 0) {
      console.log('Pre-creating LiveKit rooms (OCI)...');
      changed = true;
      for (const meeting of meetings) {
        if (!meeting.livekitRoomPreCreated) {
          await createOciRoomForMeeting(meeting, clients).catch(e =>
            console.error(`Pre-create failed for ${meeting.id}:`, e && e.message));
        } else {
          console.log(`Room already exists for meeting ${meeting.id}`);
        }
      }
    }

    // 5. Housekeeping + active rooms (OCI-scoped). null = Firestore unreadable → treat as busy.
    await houseKeepOciRooms();
    const activeRoomIds = await getOciActiveRoomIds();
    console.log(`Active OCI rooms after housekeeping: ${activeRoomIds ? activeRoomIds.size : 'unknown'}`);

    // 6. Stop-to-zero when fully idle (no active rooms AND nothing upcoming in 15m)
    if (activeRoomIds !== null && activeRoomIds.size === 0 && meetings.length === 0) {
      console.log('No active OCI rooms and no upcoming meetings - stopping master');
      await stopOciMaster(clients);
      await refreshOciStatus(clients);
      return null;
    }

    // 7. Pool top-up: one node per active room + per upcoming meeting not active yet (plan
    // item 1.5, so a burst of meetings gets its nodes ordered together). Compared against a
    // FRESH pool size and never lowered here (plan item 1.6): the old code compared against
    // the size read at the start of the run, so when pre-create had already grown the pool
    // this run it set a smaller number and Oracle deleted a booting node (prod, Fri 06 Nov
    // 16:55: 2 → 3 → 2). Scale-down only happens via stop-to-zero.
    if (activeRoomIds !== null) {
      const target = mediaNodesNeeded(activeRoomIds, meetings);
      const { instancePool } = await clients.mgmt.getInstancePool({ instancePoolId: OCI_MEDIA_POOL_ID.value() });
      if (instancePool.size < target) {
        console.log(`reconcileOciMediaUp: pool ${instancePool.size} -> ${target} (active rooms: ${activeRoomIds.size}, upcoming meetings: ${meetings.length})`);
        await setPoolSize(clients.mgmt, target);
        changed = true;
      }
    }

    // 8. Always leave a fresh status doc (re-read from Oracle only if this run changed something)
    await refreshOciStatus(clients, changed ? null : status);
    return null;

  } catch (error) {
    console.error('Error in CheckOciNodeStatus:', error);
    throw error;
  }
});

// ---- Manual controls (twins of AWS start/stopMasterNodeHTTP + scaleMediaNodes) ----
// Each finishes with a status refresh so the monitor UI reflects the click in seconds.

// These start / stop / resize paid servers, so they need a signed-in StarLabs user (Firebase
// ID token in `Authorization: Bearer …`). Until 2026-11-14 they were open to anyone with the
// URL. Signed-in (not admin-only) because the instant-meeting screen also calls the start
// function for whoever creates the room. Returns the decoded token, or null after sending 401.
async function requireSignedIn(req, res, action) {
  const header = req.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      console.log(`${action} requested by uid=${decoded.uid}`);
      return decoded;
    } catch (err) {
      console.warn(`${action}: invalid ID token:`, err && err.message);
    }
  }
  res.status(401).json({ error: "Sign-in required" });
  return null;
}

exports.startOciMasterHTTP = onRequest({ secrets: [...exports.API_SECRETS], cors: true }, async (req, res) => {
  try {
    if (!(await requireSignedIn(req, res, 'startOciMasterHTTP'))) return;
    console.log('Start OCI master node request');
    const clients = getOciClients();

    const { instance } = await clients.compute.getInstance({ instanceId: OCI_MASTER_INSTANCE_ID.value() });
    if (instance.lifecycleState === "RUNNING") {
      return res.status(400).json({ error: 'Master node is already running' });
    }

    await startOciMaster(clients);
    await refreshOciStatus(clients);

    res.status(200).json({ message: 'OCI master node starting... (status will update automatically)' });
  } catch (error) {
    console.error('Error starting OCI master:', error);
    res.status(500).json({ error: error.message || 'Failed to start OCI master node' });
  }
});

exports.stopOciMasterHTTP = onRequest({ secrets: [...exports.API_SECRETS], cors: true }, async (req, res) => {
  try {
    if (!(await requireSignedIn(req, res, 'stopOciMasterHTTP'))) return;
    console.log('Stop OCI master node request');
    const clients = getOciClients();

    const { instance } = await clients.compute.getInstance({ instanceId: OCI_MASTER_INSTANCE_ID.value() });
    if (instance.lifecycleState !== "RUNNING") {
      return res.status(400).json({ error: 'Master node is already stopped' });
    }

    const activeRooms = await getOciActiveRoomsCount();
    if (activeRooms > 0) {
      return res.status(400).json({ error: `Cannot stop: ${activeRooms} active room(s)`, activeRooms: activeRooms });
    }

    await stopOciMaster(clients);
    await refreshOciStatus(clients);

    res.status(200).json({ message: 'OCI master node stopping... (status will update automatically)' });
  } catch (error) {
    console.error('Error stopping OCI master:', error);
    res.status(500).json({ error: error.message || 'Failed to stop OCI master node' });
  }
});

exports.scaleOciMediaNodes = onRequest({ secrets: [...exports.API_SECRETS], cors: true }, async (req, res) => {
  try {
    if (!(await requireSignedIn(req, res, 'scaleOciMediaNodes'))) return;
    const { action } = req.body;
    if (!action || !['scale-up', 'scale-down'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Use "scale-up" or "scale-down"' });
    }

    console.log(`Scale OCI media nodes: ${action}`);
    const clients = getOciClients();

    const { instancePool } = await clients.mgmt.getInstancePool({ instancePoolId: OCI_MEDIA_POOL_ID.value() });
    const currentCapacity = instancePool.size;

    let newCapacity;
    if (action === 'scale-up') {
      if (currentCapacity >= MAX_MEDIA_NODES) {
        return res.status(400).json({ error: `Already at maximum capacity (${MAX_MEDIA_NODES})`, currentCapacity, maxSize: MAX_MEDIA_NODES });
      }
      newCapacity = currentCapacity + 1;
    } else {
      if (currentCapacity <= 0) {
        return res.status(400).json({ error: 'Already at minimum capacity (0)', currentCapacity, minSize: 0 });
      }
      newCapacity = currentCapacity - 1;
    }

    console.log(`Scaling OCI pool: ${currentCapacity} → ${newCapacity}`);
    await setPoolSize(clients.mgmt, newCapacity);
    await refreshOciStatus(clients);

    res.status(200).json({
      message: `Media nodes ${action === 'scale-up' ? 'scaling up' : 'scaling down'}...`,
      previousCapacity: currentCapacity,
      newCapacity: newCapacity
    });
  } catch (error) {
    console.error('Error scaling OCI media:', error);
    res.status(500).json({ error: error.message || 'Failed to scale OCI media nodes' });
  }
});

// ---- OCI Events push (twin of awsEventWebhook / EventBridge) ----
// OCI Events rule (compute state changes in the compartment) → Notifications topic →
// HTTPS subscription → this endpoint. Events are only a doorbell: state truth is always
// re-fetched from the OCI API via refreshOciStatus(). Handles the ONS subscription
// confirmation handshake automatically.
exports.ociEventWebhook = onRequest({ secrets: [...exports.API_SECRETS] }, async (req, res) => {
  try {
    let body = req.body;
    if (Buffer.isBuffer(body)) body = body.toString("utf8");
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (_) { /* keep as string */ }
    }

    // Subscription confirmation: GET the confirmation link once to activate.
    const confirmUrl = body && typeof body === "object"
      ? (body.ConfirmationURL || body.confirmationURL || body.confirmationUrl || body.SubscribeURL)
      : null;
    if (confirmUrl) {
      console.log("ONS subscription confirmation received - confirming...");
      await axios.get(confirmUrl);
      console.log("ONS subscription confirmed");
      return res.status(200).send("confirmed");
    }

    // Some ONS payload variants nest the confirmation link in a plain-text body.
    if (typeof body === "string" && body.includes("http") && body.toLowerCase().includes("confirmation")) {
      const match = body.match(/https:\/\/[^\s"']+/);
      if (match) {
        console.log("ONS confirmation link found in text body - confirming...");
        await axios.get(match[0]);
        return res.status(200).send("confirmed");
      }
    }

    const eventType = body && typeof body === "object" ? (body.eventType || (body.data && body.data.eventType) || "unknown") : "unknown";
    console.log(`OCI event received (${eventType}) - refreshing status`);

    await refreshOciStatus(getOciClients());
    // Always 200 so ONS does not retry-storm on our processing hiccups.
    return res.status(200).send("ok");
  } catch (error) {
    console.error("ociEventWebhook error:", error && error.message);
    return res.status(200).send("ok");
  }
});
