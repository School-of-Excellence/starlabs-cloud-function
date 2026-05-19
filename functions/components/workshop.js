const commonService = require('./service');
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require('firebase-admin');
const { Buffer } = require('buffer');
const axios = require('axios');

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