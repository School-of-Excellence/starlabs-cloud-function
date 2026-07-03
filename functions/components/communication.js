const admin = require('firebase-admin');
const process = require("process");

// const projectId = process.env.GCLOUD_PROJECT;
// const PRODUCTION_PROJECTS = ['fir-sample-aae4a'];
// const production = PRODUCTION_PROJECTS.includes(projectId);
// const production = false;
// if(!admin.apps.length){
  // admin.initializeApp({
  //   storageBucket: production == false ? "gs://starlabs-test.firebasestorage.app/" : "gs://fir-sample-aae4a.appspot.com"
  // });
// }
//v2 functions
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

//components imports
const commonService = require('./service');
const bucket = admin.storage().bucket();

//slack
var IncomingWebhook = require('@slack/client').IncomingWebhook;

//https
const https = require('https'); // HTTP Request/Response
const http = require('http');
const axios = require('axios');

//process imports
const { Buffer } = require('buffer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require("uuid"); // To generate unique file names
const XLSX = require('xlsx');

// Apple APN
const apn = require("apn");

const APPLE_AUTHKEY_P8 = defineSecret("APPLE_AUTHKEY_P8");
const APPLE_APN_KEYID = defineSecret("APPLE_APN_KEYID");
const APPLE_TEAMID = defineSecret("APPLE_TEAMID");
const MYOPERATOR_TOKEN = defineSecret("MYOPERATOR_TOKEN");

const postmark = require("postmark");
const POSTMARK_STARLABS_V1 = defineSecret("POSTMARK_STARLABS_V1");
const POSTMARK_STARLABS_V2 = defineSecret("POSTMARK_STARLABS_V2");
const POSTMARK_STARLABS_V3 = defineSecret("POSTMARK_STARLABS_V3");
const POSTMARK_STARLABS_V4 = defineSecret("POSTMARK_STARLABS_V4");
const POSTMARK_STARLABS_TEST = defineSecret("POSTMARK_STARLABS_TEST");

// Send Push Notification
const INVALID_TOKEN_ERRORS = [
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
  'messaging/unregistered'
];
exports.notifyMobileApp = onDocumentCreated({
  document: "/notificationrecord/{id}", 
  timeoutSeconds: 540,
  memory: "512MiB",
  secrets: [APPLE_AUTHKEY_P8, APPLE_APN_KEYID, APPLE_TEAMID]
  }, async (snapshot) => {
  const notificationData = snapshot.data.data();

  if (!notificationData) {
    console.error("No notification data found");
    return;
  }

  const title = notificationData["title"] || "A&H Update";
  const message = notificationData["message"] || "You have a new notification!";
  const subtitle = notificationData["subtitle"] || null;
  const notificationType = notificationData["notificationtype"] || "ahupdate";
  const notificationImage = notificationData["notificationimage"] || null;
  const metaData = notificationData["metadata"] || {};
  const profileID = notificationData["profileid"] || [];

  // receivingapp routing. Absent → current (breakthroughs) behaviour for
  // backward compatibility. "eiflixapp" → only EiFlix (EIFLIX_FCM_token, no
  // FCM_token/AHCRM). "all" → both apps.
  const receivingApp = notificationData["receivingapp"] || "breakthroughsapp";
  const sendBreakthroughs = receivingApp === "all" || receivingApp === "breakthroughsapp";
  const sendEiflix = receivingApp === "all" || receivingApp === "eiflixapp";

  if (profileID.length === 0) {
    console.log("No profiles to notify");
    await snapshot.data.ref.update({ success: true, profilesuccess: [], profilefailed: [], failedlist: {} });
    return;
  }

  console.log("Profile ID", profileID);
  console.log(`Starting notification for ${profileID.length} profiles`);

  const fcmTokens = [];
  const voipTokens = [];
  const mapTokenProfile = {};
  const mapVoipTokenProfile = {};
  const allUsersForLogs = [];
  const failedlist = {};
  const profilesWithUserRef = [];
  const profilesWithFCMToken = [];

  try {
    // ============ STEP 1: FETCH PROFILES TO GET USER_REF FOR LOGS ============
    const profilePromises = [];
    for (let a = 0; a < profileID.length; a += 30) {
      const profileBatch = profileID.slice(a, a + 30);
      profilePromises.push(
        admin.firestore().collection("profile_data").where(admin.firestore.FieldPath.documentId(), "in", profileBatch).get().catch(err => {
          console.error("Profile fetch batch failed:", err);
          profileBatch.forEach(pid => {
            failedlist[pid] = `Profile fetch failed: ${err.message}`;
          });
          return { docs: [] };
        })
      );
      profilePromises.push(
        admin.firestore().collection("new_user_data").where(admin.firestore.FieldPath.documentId(), "in", profileBatch).get().catch(err => {
          console.error("new_user_data fetch batch failed:", err);
          return { docs: [] };
        })
      );
    }

    const profileResults = await Promise.all(profilePromises);
    const foundProfileIds = [];

    for (const result of profileResults) {
      for (const profileDoc of result.docs) {
        const profileData = profileDoc.data();
        const profileId = profileDoc.id;
        foundProfileIds.push(profileId);

        let userId = null;
        if (profileData["user_ref"]) {
          userId = profileData["user_ref"].id;
        } else if (profileData["uid"]) {
          userId = profileData["uid"];
        }

        if (userId) {
          if (!profilesWithUserRef.includes(profileId)) {
            profilesWithUserRef.push(profileId);
          }
          if (!allUsersForLogs.includes(userId)) {
            allUsersForLogs.push(userId);
          }
          delete failedlist[profileId];
        } else if (!profilesWithUserRef.includes(profileId)) {
          failedlist[profileId] = "No user_ref/uid found in profile";
        }
      }
    }

    profileID.forEach(pid => {
      if (!foundProfileIds.includes(pid) && !failedlist[pid]) {
        failedlist[pid] = "Profile not found in database";
      }
    });

    console.log("Users Found", allUsersForLogs);
    console.log(`Found ${allUsersForLogs.length} users with user_ref for logs`);

    // ============ STEP 2: CREATE NOTIFICATION LOGS (BEFORE FCM) ============
    if (notificationData["logged"] && allUsersForLogs.length > 0) {
      console.log(`Creating logs for ${allUsersForLogs.length} users`);
      await storeNotificationLogs(allUsersForLogs, {
        title,
        message,
        subtitle,
        notificationImage,
        notificationType,
        landingpage: notificationData["landingpage"],
        sticky: notificationData["sticky"],
        metaData,
        recordid: snapshot.data.id
      });
    }

    // ============ STEP 3: FETCH FCM TOKENS FOR PUSH NOTIFICATIONS ============
    const fcmPromises = [];
    const AHCRMPromises = [];

    // Breakthroughs app tokens (current behaviour) — skipped for "eiflixapp".
    if (sendBreakthroughs) {
      for (let a = 0; a < profileID.length; a += 30) {
        const profileList = profileID.slice(a, a + 30).map(e =>
          admin.firestore().collection("profile_data").doc(e)
        );
        fcmPromises.push(
          admin.firestore().collection("FCM_token").where("profile_ref", "in", profileList).where("active", "==", true).get().catch(err => {
            console.error("FCM token fetch batch failed:", err);
            return { docs: [] };
          })
        );
      }

      // CONDITIONAL: Query AHCRM_FCM_token ONLY for supportticket notifications
      if (notificationType === "supportticket") {
        for (let a = 0; a < profileID.length; a += 30) {
          const profileList = profileID.slice(a, a + 30).map(e =>
            admin.firestore().collection("profile_data").doc(e)
          );
          AHCRMPromises.push(
            admin.firestore().collection("AHCRM_FCM_token").where("profile_ref", "in", profileList).where("active", "==", true).get().catch(err => {
              console.error("FCM token fetch batch failed:", err);
              return { docs: [] };
            })
          );
        }
      }
    }

    // EiFlix app tokens (separate collection) — added for "eiflixapp" / "all".
    // FCM routes each token to its own app, and the Firebase project's APNs key
    // for com.soe.eiflix handles iOS delivery, so the existing send path is reused.
    if (sendEiflix) {
      for (let a = 0; a < profileID.length; a += 30) {
        const profileList = profileID.slice(a, a + 30).map(e =>
          admin.firestore().collection("profile_data").doc(e)
        );
        fcmPromises.push(
          admin.firestore().collection("EIFLIX_FCM_token").where("profile_ref", "in", profileList).where("active", "==", true).get().catch(err => {
            console.error("EIFLIX FCM token fetch batch failed:", err);
            return { docs: [] };
          })
        );
      }
    }

    fcmPromises.push(...AHCRMPromises);
    console.log("ahcrm promises", AHCRMPromises.length);
    const fcmResults = await Promise.all(fcmPromises);

    for (const result of fcmResults) {
      for (const tokenDoc of result.docs) {
        const tokenData = tokenDoc.data();
        tokenData["path"] = tokenDoc.ref.path;
        const fcmToken = tokenData["FCM_id"];
        const profileId = tokenData["profile_ref"]?.id;
        const voipToken = tokenData["voipToken"]; 
        const platform = tokenData["device_os"]; 

        // console.log(`Token doc - platform: "${platform}", hasVoIP: ${voipToken}, profileId: ${profileId}`);

        if (fcmToken && profileId ) {
          fcmTokens.push(fcmToken);
          mapTokenProfile[fcmToken] = tokenData;
          if (!profilesWithFCMToken.includes(profileId)) {
            profilesWithFCMToken.push(profileId);
          }
        }

        //call kit for ios
        if (voipToken && profileId && platform == "ios") {          
          voipTokens.push(voipToken);
          console.log("voipTokens",voipToken);
          mapVoipTokenProfile[voipToken] = tokenData;
        }

      }
    }

    profilesWithUserRef.forEach(pid => {
      if (!profilesWithFCMToken.includes(pid)) {
        if (failedlist[pid]) {
          failedlist[pid] += "; No active FCM token found";
        } else {
          failedlist[pid] = "No active FCM token found";
        }
      }
    });

    if (notificationType === "supportticket") {
      console.log(`Found ${fcmTokens.length} FCM tokens (from FCM_token + AHCRM_FCM_token)`);
    } else {
      console.log(`Found ${fcmTokens.length} FCM tokens for push notifications`);
    }

    // ============ STEP 4: SEND PUSH NOTIFICATIONS ============
    const successfullProfileid = [];
    const failedFCM = [];
    const appFCMSuccess = [];
    const webFCMSuccess = [];
    const appFCMFailed = [];
    const webFCMFailed = [];
    const invalidTokenPaths = []; // Only invalid tokens to deactivate
    const voipResults = { success: [], failed: [], invalidTokens: [] }; 

    if (fcmTokens.length > 0) {
      const splitToken = commonService.chunkArray(fcmTokens, 500);

      for (let i = 0; i < splitToken.length; i++) {
        const tokenSet = splitToken[i];
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
        }
        let payload;
        if(notificationType === "studio invitation"){
          payload = {
            data: {
              type: "studio_invitation_call", 
              click_action: "FLUTTER_NOTIFICATION_CLICK",
              recordid: snapshot.data.id,
              title: title,
              body: message,
              stage: metaData?.stage || title,
              studioid: metaData?.studioid || "",
              docid: metaData?.docid || "",
              ...sanitizeDataPayload(metaData),
            },
            android: {
              priority: 'high',
              ttl: 0,
            },
            apns: {
              headers: {
                'apns-priority': '10',
              },
              payload: {
                aps: {
                  'content-available': 1,
                },
              },
            },
            tokens: tokenSet,
          };

        }
        else{
          payload = {
            notification: {
              title: title,
              body: message,
            },
            data: {
              type: notificationType,
              click_action: "FLUTTER_NOTIFICATION_CLICK",
              recordid: snapshot.data.id,
              landingpage: notificationData["landingpage"] || "",
              sticky: String(notificationData["sticky"] || false),
              ...sanitizeDataPayload(metaData),
              // ...sanitizeDataPayload(notificationData),
            },
            android: {
              notification: {
                channel_id: "default_channel",
                sound: "default",
                color: '#ffffff',
                tag: snapshot.data.id,
              },
            },
            apns: {
              payload: {
                aps: {
                  badge: 1,
                  sound: "default",
                  "mutable-content": 1,
                  'content-available': 1,
                },
              },
              headers: {
                'apns-collapse-id': snapshot.data.id,
              }
            },
            tokens: tokenSet,
          };
        }
       
        // Old payload method
        // const payload = {
        //   notification: {
        //     title: title,
        //     body: message,
        //   },
        //   data: {
        //     type: notificationType,
        //     click_action: "FLUTTER_NOTIFICATION_CLICK",
        //     recordid: snapshot.data.id,
        //     ...sanitizeDataPayload(metaData),
        //     // ...sanitizeDataPayload(notificationData),
        //   },
        //   android: {
        //     notification: {
        //       color: '#ffffff',
        //       tag: snapshot.data.id,
        //       sound: "default",
        //     },
        //   },
        //   apns: {
        //     payload: {
        //       aps: {
        //         badge: 1,
        //         sound: "default",
        //         "mutable-content": 1
        //       },
        //     },
        //     headers: {
        //       'apns-collapse-id': snapshot.data.id,
        //     }
        //   },
        //   tokens: tokenSet,
        // }; 
        if (notificationImage) {
          payload.android.notification["imageUrl"] = notificationImage;
          payload.apns["fcm_options"] = { image: notificationImage };
        }

        try {
          const response = await sendWithRetry(payload);
          response.responses.forEach((res, j) => {
            const tokenid = tokenSet[j];
            const tokenData = mapTokenProfile[tokenid];

            if (!tokenData) return;

            const tokenProfileid = tokenData["profile_ref"]?.id;
            const deviceOS = tokenData["device_os"]?.toLowerCase();
            const isApp = deviceOS === "ios" || deviceOS === "android";
            const isWeb = deviceOS === "linux" || deviceOS === "windows" || deviceOS === "mac";

            if (res.success) {
              if (tokenProfileid && !successfullProfileid.includes(tokenProfileid)) {
                successfullProfileid.push(tokenProfileid);
              }
              if (isApp && !appFCMSuccess.includes(tokenProfileid)) {
                appFCMSuccess.push(tokenProfileid);
              } else if (isWeb && !webFCMSuccess.includes(tokenProfileid)) {
                webFCMSuccess.push(tokenProfileid);
              }

              if (tokenProfileid && failedlist[tokenProfileid]) {
                delete failedlist[tokenProfileid];
              }
            } else {
              failedFCM.push(tokenid);

              const errorCode = res.error?.code || "unknown";
              const errorMessage = res.error?.message || "FCM delivery failed";

              // Only mark token as invalid if error indicates token is invalid
              if (isInvalidTokenError(errorCode)) {
                invalidTokenPaths.push(tokenData["path"]);
                console.log(`Invalid token detected: ${tokenid}, error: ${errorCode}`);
              }

              if (tokenProfileid) {
                const fcmError = `FCM failed: ${errorCode} - ${errorMessage}`;
                if (failedlist[tokenProfileid]) {
                  failedlist[tokenProfileid] += `; ${fcmError}`;
                } else {
                  failedlist[tokenProfileid] = fcmError;
                }
              }

              if (isApp && !appFCMFailed.includes(tokenProfileid)) {
                appFCMFailed.push(tokenProfileid);
              } else if (isWeb && !webFCMFailed.includes(tokenProfileid)) {
                webFCMFailed.push(tokenProfileid);
              }
            }
          });

          console.log(`Batch ${i + 1}/${splitToken.length} completed: ${response.successCount} success, ${response.failureCount} failed`);

        } catch (err) {
          console.error(`Batch ${i + 1} failed after all retries:`, err);
          tokenSet.forEach(tokenid => {
            failedFCM.push(tokenid);
            if (mapTokenProfile[tokenid]) {
              const tokenProfileid = mapTokenProfile[tokenid]["profile_ref"]?.id;
              if (tokenProfileid) {
                const batchError = `FCM batch failed: ${err.message}`;
                if (failedlist[tokenProfileid]) {
                  failedlist[tokenProfileid] += `; ${batchError}`;
                } else {
                  failedlist[tokenProfileid] = batchError;
                }
              }
            }
          });
        }
      }


      // ============ STEP 4B: SEND VOIP NOTIFICATIONS FOR iOS ============
      if (voipTokens.length > 0 && notificationType === "studio invitation") {
        console.log(`Sending VoIP to ${voipTokens.length} iOS devices`);

        const apnToken = {
          key: APPLE_AUTHKEY_P8.value(),
          keyId: APPLE_APN_KEYID.value(),
          teamId: APPLE_TEAMID.value(),
        };
        const voipResult = await sendVoipNotifications({
          apnToken: apnToken,
          voipTokens: voipTokens,
          mapVoipTokenProfile: mapVoipTokenProfile,
          notificationData: {
            title,
            message,
            notificationType,
            recordid: snapshot.data.id,
            metaData,
          }
        });

        voipResults.success = voipResult.success;
        voipResults.failed = voipResult.failed;
        
        // Add invalid VoIP tokens to deactivation list
        voipResult.invalidTokens.forEach(path => {
          if (path && !invalidTokenPaths.includes(path)) {
            invalidTokenPaths.push(path);
          }
        });

        console.log(`VoIP: ${voipResult.success.length} success, ${voipResult.failed.length} failed`);
      }

    

      // ============ STEP 5: CLEANUP ONLY INVALID FCM TOKENS ============
      if (invalidTokenPaths.length > 0) {
        console.log(`Deactivating ${invalidTokenPaths.length} invalid tokens`);
        const invalidChunks = commonService.chunkArray(invalidTokenPaths, 500);
        for (const chunk of invalidChunks) {
          const batch = admin.firestore().batch();
          chunk.forEach(path => {
            batch.update(admin.firestore().doc(path), { active: false });
          });
          await batch.commit().catch(err => {
            console.error("Failed to deactivate invalid FCM tokens:", err);
          });
        }
      }
    } else {
      console.log("No FCM tokens found, skipping push notifications");
    }

    // ============ STEP 6: UPDATE FINAL RESULT ============
    const failedProfile = profileID.filter(e => !successfullProfileid.includes(e));

    await snapshot.data.ref.update({
      profilesuccess: successfullProfileid,
      profilefailed: failedProfile,
      appFCMSuccess: appFCMSuccess,
      webFCMSuccess: webFCMSuccess,
      appFCMFailed: appFCMFailed,
      voipSuccess: voipResults.success,
      voipFailed: voipResults.failed,
      webFCMFailed: webFCMFailed,
      failedlist: failedlist,
      success: true
    });

    console.log(`Completed: ${successfullProfileid.length} FCM success, ${failedProfile.length} FCM failed, ${invalidTokenPaths.length} tokens deactivated`);

  } catch (err) {
    console.error("Critical error in notifyMobileApp:", err);

    profileID.forEach(pid => {
      if (!failedlist[pid]) {
        failedlist[pid] = `Critical error: ${err.message}`;
      }
    });

    await snapshot.data.ref.update({
      success: false,
      error: err.message || "Unknown error",
      failedlist: failedlist
    }).catch(e => console.error("Failed to update error status:", e));
  }
});

// exports.notifyMobileApp = onDocumentCreated({
//   document: "/notificationrecord/{id}", 
//   timeoutSeconds: 540,
//   memory: "512MiB",
//   secrets: [APPLE_AUTHKEY_P8, APPLE_APN_KEYID, APPLE_TEAMID]
//   }, async (snapshot) => {
//   const notificationData = snapshot.data.data();

//   if (!notificationData) {
//     console.error("No notification data found");
//     return;
//   }

//   const title = notificationData["title"] || "A&H Update";
//   const message = notificationData["message"] || "You have a new notification!";
//   const subtitle = notificationData["subtitle"] || null;
//   const notificationType = notificationData["notificationtype"] || "ahupdate";
//   const notificationImage = notificationData["notificationimage"] || null;
//   const metaData = notificationData["metadata"] || {};
//   const profileID = notificationData["profileid"] || [];

//   if (profileID.length === 0) {
//     console.log("No profiles to notify");
//     await snapshot.data.ref.update({ success: true, profilesuccess: [], profilefailed: [], failedlist: {} });
//     return;
//   }

//   console.log("Profile ID", profileID);
//   console.log(`Starting notification for ${profileID.length} profiles`);

//   const fcmTokens = [];
//   const voipTokens = [];
//   const mapTokenProfile = {};
//   const mapVoipTokenProfile = {};
//   const allUsersForLogs = [];
//   const failedlist = {};
//   const profilesWithUserRef = [];
//   const profilesWithFCMToken = [];

