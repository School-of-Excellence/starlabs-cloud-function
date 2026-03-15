// const admin = require('firebase-admin');
// const commonService = require('./service');
// const { onRequest } = require("firebase-functions/v2/https");
// const { defineSecret } = require("firebase-functions/params");
// const { onSchedule } = require('firebase-functions/v2/scheduler');
// const cors = require("cors")({ origin: true });
// const functions = require('firebase-functions');

// const process = require("process") // NodeJS Process
// const axios = require("axios"); // Promise based HTTP Client
// const livekitServer = require("livekit-server-sdk");
// const AWS = require('aws-sdk');

// const LIVEKIT_API_KEY = defineSecret("LIVEKIT_API_KEY");
// const LIVEKIT_API_SECRET = defineSecret("LIVEKIT_API_SECRET");
// const LIVEKIT_URL = defineSecret("LIVEKIT_URL");
// const AWS_ACCESS_KEY = defineSecret("AWS_ACCESS_KEY");
// const AWS_SECRET = defineSecret("AWS_SECRET");
// const masterInstanceId = defineSecret("MASTER_INSTANCE_ID");
// const mediaASGName = defineSecret("MEDIA_ASG_NAME");

// let ec2;
// let autoscaling;

// // LiveKit client
// let roomClient;
// function getRoomClient() {
//     if (!roomClient) {
//         roomClient = new livekitServer.RoomServiceClient(
//             LIVEKIT_URL.value(),
//             LIVEKIT_API_KEY.value(),
//             LIVEKIT_API_SECRET.value()
//         );
//     }
//     return roomClient;
// }

// exports.createOpenViduToken = onRequest({secrets: [LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL]}, async (req, res) => {
//   cors(req, res, async () => {
// 		if (req.method !== "POST") {
// 			return res.status(405).json({error: "Method Not Allowed. Only POST allowed"});
// 		}

// 		const { roomName, participantName, participantId } = req.body;

// 		if (!roomName || !participantName) {
// 			return res.status(400).json({
// 				error: "roomName and participantName are required",
// 			});
// 		}

// 		try {
// 			const liveKitApiKey = LIVEKIT_API_KEY.value();
// 			const livekitApiSecret = LIVEKIT_API_SECRET.value();
// 			const livekitURL = LIVEKIT_URL.value();

// 			const at = new livekitServer.AccessToken(liveKitApiKey, livekitApiSecret, {
// 				identity: participantId,
// 				name: participantName,
// 			});

// 			at.addGrant({
// 				roomJoin: true,
// 				room: roomName,
// 				canSubscribe: true,
// 			});

// 			const token = await at.toJwt();

// 			return res.status(200).json({ url: livekitURL, token });
// 		} catch (err) {
// 			console.error("Token Creation error:", err);
//       return res.status(500).json({ error: err.message || err.toString() });
// 		}
// 	});
// });

// exports.openViduStartRecording = onRequest({ secrets: [LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL, AWS_ACCESS_KEY, AWS_SECRET] }, async (req, res) => {
// 	cors(req, res, async () => {
// 		if (req.method !== "POST") {
// 			return res.status(405).json({error: "Method Not Allowed. Only POST allowed"});
// 		}

// 		const { roomId } = req.body;
// 		if (!roomId) {
// 			return res.status(400).json({
// 				error: "roomId is required",
// 			});
// 		}

// 		try {
// 			const liveKitApiKey = LIVEKIT_API_KEY.value();
// 			const livekitApiSecret = LIVEKIT_API_SECRET.value();
// 			const livekitURL = LIVEKIT_URL.value();
// 			const awsAccessKey = AWS_ACCESS_KEY.value();
// 			const awsSecret = AWS_SECRET.value();

// 			const egressClient = new livekitServer.EgressClient(livekitURL, liveKitApiKey, livekitApiSecret);
// 			// Set up recording output
// 			const fileOutput = new livekitServer.EncodedFileOutput({
// 				fileType: livekitServer.EncodedFileType.MP4,
// 				filepath: `recordings/${roomId}-${Date.now()}`,
// 				disableManifest: true,
// 				output: {
// 					case: "s3",
// 					value: {
// 						bucket: commonService.production ? "openvidu-elastic-recording" : "openvidu-community-recording",
// 						region: "us-east-1",
// 						accessKey: awsAccessKey,
// 						secret: awsSecret
// 					}
// 				},
// 			});

