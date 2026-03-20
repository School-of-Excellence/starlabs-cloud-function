const admin = require("firebase-admin")

const {onDocumentCreated,onDocumentUpdated, onDocumentWritten} = require("firebase-functions/v2/firestore")
const { onRequest } = require("firebase-functions/v2/https");

const {defineSecret} = require("firebase-functions/params")
const zoomAccountId = defineSecret("ZOOM_ACCOUNTID")
const zoomClientId = defineSecret("ZOOM_CLIENTID")
const zoomClientSecret = defineSecret("ZOOM_CLIENTSECRET")
const zoomSDkClientId = defineSecret("ZOOM_SDK_CLIENTID")
const zoomSDKClientSecret = defineSecret("ZOOM_SDK_CLIENTSECRET")

const axios = require("axios");

const getUnusedZoomAccount = require('./service').getUnusedZoomAccount
const generateSignature = require("./service").generateSignature
const commonService = require("./service");

exports.createBigParticipantAssignment = onDocumentCreated({document : "big assignment/{docid}",secrets : [zoomAccountId,zoomClientId,zoomClientSecret,zoomSDkClientId,zoomSDKClientSecret]},async (snapshot) => {
  console.log('Created Data:', snapshot);
  
  const data = snapshot.data.data()
  if(data['regeneratemeeting'] && data['status'] != 'completed'){
    await generateZoomMeeting(data,zoomAccountId.value(),zoomClientId.value(),zoomClientSecret.value(),zoomSDkClientId.value(),zoomSDKClientSecret.value())
  }
  await setBigParticipantAssignments(snapshot.data.ref,data,data['participantidlist'])
  let currentdate = new Date(new Date().setHours(0,0,0,0))
  if(data.enddate.toDate() > currentdate){
    await createBigAssignmentChat(data)
    await createBigSupportChat(data)
    //send wati confirmation message
    await sendWatiConfirmation(data)
  }
  return;
});

async function createBigAssignmentChat(assignment) {
  let doc = {
    docid:assignment.docid, 
    assignmenttype:assignment.assignmenttype,
    // cohortsref:assignment.cohortsref,
    createdAt:new Date(),
    description:assignment.description,
    marathonref:assignment.marathonref,
    participants:assignment.participantidlist,
    admins:assignment.selectedAdmin,
    startdate:assignment.startdate.toDate(),
    enddate:assignment.enddate.toDate(),
  }
  await admin.firestore().collection("bigchat").doc(doc.docid).set(doc);

  return {message : "big assignment chat created"}
}

async function createBigSupportChat(assignment){
  console.log("createBigSupportChat");
  console.log(assignment['editedprofileref'],Array.isArray(assignment['editedprofileref']),);
  
  const creatorProfileId = assignment['editedprofileref'] ? 
    Array.isArray(assignment['editedprofileref']) ? 
    assignment['editedprofileref'].length != 0 ? 
    assignment['editedprofileref'].at(-1)['profileref'].id : null : null : null
  console.log(creatorProfileId,"creatorProfileId");
  
  const creatorProfileSnap = creatorProfileId ? await admin.firestore().collection("profile_data").doc(creatorProfileId).get() : null

  const creatorUid = creatorProfileSnap ? creatorProfileSnap.exists && creatorProfileSnap.data()['user_ref'] ?  creatorProfileSnap.data()['user_ref'] : null : null
  // console.log("creatorUid",creatorUid);
  
  let userUidList = []
  for (let i = 0; i < assignment['participantidlist'].length; i+=10) {
    console.log(i,"index");
    
    const slicedProfiles = assignment['participantidlist'].slice(i,i+10);
    console.log("slicedProfiles",slicedProfiles);
    
    const snap = await admin.firestore().collection("profile_data").where("profileid","in",slicedProfiles).get();
    snap.forEach(doc => {
      const data = doc.data()
      if(data['user_ref']) userUidList.push(data['user_ref'].id)
    })
  }
  console.log("userUidList",userUidList);
  
  let docRef = admin.firestore().collection("supportchat").doc();
  console.log("supportchat");
  
  await docRef.set({
    id:docRef.id,
    isdelete:false,
    type:"group",
    members:userUidList,
    last_modification:admin.firestore.FieldValue.serverTimestamp(),
    group_name:assignment['title'],
    group_profile:null,
    created_on:admin.firestore.FieldValue.serverTimestamp(),
    creator_uid:creatorUid
  })

  await admin.firestore().collection("big assignment").doc(assignment['docid']).update({
    groupchatid:docRef.id
  })

  return { message: "big support chat created", chatId: docRef.id };
}