//   try {
//     // ============ STEP 1: FETCH PROFILES TO GET USER_REF FOR LOGS ============
//     const profilePromises = [];
//     for (let a = 0; a < profileID.length; a += 30) {
//       const profileBatch = profileID.slice(a, a + 30);
//       profilePromises.push(
//         admin.firestore().collection("profile_data").where(admin.firestore.FieldPath.documentId(), "in", profileBatch).get().catch(err => {
//           console.error("Profile fetch batch failed:", err);
//           profileBatch.forEach(pid => {
//             failedlist[pid] = `Profile fetch failed: ${err.message}`;
//           });
//           return { docs: [] };
//         })
//       );
//       profilePromises.push(
//         admin.firestore().collection("new_user_data").where(admin.firestore.FieldPath.documentId(), "in", profileBatch).get().catch(err => {
//           console.error("new_user_data fetch batch failed:", err);
//           return { docs: [] };
//         })
//       );
//     }

//     const profileResults = await Promise.all(profilePromises);
//     const foundProfileIds = [];

//     for (const result of profileResults) {
//       for (const profileDoc of result.docs) {
//         const profileData = profileDoc.data();
//         const profileId = profileDoc.id;
//         foundProfileIds.push(profileId);

//         let userId = null;
//         if (profileData["user_ref"]) {
//           userId = profileData["user_ref"].id;
//         } else if (profileData["uid"]) {
//           userId = profileData["uid"];
//         }

//         if (userId) {
//           if (!profilesWithUserRef.includes(profileId)) {
//             profilesWithUserRef.push(profileId);
//           }
//           if (!allUsersForLogs.includes(userId)) {
//             allUsersForLogs.push(userId);
//           }
//           delete failedlist[profileId];
//         } else if (!profilesWithUserRef.includes(profileId)) {
//           failedlist[profileId] = "No user_ref/uid found in profile";
//         }
//       }
//     }

//     profileID.forEach(pid => {
//       if (!foundProfileIds.includes(pid) && !failedlist[pid]) {
//         failedlist[pid] = "Profile not found in database";
//       }
//     });

//     console.log("Users Found", allUsersForLogs);
//     console.log(`Found ${allUsersForLogs.length} users with user_ref for logs`);

//     // ============ STEP 2: CREATE NOTIFICATION LOGS (BEFORE FCM) ============
//     if (notificationData["logged"] && allUsersForLogs.length > 0) {
//       console.log(`Creating logs for ${allUsersForLogs.length} users`);
//       await storeNotificationLogs(allUsersForLogs, {
//         title,
//         message,
//         subtitle,
//         notificationImage,
//         notificationType,
//         landingpage: notificationData["landingpage"],
//         sticky: notificationData["sticky"],
//         metaData,
//         recordid: snapshot.data.id
//       });
//     }

//     // ============ STEP 3: FETCH FCM TOKENS FOR PUSH NOTIFICATIONS ============
//     const fcmPromises = [];
//     const AHCRMPromises = [];

//     for (let a = 0; a < profileID.length; a += 30) {
//       const profileList = profileID.slice(a, a + 30).map(e =>
//         admin.firestore().collection("profile_data").doc(e)
//       );
//       fcmPromises.push(
//         admin.firestore().collection("FCM_token").where("profile_ref", "in", profileList).where("active", "==", true).get().catch(err => {
//           console.error("FCM token fetch batch failed:", err);
//           return { docs: [] };
//         })
//       );
//     }

//     // CONDITIONAL: Query AHCRM_FCM_token ONLY for supportticket notifications
//     if (notificationType === "supportticket") {
//       for (let a = 0; a < profileID.length; a += 30) {
//         const profileList = profileID.slice(a, a + 30).map(e =>
//           admin.firestore().collection("profile_data").doc(e)
//         );
//         AHCRMPromises.push(
//           admin.firestore().collection("AHCRM_FCM_token").where("profile_ref", "in", profileList).where("active", "==", true).get().catch(err => {
//             console.error("FCM token fetch batch failed:", err);
//             return { docs: [] };
//           })
//         );
//       }
//     }

//     fcmPromises.push(...AHCRMPromises);
//     console.log("ahcrm promises", AHCRMPromises.length);
//     const fcmResults = await Promise.all(fcmPromises);

//     for (const result of fcmResults) {
//       for (const tokenDoc of result.docs) {
//         const tokenData = tokenDoc.data();
//         tokenData["path"] = tokenDoc.ref.path;
//         const fcmToken = tokenData["FCM_id"];
//         const profileId = tokenData["profile_ref"]?.id;
//         const voipToken = tokenData["voipToken"]; 
//         const platform = tokenData["device_os"]; 

//         // console.log(`Token doc - platform: "${platform}", hasVoIP: ${voipToken}, profileId: ${profileId}`);

//         if (fcmToken && profileId ) {
//           fcmTokens.push(fcmToken);
//           mapTokenProfile[fcmToken] = tokenData;
//           if (!profilesWithFCMToken.includes(profileId)) {
//             profilesWithFCMToken.push(profileId);
//           }
//         }

//         //call kit for ios
//         if (voipToken && profileId && platform == "ios") {          
//           voipTokens.push(voipToken);
//           console.log("voipTokens",voipToken);
//           mapVoipTokenProfile[voipToken] = tokenData;
//         }

//       }
//     }

//     profilesWithUserRef.forEach(pid => {
//       if (!profilesWithFCMToken.includes(pid)) {
//         if (failedlist[pid]) {
//           failedlist[pid] += "; No active FCM token found";
//         } else {
//           failedlist[pid] = "No active FCM token found";
//         }
//       }
//     });

//     if (notificationType === "supportticket") {
//       console.log(`Found ${fcmTokens.length} FCM tokens (from FCM_token + AHCRM_FCM_token)`);
//     } else {
//       console.log(`Found ${fcmTokens.length} FCM tokens for push notifications`);
//     }

//     // ============ STEP 4: SEND PUSH NOTIFICATIONS ============
//     const successfullProfileid = [];
//     const failedFCM = [];
//     const appFCMSuccess = [];
//     const webFCMSuccess = [];
//     const appFCMFailed = [];
//     const webFCMFailed = [];
//     const invalidTokenPaths = []; // Only invalid tokens to deactivate
//     const voipResults = { success: [], failed: [], invalidTokens: [] }; 

//     if (fcmTokens.length > 0) {
//       const splitToken = commonService.chunkArray(fcmTokens, 500);

//       for (let i = 0; i < splitToken.length; i++) {
//         const tokenSet = splitToken[i];
//         if (i > 0) {
//           await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
//         }
//         let payload;
//         if(notificationType === "studio invitation"){
//           payload = {
//             data: {
//               type: "studio_invitation_call", 
//               click_action: "FLUTTER_NOTIFICATION_CLICK",
//               recordid: snapshot.data.id,
//               title: title,
//               body: message,
//               stage: metaData?.stage || title,
//               studioid: metaData?.studioid || "",
//               docid: metaData?.docid || "",
//               ...sanitizeDataPayload(metaData),
//             },
//             android: {
//               priority: 'high',
//               ttl: 0,
//             },
//             apns: {
//               headers: {
//                 'apns-priority': '10',
//               },
//               payload: {
//                 aps: {
//                   'content-available': 1,
//                 },
//               },
//             },
//             tokens: tokenSet,
//           };

//         }
//         else{
//           payload = {
//             notification: {
//               title: title,
//               body: message,
//             },
//             data: {
//               type: notificationType,
//               click_action: "FLUTTER_NOTIFICATION_CLICK",
//               recordid: snapshot.data.id,
//               landingpage: notificationData["landingpage"] || "",
//               sticky: String(notificationData["sticky"] || false),
//               ...sanitizeDataPayload(metaData),
//               // ...sanitizeDataPayload(notificationData),
//             },
//             android: {
//               notification: {
//                 channel_id: "default_channel",
//                 sound: "default",
//                 color: '#ffffff',
//                 tag: snapshot.data.id,
//               },
//             },
//             apns: {
//               payload: {
//                 aps: {
//                   badge: 1,
//                   sound: "default",
//                   "mutable-content": 1,
//                   'content-available': 1,
//                 },
//               },
//               headers: {
//                 'apns-collapse-id': snapshot.data.id,
//               }
//             },
//             tokens: tokenSet,
//           };
//         }
       
//         // Old payload method
//         // const payload = {
//         //   notification: {
//         //     title: title,
//         //     body: message,
//         //   },
//         //   data: {
//         //     type: notificationType,
//         //     click_action: "FLUTTER_NOTIFICATION_CLICK",
//         //     recordid: snapshot.data.id,
//         //     ...sanitizeDataPayload(metaData),
//         //     // ...sanitizeDataPayload(notificationData),
//         //   },
//         //   android: {
//         //     notification: {
//         //       color: '#ffffff',
//         //       tag: snapshot.data.id,
//         //       sound: "default",
//         //     },
//         //   },
//         //   apns: {
//         //     payload: {
//         //       aps: {
//         //         badge: 1,
//         //         sound: "default",
//         //         "mutable-content": 1
//         //       },
//         //     },
//         //     headers: {
//         //       'apns-collapse-id': snapshot.data.id,
//         //     }
//         //   },
//         //   tokens: tokenSet,
//         // }; 
//         if (notificationImage) {
//           payload.android.notification["imageUrl"] = notificationImage;
//           payload.apns["fcm_options"] = { image: notificationImage };
//         }

//         try {
//           const response = await sendWithRetry(payload);
//           response.responses.forEach((res, j) => {
//             const tokenid = tokenSet[j];
//             const tokenData = mapTokenProfile[tokenid];

//             if (!tokenData) return;

//             const tokenProfileid = tokenData["profile_ref"]?.id;
//             const deviceOS = tokenData["device_os"]?.toLowerCase();
//             const isApp = deviceOS === "ios" || deviceOS === "android";
//             const isWeb = deviceOS === "linux" || deviceOS === "windows" || deviceOS === "mac";

//             if (res.success) {
//               if (tokenProfileid && !successfullProfileid.includes(tokenProfileid)) {
//                 successfullProfileid.push(tokenProfileid);
//               }
//               if (isApp && !appFCMSuccess.includes(tokenProfileid)) {
//                 appFCMSuccess.push(tokenProfileid);
//               } else if (isWeb && !webFCMSuccess.includes(tokenProfileid)) {
//                 webFCMSuccess.push(tokenProfileid);
//               }

//               if (tokenProfileid && failedlist[tokenProfileid]) {
//                 delete failedlist[tokenProfileid];
//               }
//             } else {
//               failedFCM.push(tokenid);

//               const errorCode = res.error?.code || "unknown";
//               const errorMessage = res.error?.message || "FCM delivery failed";

//               // Only mark token as invalid if error indicates token is invalid
//               if (isInvalidTokenError(errorCode)) {
//                 invalidTokenPaths.push(tokenData["path"]);
//                 console.log(`Invalid token detected: ${tokenid}, error: ${errorCode}`);
//               }

//               if (tokenProfileid) {
//                 const fcmError = `FCM failed: ${errorCode} - ${errorMessage}`;
//                 if (failedlist[tokenProfileid]) {
//                   failedlist[tokenProfileid] += `; ${fcmError}`;
//                 } else {
//                   failedlist[tokenProfileid] = fcmError;
//                 }
//               }

//               if (isApp && !appFCMFailed.includes(tokenProfileid)) {
//                 appFCMFailed.push(tokenProfileid);
//               } else if (isWeb && !webFCMFailed.includes(tokenProfileid)) {
//                 webFCMFailed.push(tokenProfileid);
//               }
//             }
//           });

//           console.log(`Batch ${i + 1}/${splitToken.length} completed: ${response.successCount} success, ${response.failureCount} failed`);

//         } catch (err) {
//           console.error(`Batch ${i + 1} failed after all retries:`, err);
//           tokenSet.forEach(tokenid => {
//             failedFCM.push(tokenid);
//             if (mapTokenProfile[tokenid]) {
//               const tokenProfileid = mapTokenProfile[tokenid]["profile_ref"]?.id;
//               if (tokenProfileid) {
//                 const batchError = `FCM batch failed: ${err.message}`;
//                 if (failedlist[tokenProfileid]) {
//                   failedlist[tokenProfileid] += `; ${batchError}`;
//                 } else {
//                   failedlist[tokenProfileid] = batchError;
//                 }
//               }
//             }
//           });
//         }
//       }


//       // ============ STEP 4B: SEND VOIP NOTIFICATIONS FOR iOS ============
//       if (voipTokens.length > 0 && notificationType === "studio invitation") {
//         console.log(`Sending VoIP to ${voipTokens.length} iOS devices`);

//         const apnToken = {
//           key: APPLE_AUTHKEY_P8.value(),
//           keyId: APPLE_APN_KEYID.value(),
//           teamId: APPLE_TEAMID.value(),
//         };
//         const voipResult = await sendVoipNotifications({
//           apnToken: apnToken,
//           voipTokens: voipTokens,
//           mapVoipTokenProfile: mapVoipTokenProfile,
//           notificationData: {
//             title,
//             message,
//             notificationType,
//             recordid: snapshot.data.id,
//             metaData,
//           }
//         });

//         voipResults.success = voipResult.success;
//         voipResults.failed = voipResult.failed;
        
//         // Add invalid VoIP tokens to deactivation list
//         voipResult.invalidTokens.forEach(path => {
//           if (path && !invalidTokenPaths.includes(path)) {
//             invalidTokenPaths.push(path);
//           }
//         });

//         console.log(`VoIP: ${voipResult.success.length} success, ${voipResult.failed.length} failed`);
//       }

    

//       // ============ STEP 5: CLEANUP ONLY INVALID FCM TOKENS ============
//       if (invalidTokenPaths.length > 0) {
//         console.log(`Deactivating ${invalidTokenPaths.length} invalid tokens`);
//         const invalidChunks = commonService.chunkArray(invalidTokenPaths, 500);
//         for (const chunk of invalidChunks) {
//           const batch = admin.firestore().batch();
//           chunk.forEach(path => {
//             batch.update(admin.firestore().doc(path), { active: false });
//           });
//           await batch.commit().catch(err => {
//             console.error("Failed to deactivate invalid FCM tokens:", err);
//           });
//         }
//       }
//     } else {
//       console.log("No FCM tokens found, skipping push notifications");
//     }

//     // ============ STEP 6: UPDATE FINAL RESULT ============
//     const failedProfile = profileID.filter(e => !successfullProfileid.includes(e));

//     await snapshot.data.ref.update({
//       profilesuccess: successfullProfileid,
//       profilefailed: failedProfile,
//       appFCMSuccess: appFCMSuccess,
//       webFCMSuccess: webFCMSuccess,
//       appFCMFailed: appFCMFailed,
//       voipSuccess: voipResults.success,
//       voipFailed: voipResults.failed,
//       webFCMFailed: webFCMFailed,
//       failedlist: failedlist,
//       success: true
//     });

//     console.log(`Completed: ${successfullProfileid.length} FCM success, ${failedProfile.length} FCM failed, ${invalidTokenPaths.length} tokens deactivated`);

//   } catch (err) {
//     console.error("Critical error in notifyMobileApp:", err);

//     profileID.forEach(pid => {
//       if (!failedlist[pid]) {
//         failedlist[pid] = `Critical error: ${err.message}`;
//       }
//     });

//     await snapshot.data.ref.update({
//       success: false,
//       error: err.message || "Unknown error",
//       failedlist: failedlist
//     }).catch(e => console.error("Failed to update error status:", e));
//   }
// });

async function sendVoipNotifications({voipTokens, mapVoipTokenProfile, notificationData, apnToken}) {

  const apnProvider = new apn.Provider({
    token: apnToken,
    production: true,
  });

  const results = {
    success: [],
    failed: [],
    invalidTokens: [],
  };

  if (voipTokens.length === 0) return results;
  
  // Check if tokens match
  voipTokens.forEach(token => {
    const exists = mapVoipTokenProfile[token] !== undefined;
    console.log(`Token ${token.substring(0, 10)}... exists in map: ${exists}`);
  });

  const notification = new apn.Notification();
  notification.topic = "com.app.launchyourlegacy.voip";
  notification.pushType = "voip";
  notification.priority = 10;
  notification.expiry = Math.floor(Date.now() / 1000) + 3600;
  
  // Add aps dictionary for better compatibility
  notification.payload = {
    aps: {
      "content-available": 1
    },
    id: notificationData.recordid,
    nameCaller: notificationData.title || "Incoming Call",
    handle: notificationData.metaData?.callerHandle || "",
    docid: notificationData.metaData?.docid || "",
    studioid: notificationData.metaData?.studioid || "",
    isVideo: notificationData.metaData?.isVideo ?? false,
  };
  
  try {
    const response = await apnProvider.send(notification, voipTokens);
    
    console.log("Sent count:", response.sent.length);
    console.log("Failed count:", response.failed.length);

    // Process successful sends
    response.sent.forEach((sentItem) => {
      // In node-apn, response.sent contains the device tokens that succeeded
      const token = typeof sentItem === 'string' ? sentItem : sentItem.device;
      console.log(`Processing sent token: ${token}`);
      console.log(`Token type: ${typeof token}`);
      
      const tokenData = mapVoipTokenProfile[token];
      console.log(`TokenData found: ${tokenData !== undefined}`);
      
      if (tokenData) {
        const profileId = tokenData["profile_ref"]?.id;
        console.log(`ProfileId: ${profileId}`);
        if (profileId && !results.success.includes(profileId)) {
          results.success.push(profileId);
        }
      } else {
        const matchingKey = Object.keys(mapVoipTokenProfile).find(key => 
          key.includes(token) || token.includes(key)
        );
        if (matchingKey) {
          console.log(`Found partial match: ${matchingKey}`);
          const profileId = mapVoipTokenProfile[matchingKey]["profile_ref"]?.id;
          if (profileId && !results.success.includes(profileId)) {
            results.success.push(profileId);
          }
        }
      }
    });

    // Process failed sends
    response.failed.forEach((failure) => {
      console.log("VoIP Failure Detail:", JSON.stringify(failure));
      const token = failure.device;
      const tokenData = mapVoipTokenProfile[token];
      
      if (failure.status === "410" || failure.response?.reason === "Unregistered") {
        results.invalidTokens.push(tokenData?.path);
      }

      if (tokenData) {
        const profileId = tokenData["profile_ref"]?.id;
        if (profileId) {
          results.failed.push({
            profileId,
            error: failure.response?.reason || "VoIP send failed",
          });
        }
      }
    });

    console.log("Success profiles:", results.success);
    console.log("Failed profiles:", results.failed);

  } catch (err) {
    console.error("VoIP APNs error:", err);
    console.error("VoIP APNs error stack:", err.stack);
  }

  return results;
}

function isInvalidTokenError(errorCode) {
  return INVALID_TOKEN_ERRORS.some(code => errorCode.includes(code));
}

// ============ HELPER FUNCTIONS ============
async function storeNotificationLogs(appUsers, data) {
  const chunks = commonService.chunkArray(appUsers, 250);

  for (const chunk of chunks) {
    const readBatch = admin.firestore().batch();
    const notificationBatch = admin.firestore().batch();

    for (const uid of chunk) {
      const readRef = admin.firestore().collection("notifications").doc(uid);
      const notificationRef = admin.firestore().collection("notifications").doc(uid).collection("logs").doc();

      readBatch.set(readRef, { read: false }, { merge: true });

      notificationBatch.set(notificationRef, {
        title: data.title,
        message: data.message,
        subtitle: data.subtitle,
        date: admin.firestore.FieldValue.serverTimestamp(),
        notificationimage: data.notificationImage,
        type: data.notificationType,
        landingpage: data.landingpage,
        sticky: data.sticky,
        metadata: data.metaData,
        read: false,
        recordid: data.recordid
      });
    }

    await Promise.all([
      readBatch.commit().catch(err => console.error("Read batch failed:", err)),
      notificationBatch.commit().catch(err => console.error("Notification batch failed:", err))
    ]);
  }
}


const RETRIABLE_ERRORS = [
  'app/network-error',
  'messaging/internal-error',
  'messaging/server-unavailable',
  'messaging/quota-exceeded'
];

