const commonService = require('./service');
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require('firebase-admin');
const { Buffer } = require('buffer');
const axios = require('axios');
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getAuth } = require("firebase-admin/auth");
const { defineSecret } = require("firebase-functions/params");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
// const Razorpay = require("razorpay");
// const crypto = require("crypto");

// ── Secrets ───────────────────────────────────────────────────────────────
// Configure with: firebase functions:secrets:set RAZORPAY_KEY_ID
//                 firebase functions:secrets:set RAZORPAY_KEY_SECRET
// const RAZORPAY_KEY_ID = defineSecret("RAZORPAY_KEY_ID");
// const RAZORPAY_KEY_SECRET = defineSecret("RAZORPAY_KEY_SECRET");
// exports.workshopconfiguration = onDocumentUpdated(
//   {
//     document: "/workshopconfiguration/{docid}",
//     memory: "512MiB",
//     timeoutSeconds: 300
//   },
//   async (snapshotdata) => {
// // exports.workshopconfiguration = onDocumentUpdated("/workshopconfiguration/{docid}", async (snapshotdata) => {
//   var snapshot = snapshotdata.data;
//   var oldData = snapshot.before.data();
//   var newData = snapshot.after.data();
//   if (newData.triggerFunction !== true) return;
//   const db = admin.firestore();
//   try {
//     const workshopRef = snapshot.after.ref;
//     const changes = {};
//     for (const key of Object.keys(newData)) {
//       if (JSON.stringify(newData[key]) !== JSON.stringify(oldData[key])) {
//         changes[key] = newData[key];
//       }
//     }
//     if (Object.keys(changes).length === 0) {
//       console.log("No changes");
//       return;
//     }
//     const participantWorkshopdoc = await db.collection('participant workshop').where('workshopref', '==', workshopRef).get();
//     if (participantWorkshopdoc.empty) {
//       console.log("No participants found");
//       return;
//     }
//     const batch = db.batch();
//     participantWorkshopdoc.forEach(participantDoc => {
//       const participantData = participantDoc.data();
//       const finalChanges = { ...changes };
//       if (changes.challenges && participantData.challenges) {
//         const participantOuterMap = {};
//         (participantData.challenges || []).forEach(participantChallenge => {
//           if (participantChallenge.challengeid) {
//             participantOuterMap[participantChallenge.challengeid] = participantChallenge;
//           }
//         });
//         finalChanges.challenges = changes.challenges.map((workshopdoc) => {
//           const matchedParticipantItem = workshopdoc.challengeid ? (participantOuterMap[workshopdoc.challengeid] || null) : null;
//           const mergedItem = { ...workshopdoc };
//           if (matchedParticipantItem) {
//             Object.keys(matchedParticipantItem).forEach(key => {
//               if (key === 'challenges') return;
//               if (!(key in workshopdoc)) {
//                 mergedItem[key] = matchedParticipantItem[key];
//               }
//             });
//           }
//           if (workshopdoc.challenges && Array.isArray(workshopdoc.challenges)) {
//             const participantInnerMap = {};
//             ((matchedParticipantItem && matchedParticipantItem.challenges) || []).forEach(participantInnerChallenge => {
//               if (participantInnerChallenge.challengeid) {
//                 participantInnerMap[participantInnerChallenge.challengeid] = participantInnerChallenge;
//               }
//             });
//             const hasNewInnerChallenge = workshopdoc.challenges.some(workshopConfigChallenge =>
//               !workshopConfigChallenge.challengeid || !participantInnerMap[workshopConfigChallenge.challengeid]
//             );

//             if (hasNewInnerChallenge && mergedItem.status === 'completed') {
//               delete mergedItem.status;
//             }
//             mergedItem.challenges = workshopdoc.challenges.map((workshopConfigChallenge) => {
//               const matchedInner = workshopConfigChallenge.challengeid ? (participantInnerMap[workshopConfigChallenge.challengeid] || null) : null;
//               const mergedChallenge = { ...workshopConfigChallenge };
//               if (matchedInner) {
//                 Object.keys(matchedInner).forEach(key => {
//                   if (!(key in workshopConfigChallenge)) {
//                     mergedChallenge[key] = matchedInner[key];
//                   }
//                 });
//               }
//               return mergedChallenge;
//             });
//           }
//           return mergedItem;
//         });
//       }
//       batch.set(participantDoc.ref, finalChanges, { merge: true });
//     });

