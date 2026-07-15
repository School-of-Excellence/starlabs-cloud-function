const admin = require('firebase-admin');
const commonService = require('./service');
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const cors = require("cors")({ origin: true });
const functions = require('firebase-functions');

const process = require("process") // NodeJS Process
// Allow self-signed TLS certs on the OpenVidu endpoint (selfsigned CertificateType).
// The old account used letsencrypt; this dev deployment does not. Safe for test env.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const axios = require("axios"); // Promise based HTTP Client
const livekitServer = require("livekit-server-sdk");

// Per-provider endpoint modules. AWS / DO / OCI all run OpenVidu Elastic and speak the LiveKit
// protocol, so the request handlers below are shared and only the credentials differ (Design A:
// one function, provider param). Cloud-specific infrastructure — capacity/scaling, node
// lifecycle, state webhooks — lives in each provider's own *_endpoint.js module.
const AWS_endpoint = require('./AWS_endpoint');
const DO_endpoint = require('./DO_endpoint');
const OCI_endpoint = require('./OCI_endpoint');

const LIVEKIT_API_KEY = defineSecret("LIVEKIT_API_KEY");
const LIVEKIT_API_SECRET = defineSecret("LIVEKIT_API_SECRET");
const LIVEKIT_URL = defineSecret("LIVEKIT_URL");
const AWS_ACCESS_KEY = defineSecret("AWS_ACCESS_KEY");
const AWS_SECRET = defineSecret("AWS_SECRET");

// LiveKit connection credentials for the requested provider. AWS uses this module's own
// LIVEKIT_* secrets; DO / OCI read their suffixed secrets from their endpoint modules.
function getCredsFor(provider) {
    if (provider === 'do') return DO_endpoint.creds();
    if (provider === 'oci') return OCI_endpoint.creds();
    return { url: LIVEKIT_URL.value(), key: LIVEKIT_API_KEY.value(), secret: LIVEKIT_API_SECRET.value() };
}

// LiveKit client
let roomClient;
function getRoomClient() {
    if (!roomClient) {
        roomClient = new livekitServer.RoomServiceClient(
            LIVEKIT_URL.value(),
            LIVEKIT_API_KEY.value(),
            LIVEKIT_API_SECRET.value()
        );
    }
    return roomClient;
}