async function sendWithRetry(payload, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await admin.messaging().sendEachForMulticast(payload);
    } catch (err) {
      const errorCode = err.code || err.message || '';
      const isRetriable = RETRIABLE_ERRORS.some(code => errorCode.includes(code));

      console.log(`FCM attempt ${attempt}/${retries} failed:`, err.message);

      if (attempt === retries || !isRetriable) {
        throw err;
      }

      // Longer delay for network errors
      const delay = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function sanitizeDataPayload(obj, excludeKeys = []) {
  const sanitized = {};

  // Keys to always exclude from FCM payload (large data)
  const defaultExcludeKeys = [
    'profileid',
    'profilesuccess',
    'profilefailed',
    'failedlist',
    'appFCMSuccess',
    'appFCMFailed',
    'webFCMSuccess',
    'webFCMFailed',
    'metadata' // Include metadata separately if needed
  ];

  const keysToExclude = [...defaultExcludeKeys, ...excludeKeys];

  for (const [key, value] of Object.entries(obj)) {
    // Skip excluded keys
    if (keysToExclude.includes(key)) continue;

    if (value === null || value === undefined) {
      sanitized[key] = '';
    } else if (value instanceof admin.firestore.Timestamp) {
      sanitized[key] = value.toMillis().toString();
    } else if (value && typeof value === 'object' && value.constructor.name === 'DocumentReference') {
      sanitized[key] = value.path;
    } else if (Array.isArray(value)) {
      // Skip large arrays
      if (value.length > 10) continue;
      sanitized[key] = JSON.stringify(value);
    } else if (typeof value === 'object') {
      // Skip large objects
      const jsonStr = JSON.stringify(value);
      if (jsonStr.length > 500) continue;
      sanitized[key] = jsonStr;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = String(value);
    } else {
      // Skip large strings
      if (typeof value === 'string' && value.length > 500) continue;
      sanitized[key] = String(value);
    }
  }
  return sanitized;
}

// Slack any New Group Message to Channel
exports.SupportDeskToSlack = onDocumentCreated('/supportdesk/{docid}/messages/{messageid}', async (snapshotdata)=>{
  var url
  var snapshot = snapshotdata.data
  if(commonService.production){
    url = commonService.slackLogSupport;
  }
  else{
    url = commonService.slackDevTest
  }

  var webhook = new IncomingWebhook(url);

  var sender_uid = snapshot.data().sender_uid;
  var sender_name = await (await admin.firestore().collection("profile_data").where("user_ref", "==", admin.firestore().collection("user_data").doc(sender_uid)).get()).docs[0].data().name;

  var email = snapshot.data().sender_email;
  var groupname = "supportdesk";
  var message = snapshot.data().message;
  var time = (snapshot.data().time).toDate();

  time.setHours(time.getHours()+5)
  time.setMinutes(time.getMinutes()+30)
  console.log(time.toString())


  var data = "Sender_name: " + sender_name + "\n" + "Sender_email: " + email + "\n" + "Group_name: " + groupname + "\n" + "Message: " + message + "\n" + "Timestamp: " + time.toString()
  console.log("Message: " + data)

  webhook.send(data, function(err, header, statusCode, body) {
    if (err) {
      console.log('Error:', err);
    } else {
      console.log('Received', statusCode, 'from Slack');
    }
  });
});

// exports.emailArchiveTriggerOnWrite =  onDocumentWritten("email archive/{docid}", async (snap) => {
//   var change = snap.data
//   let mapProfile = {};
//   let mapProfileEmail = {};
//   const oldDoc = snap.data.before.exists ? snap.data.before.data() : null;
//   const newDoc = snap.data.after.exists ? snap.data.after.data() : null;
//   const newDocRef  = change.after.ref;
//   const isNewValidated = !oldDoc && newDoc?.status === "validated";
//   const isTest = !oldDoc && newDoc?.status == 'sendtest' && newDoc?.['testemails'].length != 0;

//   const isQueuedToValidated = oldDoc?.status === "queued" && newDoc?.status === "validated";
//   console.log('Checkpoint',isNewValidated || isQueuedToValidated);

//   if(isTest){

//     await admin.firestore().collection("participant metadata").get().then(async (profilesnap) => {
//       // getting profile data
//       if (profilesnap.docs.length != 0) {
//         for (let i = 0; i < profilesnap.docs.length; i++) {
//           const profileElement = profilesnap.docs[i].data();
//           mapProfile[profileElement['profileid']] = profileElement
//           mapProfileEmail[profileElement['email']] = profileElement;
//         }
//       } else {
//         console.log('No Participants Found');
//       };
//     });

//     //creating email batches
//     let batchEmailList = []
//     let emailList = []
//     for (let i = 0; i < newDoc['profileid'].length; i++) {
//       const profileId = newDoc['profileid'][i];
//       const profileData = mapProfile[profileId];
//       let mailoptions = {
//         From: "support@intl.soexcellence.com", 
//         To: newDoc['testemails'],
//         TemplateAlias: newDoc['templateid'],
//         TemplateModel: extractTemplateVariables(newDoc['body'], profileData)
//       }
//       console.log('Variables',extractTemplateVariables(newDoc['body'], profileData));
      
//       if(i != 0 && i%400 === 0){
//         batchEmailList.push(emailList)
//         emailList = [];
//       }
      
//       emailList.push(mailoptions)
//     }
//     batchEmailList.push(emailList)
//     //submitting batch email
//     for (let i = 0; i < batchEmailList.length; i++) {
//       let mailelement = batchEmailList[i]
//       await postmarkClient.sendEmailBatchWithTemplates(mailelement,async function (error, info) {
//         if (error) {
//           console.log('There was an error on sending email:', error);
//           let updateElement = newDoc
//           updateElement['mailstatus'] = 'not delivered'
//           await newDocRef.update(updateElement).then(() => {
//             console.log("error on sending email to participant");
//           }).catch(err => {console.log("error on updating email archive",err);})
//           return 
//         }else {
//           console.log("mail sent sucesinfos%",info);

//           if((i+1) === batchEmailList.length){
//             await newDocRef.update({
//               status : "testcompleted",
//               mailstatus : "testdelivered",
//             }).then(() => {
//               console.log("all email sended to participant");
//             }).catch(err => {console.log(err);
//               console.log("Error",err);
//             });
//           }

//           //changed by harish
//           let msgIds = info.map((e)=>e['MessageID']);
//           await newDocRef.update({
//             postmark_msgid : admin.firestore.FieldValue.arrayUnion(...msgIds),
//           }).then(() => {
//             console.log("all email sended to participant");
//           }).catch(err => {console.log(err);
//             console.log("Error",err);
//           });

//           const sentLogBatch = admin.firestore().batch();

//           for (let logindex = 0; logindex < info.length; logindex++) {
//             const log = info[logindex];
//             const docref = admin.firestore().collection("email logs").doc();
//             sentLogBatch.set(docref,{
//               email : log['To'],
//               profileid : [null,undefined,""].includes(mapProfileEmail[log['To']]) ? null : mapProfileEmail[log['To']]['profileid'],
//               postmark_msgid : log['MessageID'],
//               msgstatus : "sent",
//               templateid : newDoc['templateid'],
//               emailarchiveid : newDoc['docid'],
//               time : admin.firestore.FieldValue.serverTimestamp(),
//             });
//           }
//           await sentLogBatch.commit().then(()=>{
//             console.log("MESSAGE SENT SUCCESSFULLY",);
//           }).catch((error)=>{
//             console.log("ERROR WHILE SENDING EMAIL");
//           });
//         }
//       });
//     }
    
//   }
  
//   if (isNewValidated || isQueuedToValidated) {

//     console.log('Started sending to participants');
    
//     await admin.firestore().collection("participant metadata").get().then(async (profilesnap) => {
//       // getting profile data
//       if (profilesnap.docs.length != 0) {
//         for (let i = 0; i < profilesnap.docs.length; i++) {
//           const profileElement = profilesnap.docs[i].data();
//           mapProfile[profileElement['profileid']] = profileElement
//           mapProfileEmail[profileElement['email']] = profileElement;
//         }
//       } else {
//         console.log('No Participants Found');
//       };
//     });

//     //creating email batches
//     let batchEmailList = []
//     let emailList = []
//     for (let i = 0; i < newDoc['profileid'].length; i++) {
//       const profileId = newDoc['profileid'][i];
//       const profileData = mapProfile[profileId];
//       let mailoptions = {
//         From: "support@intl.soexcellence.com", 
//         To: mapProfile[profileId]['email'],
//         TemplateAlias: newDoc['templateid'],
//         TemplateModel: extractTemplateVariables(newDoc['body'], profileData)
//       }
//       console.log('Variables',extractTemplateVariables(newDoc['body'], profileData));
      
//       if(i != 0 && i%400 === 0){
//         batchEmailList.push(emailList)
//         emailList = []
//       }
      
//       emailList.push(mailoptions)
//     }
//     batchEmailList.push(emailList)
//     //submitting batch email
//     for (let i = 0; i < batchEmailList.length; i++) {
//       let mailelement = batchEmailList[i]
//       await postmarkClient.sendEmailBatchWithTemplates(mailelement,async function (error, info) {
//         if (error) {
//           console.log('There was an error on sending email:', error);
//           let updateElement = newDoc
//           updateElement['mailstatus'] = 'not delivered'
//           await newDocRef.update(updateElement).then(() => {
//             console.log("error on sending email to participant");
//           }).catch(err => {console.log("error on updating email archive",err);})
//           return 
//         }else {
//           console.log("mail sent sucesinfos%",info);

//           if((i+1) === batchEmailList.length){
//             await newDocRef.update({
//               status : "completed",
//               mailstatus : "delivered",
//             }).then(() => {
//               console.log("all email sended to participant");
//             }).catch(err => {console.log(err);
//               console.log("Error",err);
//             });
//           }

//           //changed by harish
//           let msgIds = info.map((e)=>e['MessageID']);
//           await newDocRef.update({
//             postmark_msgid : admin.firestore.FieldValue.arrayUnion(...msgIds),
//           }).then(() => {newDocRef
//             console.log("all email sended to participant");
//           }).catch(err => {console.log(err);
//             console.log("Error",err);
//           });

//           const sentLogBatch = admin.firestore().batch();

//           for (let logindex = 0; logindex < info.length; logindex++) {
//             const log = info[logindex];
//             const docref = admin.firestore().collection("email logs").doc();
//             sentLogBatch.set(docref,{
//               email : log['To'],
//               profileid : [null,undefined,""].includes(mapProfileEmail[log['To']]) ? null : mapProfileEmail[log['To']]['profileid'],
//               postmark_msgid : log['MessageID'],
//               msgstatus : "sent",
//               templateid : newDoc['templateid'],
//               emailarchiveid : newDoc['docid'],
//               time : admin.firestore.FieldValue.serverTimestamp(),
//             });
//           }
//           await sentLogBatch.commit().then(()=>{
//             console.log("MESSAGE SENT SUCCESSFULLY",);
//           }).catch((error)=>{
//             console.log("ERROR WHILE SENDING EMAIL");
//           });

//         }
//       });
//     }
//   }
// });

// async function sendBatchEmailArchive(emailArchiveId){
//   let archiveData = {};
//   let newDocRef = null;
//   await admin.firestore().collection('email archive').doc(emailArchiveId).get().then((archivedoc)=>{
//     if(archivedoc.exists){
//       archiveData = archivedoc.data();
//       newDocRef = archivedoc.ref;
//     }else{
//       archiveData = null
//     }
//   });

//   if(archiveData != null && newDocRef != null){
//     let mapProfile = {};
//     let mapProfileEmail = {};

//     await admin.firestore().collection("participant metadata").get().then(async (profilesnap) => {
//       // getting profile data
//       if (profilesnap.docs.length != 0) {
//         for (let i = 0; i < profilesnap.docs.length; i++) {
//           const profileElement = profilesnap.docs[i].data();
//           mapProfile[profileElement['profileid']] = profileElement
//           mapProfileEmail[profileElement['email']] = profileElement;
//         }
//       } else {
//         console.log('No Participants Found');
//       };
//     });

//     //creating email batches
//     let batchEmailList = []
//     let emailList = []
//     for (let i = 0; i < archiveData['emailid'].length; i++) {
//       const profileId = archiveData['profileid'][i];
//       const emailId = archiveData['emailid'][i];
//       const profileData = mapProfile[profileId];
//       let mailoptions = {
//         From: "support@intl.soexcellence.com",
//         To: emailId,
//         TemplateAlias: archiveData['templateid'],
//         TemplateModel: extractTemplateVariables(archiveData['body'], profileData)
//       }
//       console.log('Variables', extractTemplateVariables(archiveData['body'], profileData));

//       if (i != 0 && i % 400 === 0) {
//         batchEmailList.push(emailList)
//         emailList = []
//       }

//       emailList.push(mailoptions)
//     }
//     batchEmailList.push(emailList)
//     //submitting batch email
//     for (let i = 0; i < batchEmailList.length; i++) {
//       let mailelement = batchEmailList[i]
//       await commonService.postmarkClient.sendEmailBatchWithTemplates(mailelement, async function (error, info) {
//         if (error) {
//           console.log('There was an error on sending email:', error);
//           let updateElement = archiveData
//           updateElement['mailstatus'] = 'not delivered'
//           await newDocRef.update(updateElement).then(() => {
//             console.log("error on sending email to participant");
//           }).catch(err => { console.log("error on updating email archive", err); })
//           return
//         } else {
//           console.log("mail sent sucesinfos%", info);

//           if ((i + 1) === batchEmailList.length) {
//             await newDocRef.update({
//               status: "completed",
//             }).then(() => {
//               console.log("all email sended to participant");
//             }).catch(err => {
//               console.log(err);
//               console.log("Error", err);
//             });
//           }

//           //changed by harish
//           let msgIds = info.map(e => e.MessageID).filter(Boolean);
//           console.log("msgIds:", msgIds);

//           // create map only for items that have both To and MessageID
//           const responseMap = info.reduce((acc, item) => {
//             if (item.To && item.MessageID) {
//               acc[item.To] = item.MessageID;
//             }
//             return acc;
//           }, {});
//           console.log("ResponseMap",responseMap);
          
//           await newDocRef.update({
//             postmark_msgid: admin.firestore.FieldValue.arrayUnion(...msgIds),
//             response: responseMap,
//             sent: info.map(e => e.To).filter(Boolean)
//           }).then(() => {
//             console.log("all email sended to participant");
//           }).catch(err => {
//             console.log(err);
//             console.log("Error", err);
//           });

//           const sentLogBatch = admin.firestore().batch();

//           for (let logindex = 0; logindex < info.length; logindex++) {
//             const log = info[logindex];
//             const docref = admin.firestore().collection("email logs").doc();
//             sentLogBatch.set(docref, {
//               email: log['To'],
//               profileid: [null, undefined, ""].includes(mapProfileEmail[log['To']]) ? null : mapProfileEmail[log['To']]['profileid'],
//               postmark_msgid: log['MessageID'],
//               msgstatus: "sent",
//               templateid: archiveData['templateid'],
//               emailarchiveid: archiveData['docid'],
//               time: admin.firestore.FieldValue.serverTimestamp(),
//             });
//           }
//           await sentLogBatch.commit().then(() => {
//             console.log("MESSAGE SENT SUCCESSFULLY",);
//           }).catch((error) => {
//             console.log("ERROR WHILE SENDING EMAIL");
//           });

//         }
//       });
//     }
//     return 'Emails Sent Successfully'
//   } else {
//     return 'No Archive Data Found'
//   }
// }

// function extractTemplateVariables(template, profileData) {
//   const variables = {};
  
//   // Find all template variables in the format {{variable}}
//   const matches = template.match(/\{\{([^}]+)\}\}/g);
  
//   if (matches) {
//     matches.forEach(match => {
//       // Extract the variable name (remove {{ and }})
//       const variableName = match.replace(/[{}]/g, '');
//       const keys = variableName.split('.');
      
//       // Get the value from profileData
//       let value = profileData;
//       for (const key of keys) {
//         value = value?.[key];
//       }
      
//       // Store in variables object using the variable name as key
//       variables[variableName] = value !== undefined ? value : '';
//     });
//   }
  
//   return variables;
// }

exports.sendBatchEmailTest = onDocumentCreated({
  document: "email archive/{docid}",
  timeoutSeconds: 540,
  memory: "512MiB",
  secrets: [
    POSTMARK_STARLABS_V1,
    POSTMARK_STARLABS_V2,
    POSTMARK_STARLABS_V3,
    POSTMARK_STARLABS_V4,
    POSTMARK_STARLABS_TEST
  ]
},
  async (snap) => {
    const change = snap.data;
    const newDocId = change?.data().docid;
    console.log('Started sending to participants');
 
    if (change.data()['status'] != 'queued') {
 
      // FIX: Use .value() to get the actual secret string, not the Secret object
      const serversMap = {
        POSTMARK_STARLABS_V1,
        POSTMARK_STARLABS_V2,
        POSTMARK_STARLABS_V3,
        POSTMARK_STARLABS_V4,
        POSTMARK_STARLABS_TEST,
      };
 
      const result = await sendBatchEmailArchive(newDocId, serversMap);
      console.log('Finished sending to participants', result);
    }
  }
);

exports.sendBatchEmail = onRequest({
  region: "us-central1",
  cors:true,
  timeoutSeconds: 540,
  memory: "512MiB",
  secrets: [
    POSTMARK_STARLABS_V1,
    POSTMARK_STARLABS_V2,
    POSTMARK_STARLABS_V3,
    POSTMARK_STARLABS_V4,
    POSTMARK_STARLABS_TEST
  ]
},async (req, res) => {
  console.log("Function triggered");
  console.log("Archive ID", req.body);
  const archiveid = req.body.archiveid;

  const serversMap = {
    POSTMARK_STARLABS_V1,
    POSTMARK_STARLABS_V2,
    POSTMARK_STARLABS_V3,
    POSTMARK_STARLABS_V4,
    POSTMARK_STARLABS_TEST
  };

  const result = await sendBatchEmailArchive(archiveid,serversMap);
  console.log('Finished sending to participants', result);
  res.json({
    success: true,
    message: result,
    data: result
  });
});

//harish
exports.postmarkResponseCapture = onRequest({region: "us-central1", cors:true, memory: "512MiB"},async (req, res) => {

  console.log("RESPONSEBODY",req.body);
  let responseData = req.body
  let mapProfileEmail = {};
  await admin.firestore().collection("profile_data").orderBy("name","asc").get().then((profile)=>{
    for (let i = 0; i < profile.docs.length; i++) {
      const profileData = profile.docs[i].data();
      mapProfileEmail[profileData['email']] = profileData;
    }
  });

  await admin.firestore().collection("email archive").where("postmark_msgid","array-contains",responseData['MessageID']).limit(1).get().then(async(emailarchivedocs)=>{
    if(emailarchivedocs.docs.length != 0){
      const emailArchiveRef = emailarchivedocs.docs[0].ref;
      let broadcastData = emailarchivedocs.docs[0].data();

      const docref  = admin.firestore().collection("email logs").doc();

      if([null,undefined,""].includes(responseData['Recipient'])){

        responseData['email'] = responseData['Email'];

      }else if([null,undefined,""].includes(responseData['Email'])){

        responseData['email'] = responseData['Recipient'];

      }

      responseData['profileid'] = [null,undefined,""].includes(mapProfileEmail[responseData['Recipient']]) ? null : mapProfileEmail[responseData['Recipient']]['profileid'],
      responseData['postmark_msgid'] = responseData['MessageID'],
      responseData['msgstatus'] = responseData['RecordType'].toLowerCase().trim(),
      responseData['templateid'] = broadcastData['templateid'],
      responseData['emailarchiveid'] = broadcastData['docid'],
      responseData['time'] = admin.firestore.FieldValue.serverTimestamp(),
      
      await docref.set(responseData).then(()=>{
        console.log("Log Added SUCCESSFULLY");
        return res.status(200).send({ message: "Success" });
      }).catch((error)=>{
        console.log("ERROR WHILE Adding Log",error);
        return res.status(500).send({ message: "Internal Server Error" });
      });

      await emailArchiveRef.update({
        [responseData['msgstatus']] : admin.firestore.FieldValue.arrayUnion(responseData['Recipient'])
      }).then(()=>{
        console.log("Archive Updated SUCCESSFULLY");
        return res.status(200).send({ message: "Success" });
      }).catch((error)=>{
        console.log("ERROR WHILE Updating Archive",error);
        return res.status(500).send({ message: "Internal Server Error" });
      });;

    }
  });

});

async function sendBatchEmailArchive(emailArchiveId, serversMap) {
 
  // ── 1. Fetch archive doc ─────────────────────────────────────────────────
  let archiveData = null;
  let newDocRef   = null;
 
  await admin.firestore().collection('email archive').doc(emailArchiveId).get().then((doc) => {
    if (doc.exists) {
      archiveData = doc.data();
      newDocRef   = doc.ref;
    }
  });
 
  if (!archiveData || !newDocRef) {
    return 'No Archive Data Found';
  }
 
  // ── 2. Resolve Postmark server token ─────────────────────────────────────
  const selectedSecret = serversMap[archiveData['servername']].value();
 
  if (!selectedSecret) {
    console.error(`Invalid server name: "${archiveData['servername']}". Available: ${Object.keys(serversMap).join(', ')}`);
    await newDocRef.update({ status: "failed", error: `Invalid server name: ${archiveData['servername']}` });
    throw new Error(`Invalid server name: ${archiveData['servername']}`);
  }
 
  const postmarkClient = new postmark.ServerClient(selectedSecret);
 
  // ── 3. Load participant metadata ─────────────────────────────────────────
  const mapProfile      = {};
  const mapProfileEmail = {};
 
  const query = archiveData['profileid'].length < 30
    ? admin.firestore().collection("participant metadata").where('profileid', 'in', archiveData['profileid'])
    : admin.firestore().collection("participant metadata");
 
  await query.get().then((snap) => {
    snap.docs.forEach((d) => {
      const p = d.data();
      mapProfile[p['profileid']] = p;
      mapProfileEmail[p['email']] = p;
    });
  });
 
  const datamodel       = archiveData.datamodel || {};
  const variableConfigs = datamodel['_variableConfigs'] || {};
  const sheetFileUrl    = datamodel['_sheetFileUrl'] || null;
 
  const needsSheet = Object.values(variableConfigs).some(src => src === 'sheet');
 
  // ── 4. Load sheet (if needed) ────────────────────────────────────────────
  let sheetData = null;
 
  if (needsSheet && sheetFileUrl) {
    try {
      sheetData = await fetchAndParseSheet(sheetFileUrl);
      console.log('Sheet data loaded successfully');
    } catch (error) {
      console.error('Error loading sheet data:', error);
      await newDocRef.update({ status: "failed", error: "Failed to load sheet data" });
      return 'Failed to load sheet data';
    }
  }
 
  // ── 5. Fetch and base64-encode attachments ───────────────────────────────
  let postmarkAttachments = [];
 
  const rawAttachments = archiveData['postmarkAttachments'] || archiveData['attachments'] || [];
 
  if (rawAttachments.length > 0) {
    console.log(`Processing ${rawAttachments.length} attachment(s)...`);
    postmarkAttachments = await buildPostmarkAttachmentsFromUrls(rawAttachments);
    console.log(`${postmarkAttachments.length} attachment(s) ready for Postmark`);
  }
 
  // ── 6. Build per-recipient email list ────────────────────────────────────
  const batchEmailList = [];
  let   emailList      = [];
 
  for (let i = 0; i < archiveData['emailid'].length; i++) {
    const profileId   = archiveData['profileid'][i];
    const emailId     = archiveData['emailid'][i];
    const profileData = mapProfile[profileId] || {};
 
    // ── Build the templateModel for this recipient ──────────────────────
    let templateModel = {};
 
    // Legacy / automated path
    if (archiveData.variableoption === 'automated') {
      templateModel = Array.isArray(archiveData.datamodel) ? archiveData.datamodel : (archiveData.datamodel || []);
 
    } else if (Object.keys(variableConfigs).length > 0) {
      // Per-variable source resolution
      templateModel = buildPerVariableModel({
        variableConfigs,
        datamodel,
        profileData,
        emailId,
        sheetData,
      });
 
    } else {
      // Legacy fallback (single variableoption)
      if (archiveData.variableoption === 'static') {
        templateModel = archiveData.datamodel || {};
 
      } else if (archiveData.variableoption === 'analytics') {
        templateModel = extractAnalyticsVariables(profileData, archiveData.datamodel);
 
      } else if (archiveData.variableoption === 'sheet' && sheetData) {
        templateModel = extractSheetVariables(archiveData['body'], emailId, sheetData);
 
      } else {
        templateModel = extractTemplateVariables(archiveData['body'], profileData);
      }
    }
 
    console.log(`Variables for ${emailId}:`, templateModel);
 
    const mailOptions = {
      From:          archiveData['from'] || "support@intl.soexcellence.com",
      To:            emailId,
      Cc: archiveData['cc'] || null,
      Bcc: archiveData['bcc'] || null,
      TemplateAlias: archiveData['templateid'],
      TemplateModel: templateModel,
      Tag:           archiveData['broadcastname'],
      Attachments:   postmarkAttachments,
    };
    
    // Batch in groups of 400 (Postmark limit)
    if (i !== 0 && i % 400 === 0) {
      batchEmailList.push(emailList);
      emailList = [];
    }
    emailList.push(mailOptions);
  }
  batchEmailList.push(emailList);
 
  // ── 7. Send batches via Postmark ─────────────────────────────────────────
  for (let i = 0; i < batchEmailList.length; i++) {
    const mailelement = batchEmailList[i];
 
    try {
      const info = await postmarkClient.sendEmailBatchWithTemplates(mailelement);
 
      console.log("Batch sent:", info);
 
      // Mark completed on last batch
      if ((i + 1) === batchEmailList.length) {
        await newDocRef.update({ status: "completed" })
          .catch(err => console.error("Error marking completed:", err));
      }
 
      // Collect message IDs and response map
      const msgIds = info.map(e => e.MessageID).filter(Boolean);
      const responseMap = info.reduce((acc, item) => {
        if (item.To && item.MessageID) acc[item.To] = item.MessageID;
        return acc;
      }, {});
 
      await newDocRef.update({
        postmark_msgid: msgIds.length === 0
          ? []
          : admin.firestore.FieldValue.arrayUnion(...msgIds),
        response: responseMap,
        sent: info.map(e => e.To).filter(Boolean),
      }).catch(err => console.error("Error updating msgids:", err));
 
      // Write per-email send logs
      const sentLogBatch = admin.firestore().batch();
 
      for (const log of info) {
        const docRef = admin.firestore().collection("email logs").doc();
 
        if (log['ErrorCode'] === 406 || log['Message'] !== 'OK') {
          const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
          const emails = log['Message'].match(emailRegex) || [];
 
          sentLogBatch.set(docRef, {
            email:          emails[0] || null,
            profileid:      mapProfileEmail[emails[0]]?.['profileid'] || null,
            postmark_msgid: log['MessageID'] || null,
            msgstatus:      "not-sent",
            errormsg:       log['Message'] || null,
            templateid:     archiveData['templateid'],
            emailarchiveid: archiveData['docid'],
            time:           admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          sentLogBatch.set(docRef, {
            email:          log['To'] || null,
            profileid:      mapProfileEmail[log['To']]?.['profileid'] || null,
            postmark_msgid: log['MessageID'] || null,
            msgstatus:      "sent",
            templateid:     archiveData['templateid'],
            emailarchiveid: archiveData['docid'],
            time:           admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
      
      await sentLogBatch.commit().then(async()=>{
        if (archiveData['participantjourneyproductid'] != null) {
          await admin.firestore().collection('participantjourneyproduct').doc(archiveData['participantjourneyproductid']).update({
            emailsent: true
          }).then(() => {
            console.log('participantjourneyproduct updated Successfully');
          }).catch((error) => {
            console.error('Error while updating Participant Journey Product', error)
          });
        }
      }).catch(async (err) =>  {
        console.error("Error writing email logs:", err);
        if (archiveData['participantjourneyproductid'] != null) {
          await admin.firestore().collection('participantjourneyproduct').doc(archiveData['participantjourneyproductid']).update({
            emailsent: false
          }).then(() => {
            console.log('participantjourneyproduct updated Successfully');
          }).catch((error) => {
            console.error('Error while updating Participant Journey Product', error)
          });
        }
      });
 
    } catch (error) {
      console.error('Error sending email batch:', error);
      await newDocRef.update({
        ...archiveData,
        mailstatus: 'not delivered',
        error: error.message || 'Unknown error',
      }).catch(err => console.error("Error updating archive:", err));
    }
  }
 
  return 'Emails Sent Successfully';
}
 
 
// ════════════════════════════════════════════════════════════════════════════
// Attachment helpers
// ════════════════════════════════════════════════════════════════════════════
 
/**
 * Fetch each attachment URL and convert to Postmark format:
 * { Name, Content (base64), ContentType }
 *
 * Handles both formats from the frontend:
 * - postmarkAttachments: [{ Name, ContentType, ContentUrl, ContentSize }]
 * - attachments: [{ name, type, url, size }]
 */
async function buildPostmarkAttachmentsFromUrls(attachments) {
  const results = [];
 
  for (const att of attachments) {
    const name        = att.Name || att.name;
    const contentType = att.ContentType || att.type || 'application/octet-stream';
    const url         = att.ContentUrl || att.url;
 
    if (!url || !name) {
      console.warn('Skipping attachment with missing url or name:', att);
      continue;
    }
 
    try {
      const base64Content = await fetchUrlAsBase64(url);
      results.push({
        Name: name,
        Content: base64Content,
        ContentType: contentType,
      });
      console.log(`Attachment "${name}" encoded (${contentType})`);
    } catch (error) {
      console.error(`Failed to fetch attachment "${name}" from ${url}:`, error.message);
      // Skip failed attachments rather than failing the entire send
    }
  }
 
  return results;
}
 
/**
 * Fetch a URL and return its content as a base64-encoded string.
 */
function fetchUrlAsBase64(fileUrl) {
  return new Promise((resolve, reject) => {
    const protocol = fileUrl.startsWith('https:') ? https : http;
 
    protocol.get(fileUrl, (response) => {
      // Handle redirects (Firebase Storage returns 302 sometimes)
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        fetchUrlAsBase64(response.headers.location).then(resolve).catch(reject);
        return;
      }
 
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} fetching ${fileUrl}`));
        return;
      }
 
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);
          resolve(buffer.toString('base64'));
        } catch (err) {
          reject(new Error(`Failed to encode: ${err.message}`));
        }
      });
      response.on('error', (err) => reject(err));
    }).on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
  });
}
 
 
// ════════════════════════════════════════════════════════════════════════════
// Per-variable model builder
// ════════════════════════════════════════════════════════════════════════════
 
function buildPerVariableModel({ variableConfigs, datamodel, profileData, emailId, sheetData }) {
  const model = {};
 
  for (const [variable, source] of Object.entries(variableConfigs)) {
    switch (source) {
 
      case 'static': {
        model[variable] = datamodel[variable] ?? '';
        break;
      }
 
      case 'analytics': {
        const mappedField = datamodel[variable];
 
        if (Array.isArray(mappedField)) {
          model[variable] = mappedField.map(
            field => profileData?.[field] ?? ''
          );
        } else if (mappedField && profileData) {
          model[variable] = profileData[mappedField] ?? '';
        } else {
          model[variable] = '';
        }
        break;
      }
 
      case 'sheet': {
        if (!sheetData) { model[variable] = ''; break; }
 
        const emailRow = sheetData.data.find(row =>
          Object.values(row).some(val =>
            val && val.toString().trim().toLowerCase() === emailId.trim().toLowerCase()
          )
        );
 
        if (emailRow) {
          const matchingHeader = sheetData.headers.find(h =>
            h && (
              h.trim() === variable.trim() ||
              h.includes(variable) ||
              variable.includes(h)
            )
          );
          model[variable] = matchingHeader && emailRow[matchingHeader] !== undefined
            ? emailRow[matchingHeader]
            : '';
        } else {
          model[variable] = '';
        }
        break;
      }
 
      default:
        model[variable] = '';
    }
  }
 
  return model;
}
 
 
// ════════════════════════════════════════════════════════════════════════════
// Sheet parser
// ════════════════════════════════════════════════════════════════════════════
 
async function fetchAndParseSheet(fileUrl) {
  return new Promise((resolve, reject) => {
    const protocol = fileUrl.startsWith('https:') ? https : http;
 
    protocol.get(fileUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to fetch file: ${response.statusCode}`));
        return;
      }
 
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const buffer   = Buffer.concat(chunks);
          const workbook = XLSX.read(buffer, { type: 'buffer' });
          const ws       = workbook.Sheets[workbook.SheetNames[0]];
          const jsonData = XLSX.utils.sheet_to_json(ws, { header: 1 });
 
          if (jsonData.length < 2) {
            reject(new Error('Sheet must have at least a header row and one data row'));
            return;
          }
 
          const headers = jsonData[0];
          const rows    = jsonData.slice(1);
 
          resolve({
            headers,
            data: rows.map(row => {
              const obj = {};
              headers.forEach((h, idx) => { obj[h] = row[idx] ?? ''; });
              return obj;
            }),
          });
        } catch (err) {
          reject(new Error(`Failed to parse Excel file: ${err.message}`));
        }
      });
    }).on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
  });
}
 