// 			// List all Live Recording
// 			const egressList = await egressClient.listEgress({
// 				roomName: roomId
// 			})
// 			const liveEgress = egressList.find(e => e.roomName == roomId && (e.status === "EGRESS_ACTIVE" || e.status === "EGRESS_STARTING"))

// 			var egressInfo
// 			if(!liveEgress){
// 				egressInfo = await egressClient.startRoomCompositeEgress(roomId, { file: fileOutput }); // Start Recording
// 			}
// 			else{
// 				egressInfo = liveEgress // Get live recording data
// 			}

// 			// Update Recording Detail in Room
// 			var payload = JSON.parse(JSON.stringify(egressInfo))
// 			await admin.firestore().collection("openviduroom").doc(roomId).update({
// 				egressInfo: payload,
// 				recordingstatus: "started"
// 			}).catch(err =>{
// 				console.log("Error saving recording detail", err)
// 			})

// 			return res.status(200).json({ egressInfo });

// 		} catch (error) {
// 			console.error("unable to start recording:", error);
//       return res.status(500).json({ error: error.message || error.toString() });
// 		}

// 	});
// });

// exports.openViduStopRecording = onRequest({ secrets: [LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL] }, async (req, res) => {
// 	cors(req, res, async () => {
// 		if (req.method !== "POST") {
// 			return res.status(405).json({error: "Method Not Allowed. Only POST allowed"});
// 		}

// 		const { egressId, roomId } = req.body;
// 		if (!egressId || !roomId) {
// 			return res.status(400).json({
// 				error: "egressId & roomId is required",
// 			});
// 		}

// 		try{
// 			const liveKitApiKey = LIVEKIT_API_KEY.value();
// 			const livekitApiSecret = LIVEKIT_API_SECRET.value();
// 			const livekitURL = LIVEKIT_URL.value();

// 			const egressClient = new livekitServer.EgressClient(livekitURL, liveKitApiKey, livekitApiSecret);

// 			// List all Live Recording
// 			const egressList = await egressClient.listEgress({
// 				egressId: egressId
// 			})
// 			const liveEgress = egressList.filter(e => e.egressId == egressId && (e.status === "EGRESS_ACTIVE" || e.status === "EGRESS_STARTING"))

// 			var egressInfo
// 			if(liveEgress.length != 0){
// 				try {
// 					egressInfo = await egressClient.stopEgress(egressId); // Stop Recording

// 					// Update Recording Detail in Room
// 					var payload = JSON.parse(JSON.stringify(egressInfo))
// 					await admin.firestore().collection("openviduroom").doc(roomId).update({
// 						egressInfo: payload,
// 						recordingstatus: "ended"
// 					}).catch(err =>{
// 						console.log("Error saving recording detail", err)
// 					})
// 					return res.status(200).json({ egressInfo });
// 				} catch (err) {
// 					if (err.code === "failed_precondition") {
// 						// Already completed — OK
// 						await admin.firestore().collection("openviduroom").doc(roomId).update({ recordingstatus: "ended" });
// 						return res.status(200).json({ result: "Already ended" });
// 					}
// 					throw err;
// 				}

// 			}
// 			else{
// 				await admin.firestore().collection("openviduroom").doc(roomId).update({
// 					recordingstatus: "ended"
// 				}).catch(err =>{
// 					console.log("Error saving recording detail", err)
// 				})
// 				return res.status(200).json({ result: "There is no active recording found" });
// 			}
// 		}
// 		 catch (error) {
// 			console.error("unable to stop recording:", error);
//       return res.status(500).json({ error: error.message || error.toString() });
// 		}

// 	})
// });

// exports.onEventOpenVidu = onRequest({ secrets: [LIVEKIT_API_KEY, LIVEKIT_API_SECRET] }, async (req, res) => {
// 	cors(req, res, async () => {
//     if (req.method !== "POST") {
//       return res.status(405).json({error: "Method Not Allowed. Only POST allowed"});
//     }

// 		try{
// 			const liveKitApiKey = LIVEKIT_API_KEY.value();
// 			const livekitApiSecret = LIVEKIT_API_SECRET.value();

// 			const webhookReceiver = new livekitServer.WebhookReceiver(liveKitApiKey, livekitApiSecret);