//     await batch.commit();
//     console.log('Updated');
//   } catch (error) {
//     console.error("Error:", error);
//   }
// });
// exports.workshopconfiguration = onDocumentUpdated(
//   {
//     document: "/workshopconfiguration/{docid}",
//     memory: "2GiB",
//     timeoutSeconds: 300
//   },
//   async (snapshotdata) => {
//     var snapshot = snapshotdata.data;
//     var oldData = snapshot.before.data();
//     var newData = snapshot.after.data();
//     if (newData.triggerFunction !== true) return;
//     const db = admin.firestore();

//     try {
//       const workshopRef = snapshot.after.ref;
//       const scalarChanges = {};
//       let challengesChanged = false;

//       for (const key of Object.keys(newData)) {
//         if (key === 'challenges') {
//           if (JSON.stringify(newData[key]) !== JSON.stringify(oldData[key])) {
//             challengesChanged = true;
//           }
//           continue;
//         }
//         if (JSON.stringify(newData[key]) !== JSON.stringify(oldData[key])) {
//           scalarChanges[key] = newData[key];
//         }
//       }

//       const hasScalarChanges = Object.keys(scalarChanges).length > 0;

//       if (!hasScalarChanges && !challengesChanged) {
//         console.log("No changes detected");
//         return;
//       }

//       const participantWorkshopdoc = await db
//         .collection('participant workshop')
//         .where('workshopref', '==', workshopRef)
//         .get();

//       if (participantWorkshopdoc.empty) {
//         console.log("No participants found");
//         return;
//       }

//       console.log(`Processing ${participantWorkshopdoc.size} participants`);
//       let successCount = 0;
//       let errorCount = 0;

//       const participantDocs = [];
//       participantWorkshopdoc.forEach(doc => participantDocs.push(doc));
//       const PARALLEL_BATCH = 10;

//       for (let i = 0; i < participantDocs.length; i += PARALLEL_BATCH) {
//         const slice = participantDocs.slice(i, i + PARALLEL_BATCH);

//         await Promise.all(slice.map(async (participantDoc) => {
//           try {
//             const participantData = participantDoc.data();
//             const updatePayload = {};
//             if (hasScalarChanges) {
//               Object.assign(updatePayload, scalarChanges);
//             }
//             if (challengesChanged && newData.challenges) {
//               const participantOuterMap = {};
//               (participantData.challenges || []).forEach(participantChallenge => {
//                 if (participantChallenge.challengeid) {
//                   participantOuterMap[participantChallenge.challengeid] = participantChallenge;
//                 }
//               });

//               const mergedChallenges = newData.challenges.map((workshopdoc) => {
//                 const matchedParticipantItem = workshopdoc.challengeid
//                   ? (participantOuterMap[workshopdoc.challengeid] || null)
//                   : null;
//                 const mergedItem = { ...workshopdoc };
//                 if (matchedParticipantItem) {
//                   Object.keys(matchedParticipantItem).forEach(key => {
//                     if (key === 'challenges') return;
//                     if (!(key in workshopdoc)) {
//                       mergedItem[key] = matchedParticipantItem[key];
//                     }
//                   });
//                 }
//                 if (workshopdoc.challenges && Array.isArray(workshopdoc.challenges)) {
//                   const participantInnerMap = {};
//                   ((matchedParticipantItem && matchedParticipantItem.challenges) || []).forEach(
//                     participantInnerChallenge => {
//                       if (participantInnerChallenge.challengeid) {
//                         participantInnerMap[participantInnerChallenge.challengeid] = participantInnerChallenge;
//                       }
//                     }
//                   );
//                   const hasNewInnerChallenge = workshopdoc.challenges.some(
//                     workshopConfigChallenge =>
//                       !workshopConfigChallenge.challengeid ||
//                       !participantInnerMap[workshopConfigChallenge.challengeid]
//                   );
//                   if (hasNewInnerChallenge && mergedItem.status === 'completed') {
//                     delete mergedItem.status;
//                   }