// ════════════════════════════════════════════════════════════════════════════
// Legacy helpers
// ════════════════════════════════════════════════════════════════════════════
 
function extractAnalyticsVariables(profileData, analyticsMapping) {
  const variables = {};
  Object.entries(analyticsMapping).forEach(([key, mappedField]) => {
    variables[mappedField] = (mappedField && profileData)
      ? (profileData[mappedField] ?? '')
      : '';
  });
  return variables;
}
 
function extractSheetVariables(template, emailId, sheetData) {
  const variables = {};
  const matches   = template.match(/\{\{([^}]+)\}\}/g);
 
  if (matches && sheetData?.data) {
    const emailRow = sheetData.data.find(row =>
      Object.values(row).some(val =>
        val && val.toString().trim() === emailId.trim()
      )
    );
 
    matches.forEach(match => {
      const varName        = match.replace(/[{}]/g, '');
      const matchingHeader = sheetData.headers.find(h =>
        h && (h.includes(varName) || varName.includes(h) || h.trim() === varName.trim())
      );
      variables[varName] = (matchingHeader && emailRow?.[matchingHeader] !== undefined)
        ? emailRow[matchingHeader]
        : '';
    });
  }
 
  return variables;
}
 
function extractTemplateVariables(template, profileData) {
  const variables = {};
  const matches   = template.match(/\{\{([^}]+)\}\}/g);
 
  if (matches) {
    matches.forEach(match => {
      const varName = match.replace(/[{}]/g, '');
      const value   = varName.split('.').reduce((obj, key) => obj?.[key], profileData);
      variables[varName] = value !== undefined ? value : '';
    });
  }
 
  return variables;
}


//harish
exports.myOperatorCalls = onRequest({region: "us-central1", cors:true, secrets: [MYOPERATOR_TOKEN]},async (req, res) => {
  console.log("Triggered....:)");

  const messageData = req.body;
  console.log("CONTACT NUMBER", messageData["_cr"]);
  console.log("CALL RECORDING", messageData["_fu"]);
  console.log("CALL RECORDING NAME", messageData["_fn"]);
  console.log("CALL STATUS", messageData["_us"][0]["vl"]); // received or missed
  console.log("CALL TIMINGS", messageData["_dr"]);
  console.log("CALL BY", messageData["_us"][0]["ky"]);
  console.log("CALL STATUSSSSSS", messageData["_ld"][0]["_ds"]);
  console.log("MESSAGE DATA", JSON.stringify(messageData));

  const docRef = admin.firestore().collection("myoperator calls").doc();

  try {
    // Save initial document
    await docRef.set({
      docid: docRef.id,
      time: admin.firestore.FieldValue.serverTimestamp(),
      date: admin.firestore.FieldValue.serverTimestamp(),
      recordingurl: null, // Placeholder until upload
      callstatus: [null, undefined, ""].includes(messageData["_us"][0]["vl"]) ? null : messageData["_us"][0]["vl"],
      duration: [null, undefined, ""].includes(messageData["_dr"]) ? null : messageData["_dr"],
      calledby: [null, undefined, ""].includes(messageData["_us"][0]["ky"]) ? null : messageData["_us"][0]["ky"],
      status: [null, undefined, ""].includes(messageData["_ld"][0]["_ds"]) ? null : messageData["_ld"][0]["_ds"],
      calledto: [null, undefined, ""].includes(messageData["_cr"]) ? null : messageData["_cr"],
    });

    const myOperatorToken = MYOPERATOR_TOKEN.value();
    const recordingURL = await downloadCallRecording(messageData["_fn"], myOperatorToken);
    console.log("RECORDING RESPONSE",recordingURL);
    await downloadAndUpload(recordingURL,docRef)
    
    return res.status(200).send({ message: "Call captured and recording processed successfully" });
  } catch (error) {
    console.error("ERROR WHILE PROCESSING CALL:", error);
    return res.status(500).send({ message: "Internal Server Error" });
  }
});

async function downloadCallRecording(filename, myOperatorToken) {

  const savePath = "./call_recording.mp3"
  const token = myOperatorToken
  const BASE_URL = "https://developers.myoperator.co/recordings/link?token=" + token + "&file=" + filename;
  try {
      const response = await axios.get(`${BASE_URL}`, {});

      if (response.data && response.data.recording_url) {
          const recordingUrl = response.data.recording_url;

          const recordingResponse = await axios.get(recordingUrl, { responseType: 'stream' });

          const writer = fs.createWriteStream(savePath);
          recordingResponse.data.pipe(writer);

          writer.on('finish', () => console.log('Recording downloaded successfully!'));
          writer.on('error', (err) => console.error('Error writing file:', err));
      } else {
        console.error('Recording URL:', response.data['url']);
        return response.data['url'];
      }
  } catch (error) {
      console.error('Error fetching recording:', error.response ? error.response.data : error.message);
  }
}

