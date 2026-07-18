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

// Dev stack constants (hardcoded like the recording endpoint/bucket above; prod gets its
// own values in Phase 6). MAX_MEDIA_NODES caps pool growth — OCI pools have no native max.
const COMPARTMENT_ID = "ocid1.compartment.oc1..aaaaaaaahjgkgr2isamqfnk57wpqhcspchezpvo6jgwwbv2tfgn74o45nxca";
const OCI_REGION = "ap-mumbai-1";
const MAX_MEDIA_NODES = 5;

// One-room-one-node, same as AWS (CONFIG.maxRoomsPerInstance = 1 there).
const CONFIG = { maxRoomsPerInstance: 1 };

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

  const instanceStates = { healthy: 0, unhealthy: 0, pending: 0, terminating: 0, total: poolInstances.items.length };
  const instances = poolInstances.items.map(i => {
    const state = i.state || "";
    const isHealthy = state === "Running";
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
    };
  });

  let scalingStatus = 'stable';
  if (instancePool.size > instanceStates.healthy) scalingStatus = 'scaling-up';
  else if (instanceStates.terminating > 0) scalingStatus = 'scaling-down';

  console.log(`OCI pool: size=${instancePool.size} healthy=${instanceStates.healthy} status=${scalingStatus}`);

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
async function refreshOciStatus(clients) {
  const status = await collectOciStatus(clients);
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

async function startOciMaster(clients) {
  // Fire-and-forget START — no waiters (scheduled runs stay well under timeout; boot
  // progress is visible via the event webhook / next ticks). Pool follows to 1 so a media
  // node boots alongside the master, mirroring the operator's manual bring-up routine.
  await clients.compute.instanceAction({ instanceId: OCI_MASTER_INSTANCE_ID.value(), action: "START" });
  console.log('OCI master START issued');
  await setPoolSize(clients.mgmt, 1);
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

async function checkOciCapacity(mgmt, roomClient) {
  const { instancePool } = await mgmt.getInstancePool({ instancePoolId: OCI_MEDIA_POOL_ID.value() });
  const totalInstances = instancePool.size;
  if (totalInstances === 0) {
    return { allowed: false, activeRooms: 0, maxRooms: 0, totalInstances: 0, reason: 'No instances running' };
  }
  const rooms = await roomClient.listRooms();
  const activeRoomCount = rooms.length;
  const maxRooms = totalInstances * CONFIG.maxRoomsPerInstance;
  console.log(`OCI capacity: ${activeRoomCount}/${maxRooms} rooms (${totalInstances} instances)`);
  return { allowed: activeRoomCount < maxRooms, activeRooms: activeRoomCount, maxRooms, totalInstances };
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
      canCreateRoom = await checkOciCapacity(mgmt, roomClient);
    } catch (error) {
      // Cluster unreachable (master booting / node not registered) → scaling contract.
      console.log(`[${roomName}] OCI capacity check failed:`, error.message);
      return { scaling: true, activeRooms: 0, maxRooms: 0, totalInstances: 0 };
    }
    if (!canCreateRoom.allowed) {
      console.log(`[${roomName}] At OCI capacity - scaling up`);
      await scaleOciUp(mgmt).catch(e => console.error('OCI scaleUp failed:', e.message));
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
      capacity = await checkOciCapacity(clients.mgmt, roomClient);
    } catch (error) {
      console.error(`[Pre-create oci] Capacity check failed: ${error.message}`);
      capacity = { allowed: false };
    }
    if (!capacity.allowed) {
      console.log(`[Pre-create oci] At capacity - scaling up and deferring ${roomName}`);
      await scaleOciUp(clients.mgmt).catch(e => console.error('OCI scaleUp failed:', e.message));
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

  const mapProfile = {};
  const profilesSnapshot = await admin.firestore().collection('profile_data').get();
  profilesSnapshot.forEach(doc => {
    mapProfile[doc.id] = doc.data().name || 'Unknown';
  });

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
// (developer role). Fail-safe default 'aws' (matches the pre-multiprovider behavior).
async function getActiveProvider() {
  try {
    const snap = await admin.firestore().doc('openvidu server/mediaprovider').get();
    return (snap.exists && snap.data().activeprovider) || 'aws';
  } catch (e) {
    console.error('getActiveProvider failed, defaulting to aws:', e && e.message);
    return 'aws';
  }
}

// ---- Scheduled controller (twin of AWS CheckMasternodeStatus) ----
// Auto-start for upcoming meetings, housekeeping, DC-safe pool right-sizing, and
// stop-to-zero when idle. Always finishes by refreshing the status doc.
// activeprovider gate: when OCI is not the active provider this tick only refreshes the
// status doc (keeps the monitor's inactive-server alert truthful) and takes NO lifecycle
// actions — so even with both schedulers running, exactly one cloud creates rooms.
exports.CheckOciNodeStatus = onSchedule({ schedule: "*/5 * * * *", timeZone: "Asia/Kolkata", region: "asia-south1", timeoutSeconds: 300, secrets: [OCI_TENANCY_OCID, OCI_USER_OCID, OCI_KEY_FINGERPRINT, OCI_API_PRIVATE_KEY, OCI_MASTER_INSTANCE_ID, OCI_MEDIA_POOL_ID, LIVEKIT_URL_OCI, LIVEKIT_API_KEY_OCI, LIVEKIT_API_SECRET_OCI] }, async (event) => {
  const clients = getOciClients();

  try {
    const activeProvider = await getActiveProvider();
    if (activeProvider !== 'oci') {
      console.log(`activeprovider=${activeProvider} — OCI controller idle (status refresh only)`);
      await refreshOciStatus(clients);
      return null;
    }

    // 1. Current master state
    const status = await collectOciStatus(clients);
    const masterRunning = status.master.state === 'running';
    console.log(`OCI master is currently: ${masterRunning ? 'RUNNING' : 'NOT RUNNING'}`);

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

    // Start master if needed
    if (!masterRunning && meetings.length > 0) {
      console.log('Starting OCI master node...');
      await startOciMaster(clients);
      await refreshOciStatus(clients);
      return null;
    }

    if (masterRunning && meetings.length > 0) {
      console.log('Pre-creating LiveKit rooms (OCI)...');
      for (const meeting of meetings) {
        if (!meeting.livekitRoomPreCreated) {
          await createOciRoomForMeeting(meeting, clients).catch(e =>
            console.error(`Pre-create failed for ${meeting.id}:`, e && e.message));
        } else {
          console.log(`Room already exists for meeting ${meeting.id}`);
        }
      }
    }

    // 3. Housekeeping + active room count (OCI-scoped)
    let activeRooms = 0;
    if (masterRunning) {
      await houseKeepOciRooms();
      activeRooms = await getOciActiveRoomsCount();
      console.log(`Active OCI rooms after housekeeping: ${activeRooms}`);
    }

    // 4. Stop-to-zero when fully idle (no active rooms AND nothing upcoming in 15m)
    if (masterRunning && activeRooms === 0 && meetings.length === 0) {
      console.log('No active OCI rooms and no upcoming meetings - stopping master');
      await stopOciMaster(clients);
      await refreshOciStatus(clients);
      return null;
    }

    // 5. DC-safe pool right-sizing: scale UP to match active rooms (down to 0 happens in stop)
    if (masterRunning) {
      const target = Math.min(Math.max(activeRooms, 1), MAX_MEDIA_NODES);
      if (status.media.desiredCapacity < target) {
        console.log(`reconcileOciMediaUp: pool ${status.media.desiredCapacity} -> ${target} (active rooms: ${activeRooms})`);
        await setPoolSize(clients.mgmt, target);
      }
    }

    // 6. Always leave a fresh status doc
    await refreshOciStatus(clients);
    return null;

  } catch (error) {
    console.error('Error in CheckOciNodeStatus:', error);
    throw error;
  }
});

// ---- Manual controls (twins of AWS start/stopMasterNodeHTTP + scaleMediaNodes) ----
// Each finishes with a status refresh so the monitor UI reflects the click in seconds.

exports.startOciMasterHTTP = onRequest({ secrets: [...exports.API_SECRETS], cors: true }, async (req, res) => {
  try {
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