//                   mergedItem.challenges = workshopdoc.challenges.map((workshopConfigChallenge) => {
//                     const matchedInner = workshopConfigChallenge.challengeid
//                       ? (participantInnerMap[workshopConfigChallenge.challengeid] || null)
//                       : null;

//                     const mergedChallenge = { ...workshopConfigChallenge };
//                     if (matchedInner) {
//                       Object.keys(matchedInner).forEach(key => {
//                         if (!(key in workshopConfigChallenge)) {
//                           mergedChallenge[key] = matchedInner[key];
//                         }
//                       });
//                     }
//                     return mergedChallenge;
//                   });
//                 }

//                 return mergedItem;
//               });

//               updatePayload.challenges = mergedChallenges;
//             }
//             const payloadSize = JSON.stringify(updatePayload).length;
//             console.log(`Participant ${participantDoc.id}: payload ~${Math.round(payloadSize / 1024)}KB`);

//             if (payloadSize > 900000) {
//               console.error(`Participant ${participantDoc.id} payload too large (${payloadSize} bytes) — skipping. Consider moving challenges to a subcollection.`);
//               errorCount++;
//               return;
//             }
//             await participantDoc.ref.set(updatePayload, { merge: true });
//             successCount++;

//           } catch (err) {
//             console.error(`Failed to update participant ${participantDoc.id}:`, err.message);
//             errorCount++;
//           }
//         }));

//         console.log(`Progress: ${Math.min(i + PARALLEL_BATCH, participantDocs.length)}/${participantDocs.length}`);
//       }

//       console.log(`Done — ${successCount} updated, ${errorCount} failed`);