async function downloadAndUpload(recordingUrl,docRef) {
  const fileUrl = recordingUrl;
  const tempFilePath = path.join(os.tmpdir(), 'temp-audio-file.mp3');
  try {
    console.log('Downloading file...');
    const response = await axios({
      url: fileUrl,
      method: 'GET',
      responseType: 'stream',
    });
    // Save the file locally
    const writer = fs.createWriteStream(tempFilePath);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    console.log('File downloaded successfully.');
    const token = uuidv4();
    // Upload the file to Firebase Storage
    const firebaseFileName = `call_recordings/${Date.now()}-audio-file.mp3`; // Set the destination path in Firebase Storage
    console.log('Uploading to Firebase Storage...');
    const bucketresponse = await bucket.upload(tempFilePath, {
      destination: firebaseFileName,
      metadata: {
        contentType: 'audio/mpeg',
        metadata: {
          firebaseStorageDownloadTokens: token,
        },
      },
    });
    const bucketUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(firebaseFileName)}?alt=media&token=${token}`;
    await docRef.update({
      recordingurl : bucketUrl
    }).then(()=>{
      console.log("Document Updated Successfully");
    }).catch((error)=>{
      console.log("Error",error);
    })
    fs.unlinkSync(tempFilePath);
    console.log('Temporary file deleted.');
  } catch (error) {
    console.error('Error during download or upload:', error);
  }
}

//harish
exports.createPostMarkEmailTemplate = onDocumentUpdated({
  document:'email templates/{docid}',
  region: 'us-central1',
  cors: true,
  secrets: [
    POSTMARK_STARLABS_V1,
    POSTMARK_STARLABS_V2,
    POSTMARK_STARLABS_V3,
    POSTMARK_STARLABS_V4,
    POSTMARK_STARLABS_TEST
  ]
},async (change) => {

  let previousData = change.data?.before.data();
  let currentData = change.data?.after.data();

  const serversMap = {
    POSTMARK_STARLABS_V1,
    POSTMARK_STARLABS_V2,
    POSTMARK_STARLABS_V3,
    POSTMARK_STARLABS_V4,
    POSTMARK_STARLABS_TEST
  };

    const selectedSecret = serversMap[currentData['servername']];

    if (!selectedSecret) {
      throw new Error(`Invalid server name: ${currentData['servername']}`);
    }

    const postmarkClient = new postmark.ServerClient(selectedSecret.value());

  if(currentData['type'] == "email"){

    if([null,false].includes(previousData['templatevalidated']) && currentData['templatevalidated'] == true && previousData['templatestatus'] == "created" && currentData['templatestatus'] == "created"){

      console.log("TEMPLATE NAME",currentData['templatename']);
  
      await postmarkClient.createTemplate({
        TextBody : currentData['textbody'],
        Alias : currentData['templatealias'],
        LayoutTemplate : currentData['templatelayout'],
        HtmlBody : currentData['htmlbody'],
        Name : currentData['templatename'],
        Subject : currentData['subject'],
        TemplateType : currentData['templatetype'],
      }).then(async (res)=>{
        console.log("RESPONSE",res);
        await admin.firestore().collection("email templates").doc(currentData['docid']).update({
          postmarktemplateid : res['TemplateId'],
          active : res['Active'],
          postmarkstatus : "approved",
        }).then(()=>{
          console.log("TEMPLATE ACTIVE",res['TemplateId']);
        }).catch((error)=>{
          console.log("OOPS ERROR WHILE ACTG TEMPLATE");
        });
      }).catch((error)=>{
        console.log("ERROR",error);
      });
  
    }
  
    if ([null, false].includes(previousData['templatevalidated']) && currentData['templatevalidated'] == true && previousData['templatestatus'] == "updated" && currentData['templatestatus'] == "created") {

      console.log('Updating Template');
      
      let data = {
        Name: currentData['templatename'],
        Subject: currentData['subject'],
        HtmlBody: currentData['htmlbody'],
        TextBody: currentData['textbody'],
        Alias: currentData['templatealias'],
      }

      const templateId = currentData['postmarktemplateid']

      try {

        const response = await postmarkClient.editTemplate(templateId, data);

        await admin.firestore().collection("email templates").doc(currentData['docid']).update({
          active: true,
          postmarkstatus: "approved",
        }).then(() => {
          console.log("TEMPLATE EDITED", response.data['TemplateId']);
        }).catch((error) => {
          console.log("OOPS ERROR WHILE EDITING TEMPLATE", error);
        });

      } catch (error) {
        console.error("Error updating Postmark template:", error.response?.data || error.message);
      }

    }
  }
});

//harish

async function sendWatiBroadCast(watiarchiveid) {

  let templatename;
  let broadcastname;
  let mapProfile = {};
  let mapMetadata = {}; // participant metadata by profileId
  let broadCastData = {};
  let excelParameterMap = {}; // Map to store Excel data by phone number { phone: { colHeader: value } }

  // ── 1. Fetch archive document ───────────────────────────────────────
  await admin.firestore().collection('wati archive').doc(watiarchiveid).get().then((archive) => {
    templatename  = archive.data()['watitemplateid'];
    broadcastname = archive.data()['broadcastname'];
    broadCastData = archive.data();
  });

  console.log("paramFillMode:", broadCastData['paramFillMode']);
  console.log("parameterConfig:", JSON.stringify(broadCastData['parameterConfig']));

  // ── 2. Process Excel file (only if any param uses excel mode) ───────
  const hasExcelParams = (broadCastData['parameterConfig'] || []).some(p => p.fillType === 'excel');
  if (hasExcelParams && broadCastData.excelFile && broadCastData.excelFile.downloadUrl) {
    console.log("Processing Excel file:", broadCastData.excelFile.originalName);
    excelParameterMap = await processExcelFile(
      broadCastData.excelFile.downloadUrl,
      broadCastData.excelFile.headers || []
    );
    console.log('excelParameterMap',excelParameterMap);
  }

  // ── 3. Load profile_data (always needed for numbermap lookup) ────────
  // numbermap stores the profile_data document id, so look up by documentId().
  // Firestore 'in' query supports max 30 ids per call — chunk them.
  const profileIds = broadCastData['profileid'] || [];
  const profileChunkSize = 30;
  for (let i = 0; i < profileIds.length; i += profileChunkSize) {
    const chunk = profileIds.slice(i, i + profileChunkSize);
    try {
      const snap = await admin.firestore()
        .collection("profile_data")
        .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
        .get();
      snap.docs.forEach(doc => {
        mapProfile[doc.id] = doc.data();
      });
    } catch (err) {
      console.error("Error loading profile_data chunk:", err);
    }
  }

  // ── 4. Load participant metadata (only if any param uses metadata mode) ─
  const hasMetadataParams = (broadCastData['parameterConfig'] || []).some(p => p.fillType === 'metadata');
  if (hasMetadataParams) {
    console.log("Loading participant metadata for", broadCastData['profileid']?.length, "profiles");
    await loadParticipantMetadata(broadCastData['profileid'] || [], mapMetadata);
  }

  // ── 5. Build broadcast batches ────────────────────────────────────────
  let broadCast = {
    broadcast_name: broadcastname + generateRandomId(),
    template_name: templatename,
    receivers: []
  };

  let batchList = [];
  let numbersWithMissingCountryCode = [];

  for (let i = 0; i < broadCastData['numbers'].length; i++) {
    const number    = broadCastData['numbers'][i];
    const profileId = broadCastData['numbermap'][number];
    const profile   = mapProfile[profileId] || {};
    const metadata  = mapMetadata[profileId] || {};

    let rawCountryCode = profile['countrycode'];
    if (!rawCountryCode) {
      console.warn(`Missing country code for number ${number} (profileId: ${profileId})`);
      numbersWithMissingCountryCode.push(number);
      continue; // Skip this number — will be added to failedNumbers later
    }

    // Strip leading + if present, then prepend to number
    const cleanedCountryCode = rawCountryCode.toString().replace(/^\+/, '').trim();
    const formattedNumber = cleanedCountryCode + number.toString().trim();

    // Build custom params using the new parameterConfig
    const customParams = buildCustomParams(
      broadCastData['parameterConfig'] || [],
      profile,
      metadata,
      number,
      excelParameterMap,
      broadCastData['excelFile'] || null
    );
    console.log('customParams',customParams);
    
    // Batch split every 1000 numbers (WATI limit)
    if (i !== 0 && i % 1000 === 0) {
      batchList.push(broadCast);
      broadCast = {
        broadcast_name: broadcastname + generateRandomId(),
        template_name: templatename,
        receivers: []
      };
    }

    broadCast['receivers'].push({
      whatsappNumber: formattedNumber,
      customParams: customParams
    });
  }

  if (batchList.length === 0 && broadCastData['numbers'].length !== 0) {
    batchList.push(broadCast);
  }

  console.log("Total batches:", batchList.length);
  console.log("First batch sample:", JSON.stringify(batchList[0]?.receivers?.[0]));

  let sentNumbers = [];
  let failedNumbers = [...numbersWithMissingCountryCode];

  // ── 6. Send all batches ───────────────────────────────────────────────
  for (let b = 0; b < batchList.length; b++) {
    const watiContent = batchList[b];
    const batchNumbers = watiContent.receivers.map(r => r.whatsappNumber);
    try {
      const response = await sendWatiTemplateMsg(watiContent, broadCastData);
      console.log(`Batch ${b + 1} sent (${watiContent['broadcast_name']}):`, response);

      if (response && response.result === true) {
        const errors = response.errors || {};
        const invalidWhatsapp = errors.invalidWhatsappNumbers || [];
        const invalidParams = errors.invalidCustomParameters || [];

        const invalidParamNumbers = invalidParams.map(msg => {
          const match = msg.match(/contact\s+(\d+)/);
          return match ? match[1] : null;
        }).filter(Boolean);

        // Combine all failed numbers for this batch
        const batchFailed = new Set([...invalidWhatsapp, ...invalidParamNumbers]);

        // Separate sent vs failed
        batchNumbers.forEach(num => {
          if (batchFailed.has(num)) {
            failedNumbers.push(num);
          } else {
            sentNumbers.push(num);
          }
        });
      } else {
        // response.result is not true — treat entire batch as failed
        failedNumbers.push(...batchNumbers);
      }

    } catch (error) {
      console.error(`Batch ${b + 1} failed (${watiContent['broadcast_name']}):`, error);
      failedNumbers.push(...batchNumbers);
    }
  }

  // ── 7. Update archive status ──────────────────────────────────────────

  const updatePayload = {
    status: 'sent',
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
    batchCount: batchList.length,
    totalSent: sentNumbers.length,
    totalFailed: failedNumbers.length,
  };

  if (sentNumbers.length > 0) {
    updatePayload.sent = sentNumbers;
  }
  if (failedNumbers.length > 0) {
    updatePayload.failed = failedNumbers;
  }

  await admin.firestore().collection('wati archive').doc(watiarchiveid).update(updatePayload).then(()=>{
    console.log('Wati Archive Updated Successfully',`Total Sent: ${sentNumbers.length}, Total Failed: ${failedNumbers.length},`);
  }).catch((error)=>{
    console.log('Error while updating wati Archive', error);
  });

  return {
    success: true,
    batchCount: batchList.length,
    totalRecipients: broadCastData['numbers'].length,
    paramFillMode: broadCastData['paramFillMode'],
    excelProcessed: hasExcelParams && !!broadCastData.excelFile,
    metadataUsed: hasMetadataParams
  };
}

function buildCustomParams(parameterConfig, profile, metadata, phoneNumber, excelParameterMap, excelFileMeta) {
  // If no parameterConfig saved (legacy broadcast), fall back to old behaviour
  if (!parameterConfig || parameterConfig.length === 0) {
    return getLegacyParams(profile, phoneNumber, excelParameterMap);
  }

  const customParams = [];

  for (const param of parameterConfig) {
    let value = '';

    switch (param.fillType) {

      case 'static':
        // Use the fixed value saved at compose time
        value = param.staticValue || '';
        console.log(`[static] ${param.name} = "${value}"`);
        break;

      case 'metadata':
        // Fetch from participant metadata collection using saved field key
        if (param.metadataField && metadata[param.metadataField] !== undefined) {
          value = metadata[param.metadataField]?.toString().trim() || '';
          console.log(`[metadata] ${param.name} = "${value}" (field: ${param.metadataField})`);
        } else {
          // Fallback: try profile_data field with same name
          value = profile[param.metadataField]?.toString().trim() || profile[param.name]?.toString().trim() || '';
          console.warn(`[metadata] ${param.name}: field "${param.metadataField}" not found in metadata, fallback="${value}"`);
        }
        break;

      case 'excel': {
        const cleanedPhone = cleanPhoneNumber(phoneNumber);
        const excelRow = excelParameterMap[cleanedPhone] || {};

        const columnKey = param.excelColumn?.trim().toLowerCase();

        if (columnKey && excelRow[columnKey] !== undefined) {
          value = excelRow[columnKey]?.toString().trim() || '';
        } else {
          value = profile[param.name]?.toString().trim() || '';
          console.warn(`[excel] Column "${param.excelColumn}" not found for ${cleanedPhone}`);
        }
        break;
      }

      default:
        console.warn(`Unknown fillType "${param.fillType}" for param "${param.name}"`);
        value = profile[param.name]?.toString().trim() || '';
        break;
    }

    // Final safety fallback — WATI rejects empty param values
    if (!value) {
      if (param.name.toLowerCase() === 'name') {
        value = profile.name || profile.displayName || 'Valued Customer';
      } else {
        value = `[${param.name}]`;
        console.warn(`Empty value for param "${param.name}" on number ${phoneNumber}, using placeholder`);
      }
    }

    customParams.push({ name: param.name, value });
  }

  return customParams;
}

async function loadParticipantMetadata(profileIds, mapMetadata) {
  if (!profileIds || profileIds.length === 0) return;

  // Firestore 'in' query supports max 30 per call — chunk them
  const chunkSize = 30;
  const chunks = [];
  for (let i = 0; i < profileIds.length; i += chunkSize) {
    chunks.push(profileIds.slice(i, i + chunkSize));
  }

  for (const chunk of chunks) {
    try {
      // participant metadata docs are keyed by profileId
      const snap = await admin.firestore()
        .collection('participant metadata')
        .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
        .get();

      snap.docs.forEach(doc => {
        mapMetadata[doc.id] = doc.data();
      });
    } catch (err) {
      console.error("Error loading participant metadata chunk:", err);
    }
  }

  console.log("Loaded metadata for", Object.keys(mapMetadata).length, "profiles");
}


async function processExcelFile(downloadUrl, savedHeaders) {
  try {
    console.log("Fetching Excel file from:", downloadUrl);

    const response = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const workbook   = XLSX.read(response.data, { type: 'buffer' });
    const worksheet  = workbook.Sheets[workbook.SheetNames[0]];
    const jsonData   = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

    if (jsonData.length < 2) {
      console.log("Excel file has no data rows");
      return {};
    }

    const headers  = jsonData[0];
    const dataRows = jsonData.slice(1);

    console.log("Excel headers:", headers);
    console.log("Excel data rows:", dataRows.length);

    const phoneColIdx = findPhoneColumnIndex(headers);
    if (phoneColIdx === -1) {
      console.log("No phone number column found in Excel");
      return {};
    }

    const parameterMap = {};

    dataRows.forEach(row => {
      const phoneNumber = cleanPhoneNumber(row[phoneColIdx]);
      if (!phoneNumber) return;

      const rowParams = {};
      headers.forEach((header, idx) => {
        const cellValue = row[idx];
        if (cellValue !== undefined && cellValue !== null && cellValue !== '') {
          // Store under original header name (preserving case) so it matches excelColumn saved in parameterConfig
          rowParams[header.toString()] = cellValue.toString().trim();
        }
      });

      parameterMap[phoneNumber] = rowParams;
    });

    console.log("Excel parameter map built for", Object.keys(parameterMap).length, "numbers");
    return parameterMap;

  } catch (error) {
    console.error("Error processing Excel file:", error);
    return {};
  }
}

// ────────────────────────────────────────────────────────────────────────────
// getLegacyParams
// Backward-compatible fallback for old broadcasts that have no parameterConfig.
// Uses the old broadCastData['params'] array + profile + Excel priority logic.
// ────────────────────────────────────────────────────────────────────────────
function getLegacyParams(profile, phoneNumber, excelParameterMap) {
  const customParams = [];
  const excelRow = excelParameterMap[phoneNumber] || {};

  // Legacy: params was just an array of param names
  const legacyParamNames = Object.keys(excelRow).length > 0
    ? Object.keys(excelRow)
    : ['name'];

  legacyParamNames.forEach(paramName => {
    let value = '';

    if (excelRow[paramName] !== undefined) {
      value = excelRow[paramName];
    } else if (profile[paramName] !== undefined) {
      value = profile[paramName].toString().trim();
    } else if (paramName.toLowerCase() === 'name') {
      value = profile.name || profile.displayName || 'Valued Customer';
    } else {
      value = `${paramName}`;
    }

    customParams.push({ name: paramName, value });
  });

  return customParams;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findPhoneColumnIndex(headers) {
  const phoneHeaders = ['phone', 'number', 'mobile', 'contact', 'phonenumber', 'phone_number'];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]?.toString().toLowerCase().trim();
    if (phoneHeaders.some(ph => h?.includes(ph))) return i;
  }
  return -1;
}

function cleanPhoneNumber(phone) {
  if (!phone) return '';
  let cleaned = phone.toString().replace(/[^\d+]/g, '');
  if (!cleaned.startsWith('+') && cleaned.length === 10) {
    cleaned = '+91' + cleaned;
  }
  return cleaned;
}

function generateRandomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ── sendWatiTemplateMsg (unchanged) ──────────────────────────────────────────

async function sendWatiTemplateMsg(body, broadcastData) {
  console.log('BODY',body);
  console.log('BROADCAST DATA',broadcastData);
  
  var apikey = null;

  await admin.firestore().collection('classify').doc('wati').get().then((wati) => {
    if (wati.exists) {
      apikey = wati.data()[broadcastData['serverid']]['watitoken'];
    }
  });

  if (apikey != null) {
    const WATI_API_URL = `${broadcastData['serverurl']}/api/v1/sendTemplateMessages`;
    const headers = {
      'Authorization': `Bearer ${apikey.trim()}`,
      'Content-Type': 'application/json'
    };

    try {
      const response = await axios.post(WATI_API_URL, body, { headers });
      console.log('Message sent successfully:', response.data);
      return response.data;
    } catch (error) {
      console.error('Error sending message:', error.response?.data || error.message);
      throw new Error('Failed to send WATI template message');
    }
  } else {
    throw new Error(`No API key found for server: ${broadcastData['serverurl']}`);
  }
}

// ── Cloud Function trigger (unchanged entry point) ────────────────────────────
exports.sendWhatsAppBroadcastCreated = onDocumentCreated(
  { document: 'wati archive/{docid}', region: 'us-central1', cors: true },
  async (change, context) => {
    const broadcastData = change.data?.data();
    console.log("BROADCASTDATA status:", broadcastData['status']);

    if (broadcastData['status'] === 'scheduled') {
      // ── Schedule via WATI API instead of sending immediately ──
      console.log("Scheduled broadcast detected — calling WATI schedule API");
      await sendWatiScheduledBroadcast(broadcastData['docid']);
    } else if (broadcastData['validated'] == true && broadcastData['status'] !== 'queued') {
      // ── Normal immediate send ──
      await sendWatiBroadCast(broadcastData['docid']);
    } else {
      console.log(`Skipping: status="${broadcastData['status']}", validated=${broadcastData['validated']}`);
    }
  }
);

async function sendWatiScheduledBroadcast(watiarchiveid) {

  let broadCastData = {};
  let mapProfile = {};
  let mapMetadata = {};
  let excelParameterMap = {};

  // ── 1. Fetch archive document ──────────────────────────────────────
  const archiveSnap = await admin.firestore().collection('wati archive').doc(watiarchiveid).get();
  broadCastData = archiveSnap.data();

  const templatename  = broadCastData['watitemplateid'];
  const broadcastname = broadCastData['broadcastname'];
  const scheduledISO  = broadCastData['scheduledDateISO'];

  console.log("=== SCHEDULE BROADCAST START ===");
  console.log("Archive ID:", watiarchiveid);
  console.log("Template:", templatename);
  console.log("Scheduled for:", scheduledISO);

  // ── 2. Process Excel file if needed ────────────────────────────────
  const hasExcelParams = (broadCastData['parameterConfig'] || []).some(p => p.fillType === 'excel');
  if (hasExcelParams && broadCastData.excelFile && broadCastData.excelFile.downloadUrl) {
    console.log("Processing Excel:", broadCastData.excelFile.originalName);
    excelParameterMap = await processExcelFile(
      broadCastData.excelFile.downloadUrl,
      broadCastData.excelFile.headers || []
    );
  }

  // ── 3. Load profile_data ───────────────────────────────────────────
  const profileSnap = await admin.firestore().collection("profile_data").orderBy("name", "asc").get();
  profileSnap.docs.forEach(doc => { mapProfile[doc.id] = doc.data(); });

  // ── 4. Load participant metadata if needed ─────────────────────────
  const hasMetadataParams = (broadCastData['parameterConfig'] || []).some(p => p.fillType === 'metadata');
  if (hasMetadataParams) {
    await loadParticipantMetadata(broadCastData['profileid'] || [], mapMetadata);
  }

  // ── 5. Get WATI API key ────────────────────────────────────────────
  const watiDoc = await admin.firestore().collection('classify').doc('wati').get();
  if (!watiDoc.exists) throw new Error('WATI configuration not found');

  const watiConfig   = watiDoc.data();
  const serverConfig = watiConfig[broadCastData['serverid']];
  if (!serverConfig) throw new Error(`No config for server: ${broadCastData['serverid']}`);

  const apiKey = serverConfig['watitoken'];
  if (!apiKey) throw new Error(`No API key for server: ${broadCastData['serverid']}`);

  // ── 6. Build receivers array ───────────────────────────────────────
  const receivers = [];

  for (let i = 0; i < broadCastData['numbers'].length; i++) {
    const number    = broadCastData['numbers'][i];
    const profileId = broadCastData['numbermap'][number];
    const profile   = mapProfile[profileId] || {};
    const metadata  = mapMetadata[profileId] || {};

    const customParams = buildCustomParams(
      broadCastData['parameterConfig'] || [],
      profile, metadata, number,
      excelParameterMap,
      broadCastData['excelFile'] || null
    );

    // WATI v1 expects: { whatsappNumber, customParams: [{name, value}] }
    receivers.push({
      whatsappNumber: number,
      customParams: customParams,
    });
  }

  console.log("Total receivers:", receivers.length);
  console.log("First receiver sample:", JSON.stringify(receivers[0]));

  // ── 7. Build schedule payload (WATI v1 scheduleBroadcast format) ───
  const schedulePayload = {
    broadcastName: broadcastname + generateRandomId(),
    templateName: templatename,
    scheduledAt: new Date(scheduledISO).toISOString(),
    receivers: receivers,
  };

  console.log("Payload broadcastName:", schedulePayload.broadcastName);
  console.log("Payload templateName:", schedulePayload.templateName);
  console.log("Payload scheduledAt:", schedulePayload.scheduledAt);
  console.log("Payload receivers count:", schedulePayload.receivers.length);

  const SCHEDULE_URL = `${serverConfig['endpoint']}/api/v1/broadcast/scheduleBroadcast`;

  console.log("SCHEDULE_URL:", SCHEDULE_URL);
  console.log("Final URL:", SCHEDULE_URL);

  try {
    const response = await axios.request({
      method: 'POST',
      url: SCHEDULE_URL,
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
        'accept': 'application/json',
      },
      data: schedulePayload,
      timeout: 60000,
    });

    console.log("WATI Schedule response:", JSON.stringify(response.data));

    // ── 9. Update archive → sent ───────────────────────────────────
    await admin.firestore().collection('wati archive').doc(watiarchiveid).update({
      status: 'sent',
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      scheduleApiResponse: response.data || null,
      scheduleSentViaApi: true,
      scheduleUrl: SCHEDULE_URL,
      scheduledBroadcastName: schedulePayload.broadcastName,
      totalSent: broadCastData['numbers'].length,
      totalFailed: 0,
    });

    console.log("=== SCHEDULE SUCCESS ===");
    return {
      success: true,
      scheduled: true,
      scheduledTime: scheduledISO,
      broadcastName: schedulePayload.broadcastName,
      totalRecipients: broadCastData['numbers'].length,
    };

  } catch (error) {
    const errData   = error.response?.data;
    const errStatus = error.response?.status;
    const errMsg    = errData?.message || errData?.result || error.message || 'Unknown error';

    console.error("=== SCHEDULE FAILED ===");
    console.error("Status:", errStatus);
    console.error("Response:", JSON.stringify(errData));
    console.error("URL:", SCHEDULE_URL);
    console.error("Payload sent:", JSON.stringify(schedulePayload));

    await admin.firestore().collection('wati archive').doc(watiarchiveid).update({
      status: 'schedule_failed',
      scheduleError: {
        status: errStatus,
        message: errMsg,
        data: errData || null,
        url: SCHEDULE_URL,
      },
      scheduleFailedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    throw new Error(`WATI Schedule API failed (${errStatus}): ${errMsg}`);
  }
}

exports.sendWhatsAppBroadcast = onRequest({region: "us-central1", cors:true},async (req, res) => {
  console.log("Function triggered");
  console.log("Archive ID", req.body);
  const archiveid = req.body.archiveid;
  const result = await sendWatiBroadCast(archiveid);
  console.log('Finished sending to participants', result);
  res.send(result)
});


exports.watiResponseCapture = onRequest({region: "us-central1", cors:true},async (req, res) => {
  const queryData = req.query;
  let messageData = req.body;

  console.log("MESSAGE DATA", messageData);
  // await admin.firestore().collection("wati logs").where("id","==",messageData['id']).limit(1).get().then(async(watidoc)=>{
  //   if(watidoc.docs.length == 0){

      const docref = admin.firestore().collection("wati logs").doc();

        let selectedProfile;
        let mapProfile = {};
        let waId = "";

        if(![null,undefined,''].includes(messageData['waId'])){

          await admin.firestore().collection("profile_data").orderBy("name", "asc").get().then((profiledoc) => {
            if (!profiledoc.empty) {
              profiledoc.docs.some((profile) => {
                const data = profile.data();
                mapProfile[data['number']] = data;
                if (![null,undefined,''].includes(data['number']) && (typeof(data['number']) == 'string' ? data['number'] : data['number'].toString()).includes(messageData['waId'])) {
                  selectedProfile = data;
                  return true; // breaks the loop
                }
                return false;
              });
            }
          });

        }else{

          await admin.firestore().collection("wati logs").where("conversationId","==",messageData['conversationId']).where("eventType","in",['templateMessageSent_v2','sentMessageDELIVERED_v2','message']).get().then((watidoc)=>{
            if(watidoc.docs.length != 0){
              for (let i = 0; i < watidoc.docs.length; i++) {
                const wati = watidoc.docs[i];
                if(![null,undefined,''].includes(wati.data()['waId'])){
                  waId = wati.data()['waId'].startsWith("91") ? wati.data()['waId'].slice(2) : wati.data()['waId'];
                  console.log(waId);
                  
                  break;
                }else{
                  console.log("NO waID Found... :(");
                };
              }
            }
          });
        }

        console.log("SELECTED PROFILE",selectedProfile);
        
        messageData['watiName'] = [null,undefined,''].includes(queryData['watiName']) ? null : queryData['watiName'];
        messageData['watiId'] = [null,undefined,''].includes(queryData['watiId']) ? null : queryData['watiId'];
        messageData['docid'] = docref.id;
        messageData['date'] = admin.firestore.FieldValue.serverTimestamp();
        // if(messageData['type'] == 'image'){
        //   messageData['mediaUrl'] = await uploadImageFromUrl(messageData['data'],messageData['data'].split('images/')[1]);
        // }
        if([null,undefined,''].includes(messageData['waId'])){
          messageData['waId'] = waId;
        }

        console.log("UPLOADING DATA",messageData);
        let numberwithout91 = messageData['waId'].startsWith("91") ? messageData['waId'].slice(2) : messageData['waId'];
        if(![null,undefined].includes(numberwithout91)){
          await admin.firestore().collection('wati archive').where('numbers','array-contains',numberwithout91).orderBy('date','desc').limit(1).get().then(async (archive)=>{
            console.log('Total Archive Found',archive.docs.length);
            
            if(archive.docs.length != 0 && messageData['statusString'].toLowerCase() == 'sent'){
              for (let i = 0; i < archive.docs.length; i++) {
                const archiveDoc = archive.docs[i];
                if (!archiveDoc.data()['sent'].includes(numberwithout91)) {
                  
                  await archiveDoc.ref.update({
                    sent:admin.firestore.FieldValue.arrayUnion(numberwithout91),
                    pending:admin.firestore.FieldValue.arrayRemove(numberwithout91),
                  }).then(()=>{
                    console.log('Log Updated successfully');
                  }).catch((error)=>{
                    console.log('Error while Updating the log');
                  });

                }else{
                  console.log('NO Document to Update');
                }
              }
            } else if(archive.docs.length != 0 && messageData['statusString'].toLowerCase() == 'failed'){
              for (let i = 0; i < archive.docs.length; i++) {
                const archiveDoc = archive.docs[i];
                if (!archiveDoc.data()['failed'].includes(numberwithout91)) {
                  
                  await archiveDoc.ref.update({
                    failed:admin.firestore.FieldValue.arrayUnion(numberwithout91),
                    pending:admin.firestore.FieldValue.arrayRemove(numberwithout91),
                  }).then(()=>{
                    console.log('Log Updated successfully');
                  }).catch((error)=>{
                    console.log('Error while Updating the log');
                  });

                }else{
                  console.log('NO Document to Update');
                }
              }
            }
          });
        }
        
        await docref.set(messageData).then(()=>{
          console.log("MESSAGE CAPTURED : ", messageData['eventType']);
        }).catch((err)=>{
          console.log("Error : ", messageData['eventType']);
        });

        return res.status(200).send("OK");

  //   }else{
  //     console.log("Document Exist");
  //     res.status(200).send("OK");
  //   }
  // });

});

// async function sendWatiBroadCast(watiarchiveid){

//   let templatename; 
//   let broadcastname;
//   let mapProfile = {};
//   let broadCastData = {};
//   let excelParameterMap = {}; // Map to store Excel data by phone number

//   await admin.firestore().collection('wati archive').doc(watiarchiveid).get().then((archive)=>{
//     templatename = archive.data()['watitemplateid'];
//     broadcastname = archive.data()['broadcastname'];
//     broadCastData = archive.data();
//   });

//   // Process Excel file if it exists
//   if (broadCastData.excelFile && broadCastData.excelFile.downloadUrl) {
//     console.log("Processing Excel file:", broadCastData.excelFile.originalName);
//     excelParameterMap = await processExcelFile(broadCastData.excelFile.downloadUrl);
//   }

//   await admin.firestore().collection("profile_data").orderBy("name","asc").get().then((profile)=>{
//     if(profile.docs.length != 0){          
//       for (let i = 0; i < profile.docs.length; i++) {
//         const profileDoc = profile.docs[i];
//         mapProfile[profileDoc.id] = profileDoc.data();
//       }
//     } else {
//       console.log("No profiles found");
//     }
//   });    

//   let broadCast = {
//     broadcast_name : broadcastname,
//     template_name : templatename,
//     receivers : []
//   }

//   let batchList = [];
//   broadCast['broadcast_name'] = broadcastname + generateRandomId();

//   for (let i = 0; i < broadCastData['numbers'].length; i++) {
//     const number = broadCastData['numbers'][i];
//     let profileId = broadCastData['numbermap'][number];
//     let profile = mapProfile[profileId] || {};

//     // Merge profile data with Excel data for this number
//     let combinedParams = getCombinedParameters(profile, number, excelParameterMap, broadCastData['params']);

//     if(i != 0 && i%1000 == 0){
//       batchList.push(broadCast);
//       broadCast = {
//         broadcast_name: broadcastname + generateRandomId(),
//         template_name: templatename,
//         receivers: []
//       };
//       broadCast['receivers'].push({
//         "whatsappNumber" : number,
//         "customParams" : combinedParams
//       });
//     } else {
//       broadCast['receivers'].push({
//         "whatsappNumber" : number,
//         "customParams" : combinedParams
//       });
//     }
//   }

//   if(batchList.length == 0 && broadCastData['numbers'].length != 0) {
//     batchList.push(broadCast);
//   }
  
//   console.log("BATCH",batchList[0]);
  
//   for (let b = 0; b < batchList.length; b++) {
//     const watiContent = batchList[b];        
//     try {
//       const response = await sendWatiTemplateMsg(watiContent, broadCastData);
//       console.log(`Message sent to ${watiContent['broadcast_name']}:`, response);
//     } catch (error) {
//       console.error(`Failed to send message to ${watiContent['broadcast_name']}:`, error);
//     }
//   }

//   // Update the archive document status
//   await admin.firestore().collection('wati archive').doc(watiarchiveid).update({
//     status: 'sent',
//     sentAt: admin.firestore.FieldValue.serverTimestamp(),
//     batchCount: batchList.length
//   });

//   return {
//     success: true,
//     batchCount: batchList.length,
//     totalRecipients: broadCastData['numbers'].length,
//     excelProcessed: !!broadCastData.excelFile
//   };
// }

// // Function to fetch and process Excel file
// async function processExcelFile(downloadUrl) {
//   try {
//     console.log("Fetching Excel file from:", downloadUrl);
    
//     // Download the Excel file
//     const response = await axios.get(downloadUrl, {
//       responseType: 'arraybuffer',
//       timeout: 30000 // 30 second timeout
//     });

//     // Parse the Excel file
//     const workbook = XLSX.read(response.data, { type: 'buffer' });
//     const firstSheetName = workbook.SheetNames[0];
//     const worksheet = workbook.Sheets[firstSheetName];
    
//     // Convert to JSON with header row
//     const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    
//     if (jsonData.length < 2) {
//       console.log("Excel file has no data rows");
//       return {};
//     }

//     const headers = jsonData[0];
//     const dataRows = jsonData.slice(1);
    
//     console.log("Excel headers:", headers);
//     console.log("Excel data rows count:", dataRows.length);

//     // Find phone number column index
//     const phoneColumnIndex = findPhoneColumnIndex(headers);
//     if (phoneColumnIndex === -1) {
//       console.log("No phone number column found in Excel");
//       return {};
//     }

//     // Create parameter map by phone number
//     const parameterMap = {};
    
//     dataRows.forEach(row => {
//       const phoneNumber = cleanPhoneNumber(row[phoneColumnIndex]);
//       if (phoneNumber) {
//         const rowParams = {};
        
//         // Map all columns except name, number, email to parameters
//         headers.forEach((header, index) => {
//           const normalizedHeader = header.toString().toLowerCase().trim();
//           const cellValue = row[index];
          
//           // Skip system fields: name, number, email, phone, mobile, contact
//           const skipFields = ['name', 'number', 'email', 'phone', 'mobile', 'contact', 'phonenumber', 'phone_number'];
          
//           if (!skipFields.includes(normalizedHeader) && 
//               cellValue !== undefined && 
//               cellValue !== null && 
//               cellValue !== '') {
//             // Use original header as parameter name (preserve case)
//             rowParams[header] = cellValue.toString().trim();
//           }
//         });
        
//         parameterMap[phoneNumber] = rowParams;
//       }
//     });

//     console.log("Excel parameter map created for", Object.keys(parameterMap).length, "numbers");
//     return parameterMap;

//   } catch (error) {
//     console.error("Error processing Excel file:", error);
//     return {};
//   }
// }

// // Function to find phone number column index
// function findPhoneColumnIndex(headers) {
//   const phoneHeaders = ['phone', 'number', 'mobile', 'contact', 'phonenumber', 'phone_number'];
  
//   for (let i = 0; i < headers.length; i++) {
//     const header = headers[i].toString().toLowerCase().trim();
//     if (phoneHeaders.some(ph => header.includes(ph))) {
//       return i;
//     }
//   }
//   return -1;
// }

// // Function to clean phone number (should match frontend logic)
// function cleanPhoneNumber(phone) {
//   if (!phone) return '';
  
//   // Remove all non-digit characters except +
//   let cleaned = phone.toString().replace(/[^\d+]/g, '');
  
//   // If no + at the beginning and number doesn't start with country code, add default country code
//   if (!cleaned.startsWith('+') && cleaned.length === 10) {
//     cleaned = '+91' + cleaned; // Assuming Indian numbers, adjust as needed
//   }
  
//   return cleaned;
// }

// // Function to combine profile parameters with Excel parameters
// function getCombinedParameters(profile, phoneNumber, excelParameterMap, templateParams) {
//   const combinedParams = [];
  
//   // Get Excel parameters for this phone number
//   const excelParams = excelParameterMap[phoneNumber] || {};
  
//   // Process each template parameter
//   templateParams.forEach(paramName => {
//     let paramValue = '';
    
//     // Priority: Excel data > Profile data
//     if (excelParams[paramName] !== undefined) {
//       paramValue = excelParams[paramName];
//       console.log(`Using Excel value for ${paramName}: ${paramValue}`);
//     } else if (profile[paramName] !== undefined && profile[paramName] !== null) {
//       paramValue = profile[paramName].toString().trim();
//       console.log(`Using profile value for ${paramName}: ${paramValue}`);
//     } else {
//       // Default fallback values
//       if (paramName.toLowerCase() === 'name') {
//         paramValue = profile.name || profile.displayName || 'Valued Customer';
//       } else {
//         paramValue = `[${paramName}]`; // Placeholder for missing parameters
//         console.log(`Missing parameter ${paramName} for number ${phoneNumber}`);
//       }
//     }
    
//     combinedParams.push({
//       name: paramName,
//       value: paramValue
//     });
//   });
  
//   return combinedParams;
// }

// function generateRandomId() {
//   const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
//   let randomId = '';
//   for (let i = 0; i < 4; i++) {
//     const randomIndex = Math.floor(Math.random() * characters.length);
//     randomId += characters[randomIndex];
//   }
//   return randomId;
// }

// async function sendWatiTemplateMsg(body,broadcastData) {

//   var apikey = null;

//   await admin.firestore().collection('classify').doc('wati').get().then((wati) => {
//     if(wati.exists) {
//       apikey = wati.data()['wati'].find((e)=>e['endpoint'] === broadcastData['serverurl'])['watitoken'];      
//     }
//   });
  
//   if(apikey != null){
//     const API_KEY = apikey;
//     const WATI_API_URL = `${broadcastData['serverurl']}/api/v1/sendTemplateMessages`
//     const headers = {
//       'Authorization': `Bearer ${API_KEY.trim()}`,
//       'Content-Type': 'application/json'
//     };

//     const data = body;
//     console.log('apikey',apikey);
//     console.log('WATI_API_URL',WATI_API_URL);
    
//     try {
//       const response = await axios.post(WATI_API_URL, data, { headers: headers });
//       console.log('Message sent successfully:', response.data);
//       return response.data;
//     } catch (error) {
//       console.error('Error sending message:', error.response);
//       throw new Error('Failed to send WATI template message');
//     }
//   }
// }

exports.slackLoginEvent = onDocumentCreated("loginlog/{docid}",async (change) => {
  const data = change.data.data()
  let url = null
  if(commonService.production === true){
    url = commonService.slackAppLogin
  }else{
    url = commonService.slackDevTest
  }
  if(url != null){
    const googleSheetsUrl = "https://script.google.com/a/macros/soexcellence.com/s/AKfycbxGoEUHufRqlcZEZ2hffcDYf07bnw9_Nr_Kmvz9qkNmcVcmdRTfCUkFoNKNjPgxUVAg/exec"
    await admin.firestore().collection("participant metadata").doc(data['profileid']).get().then(async profileSnap => {
      if(profileSnap.exists){
        var profileData = profileSnap.data()
        // Action Pending
        var actionPending = {
          forms: null,
          action: null
        }
        await admin.firestore().collection("appactionpending").doc(data['profileid']).get().then(async pending =>{
          if(pending.exists){
            var pendingData = pending.data()
            var forms = pendingData["formspending"] || []
            if((pendingData["mandatoryaction"] || []).length != 0) actionPending.action = pendingData["mandatoryaction"].join(", ")
            if(forms.length != 0){
              await admin.firestore().collection("delivery forms").where("docid", "in", forms.map(e => e.id)).get().then(forms=>{
                actionPending.forms = forms.docs.map(e => e.data()["formname"]).join(", ")
              })
            }
          }
        })
        // Map Product journey Tier
        var mapProduct = {}
        var mapJourney = {}
        var mapTier = {}
        await admin.firestore().collection("journey").get().then(async journeysnap => {
          for (let i = 0; i < journeysnap.docs.length; i++) {
            var journeyDoc = journeysnap.docs[i]
            const journeyelement = journeyDoc.data();
            mapJourney[journeyDoc.id] = journeyelement['journey']
          }
        });
        await admin.firestore().collection("products").get().then(async productsnap => {
          for (let i = 0; i < productsnap.docs.length; i++) {
            var productDoc = productsnap.docs[i]
            const productelement = productDoc.data();
            mapProduct[productDoc.id] = productelement['product']
          }
        });
        await admin.firestore().collection("tier").get().then(snap =>{
          for (let i = 0; i < snap.docs.length; i++) {
            var doc = snap.docs[i]
            const element = doc.data();
            mapTier[doc.id] = element['tier']
          }
        })
        // Map Big Level
        var bigLevel = profileData["mapatcmodeltobiglevel"] || {}
        var participantLevel = null
        if(Object.keys(bigLevel).length != 0){
          var mapLevel = {}
          await admin.firestore().collection("biglevel").get().then(level =>{
            level.docs.forEach(doc =>{
              var data = doc.data()
              mapLevel[doc.id] = data["level"]
            })
          })
          participantLevel = ""
          Object.keys(bigLevel).forEach(model =>{
            participantLevel = participantLevel + model + ` (${mapLevel[bigLevel[model]]}), `
          })
        }
        // Participant AEL
        var completedAEL = profileData["completedael"] || []
        var ongoingAEL = profileData["currentael"] || []
        var totalAEL = completedAEL.length + ongoingAEL.length
        var currentAEL = null
        if(ongoingAEL.length != 0){
          var metric = ongoingAEL[0]["crossovermetric"] || {}
          Object.keys(metric).forEach(category =>{
            currentAEL = currentAEL || ""
            currentAEL = currentAEL + category + ` (${metric[category]["startpoint"]} to ${metric[category]["endpoint"]}), `
          })
        }
        let message = {
          "blocks": [
            {
              "type": "header",
              "text": {
                "type": "plain_text",
                "text": `${profileData['name']}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Active Journey*: ${mapJourney[profileData["activejourney"]] || 'none'}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Active Products*: ${(profileData["activeproduct"] || []).map(e => mapProduct[e]).join(", ")}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Subscription End*: ${profileData["subscriptionend"] != null ? profileData["subscriptionend"].toDate() : "Unknown"}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Last Completed Journey*: ${mapJourney[profileData["lastcompletedjourney"]] || 'none'}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Last Completed Products*: ${(profileData["consumedproducts"] || []).map(e => mapProduct[e]).join(", ")}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Mode*: ${profileData['participantmode']}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*EiFlix Tier*: ${(profileData["tier"] || []).map(e => mapTier[e]).join(", ")}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Extended Impactful Year*: ${profileData["extendedlifeimpact"] || 'none'}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*B!G Level*: ${participantLevel || 'none'}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Saved Year*: ${profileData["evolutionyearsaved"] || 'none'}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Total Evolution Cycle*: ${totalAEL}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Current AEL*: ${currentAEL}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*App Launched*: ${data['date'].toDate()}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Version*: ${data["current_version"]}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Device Platform*: ${data["device_os"]}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Device INFO* - *Model*:  ${data["deviceinfo"]["model"] || 'unknown'}, *Brand*:  ${data["deviceinfo"]["brand"] || 'unknown'}`
              }
            },
          ]
        }
        if(actionPending.action){
          message.blocks.push({
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": `*Pending Action*: ${actionPending.action || 'none'}`
            }
          })
        }
        if(actionPending.forms){
          message.blocks.push({
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": `*Pending Forms*: ${actionPending.forms || 'none'}`
            }
          })
        }
        if(data["customersupport"]){
          message.blocks.push({
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": `*CustomerSupport Status*: ${data["customersupport"]}`
            }
          })
        }
        message.blocks.push({
          "type": "divider"
        })
        var webhook = new IncomingWebhook(url);
        webhook.send(message,function(err, header, statusCode, body) {
          if (err) {
            console.log('Error:', err);
          } else {
            console.log('Received', statusCode, 'from Slack');
          }
        });
        // Update Google Sheet
        const sheetData = {
          name: profileData['name'],
          activeJourney: mapJourney[profileData["activejourney"]] || "none",
          activeProducts: (profileData["activeproduct"] || []).map(e => mapProduct[e]).join(", "),
          subscriptionEnd: profileData["subscriptionend"] ? profileData["subscriptionend"].toDate() : "none",
          lastCompletedJourney: mapJourney[profileData["lastcompletedjourney"]] || "none",
          lastCompletedProducts: (profileData["consumedproducts"] || []).map(e => mapProduct[e]).join(", "),
          participantMode: profileData['participantmode'],
          eiFlixTier: (profileData["tier"] || []).map(e => mapTier[e]).join(", "),
          extendedImpactfulYear: profileData["extendedlifeimpact"] || "none",
          bigLevel: participantLevel || "none",
          savedYear: profileData["evolutionyearsaved"] || "none",
          totalEvolutionCycle: totalAEL,
          currentAEL: currentAEL || "none",
          appLaunched: data['date'] ? data['date'].toDate() : "none",
          version: data["current_version"],
          devicePlatform: data["device_os"],
          deviceInfo: data["deviceinfo"] || {},
          pendingAction: actionPending.action || "none",
          pendingForms: actionPending.forms || "none",
          customerSupport: data["customersupport"] || "none"
        };
        console.log("sheet data console",sheetData);
        await fetch(googleSheetsUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sheetData),
        });
      }else {
        console.log("profile data doc not found");
      }
    });
  }
});

// Group Chat Notification
exports.ChatxNotification = onDocumentCreated("supportchat/{chatid}/messages/{msgid}", async (snapshot)=>{
  console.log(snapshot.data.ref.path);
  var chatid = snapshot.params.chatid;
  var messageData = snapshot.data.data();
  var sender_uid = messageData["sender_uid"];

  console.log("Message Data", messageData);

  var sender_name = null;
  
  await admin.firestore().collection("profile_data").where("user_ref", "==", admin.firestore().collection("user_data").doc(sender_uid)).get().then(userData =>{
    if(userData.docs.length != 0){
      sender_name = userData.docs[0].data()["name"]
    }
  });
  // var sender_name = await (await admin.firestore().collection("profile_data").where("user_ref", "==", admin.firestore().collection("user_data").doc(sender_uid)).get()).docs[0].data().name
  console.log(sender_name)
  console.log(sender_uid)
  var message = messageData["message"]
  var pending_user = messageData["pending"]
  var readby_user = messageData["read_by"]
  var time = messageData["time"].toDate()

  const mentions = message.match(/@\w+/g);
  console.log("Mentions", mentions);

  if((mentions || []).length != 0){
    var mentionMap = {}
    var profileID = []
    for (let i = 0; i < mentions.length; i++) {
      const profilemention = mentions[i];
      profileID.push(profilemention.slice(1))
    }
    console.log("Mentioned ProfileID", profileID);
    for (let a = 0; a < profileID.length; a+=10) {
      await admin.firestore().collection("profile_data").where("profileid", "in", profileID.slice(a, a+10)).get().then(list =>{
        list.docs.forEach(doc =>{
          var data = doc.data()
          mentionMap["@"+doc.id] = "@"+data["name"]
        })
      })
    }
    console.log("Mention Map", mentionMap)
    const replacedText = message.replace(/@\w+/g, match => {
      return mentionMap[match] || match; // Replace if found, else keep original
    });
    message = replacedText
  }

  console.log("message", message)

  // Update Last Chat data
  var chatMeta = {
    last_message: message,
    last_pending: pending_user,
    last_read_by: readby_user,
    last_sender_uid: sender_uid,
    last_modification: time,
  }

  await admin.firestore().collection("supportchat").doc(chatid).update(chatMeta).catch(e =>{
    console.log("Chat meta Error", e)
  });
  var chat_type = (await admin.firestore().collection("supportchat").doc(chatid).get()).data().type

  if(chat_type == "group"){
    var supportChatDocSnap = await admin.firestore().collection("supportchat").doc(chatid).get();
    var supportChatData = supportChatDocSnap.data();
    var group_name = supportChatData.group_name;
    var profileToSend = []
    for (let i = 0; i < pending_user.length; i+=10) {
      var userRef = pending_user.slice(i, i+10).map(e => admin.firestore().collection("user_data").doc(e))
      await admin.firestore().collection("profile_data").where("user_ref", "in", userRef).get().then(async (profile)=>{
        profile.forEach(doc=>{
          if(!profileToSend.includes(doc.id)) profileToSend.push(doc.id)
        })
      })
    }

    await commonService.saveNotificationRecord({
      title: `New message in ${group_name}`,
      message: `${sender_name}: ${message}`,
      subtitle: null,
      date: admin.firestore.FieldValue.serverTimestamp(),
      landingpage: null,
      logged: false,
      profileid: profileToSend,
      sticky: false,
      notificationtype: "groupchat",
      notificationimage: null,
      metadata: {
        "type" : "chatx",
        "chatType": "group",
        "groupname":group_name,
        "groupprofile":supportChatData.group_profile,
        "click_action": "FLUTTER_NOTIFICATION_CLICK",
        "messageRef": supportChatData.id,
        "groupref": supportChatData.id,
      }
    });
  }
});

// exports.createTwilioWhatsAppTemplate = onDocumentCreated('twilio_templates/{docid}',async (event) => {
//     const templateData = event.data?.data();
//     const templateId = event.params.templateId;

//     try {
//       console.log(`Processing new template: ${templateId}`);

//       // Validate required fields
//       if (!templateData.name || !templateData.body) {
//         throw new Error('Template name and body are required');
//       }

//       // Build template components based on document structure
//       const components = buildTemplateComponents(templateData);

//       // Submit template to Twilio Content API
//       const twilioTemplate = await twilioClient.content.v1.contents.create({
//         friendlyName: templateData.name,
//         language: templateData.language || 'en',
//         variables: extractVariables(templateData),
//         types: {
//           'twilio/whatsapp': {
//             components: components
//           }
//         }
//       });

//       // Update Firestore document with Twilio response
//       await event.data.ref.update({
//         twilioContentSid: twilioTemplate.sid,
//         submissionStatus: 'submitted',
//         submittedAt: admin.firestore.FieldValue.serverTimestamp(),
//         approvalStatus: 'pending',
//         lastUpdated: admin.firestore.FieldValue.serverTimestamp()
//       });

//       console.log(`Template submitted to Twilio: ${twilioTemplate.sid}`);

//       // Log the submission
//       await admin.firestore().collection('template_logs').add({
//         templateId,
//         twilioContentSid: twilioTemplate.sid,
//         action: 'submitted',
//         status: 'success',
//         timestamp: admin.firestore.FieldValue.serverTimestamp()
//       });

//     } catch (error) {
//       console.error(`Error creating Twilio template for ${templateId}:`, error);

//       // Update document with error status
//       await event.data.ref.update({
//         submissionStatus: 'failed',
//         error: error.message,
//         lastUpdated: admin.firestore.FieldValue.serverTimestamp()
//       });

//       // Log the error
//       await admin.firestore().collection('template_logs').add({
//         templateId,
//         action: 'submission_failed',
//         error: error.message,
//         timestamp: admin.firestore.FieldValue.serverTimestamp()
//       });
//     }
//   }
// );

// function buildTemplateComponents(templateData) {
//   const components = [];

//   // Add header component if provided
//   if (templateData.header) {
//     if (templateData.header.type === 'IMAGE') {
//       components.push({
//         type: 'HEADER',
//         format: 'IMAGE',
//         example: {
//           header_handle: [templateData.header.example_url || 'https://example.com/image.jpg']
//         }
//       });
//     } else if (templateData.header.type === 'VIDEO') {
//       components.push({
//         type: 'HEADER',
//         format: 'VIDEO',
//         example: {
//           header_handle: [templateData.header.example_url || 'https://example.com/video.mp4']
//         }
//       });
//     } else {
//       // Text header
//       components.push({
//         type: 'HEADER',
//         format: 'TEXT',
//         text: templateData.header.text || templateData.header
//       });
//     }
//   }

//   // Add body component (required)
//   const bodyComponent = {
//     type: 'BODY',
//     text: templateData.body
//   };

//   // Add examples for variables if provided
//   if (templateData.examples && templateData.examples.length > 0) {
//     bodyComponent.example = {
//       body_text: templateData.examples
//     };
//   }

//   components.push(bodyComponent);

//   // Add footer component if provided
//   if (templateData.footer) {
//     components.push({
//       type: 'FOOTER',
//       text: templateData.footer
//     });
//   }

//   // Add buttons if provided
//   if (templateData.buttons && templateData.buttons.length > 0) {
//     const buttonComponent = {
//       type: 'BUTTONS',
//       buttons: templateData.buttons.map(button => {
//         if (button.type === 'URL') {
//           return {
//             type: 'URL',
//             text: button.text,
//             url: button.url,
//             example: button.example_url ? [button.example_url] : undefined
//           };
//         } else if (button.type === 'PHONE_NUMBER') {
//           return {
//             type: 'PHONE_NUMBER',
//             text: button.text,
//             phone_number: button.phone_number
//           };
//         } else if (button.type === 'QUICK_REPLY') {
//           return {
//             type: 'QUICK_REPLY',
//             text: button.text
//           };
//         }
//         return button;
//       })
//     };
//     components.push(buttonComponent);
//   }

//   return components;
// }

// /**
//  * Extract variables from template content
//  */
// function extractVariables(templateData) {
//   const variables = {};
  
//   // Extract from body
//   const bodyMatches = templateData.body.match(/\{\{(\d+)\}\}/g);
//   if (bodyMatches) {
//     bodyMatches.forEach(match => {
//       const number = match.match(/\d+/)[0];
//       variables[number] = templateData.variableNames?.[number] || `Variable${number}`;
//     });
//   }

//   // Extract from header if text
//   if (templateData.header && typeof templateData.header === 'string') {
//     const headerMatches = templateData.header.match(/\{\{(\d+)\}\}/g);
//     if (headerMatches) {
//       headerMatches.forEach(match => {
//         const number = match.match(/\d+/)[0];
//         variables[number] = templateData.variableNames?.[number] || `Variable${number}`;
//       });
//     }
//   }

//   return variables;
// }


// exports.sendValidationMail = onRequest({region: "us-central1", cors:true},async (req, res) => {
//     try {
//       const dataArray = req.body.data;
//       console.log('Request',req.body.data);
      
//       if (!dataArray || !Array.isArray(dataArray)) {
//         return res.status(400).send('Invalid data format');
//       }
      
//       const info = await commonService.postmarkClient.sendEmailBatchWithTemplates(dataArray);
//       console.log("Mail sent successfully:", info);
      
//       if(info.filter((e)=>![null,undefined,''].includes(e['ErrorCode']))){
//         return res.status(200).json({
//           success: false,
//           message: info[0]['Message'] == 'OK' ? 'Email Sent Successfully' : info[0]['Message']
//         });
//       }else{
//         return res.status(200).json({
//           success: true,
//           message: "Mail Sent Successfully"
//         });
//       }

//     } catch (error) {
//       console.error('Error:', error);
//       return res.status(500).json({
//         success: false,
//         error: error.message
//       });
//     }
// });

//workshop
  async function getProfileData(profileId) {
    if (!profileId) {
      console.log("No profileId provided");
      return null;
    }
    const db = admin.firestore();
    let profileSnap = await db.collection("profile_data").doc(profileId).get();
    if (profileSnap.exists) {
      return profileSnap.data();
    }
    let newUserSnap = await db.collection("new_user_data").doc(profileId).get();
    if (newUserSnap.exists) {
      console.log("newUserSnap console",newUserSnap);
      // const data = newUserSnap.data()
      // data['number'] = data['phonenumber']
      return newUserSnap.data();
    }

    console.log("loggg", profileId);
    return null;
  }

  exports.workshopQandA = onDocumentCreated("workshopQA/{docid}", async (document) => {
    var snapshot = document.data;
    var data = snapshot.data();
    var question = data["question"];
    const profile = await getProfileData(data["profileid"]);
    if (!profile) return;
    const profilename = profile["name"];
    const workshopDoc = await admin.firestore().collection("workshopconfiguration").doc(data["workshopId"]).get();
    const workshopData = workshopDoc.data();
    const workshopname = workshopData["detailpage"]["title"];
    const slackChannel = workshopData["workshopactivitychannel"];
    // var profilename = (await admin.firestore().collection("profile_data").doc(data["profileid"]).get()).data()["name"];
    // var workshopname = (await admin.firestore().collection("workshopconfiguration").doc(data["workshopId"]).get()).data()["detailpage"]["title"];
    // var slackChannel = (await admin.firestore().collection("workshopconfiguration").doc(data["workshopId"]).get()).data()["workshopactivitychannel"];
    let url;
    if (slackChannel === 'workshop-subscriber-activity') {
      url = commonService.production
        ? commonService.slackWorkshopsubscribersactivity
        : commonService.slackDevTest;
    } else {
      url = commonService.production
        ? commonService.slackWorkshopQandA
        : commonService.slackDevTest;
    }
    // var url = commonService.production ? commonService.slackWorkshopQandA : commonService.slackDevTest;

    if (url != null) {
      var webhook = new commonService.IncomingWebhook(url);

      let message = "";

      if (data["replyid"] == null) {
        message = `🤔 *${profilename}* has asked a new question in *${workshopname}*:\n\n👉 *${question}* `;
      } else {
        const tagprofile = await getProfileData(data["tag"]);
        // var tagname = (await admin.firestore().collection("profile_data").doc(data["tag"]).get()).data()["name"];
        // Guard nulls: a self-reply has no `tag`, and a deleted parent has no data.
        var tagname = tagprofile ? tagprofile["name"] : "the discussion";
        const repliedDoc = await admin.firestore().collection("workshopQA").doc(data["replyid"]).get();
        var repliedformessage = repliedDoc.exists ? repliedDoc.data()["question"] : "";

        message = `💬 *${profilename}* replied to *${tagname}* in *${workshopname}*:\n\n📝 *${repliedformessage}*\n\n↪️ *${question}*`;
      }

      console.log(message.toString());

      webhook.send(message, function (err, header, statusCode, body) {
        if (err) {
          console.log("Error:", err);
        } else {
          console.log("Received", statusCode, "from Slack");
        }
      });
    }

    // ===== EiFlix push notifications (com.soe.eiflix only) =====
    // Mirror the Slack alert as an FCM push to the workshop's EiFlix participants.
    // Tokens live in the dedicated EIFLIX_FCM_token collection, so the sibling
    // app com.soe.launchyourlegacy (which writes to FCM_token) is never targeted.
    try {
      const authorId = data["profileid"];
      const isReply = data["replyid"] != null;

      // Resolve recipient profile ids.
      let recipientIds = [];
      if (isReply) {
        // A reply notifies just the thread: the question's author, the tagged
        // person, and everyone who replied in the thread — minus the author.
        const ids = new Set();
        const questionDoc = await admin.firestore().collection("workshopQA").doc(data["replyid"]).get();
        if (questionDoc.exists && questionDoc.data()["profileid"]) {
          ids.add(questionDoc.data()["profileid"]);
        }
        if (data["tag"]) {
          ids.add(data["tag"]);
        }
        const threadReplies = await admin.firestore().collection("workshopQA").where("replyid", "==", data["replyid"]).get();
        threadReplies.docs.forEach(d => { const p = d.data()["profileid"]; if (p) ids.add(p); });
        ids.delete(authorId);
        recipientIds = [...ids];
      } else {
        // A new question notifies every enrolled participant — minus the author.
        const enrolled = await admin.firestore().collection("workshop participant enrolled")
          .where("workshopref", "==", admin.firestore().collection("workshopconfiguration").doc(data["workshopId"])).get();
        const ids = new Set();
        enrolled.docs.forEach(d => { const p = d.data()["profileid"]; if (p && p !== authorId) ids.add(p); });
        recipientIds = [...ids];
      }

      if (recipientIds.length > 0) {
        // Collect active EiFlix FCM tokens for those profiles (batched 'in' by 30).
        const tokens = new Set();
        for (let i = 0; i < recipientIds.length; i += 30) {
          const refs = recipientIds.slice(i, i + 30).map(pid =>
            admin.firestore().collection("profile_data").doc(pid));
          const tokenSnap = await admin.firestore().collection("EIFLIX_FCM_token")
            .where("profile_ref", "in", refs).where("active", "==", true).get();
          tokenSnap.docs.forEach(t => { const id = t.data()["FCM_id"]; if (id) tokens.add(id); });
        }
        const tokenList = [...tokens];

        if (tokenList.length > 0) {
          const pushTitle = isReply ? `New reply in ${workshopname}` : `New question in ${workshopname}`;
          const pushBody = isReply ? `${profilename} replied: ${question}` : `${profilename}: ${question}`;
          const basePayload = {
            notification: { title: pushTitle, body: pushBody },
            data: {
              type: "workshop_qa",
              workshopId: `${data["workshopId"]}`,
              workshopTitle: `${workshopname}`,
              click_action: "FLUTTER_NOTIFICATION_CLICK",
            },
            android: { priority: "high", notification: { channelId: "eiflix_qa", sound: "default" } },
            apns: { payload: { aps: { sound: "default", badge: 1 } } },
          };
          // sendEachForMulticast accepts up to 500 tokens per call.
          for (let i = 0; i < tokenList.length; i += 500) {
            const batch = tokenList.slice(i, i + 500);
            await admin.messaging().sendEachForMulticast({ ...basePayload, tokens: batch })
              .then(res => console.log(`EiFlix Q&A push: ${res.successCount} sent, ${res.failureCount} failed`))
              .catch(err => console.log("EiFlix Q&A push send error:", err));
          }
        } else {
          console.log("EiFlix Q&A push: no active EIFLIX_FCM_token for recipients");
        }
      }
    } catch (pushErr) {
      console.log("EiFlix Q&A push failed:", pushErr);
    }
  });

  exports.workshopFormsSubmission = onDocumentCreated({document: "formsByClient/{docid}", database: "firestore-forms"}, async (document) => {
    var snapshot = document.data;
    var data = snapshot.data();
    if (data["workshopref"] == null) {
      console.log("workshopref is null or doesn't exist, skipping function execution");
      return;
    }
    var docid = data["docid"];
    var formname = data["formname"];
    var formid = data["formid"];
    const profile = await getProfileData(data["profileid"]);
    if (!profile) return;
    const profilename = profile["name"];
    // var profilename = (await admin.firestore().collection("profile_data").doc(data["profileid"]).get()).data()["name"];
    // var workshopTitle = (await admin.firestore().doc(data["workshopref"].path).get()).data()["detailpage"]["title"];
    // var url = commonService.production ? commonService.slackWorkshopQandA : commonService.slackDevTest;
    var url;
    // var workshopTitle = (await data["workshopref"].get()).data()["detailpage"]["title"];
    // let activeworkshop = (await data["workshopref"].get()).data()["active"];
    // // var url = commonService.production ? commonService.slackWorkshopQandA : commonService.slackDevTest;
    // const slackChannel = (await data["workshopref"].get()).data()["workshopactivitychannel"];
    // const workshopDoc = await data["workshopref"].get();
    const workshopDoc = await admin.firestore().doc(data["workshopref"].path).get();
    if (!workshopDoc.exists) {
      console.log(`Workshop document not found at path: ${data["workshopref"].path}, skipping.`);
      return;
    }
    const workshopData = workshopDoc.data();
    const workshopTitle = workshopData['detailpage']['title'] || "Unknown Workshop";
    const activeworkshop = workshopData['active'] || false;
    const slackChannel = workshopData['workshopactivitychannel'] || null;
    if (slackChannel === 'workshop-subscriber-activity') {
      url = commonService.production
        ? commonService.slackWorkshopsubscribersactivity
        : commonService.slackDevTest;
    } else {
      url = commonService.production
        ? commonService.slackWorkshopQandA
        : commonService.slackDevTest;
    }
    // var url =  commonService.slackDevTest;
    if (url != null) {
    // if (url != null && activeworkshop == true) {
      var webhook = new commonService.IncomingWebhook(url);
      var formUrl = commonService.production 
      ? `https://breakthroughs.app/formtemplate?id=${formid}&type=form&patchdata=formsByClient%2F${docid}`
      : `https://breakthroughs-test.web.app/formtemplate?id=${formid}&type=form&patchdata=formsByClient%2F${docid}`;
      let message = "";
      if (data["formassignment"] && data["formassignment"] === true) {
        message = `📝 *${profilename}* has submitted the assignment *${formname}* in *${workshopTitle}* workshop \n\n🔗 <${formUrl}|Click to view the assignment>`;
      } else {
        message = `📝 *${profilename}* has submitted a *${formname}* form in *${workshopTitle}* workshop \n\n🔗 <${formUrl}|Click to view the form>`;
      }
      // let message = `📝 *${profilename}* has submitted a *${formname}* form in *${workshopTitle}* workshop \n\n🔗 <${formUrl}|Click to view the form>`;
      console.log(message.toString());
      webhook.send(message, function (err, header, statusCode, body) {
        if (err) {
          console.log("Error:", err);
        } else {
          console.log("Received", statusCode, "from Slack");
        }
      });
    }
  });
  exports.workshopAssignment = onRequest(
    { cors: true },
    async (req, res) => {
      if (req.method !== 'POST') {
        res.status(405).send('Method Not Allowed');
        return;
      }

      try {
        const { message } = req.body;
        
      if (!message) {
        res.status(400).send('Message is required');
        return;
      }
      var url = commonService.production ? commonService.slackWorkshopQandA : commonService.slackDevTest;
      if (url != null) {
        var webhook = new commonService.IncomingWebhook(url);
        
        await new Promise((resolve, reject) => {
          webhook.send(message, function (err, header, statusCode, body) {
            if (err) {
              console.log("Error:", err);
              reject(err);
            } else {
              console.log("Received", statusCode, "from Slack");
              resolve();
            }
          });
        });
        
        res.status(200).json({ success: true, message: "Message sent successfully" });
      } else {
        res.status(500).json({ error: "Webhook URL not configured" });
      }
    } catch (error) {
      console.error("Slack webhook error:", error);
      res.status(500).json({ error: "Failed to send Slack message" });
    }
  }
);