// 			const event = await webhookReceiver.receive(
// 				req.body,
// 				req.get("Authorization")
// 			);
// 			console.log(`WebhookReceiver: ${JSON.stringify(event)}`);

// 			// Save Webhook triggers
// 			var payload = JSON.parse(JSON.stringify(event))
// 			await admin.firestore().collection("openvidu event").add({
// 				payload: payload,
// 				time: admin.firestore.FieldValue.serverTimestamp()
// 			}).catch(err =>{
// 				console.log(err)
// 			})

// 			// New Room Started
// 			if(event.event == "room_started"){
// 				// Update Room Status
// 				await admin.firestore().collection("openviduroom").doc(event.room.name).update({
// 					roomstatus: "live",
// 				})
// 			}
// 			// New Participant is Joined
// 			else if(event.event === "participant_joined"){
// 				var startRecording = false
// 				// Update Live Participants & Joined Participants
// 				await admin.firestore().runTransaction(async (tx) => {
// 					const participantId = event.participant.identity
// 					const ref = admin.firestore().collection("openviduroom").doc(event.room.name);
// 					const snap = await tx.get(ref);
// 					var active = new Set(snap.data()["participantlive"] || []);
// 					const activeBeforeCount = active.size;

// 					active.add(participantId);

// 					// Check if Room is reopened
// 					if (activeBeforeCount === 0 && active.size === 1) {
// 						startRecording = true
// 						tx.update(ref, {
// 							recordingstatus: "starting",
// 						})
// 					}

// 					var roomParticipantData = {
// 						participantlive: Array.from(active),
// 						roomstatus: "live"
// 					}
// 					if(payload.participant.kind === "STANDARD"){
// 						const ghostID = " - Ghost"
// 						if(participantId.trim().endsWith(ghostID)){
// 							// Extract Original Participant ID
// 							const originalId = participantId.slice(0, - ghostID.length).trim() // Remove "- Ghost"
// 							roomParticipantData["participantghost"]	= originalId
// 						}
// 						else{
// 							roomParticipantData["participantjoined"] = admin.firestore.FieldValue.arrayUnion(participantId)
// 						}
// 					}

// 					tx.update(ref, roomParticipantData);
// 				});

// 				if(startRecording){
// 					// Start Recording
// 					try {
// 						const result = await axios.post(`https://us-central1-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/openViduStartRecording`, {roomId: event.room.name})
// 						console.log('Room Started and Recording Started:', result.data);
// 					} catch (recordingFailed) {
// 						console.log('Room Restarted and Recording Failed:');
// 						console.log(recordingFailed)
// 						admin.firestore().collection("openviduroom").doc(event.room.name).update({
// 							recordingstatus: "idle"
// 						})
// 					}
// 				}
// 			}
// 			// A Participant is left
// 			else if(event.event === "participant_left"){
// 				// Update Live Participants
// 				let stopRecording = false;
// 				let egressId;

// 				await admin.firestore().runTransaction(async (tx) => {
// 					const ref = admin.firestore().collection("openviduroom").doc(event.room.name);
// 					const snap = await tx.get(ref);

// 					const data = snap.data() || {};
// 					const live = new Set(data["participantlive"] || []);
// 					const recordingstatus = data["recordingstatus"] || "";

// 					live.delete(event.participant.identity);

// 					if (live.size === 0 && recordingstatus === "started") {
// 						stopRecording = true;
// 						egressId = (data["egressInfo"] || {})["egressId"];
// 						tx.update(ref, {
// 							recordingstatus: "ending"
// 						});
// 					}

// 					tx.update(ref, {
// 						participantlive: Array.from(live),
// 						roomstatus: live.size === 0 ? "finished" : "live",
// 					});
// 				});

