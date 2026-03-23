const admin = require('firebase-admin');
const commonService = require('./service');
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { onSchedule } = require('firebase-functions/v2/scheduler');
const cors = require("cors")({ origin: true });
const functions = require('firebase-functions');

const process = require("process") // NodeJS Process
const axios = require("axios"); // Promise based HTTP Client
const livekitServer = require("livekit-server-sdk");
const AWS = require('aws-sdk');

const LIVEKIT_API_KEY = defineSecret("LIVEKIT_API_KEY");
const LIVEKIT_API_SECRET = defineSecret("LIVEKIT_API_SECRET");
const LIVEKIT_URL = defineSecret("LIVEKIT_URL");
const AWS_ACCESS_KEY = defineSecret("AWS_ACCESS_KEY");
const AWS_SECRET = defineSecret("AWS_SECRET");
const masterInstanceId = defineSecret("MASTER_INSTANCE_ID");
const mediaASGName = defineSecret("MEDIA_ASG_NAME");
const { AccessToken } = require('livekit-server-sdk');

let ec2 = null;
let autoscaling = null;

/**
 * Get EC2 client (lazy initialization)
 */
function getEC2() {
  if (!ec2) {
    ec2 = new AWS.EC2({
      region: 'us-east-1',
      accessKeyId: AWS_ACCESS_KEY.value(),
      secretAccessKey: AWS_SECRET.value()
    });
  }
  return ec2;
}

/**
 * Get AutoScaling client (lazy initialization)
 */