exports.workshopprogressmessagev2 = onRequest({ 
  cors: true,
  timeoutSeconds: 300,
  memory: '512MiB'
}, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }
  const { type } = req.body;
  console.log("Request type:", type);
  if (type === 'mail') {
    const { subject, message, recipients } = req.body;
    console.log("Bulk email request:", { subject, recipientsCount: recipients?.length });

    if (!subject || !message || !recipients || !Array.isArray(recipients) || recipients.length === 0) {
      res.status(400).send("Missing required fields for bulk email send");
      return;
    }
    
    let successCount = 0;
    let failureCount = 0;
    const results = [];
    const errors = [];
    
    const sendEmailBulk = recipients.map(async (recipient) => {
      const { email, name } = recipient;

      if (!email || !name) {
        return { success: false, email, error: 'Missing required fields' };
      }

      try {

        await commonService.postmarkClient.sendEmailWithTemplate({
          From: "starlabs@excellenceinstallation.com",
          To: email,
          TemplateAlias: "workshopprogressmessage",
          TemplateModel: {
            name: name,
            subject: subject,
            message: message
          }
        });

        // var dataModel = {
        //   name: name,
        //   subject: subject,
        //   message: message
        // }
        // await commonService.createEmailArchiveDocument({
        //   emailData : dataModel,
        //   datamodel : dataModel,
        //   attachments : [],
        //   emailTo : [email],
        //   emailMap : [{[email] : }],
        //   fileURL : '',
        //   from:'starlabs@excellenceinstallation.com',
        //   notes : '',
        //   profileId : [],
        //   postmarkTemplateId: '42136886',
        //   templateAlias:'workshopprogressmessage'
        // });

        console.log(`Email sent to ${name} (${email})`);
        return { success: true, email, name };

      } catch (error) {
        console.error(`Failed to send email to ${email}:`, error);
        return {
          success: false,
          email,
          name,
          error: error.message || 'Unknown error'
        };
      }
    });
    
    const emailResult = await Promise.allSettled(sendEmailBulk);
    emailResult.forEach((result) => {
      if (result.status === 'fulfilled') {
        const value = result.value;
        results.push(value);
        if (value.success) {
          successCount++;
        } else {
          failureCount++;
          if (value.error) {
            errors.push(`${value.email}: ${value.error}`);
          }
        }
      } else {
        failureCount++;
        results.push({ success: false, error: result.reason });
        errors.push(`Unknown recipient: ${result.reason}`);
      }
    });

    console.log(`Bulk email send completed: ${successCount} success, ${failureCount} failed`);
    res.status(200).json({
      message: "Bulk email send completed",
      successCount,
      failureCount,
      totalProcessed: recipients.length,
      results: results,
      errors: errors
    });
  }
  
  else if (type === 'whatsapp') {
    const { templateName, participants, chunkInfo } = req.body;
    
    console.log("WhatsApp bulk request:", { 
      templateName, 
      participantsCount: participants?.length,
      chunkInfo 
    });

    if (!templateName || !participants || !Array.isArray(participants) || participants.length === 0) {
      res.status(400).json({
        message: "Missing required fields for WhatsApp bulk send",
        successCount: 0,
        failureCount: 0,
        totalProcessed: 0,
        errors: ["Missing templateName or participants"]
      });
      return;
    }

    var apikey = null;
    var serverid = null;
    await admin.firestore().collection("classify").doc("wati").get().then((wati) => {
      if(wati.exists) {
        const watiData = wati.data()[commonService.eventWatiServerId]
        apikey = watiData['watitoken'];
        serverid = commonService.eventWatiServerId;
      }
    })

    const WATI_BASE_URL = `https://live-mt-server.wati.io/${serverid}`;
    const WATI_API_TOKEN = apikey;

    const errors = [];
    let successCount = 0;
    let failureCount = 0;

    try {
      const validReceivers = [];
      const invalidParticipants = [];
      participants.forEach((participant, index) => {
        const phone = participant.phonenumber?.toString().trim();
        if (!phone || phone.length < 10) {
          invalidParticipants.push({
            index,
            name: participant.name,
            phone,
            reason: 'Invalid phone number format'
          });
          return;
        }

        validReceivers.push({
          whatsappNumber: phone,
          customParams: participant.customParams.map(param => ({
            name: param.name,
            value: param.value
          }))
        });
      });

      if (invalidParticipants.length > 0) {
        console.log('Invalid participants:', invalidParticipants);
        invalidParticipants.forEach(p => {
          errors.push(`Invalid phone for ${p.name}: ${p.phone || 'empty'}`);
        });
        failureCount += invalidParticipants.length;
      }

      if (validReceivers.length === 0) {
        res.status(200).json({
          message: "No valid recipients to send",
          successCount: 0,
          failureCount: participants.length,
          totalProcessed: participants.length,
          errors: errors
        });
        return;
      }

      const endpoint = `${WATI_BASE_URL}/api/v1/sendTemplateMessages`;
      
      const headers = {
        'Authorization': `Bearer ${WATI_API_TOKEN}`,
        'Content-Type': 'application/json-patch+json',
      };

      const broadcastName = chunkInfo 
        ? `Workshop_${Date.now()}_chunk${chunkInfo.chunkIndex}`
        : `Workshop_${Date.now()}`;

      const broadcastData = {
        template_name: templateName,
        broadcast_name: broadcastName,
        receivers: validReceivers
      };

      console.log('Sending broadcast:', {
        template_name: broadcastData.template_name,
        broadcast_name: broadcastData.broadcast_name,
        receiversCount: validReceivers.length,
        chunkInfo
      });
      let response;
      let retryCount = 0;
      const maxRetries = 2;

      while (retryCount <= maxRetries) {
        try {
          response = await axios.post(endpoint, broadcastData, { 
            headers,
            timeout: 60000
          });
          break;
        } catch (error) {
          retryCount++;
          if (error.response?.status === 429) {
            if (retryCount <= maxRetries) {
              console.log(`Rate limited, retrying in ${retryCount * 2} seconds...`);
              await new Promise(resolve => setTimeout(resolve, retryCount * 2000));
              continue;
            }
          }
          if ((error.response?.status === 401 || error.response?.status === 404) && retryCount === 1) {
            const endpointV2 = `${WATI_BASE_URL}/api/v2/sendTemplateMessages`;
            console.log('Trying v2 endpoint...');
            response = await axios.post(endpointV2, broadcastData, { 
              headers,
              timeout: 60000 
            });
            break;
          }
          
          if (retryCount > maxRetries) {
            throw error;
          }
        }
      }
      console.log('WATI Broadcast response:', JSON.stringify(response.data, null, 2));
      const watiResult = response.data;
      const watiErrors = [];
      if (watiResult.result === true || watiResult.result === 'true') {
        successCount += validReceivers.length;
      } else if (watiResult.result === false) {
        if (watiResult.invalidContacts && Array.isArray(watiResult.invalidContacts)) {
          watiResult.invalidContacts.forEach(contact => {
            failureCount++;
            const errorInfo = {
              phone: contact.whatsappNumber || contact.number || contact,
              name: contact.name || contact.contactName,
              reason: contact.reason || contact.error || 'Invalid contact'
            };
            watiErrors.push(errorInfo);
            errors.push(`${errorInfo.phone}: ${errorInfo.reason}`);
          });
          successCount += (validReceivers.length - watiResult.invalidContacts.length);
        }
        if (watiResult.failedMessages && Array.isArray(watiResult.failedMessages)) {
          watiResult.failedMessages.forEach(failed => {
            failureCount++;
            const errorInfo = {
              phone: failed.whatsappNumber || failed.number,
              name: failed.name || failed.contactName,
              reason: failed.reason || failed.failureReason || failed.error || 'Message failed'
            };
            watiErrors.push(errorInfo);
            errors.push(`${errorInfo.phone}: ${errorInfo.reason}`);
          });
        }
        if (watiResult.contacts && Array.isArray(watiResult.contacts)) {
          watiResult.contacts.forEach(contact => {
            if (contact.status === 'failed' || contact.status === 'error') {
              failureCount++;
              const errorInfo = {
                phone: contact.whatsappNumber || contact.number,
                name: contact.name,
                reason: contact.reason || contact.error || contact.statusMessage || 'Delivery failed'
              };
              watiErrors.push(errorInfo);
              errors.push(`${errorInfo.phone}: ${errorInfo.reason}`);
            } else {
              successCount++;
            }
          });
        }
        if (watiResult.errors && Array.isArray(watiResult.errors)) {
          watiResult.errors.forEach(err => {
            const errorInfo = {
              phone: err.whatsappNumber || err.number || err.phone,
              name: err.name || err.contactName,
              reason: err.message || err.reason || err.error || 'Unknown error'
            };
            watiErrors.push(errorInfo);
            errors.push(`${errorInfo.phone || 'Unknown'}: ${errorInfo.reason}`);
            failureCount++;
          });
        }
        if (watiErrors.length === 0 && failureCount === 0) {
          failureCount = validReceivers.length;
          const errorReason = watiResult.info || watiResult.message || watiResult.error || 'Broadcast failed';
          errors.push(`Broadcast failed: ${errorReason}`);
          watiErrors.push({
            phone: null,
            name: null,
            reason: errorReason
          });
        }
      } else {
        if (watiResult.data && watiResult.data.contacts) {
          watiResult.data.contacts.forEach(contact => {
            if (contact.status === 'failed' || contact.errorMessage) {
              failureCount++;
              const errorInfo = {
                phone: contact.whatsappNumber,
                name: contact.name,
                reason: contact.errorMessage || contact.reason || 'Delivery failed'
              };
              watiErrors.push(errorInfo);
              errors.push(`${errorInfo.phone}: ${errorInfo.reason}`);
            } else {
              successCount++;
            }
          });
        } else {
          successCount += validReceivers.length;
        }
      }
      const categorizedWatiErrors = watiErrors.map(err => {
        let errorType = 'unknown';
        const reasonLower = (err.reason || '').toLowerCase();
        
        if (reasonLower.includes('missing customer attributes') || 
            reasonLower.includes('custom attributes have not been set') ||
            reasonLower.includes('check contact information')) {
          errorType = 'attribute';
        } else if (reasonLower.includes('undeliverable') || 
                   reasonLower.includes('not on whatsapp') ||
                   reasonLower.includes('delivery failed')) {
          errorType = 'delivery';
        } else if (reasonLower.includes('invalid') || 
                   reasonLower.includes('phone number')) {
          errorType = 'validation';
        }
        
        return { ...err, errorType };
      });

      res.status(200).json({
        message: "Broadcast processed",
        broadcastName: broadcastName,
        templateName: templateName,
        successCount: successCount,
        failureCount: failureCount,
        totalProcessed: participants.length,
        validReceivers: validReceivers.length,
        invalidReceivers: invalidParticipants.length,
        chunkInfo: chunkInfo,
        errors: errors,
        watiErrors: categorizedWatiErrors,
        watiResponse: {
          result: watiResult.result,
          info: watiResult.info
        }
      });

    } catch (error) {
      console.error('Failed to send broadcast:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message
      });
      let errorMessage = error.message;
      if (error.response?.data) {
        if (typeof error.response.data === 'string') {
          errorMessage = error.response.data;
        } else if (error.response.data.message) {
          errorMessage = error.response.data.message;
        } else if (error.response.data.info) {
          errorMessage = error.response.data.info;
        }
      }

      errors.push(`API Error: ${errorMessage}`);
      
      res.status(200).json({
        message: "Broadcast failed",
        broadcastName: null,
        templateName: templateName,
        successCount: 0,
        failureCount: participants.length,
        totalProcessed: participants.length,
        chunkInfo: chunkInfo,
        errors: errors,
        errorDetails: {
          status: error.response?.status,
          message: errorMessage
        }
      });
    }
  }
  else {
    res.status(400).send("Invalid type");
  }
});