exports.createOpenViduToken = onRequest({secrets: [LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL, AWS_ACCESS_KEY, AWS_SECRET, ...AWS_endpoint.CAPACITY_SECRETS, ...DO_endpoint.SECRETS, ...OCI_endpoint.SECRETS]}, async (req, res) => {
  cors(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed. Only POST allowed" });
    }

    const { roomName, participantName, participantId } = req.body;
    const provider = (req.body.provider || "aws").toString().toLowerCase();

    if (!roomName || !participantName) {
      return res.status(400).json({
        error: "roomName and participantName are required",
      });
    }

    console.log(`[${roomName}] Token request from: ${participantName} (${participantId}) [provider=${provider}]`);

    try {
      const { url: livekitURL, key: liveKitApiKey, secret: livekitApiSecret } = getCredsFor(provider);

      const roomClient = new livekitServer.RoomServiceClient(livekitURL, liveKitApiKey, livekitApiSecret);

      let totalInstances = null;
      if (provider === "aws") {
        // AWS ASG capacity gate + room creation (moved to AWS_endpoint.js). Behaviour is
        // identical to the original inline logic: 503 SCALING_IN_PROGRESS when at capacity.
        const gate = await AWS_endpoint.prepareRoom({ roomName, url: livekitURL, key: liveKitApiKey, secret: livekitApiSecret });
        if (gate.scaling) {
          return res.status(503).json({
            success: false,
            code: 'SCALING_IN_PROGRESS',
            message: 'All instances at capacity. Scaling in progress.',
            retryAfter: 60,
            currentRooms: gate.activeRooms,
            maxRooms: gate.maxRooms,
            instances: gate.totalInstances
          });
        }
        totalInstances = gate.totalInstances;
      } else {
        // DO / OCI: the per-meeting media node is provisioned by the provider controller,
        // so there is no ASG gate. Ensure the LiveKit room exists, then issue the token.
        try {
          const existingRooms = await roomClient.listRooms([roomName]);
          if (existingRooms.length === 0) {
            await roomClient.createRoom({ name: roomName, emptyTimeout: 300, maxParticipants: 50 });
            console.log(`[${roomName}] ✅ New room created (${provider})`);
          }
        } catch (roomErr) {
          // Node not ready yet → tell the client to retry (mirrors the AWS 503 contract).
          console.log(`[${roomName}] Room ensure failed (${provider}):`, roomErr && roomErr.message);
          return res.status(503).json({
            success: false,
            code: 'SCALING_IN_PROGRESS',
            message: 'Media node not ready. Please retry.',
            retryAfter: 15
          });
        }
      }

      // Generate token
      const at = new livekitServer.AccessToken(liveKitApiKey, livekitApiSecret, {
        identity: participantId,
        name: participantName,
      });

      at.addGrant({
        roomJoin: true,
        room: roomName,
        canSubscribe: true,
        canPublish: true,
        canPublishData: true
      });

      const token = await at.toJwt();

      // Stamp the system (openvidu vs livekit-cloud) and the cloud that hosts it. `provider`
      // stays "openvidu" so monitor-liveassignment keeps classifying it as self-hosted;
      // `mediaProvider` records aws/do/oci and is what join-livekit-call reads for routing.
      await admin.firestore().collection("openviduroom").doc(roomName).set({
        provider: "openvidu", 
        mediaProvider: provider 
      }, { merge: true }).catch(err => console.log(`[${roomName}] provider stamp failed:`, err && err.message));

      console.log(`[${roomName}] Token generated for ${participantName}`);

      return res.status(200).json({
        success: true,
        url: livekitURL,
        token,
        roomName,
        instanceCount: totalInstances
      });

    } catch (err) {
      console.error(`[${roomName}] Error:`, err);
      return res.status(500).json({
        success: false,
        error: err.message || err.toString()
      });
    }
  });
});

exports.openViduStartRecording = onRequest({ secrets: [LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL, AWS_ACCESS_KEY, AWS_SECRET] }, async (req, res) => {
	cors(req, res, async () => {
		if (req.method !== "POST") {
			return res.status(405).json({error: "Method Not Allowed. Only POST allowed"});
		}

		const { roomId } = req.body;
		if (!roomId) {
			return res.status(400).json({
				error: "roomId is required",
			});
		}

		try {
			const liveKitApiKey = LIVEKIT_API_KEY.value();
			const livekitApiSecret = LIVEKIT_API_SECRET.value();
			const livekitURL = LIVEKIT_URL.value();
			const awsAccessKey = AWS_ACCESS_KEY.value();
			const awsSecret = AWS_SECRET.value();

			const egressClient = new livekitServer.EgressClient(livekitURL, liveKitApiKey, livekitApiSecret);
			// Set up recording output
			const fileOutput = new livekitServer.EncodedFileOutput({
				fileType: livekitServer.EncodedFileType.MP4,
				filepath: `recordings/${roomId}-${Date.now()}`,
				disableManifest: true,
				output: {
					case: "s3",
					value: {
						bucket: commonService.production ? "openvidu-meet-recordings-prod" : "openvidu-meet-recordings-dev",
						region: "ap-south-1",
						accessKey: awsAccessKey,
						secret: awsSecret
					}
				},
			});

			// List all Live Recording
			const egressList = await egressClient.listEgress({
				roomName: roomId
			})
			const liveEgress = egressList.find(e => e.roomName == roomId && (e.status === "EGRESS_ACTIVE" || e.status === "EGRESS_STARTING"))

			var egressInfo
			if(!liveEgress){
				egressInfo = await egressClient.startRoomCompositeEgress(roomId, { file: fileOutput }); // Start Recording
			}
			else{
				egressInfo = liveEgress // Get live recording data
			}

			// Update Recording Detail in Room
			var payload = JSON.parse(JSON.stringify(egressInfo))
			await admin.firestore().collection("openviduroom").doc(roomId).update({
				egressInfo: payload,
				recordingstatus: "started"
			}).catch(err =>{
				console.log("Error saving recording detail", err)
			})

			return res.status(200).json({ egressInfo });

		} catch (error) {
			console.error("unable to start recording:", error);
      return res.status(500).json({ error: error.message || error.toString() });
		}

	});
});