//     } catch (error) {
//       console.error("Fatal error:", error);
//     }
//   }
// );
exports.workshopconfiguration = onDocumentUpdated(
  {
    document: "/workshopconfiguration/{docid}",
    memory: "1GiB",
    timeoutSeconds: 300
  },
  async (snapshotdata) => {
    const snapshot = snapshotdata.data;
    const oldData = snapshot.before.data();
    const newData = snapshot.after.data();
    if (newData.triggerFunction !== true) return;
    const db = admin.firestore();
    try {
      const workshopRef = snapshot.after.ref;
      const scalarChanges = {};
      let challengesChanged = false;

      for (const key of Object.keys(newData)) {
        if (key === 'challenges') {
          if (JSON.stringify(newData[key]) !== JSON.stringify(oldData[key])) {
            challengesChanged = true;
          }
          continue;
        }
        if (JSON.stringify(newData[key]) !== JSON.stringify(oldData[key])) {
          scalarChanges[key] = newData[key];
        }
      }

      if (!Object.keys(scalarChanges).length && !challengesChanged) {
        console.log("No changes detected");
        return;
      }
      const participantSnapshot = await db
        .collection('participant workshop')
        .where('workshopref', '==', workshopRef)
        .get();

      if (participantSnapshot.empty) {
        console.log("No participants found");
        return;
      }
      const participantDocs = participantSnapshot.docs;
      console.log(`Processing ${participantDocs.length} participants`);
      const newChallengesMap = {};
      if (challengesChanged && newData.challenges) {
        newData.challenges.forEach(challenge => {
          if (challenge.challengeid) {
            newChallengesMap[challenge.challengeid] = challenge;
          }
        });
      }
      function buildMergedChallenges(participantData) {
        const participantOuterMap = {};
        (participantData.challenges || []).forEach(c => {
          if (c.challengeid) participantOuterMap[c.challengeid] = c;
        });

        return newData.challenges.map((workshopChallenge) => {
          const participantMatch = workshopChallenge.challengeid
            ? (participantOuterMap[workshopChallenge.challengeid] || null)
            : null;
          const mergedItem = { ...workshopChallenge };
          if (participantMatch) {
            Object.keys(participantMatch).forEach(key => {
              if (key === 'challenges') return;
              if (!(key in workshopChallenge)) {
                mergedItem[key] = participantMatch[key];
              }
            });
          }
          if (Array.isArray(workshopChallenge.challenges)) {
            const participantInnerMap = {};
            ((participantMatch && participantMatch.challenges) || []).forEach(inner => {
              if (inner.challengeid) participantInnerMap[inner.challengeid] = inner;
            });
            const hasNewInner = workshopChallenge.challenges.some(
              wc => !wc.challengeid || !participantInnerMap[wc.challengeid]
            );
            if (hasNewInner && mergedItem.status === 'completed') {
              delete mergedItem.status;
            }

            mergedItem.challenges = workshopChallenge.challenges.map((innerChallenge) => {
              const innerMatch = innerChallenge.challengeid
                ? (participantInnerMap[innerChallenge.challengeid] || null)
                : null;
              const mergedInner = { ...innerChallenge };
              if (innerMatch) {
                Object.keys(innerMatch).forEach(key => {
                  if (!(key in innerChallenge)) {
                    mergedInner[key] = innerMatch[key];
                  }
                });
              }
              return mergedInner;
            });
          }

          return mergedItem;
        });
      }
      const PARALLEL_BATCH = 25;
      let successCount = 0;
      let errorCount = 0;

      for (let i = 0; i < participantDocs.length; i += PARALLEL_BATCH) {
        const chunk = participantDocs.slice(i, i + PARALLEL_BATCH);

        await Promise.all(chunk.map(async (participantDoc) => {
          try {
            const participantData = participantDoc.data();
            const updatePayload = { ...scalarChanges };

            if (challengesChanged && newData.challenges) {
              updatePayload.challenges = buildMergedChallenges(participantData);
            }

            await participantDoc.ref.set(updatePayload, { merge: true });
            successCount++;
          } catch (err) {
            console.error(`Failed: ${participantDoc.id} — ${err.message}`);
            errorCount++;
          }
        }));

        console.log(`Progress: ${Math.min(i + PARALLEL_BATCH, participantDocs.length)}/${participantDocs.length}`);
      }

      console.log(`Done ${successCount} updated, ${errorCount} failed`);

    } catch (error) {
      console.error("Fatal error:", error);
    }
  }
);
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
async function sendWatiWorkshopMessage({ profileID, profileName, workshopName, workshopId, message }) {
  var apikey = null;
  var serverid = null;

  await admin.firestore().collection("classify").doc("eventwati").get().then((wati) => {
    if (wati.exists) {
      const watiData = wati.data();
      apikey = watiData['apikey'];
      serverid = watiData['serverid'];
    }
  });

  const WATI_BASE_URL = `https://live-mt-server.wati.io/${serverid}`;
  const WATI_API_TOKEN = apikey;

  const workshopurl = commonService.production
    ? `https://eiflix.com/workshop/${workshopId}`
    : `https://eiflix-workshop.web.app/workshop/${workshopId}`;

  const profileData = (await admin.firestore().collection("profile_data").doc(profileID).get()).data();
  const phonenumber = profileData['number'] ?? profileData['phonenumber'];

  const endpoint = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${phonenumber}`;
  const headers = {
    'Authorization': `Bearer ${WATI_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
  const data = {
    template_name: 'vantage__poin_confirmation_message',
    broadcast_name: 'Workshop Evergreen',
    parameters: [
      { name: 'name', value: profileName || '' },
      { name: 'message', value: workshopName },
      { name: '1', value: message },
      { name: '2', value: workshopurl },
      { name: '3', value: 'https://breakthroughs.app/home' },
    ]
  };

  console.log("endpoint", endpoint);
  console.log("data", data);

  const response = await axios.post(endpoint, data, { headers });
  console.log('Message sent successfully:', response.data);
  return response.data;
}
exports.workshopenrolledwatti = onDocumentCreated(
  "workshop participant enrolled/{docid}",
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
      console.log("No data, exiting.");
      return;
    }

    const newData = snapshot.data();

    try {
      const profile = await getProfileData(newData.profileid);
      if (!profile) return;
      // if (!newData['profileid']) {
      //   console.log("profileid not found"); 
      //   return;
      // }
      // const profileSnap = await admin.firestore()
      //   .collection("profile_data")
      //   .doc(newData['profileid'])
      //   .get();

      // if (!profileSnap.exists) {
      //   console.log("Profile not found for:", newData['profileid']);
      //   return;
      // }

      // const profile = profileSnap.data();
      console.log("Profile console for mobile number",profile);
      if (newData?.status === 'enrolled' || newData?.status === 'enrollednotstarted') {

      var apikey = null;
      var serverid = null;
      await admin.firestore().collection("classify").doc("eventwati").get().then((wati) => {
        if (wati.exists) {
          const watiData = wati.data();
          apikey = watiData['apikey'];
          serverid = watiData['serverid'];
        }
      })

        const WATI_BASE_URL = `https://live-mt-server.wati.io/${serverid}`;
        const WATI_API_TOKEN = apikey;
        let workshopName = "Workshop";
        let messageText = "";
        let workshopurl = "";
        let mailsubject = "";
        let maildescription = "";
        let mailliveCallText = "";
        let slackchannel = "";
        let categorybased = false;
        if (newData['workshopref']) {
          const workshopSnap = await newData['workshopref'].get();
          if (workshopSnap.exists) {
            const workshopData = workshopSnap.data();
            workshopName = workshopData?.detailpage?.title || "Workshop";
            messageText = workshopData?.enrollwattimessage || "";
            mailsubject = workshopData?.mailTemplate['subject'] || "";
            maildescription = workshopData?.mailTemplate['description'] || "";  
            mailliveCallText = workshopData?.mailTemplate['liveCallText'] || "";  
            categorybased = workshopData?.categorybased || false;
            slackchannel = workshopData?.workshopactivitychannel || null;
            workshopurl = commonService.production
              ? `https://eiflix.com/workshop/${workshopData?.docid}`
              : `https://eiflix-workshop.web.app/workshop/${workshopData?.docid}`;
          }
        }
        try {
          let url;
          if (slackchannel === 'workshop-subscriber-activity') {
            url = commonService.production ? commonService.slackWorkshopsubscribersactivity : commonService.slackDevTest;
          } else if (slackchannel === 'workshop-logs') {
            url = commonService.production ? commonService.slackWorkshopQandA : commonService.slackDevTest;
          }
          if (url) {
            const webhook = new commonService.IncomingWebhook(url);
            let message = `🚀 *${profile['name']}* just Enrolled *${workshopName}*! 🌱`;
            console.log(message);
            webhook.send(message, (err, header, statusCode, body) => {
              if (err) {
                console.error("Error", err);
              } else {
                console.log("Message sent", statusCode);
              }
            });
          } else {
            console.warn("Slack webhook URL not configured.");
          }
        } catch (error) {
          console.log(error,'enrolled slack error')
        }
        let phonenumber = profile['number'] ?? profile['phonenumber']
        const endpoint = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${phonenumber}`;
        const headers = {
          'Authorization': `Bearer ${WATI_API_TOKEN}`,
          'Content-Type': 'application/json',
        };

        const data = {
          template_name: 'eiflixworkshopv7',
          broadcast_name: 'Workshop Enrolled',
          parameters: [
            { name: 'name', value: profile['name'] || '' },
            { name: 'workshopname', value: workshopName },
            { name: 'link', value: workshopurl },
            { name: '1', value: messageText },
          ]
        };
        try {
          const templateAlias = categorybased ? "WorkshopEnrolledMessage1" : "WorkshopEnrolledMessage";
          const postmarktemplateId = categorybased ? '43859890' : '42135513';
          // await commonService.postmarkClient.sendEmailWithTemplate({
          //   From: "starlabs@excellenceinstallation.com",
          //   To: profile['email'],
          //   TemplateAlias: templateAlias,
          //   TemplateModel: {
          //     name: profile['name'],
          //     email: profile['email'],
          //     subject: mailsubject,
          //     workshopName:workshopName,
          //     maildescription : maildescription,
          //     mailliveCallText : mailliveCallText,
          //     workshopurl : workshopurl,
          //   },
          // });

          var dataModel = {
          name: profile['name'],
          email: profile['email'],
          subject: mailsubject,
          workshopName:workshopName,
          maildescription : maildescription,
          mailliveCallText : mailliveCallText,
          workshopurl : workshopurl,
          }
          await commonService.createEmailArchiveDocument({
            emailData : dataModel,
            datamodel : dataModel,
            attachments : [],
            emailTo : [profile['email']],
            emailMap : [{[profile['email']] : newData.profileid}],
            fileURL : '',
            from:'starlabs@excellenceinstallation.com',
            notes : '',
            profileId : [newData.profileid],
            postmarkTemplateId: postmarktemplateId,
            templateAlias:templateAlias
          });

        } catch (emailError) {
          console.error('Error sending welcome email:', emailError);
        }
        console.log("endpoint", endpoint);
        console.log("data", data);

        const response = await axios.post(endpoint, data, { headers });
        console.log('Message sent successfully:', response.data);
        return response.data;
      } else {
        console.log("Document created but not 'enrolled' status — skipping message.");
      }

    } catch (error) {
      console.error('Error sending WhatsApp message:', error.response?.data || error.message);
      throw error;
    }
  }
);
exports.workshopautocommunicationschedule = onSchedule({schedule : "00 15 * * *", region: "asia-south1", timeZone: "Asia/Kolkata"},async (context)=>{
  try {
    console.log('started');
    const snapshot = await admin.firestore().collection("workshopconfiguration").where('evergreenWorkshop','==',true).get();
    let activeWorkshops = [];
    for (let i = 0; i < snapshot.docs.length; i++) {
      const doc = snapshot.docs[i];
      const data = doc.data()
      if (data['active'] == true || data['testmode'] == true) {
        activeWorkshops.push ({
          id:doc.id,
          ref:doc.ref,
          evergreenMeta:data['evergreenWorkshopMeta'],
          workshopName : data['detailpage']['title'],
          ...data
        });
      }
    }
    if (activeWorkshops.length === 0) return null;
    console.log(activeWorkshops,'activeWorkshops console');
    for (let i = 0; i < activeWorkshops.length; i++) {
      const workshop = activeWorkshops[i];
      const workshopName = workshop.workshopName ?? '';
      const workshopId = workshop.id ?? '';
      const workshopDays = workshop.evergreenMeta?.workshopDays;
      const dailyCommunication = workshop.evergreenMeta?.dailyCommunication;
      if (!workshopDays || !dailyCommunication) continue;
      const participantSnapshot = await admin.firestore().collection("participant workshop").where('workshopref','==',workshop['ref']).get();
      for (let j = 0; j < participantSnapshot.docs.length; j++) {
        const participantDoc = participantSnapshot.docs[j];
        const participantData = participantDoc.data()
        const created = participantData['created']?.toDate?.();
        if(!created) continue;
        const profileID = participantData['profileid'];
        if (!profileID) continue;
        const now = new Date()
        const diffTime = now - created;
        const dayNumber = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        console.log(dayNumber,'workshopDays calc console ')
        if (dayNumber < workshopDays) {
          // const message = dailyCommunication[dayNumber];
          const message = dailyCommunication[String(dayNumber)];
          if (!message) continue;
          console.log(
            "Workshop:", workshop.id,
            "User:", participantDoc.id,
            "Day:", dayNumber
          );
          console.log("Message:", message);
          await commonService.saveNotificationRecord({
            title: workshopName || "Workshop Update",
            message: message || '',
            subtitle: message || null,
            date: admin.firestore.FieldValue.serverTimestamp(),
            landingpage: null,
            logged: false,
            profileid: [profileID],
            sticky: false,
            notificationtype: "ahupdate",
            notificationimage: null,
            metadata: {
              workshopId: workshop.id,
              day: dayNumber
            }
          });
          const profileData = (await admin.firestore().collection("profile_data").doc(profileID).get()).data();
          const profileName = profileData["name"];
          await sendWatiWorkshopMessage({ profileID, profileName, workshopName, workshopId, message });
        }
      }     
    }
  } catch (error) {
    console.error(error,'Error')
  }
})

function requireAuth(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Sign-in is required.");
  }
  return request.auth.uid;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpsError("invalid-argument", `Missing "${field}".`);
  }
  return value.trim();
}

// /**
//  * Reads `series/{seriesId}` and validates it is a paid item with a price.
//  */
// async function loadPaidSeries(seriesId) {
//   const db = getFirestore();
//   const snap = await db.doc(`series/${seriesId}`).get();
//   if (!snap.exists) {
//     throw new HttpsError("not-found", "Series not found.");
//   }
//   const data = snap.data() || {};
//   const type = String(data.type || "").trim().toLowerCase();
//   if (type !== "paid") {
//     throw new HttpsError(
//       "failed-precondition",
//       "Series is not a paid item."
//     );
//   }
//   const price = Number(data.price);
//   if (!Number.isFinite(price) || price <= 0) {
//     throw new HttpsError(
//       "failed-precondition",
//       "Series has no valid price."
//     );
//   }
//   return {
//     ref: snap.ref,
//     name: String(data.seriesName || ""),
//     price,
//   };
// }

// // ── createRazorpayOrder ───────────────────────────────────────────────────

// exports.createRazorpayOrder = onCall(
//   {
//     secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET],
//     region: "us-central1",
//   },
//   async (request) => {
//     requireAuth(request);
//     const data = request.data || {};
//     const profileId = requireString(data.profileid, "profileid");
//     const seriesId = requireString(data.seriesId, "seriesId");

//     const series = await loadPaidSeries(seriesId);

//     const razorpay = new Razorpay({
//       key_id: RAZORPAY_KEY_ID.value(),
//       key_secret: RAZORPAY_KEY_SECRET.value(),
//     });

//     // Razorpay expects amounts in the smallest currency unit (paise for INR).
//     const amount = Math.round(series.price * 100);

//     let order;
//     try {
//       order = await razorpay.orders.create({
//         amount,
//         currency: "INR",
//         // Receipt must be <= 40 chars per Razorpay rules.
//         receipt: `eiflix_${profileId.slice(0, 14)}_${seriesId.slice(0, 14)}`,
//         notes: {
//           profileid: profileId,
//           seriesId,
//           seriesName: series.name,
//         },
//       });
//     } catch (error) {
//       console.error("Razorpay order creation failed:", error);
//       throw new HttpsError("internal", "Could not create order.");
//     }

//     return {
//       orderId: order.id,
//       amount,
//       currency: "INR",
//       seriesName: series.name,
//       price: series.price,
//     };
//   }
// );

// // ── verifyRazorpayPayment ─────────────────────────────────────────────────

// exports.verifyRazorpayPayment = onCall(
//   {
//     secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET],
//     region: "us-central1",
//   },
//   async (request) => {
//     const firebaseUid = requireAuth(request);
//     const data = request.data || {};
//     const paymentDocId = requireString(data.paymentDocId, "paymentDocId");
//     const profileId = requireString(data.profileid, "profileid");
//     const orderId = requireString(data.orderId, "orderId");
//     const paymentId = requireString(data.paymentId, "paymentId");
//     const signature = requireString(data.signature, "signature");

//     const db = getFirestore();
//     const docRef = db.doc(`eiflixpayment/${paymentDocId}`);

//     // Ownership check — the doc must already exist (client created it as
//     // pending) and must belong to the calling user.
//     const snap = await docRef.get();
//     if (!snap.exists) {
//       throw new HttpsError("not-found", "Payment record not found.");
//     }
//     const existing = snap.data() || {};
//     if (existing.firebaseuid !== firebaseUid) {
//       throw new HttpsError(
//         "permission-denied",
//         "You do not own this payment record."
//       );
//     }
//     if (existing.profileid !== profileId) {
//       throw new HttpsError(
//         "permission-denied",
//         "profileid mismatch."
//       );
//     }

//     // Recompute the signature server-side using the secret key.
//     const expected = crypto
//       .createHmac("sha256", RAZORPAY_KEY_SECRET.value())
//       .update(`${orderId}|${paymentId}`)
//       .digest("hex");

//     const isValid =
//       expected.length === signature.length &&
//       crypto.timingSafeEqual(
//         Buffer.from(expected, "hex"),
//         Buffer.from(signature, "hex")
//       );

//     if (!isValid) {
//       await docRef.set(
//         {
//           payment: {
//             status: "failed",
//             orderId,
//             paymentId,
//             signature,
//           },
//         },
//         { merge: true }
//       );
//       throw new HttpsError(
//         "invalid-argument",
//         "Payment signature mismatch."
//       );
//     }

//     // Verified — update the same document with success state.
//     await docRef.set(
//       {
//         payment: {
//           status: "success",
//           orderId,
//           paymentId,
//           signature,
//           paidAt: FieldValue.serverTimestamp(),
//         },
//       },
//       { merge: true }
//     );

//     return { verified: true };
//   }
// );

exports.authorizeTvDevice = onCall(
  {
    region: "us-central1",
  },
  async (request) => {
    // SELF-CONTAINED: do NOT call the module-level `requireAuth` /
    // `requireString` helpers from here. A previous deploy of this
    // function ReferenceError'd on `requireAuth` even though it was
    // visible at module scope in the source — Cloud Functions' gen-2
    // function-target wrapper appears to bundle this handler without
    // pulling in sibling top-level declarations. Inlining the auth
    // and validation logic makes the function bullet-proof against
    // whatever bundling quirk caused that.
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError("unauthenticated", "Sign-in is required.");
    }
    const uid = request.auth.uid;

    const rawCode = (request.data && request.data.code) || "";
    const code = String(rawCode).toUpperCase().trim();
    if (!code || code.length !== 6) {
      throw new HttpsError(
        "invalid-argument",
        "A 6-character pairing code is required."
      );
    }

    const db = getFirestore();
    const docRef = db.collection("pendingAuth").doc(code);

    // ── Diagnostic logging ────────────────────────────────────────────────
    // The Firestore Console shows pendingAuth/{code} present, yet this
    // function keeps reporting snap.exists === false. The four most likely
    // causes are: (a) the project has a non-default Firestore database and
    // we are reading from the wrong one, (b) the TV writes a doc ID that
    // looks identical to the eye but has hidden whitespace/Unicode chars,
    // (c) the function is bound to a different Firebase project than the
    // Console we are inspecting, (d) eventual-consistency lag (rare for a
    // strongly-consistent doc.get). These log lines let us tell them apart.
    // Nothing sensitive — pairing codes are not bearer credentials.
    const dbId =
      (db && db._settings && db._settings.databaseId) || "(default)";
    const projectId =
      process.env.GCLOUD_PROJECT ||
      process.env.GCP_PROJECT ||
      "(unknown)";
    console.log(
      `authorizeTvDevice: rawCode=${JSON.stringify(rawCode)} ` +
        `normalisedCode=${JSON.stringify(code)} ` +
        `codeBytesHex=${Buffer.from(code).toString("hex")} ` +
        `docPath="${docRef.path}" databaseId="${dbId}" projectId="${projectId}"`
    );

    const snap = await docRef.get();
    console.log(`authorizeTvDevice: snap.exists=${snap.exists} for code=${code}`);
    if (!snap.exists) {
      // Dump every doc ID currently in pendingAuth so we can compare
      // against the code the TV displayed. If our normalised code is
      // 4929FC but the collection contains a doc named " 4929FC" (with a
      // leading space) or "4929fc" (lowercase) the mismatch will be
      // visible immediately.
      try {
        const existing = await db.collection("pendingAuth").listDocuments();
        const ids = existing.map((d) => d.id);
        const idsHex = existing.map((d) =>
          `${d.id}=${Buffer.from(d.id).toString("hex")}`
        );
        console.warn(
          `authorizeTvDevice: not-found. pendingAuth has ${ids.length} ` +
            `doc(s): ${JSON.stringify(ids)} hex=${JSON.stringify(idsHex)}`
        );
      } catch (listError) {
        console.warn(
          `authorizeTvDevice: listDocuments failed: ${listError.message}`
        );
      }
      throw new HttpsError(
        "not-found",
        "This pairing code is not valid. Generate a new one on the TV."
      );
    }

    const expiresAt = snap.get("expiresAt");
    if (!expiresAt || expiresAt.toMillis() < Date.now()) {
      throw new HttpsError(
        "deadline-exceeded",
        "This code has expired. Generate a new one on the TV."
      );
    }

    const existingUid = snap.get("uid");
    if (existingUid) {
      throw new HttpsError(
        "already-exists",
        "This code has already been used."
      );
    }

    let customToken;
    try {
      customToken = await getAuth().createCustomToken(uid);
    } catch (error) {
      // Do not surface SDK internals to the client — log server-side and
      // return a generic error. The token itself is never logged.
      console.error("authorizeTvDevice: createCustomToken failed:", error);
      throw new HttpsError(
        "internal",
        "Could not authorize the TV. Please try again."
      );
    }

    await docRef.set(
      {
        uid,
        customToken,
        authorizedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { ok: true };
  }
);