exports.workshopprogressmessage = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const { type } = req.body;
  console.log("Request type:", type);

  // Email - BULK 
  if (type === 'mail') {
    const { subject, message, recipients } = req.body;
    console.log("Bulk email request:", { subject, recipientsCount: recipients?.length });

    if (!subject || !message || !recipients || !Array.isArray(recipients) || recipients.length === 0) {
      res.status(400).send("Missing required fields for bulk email send");
      return;
    }
    let successCount = 0;
    let failureCount = 0;
    const results = [];
    const sendEmailBulk = recipients.map(async (recipient) => {
      const { email, name } = recipient;

      if (!email || !name) {
        return { success: false, email, error: 'Missing required fields' };
      }

      try {
        await commonService.postmarkClient.sendEmailWithTemplate({
          From: "starlabs@excellenceinstallation.com",
          To: email,
          TemplateAlias: "workshopprogressmessage",
          TemplateModel: {
            name: name,
            subject: subject,
            message: message
          }
        });

        // var dataModel = {
        //   name: name,
        //   subject: subject,
        //   message: message
        // }
        // await commonService.createEmailArchiveDocument({
        //   emailData : dataModel,
        //   datamodel : dataModel,
        //   attachments : [],
        //   emailTo : [email],
        //   emailMap : [{[email] : }],
        //   fileURL : '',
        //   from:'starlabs@excellenceinstallation.com',
        //   notes : '',
        //   profileId : [],
        //   postmarkTemplateId: '42136886',
        //   templateAlias:'workshopprogressmessage'
        // });

        console.log(`Email sent to ${name} (${email})`);
        return { success: true, email, name };

      } catch (error) {
        console.error(`Failed to send email to ${email}:`, error);
        return {
          success: false,
          email,
          name,
          error: error.message || 'Unknown error'
        };
      }
    });
    const emailResult = await Promise.allSettled(sendEmailBulk);
    emailResult.forEach((result) => {
      if (result.status === 'fulfilled') {
        const value = result.value;
        results.push(value);
        if (value.success) {
          successCount++;
        } else {
          failureCount++;
        }
      } else {
        failureCount++;
        results.push({ success: false, error: result.reason });
      }
    });

    console.log(`Bulk email send completed: ${successCount} success, ${failureCount} failed`);
    res.status(200).json({
      message: "Bulk email send completed",
      successCount,
      failureCount,
      totalProcessed: recipients.length,
      results: results
    });
  }
  else if (type === 'whatsapp') {
    const { templateName, participants } = req.body;
    console.log("WhatsApp bulk request:", { templateName, participantsCount: participants?.length });

    if (!templateName || !participants || !Array.isArray(participants) || participants.length === 0) {
      res.status(400).send("Missing required fields for WhatsApp bulk send");
      return;
    }

    var apikey = null;
    var serverid = null;
    await admin.firestore().collection("classify").doc("wati").get().then((wati) => {
      if(wati.exists) {
        const watiData = wati.data()[commonService.eventWatiServerId]
        apikey = watiData['watitoken'];
        serverid = commonService.eventWatiServerId;
      }
    })

    const WATI_BASE_URL = `https://live-mt-server.wati.io/${serverid}`;
    const WATI_API_TOKEN = apikey;


    try {
      let endpoint = `${WATI_BASE_URL}/api/v1/sendTemplateMessages`;
      
      const headers = {
        'Authorization': `Bearer ${WATI_API_TOKEN}`,
        'Content-Type': 'application/json-patch+json', 
      };

      const receivers = participants.map(participant => ({
        whatsappNumber: participant.phonenumber,
        customParams: participant.customParams.map(param => ({
          name: param.name,
          value: param.value
        }))
      }));

      const broadcastData = {
        template_name: templateName,
        broadcast_name: `Workshop Progress ${Date.now()}`,
        receivers: receivers
      };

      console.log('Attempting broadcast with endpoint:', endpoint);
      console.log('Broadcast data sample:', {
        template_name: broadcastData.template_name,
        broadcast_name: broadcastData.broadcast_name,
        receiversCount: receivers.length,
        firstReceiver: receivers[0]
      });
      
      let response;
      try {
        response = await axios.post(endpoint, broadcastData, { headers });
      } catch (error) {
        if (error.response?.status === 401 || error.response?.status === 404) {
          endpoint = `${WATI_BASE_URL}/api/v2/sendTemplateMessages`;
          response = await axios.post(endpoint, broadcastData, { headers });
        } else {
          throw error;
        }
      }
      
      console.log('Broadcast response:', response.data);

      // res.status(200).json({
      //   message: "Broadcast sent successfully",
      //   successCount: receivers.length,
      //   failureCount: 0,
      //   totalProcessed: participants.length,
      //   broadcastDetails: response.data
      // });
      res.status(200).json({
        message: "Broadcast sent successfully",
        broadcastName: broadcastData.broadcast_name,
        templateName: templateName,
        successCount: receivers.length,
        failureCount: 0,
        totalProcessed: participants.length,
        broadcastDetails: response.data
      });

    } catch (error) {
      console.error('Failed to send broadcast:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message
      });
      
      res.status(500).json({
        message: "Failed to send broadcast",
        error: error.response?.data || error.message,
        errorStatus: error.response?.status,
        successCount: 0,
        failureCount: participants.length,
        totalProcessed: participants.length
      });
    }
  }

  else {
    res.status(400).send("Invalid type");
  }
});


  exports.productenquiryfromeiflix = onDocumentCreated("productenquirylog/{docid}", async (document) => {
    var snapshot = document.data;
    var data = snapshot.data();
    var question = data["enquiry"];
    var product = data["product"];
    const profile = await getProfileData(data["profileid"]);
    if (!profile) return;
    const profilename = profile["name"];
    var url = commonService.production ? commonService.slackWorkshopQandA : commonService.slackDevTest;
    if (url != null) {
      var webhook = new commonService.IncomingWebhook(url);
      var message = `👤 *${profilename}* enquired | 📱 ${data["phone"]} | 🛒 ${product ?? "No Product"} | 💬 ${question}`;
      console.log(message.toString());

      webhook.send(message, function (err, header, statusCode, body) {
        if (err) {
          console.log("Error:", err);
        } else {
          console.log("Received", statusCode, "from Slack");
        }
      });
    }
  });