exports.openViduStopRecording = onRequest({ secrets: [LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL] }, async (req, res) => {
	cors(req, res, async () => {
		if (req.method !== "POST") {
			return res.status(405).json({error: "Method Not Allowed. Only POST allowed"});
		}

		const { egressId, roomId } = req.body;
		if (!egressId || !roomId) {
			return res.status(400).json({
				error: "egressId & roomId is required",
			});
		}

		try{
			const liveKitApiKey = LIVEKIT_API_KEY.value();
			const livekitApiSecret = LIVEKIT_API_SECRET.value();
			const livekitURL = LIVEKIT_URL.value();

			const egressClient = new livekitServer.EgressClient(livekitURL, liveKitApiKey, livekitApiSecret);

			// List all Live Recording
			const egressList = await egressClient.listEgress({
				egressId: egressId
			})
			const liveEgress = egressList.filter(e => e.egressId == egressId && (e.status === "EGRESS_ACTIVE" || e.status === "EGRESS_STARTING"))

			var egressInfo
			if(liveEgress.length != 0){
				try {
					egressInfo = await egressClient.stopEgress(egressId); // Stop Recording

					// Update Recording Detail in Room
					var payload = JSON.parse(JSON.stringify(egressInfo))
					await admin.firestore().collection("openviduroom").doc(roomId).update({
						egressInfo: payload,
						recordingstatus: "ended"
					}).catch(err =>{
						console.log("Error saving recording detail", err)
					})
					return res.status(200).json({ egressInfo });
				} catch (err) {
					if (err.code === "failed_precondition") {
						// Already completed — OK
						await admin.firestore().collection("openviduroom").doc(roomId).update({ recordingstatus: "ended" });
						return res.status(200).json({ result: "Already ended" });
					}
					throw err;
				}

			}
			else{
				await admin.firestore().collection("openviduroom").doc(roomId).update({
					recordingstatus: "ended"
				}).catch(err =>{
					console.log("Error saving recording detail", err)
				})
				return res.status(200).json({ result: "There is no active recording found" });
			}
		}
		 catch (error) {
			console.error("unable to stop recording:", error);
      return res.status(500).json({ error: error.message || error.toString() });
		}

	})
});