// 				if (stopRecording && egressId) {
// 					try {
// 						const result = await axios.post(`https://us-central1-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/openViduStopRecording`, {egressId: egressId, roomId: event.room.name})
// 						console.log('Room Finised and Recording Completed:', result.data);
// 					} catch (recordingError) {
// 						console.log('All Participant Left and Recording Failed:')
// 						console.log(recordingError)
// 						admin.firestore().collection("openviduroom").doc(event.room.name).update({
// 							recordingstatus: "started"
// 						})
// 					}
// 				}
// 			}
// 			// Room Finished or All Participant Left
// 			else if(event.event == "room_finished"){
// 				await admin.firestore().collection("openviduroom").doc(event.room.name).update({
// 					roomstatus: "finished",
// 					participantlive: [],
// 				})
// 			}
// 			// Egress Started - Recording is running
// 			else if(event.event == "egress_started"){
// 				// Recording Live
// 				await admin.firestore().collection("openviduroom").doc(event.egressInfo.roomName).update({
// 					recordingstatus: "started"
// 				})
// 			}
// 			// Egress Ended - Recording is ended
// 			else if(event.event == "egress_ended"){
// 				// Recording Ended
// 				await admin.firestore().collection("openviduroom").doc(event.egressInfo.roomName).update({
// 					recordingstatus: "ended"
// 				})
// 			}

// 			return res.status(200).json({ status: "Success" });
// 		}
// 		 catch (error) {
// 			console.error("Webhook Error:", error);
//       return res.status(500).json({ error: error.message || error.toString() });
// 		}
// 	})
// })

// exports.openViduCloseRoom = onRequest({secrets: [LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL]}, async (req, res) => {
// 	cors(req, res, async () => {
//     if (req.method !== "POST") {
//       return res.status(405).json({error: "Method Not Allowed. Only POST allowed"});
//     }

//     const roomName = req.body.roomName;
//     if (!roomName) {
//       return res.status(400).json({error: "roomName is required" });
//     }

//     try {
//       const roomService = new livekitServer.RoomServiceClient(
//         LIVEKIT_URL.value(),
//         LIVEKIT_API_KEY.value(),
//         LIVEKIT_API_SECRET.value()
//       );

//       await roomService.deleteRoom(roomName);

// 			await admin.firestore().collection("openviduroom").doc(roomName).update({
// 				active: false,
// 				roomstatus: "finished"
// 			})

//       return res.json({ message: "Room closed for all participants" });

//     } catch (err) {
//       console.error("Delete room error:", err);
//       return res.status(500).json({ error: err.message || err.toString() });
//     }
// 	});
// });




// exports.CheckMasternodeStatus =  onSchedule({schedule: "*/5 * * * *", timeZone: "Asia/Kolkata", region: "asia-south1", secrets: [masterInstanceId, mediaASGName, AWS_SECRET, AWS_ACCESS_KEY, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET ]}, async (event) => {
// 	ec2 = new AWS.EC2({
// 		region: 'us-east-1',
// 		accessKeyId: AWS_ACCESS_KEY.value(),
// 		secretAccessKey: AWS_SECRET.value()
// 	});

// 	autoscaling = new AWS.AutoScaling({
// 		region: 'us-east-1',
// 		accessKeyId: AWS_ACCESS_KEY.value(),
// 		secretAccessKey: AWS_SECRET.value()
// 	});

// 	// AWS Configuration
// 	AWS.config.update({
// 		region: 'us-east-1',
// 		accessKeyId: AWS_ACCESS_KEY.value(),
// 		secretAccessKey: AWS_SECRET.value()
// 	});
// 	try {
// 		// 1. Check current master state
// 		const masterRunning = await isMasterNodeRunning();
// 		console.log(`Master node is currently: ${masterRunning ? 'RUNNING' : 'STOPPED'}`);

// 		// 2. Check for upcoming meetings (for auto-start)
// 		const now = admin.firestore.Timestamp.now();
// 		const tenMinutesFromNow = admin.firestore.Timestamp.fromMillis(
// 			Date.now() + 10 * 60 * 1000
// 		);
// 		const meetingsSnapshot = await admin.firestore()
// 			.collection('appointments')
// 			.where('platform', '==', 'openvidu')
// 			.where('starttime', '>', now)
// 			.where('starttime', '<=', tenMinutesFromNow)
// 			.where('cancelled', '==', false)
// 			.where('attended', '==', false)
// 			.get();

// 		let meetings = [];
// 		if (!meetingsSnapshot.empty) {
// 			meetings = meetingsSnapshot.docs.map(doc => ({
// 				id: doc.id,
// 				...doc.data()
// 			}));
// 			console.log(`Found ${meetings.length} upcoming meeting(s)`);
// 		}
		
// 		// Start master node if needed
// 		if (!masterRunning && meetings.length > 0) {
// 			console.log('Starting master node...');
// 			await startMasterNode();
// 			console.log('Master node started successfully');
// 			return null;
// 		}

