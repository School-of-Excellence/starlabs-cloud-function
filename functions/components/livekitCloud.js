/**
 * LiveKit CLOUD variant of the video-call functions.
 *
 * These mirror the self-hosted functions in openVidu.js but target a LiveKit **Cloud** project
 * instead of the AWS master/media cluster — so there is NO autoscaling, no master-node check, and
 * no 503 SCALING_IN_PROGRESS handshake (Cloud is fully managed). They read/write the SAME Firestore
 * `openviduroom` collection with the SAME fields + workflow, so the app behaves identically to the
 * self-hosted flow. Recording is composite egress → the same S3 buckets.
 *
 * Called by the Angular <app-livekit-cloud-room> component (route /livekit-cloud-room/:roomid).
 *
 * Secrets: LIVEKIT_CLOUD_URL / LIVEKIT_CLOUD_API_KEY / LIVEKIT_CLOUD_API_SECRET (the Cloud project),
 * and the existing AWS_ACCESS_KEY / AWS_SECRET (S3 recording storage — same buckets).
 */
const admin = require('firebase-admin');
const commonService = require('./service');
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const cors = require("cors")({ origin: true });
const crypto = require("crypto");
const axios = require("axios");
const livekitServer = require("livekit-server-sdk");

const LIVEKIT_CLOUD_URL = defineSecret("LIVEKIT_CLOUD_URL");
const LIVEKIT_CLOUD_API_KEY = defineSecret("LIVEKIT_CLOUD_API_KEY");
const LIVEKIT_CLOUD_API_SECRET = defineSecret("LIVEKIT_CLOUD_API_SECRET");
const AWS_ACCESS_KEY = defineSecret("AWS_ACCESS_KEY");
const AWS_SECRET = defineSecret("AWS_SECRET");

const CLOUD_SECRETS = [LIVEKIT_CLOUD_URL, LIVEKIT_CLOUD_API_KEY, LIVEKIT_CLOUD_API_SECRET];

/** POST { roomName, participantName, participantId } -> { success, url, token, roomName } */
exports.createLivekitCloudToken = onRequest({ secrets: CLOUD_SECRETS }, async (req, res) => {
    cors(req, res, async () => {
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Method Not Allowed. Only POST allowed" });
        }

        const { roomName, participantName, participantId } = req.body;
        if (!roomName || !participantId) {
            return res.status(400).json({ error: "roomName and participantId are required" });
        }

        try {
            const apiKey = LIVEKIT_CLOUD_API_KEY.value();
            const apiSecret = LIVEKIT_CLOUD_API_SECRET.value();
            const url = LIVEKIT_CLOUD_URL.value();

            // Ensure the Cloud room exists (idempotent — Cloud auto-scales, so no capacity check).
            const roomClient = new livekitServer.RoomServiceClient(url, apiKey, apiSecret);
            try {
                await roomClient.createRoom({ name: roomName, emptyTimeout: 300, maxParticipants: 50 });
                console.log(`[${roomName}] ✅ Cloud room created`);
            } catch (createError) {
                const msg = createError && createError.message ? createError.message : "";
                if (msg.includes("already exists") || msg.includes("RoomExists")) {
                    console.log(`[${roomName}] ✅ Joining existing Cloud room`);
                } else {
                    throw createError;
                }
            }

            // Plain identity == participantId — identical to createOpenViduToken. LiveKit's own
            // last-connection-wins eviction enforces "one person, one tab"; the client's Disconnected
            // handler leaves cleanly (no auto-resume), so there is no eviction ping-pong.
            const at = new livekitServer.AccessToken(apiKey, apiSecret, {
                identity: participantId,
                name: participantName,
            });
            at.addGrant({
                roomJoin: true,
                room: roomName,
                canSubscribe: true,
                canPublish: true,
                canPublishData: true,
            });
            const token = await at.toJwt();

            // Stamp the provider so the self-hosted AWS scheduler (openVidu.js) skips this room —
            // Cloud rooms self-manage and must not drive AWS media scaling or housekeeping. merge:true
            // so no other field is touched. AWAITED (not fire-and-forget): a gen2 instance can freeze
            // after res is sent, so an un-awaited write may never flush — and this stamp is the ONLY
            // signal that keeps the AWS scheduler off this room. .catch so it can never throw.
            await admin.firestore().collection("openviduroom").doc(roomName)
                .set({ provider: "livekit-cloud" }, { merge: true })
                .catch(err => console.log(`[${roomName}] provider stamp failed:`, err && err.message));

            console.log(`[${roomName}] Cloud token generated for ${participantName} (${participantId})`);
            return res.status(200).json({ success: true, url, token, roomName });
        } catch (err) {
            console.error(`[${roomName}] createLivekitCloudToken error:`, err);
            return res.status(500).json({ success: false, error: err.message || err.toString() });
        }
    });
});