async function setBigParticipantAssignments(assignmentRef,assignmentData,participantIdList){
  let batch = admin.firestore().batch()
  let n = 0
  for (let i = 0; i < participantIdList.length; i++) {
    const profileId = participantIdList[i];
    const cohortsRef = assignmentData['participantidbycohorts'] ? assignmentData['participantidbycohorts'][profileId] ? assignmentData['participantidbycohorts'][profileId] : null : null
    if(cohortsRef === null) continue;
    let doc = {
      docid: admin.firestore().collection("big participants assignments").doc().id,
      profileid: profileId,
      assignmentref: assignmentRef,
      status: 'initiated',
      cohortsref: assignmentData['participantidbycohorts'][profileId],
      marathonref: assignmentData['marathonref'],
      watinotification:assignmentData['watinotification'],
      createddate: new Date(),
    }
    batch.set(admin.firestore().collection("big participants assignments").doc(doc['docid']), doc)
    n++
    if (n != 0 && n % 450 == 0) {
      await batch.commit()
      console.log("batchsize 450", n / 450);
      batch = admin.firestore().batch()
    }
  }
  if (n % 450 != 0) {
    await batch.commit().then(() => {
      console.log("final batch committed, total operations:", n);
    })
  }
  return {meesage:"big participants assignment created for each participants"}
}