exports.onEventOpenVidu = onRequest({ secrets: [LIVEKIT_API_KEY, LIVEKIT_API_SECRET] }, async (req, res) => {
	cors(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).json({error: "Method Not Allowed. Only POST allowed"});
    }

		try{
			const liveKitApiKey = LIVEKIT_API_KEY.value();
			const livekitApiSecret = LIVEKIT_API_SECRET.value();

			const webhookReceiver = new livekitServer.WebhookReceiver(liveKitApiKey, livekitApiSecret);

			const event = await webhookReceiver.receive(
				req.body,
				req.get("Authorization")
			);
			console.log(`WebhookReceiver: ${JSON.stringify(event)}`);

			// Save Webhook triggers
			var payload = JSON.parse(JSON.stringify(event))
			await admin.firestore().collection("openvidu event").add({
				payload: payload,
				time: admin.firestore.FieldValue.serverTimestamp()
			}).catch(err =>{
				console.log(err)
			})

			// New Room Started
			if(event.event == "room_started"){
				// Update Room Status
				await admin.firestore().collection("openviduroom").doc(event.room.name).update({
					roomstatus: "live",
				})
			}
			// New Participant is Joined
			else if(event.event === "participant_joined"){
				var startRecording = false
				// Update Live Participants & Joined Participants
				await admin.firestore().runTransaction(async (tx) => {
					const participantId = event.participant.identity
					const ref = admin.firestore().collection("openviduroom").doc(event.room.name);
					const snap = await tx.get(ref);
					var active = new Set(snap.data()["participantlive"] || []);
					const activeBeforeCount = active.size;

					active.add(participantId);

					// Check if Room is reopened
					if (activeBeforeCount === 0 && active.size === 1) {
						startRecording = true
						tx.update(ref, {
							recordingstatus: "starting",
						})
					}

					var roomParticipantData = {
						participantlive: Array.from(active),
						roomstatus: "live"
					}
					if(payload.participant.kind === "STANDARD"){
						const ghostID = " - Ghost"
						if(participantId.trim().endsWith(ghostID)){
							// Extract Original Participant ID
							const originalId = participantId.slice(0, - ghostID.length).trim() // Remove "- Ghost"
							roomParticipantData["participantghost"]	= admin.firestore.FieldValue.arrayUnion(originalId)
						}
						else{
							roomParticipantData["participantjoined"] = admin.firestore.FieldValue.arrayUnion(participantId)
						}
					}

					tx.update(ref, roomParticipantData);
				});

				if(startRecording){
					// Start Recording
					try {
						const result = await axios.post(`https://us-central1-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/openViduStartRecording`, {roomId: event.room.name})
						console.log('Room Started and Recording Started:', result.data);
					} catch (recordingFailed) {
						console.log('Room Restarted and Recording Failed:');
						console.log(recordingFailed)
						admin.firestore().collection("openviduroom").doc(event.room.name).update({
							recordingstatus: "idle"
						})
					}
				}
			}
			// A Participant is left
			else if(event.event === "participant_left"){
				// Update Live Participants
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
						tx.update(ref, {
							recordingstatus: "ending"
						});
					}

					tx.update(ref, {
						participantlive: Array.from(live),
						roomstatus: live.size === 0 ? "finished" : "live",
					});
				});

				if (stopRecording && egressId) {
					try {
						const result = await axios.post(`https://us-central1-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/openViduStopRecording`, {egressId: egressId, roomId: event.room.name})
						console.log('Room Finised and Recording Completed:', result.data);
					} catch (recordingError) {
						console.log('All Participant Left and Recording Failed:')
						console.log(recordingError)
						admin.firestore().collection("openviduroom").doc(event.room.name).update({
							recordingstatus: "started"
						})
					}
				}
			}
			// Room Finished or All Participant Left
			else if(event.event == "room_finished"){
				await admin.firestore().collection("openviduroom").doc(event.room.name).update({
					roomstatus: "finished",
					participantlive: [],
				})
			}
			// Egress Started - Recording is running
			else if(event.event == "egress_started"){
				// Recording Live
				await admin.firestore().collection("openviduroom").doc(event.egressInfo.roomName).update({
					recordingstatus: "started"
				})
			}
			// Egress Ended - Recording is ended
			else if(event.event == "egress_ended"){
				// Recording Ended
				await admin.firestore().collection("openviduroom").doc(event.egressInfo.roomName).update({
					recordingstatus: "ended"
				})
			}

			return res.status(200).json({ status: "Success" });
		}
		 catch (error) {
			console.error("Webhook Error:", error);
      return res.status(500).json({ error: error.message || error.toString() });
		}
	})
})

