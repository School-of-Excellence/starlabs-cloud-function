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
const Razorpay = require("razorpay");
const crypto = require("crypto");

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
async function sendWatiWorkshopMessage({ profileID, profileName, workshopName, workshopId, message, message2 }) {
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
    ? `https://eiflix.com/web/workshop/${workshopId}`
    : `https://eiflix-workshop.web.app/workshop/${workshopId}`;

  // profile_data first, then new_user_data (a new user's profile lives there).
  const profileData = await getProfileData(profileID);
  const phonenumber = profileData?.['number'] ?? profileData?.['phonenumber'];

  const endpoint = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${phonenumber}`;
  const headers = {
    'Authorization': `Bearer ${WATI_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
  const data = {
    // template_name: 'vantage__poin_confirmation_message',
    template_name : 'workshop_auto_3variable',
    broadcast_name: 'WorkshopEvergreen2',
    parameters: [
      { name: 'name', value: profileName || '' },
      { name: 'message', value: message },
      { name: '1', value: message2 },
      { name: '2', value: workshopurl },
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
      let referreduser = null;
      if (newData.referringuser != null) {
        referreduser = await getProfileData(newData.referringuser);
      }
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
        let evergreenWorkshop = false;
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
            evergreenWorkshop = workshopData?.evergreenWorkshop || false;
            slackchannel = workshopData?.workshopactivitychannel || null;
            workshopurl = commonService.production
              ? `https://eiflix.com/web/workshop/${workshopData?.docid}`
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
            let message = referreduser ?  `🚀 *${profile['name']}* just Enrolled *${workshopName}*! 🌱 Referred by *${referreduser['name']}*` : `🚀 *${profile['name']}* just Enrolled *${workshopName}*! 🌱`;
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
          console.log(evergreenWorkshop,'consoleee evergreenWorkshop')
          const templateAlias = evergreenWorkshop
            ? "WorkshopEnrolledMessageEvergreen"
            : categorybased
              ? "WorkshopEnrolledMessage1"
              : "WorkshopEnrolledMessage";
          const postmarktemplateId = evergreenWorkshop
            ? '45591602'
            : categorybased
              ? '43859890'
              : '42135513';
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
exports.workshopautocommunicationschedule = onSchedule({schedule : "00 21 * * *", region: "asia-south1", timeZone: "Asia/Kolkata"},async (context)=>{
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
      const dailyCommunication2 = workshop.evergreenMeta?.dailyCommunication2;
      if (!workshopDays || !dailyCommunication || !dailyCommunication2) continue;
      const participantSnapshot = await admin.firestore().collection("participant workshop").where('workshopref','==',workshop['ref']).get();
      for (let j = 0; j < participantSnapshot.docs.length; j++) {
        const participantDoc = participantSnapshot.docs[j];
        const participantData = participantDoc.data()
        const created = participantData['created']?.toDate?.();
        if(!created) continue;
        const profileID = participantData['profileid'];
        if (!profileID) continue;
        // Completion gate — mirror the participant completion page
        // (`_showCompletion`): a participant who has COMPLETED the workshop gets
        // no further daily communication. Two of the page's three signals are
        // checked here — the `workshopcompleted` flag and "all challenges
        // completed" (via the shared `overallChallengeProgress` port); the third,
        // evergreen day-count expiry, is already covered by the
        // `dayNumber < workshopDays` guard below.
        const completionProgress =
          overallChallengeProgress(participantData['challenges']);
        const participantCompleted =
          workshop['workshopcompleted'] === true ||
          (completionProgress.total > 0 &&
            completionProgress.completed >= completionProgress.total);
        if (participantCompleted) {
          console.log(
            'workshopautocommunicationschedule: skipping completed participant',
            participantDoc.id
          );
          continue;
        }
        const now = new Date()
        const diffTime = now - created;
        const dayNumber = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        console.log(dayNumber,'workshopDays calc console ')
        if (dayNumber < workshopDays) {
          // const message = dailyCommunication[dayNumber];
          const message = dailyCommunication[String(dayNumber)];
          const message2 = dailyCommunication2[String(dayNumber)];
          if (!message || !message2) continue;
          console.log(
            "Workshop:", workshop.id,
            "User:", participantDoc.id,
            "Day:", dayNumber
          );
          console.log("Message:", message);
          //redo when needed
          
          // await commonService.saveNotificationRecord({
          //   title: workshopName || "Workshop Update",
          //   message: message || '',
          //   subtitle: message || null,
          //   date: admin.firestore.FieldValue.serverTimestamp(),
          //   landingpage: null,
          //   logged: false,
          //   profileid: [profileID],
          //   sticky: false,
          //   notificationtype: "ahupdate",
          //   notificationimage: null,
          //   metadata: {
          //     workshopId: workshop.id,
          //     day: dayNumber
          //   }
          // });
          // profile_data first, then new_user_data (new users live there).
          const profileData = await getProfileData(profileID);
          const profileName = profileData?.["name"] ?? "";
          await sendWatiWorkshopMessage({ profileID, profileName, workshopName, workshopId, message, message2 });
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

// ── Workshop Razorpay payment + paid enrollment ───────────────────────────
//
// The web Workshop (V2) Buy flow. Two callables, both self-contained (auth +
// validation inlined — a gen-2 bundling quirk once dropped sibling top-level
// helpers from a deployed handler, see authorizeTvDevice; payment code must be
// bullet-proof against that).
//
// The Razorpay key id + secret live per-workshop on
// `workshopconfiguration.paymentmap` ({ amount, api: keyId, id: keySecret }) so
// each workshop can bill through its own merchant account. The secret is read
// ONLY here, server-side — the web client receives just the public key id and a
// server-created order id. `createWorkshopPaymentOrder` mints the order;
// `verifyWorkshopPayment` re-verifies the checkout signature + payment entity,
// logs the payment to `workshoppaymentlog`, and enrolls the buyer (twin of the
// client enroll writes) with `enrollmentmode: 'payment'` + `workshoppaymentlogref`
// on both enrollment documents.

const WS_WORKSHOP_COLLECTION = "workshopconfiguration";
const WS_SECRET_COLLECTION = "workshopsecrets";
const WS_PAYMENT_LOG_COLLECTION = "workshoppaymentlog";
const WS_ORDER_COLLECTION = "workshoporder";
const WS_PARTICIPANT_WORKSHOP_COLLECTION = "participant workshop";
const WS_ENROLLED_COLLECTION = "workshop participant enrolled";
const WS_STATUS_ENROLLED = "enrolled";
const WS_STATUS_ENROLLED_NOT_STARTED = "enrollednotstarted";

/**
 * Reads and validates a workshop's payment configuration. Throws HttpsError
 * when payment is disabled or amount/keys are missing.
 *
 * The `amount` and the (public) key id come from `workshopconfiguration
 * .paymentmap` ({ amount, api: keyId }). The key SECRET is read from the
 * locked `workshopsecrets/{workshopId}` doc — client reads are denied by
 * Firestore rules and the Admin SDK (here) bypasses them, so the secret is
 * never exposed on the client-readable workshop doc. It falls back to the
 * legacy `paymentmap.id` only until every workshop is migrated.
 * @returns {Promise<{workshopData: object, workshopRef: FirebaseFirestore.DocumentReference, amount: number, keyId: string, keySecret: string}>}
 */
async function loadWorkshopPaymentConfig(db, workshopId) {
  const snap = await db.collection(WS_WORKSHOP_COLLECTION).doc(workshopId).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Workshop not found.");
  }
  const data = snap.data() || {};
  if (data.payment !== true) {
    throw new HttpsError(
      "failed-precondition",
      "Payment is not enabled for this workshop."
    );
  }
  const paymentMap = (data.paymentmap && typeof data.paymentmap === "object")
    ? data.paymentmap
    : {};
  const amount = Number(paymentMap.amount);
  const keyId = String(paymentMap.api || "").trim();

  // Key secret from the locked secrets collection (preferred), else the legacy
  // in-doc field during migration.
  let keySecret = "";
  const secretSnap =
    await db.collection(WS_SECRET_COLLECTION).doc(workshopId).get();
  if (secretSnap.exists) {
    keySecret = String(secretSnap.get("keySecret") || "").trim();
  }
  if (!keySecret) {
    const legacy = String(paymentMap.id || "").trim();
    if (legacy) {
      console.warn(
        `loadWorkshopPaymentConfig: workshop ${workshopId} still uses the ` +
          `legacy paymentmap.id secret — migrate it to ` +
          `${WS_SECRET_COLLECTION}/${workshopId}.keySecret and remove it from ` +
          `paymentmap.`
      );
      keySecret = legacy;
    }
  }

  if (!Number.isFinite(amount) || amount <= 0 || !keyId || !keySecret) {
    throw new HttpsError(
      "failed-precondition",
      "Payment is not configured correctly for this workshop."
    );
  }
  return { workshopData: data, workshopRef: snap.ref, amount, keyId, keySecret };
}

/**
 * Resolves the buyer's real contact details for the payment log — phone,
 * country code and email — from the app's own collections, because Razorpay's
 * `contact`/`email` are often test values or empty. A regular user's data
 * lives in `participant metadata`; a new user's in `new_user_data` (checked as
 * a fallback). Both keyed by `profileId`:
 *   - `participant metadata`→ `phonenumber` / `countrycode` / `email`
 *   - `new_user_data`       → `phonenumber` / `countryCode` / `email`
 * Never throws — returns nulls on any miss/error.
 * @returns {Promise<{email: (string|null), phonenumber: (string|null), countrycode: (string|null)}>}
 */
async function resolveWorkshopUserContact(db, profileId) {
  const empty = { email: null, phonenumber: null, countrycode: null };
  if (!profileId) {
    return empty;
  }
  const str = (v) => (v == null || v === "" ? null : String(v));
  try {
    const pm = await db.collection("participant metadata").doc(profileId).get();
    if (pm.exists) {
      const d = pm.data() || {};
      return {
        email: str(d.email),
        phonenumber: str(d.phonenumber),
        countrycode: str(d.countrycode),
      };
    }
    const nu = await db.collection("new_user_data").doc(profileId).get();
    if (nu.exists) {
      const d = nu.data() || {};
      return {
        email: str(d.email),
        phonenumber: str(d.phonenumber),
        countrycode: str(d.countryCode), // capital C in new_user_data
      };
    }
  } catch (error) {
    console.warn(
      `resolveWorkshopUserContact failed for ${profileId}: ${error.message}`
    );
  }
  return empty;
}

/**
 * Creates a Razorpay order for a workshop purchase and persists it (bound to
 * the workshop + profile + authenticated uid) so `verifyWorkshopPayment` can
 * redeem it exactly once for exactly that profile.
 * Input:  { workshopId, profileId }
 * Output: { orderId, keyId, amount (paise), currency }
 */
exports.createWorkshopPaymentOrder = onCall(
  { region: "us-central1" },
  async (request) => {
    // Self-contained auth + validation (see the header note).
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError("unauthenticated", "Sign-in is required.");
    }
    const uid = request.auth.uid;
    const data = request.data || {};
    const workshopId = String(data.workshopId || "").trim();
    const profileId = String(data.profileId || "").trim();
    if (!workshopId) {
      throw new HttpsError("invalid-argument", 'Missing "workshopId".');
    }
    if (!profileId) {
      throw new HttpsError("invalid-argument", 'Missing "profileId".');
    }

    const db = getFirestore();
    const { workshopRef, amount, keyId, keySecret } =
      await loadWorkshopPaymentConfig(db, workshopId);
    // Razorpay expects the smallest currency unit (paise for INR).
    const amountPaise = Math.round(amount * 100);

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    let order;
    try {
      order = await razorpay.orders.create({
        amount: amountPaise,
        currency: "INR",
        // Auto-capture so funds move on payment (verify also captures any
        // stray `authorized` payment defensively).
        payment_capture: 1,
        // Receipt must be <= 40 chars per Razorpay rules.
        receipt: `ws_${workshopId}_${Date.now()}`.slice(0, 40),
        notes: { workshopId, profileId, uid },
      });
    } catch (error) {
      console.error("createWorkshopPaymentOrder: order create failed", error);
      throw new HttpsError("internal", "Could not create the payment order.");
    }

    // Persist the order bound to (workshop, profile, uid). verify requires this
    // record and consumes it once, so a single payment cannot be replayed onto
    // another profile and only the uid that created the order can redeem it.
    await db.collection(WS_ORDER_COLLECTION).doc(order.id).set({
      orderid: order.id,
      workshopid: workshopId,
      workshopref: workshopRef,
      profileid: profileId,
      uid,
      amount: amountPaise,
      currency: order.currency || "INR",
      consumed: false,
      created: FieldValue.serverTimestamp(),
    });

    console.log(
      `createWorkshopPaymentOrder: order ${order.id} for workshop ` +
        `${workshopId} profile ${profileId} amount ${amountPaise}`
    );
    return {
      orderId: order.id,
      keyId,
      amount: amountPaise,
      currency: order.currency || "INR",
    };
  }
);

/**
 * Fetches the Razorpay payment entity, captures it if it is still merely
 * `authorized`, and asserts it belongs to `orderId` and matches `amountPaise`.
 * The single source of truth for "did the money actually move" — used by the
 * client verify, the reconcile callable and the scheduled sweep so all three
 * agree on when a payment is settle-able.
 * @returns {Promise<object>} the captured Razorpay payment entity
 */
async function fetchCaptureAndValidatePayment(
  razorpay,
  { paymentId, orderId, amountPaise }
) {
  let payment = await razorpay.payments.fetch(paymentId);
  if (payment.order_id !== orderId) {
    throw new HttpsError(
      "permission-denied",
      "Payment does not match the order."
    );
  }
  if (Number(payment.amount) !== Number(amountPaise)) {
    throw new HttpsError("permission-denied", "Payment amount mismatch.");
  }
  if (payment.status === "authorized") {
    payment = await razorpay.payments.capture(
      paymentId,
      Number(amountPaise),
      payment.currency || "INR"
    );
  }
  if (payment.status !== "captured") {
    throw new HttpsError(
      "failed-precondition",
      `Payment is not captured (status: ${payment.status}).`
    );
  }
  return payment;
}

/**
 * Server port of the client's `isEvergreenExpired`: whole days elapsed since
 * enrollment (`floor((now - createdAt)/day)`) has reached the evergreen
 * `workshopDays` window. `false` for a missing date or a ≤0 duration.
 */
function isEvergreenExpiredServer(createdAt, workshopDays) {
  if (!createdAt || !Number.isFinite(workshopDays) || workshopDays <= 0) {
    return false;
  }
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const dayNumber = Math.floor((Date.now() - createdAt.getTime()) / MS_PER_DAY);
  return dayNumber >= workshopDays;
}

/**
 * Server port of the client's `workshopOverallProgress`. Counts completed vs
 * total progress-countable activities across a participant's `challenges`.
 * Mirrors the client EXACTLY: only `type === "challenge"` challenges count
 * (zoomcalls excluded); a challenge's activities live under its nested
 * `challenges` key; `note` activities are excluded; an activity is complete
 * when `status === "completed"`.
 * @returns {{completed: number, total: number}}
 */
function overallChallengeProgress(rawChallenges) {
  let completed = 0;
  let total = 0;
  const challenges = Array.isArray(rawChallenges) ? rawChallenges : [];
  for (const ch of challenges) {
    if (!ch || typeof ch !== "object" || ch.type !== "challenge") {
      continue; // excludes zoomcall (and any non-challenge type)
    }
    const activities = Array.isArray(ch.challenges) ? ch.challenges : [];
    for (const a of activities) {
      if (!a || typeof a !== "object" || a.type === "note") {
        continue; // notes are informational, excluded from progress
      }
      total++;
      if (a.status === "completed") {
        completed++;
      }
    }
  }
  return { completed, total };
}

/**
 * Server port of the client's `activeEvergreenBlocker` decision, reduced to the
 * boolean the recovery paths need: does [profileId] already have an active,
 * NOT-yet-completed evergreen workshop (other than [excludeWorkshopId])? When
 * `true`, a newly-settled evergreen enrollment must be QUEUED (`waiting`) rather
 * than started immediately, preserving the "one evergreen at a time" invariant.
 *
 * A workshop counts as completed (i.e. NOT a blocker) when any of the three
 * signals the participant screen uses is true: the config `workshopcompleted`
 * flag, evergreen day-count expiry, or all challenges done. Same three signals,
 * same order as the client.
 *
 * Fails OPEN to match the client's enroll/queue decision: on any read error it
 * returns `false` (enroll active) so a paid buyer is never wrongly blocked.
 */
async function evergreenWaitingRequired(db, { profileId, excludeWorkshopId }) {
  try {
    // Single-field query (no composite index needed); filter the rest here.
    const snap = await db
      .collection(WS_ENROLLED_COLLECTION)
      .where("profileid", "==", profileId)
      .get();
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      if (d.status !== WS_STATUS_ENROLLED || d.evergreenWorkshop !== true) {
        continue; // only active evergreen enrollments can block
      }
      const workshopRef = d.workshopref;
      if (!workshopRef || typeof workshopRef.id !== "string") {
        continue;
      }
      if (workshopRef.id === excludeWorkshopId) {
        continue; // never let the workshop being settled block itself
      }
      const participantRef = d.participantworkshopref;
      if (!participantRef || typeof participantRef.get !== "function") {
        continue;
      }
      const [pSnap, wsSnap] = await Promise.all([
        participantRef.get(),
        workshopRef.get(),
      ]);
      const pData = pSnap.data();
      if (!pData) {
        continue;
      }
      const wsData = wsSnap.data() || {};
      const created =
        pData.created && pData.created.toDate ? pData.created.toDate() : null;
      const meta =
        wsData.evergreenWorkshopMeta &&
        typeof wsData.evergreenWorkshopMeta === "object"
          ? wsData.evergreenWorkshopMeta
          : {};
      const workshopDays = Number(meta.workshopDays);
      const progress = overallChallengeProgress(pData.challenges);
      const completed =
        wsData.workshopcompleted === true ||
        isEvergreenExpiredServer(created, workshopDays) ||
        (progress.total > 0 && progress.completed >= progress.total);
      if (!completed) {
        return true; // an active, unfinished evergreen workshop → must wait
      }
    }
    return false;
  } catch (error) {
    console.warn(
      `evergreenWaitingRequired: failing open for profile ${profileId}: ` +
        `${error.message}`
    );
    return false;
  }
}

/**
 * Resolves the `waiting` flag for a recovered enrollment: `true` only for an
 * evergreen workshop whose buyer already has another active, unfinished
 * evergreen workshop. Non-evergreen workshops never wait. Centralised so the
 * reconcile callable and the sweep decide identically.
 */
async function resolveRecoveryWaiting(db, workshopData, workshopId, profileId) {
  if (workshopData.evergreenWorkshop !== true) {
    return false;
  }
  return evergreenWaitingRequired(db, {
    profileId,
    excludeWorkshopId: workshopId,
  });
}

/**
 * Idempotently settles a captured Razorpay workshop payment: writes the
 * `workshoppaymentlog` entry (keyed by `paymentId`), enrolls the profile
 * (server-side twin of the client enroll writes) and consumes the
 * `workshoporder`. Everything commits in ONE transaction, so it is safe to call
 * repeatedly and from every recovery source — the client verify, the reconcile
 * callable, the scheduled sweep and the webhook. The idempotency guards are: an
 * existing-enrollment check (status-agnostic), the `consumed` order, and the
 * paymentId-keyed log (merge). A payment can therefore be settled at most once
 * no matter how many sources race on it, so a charged buyer is enrolled exactly
 * once and never double-charged/double-enrolled.
 *
 * The caller MUST have already: loaded + bound-checked the order to
 * (workshop, profile, uid), fetched the Razorpay `payment` entity, and
 * confirmed via {@link fetchCaptureAndValidatePayment} that it is `captured`
 * and matches the order + amount.
 *
 * @returns {Promise<{participantWorkshopId: (string|null), paymentLogId: string, alreadyEnrolled: boolean}>}
 */
async function settleWorkshopPayment(
  db,
  {
    workshopData,
    workshopRef,
    orderRef,
    profileId,
    uid,
    orderId,
    paymentId,
    payment,
    device = {},
    waiting = false,
    source = "verify",
  }
) {
  // Resolve the buyer's real contact for the log (Razorpay's contact/email are
  // often test values or empty). Read outside the transaction.
  const contact = await resolveWorkshopUserContact(db, profileId);

  const logRef = db.collection(WS_PAYMENT_LOG_COLLECTION).doc(paymentId);
  const evergreen = workshopData.evergreenWorkshop === true;
  const categoryBased = workshopData.categorybased === true;
  const detail = (workshopData.detailpage &&
    typeof workshopData.detailpage === "object")
    ? workshopData.detailpage
    : {};
  const challenges = Array.isArray(workshopData.challenges)
    ? workshopData.challenges
    : [];
  const enrolledQuery = db
    .collection(WS_ENROLLED_COLLECTION)
    .where("profileid", "==", profileId)
    .where("workshopref", "==", workshopRef)
    .limit(1);

  const outcome = await db.runTransaction(async (tx) => {
    // READS first (Firestore transaction rule).
    const freshOrder = (await tx.get(orderRef)).data() || {};
    const existing = await tx.get(enrolledQuery);
    // First time this paymentId is logged → the payment is being credited now.
    // Retries/reconciles of an already-settled payment see the log and skip the
    // Slack notification below.
    const newlyCredited = !(await tx.get(logRef)).exists;

    let participantRef = null;
    let enrolledRef = null;
    let alreadyEnrolled;
    if (!existing.empty) {
      // Already enrolled (a prior payment retry, or a referral enrollment).
      enrolledRef = existing.docs[0].ref;
      participantRef = existing.docs[0].get("participantworkshopref") || null;
      alreadyEnrolled = true;
    } else if (freshOrder.consumed && freshOrder.participantworkshopref) {
      // This order already produced an enrollment.
      participantRef = freshOrder.participantworkshopref;
      enrolledRef = freshOrder.workshopparticipantenrolledref || null;
      alreadyEnrolled = true;
    } else {
      participantRef = db.collection(WS_PARTICIPANT_WORKSHOP_COLLECTION).doc();
      enrolledRef = db.collection(WS_ENROLLED_COLLECTION).doc();
      alreadyEnrolled = false;
    }

    // WRITES. The log is keyed by paymentId (merge) so it is never duplicated.
    tx.set(
      logRef,
      {
        docid: logRef.id,
        profileid: profileId,
        workshopref: workshopRef,
        uid,
        orderid: orderId,
        paymentid: paymentId,
        signatureverified: true,
        amount: payment.amount, // Razorpay's canonical value, in paise
        amountRupees: payment.amount / 100, // human-readable (₹) companion
        currency: payment.currency,
        status: payment.status,
        method: payment.method || null,
        // Buyer contact resolved from our own profile collections; the raw
        // Razorpay contact/email remain inside the `payment` entity below.
        email: contact.email || payment.email || null,
        phonenumber: contact.phonenumber,
        countrycode: contact.countrycode,
        payment, // the complete Razorpay payment entity
        device, // client-collected device details (user agent, screen, …)
        settledsource: source, // verify | reconcile | sweep | webhook
        participantworkshopref: participantRef,
        workshopparticipantenrolledref: enrolledRef,
        datetime: FieldValue.serverTimestamp(),
        createdatiso: new Date().toISOString(),
      },
      { merge: true }
    );

    if (!alreadyEnrolled) {
      // Server-side twin of the client enroll writes. Payment is the gate —
      // the registration window is NOT re-checked (the buyer paid) and a
      // missing `challenges` array falls back to [] rather than failing. When
      // `waiting` (evergreen one-at-a-time queue), both docs are written
      // `enrollednotstarted` with a `waitingstartedat` timestamp.
      const notStarted = waiting || categoryBased;
      const waitingAt = waiting ? FieldValue.serverTimestamp() : null;
      tx.set(participantRef, {
        docref: participantRef,
        profileid: profileId,
        workshopref: workshopRef,
        challenges,
        detailpage: detail,
        created: FieldValue.serverTimestamp(),
        evergreenWorkshop: evergreen,
        enrollmentmode: "payment",
        platform_name: "Eiflixweb",
        workshoppaymentlogref: logRef,
        workshopparticipantenrolledRef: enrolledRef,
        ...(waiting ? { waitingstartedat: waitingAt } : {}),
      });
      tx.set(enrolledRef, {
        profileid: profileId,
        workshopref: workshopRef,
        participantworkshopref: participantRef,
        enrollmentdate: FieldValue.serverTimestamp(),
        status: notStarted
          ? WS_STATUS_ENROLLED_NOT_STARTED
          : WS_STATUS_ENROLLED,
        workshopStartedAt: FieldValue.serverTimestamp(),
        evergreenWorkshop: evergreen,
        enrollmentmode: "payment",
        platform_name: "Eiflixweb",
        workshoppaymentlogref: logRef,
        ...(waiting ? { waitingstartedat: waitingAt } : {}),
      });
    }

    // Consume the order (idempotent) with the resolved enrollment refs.
    tx.set(
      orderRef,
      {
        consumed: true,
        consumedat: FieldValue.serverTimestamp(),
        paymentid: paymentId,
        settledsource: source,
        participantworkshopref: participantRef,
        workshopparticipantenrolledref: enrolledRef,
      },
      { merge: true }
    );

    return {
      participantWorkshopId: participantRef ? participantRef.id : null,
      alreadyEnrolled,
      newlyCredited,
    };
  });

  // Notify the workshop-logs Slack channel once, only when this payment was
  // just credited (never on idempotent retries). Awaited so it finishes inside
  // the invocation — Cloud Run freezes background work after the response, which
  // was surfacing as "Exception from a finished function". A Slack failure is
  // caught here and never breaks settlement.
  if (outcome.newlyCredited) {
    try {
      const url = commonService.production
        ? commonService.slackeiflixrefferals
        : commonService.slackDevTest;
      if (url) {
        const webhook = new commonService.IncomingWebhook(url);
        const workshopTitle = detail.title || "Workshop";
        const buyer = contact.email || contact.phonenumber || profileId;
        const amountText = payment && payment.amount != null
          ? `₹${payment.amount / 100}`
          : "payment";
        const message =
          `💰 *Payment credited* — *${buyer}* paid *${amountText}* for ` +
          `*${workshopTitle}* 🎉`;
        await webhook.send(message);
        console.log(`settleWorkshopPayment: slack notified for ${paymentId}`);
      } else {
        console.warn("settleWorkshopPayment: slack webhook URL not configured.");
      }
    } catch (error) {
      console.error("settleWorkshopPayment: slack notify failed", error);
    }
  }

  return {
    participantWorkshopId: outcome.participantWorkshopId,
    paymentLogId: logRef.id,
    alreadyEnrolled: outcome.alreadyEnrolled,
  };
}

/**
 * Verifies a completed Razorpay checkout, logs it to `workshoppaymentlog`, and
 * enrolls the profile in the workshop (server-side twin of the client enroll
 * flow) with `enrollmentmode: 'payment'` + `workshoppaymentlogref` on both the
 * `participant workshop` and `workshop participant enrolled` documents.
 *
 * Input:  { workshopId, profileId, orderId, paymentId, signature, device }
 * Output: { participantWorkshopId, paymentLogId, alreadyEnrolled }
 */
exports.verifyWorkshopPayment = onCall(
  { region: "us-central1" },
  async (request) => {
    // Self-contained auth + validation (see the header note).
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError("unauthenticated", "Sign-in is required.");
    }
    const uid = request.auth.uid;
    const data = request.data || {};
    const workshopId = String(data.workshopId || "").trim();
    const profileId = String(data.profileId || "").trim();
    const orderId = String(data.orderId || "").trim();
    const paymentId = String(data.paymentId || "").trim();
    const signature = String(data.signature || "").trim();
    const device = (data.device && typeof data.device === "object")
      ? data.device
      : {};
    // Evergreen "one at a time" queue: the client computes whether this
    // (evergreen) workshop must wait behind an active one.
    const waiting = data.waiting === true;
    if (!workshopId || !profileId || !orderId || !paymentId || !signature) {
      throw new HttpsError(
        "invalid-argument",
        "Missing payment verification fields."
      );
    }

    const db = getFirestore();
    const { workshopData, workshopRef, keyId, keySecret } =
      await loadWorkshopPaymentConfig(db, workshopId);

    // 1. Load the persisted order and require it was minted for THIS workshop,
    //    profile and authenticated uid — so a single paid order can only be
    //    redeemed once, for the profile it was created for, by its creator.
    const orderRef = db.collection(WS_ORDER_COLLECTION).doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      throw new HttpsError("permission-denied", "Unknown payment order.");
    }
    const orderData = orderSnap.data() || {};
    if (
      orderData.workshopid !== workshopId ||
      orderData.profileid !== profileId ||
      orderData.uid !== uid
    ) {
      console.warn(
        `verifyWorkshopPayment: order binding mismatch for order ${orderId}`
      );
      throw new HttpsError(
        "permission-denied",
        "Payment order does not match this request."
      );
    }
    const amountPaise = Number(orderData.amount);

    // 2. Verify the checkout signature: HMAC-SHA256("orderId|paymentId").
    const expected = crypto
      .createHmac("sha256", keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    const expectedBuf = Buffer.from(expected, "utf8");
    const actualBuf = Buffer.from(signature, "utf8");
    const signatureValid =
      expectedBuf.length === actualBuf.length &&
      crypto.timingSafeEqual(expectedBuf, actualBuf);
    if (!signatureValid) {
      console.warn(
        `verifyWorkshopPayment: signature mismatch for order ${orderId} ` +
          `workshop ${workshopId} profile ${profileId}`
      );
      throw new HttpsError("permission-denied", "Payment verification failed.");
    }

    // 3. Cross-check + capture the payment entity via the Razorpay API so funds
    //    actually move before enrolling (shared with reconcile/sweep).
    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    let payment;
    try {
      payment = await fetchCaptureAndValidatePayment(razorpay, {
        paymentId,
        orderId,
        amountPaise,
      });
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }
      console.error("verifyWorkshopPayment: payment fetch/capture failed", error);
      throw new HttpsError("internal", "Could not verify the payment.");
    }

    // 4. Log the payment + enroll the profile ATOMICALLY (shared, idempotent).
    const settlement = await settleWorkshopPayment(db, {
      workshopData,
      workshopRef,
      orderRef,
      profileId,
      uid,
      orderId,
      paymentId,
      payment,
      device,
      waiting,
      source: "verify",
    });

    console.log(
      `verifyWorkshopPayment: ${settlement.alreadyEnrolled ? "existing" : "new"} ` +
        `enrollment ${settlement.participantWorkshopId} (log ` +
        `${settlement.paymentLogId}) for workshop ${workshopId} profile ` +
        `${profileId}`
    );
    return {
      participantWorkshopId: settlement.participantWorkshopId,
      paymentLogId: settlement.paymentLogId,
      alreadyEnrolled: settlement.alreadyEnrolled,
      waiting: settlement.alreadyEnrolled ? false : waiting,
    };
  }
);

/**
 * RECOVERY PATH — settles a charged-but-not-settled workshop payment.
 *
 * Fixes the "internet dropped right after Razorpay captured the money"
 * failure: the browser never reached `verifyWorkshopPayment`, so the
 * `workshoporder` is stuck `consumed:false`, there is no `workshoppaymentlog`,
 * and the buyer is charged but not enrolled (the UI would otherwise ask them to
 * pay AGAIN). The client calls this before offering "Buy" again; it asks
 * Razorpay — the source of truth — whether any order this (uid, profile) minted
 * for this workshop already has a captured payment, and if so settles it
 * through the same idempotent {@link settleWorkshopPayment} used by verify.
 *
 * No client signature is needed: trust comes from the authenticated uid, the
 * order binding (uid + profile + workshop, set at order-creation), and reading
 * the payment's captured state straight from Razorpay.
 *
 * Input:  { workshopId, profileId }
 * Output: { recovered, participantWorkshopId, paymentLogId, alreadyEnrolled,
 *           waiting }
 */
exports.reconcileWorkshopPayment = onCall(
  { region: "us-central1" },
  async (request) => {
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError("unauthenticated", "Sign-in is required.");
    }
    const uid = request.auth.uid;
    const data = request.data || {};
    const workshopId = String(data.workshopId || "").trim();
    const profileId = String(data.profileId || "").trim();
    if (!workshopId || !profileId) {
      throw new HttpsError(
        "invalid-argument",
        "Missing workshopId/profileId."
      );
    }

    const db = getFirestore();
    const { workshopData, workshopRef, keyId, keySecret } =
      await loadWorkshopPaymentConfig(db, workshopId);
    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

    // The buyer's unconsumed orders. Single-field `uid` equality needs no
    // composite index; the rest is filtered in memory (a user has very few).
    const ordersSnap = await db
      .collection(WS_ORDER_COLLECTION)
      .where("uid", "==", uid)
      .get();

    const candidates = ordersSnap.docs.filter((d) => {
      const o = d.data() || {};
      return (
        o.consumed !== true &&
        o.workshopid === workshopId &&
        o.profileid === profileId
      );
    });

    for (const orderDoc of candidates) {
      const orderData = orderDoc.data() || {};
      const orderId = orderData.orderid || orderDoc.id;
      const amountPaise = Number(orderData.amount);
      const reconciled =
        await reconcileOrderPayment(razorpay, orderId, amountPaise);
      if (reconciled.status !== "settleable") {
        continue; // never paid, or a transient lookup error — try the next one
      }
      const payment = reconciled.payment;
      // Preserve the evergreen "one at a time" queue: if the buyer already has
      // another active evergreen workshop, this recovered enrollment must wait
      // (exactly the decision the client makes at buy time).
      const waiting =
        await resolveRecoveryWaiting(db, workshopData, workshopId, profileId);
      const settlement = await settleWorkshopPayment(db, {
        workshopData,
        workshopRef,
        orderRef: orderDoc.ref,
        profileId,
        uid,
        orderId,
        paymentId: payment.id,
        payment,
        device: { recovered: "reconcile" },
        waiting,
        source: "reconcile",
      });
      console.log(
        `reconcileWorkshopPayment: recovered order ${orderId} → ` +
          `enrollment ${settlement.participantWorkshopId} (log ` +
          `${settlement.paymentLogId}) for workshop ${workshopId} profile ` +
          `${profileId}`
      );
      return {
        recovered: true,
        participantWorkshopId: settlement.participantWorkshopId,
        paymentLogId: settlement.paymentLogId,
        alreadyEnrolled: settlement.alreadyEnrolled,
        // A brand-new recovered enrollment reflects the queue decision; an
        // already-existing one keeps whatever state it already had.
        waiting: settlement.alreadyEnrolled ? false : waiting,
      };
    }

    return {
      recovered: false,
      participantWorkshopId: null,
      paymentLogId: null,
      alreadyEnrolled: false,
      waiting: false,
    };
  }
);

/**
 * Reconciles ONE order against Razorpay and classifies it, never throwing so
 * the reconcile loop and the sweep can branch on the result:
 *   - `{ status: "settleable", payment }` — a captured (or now-captured)
 *     payment matching the order + amount is ready to settle;
 *   - `{ status: "none" }` — the fetch succeeded but the order has no
 *     settle-able payment (unpaid, or only failed payments). Authoritative:
 *     safe to treat as "never paid";
 *   - `{ status: "error" }` — the Razorpay lookup itself failed (transient);
 *     the order state is UNKNOWN, so callers must retry later, never close it.
 */
async function reconcileOrderPayment(razorpay, orderId, amountPaise) {
  let items;
  try {
    const resp = await razorpay.orders.fetchPayments(orderId);
    items = (resp && resp.items) || [];
  } catch (error) {
    console.warn(
      `reconcileOrderPayment: fetchPayments failed for ${orderId}: ` +
        `${error.message}`
    );
    return { status: "error" };
  }
  const candidate =
    items.find((p) => p.status === "captured") ||
    items.find((p) => p.status === "authorized");
  if (!candidate) {
    return { status: "none" };
  }
  try {
    const payment = await fetchCaptureAndValidatePayment(razorpay, {
      paymentId: candidate.id,
      orderId,
      amountPaise,
    });
    return { status: "settleable", payment };
  } catch (error) {
    console.warn(
      `reconcileOrderPayment: ${candidate.id} not settle-able for ` +
        `${orderId}: ${error.message}`
    );
    return { status: "none" };
  }
}

/**
 * SAFETY NET — settles charged-but-orphaned workshop orders in one pass.
 *
 * Reconciles `workshoporder` docs left `consumed:false` against Razorpay: any
 * order that turns out to have a captured payment is settled through the same
 * idempotent {@link settleWorkshopPayment}. This recovers every buyer whose
 * browser died after payment — even those who never return to the app — without
 * any Razorpay dashboard/webhook configuration.
 *
 * NOT its own scheduled function: it is a plain async routine invoked from the
 * existing every-5-minutes `appointmentremainder` schedule (see
 * `components/appointment.js`) so we do not spin up a second scheduler. Guards:
 * orders younger than 2 minutes are skipped (let the client's own verify win
 * first); orders confirmed unpaid past 3 days are finalised (abandoned
 * checkouts). Never throws — it logs and returns a small summary so the caller
 * can run it fire-and-forget.
 *
 * @returns {Promise<{recovered: number, closed: number, skipped: number, failed: number, scanned: number}>}
 */
exports.runWorkshopPaymentReconcile = async () => {
  const db = getFirestore();
  const MIN_AGE_MS = 2 * 60 * 1000; // give the client verify a head start
  const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // ignore abandoned checkouts
  const now = Date.now();

  const snap = await db
    .collection(WS_ORDER_COLLECTION)
    .where("consumed", "==", false)
    .limit(300)
    .get();
  if (snap.empty) {
    console.log("runWorkshopPaymentReconcile: nothing to reconcile");
    return { recovered: 0, closed: 0, skipped: 0, failed: 0, scanned: 0 };
  }

    // Cache one Razorpay client + workshop config per workshop across the run.
    const configCache = {};
    let recovered = 0;
    let skipped = 0;
    let closed = 0;
    let failed = 0;

    for (const orderDoc of snap.docs) {
      const o = orderDoc.data() || {};
      const created = o.created && o.created.toDate ? o.created.toDate() : null;
      const ageMs = created ? now - created.getTime() : null;
      // Too new: let the client's own verify win first.
      if (ageMs != null && ageMs < MIN_AGE_MS) {
        skipped++;
        continue;
      }
      const workshopId = o.workshopid;
      const profileId = o.profileid;
      const uid = o.uid;
      if (!workshopId || !profileId || !uid) {
        skipped++;
        continue;
      }
      try {
        let cfg = configCache[workshopId];
        if (cfg === undefined) {
          try {
            const loaded = await loadWorkshopPaymentConfig(db, workshopId);
            cfg = {
              workshopData: loaded.workshopData,
              workshopRef: loaded.workshopRef,
              razorpay: new Razorpay({
                key_id: loaded.keyId,
                key_secret: loaded.keySecret,
              }),
            };
          } catch (error) {
            console.warn(
              `runWorkshopPaymentReconcile: config load failed for workshop ` +
                `${workshopId}: ${error.message}`
            );
            cfg = null; // remember the failure so we don't retry it this run
          }
          configCache[workshopId] = cfg;
        }
        if (!cfg) {
          skipped++;
          continue;
        }
        const orderId = o.orderid || orderDoc.id;
        const amountPaise = Number(o.amount);
        const reconciled =
          await reconcileOrderPayment(cfg.razorpay, orderId, amountPaise);

        if (reconciled.status === "error") {
          // Razorpay lookup failed — order state unknown; retry next run.
          skipped++;
          continue;
        }
        if (reconciled.status === "none") {
          // Authoritatively unpaid. Once it is older than the max age it will
          // never be paid (an abandoned checkout), so finalise it — this keeps
          // the `consumed == false` working set bounded so real orphans are
          // never crowded out of the limited sweep. Younger ones are left to
          // retry (a capture could still land).
          if (ageMs != null && ageMs > MAX_AGE_MS) {
            await orderDoc.ref.set(
              {
                consumed: true,
                abandoned: true,
                abandonedat: FieldValue.serverTimestamp(),
                settledsource: "expired-unpaid",
              },
              { merge: true }
            );
            closed++;
          } else {
            skipped++;
          }
          continue;
        }

        // status === "settleable"
        const payment = reconciled.payment;
        // Same evergreen queue decision as the client/reconcile path.
        const waiting = await resolveRecoveryWaiting(
          db,
          cfg.workshopData,
          workshopId,
          profileId
        );
        await settleWorkshopPayment(db, {
          workshopData: cfg.workshopData,
          workshopRef: cfg.workshopRef,
          orderRef: orderDoc.ref,
          profileId,
          uid,
          orderId,
          paymentId: payment.id,
          payment,
          device: { recovered: "sweep" },
          waiting,
          source: "sweep",
        });
        recovered++;
        console.log(
          `runWorkshopPaymentReconcile: recovered order ${orderId} for ` +
            `workshop ${workshopId} profile ${profileId}`
        );
      } catch (error) {
        failed++;
        console.error(
          `runWorkshopPaymentReconcile: order ${orderDoc.id} failed: ` +
            `${error.message}`
        );
      }
    }

    console.log(
      `runWorkshopPaymentReconcile: done — ${recovered} recovered, ` +
        `${closed} closed, ${skipped} skipped, ${failed} failed of ` +
        `${snap.size}`
    );
    return { recovered, closed, skipped, failed, scanned: snap.size };
};

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

function sendwatitonewusers(){
  
}