async function generateZoomMeeting(assignmentData,zoomaccountid,zoomclientid,zoomclientsecret,zoomsdkclientid,zoomsdkclientsecret){
  assignmentData['zoomhostemail'] = await getUnusedZoomAccount()
  if(![null,undefined].includes(assignmentData['zoomhostemail'])){
    console.log("zoom meeting creation started");
    var accountid = zoomaccountid
    var clientid = zoomclientid
    var clientsecret = zoomclientsecret
    const tokenResponse = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountid}&client_id=${clientid}&client_secret=${clientsecret}`, {
      method: 'POST'
    });
    const tokenData = await tokenResponse.json();
    try {
      const zoomresult = await axios.post("https://api.zoom.us/v2/users/" + assignmentData['zoomhostemail'] + "/meetings", {
        "topic": assignmentData['title'],
        "type": 1,
        "start_time": new Date(),
        "timezone": "India",
        "host_email": assignmentData['zoomhostemail'],
        "settings": {
          "host_video": true,
          "participant_video": true,
          "cn_meeting": false,
          "in_meeting": true,
          "join_before_host": true,
          "mute_upon_entry": false,
          "watermark": false,
          "use_pmi": false,
          "approval_type": 1,
          "audio": "both",
          // "auto_recording": "local",
          "enforce_login": false,
          "registrants_email_notification": false,
          "waiting_room": true,
          "allow_multiple_devices": true,
        }
      }, {
        headers: {
          'Authorization': 'Bearer ' + tokenData.access_token,
          'content-type': 'application/json'
        }
      });
      let sdkclientid = zoomsdkclientid
      let sdkclientsecret = zoomsdkclientsecret
      let signature  = await generateSignature(sdkclientid,sdkclientsecret,zoomresult.data['id'],1)
      let participantsignature = await generateSignature(sdkclientid,sdkclientsecret,zoomresult.data['id'],0)
      await admin.firestore().collection("big assignment").doc(assignmentData['docid']).update({
        signature : signature,
        zoomdata : zoomresult.data,
        hostid:zoomresult.data['host_id'] ? zoomresult.data['host_id'] : null,
        regeneratemeeting : false,
        participantsignature :participantsignature
      })
      return {message : "zoom created for the assignment",hostId:zoomresult.data['host_id'] ? zoomresult.data['host_id'] : null}
    } catch (error) {
      console.log(error.message);
    }
  }
}

async function sendWatiConfirmation(assignment){
  let mapProfileId = {}
  for (let i = 0; i < assignment['participantidlist'].length; i+=10) {
    const slicedElement = assignment['participantidlist'].slice(i,i+10);
    await admin.firestore().collection("profile_data").where("profileid","in",slicedElement).get().then(snap => {
      snap.forEach(doc => {
        let data = doc.data()
        mapProfileId[data['profileid']] = data
      })
    })
  }
  console.log("map profileid to profile data done");
  for (let i = 0; i < assignment['participantidlist'].length; i++) {
    const profileid = assignment['participantidlist'][i]
    let countrycode = (![null,undefined].includes(mapProfileId[profileid]['countrycode']) ? mapProfileId[profileid]['countrycode'] : '+91').replace(/\+/g,"")
    let waticontent = {
      // phonenumber : `${countrycode}${mapProfileId[profileid]['number']}`,
      phonenumber : `${mapProfileId[profileid]['number']}`,
      body : {
        parameters: [
          {name: '1', value: mapProfileId[profileid]['name']},
          {name: '2', value: assignment['title']},
          {name: '3', value: assignment['description']},
          {name: '4', value: `assignmentid=${assignment['docid']}&profileid=${profileid}&status=confirmed`},
          {name: '5', value: `assignmentid=${assignment['docid']}&profileid=${profileid}&status=declined`},
        ],
        broadcast_name: 'big_activity_confirmation',
        template_name: 'big_activity_confirmation'
      }
    }
    console.log('wati content',waticontent);

    const parameterConfig = waticontent['body']['parameters'].map(param => ({
      excelColumn: null,
      fillType: 'static',
      metadataField: null,
      name: param.name,
      staticValue: param.value
    }));
    console.log('Triggered Wati Archive Creation');
    
    const response = await commonService.createWatiArchiveDocument({
      numbers: [parseInt(waticontent['phonenumber'])],
      numbermap : {[`${waticontent['phonenumber']}`] : profileid},
      broadcastname : 'Individual',
      paramFillMode: 'static',
      parameterConfig: parameterConfig,
      params: [],
      profileid: [profileid],
      templateid: null,
      watitemplateid: 'big_activity_confirmation',
    });
    console.log('WATI ARCHIVE RESPONSE', response);

    // commonService.sendToWhatsappViaWati(waticontent)
  }
  return {message:"participant confirmation messages are sent through wati"}
}

exports.onUpdateBigAssignment = onDocumentUpdated("big assignment/{docid}",async (change) => {
  console.log("onUpdateBigAssignment");
  
  const oldDoc = change.data.before.data()
  const newDoc = change.data.after.data()

  if(newDoc['status'] === 'completed'){
    if(newDoc['groupchatid']){
      await admin.firestore().collection("supportchat").doc(newDoc['groupchatid']).update({
        isdelete:true
      })
      console.log("group chat isdelete marked");
    }
    return {message : "big assignement completed"}
  }

  //zoom meeting creation
  if(oldDoc['regeneratemeeting'] !=  newDoc['regeneratemeeting'] && newDoc['regeneratemeeting']){
    generateZoomMeeting(newDoc,zoomAccountId.value(),zoomClientId.value(),zoomClientSecret.value(),zoomSDkClientId.value(),zoomSDKClientSecret.value())
  }

  let changesInOldParticipantIdList = oldDoc['participantidlist'].filter(e => !newDoc['participantidlist'].includes(e))
  console.log(changesInOldParticipantIdList,"changesInOldParticipantIdList");
  
  if(changesInOldParticipantIdList.length != 0){
    for (let i = 0; i < changesInOldParticipantIdList.length; i=i+10) {
      const profileList = changesInOldParticipantIdList.slice(i,i+10);
      await admin.firestore().collection("big participants assignments").where("profileid","in",profileList).where("assignmentref","==",change.data.after.ref).get().then(async (participantsAssignmentsSnap) => {
        let participantsAssignmentsData = participantsAssignmentsSnap.docs.map(e => e.ref)
        console.log(participantsAssignmentsData.length,"participantsAssignmentsData");
        await deleteParticipantsAssignments(participantsAssignmentsData)
      })
    }
  }

  let changesInNewParticipantIdList = newDoc['participantidlist'].filter(e => !oldDoc['participantidlist'].includes(e))
  console.log(changesInNewParticipantIdList,"changesInNewParticipantIdList");
  if(changesInNewParticipantIdList.length != 0){
    await setBigParticipantAssignments(change.data.after.ref,newDoc,changesInNewParticipantIdList)
    let currentdate = new Date(new Date().setHours(0,0,0,0))
    if(newDoc.enddate.toDate() > currentdate){
      await updateBigAssignmentChat(newDoc)
    }
  }

  if(newDoc['groupchatid']){
    if(changesInNewParticipantIdList.length != 0){
      console.log("getting uid for participants");
      
      const groupChatRef = await admin.firestore().collection("supportchat").doc(newDoc['groupchatid']).get();
      let userUidList = []
      for (let i = 0; i < newDoc['participantidlist'].length; i=i+10) {
        const slicedProfiles = newDoc['participantidlist'].slice(i,i+10);
        const snap = await admin.firestore().collection("profile_data").where("profileid","in",slicedProfiles).get();
        snap.forEach(doc => {
          const data = doc.data()
          if(data['user_ref']) userUidList.push(data['user_ref'].id)
        })
      }
      const members = groupChatRef.data()['members']
      let findNewMembers = userUidList.filter(e => !members.includes(e))
      if(findNewMembers.length != 0){
        console.log("updating group chat");
        
        await groupChatRef.update({
          members : [...members,...findNewMembers]
        })
      }
    }
  }else{
    console.log("on creating big support chat");
    await createBigSupportChat(newDoc)
  }
  
  return {message : "big assignement updates done"}
})

async function updateBigAssignmentChat(assignment){
  await admin.firestore().collection("bigchat").doc(assignment.docid).get().then(snap => {
    if(snap.exists){
      let doc = {
        description:assignment.description,
        participants:assignment.participantidlist,
        admins:assignment.selectedAdmin,
        startdate:assignment.startdate.toDate(),
        enddate:assignment.enddate.toDate()
      }
      snap.ref.update(doc)
      console.log("chatupdated");
      return 
    }else{
      console.log("chat doesn't exist");
      return
    }
  })
}

async function deleteParticipantsAssignments(documentRef){
  let result  = "done"
  let batch = admin.firestore().batch()
  for (let i = 0; i < documentRef.length; i++){
    const ref = documentRef[i];
    console.log(i,"iiiiiiiiii");
    
    const doc = await ref.get();
    if (doc.exists) {
      const data = doc.data();
      console.log(data['status'],"status console");
      if (data.status === 'initiated' || data.status === null) {
        batch.delete(ref);
      }
    }
    if(i != 0 && i%500 === 0){
      await batch.commit().then(() => {
        batch = admin.firestore().batch()
        console.log("batch size",i/500);
      })
    }
  }
  await batch.commit()
  return result
}

exports.updateBigParticipantsAssignment = onDocumentWritten("big participants assignments/{docid}",async (snapshot)=>{
  let oldData = snapshot.data.before.data();
  let newData = snapshot.data.after.data();

  try {

    let mapProfile = {};  
    await admin.firestore().collection("profile_data").doc(newData['profileid']).get().then((profile)=>{
      if(profile.exists){
        const profileDoc = profile;
        mapProfile[profileDoc.id] = profileDoc.data();
      }
    }); 
    
    if([null,undefined].includes(newData['profileid'])){
      console.log("profileid not found");
      return;
    }

    var apikey = null;
    var serverid = null;
    await admin.firestore().collection("classify").doc("wati").get().then((wati) => {
      if(wati.exists) {
        const watiData = wati.data()['101723']
        apikey = watiData['watitoken'];
        serverid = "101723";
      }
    })

    //event wati
    const WATI_BASE_URL = `https://live-mt-server.wati.io/${serverid}`;
    const WATI_API_TOKEN = apikey;
  
    let data = {}; 
    let assignmentData = {};
    const endpoint = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${mapProfile[newData['profileid']]['number']}`;
    const headers = {
      'Authorization': `Bearer ${WATI_API_TOKEN}`,
      'Content-Type': 'application/json',
    };
  
    await admin.firestore().collection("big assignment").doc(newData['assignmentref'].id).get().then((assignment)=>{
      if(assignment.exists) {
        assignmentData = assignment.data();
      } else {
        console.log("No Assignment Found");
      }
    })
    console.log("outside initiated");
    console.log(oldData,"oldData console");
    console.log(newData,"newData console");
    
    
    if([null, undefined, ""].includes(oldData) && newData['status'] == 'initiated' && newData['watinotification']) {
      console.log("inside initiated");
      let assignmentDescription;
      if (newData['assignmenttype'] == 'Form') {
        assignmentDescription = assignmentData['description'];
      } else {
        assignmentDescription = assignmentData['directive'] || "No directive";
      }
      // const assignmentDescription = assignmentData['directive'] || "No directive";
      data = {
        template_name: 'assignment_initiated',
        broadcast_name: 'Assignment Initiated',
        parameters: [
          { name: 'name', value: mapProfile[newData['profileid']]['name']},
          { name: 'assignment_name', value: assignmentData['title'] },
          { name: 'assignment_description', value: assignmentDescription }
        ]
      };
    } else if(![null, undefined, ""].includes(oldData) && oldData['status'] != newData['status'] && newData['watinotification']) {
      if(newData['status'] == 'review') {
        console.log("review");
        data = {
          template_name: 'assignment_review',
          broadcast_name: 'Assignment Review',
          parameters: [
            { name: 'name', value: mapProfile[newData['profileid']]['name']},
            { name: 'assignment_name', value: assignmentData['title'] },
          ]
        };
      } else if(newData['status'] == 'rework') {
        console.log("rework");
        data = {
          template_name: 'assignment_rework',
          broadcast_name: 'Assignment Rework',
          parameters: [
            { name: 'name', value: mapProfile[newData['profileid']]['name']},
            { name: 'assignment_name', value: assignmentData['title'] },
          ]
        };
      } else if(newData['status'] == 'completed') {
        console.log("completed");
        data = {
          template_name: 'assignment_completed',
          broadcast_name: 'Assignment Completed',
          parameters: [
            { name: 'name', value: mapProfile[newData['profileid']]['name']},
            { name: 'assignment_name', value: assignmentData['title'] },
          ]
        };
      }
    }
  
    console.log("endpoint", endpoint);
    console.log("data", data);
    
    const response = await axios.post(endpoint, data, {headers : headers});
    console.log('Message sent successfully:', response.data);
    return response.data;
  } catch (error){
    console.error('Error sending WhatsApp message:', error.response?.data || error.message);
    throw error;
  }
})

exports.bigAssignmentParticipantConfirmation = onRequest({region: "us-central1", cors:true},async (req,res) => {
  try {

    const assignmentId = req.query.assignmentid
    const profileId = req.query.profileid
    const status = req.query.status

    if(!assignmentId || !profileId || !status){
      return res.status(400).send("Missing query paramaters")
    }

    const assignmentRef = admin.firestore().collection("big assignment").doc(assignmentId)

    const participantAssignmentDocs = await admin.firestore()
      .collection("big participants assignments")
      .where("assignmentref","==",assignmentRef)
      .where("profileid","==",profileId)
      .get();

    if(participantAssignmentDocs.size > 1){
      console.log("⚠ Bug: This profileId has more than one document for same assignment");
    }

    if (participantAssignmentDocs.empty) {
      return res.status(404).send("No participant assignment record found");
    }

    const doc = participantAssignmentDocs.docs[0];

    if (doc.data().confirmation !== status) {
      await doc.ref.update({ confirmation: status });
      //send wati message
      return res.send("Participation confirmation updated");
    } else {
      return res.send("Participant already updated their confirmation");
    }

    
  } catch (error) {
    console.error(error);
    return res.status(500).send("Internal Server Error")
  }
})

// exports.sendAssignmentConfirmationLink = onRequest({region: "us-central1", cors:true},async (req,res) => {
//   try {
//     const assignmentId = req.query.assignmentid

//     if(!assignmentId){
//       return res.status(400).send("Missing query parameters")
//     }

//     const assignmentSnap = await admin.firestore().collection("big assignment").doc(assignmentId).get();

//     if(!assignmentSnap.exists){
//       return res.status(404).send("No assignment record found");
//     }
//     const docData = assignmentSnap.data()
//     const participantIdList = docData['participantidlist']


//   } catch (error) {
//     console.error(error)
//     return res.status(500).send
//   }
// });