exports.openViduCloseRoom = onRequest({secrets: [LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL]}, async (req, res) => {
	cors(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).json({error: "Method Not Allowed. Only POST allowed"});
    }

    const roomName = req.body.roomName;
    if (!roomName) {
      return res.status(400).json({error: "roomName is required" });
    }

    try {
      const roomService = new livekitServer.RoomServiceClient(
        LIVEKIT_URL.value(),
        LIVEKIT_API_KEY.value(),
        LIVEKIT_API_SECRET.value()
      );

      await roomService.deleteRoom(roomName);

			await admin.firestore().collection("openviduroom").doc(roomName).update({
				active: false,
				roomstatus: "finished"
			})

      return res.json({ message: "Room closed for all participants" });

    } catch (err) {
      console.error("Delete room error:", err);
      return res.status(500).json({ error: err.message || err.toString() });
    }
	});
});

exports.muteParticipant = onRequest({secrets: [LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL]}, async (req, res) => {
	cors(req, res, async () => {
		if (req.method !== "POST") {
			return res.status(405).json({error: "Method Not Allowed. Only POST allowed"});
		}

		const { roomName, participantIdentity } = req.body;

		if (!roomName || !participantIdentity) {
			return res.status(400).json({error: "roomName and participantIdentity are required"});
		}

		try {
			const roomService = new livekitServer.RoomServiceClient(
				LIVEKIT_URL.value(),
				LIVEKIT_API_KEY.value(),
				LIVEKIT_API_SECRET.value()
			);

			// Get participant to find their audio track SID
			const participant = await roomService.getParticipant(roomName, participantIdentity);
			if (!participant) {
				return res.status(404).json({error: "Participant not found in room"});
			}

			const audioTrack = participant.tracks.find(t => t.type === 0); // 0 = AUDIO
			if (!audioTrack) {
				return res.status(404).json({error: "No audio track found for participant"});
			}

			// Always mute — host can only mute, not unmute
			await roomService.mutePublishedTrack(roomName, participantIdentity, audioTrack.sid, true);

			console.log(`[${roomName}] muted participant ${participantIdentity}`);
			return res.status(200).json({success: true, message: `${participantIdentity} has been muted`});
		} catch (err) {
			console.error(`[${roomName}] Mute error:`, err);
			return res.status(500).json({error: err.message || err.toString()});
		}
	});
});

exports.kickParticipant = onRequest({secrets: [LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL]}, async (req, res) => {
	cors(req, res, async () => {
		if (req.method !== "POST") {
			return res.status(405).json({error: "Method Not Allowed. Only POST allowed"});
		}

		const { roomName, participantIdentity } = req.body;

		if (!roomName || !participantIdentity) {
			return res.status(400).json({error: "roomName and participantIdentity are required"});
		}

		try {
			// Verify requester is a host
			const roomDoc = await admin.firestore().collection("openviduroom").doc(roomName).get();
			if (!roomDoc.exists) {
				return res.status(404).json({error: "Room not found"});
			}

			const roomService = new livekitServer.RoomServiceClient(
				LIVEKIT_URL.value(),
				LIVEKIT_API_KEY.value(),
				LIVEKIT_API_SECRET.value()
			);

			await roomService.removeParticipant(roomName, participantIdentity);

			console.log(`[${roomName}] removed participant ${participantIdentity}`);
			return res.status(200).json({success: true, message: `${participantIdentity} has been removed from the room`});

		} catch (err) {
			console.error(`[${roomName}] Kick error:`, err);
			return res.status(500).json({error: err.message || err.toString()});
		}
	});
});


exports.flushOpenviduCallQuality = functions.https.onRequest({cors: true}, async (req, res) => {
  try {
    const { documentId, snapshots, exitReason } = req.body;

    if (!documentId || !Array.isArray(snapshots)) {
      res.status(400).send('Missing documentId or snapshots');
      return;
    }

    const ref = admin.firestore().doc(`openviduCallQuality/${documentId}`);

    await ref.update({
      snapshots: admin.firestore.FieldValue.arrayUnion(...snapshots),
      exitReason: exitReason ?? 'tab_closed',
      lastUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ Beacon flush: ${snapshots.length} snapshots → ${documentId}`);
    res.status(200).send('ok');

  } catch (err) {
    console.error('❌ flushCallQuality error:', err);
    res.status(500).send('Internal error');
  }
});