/** POST { roomId } -> starts composite recording to S3; writes egressInfo + recordingstatus. */
exports.livekitCloudStartRecording = onRequest({ secrets: [...CLOUD_SECRETS, AWS_ACCESS_KEY, AWS_SECRET] }, async (req, res) => {
    cors(req, res, async () => {
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Method Not Allowed. Only POST allowed" });
        }
        const { roomId } = req.body;
        if (!roomId) return res.status(400).json({ error: "roomId is required" });

        try {
            const egressClient = new livekitServer.EgressClient(
                LIVEKIT_CLOUD_URL.value(), LIVEKIT_CLOUD_API_KEY.value(), LIVEKIT_CLOUD_API_SECRET.value(),
            );
            const fileOutput = new livekitServer.EncodedFileOutput({
                fileType: livekitServer.EncodedFileType.MP4,
                filepath: `recordings/${roomId}-${Date.now()}`,
                disableManifest: true,
                output: {
                    case: "s3",
                    value: {
                        bucket: commonService.production ? "openvidu-meet-recordings-prod" : "openvidu-meet-recordings-dev",
                        region: "ap-south-1",
                        accessKey: AWS_ACCESS_KEY.value(),
                        secret: AWS_SECRET.value(),
                    },
                },
            });

            const egressList = await egressClient.listEgress({ roomName: roomId });
            const liveEgress = egressList.find(e => e.roomName == roomId && (e.status === "EGRESS_ACTIVE" || e.status === "EGRESS_STARTING"));

            let egressInfo;
            if (!liveEgress) {
                egressInfo = await egressClient.startRoomCompositeEgress(roomId, { file: fileOutput });
            } else {
                egressInfo = liveEgress;
            }

            const payload = JSON.parse(JSON.stringify(egressInfo));
            await admin.firestore().collection("openviduroom").doc(roomId).update({
                egressInfo: payload,
                recordingstatus: "started",
            }).catch(err => console.log("Error saving recording detail", err));

            return res.status(200).json({ egressInfo });
        } catch (error) {
            console.error("unable to start recording:", error);
            return res.status(500).json({ error: error.message || error.toString() });
        }
    });
});

/** POST { egressId, roomId } -> stops recording; writes recordingstatus. */
exports.livekitCloudStopRecording = onRequest({ secrets: CLOUD_SECRETS }, async (req, res) => {
    cors(req, res, async () => {
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Method Not Allowed. Only POST allowed" });
        }
        const { egressId, roomId } = req.body;
        if (!egressId || !roomId) return res.status(400).json({ error: "egressId & roomId is required" });

        try {
            const egressClient = new livekitServer.EgressClient(
                LIVEKIT_CLOUD_URL.value(), LIVEKIT_CLOUD_API_KEY.value(), LIVEKIT_CLOUD_API_SECRET.value(),
            );
            const egressList = await egressClient.listEgress({ egressId });
            const liveEgress = egressList.filter(e => e.egressId == egressId && (e.status === "EGRESS_ACTIVE" || e.status === "EGRESS_STARTING"));

            if (liveEgress.length !== 0) {
                try {
                    const egressInfo = await egressClient.stopEgress(egressId);
                    const payload = JSON.parse(JSON.stringify(egressInfo));
                    await admin.firestore().collection("openviduroom").doc(roomId).update({
                        egressInfo: payload,
                        recordingstatus: "ended",
                    }).catch(err => console.log("Error saving recording detail", err));
                    return res.status(200).json({ egressInfo });
                } catch (err) {
                    if (err.code === "failed_precondition") {
                        await admin.firestore().collection("openviduroom").doc(roomId).update({ recordingstatus: "ended" });
                        return res.status(200).json({ result: "Already ended" });
                    }
                    throw err;
                }
            } else {
                await admin.firestore().collection("openviduroom").doc(roomId).update({
                    recordingstatus: "ended",
                }).catch(err => console.log("Error saving recording detail", err));
                return res.status(200).json({ result: "There is no active recording found" });
            }
        } catch (error) {
            console.error("unable to stop recording:", error);
            return res.status(500).json({ error: error.message || error.toString() });
        }
    });
});

