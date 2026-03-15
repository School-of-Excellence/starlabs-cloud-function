const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const commonService = require("./service");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");

var IncomingWebhook = require('@slack/client').IncomingWebhook; // Slack Webhook
const axios = require("axios");

exports.ticketfromwebsite = onRequest(async (req,res) => {
  console.log("Data", req.body);
  
  let profileData = {};
  let issueData = req.body;
  
  await admin.firestore().collection("profile_data").where("email","==",issueData['email']).limit(1).get().then((profiledoc)=>{
    if(profiledoc.docs.length != 0){
      console.log("PROFILE FOUND...:)");
      profileData = profiledoc.docs[0].data();
    }else{
      console.log("NO PROFILE FOUND... :(");
    }
  });

  if(Object.keys(profileData).length != 0){
    
    var issuenumber;
    let files = [];
    const id = admin.firestore().collection("clientissue").doc().id;
    const selectedClientId = profileData['profileid'];
    const clientName = profileData['name'];
    let currentjourney = '';
    let assignedTo = [];

    await admin.firestore().collection('clientissue').orderBy("issueno","desc").get().then((tickets)=>{
      if(tickets.docs.length != 0) {
        issuenumber = tickets.docs[0].data()['issueno'] + 1;
      } else {
        issuenumber = 1001;
      }
    });

    console.log("ISSUE NO",issuenumber);

    await admin.firestore().collection('participantjourneyproduct').where("profileid","==",selectedClientId).where("journeystatus","in",["ongoing","initiated","completed"]).get().then((journey)=>{
      if(journey.docs.length != 0){
        console.log("JOURNEY FOUND.. :)");
        currentjourney = [null,undefined,""].includes(journey.docs[0].data()['journeyref']) ? null : journey.docs[0].data()['journeyref'];
      }else{
        console.log("JOURNEY NOT FOUND.. :(");
      }
    });

    await admin.firestore().collection('chat config').get().then((chatConfig) => {
      if(chatConfig.docs.length != 0){
        let categories = chatConfig.docs[0].data()['categories'];
        assignedTo = categories.filter((e)=>e['category'].toLowerCase() == issueData['category'].toLowerCase())[0]['assignto']
      }
    });

    if(![null,undefined,''].includes(issueData['attachement'])){
      const match = issueData['attachement'].match(/-ff-(.*)/);
      if (match) {
        console.log("FILENAME",match[1]);
        const filename = match[1];
        let uploadedFileurl = await commonService.uploadImageFromUrl(issueData['attachement'],filename)
        console.log("Uploaded file URL:", uploadedFileurl);
        files.push({
          filename:filename,
          filetype:filename.split('.').pop(),
          fileurl:[null,undefined,""].includes(uploadedFileurl) ? null : uploadedFileurl,
          mediatype: ['jpg','jpeg','gif','png','bmp'].includes(filename.split('.').pop()) ?
          'image' : ['mp3','wav','ogg','wma','mka','m4a','ra','mid','midi'].includes(filename.split('.').pop()) ?
          'audio' : ['avi','divx','flv','mov','ogv','mkv','mp4','m4v','mpg','mpeg','mpe'].includes(filename.split('.').pop()) ?
          'video' : ['pdf','doc','ppt','pps','xls','mdb','docx','xlsx','pptx','odt','odp','ods','odg','odc','odb'].includes(filename.split('.').pop()) ?
          'application' : null,
        });                      
      }
    }

    const status = {
      status : 'open',
      date: admin.firestore.FieldValue.serverTimestamp(),
      editedBy: selectedClientId
    }

    const currentTime = admin.firestore.FieldValue.serverTimestamp();  
    var record = {
      id:id,
      issueno: issuenumber,
      clientid: selectedClientId,
      chatstatus: "New",
      priority: "",
      name: clientName,
      reporteddate: currentTime,
      journey: currentjourney,
      reportedBy: selectedClientId,
      assign: assignedTo,
      issue: issueData['issue'],
      category: issueData['category'],
      subcategory:null,
      status: status,
      last_modification: currentTime,
      issueReportedBy: selectedClientId,
      email: profileData['email'],
      mobile: profileData['number'],
      mandatereview: {},
      review:{},
      notes:[],
      files:files,
      ticketfrom:"website"
    }

    await admin.firestore().doc('/clientissue/'+id).set(record, {merge: true}).then(() => {
      console.log("Ticket Generated Successfully")
    }).then(async ()=>{

      let firstMsgRef = admin.firestore().collection('clientissue').doc(id).collection('messages').doc();

      var firstMessage = {
        "time": admin.firestore.FieldValue.serverTimestamp(),
        "message": issueData['issue'],
        "messageid": firstMsgRef.id,
        "issueno":issuenumber,
        "sender_profileid": selectedClientId,
        "sender_email": profileData['email'],
        "sender_uid": [null,undefined,''].includes(profileData['user_ref']) ? null : profileData['user_ref'].id,
        "pending": ["user"],
        "read_by": ["admin"],
        "links": [],
        "files": files,
        "ticketid" : id,
        "type":"chat",
      }

      firstMsgRef.set(firstMessage).then(async()=>{
        console.log('MESSAGE SENT SUCCESSFULLY');
        res.send("success");
      }).catch((error)=>{
        console.log('OOPS ERROR WHILE SENDING MESSAGE',error);
        res.send("Error");
      });

    }).catch(error => {
      res.send("Error");
      console.error("OOPS ERROR WHILE GENERATING TICKET",error);
    });
  }
});

