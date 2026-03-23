const commonService = require('./service');
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const admin = require('firebase-admin');
const { Buffer } = require('buffer');

exports.workshopconfiguration = onDocumentUpdated(
  {
    document: "/workshopconfiguration/{docid}",
    memory: "512MiB",
    timeoutSeconds: 300
  },
  async (snapshotdata) => {
// exports.workshopconfiguration = onDocumentUpdated("/workshopconfiguration/{docid}", async (snapshotdata) => {
  var snapshot = snapshotdata.data;
  var oldData = snapshot.before.data();
  var newData = snapshot.after.data();
  if (newData.triggerFunction !== true) return;
  const db = admin.firestore();
  try {
    const workshopRef = snapshot.after.ref;
    const changes = {};
    for (const key of Object.keys(newData)) {
      if (JSON.stringify(newData[key]) !== JSON.stringify(oldData[key])) {
        changes[key] = newData[key];
      }
    }
    if (Object.keys(changes).length === 0) {
      console.log("No changes");
      return;
    }
    const participantWorkshopdoc = await db.collection('participant workshop').where('workshopref', '==', workshopRef).get();
    if (participantWorkshopdoc.empty) {
      console.log("No participants found");
      return;
    }
    const batch = db.batch();
    participantWorkshopdoc.forEach(participantDoc => {
      const participantData = participantDoc.data();
      const finalChanges = { ...changes };
      if (changes.challenges && participantData.challenges) {
        const participantOuterMap = {};
        (participantData.challenges || []).forEach(participantChallenge => {
          if (participantChallenge.challengeid) {
            participantOuterMap[participantChallenge.challengeid] = participantChallenge;
          }
        });
        finalChanges.challenges = changes.challenges.map((workshopdoc) => {
          const matchedParticipantItem = workshopdoc.challengeid ? (participantOuterMap[workshopdoc.challengeid] || null) : null;
          const mergedItem = { ...workshopdoc };
          if (matchedParticipantItem) {
            Object.keys(matchedParticipantItem).forEach(key => {
              if (key === 'challenges') return;
              if (!(key in workshopdoc)) {
                mergedItem[key] = matchedParticipantItem[key];
              }
            });
          }
          if (workshopdoc.challenges && Array.isArray(workshopdoc.challenges)) {
            const participantInnerMap = {};
            ((matchedParticipantItem && matchedParticipantItem.challenges) || []).forEach(participantInnerChallenge => {
              if (participantInnerChallenge.challengeid) {
                participantInnerMap[participantInnerChallenge.challengeid] = participantInnerChallenge;
              }
            });
            const hasNewInnerChallenge = workshopdoc.challenges.some(workshopConfigChallenge =>
              !workshopConfigChallenge.challengeid || !participantInnerMap[workshopConfigChallenge.challengeid]
            );

            if (hasNewInnerChallenge && mergedItem.status === 'completed') {
              delete mergedItem.status;
            }
            mergedItem.challenges = workshopdoc.challenges.map((workshopConfigChallenge) => {
              const matchedInner = workshopConfigChallenge.challengeid ? (participantInnerMap[workshopConfigChallenge.challengeid] || null) : null;
              const mergedChallenge = { ...workshopConfigChallenge };
              if (matchedInner) {
                Object.keys(matchedInner).forEach(key => {
                  if (!(key in workshopConfigChallenge)) {
                    mergedChallenge[key] = matchedInner[key];
                  }
                });
              }
              return mergedChallenge;
            });
          }
          return mergedItem;
        });
      }
      batch.set(participantDoc.ref, finalChanges, { merge: true });
    });

    await batch.commit();
    console.log('Updated');
  } catch (error) {
    console.error("Error:", error);
  }
});