/** POST { roomName } -> deletes the Cloud room + marks Firestore finished. */
exports.livekitCloudCloseRoom = onRequest({ secrets: CLOUD_SECRETS }, async (req, res) => {
    cors(req, res, async () => {
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Method Not Allowed. Only POST allowed" });
        }
        const roomName = req.body.roomName;
        if (!roomName) return res.status(400).json({ error: "roomName is required" });

        try {
            const roomService = new livekitServer.RoomServiceClient(
                LIVEKIT_CLOUD_URL.value(), LIVEKIT_CLOUD_API_KEY.value(), LIVEKIT_CLOUD_API_SECRET.value(),
            );
            await roomService.deleteRoom(roomName);
            await admin.firestore().collection("openviduroom").doc(roomName).update({
                active: false,
                roomstatus: "finished",
            });
            return res.json({ message: "Room closed for all participants" });
        } catch (err) {
            console.error("Delete room error:", err);
            return res.status(500).json({ error: err.message || err.toString() });
        }
    });
});

/** POST { roomName, participantIdentity } -> mutes that participant's audio (host only). */
exports.livekitCloudMuteParticipant = onRequest({ secrets: CLOUD_SECRETS }, async (req, res) => {
    cors(req, res, async () => {
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Method Not Allowed. Only POST allowed" });
        }
        const { roomName, participantIdentity } = req.body;
        if (!roomName || !participantIdentity) {
            return res.status(400).json({ error: "roomName and participantIdentity are required" });
        }
        try {
            const roomService = new livekitServer.RoomServiceClient(
                LIVEKIT_CLOUD_URL.value(), LIVEKIT_CLOUD_API_KEY.value(), LIVEKIT_CLOUD_API_SECRET.value(),
            );
            const participant = await roomService.getParticipant(roomName, participantIdentity);
            if (!participant) return res.status(404).json({ error: "Participant not found in room" });

            const audioTrack = participant.tracks.find(t => t.type === 0); // 0 = AUDIO
            if (!audioTrack) return res.status(404).json({ error: "No audio track found for participant" });

            await roomService.mutePublishedTrack(roomName, participantIdentity, audioTrack.sid, true);
            console.log(`[${roomName}] muted participant ${participantIdentity}`);
            return res.status(200).json({ success: true, message: `${participantIdentity} has been muted` });
        } catch (err) {
            console.error(`[${roomName}] Mute error:`, err);
            return res.status(500).json({ error: err.message || err.toString() });
        }
    });
});

/** POST { roomName, participantIdentity } -> removes that participant (host only). */
exports.livekitCloudKickParticipant = onRequest({ secrets: CLOUD_SECRETS }, async (req, res) => {
    cors(req, res, async () => {
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Method Not Allowed. Only POST allowed" });
        }
        const { roomName, participantIdentity } = req.body;
        if (!roomName || !participantIdentity) {
            return res.status(400).json({ error: "roomName and participantIdentity are required" });
        }
        try {
            const roomDoc = await admin.firestore().collection("openviduroom").doc(roomName).get();
            if (!roomDoc.exists) return res.status(404).json({ error: "Room not found" });

            const roomService = new livekitServer.RoomServiceClient(
                LIVEKIT_CLOUD_URL.value(), LIVEKIT_CLOUD_API_KEY.value(), LIVEKIT_CLOUD_API_SECRET.value(),
            );
            await roomService.removeParticipant(roomName, participantIdentity);
            console.log(`[${roomName}] removed participant ${participantIdentity}`);
            return res.status(200).json({ success: true, message: `${participantIdentity} has been removed from the room` });
        } catch (err) {
            console.error(`[${roomName}] Kick error:`, err);
            return res.status(500).json({ error: err.message || err.toString() });
        }
    });
});

/**
 * LiveKit Cloud webhook receiver — same participant-tracking + auto-record workflow as
 * onEventOpenVidu. Configure its URL in the LiveKit Cloud dashboard (Settings → Webhooks).
 * Occupancy (participantlive) keys on the unique connection identity; person-level tracking
 * (participantjoined / participantghost) keys on the base id (suffix stripped).
 */