exports.ticketMsgNotification = onDocumentCreated('/clientissue/{docid}/messages/{messageid}', async (snapShot) => {
  let ticketMsgData = snapShot.data.data();
  let clientissueDocid = snapShot.data.ref.path.split("/")[1];
  let ticketData = {};
  console.log("Ticket Data",ticketMsgData);
  
  //fetching clientissue doc
  await admin.firestore().collection("clientissue").doc(clientissueDocid).get().then(async(ticketdoc)=>{
    ticketData = ticketdoc.data();
  });

  if(![null,undefined].includes(ticketMsgData['sender_uid'])){
    console.log("Senderuid",ticketMsgData['sender_uid']);
    
    let ParticipantNotification = ticketMsgData['pending'].includes('user') && ticketMsgData['read_by'].includes('admin');
    let adminNotification = ticketMsgData['pending'].includes('admin') && ticketMsgData['read_by'].includes('user')
    console.log('participant',ParticipantNotification);
    console.log('admin',adminNotification);
    
    if(ParticipantNotification){
      console.log("Notification Sending to USER");
      // await sendPushNotification(
      //   ticketData['clientid'],
      //   ticketData['id'],
      //   "Ticket No :" + ticketData['issueno'],
      //   ticketMsgData['message'],
      //   null,
      // );
      await commonService.saveNotificationRecord({
        title: "Ticket No :" + ticketData['issueno'],
        message: ticketMsgData['message'],
        subtitle: null,
        date: admin.firestore.FieldValue.serverTimestamp(),
        landingpage: null,
        logged: false,
        profileid: [ticketData['clientid']],
        sticky: false,
        notificationtype: "supportticket",
        notificationimage: null,
        metadata: {
          ticketid: ticketData['id'],
          messageid: snapShot.data.id
        }
      });
    }
    if(adminNotification){
      console.log("Notification Sending to ADMIN");
      // for (let i = 0; i < ticketData['assign'].length; i++) {
      //   const assignedAdmin = ticketData['assign'][i];
      //   await sendPushNotification(
      //     ticketData[assignedAdmin],
      //     ticketData['id'],
      //     "Ticket No :" + ticketData['issueno'],
      //     ticketMsgData['message'],
      //     null,
      //   );
      // }

      const notifyProfiles = Array.from(
        new Set([
          ...(ticketData.assign || []),
          ...(ticketData.peopleinvolved || [])
        ])
      ).filter(Boolean);
      await commonService.saveNotificationRecord({
        title: "Ticket No :" + ticketData['issueno'],
        message: ticketMsgData['message'],
        subtitle: null,
        date: admin.firestore.FieldValue.serverTimestamp(),
        landingpage: null,
        logged: false,
        profileid: notifyProfiles,
        sticky: false,
        notificationtype: "supportticket",
        notificationimage: null,
        metadata: {
          ticketid: ticketData['id'],
          messageid: snapShot.data.id
        }
      });
    }

  }
});