// 		// 3. Check for active rooms (for auto-stop)
// 		let activeRooms = 0;
// 		if (masterRunning) {
// 			activeRooms = await getActiveRoomsCount();
// 			console.log(`Active rooms: ${activeRooms}`);
// 		}


// 		// Stop master node if idle
// 		if (masterRunning && activeRooms === 0) {
// 			console.log('No active rooms and no upcoming meetings');
// 			await stopMasterNode();
// 			console.log('Master node stopped successfully');
// 			return null;
// 		}

// 		// Log current state
// 		if (masterRunning) {
// 			console.log('Master running - in use');
// 		} else {
// 			console.log('Master stopped - no meetings scheduled');
// 		}

// 		return null;
		
// 	} catch (error) {
// 		console.error('Error checking status:', error);
// 		throw error;
// 	}
// });

// /**
//  * Check if master node is running
//  */
// async function isMasterNodeRunning() {
//     try {
//         const result = await ec2.describeInstances({
//             InstanceIds: [masterInstanceId.value()]
//         }).promise();
        
//         const instance = result.Reservations[0]?.Instances[0];
//         const state = instance?.State.Name;
        
//         console.log(`Master node state: ${state}`);
        
//         return state === 'running';
        
//     } catch (error) {
//         console.error('Error checking master node:', error);
//         return false;
//     }
// }

// /**
//  * Get active rooms count
//  */
// async function getActiveRoomsCount() {
//     try {
//         const client = getRoomClient();
//         const rooms = await client.listRooms();
//         return rooms.filter(r => r.numParticipants > 0).length;
//     } catch (error) {
// 		if (error.status === 503) {
//           return 0;  // LiveKit down = no rooms = safe to stop
//         }
//         return 1; 
        
//     }
// }

// /**
//  * Start master node
//  */
// async function startMasterNode() {
//     try {
//         await ec2.startInstances({
//             InstanceIds: [masterInstanceId.value()]
//         }).promise();
        
//         console.log(`Starting master node: ${masterInstanceId.value()}`);
        
//         await ec2.waitFor('instanceRunning', {
//             InstanceIds: [masterInstanceId.value()]
//         }).promise();
        
//         console.log('Master node is running');
        
//         await sleep(30000);
        
//         await ensureMediaNodesReady();
        
//         return true;
        
//     } catch (error) {
//         console.error('Failed to start master node:', error);
//         throw error;
//     }
// }

// /**
//  * Stop master node
//  */
// async function stopMasterNode() {
//     try {
//         // Stop media nodes first
//         console.log('Stopping media nodes...');
        
//         await autoscaling.setDesiredCapacity({
//             AutoScalingGroupName: mediaASGName.value(),
//             DesiredCapacity: 0,
//             HonorCooldown: false
//         }).promise();
        
//         console.log('Media nodes ASG set to 0');
        
//         // Then stop master
//         await ec2.stopInstances({
//             InstanceIds: [masterInstanceId.value()]
//         }).promise();
        
//         console.log(`Stopping master node: ${masterInstanceId.value()}`);
        
//         await ec2.waitFor('instanceStopped', {
//             InstanceIds: [masterInstanceId.value()]
//         }).promise();
        
//         console.log('Master node stopped');
        
//         return true;
        
//     } catch (error) {
//         console.error('Failed to stop master node:', error);
//         throw error;
//     }
// }

// /**
//  * Ensure media nodes ASG is ready
//  */
// async function ensureMediaNodesReady() {
//     try {
//         const result = await autoscaling.describeAutoScalingGroups({
//             AutoScalingGroupNames: [mediaASGName.value()]
//         }).promise();
        
//         const asg = result.AutoScalingGroups[0];
        
//         if (asg.DesiredCapacity === 0) {
//             console.log('Setting media nodes desired capacity to 1');
            
//             await autoscaling.setDesiredCapacity({
//                 AutoScalingGroupName: mediaASGName.value(),
//                 DesiredCapacity: 1,
//                 HonorCooldown: false
//             }).promise();
            
//             console.log('Media nodes ASG activated');
//         }
        
//     } catch (error) {
//         console.error('Error ensuring media nodes ready:', error);
//     }
// }

// function sleep(ms) {
//     return new Promise(resolve => setTimeout(resolve, ms));
// }