function getAutoScaling() {
  if (!autoscaling) {
    autoscaling = new AWS.AutoScaling({
      region: 'us-east-1',
      accessKeyId: AWS_ACCESS_KEY.value(),
      secretAccessKey: AWS_SECRET.value()
    });
  }
  return autoscaling;
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

const CONFIG = {
    maxRoomsPerInstance: 1
};

exports.createOpenViduToken = onRequest({secrets: [LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL, AWS_ACCESS_KEY, AWS_SECRET, mediaASGName]}, async (req, res) => {
    cors(req, res, async () => {
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Method Not Allowed. Only POST allowed" });
        }

        const { roomName, participantName, participantId } = req.body;

        if (!roomName || !participantName) {
            return res.status(400).json({
                error: "roomName and participantName are required",
            });
        }

        console.log(`[${roomName}] Token request from: ${participantName} (${participantId})`);

        try {
            // Initialize AWS
            const autoscaling = new AWS.AutoScaling({
                region: 'us-east-1',
                accessKeyId: AWS_ACCESS_KEY.value(),
                secretAccessKey: AWS_SECRET.value()
            });

            // Initialize LiveKit Room Client
            const roomClient = new livekitServer.RoomServiceClient(
                LIVEKIT_URL.value(),
                LIVEKIT_API_KEY.value(),
                LIVEKIT_API_SECRET.value()
            );

            // Check capacity BEFORE creating room
            const canCreateRoom = await checkCapacity(autoscaling, roomClient);

            if (!canCreateRoom.allowed) {
                console.log(`[${roomName}] At capacity - scaling up`);
                await scaleUp(autoscaling);
                
                return res.status(503).json({
                    success: false,
                    code: 'SCALING_IN_PROGRESS',
                    message: 'All instances at capacity. Scaling in progress.',
                    retryAfter: 60,
                    currentRooms: canCreateRoom.activeRooms,
                    maxRooms: canCreateRoom.maxRooms,
                    instances: canCreateRoom.totalInstances
                });
            }

            console.log(`[${roomName}] Capacity OK: ${canCreateRoom.activeRooms}/${canCreateRoom.maxRooms} rooms`);

            // Create room (or use existing)
            try {
                await roomClient.createRoom({
                    name: roomName,
                    emptyTimeout: 300,
                    maxParticipants: 50
                });
                console.log(`[${roomName}] New room created`);
            } catch (createError) {
                // Check if error is "room already exists"
                if (createError.message && 
                    (createError.message.includes('already exists') || 
                     createError.message.includes('RoomExists'))) {
                    console.log(`[${roomName}] Room already exists - joining existing room`);
                } else {
                    // Different error - throw it
                    console.error(`[${roomName}] Room creation error:`, createError);
                    throw createError;
                }
            }

            // Generate token
            const liveKitApiKey = LIVEKIT_API_KEY.value();
            const livekitApiSecret = LIVEKIT_API_SECRET.value();
            const livekitURL = LIVEKIT_URL.value();

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

            console.log(`[${roomName}] Token generated for ${participantName}`);

            return res.status(200).json({ 
                success: true,
                url: livekitURL, 
                token,
                roomName,
                instanceCount: canCreateRoom.totalInstances
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

/**
 * Check capacity
 */
async function checkCapacity(autoscaling, roomClient) {
    try {
        const asgResult = await autoscaling.describeAutoScalingGroups({
            AutoScalingGroupNames: [mediaASGName.value()]
        }).promise();

        const asg = asgResult.AutoScalingGroups[0];
        const instances = asg.Instances.filter(i => i.LifecycleState === 'InService');
        const totalInstances = instances.length;

        if (totalInstances === 0) {
            return {
                allowed: false,
                activeRooms: 0,
                maxRooms: 0,
                totalInstances: 0,
                reason: 'No instances running'
            };
        }

        const rooms = await roomClient.listRooms();
        const activeRoomCount = rooms.length;
        const maxRooms = totalInstances * CONFIG.maxRoomsPerInstance;
        const allowed = activeRoomCount < maxRooms;

        console.log(`Capacity: ${activeRoomCount}/${maxRooms} rooms (${totalInstances} instances)`);

        return {
            allowed,
            activeRooms: activeRoomCount,
            maxRooms,
            totalInstances,
            desiredCapacity: asg.DesiredCapacity,
            maxSize: asg.MaxSize
        };
    } catch (error) {
        console.error('Capacity check error:', error.message);
        throw error;
    }
}

/**
 * Scale up by 1 instance
 */
async function scaleUp(autoscaling) {
    try {
        const result = await autoscaling.describeAutoScalingGroups({
            AutoScalingGroupNames: [mediaASGName.value()]
        }).promise();

        const asg = result.AutoScalingGroups[0];
        const current = asg.DesiredCapacity;
        const max = asg.MaxSize;

        if (current >= max) {
            console.log(`Already at max capacity (${max} instances)`);
            return false;
        }

        const newCapacity = current + 1;
        console.log(`Scaling up: ${current} → ${newCapacity} instances`);

        await autoscaling.setDesiredCapacity({
            AutoScalingGroupName: mediaASGName.value(),
            DesiredCapacity: newCapacity,
            HonorCooldown: false
        }).promise();

        console.log(`✓ Scaled to ${newCapacity} instances`);
        return true;
    } catch (error) {
        console.error('Scale up failed:', error.message);
        return false;
    }
}


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
						bucket: commonService.production ? "openvidu-elastic-recording" : "openvidu-community-recording",
						region: "us-east-1",
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
							roomParticipantData["participantghost"]	= originalId
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




exports.CheckMasternodeStatus =  onSchedule({schedule: "*/5 * * * *", timeZone: "Asia/Kolkata", region: "asia-south1", secrets: [masterInstanceId, mediaASGName, AWS_SECRET, AWS_ACCESS_KEY, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET ]}, async (event) => {
	ec2 = getEC2();

	autoscaling = getAutoScaling();

	// AWS Configuration
	AWS.config.update({
		region: 'us-east-1',
		accessKeyId: AWS_ACCESS_KEY.value(),
		secretAccessKey: AWS_SECRET.value()
	});
	try {
		// 1. Check current master state
		const masterRunning = await isMasterNodeRunning();
		console.log(`Master node is currently: ${masterRunning ? 'RUNNING' : 'STOPPED'}`);

		// 2. Check for upcoming meetings (for auto-start)
		const now = admin.firestore.Timestamp.now();
		const fifteenMinutesFromNow = admin.firestore.Timestamp.fromMillis(
			Date.now() + 15 * 60 * 1000
		);
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
			meetings = meetingsSnapshot.docs.map(doc => ({
				id: doc.id,
				...doc.data()
			}));
			console.log(`Found ${meetings.length} upcoming meeting(s)`);
		}
		
		// Start master node if needed
		if (!masterRunning && meetings.length > 0) {
			console.log('Starting master node...');
			await startMasterNode();
			console.log('Master node started successfully');
			return null;
		}

		if (masterRunning && meetings.length > 0) {
			console.log('Pre-creating LiveKit rooms...');
			
			for (const meeting of meetings) {
				// Only create if not already pre-created
				if (!meeting.livekitRoomPreCreated) {
				try {
					await createRoomForMeeting(meeting);
					console.log(` Room pre-created for meeting ${meeting.id}`);
				} catch (error) {
					console.error(` Failed to create room for meeting ${meeting.id}:`, error);
				}
				} else {
				console.log(`Room already exists for meeting ${meeting.id}`);
				}
			}
		}

		// 3. Check for active rooms (for auto-stop)
		let activeRooms = 0;
		if (masterRunning) {
			activeRooms = await getActiveRoomsCount();
			console.log(`Active rooms: ${activeRooms}`);
		}


		// Stop master node if idle
		if (masterRunning && activeRooms === 0 && meetings.length === 0) {
			console.log('No active rooms and no upcoming meetings');
			await stopMasterNode();
			console.log('Master node stopped successfully');
			return null;
		}

		// Log current state
		if (masterRunning) {
			console.log('Master running - in use');
		} else {
			console.log('Master stopped - no meetings scheduled');
		}

		return null;
		
	} catch (error) {
		console.error('Error checking status:', error);
		throw error;
	}
});

/**
 * Check if master node is running
 */
async function isMasterNodeRunning() {
    try {
      const ec2 = getEC2();
      const result = await ec2.describeInstances({
          InstanceIds: [masterInstanceId.value()]
      }).promise();
      
      const instance = result.Reservations[0]?.Instances[0];
      const state = instance?.State.Name;
      
      console.log(`Master node state: ${state}`);
      
      return state === 'running';
        
    } catch (error) {
      console.error('Error checking master node:', error);
      return false;
    }
}



async function createRoomForMeeting(meeting) {
    const client = getRoomClient();
    const roomName = meeting.id;
    
    try {
        // Create the room in LiveKit
        const room = await client.createRoom({
            name: roomName,
            emptyTimeout: 300, // Auto-close room 5 minutes after last participant leaves
            maxParticipants: 10, 
            metadata: JSON.stringify({
                meetingId: meeting.id,
                startTime: meeting.starttime.toDate().toISOString(),
                createdAt: new Date().toISOString()
            })
        });
        
        console.log(`LiveKit room created: ${roomName}`);

    } catch (error) {
        if (error.message && error.message.includes('already exists')) {
            console.log(`LiveKit room ${roomName} already exists - continuing with Firestore setup`);
        } else {
            throw error;
        }
    }

    try {
        // Update appointment document
        await admin.firestore()
            .collection('appointments')
            .doc(meeting.id)
            .update({
                livekitRoomName: roomName,
                livekitRoomCreated: true,
                livekitRoomCreatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

        const hostIds = meeting.hosts ? meeting.hosts.map(ref => {
            return ref.path?.split('/').pop() || ref.id;
        }) : [];

        const participantid = meeting.bookedby?.id || meeting.bookedby;

        // Fetch profile data 
        const mapProfile = {};
        const profilesSnapshot = await admin.firestore()
            .collection('profile_data')
            .get();
        
        profilesSnapshot.forEach(doc => {
            mapProfile[doc.id] = doc.data().name || 'Unknown';
        });

        // Fetch appointment type name
        let appointmentTypeName = 'Appointment';
        if (meeting.appointment?.id) {
            const appointmentDoc = await admin.firestore()
                .collection('appointmenttype') 
                .doc(meeting.appointment.id)
                .get();
            
            if (appointmentDoc.exists) {
                appointmentTypeName = appointmentDoc.data().appointmenttype || 'Appointment';
            }
        }

        const participantName = mapProfile[participantid] || 'Guest';
        const hostNames = hostIds.map(hostId => mapProfile[hostId] || 'Unknown').join(', ');
        const title = `${participantName} - ${appointmentTypeName} (${hostNames})`;

        // Create or update openviduroom document
        const roomRef = admin.firestore()
            .collection('openviduroom')
            .doc(meeting.id);

        const roomDoc = await roomRef.get();

        if (!roomDoc.exists) {
            // Create new room document
            const roomData = {
                active: true,
                createddate: admin.firestore.FieldValue.serverTimestamp(),
                hosts: hostIds,
                metadata: {
                    sessiontype: "appointment",
                    sessionid: meeting.id,
                    roomid: meeting.id,
                    appointmentid: meeting.id,
                    participantid: participantid,
                    title: title
                }
            };
            
            await roomRef.set(roomData);
            console.log(`Firestore room document created: ${meeting.id}`);
        } else {
            // Update existing room if not active
            if (!roomDoc.data().active) {
                await roomRef.update({ 
                    active: true,
                    metadata: {
                        ...roomDoc.data().metadata,
                        title: title
                    }
                });
                console.log(`Firestore room document reactivated: ${meeting.id}`);
            } else {
                console.log(`Firestore room document already active: ${meeting.id}`);
            }
        }

        return { success: true, roomName };

    } catch (error) {
        console.error(`Error setting up Firestore for meeting ${meeting.id}:`, error);
        throw error;
    }
}

/**
 * Get active rooms count
 */
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

async function getActiveRoomsCount() {
    try {
        const activeSessionsSnapshot = await admin.firestore()
            .collection('openviduroom') 
            .where('active', '==', true)
            .get();

        const activeCount = activeSessionsSnapshot.size;
        
        console.log(`Active sessions in Firestore: ${activeCount}`);
        
        return activeCount;

    } catch (error) {
        console.error('Error checking Firestore for active sessions:', error);
        return 1; 
    }
}

/**
 * Start master node
 */
async function startMasterNode() {
    try {
      const ec2 = getEC2();
      await ec2.startInstances({
          InstanceIds: [masterInstanceId.value()]
      }).promise();
      
      console.log(`Starting master node: ${masterInstanceId.value()}`);
      
      await ec2.waitFor('instanceRunning', {
          InstanceIds: [masterInstanceId.value()]
      }).promise();
      
      console.log('Master node is running');
      
      await sleep(30000);
      
      await ensureMediaNodesReady();
      
      return true;
        
    } catch (error) {
        console.error('Failed to start master node:', error);
        throw error;
    }
}

/**
 * Stop master node
 */
async function stopMasterNode() {
    try {
      const ec2 = getEC2();
      const autoscaling = getAutoScaling();
      // Stop media nodes first
      console.log('Stopping media nodes...');
      
      await autoscaling.setDesiredCapacity({
          AutoScalingGroupName: mediaASGName.value(),
          DesiredCapacity: 0,
          HonorCooldown: false
      }).promise();
      
      console.log('Media nodes ASG set to 0');
      
      // Then stop master
      await ec2.stopInstances({
          InstanceIds: [masterInstanceId.value()]
      }).promise();
      
      console.log(`Stopping master node: ${masterInstanceId.value()}`);
      
      await ec2.waitFor('instanceStopped', {
          InstanceIds: [masterInstanceId.value()]
      }).promise();
      
      console.log('Master node stopped');
      
      return true;
        
    } catch (error) {
        console.error('Failed to stop master node:', error);
        throw error;
    }
}

/**
 * Ensure media nodes ASG is ready
 */
async function ensureMediaNodesReady() {
    try {
      const autoscaling = getAutoScaling();
      const result = await autoscaling.describeAutoScalingGroups({
          AutoScalingGroupNames: [mediaASGName.value()]
      }).promise();
      
      const asg = result.AutoScalingGroups[0];
      
      if (asg.DesiredCapacity === 0) {
          console.log('Setting media nodes desired capacity to 1');
          
          await autoscaling.setDesiredCapacity({
              AutoScalingGroupName: mediaASGName.value(),
              DesiredCapacity: 1,
              HonorCooldown: false
          }).promise();
          
          console.log('Media nodes ASG activated');
      }
        
    } catch (error) {
        console.error('Error ensuring media nodes ready:', error);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== ADD THIS NEW WEBHOOK FOR AWS EVENTS ==========

exports.awsEventWebhook = onRequest({
  cors: true
}, async (req, res) => {
  try {
     // STEP 1: Parse the outer body (which is a string)
    let body;
    if (typeof req.body === 'string') {
      console.log('Body is a string, parsing...');
      body = JSON.parse(req.body);
    } else {
      console.log('Body is already an object');
      body = req.body;
    }
    
    console.log('Type:', body.Type);
    
    // STEP 2: Handle SNS subscription confirmation
    if (body.Type === 'SubscriptionConfirmation') {
      console.log('SNS Subscription Confirmation');
      
      const https = require('https');
      https.get(body.SubscribeURL, (response) => {
        console.log('Subscription confirmed');
      });
      
      return res.status(200).send('Subscription confirmed');
    }
    
    // STEP 3: Handle notification
    if (body.Type === 'Notification') {
      console.log('Processing Notification...');
      
      // STEP 4: Parse the nested Message (also a string)
      let message;
      if (typeof body.Message === 'string') {
        console.log('Message is a string, parsing...');
        message = JSON.parse(body.Message);
      } else {
        message = body.Message;
      }
      
      console.log('Event parsed successfully');
      console.log('Detail-type:', message['detail-type']);
      console.log('Source:', message.source);
      
      // STEP 5: Route to appropriate handler
      if (message['detail-type'] === 'EC2 Instance State-change Notification') {
        console.log('Handling EC2 State Change...');
        await handleEC2StateChange(message.detail);
      } 
      else if (message.source === 'aws.autoscaling') {
        console.log('Handling Auto Scaling Event...');
        await handleAutoScalingEvent(message.detail);
      }
      else {
        console.log('Unknown event type:', message['detail-type']);
      }
    }
    
    res.status(200).send('OK');
    
  } catch (error) {
    console.error('Error in webhook:', error);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    res.status(500).send('Error');
  }
});

async function handleEC2StateChange(detail) {
  try {
    const instanceId = detail['instance-id'];
    const state = detail.state;
    
    console.log('EC2 Event:');
    console.log('   Instance:', instanceId);
    console.log('   State:', state);
    
    const ourMasterId = masterInstanceId.value();
    console.log('   Our master:', ourMasterId);
    
    if (instanceId !== ourMasterId) {
      console.log('Not our master node, skipping');
      return;
    }
    
    console.log('This is our master node!');
    
    const mappedState = mapMasterState(state);
    console.log('   Mapped to:', mappedState);
     const updateData = {
      master: {  // ← Nested object, not "master.state"
        state: mappedState,
        status: state,
        lastExternalChange: admin.firestore.FieldValue.serverTimestamp(),
        changedExternally: true,
        instanceId: instanceId
      },
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };
    
    // Update Firestore
    console.log('Updating Firestore...');
    
    await admin.firestore()
      .doc('AWS_System/instance_status')
      .set(updateData, { merge: true });
    
    console.log('Firestore updated!');
    
    // If running, fetch and update IP addresses
    if (state === 'running') {
      console.log('Fetching instance details...');
      
      const ec2 = getEC2();
      
      const result = await ec2.describeInstances({
        InstanceIds: [instanceId]
      }).promise();
      
      const instance = result.Reservations[0].Instances[0];
      
      await admin.firestore()
        .doc('AWS_System/instance_status')
        .set({
          master: {
            publicIp: instance.PublicIpAddress || null,
            privateIp: instance.PrivateIpAddress || null,
            launchTime: instance.LaunchTime ? instance.LaunchTime.toISOString() : null,
            instanceType: instance.InstanceType || null
          },
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      
      console.log('IP addresses updated');
    }
    
  } catch (error) {
    console.error('Error in handleEC2StateChange:', error);
    throw error;
  }
}

async function handleAutoScalingEvent(detail) {
  try {
    const asgName = detail.AutoScalingGroupName;
    
    console.log('Auto Scaling Event:');
    console.log('   ASG:', asgName);
    
    const ourMediaASG = mediaASGName.value();
    console.log('   Our ASG:', ourMediaASG);
    
    if (asgName !== ourMediaASG) {
      console.log('Not our media ASG, skipping');
      return;
    }
    
    console.log('This is our media ASG!');
    
    const autoscaling = getAutoScaling();
    
    console.log('Fetching ASG details...');
    
    const asgData = await autoscaling.describeAutoScalingGroups({
      AutoScalingGroupNames: [asgName]
    }).promise();
    
    const asg = asgData.AutoScalingGroups[0];
    
    const instanceStates = {
      healthy: 0,
      unhealthy: 0,
      pending: 0,
      terminating: 0,
      total: asg.Instances.length
    };
    
    const instances = asg.Instances.map(instance => {
      const isHealthy = instance.HealthStatus === 'Healthy' && instance.LifecycleState === 'InService';
      
      // Count states
      if (isHealthy) {
        instanceStates.healthy++;
      } else if (instance.LifecycleState === 'Pending') {
        instanceStates.pending++;
      } else if (instance.LifecycleState === 'Terminating') {
        instanceStates.terminating++;
      } else {
        instanceStates.unhealthy++;
      }
      
      // Return instance details
      return {
        instanceId: instance.InstanceId,
        healthStatus: instance.HealthStatus,
        lifecycleState: instance.LifecycleState,
        availabilityZone: instance.AvailabilityZone,
        isHealthy: isHealthy
      };
    });
    
    let scalingStatus = 'stable';
    if (asg.DesiredCapacity > instanceStates.healthy) {
      scalingStatus = 'scaling-up';
    } else if (instanceStates.terminating > 0) {
      scalingStatus = 'scaling-down';
    }
    
    console.log('   Desired:', asg.DesiredCapacity);
    console.log('   Healthy:', instanceStates.healthy);
    console.log('   Status:', scalingStatus);


    
    console.log('Updating Firestore...');
    
    await admin.firestore()
      .doc('AWS_System/instance_status')
      .set({
        media: {  
          asgName: asg.AutoScalingGroupName,
          desiredCapacity: asg.DesiredCapacity,
          minSize: asg.MinSize,
          maxSize: asg.MaxSize,
          instanceStates: instanceStates,
          instances: instances,
          scalingStatus: scalingStatus,
          lastExternalChange: admin.firestore.FieldValue.serverTimestamp(),
          changedExternally: true
        },
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    
    console.log('Firestore updated!');
    
  } catch (error) {
    console.error('Error in handleAutoScalingEvent:', error);
    throw error;
  }
}

function mapMasterState(awsState) {
  const stateMap = {
    'running': 'running',
    'stopped': 'stopped',
    'stopping': 'stopping',
    'pending': 'starting',
    'shutting-down': 'stopping',
    'terminated': 'terminated'
  };
  return stateMap[awsState] || 'unknown';
}


/**
 * HTTP endpoint to start master node
 * Webhooks will update Firestore automatically
 */
exports.startMasterNodeHTTP = onRequest({
  secrets: [masterInstanceId, mediaASGName, AWS_ACCESS_KEY, AWS_SECRET],
  cors: true
}, async (req, res) => {
  try {
    console.log('Start master node request');
    const ec2 = getEC2();
    const autoscaling = getAutoScaling();

    // Check if already running
    const isRunning = await isMasterNodeRunning();
    if (isRunning) {
      return res.status(400).json({
        error: 'Master node is already running'
      });
    }

    // Start EC2 instance
    await ec2.startInstances({
      InstanceIds: [masterInstanceId.value()]
    }).promise();

    console.log('Master node start initiated');

    // Prepare media nodes
    ensureMediaNodesReady().catch(err => console.error(err));

    // AWS webhook will update Firestore when state changes
    res.status(200).json({
      message: 'Master node starting... (status will update automatically)'
    });

  } catch (error) {
    console.error('Error starting master:', error);
    res.status(500).json({
      error: error.message || 'Failed to start master node'
    });
  }
});

/**
 * HTTP endpoint to stop master node
 * Webhooks will update Firestore automatically
 */
exports.stopMasterNodeHTTP = onRequest({
  secrets: [masterInstanceId, mediaASGName, AWS_ACCESS_KEY, AWS_SECRET],
  cors: true
}, async (req, res) => {
  try {
    console.log('Stop master node request');
    const ec2 = getEC2();
    const autoscaling = getAutoScaling();

    // Check if already stopped
    const isRunning = await isMasterNodeRunning();
    if (!isRunning) {
      return res.status(400).json({
        error: 'Master node is already stopped'
      });
    }

    // Check for active rooms
    const activeRooms = await getActiveRoomsCount();
    if (activeRooms > 0) {
      return res.status(400).json({
        error: `Cannot stop: ${activeRooms} active room(s)`,
        activeRooms: activeRooms
      });
    }

    // Stop media nodes first
    await autoscaling.setDesiredCapacity({
      AutoScalingGroupName: mediaASGName.value(),
      DesiredCapacity: 0,
      HonorCooldown: false
    }).promise();

    // Stop EC2 instance
    await ec2.stopInstances({
      InstanceIds: [masterInstanceId.value()]
    }).promise();

    console.log('Master node stop initiated');

    // AWS webhook will update Firestore when state changes
    res.status(200).json({
      message: 'Master node stopping... (status will update automatically)'
    });

  } catch (error) {
    console.error('Error stopping master:', error);
    res.status(500).json({
      error: error.message || 'Failed to stop master node'
    });
  }
});

/**
 * HTTP endpoint to scale media nodes
 * Webhooks will update Firestore automatically
 */
exports.scaleMediaNodes = onRequest({
  secrets: [mediaASGName, AWS_ACCESS_KEY, AWS_SECRET],
  cors: true
}, async (req, res) => {
  try {
    const { action } = req.body;

    if (!action || !['scale-up', 'scale-down'].includes(action)) {
      return res.status(400).json({
        error: 'Invalid action. Use "scale-up" or "scale-down"'
      });
    }

    console.log(`Scale media nodes: ${action}`);
    const autoscaling = getAutoScaling();

    // Get current ASG state
    const asgResult = await autoscaling.describeAutoScalingGroups({
      AutoScalingGroupNames: [mediaASGName.value()]
    }).promise();

    const asg = asgResult.AutoScalingGroups[0];
    const currentCapacity = asg.DesiredCapacity;
    const minSize = asg.MinSize;
    const maxSize = asg.MaxSize;

    let newCapacity;

    if (action === 'scale-up') {
      if (currentCapacity >= maxSize) {
        return res.status(400).json({
          error: `Already at maximum capacity (${maxSize})`,
          currentCapacity,
          maxSize
        });
      }
      newCapacity = currentCapacity + 1;
    } else {
      if (currentCapacity <= minSize) {
        return res.status(400).json({
          error: `Already at minimum capacity (${minSize})`,
          currentCapacity,
          minSize
        });
      }
      newCapacity = currentCapacity - 1;
    }

    console.log(`Scaling: ${currentCapacity} → ${newCapacity}`);

    // Set new desired capacity in AWS
    await autoscaling.setDesiredCapacity({
      AutoScalingGroupName: mediaASGName.value(),
      DesiredCapacity: newCapacity,
      HonorCooldown: false
    }).promise();

    console.log(`ASG scaled to ${newCapacity}`);

    // AWS webhook will update Firestore when scaling completes
    res.status(200).json({
      message: `Media nodes ${action === 'scale-up' ? 'scaling up' : 'scaling down'}...`,
      previousCapacity: currentCapacity,
      newCapacity: newCapacity
    });

  } catch (error) {
    console.error('Error scaling media:', error);
    res.status(500).json({
      error: error.message || 'Failed to scale media nodes'
    });
  }
});