exports.slackCustomerSupport = onDocumentWritten("clientissue/{id}",async (change)=>{
  const beforeData = change.data.before.exists ? change.data.before.data() : null;
  const afterData = change.data.after.exists ? change.data.after.data() : null;
  if( beforeData == null || beforeData['status']['status'].toLowerCase() != afterData['status']['status'].toLowerCase() || beforeData != null && beforeData['category'] != afterData['category']) {

    if(afterData['status']['status'].toLowerCase() == 'closed'){
      console.log("Sending Notification To Participant")
      // await sendPushNotification(
      //   afterData['clientid'],
      //   afterData['id'],
      //   "Ticket No : " +afterData['issueno'],
      //   "This Ticket has been Resolved",
      //   null
      // )
      await commonService.saveNotificationRecord({
        title: "Ticket No :" + afterData['issueno'],
        message: "This Ticket has been Resolved",
        subtitle: null,
        date: admin.firestore.FieldValue.serverTimestamp(),
        landingpage: null,
        logged: false,
        profileid: afterData["assign"],
        sticky: false,
        notificationtype: "supportticket",
        notificationimage: null,
        metadata: {
          ticketid: afterData['id'],
          messageid: change.data.after.id
        }
      });
    }

    var reportedby;
    var assignedto = [];
    var status = beforeData == null ? afterData['status']['status'] : `From ${beforeData['status']['status']} To ${afterData['status']['status']}`;
    var category = beforeData != null && beforeData['category'] != afterData['category'] ? `From ${'*'+beforeData['category']+"*"} To ${"*"+afterData['category']+"*"}` : "*"+afterData['category']+"*";
    await admin.firestore().collection("profile_data").doc(afterData["reportedBy"]).get().then(profile=>{
      reportedby = profile.data()["name"]
    }).catch(e => {console.log(e)})
    for (let i = 0; i < afterData["assign"].length; i++) {
      const element = afterData["assign"][i];
      await admin.firestore().collection("profile_data").doc(element).get().then(profile=>{
        assignedto.push(profile.data()["name"])
      }).catch(e => {console.log(e)})
    }
    var url
      if(commonService.production){
        url = commonService.slackTicketingSystem // Production
      }
      else{
        url = commonService.slackDevTest // Test
      }
    var webhook = new IncomingWebhook(url);

    let message = {
      "blocks" : [
        {
          "type" : "divider"
        },
        {
          "type": "header",
          "text": {
            "type": "plain_text",
            "text": `Ticket Captured : ${afterData['issueno'].toString()}`
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*Client Name* : ${afterData['name']}`
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*Reported Date* : ${afterData['reporteddate'].toDate().toDateString()}`
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*Reported By* : ${reportedby}`
          }
        },         
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*Category* : ${category}`
          }
        },        
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*Assigned To* : ${assignedto.join(', ')}`
          }
        },        
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*Status* : ${status}`
          }
        },        
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*Issue* : ${afterData['issue']}`
          }
        },
      ]
    }
    await webhook.send(message, function(err, header, statusCode, body) {
      if (err) {
        console.log('Error:', err);
      } else {
        console.log('Received', statusCode, 'from Slack');
      }
    });
  }
});

//harish
// exports.ticketCreated = onDocumentCreated("clientissue/{id}", async(snap)=>{
//     var ticket = snap.data
//     const ticketData = ticket.data();
//     const secondMessageDocId = admin.firestore().collection("messages").doc().id;
//     let mapProfile = {};
//     console.log(ticketData,"ticketData");
    
//     //Fetch All participants to ProfileData Map
//     await admin.firestore().collection("profile_data").get().then((profiledoc)=>{
//       for (let index = 0; index < profiledoc.docs.length; index++) {
//         const profileDoc = profiledoc.docs[index];
//         mapProfile[profileDoc.id] = profileDoc.data();
//       }
//     });
  
//     // Fetching Chat Configuration Data
//     let chatConfigData = {}
//     await admin.firestore().collection("chat config").get().then((chatdoc)=>{
//       chatConfigData = chatdoc.docs[0].data();
//     });
  
//     let firstMsg = {};
//     await admin.firestore().collection("clientissue").doc(ticketData['id']).collection("messages").orderBy("time","desc").get().then(async(chatMsgdoc)=>{
//       if(chatMsgdoc.docs.length != 0){
  
//         firstMsg = chatMsgdoc.docs[0].data();
  
//         // This Document is to show the Predefined Msg in the Ticket Chat
//         await admin.firestore().collection("clientissue").doc(ticketData['id']).collection("messages").doc(secondMessageDocId).set({
//           files:[null,undefined,''].includes(ticketData['files']) ? [] : ticketData['files'],
//           links:[],
//           message:chatConfigData['messages'][0]['message'],
//           messageid:secondMessageDocId,
//           pending:['user'],
//           read_by:['admin'],
//           sender_email:mapProfile[ticketData['assign'][0]]['email'],
//           sender_profileid:ticketData['assign'][0],
//           sender_uid:[null,undefined].includes(mapProfile[ticketData['assign'][0]]['user_ref'].id) ? null : mapProfile[ticketData['assign'][0]]['user_ref'].id,
//           time: new Date(firstMsg['time'].toDate().getTime() + 15 * 1000),
//           notification:false,
//           type:"automated",
//           ticketid:ticketData['id'],
//           clientid : ticketData['clientid']
//         }).then(()=>{
//           console.log("Second Msg Sent Successfully");
//         }).catch((error)=>{
//           console.log("Oops Something went wrong while Sending Second Msg",error);
//         });
  
//       }else{
//         console.log("Ticket First Chat Not Sent...:(");
//       }
//     });
// });

exports.ticketCreated = onDocumentCreated("clientissue/{id}", async (snap) => {
  const ticket = snap.data;
  const ticketData = ticket.data();
  const ticketId = ticketData['id'];

  const ticketRef = admin.firestore().collection("clientissue").doc(ticketId);

  await ticketRef.update({
    chatstatus: "New"
  });

  let mapProfile = {};
  try {
    const profileSnapshot = await admin.firestore().collection("profile_data").get();
    profileSnapshot.docs.forEach((profileDoc) => {
      mapProfile[profileDoc.id] = profileDoc.data();
    });
    console.log("Profile data loaded:");
  } catch (error) {
    console.error("Error fetching profile data:", error);
    return;
  }

  let chatConfigData = {};
  try {
    const chatConfigSnapshot = await admin.firestore().collection("chat config").get();
    if (chatConfigSnapshot.docs.length > 0) {
      chatConfigData = chatConfigSnapshot.docs[0].data();
      console.log("Chat config loaded");
    } else {
      console.warn("No chat config found");
    }
  } catch (error) {
    console.error("Error fetching chat config:", error);
    return;
  }

  try {
    const messagesSnapshot = await admin.firestore()
      .collection("clientissue")
      .doc(ticketId)
      .collection("messages")
      .orderBy("time", "asc")
      .get();

    const messageCount = messagesSnapshot.docs.length;
    console.log("Current message count:", messageCount);

    if (messageCount === 0) {
      console.log("Creating first message");

      const firstMessageId = admin.firestore().collection("clientissue").doc().id;
      const firstMsgRef = admin.firestore()
        .collection("clientissue")
        .doc(ticketId)
        .collection("messages")
        .doc(firstMessageId);

      // Extract links from issue text (same pattern as Angular)
      const linkPattern = /https?:\/\/[^\s]+/g;
      const issueText = ticketData['issue'] || '';
      const extractedLinks = (issueText.match(linkPattern) || []).map(link => link.trim());

      // Get client profile data
      const clientId = ticketData['clientid'];
      const clientProfile = mapProfile[clientId] || {};

      const firstMessage = {
        time: new Date(),
        message: ticketData['issue'],
        messageid: firstMessageId,
        issueno: ticketData['issueno'],
        sender_profileid: ticketData['clientid'],
        sender_email: clientProfile['email'] || null,
        sender_uid: null,
        pending: ["user"],
        read_by: ["admin"],
        links: extractedLinks,
        files: ticketData['files'] ?? [],
        ticketid: ticketData['id'],
        type: "chat"
      };

      await firstMsgRef.set(firstMessage);
      console.log("First message created successfully:", firstMessageId);

      // After creating first message, create second message
      await createSecondMessage(ticketId, ticketData, mapProfile, chatConfigData, new Date());

    } else if (messageCount === 1) {
      console.log("Creating second message (automated response)...");

      const firstMsg = messagesSnapshot.docs[0].data();
      const firstMsgTime = firstMsg['time']?.toDate ? firstMsg['time'].toDate() : new Date();

      await createSecondMessage(ticketId, ticketData, mapProfile, chatConfigData, firstMsgTime);

    } else {
      console.log("Messages already exist, skipping message creation");
    }

  } catch (error) {
    console.error("Error processing messages:", error);
  }
});

async function createSecondMessage(ticketId, ticketData, mapProfile, chatConfigData, firstMsgTime) {
  try {
    const secondMessageId = admin.firestore().collection("clientissue").doc().id;
    const secondMsgRef = admin.firestore()
      .collection("clientissue")
      .doc(ticketId)
      .collection("messages")
      .doc(secondMessageId);

    // Get assigned user's profile
    const assignedUserId = ticketData['assign']?.[0];
    const assignedProfile = mapProfile[assignedUserId] || {};

    // Get automated message from config
    const automatedMessage = chatConfigData['messages']?.[0]?.['message'] || 'Thank you for reaching out. We will get back to you shortly.';

    // Calculate time offset (15 seconds after first message)
    const secondMsgTime = new Date(firstMsgTime.getTime() + 15 * 1000);

    const secondMessage = {
      files: [],
      links: [],
      message: automatedMessage,
      messageid: secondMessageId,
      pending: ['user'],
      read_by: ['admin'],
      sender_email: assignedProfile['email'] || null,
      sender_profileid: assignedUserId || null,
      sender_uid: assignedProfile['user_ref']?.id || null,
      time: secondMsgTime,
      notification: false,
      type: "automated",
      ticketid: ticketId,
      clientid: ticketData['clientid']
    };

    await secondMsgRef.set(secondMessage);
    console.log("Second message (automated) created successfully:", secondMessageId);

  } catch (error) {
    console.error("Error creating second message:", error);
    throw error;
  }
}

exports.ticketCreatedV2 = onDocumentCreated("clientissue/{id}", async (snap) => {
  const ticket = snap.data;
  const ticketData = ticket.data();
  const ticketRef = ticket.ref;
  const ticketId = snap.params.id;

  console.log("Ticket Data:", ticketData);

  try {
    const counterRef = admin.firestore().collection('counters').doc('ticketCounter');

    const ticketNumber = await admin.firestore().runTransaction(async (transaction) => {
      const counterDoc = await transaction.get(counterRef);
      let nextNumber;

      if (!counterDoc.exists) {
        nextNumber = 1001;
        transaction.set(counterRef, { currentNumber: nextNumber });
      } else {
        const data = counterDoc.data();
        nextNumber = (data.currentNumber || 1000) + 1;
        transaction.update(counterRef, { currentNumber: nextNumber });
      }

      return nextNumber;
    });

    console.log(`Ticket number generated: ${ticketNumber}`);

    const profileSnapshot = await admin.firestore().collection("profile_data").get();
    const mapProfile = {};
    profileSnapshot.docs.forEach((doc) => {
      mapProfile[doc.id] = doc.data();
    });

    const chatConfigSnapshot = await admin.firestore().collection("chat config").get();
    if (chatConfigSnapshot.empty) {
      console.log("No chat config found");
      return null;
    }
    const chatConfigData = chatConfigSnapshot.docs[0].data();

    const messagesSnapshot = await admin.firestore()
      .collection("clientissue")
      .doc(ticketId)
      .collection("messages")
      .orderBy("time", "desc")
      .get();

    if (messagesSnapshot.empty) {
      console.log("Ticket First Chat Not Sent... :(");
      return null;
    }

    const firstMsg = messagesSnapshot.docs[0].data();
    const firstMsgRef = messagesSnapshot.docs[0].ref;

    const assignedProfile = mapProfile[ticketData['assign'][0]];
    if (!assignedProfile) {
      console.log("Assigned profile not found");
      return null;
    }

    const secondMessageId = admin.firestore().collection("clientissue").doc().id;
    const secondMessageRef = admin.firestore()
      .collection("clientissue")
      .doc(ticketId)
      .collection("messages")
      .doc(secondMessageId);

    const secondMessageData = {
      files: [null, undefined, ''].includes(ticketData['files']) ? [] : ticketData['files'],
      links: [],
      message: chatConfigData['messages'][0]['message'],
      messageid: secondMessageId,
      issueno: ticketNumber,
      pending: ['user'],
      read_by: ['admin'],
      sender_email: assignedProfile['email'],
      sender_profileid: ticketData['assign'][0],
      sender_uid: assignedProfile['user_ref']?.id || null,
      time: new Date(firstMsg['time'].toDate().getTime() + 15 * 1000),
      notification: false,
      type: "automated",
      ticketid: ticketId,
      clientid: ticketData['clientid']
    };

    const batch = admin.firestore().batch();

    batch.update(ticketRef, { issueno: ticketNumber });
    batch.update(firstMsgRef, { issueno: ticketNumber });
    batch.set(secondMessageRef, secondMessageData);

    await batch.commit();

    console.log("Ticket created successfully:", {
      ticketId,
      ticketNumber,
      firstMessageUpdated: true,
      secondMessageCreated: true
    });

    return { success: true, ticketNumber };

  } catch (error) {
    console.error("Error in ticketCreatedV2:", error);
    return { success: false, error: error.message };
  }
});

// Auto-close tickets - Runs daily at 6 AM IST
exports.autoCloseTickets = onSchedule({
  schedule: "0 6 * * *",
  timeZone: "Asia/Kolkata",
}, async (context) => {
  console.log("Running auto-close tickets job at 6 AM IST...");
  const now = new Date();
  now.setHours(6, 0, 0, 0);

  const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
  const utcTime = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
  const istTime = new Date(utcTime + istOffset);
  istTime.setHours(6, 0, 0, 0);
  
  // Convert back to UTC for storing in Firestore
  const istSixAM = new Date(istTime.getTime() - istOffset);

  try {
    // Fetch chat config and profiles in parallel
    const [chatConfigSnapshot, profileSnapshot] = await Promise.all([
      admin.firestore().collection("chat config").get(),
      admin.firestore().collection("profile_data").get()
    ]);

    if (chatConfigSnapshot.empty) {
      console.log("No chat config found");
      return null;
    }

    const chatConfigData = chatConfigSnapshot.docs[0].data();
    const warningMessageText = chatConfigData['warningmessages'][0]['message'];
    const closingMessageText = chatConfigData['closingmessages'][0]['message'];

    // Create profile map
    const mapProfile = {};
    profileSnapshot.docs.forEach(doc => mapProfile[doc.id] = doc.data());

    // Get open tickets with Responded status
    const ticketsSnapshot = await admin.firestore().collection("clientissue")
      .where("chatstatus", "==", "Responded")
      .where("status.status", "==", "Open")
      .get();
    console.log(`Found ${ticketsSnapshot.size} tickets`);

    for (const ticketDoc of ticketsSnapshot.docs) {
      const ticket = ticketDoc.data();
      const ticketId = ticketDoc.id;

      // Get last message
      const messagesSnapshot = await admin.firestore().collection("clientissue").doc(ticketId).collection("messages").orderBy("time", "desc").limit(1).get();
      if (messagesSnapshot.empty) continue;
      const lastMessage = messagesSnapshot.docs[0].data();
      const lastMessageTime = lastMessage.time?.toDate();
      const warningFlag = lastMessage.warningMessage ?? null;

      if (!lastMessageTime) continue;

      // Get assigned profile
      const assignedProfileId = ticket.assign?.[0];
      const assignedProfile = assignedProfileId ? mapProfile[assignedProfileId] : null;
      if (!assignedProfile) continue;
      const hoursSinceLastMessage = (now - lastMessageTime) / (1000 * 60 * 60);
      const daysSinceLastMessage = Math.floor(hoursSinceLastMessage / 24);

      // Day 6 - Close ticket (if warningMessage is true AND 24+ hrs passed)
      if (warningFlag && hoursSinceLastMessage >= 24) {
        await sendAutoMessage(ticketId, ticket, assignedProfileId, assignedProfile, closingMessageText, 'closing', istSixAM);
        continue;
      }

      // Day 5 - Send warning (if 4+ days passed)
      if (daysSinceLastMessage > 3) {
        await sendAutoMessage(ticketId, ticket, assignedProfileId, assignedProfile, warningMessageText, 'warning', istSixAM);
        continue;
      }
    }
    console.log("Auto-close tickets job completed");
    return null;
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
});

// Function for sending messages
async function sendAutoMessage(ticketId, ticket, assignedProfileId, assignedProfile, messageText, type, time) {
  const messageId = admin.firestore().collection("clientissue").doc().id;
  const ticketRef = admin.firestore().collection("clientissue").doc(ticketId);
  // Add message
  await ticketRef.collection("messages").doc(messageId).set({
    files: [],
    links: [],
    message: messageText,
    messageid: messageId,
    issueno: ticket.issueno,
    pending: ['user'],
    read_by: ['admin'],
    sender_email: assignedProfile['email'],
    sender_profileid: assignedProfileId,
    sender_uid: assignedProfile?.user_ref?.id || null,
    time: time,
    notification: false,
    type: "automated",
    ticketid: ticketId,
    clientid: ticket.clientid,
    warningMessage: type === 'warning' ? true : false
  });
  // Update ticket
  const updateData = type === 'warning'
    ? {
      last_modification: admin.firestore.FieldValue.serverTimestamp()
    }
    : {
      status: { status: "Closed", date: admin.firestore.FieldValue.serverTimestamp(), editedBy: assignedProfileId },
      last_modification: admin.firestore.FieldValue.serverTimestamp()
    };
  await ticketRef.update(updateData);
}

//customer support status update cloud functions
exports.dashboardcustomersupport = onDocumentWritten("clientissue/{id}", async (change) => {
  const olddoc = change.data.before.exists ? change.data.before.data() : null;
  const newdoc = change.data.after.exists ? change.data.after.data() : null;
  const profileid = (newdoc?.clientid || olddoc?.clientid) || null;
  
  let errorData = {
    profileid: profileid,
    triggerdoc: change.data.after.ref.path,
  };

  let mapProfile = {};
  
  // Get profile data
  await admin.firestore().collection("profile_data").get().then((profileSnapshot) => {
    if (profileSnapshot.docs.length > 0) {
      for (let i = 0; i < profileSnapshot.docs.length; i++) {
        const profile = profileSnapshot.docs[i];
        mapProfile[profile.id] = profile.data();
      }
      console.log("Profiles Mapped");
    } else {
      console.log("No profiles found in profile_data collection");
    }
  });

  if (![null, undefined, ""].includes(newdoc)) {
    if ([null, undefined, ""].includes(olddoc) && ![null, undefined, ""].includes(newdoc)) {
      console.log("NEWDOC");
    }
    if (![null, undefined, ""].includes(olddoc) && ![null, undefined, ""].includes(newdoc)) {
      console.log("UPDATING");
    }

    // Send Data to Watson
    try {
      let url = '';
      let salescrmurl = '';
      if (commonService.production) {
        url = "https://us-central1-watsonproduction-becde.cloudfunctions.net/support_tickets";
        salescrmurl = "https://us-central1-salesleadcrm.cloudfunctions.net/updatepersonfromstarlabs";
      } else {
        url = "https://us-central1-watson-test-19.cloudfunctions.net/support_tickets";
        salescrmurl = "https://us-central1-salescrm-test-19.cloudfunctions.net/updatepersonfromstarlabs";
      }

      // Clean Firestore data for JSON serialization
      const cleanFirestoreData = (obj) => {
        if (obj === null || obj === undefined) return obj;
        
        if (Array.isArray(obj)) {
          return obj.map(item => cleanFirestoreData(item));
        }
        
        if (typeof obj === 'object') {
          // Handle Firestore Timestamp
          if (obj._seconds !== undefined) {
            return new Date(obj._seconds * 1000).toISOString();
          }
          
          // Handle Firestore DocumentReference
          if (obj._path && obj._path.segments) {
            return obj._path.segments[obj._path.segments.length - 1]; // Just return the ID
          }
          
          // Handle regular objects
          const cleaned = {};
          for (const [key, value] of Object.entries(obj)) {
            cleaned[key] = cleanFirestoreData(value);
          }
          return cleaned;
        }
        
        return obj;
      };

      // Create a clean copy of ticket data
      var ticketdata = cleanFirestoreData({ ...newdoc });
      ticketdata.profileid = profileid;
      
      // Remove any remaining problematic fields
      delete ticketdata._firestore;
      delete ticketdata._path;
      delete ticketdata._converter;

      let assignArray = [];
      let peopleInvolved = [];

      console.log("url", url);
      console.log("Original Ticket Data Keys:", Object.keys(newdoc));

      // Process assign array
      if (![null, undefined, ""].includes(ticketdata['assign']) && Array.isArray(ticketdata['assign']) && ticketdata['assign'].length !== 0) {
        ticketdata['assign'].forEach(element => { 
          if (mapProfile[element] && mapProfile[element]['name']) {
            assignArray.push(mapProfile[element]['name']);
          } else {
            console.warn(`Profile not found for assign ID: ${element}`);
          }
        });
      }

      // Process people involved array
      if (![null, undefined, ""].includes(ticketdata['peopleinvolved']) && Array.isArray(ticketdata['peopleinvolved']) && ticketdata['peopleinvolved'].length !== 0) {
        ticketdata['peopleinvolved'].forEach(element => { 
          if (mapProfile[element] && mapProfile[element]['name']) {
            peopleInvolved.push(mapProfile[element]['name']);
          } else {
            console.warn(`Profile not found for peopleinvolved ID: ${element}`);
          }
        });
      }
      //clientid
      ticketdata['assign'] = assignArray;
      ticketdata['peopleinvolved'] = peopleInvolved;

      // Validate JSON serialization
      try {
        const jsonString = JSON.stringify(ticketdata);
        console.log("JSON serialization successful, payload size:", jsonString.length);
        console.log("Final ticket data structure:", JSON.stringify(ticketdata, null, 2));
      } catch (jsonError) {
        console.error("JSON serialization failed:", jsonError);
        throw new Error("Data contains non-serializable content: " + jsonError.message);
      }

      // Send request with enhanced error handling
      try {
        const response = await axios({
          method: 'post',
          url: url,
          data: ticketdata,
          timeout: 30000, // 30 second timeout
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          validateStatus: function (status) {
            return status < 600; // Don't throw on 4xx or 5xx, let us handle it
          }
        });

        const salescrmresponse = await axios({
          method: 'post',
          url: salescrmurl,
          data: ticketdata,
          timeout: 30000, // 30 second timeout
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          validateStatus: function (status) {
            return status < 600; // Don't throw on 4xx or 5xx, let us handle it
          }
        });

        if (salescrmresponse.status >= 400) {
          throw new Error(`SalesCRM HTTP ${salescrmresponse.status}`);
        }

        if (response.status >= 400) {
          console.error('HTTP Error Response Details:', {
            status: response.status,
            statusText: response.statusText,
            responseData: response.data,
            responseHeaders: response.headers,
            requestUrl: url,
            requestData: ticketdata
          });
          
          errorData = {
            failed: "HTTP error from support_tickets endpoint",
            httpStatus: response.status,
            httpStatusText: response.statusText,
            responseData: response.data,
            err: `HTTP ${response.status}: ${response.statusText}`
          };
          await throwParticipantMetaDataException(errorData);
          return; // Exit early on HTTP error
        }

        console.log('Successfully posted ticket data to support_tickets endpoint. Status:', response.status);
        
      } catch (axiosError) {
        // Detailed error logging
        console.error('Detailed Axios Error Information:', {
          message: axiosError.message,
          code: axiosError.code,
          response: axiosError.response ? {
            status: axiosError.response.status,
            statusText: axiosError.response.statusText,
            data: axiosError.response.data,
            headers: axiosError.response.headers
          } : 'No response received from server',
          request: axiosError.request ? 'Request was made but no response received' : 'Request configuration error',
          config: {
            url: axiosError.config?.url,
            method: axiosError.config?.method,
            timeout: axiosError.config?.timeout,
            dataSize: JSON.stringify(axiosError.config?.data || {}).length
          },
          stack: axiosError.stack
        });
        
        errorData = {
          failed: "Error posting to support_tickets endpoint",
          err: axiosError.toString(),
          details: {
            status: axiosError.response?.status,
            statusText: axiosError.response?.statusText,
            responseData: axiosError.response?.data,
            code: axiosError.code
          }
        };
        await throwParticipantMetaDataException(errorData);
        throw axiosError; // Re-throw to prevent further execution
      }
      
    } catch (ticketProcessError) {
      console.error('Error in ticket processing section:', ticketProcessError);
      errorData = {
        failed: "Error processing ticket data",
        err: ticketProcessError.toString(),
        stack: ticketProcessError.stack
      };
      await throwParticipantMetaDataException(errorData);
      return; // Exit early on processing error
    }

    // Store Data in Starlabs Participant Data
    if (olddoc && (olddoc.status !== newdoc.status || 
        JSON.stringify(olddoc.assign) !== JSON.stringify(newdoc.assign) || 
        JSON.stringify(olddoc.peopleinvolved) !== JSON.stringify(newdoc.peopleinvolved) || 
        olddoc.category !== newdoc.category)) {
      
      try {
        let issueupdatestatus = {};
        let ticketcount = 0;
        
        await admin.firestore().collection('clientissue')
          .where('clientid', '==', profileid)
          .orderBy("reporteddate", "desc")
          .get()
          .then((ticketdoc) => {
            if (ticketdoc.docs.length > 0) {
              let count = 0;
              ticketdoc.docs.forEach(issueDoc => {
                const data = issueDoc.data();
                if (data['status'] && data['status']['status'] && data['status']['status'].toLowerCase() === 'open') {
                  ticketcount = (count + 1) + ticketcount;
                  issueupdatestatus[issueDoc.id] = {
                    'ticketno': data['issueno'] || null,
                    'category': data['category'] || null,
                    'issue': data['issue'] || null,
                    'reporteddate': data['reporteddate'] || null,
                    'status': data['status']['status']
                  };
                }
              });
            } else {
              console.log("No open tickets found for client:", profileid);
            }
          });

        console.log('CUSTOMER SUPPORT DATA:', issueupdatestatus);
        console.log('CUSTOMER TICKETS COUNT:', ticketcount);

        try {
          await admin.firestore().collection('participant metadata').doc(profileid).set({
            customersupport: issueupdatestatus,
            customersupporttickets: ticketcount
          }, { merge: true });
          
          console.log('Participant metadata updated successfully for profile:', profileid);
          
        } catch (metadataError) {
          console.error('Error updating participant metadata:', metadataError);
          errorData = {
            failed: "Error updating participant metadata",
            err: metadataError.toString(),
            stack: metadataError.stack
          };
          await throwParticipantMetaDataException(errorData);
          throw metadataError;
        }
        
      } catch (ticketQueryError) {
        console.error('Error querying open tickets:', ticketQueryError);
        errorData = {
          failed: "Error querying open tickets",
          err: ticketQueryError.toString(),
          stack: ticketQueryError.stack
        };
        await throwParticipantMetaDataException(errorData);
        throw ticketQueryError;
      }
    } else {
      console.log('No significant changes detected, skipping metadata update');
    }
  } else {
    console.log('No new document data available');
  }
});

async function throwParticipantMetaDataException(exception) {
  let data = { ...exception, ...{ updateddate: new Date() } }
  await admin.firestore().collection('participantmetadata exception').add(data)
}