exports.onEventLivekitCloud = onRequest({ secrets: [LIVEKIT_CLOUD_API_KEY, LIVEKIT_CLOUD_API_SECRET] }, async (req, res) => {
    cors(req, res, async () => {
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Method Not Allowed. Only POST allowed" });
        }
        try {
            const webhookReceiver = new livekitServer.WebhookReceiver(
                LIVEKIT_CLOUD_API_KEY.value(), LIVEKIT_CLOUD_API_SECRET.value(),
            );
            const event = await webhookReceiver.receive(req.body, req.get("Authorization"));
            console.log(`WebhookReceiver (cloud): ${JSON.stringify(event)}`);

            const payload = JSON.parse(JSON.stringify(event));
            await admin.firestore().collection("openvidu event").add({
                payload,
                time: admin.firestore.FieldValue.serverTimestamp(),
            }).catch(err => console.log(err));

            if (event.event == "room_started") {
                await admin.firestore().collection("openviduroom").doc(event.room.name).update({ roomstatus: "live" });
            } else if (event.event === "participant_joined") {
                let startRecording = false;
                await admin.firestore().runTransaction(async (tx) => {
                    const participantId = event.participant.identity;        // plain id — identical to openVidu.js
                    const ref = admin.firestore().collection("openviduroom").doc(event.room.name);
                    const snap = await tx.get(ref);
                    const active = new Set((snap.data() || {})["participantlive"] || []);
                    const activeBeforeCount = active.size;
                    active.add(participantId);

                    if (activeBeforeCount === 0 && active.size === 1) {
                        startRecording = true;
                        tx.update(ref, { recordingstatus: "starting" });
                    }

                    const roomParticipantData = { participantlive: Array.from(active), roomstatus: "live" };
                    if (payload.participant.kind === "STANDARD") {
                        const ghostID = " - Ghost";
                        if (participantId.trim().endsWith(ghostID)) {
                            const originalId = participantId.slice(0, -ghostID.length).trim();
                            roomParticipantData["participantghost"] = admin.firestore.FieldValue.arrayUnion(originalId);
                        } else {
                            roomParticipantData["participantjoined"] = admin.firestore.FieldValue.arrayUnion(participantId);
                        }
                    }
                    tx.update(ref, roomParticipantData);
                });

                if (startRecording) {
                    try {
                        const result = await axios.post(`https://us-central1-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/livekitCloudStartRecording`, { roomId: event.room.name });
                        console.log('Room Started and Recording Started:', result.data);
                    } catch (recordingFailed) {
                        console.log('Room Restarted and Recording Failed:', recordingFailed);
                        admin.firestore().collection("openviduroom").doc(event.room.name).update({ recordingstatus: "idle" });
                    }
                }
            } else if (event.event === "participant_left") {
                let stopRecording = false;
                let egressId;
                await admin.firestore().runTransaction(async (tx) => {
                    const ref = admin.firestore().collection("openviduroom").doc(event.room.name);
                    const snap = await tx.get(ref);
                    const data = snap.data() || {};
                    const live = new Set(data["participantlive"] || []);
                    const recordingstatus = data["recordingstatus"] || "";

                    live.delete(event.participant.identity);

                    if (live.size === 0 && recordingstatus === "started") {
                        stopRecording = true;
                        egressId = (data["egressInfo"] || {})["egressId"];
                        tx.update(ref, { recordingstatus: "ending" });
                    }
                    tx.update(ref, {
                        participantlive: Array.from(live),
                        roomstatus: live.size === 0 ? "finished" : "live",
                    });
                });

                if (stopRecording && egressId) {
                    try {
                        const result = await axios.post(`https://us-central1-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/livekitCloudStopRecording`, { egressId, roomId: event.room.name });
                        console.log('Room Finished and Recording Completed:', result.data);
                    } catch (recordingError) {
                        console.log('All Participant Left and Recording Failed:', recordingError);
                        admin.firestore().collection("openviduroom").doc(event.room.name).update({ recordingstatus: "started" });
                    }
                }
            } else if (event.event == "room_finished") {
                await admin.firestore().collection("openviduroom").doc(event.room.name).update({
                    roomstatus: "finished",
                    participantlive: [],
                });
            } else if (event.event == "egress_started") {
                await admin.firestore().collection("openviduroom").doc(event.egressInfo.roomName).update({ recordingstatus: "started" });
            } else if (event.event == "egress_ended") {
                await admin.firestore().collection("openviduroom").doc(event.egressInfo.roomName).update({ recordingstatus: "ended" });
            }

            return res.status(200).json({ status: "Success" });
        } catch (error) {
            console.error("Webhook Error:", error);
            return res.status(500).json({ error: error.message || error.toString() });
        }
    });
});
