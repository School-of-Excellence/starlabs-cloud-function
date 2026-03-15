const { onRequest } = require("firebase-functions/v2/https");
var commonService = require("./service");
const admin = require('firebase-admin');
const { onDocumentCreated, onDocumentWritten, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const https = require('https'); // HTTP Request/Response
const { onSchedule } = require("firebase-functions/scheduler");

// To Generate Email OTP
exports.emailOTP = onRequest(async (req, res)=>{
  var email = req.query.email
  var code = (Math.floor(Math.random() * 999999) + 100000).toString().substring(0, 6)
  await admin.firestore().collection("generated_OTP").add({
    created: admin.firestore.FieldValue.serverTimestamp(),
    createdby: email,
    used: false,
    otp: code
  })
  var data = {
    product_name: "Breakthroughs",
    otp: code,
    company_name: "Antano & Harini",
  }
  await commonService.postmarkClient.sendEmailWithTemplate({
    From: "starlabs@excellenceinstallation.com",
    To: email,
    TemplateAlias: "register-otp",
    TemplateModel: data,
  }).catch(err=>{
    console.log(err)
  });
  res.send("success");
});

// General App Notification
exports.sendnotification = onDocumentCreated('send_notification/{ID}', async (snapshotdata)=>{
  var snapshot = snapshotdata.data
  var data = snapshot.data();
  console.log("Document ID : "+snapshot.id)
  var payload;
  var count = 0;

  if(data.image==null){
    payload = {
      "notification" : {
        "title" : data.title,
        "body" : data.body,
        "sound" : "default",
      },
      "data" : {
        "type" : "general",
      }
    }
  }
  else{
    payload = {
      "notification" : {
        "title" : data.title,
        "body" : data.body,
        "sound" : "default",
        "image" : data.image
      },
      "data" : {
        "type" : "general",
      }
    }        
  }
  if(data.event == "all"){
    return admin.messaging().sendToTopic("ahmember", payload).then(async res=>{
      console.log(res)
      await snapshot.ref.update({
        "sent" : "success",
        "date" : admin.firestore.FieldValue.serverTimestamp()
      })
    }).catch(async err=>{
      console.log(err)
      await snapshot.ref.update({
        "sent" : "failed",
        "date" : admin.firestore.FieldValue.serverTimestamp()
      })
    })
  }
  else{
    await admin.firestore().collection("event_token_user").where("event" , "==", data.event).get().then(async doc=>{
      console.log(doc.size)
      doc.forEach(async d=>{
        console.log(d.id)
        console.log(d.data().user_ref)
        await admin.firestore().collection("FCM_token").where("user_ref", "==", d.data().user_ref).get().then(async val=>{
          console.log(val.size)
          val.forEach(token=>{
            count = count + 1
            console.log(token.id)
            return admin.messaging().sendToDevice(token.data().FCM_id, payload).then(async res=>{
              console.log(res)
              await snapshot.ref.update({
                "sent" : "success",
                "date" : admin.firestore.FieldValue.serverTimestamp(),
                "total" : count
              })
            }).catch(async err=>{
              console.log(err)
              await snapshot.ref.update({
                "sent" : "failed",
                "date" : admin.firestore.FieldValue.serverTimestamp(),
                "total" : count
              })
            })
          })
        }).catch(err=>{
          console.log(err)
        })
      })
    }).catch(err=>{
      console.log("first"+ err.toString())
    })
  }
});

// Send A&H Updates
exports.sendAHupdates = onDocumentCreated("/A&H updates/{id}", async (snapshot) => {
  const notificationData = snapshot.data.data();
  const userList = notificationData["users"];
  const date = notificationData["date"];
  const message = notificationData["message"];
  const sticky = notificationData["sticky"];
  const title = notificationData["title"];
  const landingpage = notificationData["landingpage"];
  const logged = notificationData["logged"];

  commonService.saveNotificationRecord({
    logged: logged || true,
    title: title,
    message: message,
    subtitle: null,
    date: date.toDate(),
    userid: userList.map(e => e.id),
    sticky: sticky,
    notificationtype: "ahupdate",
    notificationimage: notificationData["notificationimage"],
    landingpage: landingpage,
    metadata: {
      from: snapshot.data.ref,
    }
  })
  return null;
});

async function sendNotification({title, body, tag, profileid = [], logtype}){
  var firebaseMessaging = admin.messaging()
  var topicName = "queuetopic"
  var fcmTokenBatch = []
  var fcmToken = []
  let message = {
    "notification": {
      "title": title,
      "body": body,
    },
    "data": {
      "click_action": "FLUTTER_NOTIFICATION_CLICK",
    },
    "android": {
      "notification": {
        "color": '#ffffff',
        "tag" : tag,
        "sound": "default",
      },
    },
    "apns": {
      "payload": {
        "aps": {
          "badge": 1,
          "sound": "default",
        },
      },
      "headers": {
        'apns-collapse-id': tag,
      }
    },
    // "tokens": [],
    "topic": topicName
  };
  
  for (let i = 0; i < profileid.length; i++) {
    const id = profileid[i];
    await admin.firestore().collection("FCM_token").where("profile_ref", "==", admin.firestore().collection("profile_data").doc(id)).where("active", "==", true).get().then(async fcmDoc=>{
      for (let j = 0; j < fcmDoc.docs.length; j++) {
        const fcmelement = fcmDoc.docs[j].data();
        if(![null,undefined].includes(fcmelement.FCM_id)){
          fcmToken.push(fcmelement.FCM_id)
        } 
      }
    })
    if(i != 0 && fcmToken.length >= 450){
      fcmTokenBatch.push(fcmToken)
      fcmToken = []
    }
    if(logtype == "appointmentreminder"){
      await admin.firestore().collection("profile_data").doc(id).get().then(async profile=>{
        if(profile.data()["uid"] != null){
          var uid = profile.data()["uid"]
          await admin.firestore().collection("notifications").doc(uid).set({
            "name" : profile.data()["name"],
            "read" : false,
          }, {merge : true}).then(async ()=>{
            await admin.firestore().collection("notifications").doc(uid).collection("logs").add({
              date: admin.firestore.FieldValue.serverTimestamp(),
              message: body,
              type: "reminder",
            })
          })
        }
      })
    }
  }
  fcmTokenBatch.push(fcmToken)
  for (let i = 0; i < fcmTokenBatch.length; i++) {
    const element = fcmTokenBatch[i];
    console.log("batch length",element.length);
    await firebaseMessaging.subscribeToTopic(element, topicName).then(value=>{
      console.log("Subscribed Success -", value.successCount, "Failed", value.failureCount, " ErrorList", value.errors.map(e => e.error).join(", "))
    })
    await firebaseMessaging.send(message).then(res=>{
      // console.log("Batch", i+1, "/", splitToken.length, res)
    }).catch(err=>{
      console.log("Unable to Send Notification", err)
    })
    await firebaseMessaging.unsubscribeFromTopic(element, topicName).then(value=>{
      console.log("Unsubscribed Success -", value.successCount, "Failed", value.failureCount, " ErrorList", value.errors.map(e => e.error).join(", "))
    })
  }
}

exports.queuepipelinecreation = onDocumentCreated("queue generation/{docid}",async snap => {
  let snapshot = snap.data
  var data = snapshot.data();
  var queuename = data['queuename']
  console.log(queuename);
  var url = "https://us-central1-salesleadcrm-test.cloudfunctions.net/createqueuepipeline?queuename="+queuename
  https.get(url);
})

exports.sendleadstoqualifiedpipelines = onDocumentWritten("queue_token/{docid}", async (snapshot) => {
  var change = snapshot.data
  var beforeData = change.before.data();
  var afterData = change.after.data();
  var queuename = afterData['queuename']
  var queueid = afterData['docid']
  var profileid = afterData['profile_id']
  let mapprofile = {}
  await admin.firestore().collection('profile_data').get().then(snap => {
    for (let i = 0; i < snap.docs.length; i++) {
      const element = snap.docs[i].data();
      mapprofile[element['profileid']] = element
    }
  })
  if(beforeData != undefined && beforeData['currentstage'] != afterData['currentstage'] && afterData['currentstage'] == 'Completed'){
    var data = mapprofile[profileid] 
    console.log(data);
    var url = "https://us-central1-salesleadcrmtest.cloudfunctions.net/queueleadstopipeline?queuename="+queuename+"&profiledata="+encodeURIComponent(JSON.stringify(data)+"&queueid="+queueid)
    https.get(url);
  }
})

// HTTP request To Create Profile For New Watson User
exports.createWatsonProfile = onRequest(async (req, res)=>{
  var name = req.query.name
  var email = req.query.email
  var number = req.query.number
  var countrycode = req.query.countrycode
  var recentpurchase = req.query.recentpurchase != undefined && req.query.recentpurchase != null ? req.query.recentpurchase : null

  if(name != null && name != undefined && email != null && email != undefined && number != null && number != undefined){
    var useremail = email.trim().toLowerCase()
    var username = name.trim()
    var usernumber = number.trim()
    if(useremail.length != 0 && username.length != 0 && usernumber.length != 0){
      await admin.firestore().collection("profile_data").where("email", "==", useremail).get().then(async profileData=>{
        if(profileData.size == 0){
          var profile_id = admin.firestore().collection("profile_data").doc().id;
          var role_id = admin.firestore().collection("roles_of_users").doc().id;
          await admin.firestore().collection("profile_data").doc(profile_id).set({
            name : username,
            countrycode : countrycode.toString(),
            number : usernumber.toString(),
            profile : null,
            email : useremail,
            recentpurchase : recentpurchase,
            user_ref : null,
            created : admin.firestore.FieldValue.serverTimestamp(),
            enable : true,
            block : false,
            profileid : profile_id,
            role_ref : admin.firestore().collection("users_roles").doc(role_id)
          }).then(async ()=>{
            await admin.firestore().collection("users_roles").doc(role_id).set({
              name : username,
              profile_ref : admin.firestore().collection("profile_data").doc(profile_id),
              admin : false,
              changeagent : false,
              eitfellowship : false,
              eitapprentice: false,
              eitcoordinator : false,
              eventcoordinator : false,
              participant : true,
              transcriber : false,
              verifier : false,
              chatxadmin : false,
              supportdesk : false,
            }).then(()=>{
              res.send("Success", profile_id)
            }).catch(err=>{
              console.log(err)
              res.send("Roles created error")
            })
          }).catch(err=>{
            console.log(err)
            res.send("Profile creation error")
          })
        }
        else{
          await profileData.docs[0].ref.update({
            recentpurchase: recentpurchase
          }).catch(err=>{
            res.send(err)
          })
          res.send("Profile Exists")
        }
      }).catch(err=>{
        console.log(err)
        res.send("Mail Query error")
      })
    }
    else{
      res.send("Data Empty")
    }
  }
  else{
    res.send("Format missing")
  }
})
  

exports.QueueEventUpdate_to_pmd = onDocumentWritten('/queue_token/{id}',async (snapshot) => {
  var beforeData = snapshot.data.before.data()
  var afterData = snapshot.data.after.data()
  var profileid = afterData["profile_id"]
  console.log(profileid);

  // onCreate timeline log 
  // try{
  //   if (beforeData !== afterData && beforeData === null && afterData !== null) {
  //     // timeline log
  //     var docid = afterData['docid']
  //     var data = {
  //       logid: docid,
  //       created: new Date(),
  //       activityname: "queueevent",
  //       productref: afterData["productref"],
  //       activitydate: [null, undefined].includes(afterData["logdate"][afterData['currentstage']]) ? null : afterData["logdate"][afterData['currentstage']],
  //       profileid: afterData["profile_id"],
  //       queueid:afterData['queueref'].id,
  //     }
  //     await admin.firestore().collection('timeline log').doc(docid).set(data).then(() => {
  //       console.log("timelog updated for the queue token created",afterData['docid']);
  //     })
  //   }
  // }catch (err) {
  //   await throwParticipantMetaDataException({
  //     profileid: profileid,
  //     failed: "queue token",
  //     triggerdoc: snapshot.data.after.ref.path,
  //     err: err.toString() 
  //   })
  // }
  

  try {
    if(beforeData["tokenstatus"] != afterData["tokenstatus"]){
      var participantdashboardData = {}
      await admin.firestore().collection("participant metadata").doc(profileid).get().then(async pdSnap => {
        if(pdSnap.exists){
          participantdashboardData = pdSnap.data()
          if(participantdashboardData["queueevent"] == null || participantdashboardData["queueevent"] == undefined){
            participantdashboardData["queueevent"] = {}
          }
        }
        else{
          await commonService.throwParticipantMetaDataException({
            profileid: profileid,
            failed: "activeproduct",
            triggerdoc: snapshot.data.after.ref.path,
            err: "no profile exist" 
          })
        }
      })

      await admin.firestore().collection('queue_token').where('profile_id', '==', profileid).where('tokenstatus', '==', 'Active').where('stagestatus', '==', 'Approved').where('currentstage', '==', 'completed').get().then(async (tokenlist) => {
        var profileQueueAttended = {}

        for (let i = 0; i < tokenlist.docs.length; i++) {
          const element = tokenlist.docs[i];
          var attendedData = element.data()
          profileQueueAttended[attendedData["productref"].id] = profileQueueAttended[attendedData["productref"].id] || []
          profileQueueAttended[attendedData["productref"].id].push(attendedData["queueref"].id)
        }

        Object.keys(participantdashboardData["queueevent"]).forEach(productname =>{
          if([null, undefined].includes(profileQueueAttended[productname])){
            profileQueueAttended[productname] = admin.firestore.FieldValue.delete()
          }
        })

        await admin.firestore().collection('participant metadata').doc(profileid).set({
          queueevent : profileQueueAttended
        },{merge:true}).then(async () => {
          console.log('document successfully updated')
          // timeline log
          var docid = afterData['docid']
          var data = {
            logid: docid,
            created: new Date(),
            activityname: "queueevent",
            productref: afterData["productref"],
            activitydate: [null, undefined].includes(afterData["logdate"][afterData['currentstage']]) ? null : afterData["logdate"][afterData['currentstage']],
            profileid: afterData["profile_id"],
            queueid:afterData['queueref'].id,
          }
          await admin.firestore().collection('timeline log').doc(docid).set(data).then(() => {
            console.log("timelog updated for the queue completed",afterData['docid']);
          })
        })
      })
    }
  } catch (err) {
    await commonService.throwParticipantMetaDataException({
      profileid: profileid,
      failed: "queue token",
      triggerdoc: snapshot.data.after.ref.path,
      err: err.toString() 
    })
  }
}) 

exports.queueStage = onDocumentUpdated("queue_token/{id}", async (change) => {

  var before = change.data.before
  var after = change.data.after
  var beforeData = before.exists ? before.data() : {}
  var afterData = after.exists ? after.data() : {}

  var data = afterData
  var profileid = afterData["profile_id"]
  var queue = afterData["variationid"] != null ? admin.firestore().collection("queue variation").doc(afterData["variationid"]).path : afterData["queueref"].path
  var message = "Your Token: " + afterData["tokennumber"] + " for " + afterData["queuename"] + " has been moved to " + afterData["currentstage"] + " stage"
  
  if(beforeData["currentstage"] != afterData["currentstage"]){
    await admin.firestore().doc(queue).get().then(queue=>{
      data["stages"] = queue.data()["stages"]
    })
    await commonService.saveNotificationRecord({
      title: "Your Queue stage is updated",
      message: message,
      subtitle: null,
      date: admin.firestore.FieldValue.serverTimestamp(),
      landingpage: null,
      logged: true,
      profileid: [profileid],
      sticky: false,
      notificationtype: "queue",
      notificationimage: null,
      metadata: data,
    })
  }
});

exports.watiQueueWelcomeNotification = onDocumentWritten("/queue_token/{queuetokenid}", async (snap) => {
  let change = snap.data
  let olddoc = change.before.data()
  let newdoc = change.after.data()
  let firststage = null
  let laststage = null
  let excludequeuestage = [null]

  //get profile data
  let profiledata = null
  await admin.firestore().collection("profile_data").doc(newdoc['profile_id']).get().then(async profilesnap => {
    profiledata = profilesnap.data()
  })

  // getting first stage of queue
  let queueGenerationDoc = null
  await admin.firestore().doc(newdoc['queueref'].path).get().then(queuesnap => {
    queueGenerationDoc = queuesnap.data()
    firststage = queueGenerationDoc['stages'][0]
    laststage = queueGenerationDoc['stages'][queueGenerationDoc['stages'].length -1]
    excludequeuestage.push(firststage)
    excludequeuestage.push(laststage)
  })

  if(queueGenerationDoc['iscommunicationsdisabled'] != true){
    //
      //sending message to new created doc
      if([null,undefined].includes(olddoc)){
        console.log("onCreate");
        console.log(newdoc['tokenstatus'],newdoc['stagestatus'] == 'Approved');
        if(newdoc['tokenstatus'] === 'Active' && newdoc['stagestatus'] === 'Approved' && firststage === newdoc['currentstage']){
          //send via wati
          let countrycode = (![null,undefined].includes(profiledata['countrycode']) ? profiledata['countrycode'] : '+91').replace(/\+/g,"")
          let waticontent = {
            phonenumber : `${countrycode}${profiledata['number']}`,
            body : {
              parameters: [
                {name: 'name', value: newdoc['profile_name']},
                {name: 'tokenumber', value: newdoc['tokennumber']}
              ],
              broadcast_name: queueGenerationDoc['queuewelcometemplate'],
              template_name: queueGenerationDoc['queuewelcometemplate']
            }
          }
          console.log('wati content',waticontent);
          await commonService.sendToWhatsappViaWati(waticontent)
        }
      }
      else if(![null,undefined].includes(olddoc) && ![null,undefined].includes(newdoc)){
        console.log("onUpdate");
        if(olddoc['currentstage'] != newdoc['currentstage']){
          
          //send message to slack channel events (eventSlackTrigger)
          if(!excludequeuestage.includes(newdoc['currentstage'])){
            var url
            if(commonService.production){
              url = commonService.slackEvent // Production
            }
            else{
              url = commonService.slackDevTest // Test
            }
            if(url != undefined){
              var webhook = new commonService.IncomingWebhook(url);
              let message = `${newdoc['currentstage']} : ${newdoc['profile_name']}`
              webhook.send(message, function(err, header, statusCode, body) {
                if (err) {
                  console.log('Error:', err);
                } else {
                  console.log('Received', statusCode, 'from Slack');
                }
              });
            }
          }
          // if queue completed -  wati message,dashboardQueueEventUpdate,sendLeadsToQualifiedPipeline
          if(newdoc['currentstage'] === laststage){
            console.log("currentstage",newdoc['currentstage']+ "wati message sending started");
            //wati
            let countrycode = (![null,undefined].includes(profiledata['countrycode']) ? profiledata['countrycode'] : '+91').replace(/\+/g,"")
            let waticontent = {
              phonenumber : `${countrycode}${profiledata['number']}`,
              body : {
                parameters:[
                  {name: 'productname', value:newdoc['productname']},
                  {name: 'name', value:newdoc['profile_name']},
                ],
                broadcast_name: 'queuecompletion_v3',
                template_name: 'queuecompletion_v3'
              }
            }
            await commonService.sendToWhatsappViaWati(waticontent)
            

            //sendleadstoqualifiedpipelines
            var leadprofile = {
              "name" : newdoc['name'],
              "number" : newdoc['number'],
              "email" : newdoc['email'],
              "profileid" : newdoc['profileid']
            };
            var leadurl = "https://us-central1-crmtesting-2f80b.cloudfunctions.net/queueleadstopipeline?queuename="+newdoc['queuename']+"&profiledata="+encodeURIComponent(JSON.stringify(leadprofile)+"&queueid="+newdoc['queueref'].id)
            https.get(leadurl);
          }

          // when moved to next stage check stage action type if form or lint based action we have to send notification via email wati and mobile app.
          let queueGenerationDocData = queueGenerationDoc
          if(queueGenerationDocData['stageproperty'][newdoc['currentstage']]['actiontype'] === 'form'){
            console.log("action type form");
            //email
              let clientModel = {
                name:profiledata['name'],
                stage:newdoc['currentstage'],
                productname:newdoc['productname']
              }
              console.log("sending email");
              await commonService.postmarkClient.sendEmailWithTemplate({
                From: "starlabs@excellenceinstallation.com",
                To: profiledata["email"],
                TemplateAlias: "queue_stage_formtype",
                TemplateModel: clientModel,
              }).catch(err=>{
                console.log(err)
              });
            // mobileapp
              console.log("sending app notification");
              await commonService.saveNotificationRecord({
                title: "Hello "+profiledata['name'],
                message: `You are ready for the ${newdoc['currentstage']} stage please open your breakthroughs app and complete the process`,
                subtitle: null,
                date: admin.firestore.FieldValue.serverTimestamp(),
                landingpage: null,
                logged: false,
                profileid: [profiledata['profileid']],
                sticky: false,
                notificationtype: "queue",
                notificationimage: null,
                metadata: {
                  queuetoken: snap.data.after.ref
                },
              })
              // await sendNotification({
              //   title: "Hello "+profiledata['name'],
              //   body: `You are ready for the ${newdoc['currentstage']} stage please open your breakthroughs app and complete the process`,
              //   tag: newdoc['docid'],
              //   profileid: [profiledata['profileid']],
              //   logtype: null
              // })
            //wati
              let countrycode = (![null,undefined].includes(profiledata['countrycode']) ? profiledata['countrycode'] : '+91').replace(/\+/g,"")
              let waticontent = {
                phonenumber : `${countrycode}${profiledata['number']}`,
                body : {
                  parameters: [
                    {name: 'name', value: profiledata['name']},
                    {name: 'stage', value: newdoc['currentstage']}
                  ],
                  broadcast_name: 'queue_stage_formtype_v3',
                  template_name: 'queue_stage_formtype_v3'
                }
              }
              console.log('wati content',waticontent);
              await commonService.sendToWhatsappViaWati(waticontent)
          }else if(queueGenerationDocData['stageproperty'][newdoc['currentstage']]['actiontype'] === 'link'){
            console.log("action type link");
            //email
              let clientModel = {
                name:profiledata['name'],
                stage:newdoc['currentstage'],
                url:queueGenerationDocData['stageproperty'][newdoc['currentstage']]['actionresource'],
                productname:newdoc['productname']
              }
              console.log("sending link email");
              await commonService.postmarkClient.sendEmailWithTemplate({
                From: "starlabs@excellenceinstallation.com",
                To: profiledata["email"],
                TemplateAlias: "queue_stage_actiontype_link",
                TemplateModel: clientModel,
              }).catch(err=>{
                console.log(err)
              });
            // mobileapp
              console.log("sending app notification");
              await commonService.saveNotificationRecord({
                title: "Hello "+profiledata['name'],
                message: `You are ready for the ${newdoc['currentstage']} stage, Please check your Whatsapp/ Email.`,
                subtitle: null,
                date: admin.firestore.FieldValue.serverTimestamp(),
                landingpage: null,
                logged: false,
                profileid: [profiledata['profileid']],
                sticky: false,
                notificationtype: "queue",
                notificationimage: null,
                metadata: {
                  queuetoken: snap.data.after.ref
                },
              })
              // await sendNotification({
              //   title: "Hello "+profiledata['name'],
              //   body: `You are ready for the ${newdoc['currentstage']} stage, Please check your Whatsapp/ Email.`,
              //   tag: newdoc['docid'],
              //   profileid: [profiledata['profileid']],
              //   logtype: null
              // })
            //wati
              let countrycode = (![null,undefined].includes(profiledata['countrycode']) ? profiledata['countrycode'] : '+91').replace(/\+/g,"")
              let waticontent = {
                phonenumber : `${countrycode}${profiledata['number']}`,
                body : {
                  parameters: [
                    {name: 'name', value: profiledata['name']},
                    {name: 'stage', value: newdoc['currentstage']},
                    {name: 'url', value: queueGenerationDocData['stageproperty'][newdoc['currentstage']]['actionresource']}
                  ],
                  broadcast_name: 'queue_stage_linktype_v4',
                  template_name: 'queue_stage_linktype_v4'
                }
              }
              console.log('wati content',waticontent);
              await commonService.sendToWhatsappViaWati(waticontent)
          }//action type link
        }
      }
    //
  }
})

// Mode Cron JOB
// Installation Event Mode
exports.installationEventMode = onSchedule({schedule: "00 00 * * *"}, async (context)=>{
    var batchCount = 0
    var batch = admin.firestore().batch()
    var startDate = new Date(new Date().setHours(0, 0, 0, 0))
    var endDate = new Date(new Date().setHours(23, 59, 59, 59))
    await admin.firestore().collection("event collection").where("start_date", ">=", startDate).where("start_date", "<=", endDate).get().then(async todayEvent=>{
      if(todayEvent.docs.length != 0){
        var installationProduct = (await admin.firestore().collection("products").where("mode", "==", "Installation Event Mode").get()).docs.map(e => e.ref)
        for (let a = 0; a < todayEvent.docs.length; a++) {
          var currentEventDoc = todayEvent.docs[a]
          var currentEventData = currentEventDoc.data()
          for (let i = 0; i < installationProduct.length; i+=10) {
            const subproduct = installationProduct.slice(i, i+10);
            await admin.firestore().collection("event participation request").where("productref", "in", subproduct).where("status", "==", "approved").where("eventref", "==", currentEventDoc.ref).get().then(async eventrequest=>{
              /**************************/
              var requestedProfileid = eventrequest.docs.map(e => e.data()["profileid"]) // Future store participant product ID
              // .where("producteligible", "==", "eligible")
              await admin.firestore().collection("participantsproduct").where("mode", "==", "Preparation Mode").where("productref", "in", subproduct).get().then(async participantProduct=>{
                /**************************/
                // Store Mode & Payment Status in Participant Product
                for (let i = 0; i < participantProduct.docs.length; i++) {
                  const product = participantProduct.docs[i];
                  var productData = product.data()
                  if(requestedProfileid.includes(productData["profileid"])){
                    batch.update(
                      product.ref, {
                      mode: "Installation Event Mode",
                      nextmode: "Integration Mode",
                      nextmodedate: new Date(new Date(currentEventData["end_date"].toDate()).setDate(currentEventData["end_date"].toDate().getDate() + 1))
                    })
                    batchCount = batchCount + 1
                    if(batchCount != 1 && batchCount % 500 == 0){
                      await batch.commit().then(()=>{
                        console.log("Batch", batchCount/500, "Done")
                      }).catch(err=>{
                        console.log(err)
                      })
                    }
                  }
                }
              })
            })
          }
          await calculateBigMode({
            eventref: currentEventDoc.ref,
            newmode: "Big Mode",
            nextmode: "Integration Mode",
            nextmodedate: new Date(new Date(currentEventData["end_date"].toDate()).setDate(currentEventData["end_date"].toDate().getDate() + 1))
          })
        }
      }
    })
    // Update Remaining Batch
    if(batchCount != 0 && batchCount % 500 != 0){
      await batch.commit().then(()=>{
        console.log("Remaing Batch Done")
      }).catch(err=>{
        console.log(err)
      })
    }
})

// Calculate Big Mode
async function calculateBigMode({eventref, newmode, nextmode, nextmodedate}){
    var invitationref = []
    await admin.firestore().collection("biginvitation").where("eventref", "==", eventref).where("status", "==", "accepted").get().then(invitation=>{
      invitationref = invitation.docs.map(e => e.ref)
    })  
    var batch = admin.firestore().batch()
    var batchCount = 0
    for (let i = 0; i < invitationref.length; i+=10) {
      const sublist = invitationref.slice(i, i+10);
      await admin.firestore().collection("deliverables").where("fileref", "array-contains-any", sublist).get().then(async deliverables=>{
        for (let a = 0; a < deliverables.docs.length; a++) {
          const deliverableDoc = deliverables.docs[a];
          var docData = deliverableDoc.data()
          if(docData["participantproductid"] != null && docData["status"] != "completed"){
            batch.update(admin.firestore().collection("participantsproduct").doc(docData["participantproductid"]), {
              mode: newmode,
              nextmode: nextmode,
              nextmodedate: nextmodedate
            })
            batchCount = batchCount + 1
            if(batchCount != 1 && batchCount % 500 == 0){
              await batch.commit().then((value)=>{
                console.log("Batch Done", batchCount/500, "--", value.length)
                batch = admin.firestore().batch()
              })
            }
          }
        }
      })
    }
    if(batchCount != 0 && batchCount % 500 != 0){
      await batch.commit().then((value)=>{
        console.log("Remaining Batch Done", value.length)
      })
    }
}

// Event Mode (Queue)
exports.eventMode = onSchedule({schedule: "00 00 * * *"}, async (context)=>{
    var batchCount = 0
    var batch = admin.firestore().batch()
    var startDate = new Date(new Date().setHours(0, 0, 0, 0))
    var endDate = new Date(new Date().setHours(23, 59, 59, 59))
    await admin.firestore().collection("queue generation").where("queuestartdate", ">=", startDate).where("queuestartdate", "<=", endDate).get().then(async todayEvent=>{
      if(todayEvent.docs.length != 0){
        var eventProduct = (await admin.firestore().collection("products").where("mode", "==", "Event Mode").get()).docs.map(e => e.ref)
        for (let a = 0; a < todayEvent.docs.length; a++) {
          var currentEventDoc = todayEvent.docs[a]
          var currentEventData = currentEventDoc.data()
          for (let i = 0; i < eventProduct.length; i+=10) {
            const subproduct = eventProduct.slice(i, i+10);
            await admin.firestore().collection("queue_token").where("productref", "in", subproduct).where("tokenstatus", "==", "Active").where("stagestatus", "==", "Approved").where("queueref", "==", currentEventDoc.ref).get().then(async eventrequest=>{
              /**************************/
              var requestedProfileid = eventrequest.docs.map(e => e.data()["profile_id"]) // Future store participant product ID
              // .where("producteligible", "==", "eligible")
              await admin.firestore().collection("participantsproduct").where("mode", "==", "Preparation Mode").where("productref", "in", subproduct).get().then(async participantProduct=>{
                /**************************/
                // Store Mode & Payment Status in Participant Product
                for (let i = 0; i < participantProduct.docs.length; i++) {
                  const product = participantProduct.docs[i];
                  var productData = product.data()
                  if(requestedProfileid.includes(productData["profileid"])){
                    batch.update(
                      product.ref, {
                      mode: "Event Mode",
                      nextmode: "Integration Mode",
                      nextmodedate: new Date(new Date(currentEventData["queueenddate"].toDate()).setDate(currentEventData["queueenddate"].toDate().getDate() + 1))
                    })
                    batchCount = batchCount + 1
                    if(batchCount != 1 && batchCount % 500 == 0){
                      await batch.commit().then(()=>{
                        console.log("Batch", batchCount/500, "Done")
                      }).catch(err=>{
                        console.log(err)
                      })
                    }
                  }
                }
              })
            })
          }
          await calculateBigMode({
            eventref: currentEventDoc.ref,
            newmode: "Big Mode",
            nextmode: "Integration Mode",
            nextmodedate: new Date(new Date(currentEventData["queueenddate"].toDate()).setDate(currentEventData["queueenddate"].toDate().getDate() + 1))
          })
        }
      }
    })
    // Update Remaining Batch
    if(batchCount != 0 && batchCount % 500 != 0){
      await batch.commit().then(()=>{
        console.log("Remaing Batch Done")
      }).catch(err=>{
        console.log(err)
      })
    }
})

// Integration Mode (Live Event) TODO
exports.IntegrationModeEvent = onSchedule({schedule : "00 00 * * *"} ,async (context)=>{
    var batchCount = 0
    var batch = admin.firestore().batch()
    var startDate = new Date(new Date(new Date().setHours(0, 0, 0, 0)).setDate(new Date().getDate() - 1))
    var endDate = new Date(new Date(new Date().setHours(23, 59, 59, 59)).setDate(new Date().getDate() - 1))
    await admin.firestore().collection("event collection").where("end_date", ">=", startDate).where("end_date", "<=", endDate).get().then(async eventcompleted=>{
      var eventRef = eventcompleted.docs.map(e => e.ref)
      console.log("event Ref", eventRef.length)
      if(eventRef.length != 0){
        var eventProduct = []
        var productIntegration = {}
        await admin.firestore().collection("products").orderBy("integrationdays").get().then(async product=>{
          for (let i = 0; i < product.docs.length; i++) {
            const productDoc = product.docs[i];
            var productData = productDoc.data()
            productIntegration[productDoc.id] = productData["integrationdays"] != null && productData["integrationdays"] != undefined ? productData["integrationdays"] : null
            if(["Installation Event Mode", "Big Mode"].includes(productData["mode"])){
              eventProduct.push(productDoc.ref)
            }
          }
        })
        console.log("event Product", eventProduct.length)
        for (let i = 0; i < eventProduct.length; i+=10) {
          const subproduct = eventProduct.slice(i, i+10);
          await admin.firestore().collection("event participation request").where("productref", "in", subproduct).where("status", "in", ["approved", "attended"]).where("eventref", "in", eventRef).get().then(async eventrequest=>{
            console.log("Participation Request", eventrequest.size)
            /**************************/
            var requestedProfileid = eventrequest.docs.map(e => e.data()["profileid"]) // Future store participant product ID
            // .where("producteligible ", "==", "eligible")
            await admin.firestore().collection("participantsproduct").where("mode", "in", ["Installation Event Mode", "Big Mode"]).where("productref", "in", subproduct).get().then(async participantProduct=>{
              console.log("Participant Product", participantProduct.size)
              /**************************/
              // Store Mode & Payment Status in Participant Product
              for (let i = 0; i < participantProduct.docs.length; i++) {
                const product = participantProduct.docs[i];
                var productData = product.data()
                if(requestedProfileid.includes(productData["profileid"])){
                  batch.update(
                    product.ref, {
                    mode: "Integration Mode",
                    status: "completed",
                    "statusdate.completed": new Date(),
                    nextmode: "Performance Mode",
                    nextmodedate: productIntegration[productData["productref"].id] == null ? null : new Date(new Date().setDate(new Date().getDate() + productIntegration[productData["productref"].id]))
                  })
                  batchCount = batchCount + 1
                  if(batchCount != 1 && batchCount % 500 == 0){
                    await batch.commit().then(()=>{
                      console.log("Batch", batchCount/500, "Done")
                    }).catch(err=>{
                      console.log(err)
                    })
                  }
                }
              }
            })
          })
        }
      }
    })
    // Update Remaining Batch
    if(batchCount != 0 && batchCount % 500 != 0){
      await batch.commit().then(()=>{
        console.log("Remaing Batch Done")
      }).catch(err=>{
        console.log(err)
      })
    }
    console.log("Batch Count", batchCount)
})

// Priority Mode
exports.priorityMode = onSchedule({schedule : "00 00 * * *"},async (context)=>{
    var startDate = new Date(new Date(new Date().setHours(0, 0, 0, 0)).setDate(new Date().getDate() + 15))
    var endDate = new Date(new Date(new Date().setHours(23, 59, 59, 59)).setDate(new Date().getDate() + 15))
    var batch = admin.firestore().batch()
    var batchCount = 0
    var priorityProduct = (await admin.firestore().collection("products").where("mode", "==", "Priority Mode").get()).docs.map(e => e.ref)
    var productDeliverySet = {}
    for (let a = 0; a < priorityProduct.length; a+=10) {
      const sublist = priorityProduct.slice(a, a + 10);
      await admin.firestore().collection('productToDeliverySequence').where('product', 'in', sublist).get().then( async querysnap => {
        for (let i = 0; i < querysnap.docs.length; i++) {
          var elementData = querysnap.docs[i].data()
          const deliveryoption = elementData["deliveryoptions"];
          if(deliveryoption != null && deliveryoption != undefined && deliveryoption.length != 0){
            productDeliverySet[elementData["product"].id] = deliveryoption[0]["deliverytype"]
          }
        }
      })
      // .where("producteligible", "==", "eligible")
      await admin.firestore().collection("participantsproduct").where("productref", "in", sublist).where("mode", "==", "Preparation Mode").where("participanttentativedate", ">=", startDate).where("participanttentativedate", "<=", endDate).get().then(async priorityProduct=>{
        for (let i = 0; i < priorityProduct.docs.length; i++) {
          const product = priorityProduct.docs[i];
          var productData = product.data()
          batch.update(
            product.ref, {
            deliverytype: productData["deliverytype"] == null || productData["deliverytype"] == undefined ? productDeliverySet[product["productref"].id] : productData["deliverytype"],
            mode: "Priority Mode",
            status: "initiated",
            "statusdate.initiated": new Date(),
            nextmode: "Integration Mode",
            nextmodedate: null
          })
          batchCount = batchCount + 1
          if(batchCount != 1 && batchCount % 500 == 0){
            await batch.commit().then(()=>{
              console.log("Batch", batchCount/500, "Done")
            }).catch(err=>{
              console.log(err)
            })
          }
        }
      })
    }
    // Update Remaining Batch
    if(batchCount != 0 && batchCount % 500 != 0){
      await batch.commit().then(()=>{
        console.log("Remaing Batch Done")
      }).catch(err=>{
        console.log(err)
      })
    }
  })
  
// Performance Mode
exports.performanceMode = onSchedule({schedule : "00 00 * * *"}, async (context)=>{
  var batchCount = 0
  var batch = admin.firestore().batch()
  await admin.firestore().collection("products").orderBy("integrationdays").get().then(async product=>{
    var productPerformanceDays = {}
    var lowestIntegration = 151
    var productIntegration = {}
    for (let i = 0; i < product.docs.length; i++) {
      const productDoc = product.docs[i];
      var productData = productDoc.data()
      if(productData["integrationdays"] != 0 && productData["integrationdays"] != null){
        productPerformanceDays[productDoc.id] = productData["performancedays"] != 0 && productData["performancedays"] != null && productData["performancedays"] != undefined ? (productData["performancedays"] + productData["integrationdays"]) : null
        productIntegration[productDoc.id] = productData["integrationdays"]
        if(productData["integrationdays"] > lowestIntegration){
          lowestIntegration = productData["integrationdays"]
        }
      }
    }
    console.log("Lowest Integration", lowestIntegration)
    if(lowestIntegration != 0){
      var startdate = new Date(new Date(new Date().setDate(new Date().getDate() - lowestIntegration)).setHours(23, 59, 59, 59))
      console.log("Start Date", startdate)
      await admin.firestore().collection("participantsproduct").where("mode", "==", "Integration Mode").where("statusdate.completed", ">=", startdate).get().then(async completedProduct=>{
        console.log("Pending Products", completedProduct.size)
        for (let i = 0; i < completedProduct.docs.length; i++) {
          const participantProduct = completedProduct.docs[i];
          var productData = participantProduct.data()
          var timedifference = Math.floor((new Date().getTime() - productData["statusdate"]["completed"].toDate().getTime()) / 1000 / 60 / 60 / 24)
          if(productIntegration[productData["productref"].id] != null && productIntegration[productData["productref"].id] != undefined){
            if(timedifference >= productIntegration[productData["productref"].id]){
              batch.update(
                participantProduct.ref, {
                mode: "Performance Mode",
                "statusdate.integrationcompleteddate": new Date(),
                nextmode: "Extended Performance Mode",
                nextmodedate: productPerformanceDays[productData["productref"].id] == null ? null : new Date(new Date(productData["statusdate"]["completed"].toDate()).setDate(productData["statusdate"]["completed"].toDate().getDate() + productPerformanceDays[productData["productref"].id]))
              })
              batchCount = batchCount + 1
              if(batchCount != 1 && batchCount % 500 == 0){
                await batch.commit().then(()=>{
                  console.log("Batch", batchCount/500, "Done")
                }).catch(err=>{
                  console.log(err)
                })
              }
            }
          }
        }
      })
      // Update Remaining Batch
      if(batchCount != 0 && batchCount % 500 != 0){
        await batch.commit().then(()=>{
          console.log("Remaing Batch Done")
        }).catch(err=>{
          console.log(err)
        })
      }
    }
  })
})
  
// Extended Performance Mode
exports.extendedPerformanceMode = onSchedule({schedule : "00 00 * * *"}, async (context)=>{
  var batchCount = 0
  var batch = admin.firestore().batch()
  await admin.firestore().collection("products").orderBy("performancedays").get().then(async product=>{
    var productAfterPerformanceDays = {}
    var lowestPerformance = 151
    var productPerformance = {}
    for (let i = 0; i < product.docs.length; i++) {
      const productDoc = product.docs[i];
      var productData = productDoc.data()
      if(productData["performancedays"] != 0 && productData["performancedays"] != null){
        productPerformance[productDoc.id] = productData["performancedays"] + productData["integrationdays"]
        productAfterPerformanceDays[productDoc.id] = productData["extendedperformancedays"] != 0 && productData["extendedperformancedays"] != null && productData["extendedperformancedays"] != undefined ? (productData["extendedperformancedays"] + productData["performancedays"] + productData["integrationdays"]) : null
        if(productPerformance[productDoc.id] > lowestPerformance){
          lowestPerformance = productPerformance[productDoc.id]
        }
      }
    }
    console.log("Lowest Performance", lowestPerformance)
    if(lowestPerformance != 0){
      var startdate = new Date(new Date(new Date().setDate(new Date().getDate() - lowestPerformance)).setHours(23, 59, 59, 59))
      console.log("Start Date", startdate)
      await admin.firestore().collection("participantsproduct").where("mode", "==", "Performance Mode").where("statusdate.completed", ">=", startdate).get().then(async completedProduct=>{
        console.log("Pending Products", completedProduct.size)
        for (let i = 0; i < completedProduct.docs.length; i++) {
          const participantProduct = completedProduct.docs[i];
          var productData = participantProduct.data()
          var timedifference = Math.floor((new Date().getTime() - productData["statusdate"]["completed"].toDate().getTime()) / 1000 / 60 / 60 / 24)
          if(productPerformance[productData["productref"].id] != null && productPerformance[productData["productref"].id] != undefined){
            if(timedifference >= productPerformance[productData["productref"].id]){
              batch.update(
                participantProduct.ref, {
                mode: "Extended Performance Mode",
                "statusdate.performancecompleteddate": new Date(),
                nextmode: "After Extended Performance Mode",
                nextmodedate: productAfterPerformanceDays[productData["productref"].id] == null ? null : new Date(new Date(productData["statusdate"]["completed"].toDate()).setDate(productData["statusdate"]["completed"].toDate().getDate() + productAfterPerformanceDays[productData["productref"].id]))
              })
              batchCount = batchCount + 1
              if(batchCount != 1 && batchCount % 500 == 0){
                await batch.commit().then(()=>{
                  console.log("Batch", batchCount/500, "Done")
                }).catch(err=>{
                  console.log(err)
                })
              }
            }
          }
        }
      })
      // Update Remaining Batch
      if(batchCount != 0 && batchCount % 500 != 0){
        await batch.commit().then(()=>{
          console.log("Remaing Batch Done")
        }).catch(err=>{
          console.log(err)
        })
      }
    }
  })
})
  
// After Extended Performance Mode
exports.afterextendedPerformanceMode = onSchedule({schedule: "00 00 * * *"}, async (context)=>{
  var batchCount = 0
  var batch = admin.firestore().batch()
  await admin.firestore().collection("products").orderBy("extendedperformancedays").get().then(async product=>{
    var lowestPerformance = 151
    var productPerformance = {}
    for (let i = 0; i < product.docs.length; i++) {
      const productDoc = product.docs[i];
      var productData = productDoc.data()
      if(productData["extendedperformancedays"] != 0 && productData["extendedperformancedays"] != null){
        productPerformance[productDoc.id] = productData["extendedperformancedays"] + productData["performancedays"] + productData["integrationdays"]
        if(productPerformance[productDoc.id] > lowestPerformance){
          lowestPerformance = productPerformance[productDoc.id]
        }
      }
    }
    console.log("Lowest Performance", lowestPerformance)
    if(lowestPerformance != 0){
      var startdate = new Date(new Date(new Date().setDate(new Date().getDate() - lowestPerformance)).setHours(23, 59, 59, 59))
      console.log("Start Date", startdate)
      await admin.firestore().collection("participantsproduct").where("mode", "==", "Extended Performance Mode").where("statusdate.completed", ">=", startdate).get().then(async completedProduct=>{
        console.log("Pending Products", completedProduct.size)
        for (let i = 0; i < completedProduct.docs.length; i++) {
          const participantProduct = completedProduct.docs[i];
          var productData = participantProduct.data()
          var timedifference = Math.floor((new Date().getTime() - productData["statusdate"]["completed"].toDate().getTime()) / 1000 / 60 / 60 / 24)
          if(productPerformance[productData["productref"].id] != null && productPerformance[productData["productref"].id] != undefined){
            if(timedifference >= productPerformance[productData["productref"].id]){
              batch.update(
                participantProduct.ref, {
                mode: "After Extended Performance Mode",
                "statusdate.extendedperformancecompleteddate": new Date(),
                nextmode: null,
                nextmodedate: null
              })
              batchCount = batchCount + 1
              if(batchCount != 1 && batchCount % 500 == 0){
                await batch.commit().then(()=>{
                  console.log("Batch", batchCount/500, "Done")
                }).catch(err=>{
                  console.log(err)
                })
              }
            }
          }
        }
      })
      // Update Remaining Batch
      if(batchCount != 0 && batchCount % 500 != 0){
        await batch.commit().then(()=>{
          console.log("Remaing Batch Done")
        }).catch(err=>{
          console.log(err)
        })
      }
    }
  })
})


exports.priorityPreparationMode = onSchedule({schedule : 'every 24 hours'}, async (context) => {
  let mapParticipantProduct = {}
  admin.firestore().collection("participantsproduct").where("mode","==","Early Preparation Mode").where("deliverymode","==","Priority Mode").get().then(ppsnap => {
    console.log(ppsnap.docs.length);
    for (let i = 0; i < ppsnap.docs.length; i++) {
      const element = ppsnap.docs[i].data();
      if(element['participanttentativedate']){
        mapParticipantProduct[element['docid']] = element['participanttentativedate'].toDate()
      }
    } 
    let batch = admin.firestore().batch()
    let count = 0
    for (const docid in mapParticipantProduct) {
      if(mapParticipantProduct[docid] >= new Date()){
        let diff = Math.abs(mapParticipantProduct[docid].getTime() - new Date().getTime())
        let days = Math.ceil(diff/(1000*3600*24))
        console.log("diff in days",days);
        if(days > 15 && days <= 30){
          count++
          console.log("between 15 to 30 days",days);
          let ref = admin.firestore().collection("participantsproduct").doc(docid)
          console.log(ref.path);
          batch.update(ref,{
            mode:"Preparation Mode",
            nextmode:"Priority Mode",
            nextmodedate:new Date(new Date(mapParticipantProduct[docid]).setDate(mapParticipantProduct[docid].getDate() - 15))
          })
          if(count != 0 && count%450 == 0 ){
            batch.commit().then(() => {
              batch = admin.firestore().batch()
              console.log("batch submitted",count/450);
            })
          }
        }
      }
    }
    batch.commit()
    console.log("Done");
  })
})
  
exports.queuePreparationMode = onSchedule({schedule : 'every 24 hours'},async (context) => {
  let upcomingQueueList = []
  let mapQueueGenerationIdToStartDate = {}
  await admin.firestore().collection("queue generation").where("queuestartdate",">",new Date()).get().then((upcomingQueueSnap => {
    for (let i = 0; i < upcomingQueueSnap.docs.length; i++) {
      const element = upcomingQueueSnap.docs[i].data();
      const elementref = upcomingQueueSnap.docs[i].ref
      let diff = Math.abs(element['queuestartdate'].toDate().getTime() - new Date().getTime())
      let days = Math.ceil(diff/(1000*3600*24))
      if(days > 15 && days <= 30){
        console.log(element['queuestartdate'].toDate(),days);
        upcomingQueueList.push(elementref)
        mapQueueGenerationIdToStartDate[elementref.id] = element['queuestartdate'].toDate()
      }else{
        console.log("else",element['queuestartdate'].toDate(),days);
      }
    }
  }))
  console.log("upcomingQueueList",upcomingQueueList.map(e => e.path));
  // get queue token participant
  let participantQueueTokenList = []
  let mapQueueTokenToQueueGenerationId = {}
  for (let i = 0; i < upcomingQueueList.length; i++) {
    const queueGenerationRef = upcomingQueueList[i];
    await admin.firestore().collection("queue_token").where("queueref","==",queueGenerationRef).get().then(queueTokenSnap => {
      for (let j = 0; j < queueTokenSnap.docs.length; j++) {
        const queueTokenElement = queueTokenSnap.docs[j].data();
        const queueTokenElementRef = queueTokenSnap.docs[j].ref
        participantQueueTokenList.push(queueTokenElementRef)
        mapQueueTokenToQueueGenerationId[queueTokenElementRef.id] = queueGenerationRef.id
      }
    })
  }
  // get participantproductref
  let batch = admin.firestore().batch()
  let count = 0
  for (let i = 0; i < participantQueueTokenList.length; i=i+10) {
    await admin.firestore().collection("deliverables").where("fileref","array-contains-any",participantQueueTokenList.slice(i,i+10)).get().then(async deliverablesnap => {
      if(deliverablesnap.docs.length != 0){
        for (let j = 0; j < deliverablesnap.docs.length; j++) {
          const element = deliverablesnap.docs[j].data();
          count++
          let ppref = admin.firestore().collection("participantsproduct").doc(element['participantproductid'])
          let getQueueTokenId = participantQueueTokenList.slice(i,i+10).filter( e => element['fileref'].some(item => item.id === e.id))
          console.log(count,element['participantproductid'],mapQueueGenerationIdToStartDate[mapQueueTokenToQueueGenerationId[getQueueTokenId[0].id]]);
          batch.update(ppref,{
            mode:"Preparation Mode",
            nextmode:"Event Mode",
            nextmodedate:mapQueueGenerationIdToStartDate[mapQueueTokenToQueueGenerationId[getQueueTokenId[0].id]]
          })
          if(count != 0 && count%450 == 0){
            await batch.commit().then(() => {
              batch = admin.firestore().batch()
              console.log("batch updated",count/450);
            })
          }
        }
      }
    })
  }
  batch.commit()
  console.log("Done");
})
  
exports.eventPreparationMode =  onSchedule({schedule : 'every 24 hours'},async (context) => {
  console.log("changeToPreparationModeForEventParticipants");
  var count
  let upcomingEvents = []
  let mapUpcomingEventToStartDate = {}
  await admin.firestore().collection("event collection").where("start_date",">",new Date()).get().then(async eventsnap => {
    for (let i = 0; i < eventsnap.docs.length; i++) {
      const element = eventsnap.docs[i].data();
      const elementref = eventsnap.docs[i].ref
      let diff = Math.abs(element['start_date'].toDate().getTime() - new Date().getTime())
      let days = Math.ceil(diff/(1000*3600*24))
      if(days > 15 && days <= 30){
        console.log(element['start_date'].toDate(),days);
        upcomingEvents.push(elementref)
        mapUpcomingEventToStartDate[elementref.id] = element['start_date'].toDate()
      }else{
        console.log("else",element['start_date'].toDate(),days);
      }
    }
  })
  //get event participation request
  let eventParticipantIdToEventCollectionId = {}
  let eventParticipantRequestList = []
  for (let i = 0; i < upcomingEvents.length; i++) {
    const eventRef = upcomingEvents[i];
    await admin.firestore().collection("event participation request").where("eventref","==",eventRef).where("status","==","Approved").get().then(eventParticipationSnap => {
      for (let i = 0; i < eventParticipationSnap.docs.length; i++) {
        const element = eventParticipationSnap.docs[i].data();
        const elementRef = eventParticipationSnap.docs[i].ref
        eventParticipantIdToEventCollectionId[elementRef.id] = eventRef.id
        eventParticipantRequestList.push(elementRef)
      } 
    })
  }
  //update participant
  let batch = admin.firestore().batch()
  for (let i = 0; i < eventParticipantRequestList.length; i=i+10) {
    await admin.firestore().collection("deliverables").where("fileref","array-contains",eventParticipantRequestList.slice(i,i+10)).get().then(async deliverableSnap => {
      if(deliverableSnap.docs.length != 0){
        for (let j = 0; j < deliverableSnap.docs.length; j++) {
          const element = deliverableSnap.docs[j].data();
          count++
          let ppref = admin.firestore().collection("participantsproduct").doc(element['participantproductid'])
          let getEventParticipationId = eventParticipantRequestList.slice(i,i+10).filter(e => element['fileref'].some(item => item.id === e.id))
          console.log(count,element['participantproductid'],getEventParticipationId);
          batch.update(ppref,{
            mode:"Preparation Mode",
            nextmode:"Installation Event Mode",
            nextmodedate:mapUpcomingEventToStartDate[eventParticipantIdToEventCollectionId[getEventParticipationId[0].id]]
          })
          if(count != 0 && count%450 == 0){
            await batch.commit().then(() => {
              batch = admin.firestore().batch()
              console.log("batch updated",count/450);
            })
          }
        }
      }
    })
  }
  await batch.commit()
  console.log("Done")
})

async function updateDeliveryStatus(apptPath, status){
  await admin.firestore().collection("deliverables").where("fileref", "array-contains", admin.firestore().doc(apptPath)).get().then(async deliverable=>{
    for (let i = 0; i < deliverable.docs.length; i++) {
      const doc = deliverable.docs[i];
      await doc.ref.update({
        status: status
      })

      await admin.firestore().collection("participantdeliverysequence").doc(doc.data()["profileid"]).get().then(async snapshot=>{
        if(snapshot.exists){
          var record = snapshot.data()
          for (let i = 0; i < record["products"].length; i++) {
            const product = record["products"][i];
            var oldProductStatus = null
            var newProductStatus = null
            var statusDate = {}
            for (let j = 0; j < product.delivery.length; j++) {
              const delivery = product.delivery[j];
              if(delivery.sequenceref.path == doc.ref.path){
                delivery.status = status
                await admin.firestore().collection("participantsproduct").doc(product.participantproductid).get().then(async productDoc=>{
                  var productData = productDoc.data()
                  oldProductStatus = productData["status"] != null ? productData["status"] : null
                  newProductStatus = productData["status"] != null ? productData["status"] : null
                  statusDate = productData["statusdate"] != null ? productData["statusdate"] : {}
                  for(const key in statusDate){
                    if(statusDate[key] != null){
                      statusDate[key] = statusDate[key] != null ? statusDate[key].toDate() : null
                    }
                  }
                })
                if(status == "completed"){
                  if(j+1 < product.delivery.length){
                    product.delivery[j+1].status = "ready"
                  }
                }
                if(product.delivery.filter(e => e.status == "completed").length == product.delivery.length){
                  if(newProductStatus != "completed"){
                    newProductStatus = "completed"
                  }
                }
                else if(product.delivery.filter(e => e.status == "completed" || e.status == "ongoing").length > 0){
                  if(newProductStatus != "ongoing"){
                    newProductStatus = "ongoing"
                  }
                }
                else if(product.delivery.filter(e => e.status == "ready").length != 0){
                  if(newProductStatus != "initiated"){
                    newProductStatus = "initiated"
                  }
                }
                if(newProductStatus != oldProductStatus){
                  if(statusDate[newProductStatus] == null || statusDate[newProductStatus] == undefined){
                    statusDate[newProductStatus] = new Date()
                  }
                  await admin.firestore().collection("participantsproduct").doc(product.participantproductid).update({
                    status: newProductStatus,
                    statusdate: statusDate
                  })
                }
                i = 1000
                j = 1000
              }
            }
          }
          await snapshot.ref.update(record).catch(err => {
            console.log(err)
          })
        }
      })
      break;
    }
  })
}

async function updateParticipantMetadataTierAccess(profileidArg,path){
  let profileid = profileidArg
  let mapProfileData = {}
  await admin.firestore().collection("profile_data").where("profileid","==",profileid).get().then(snap => {
    for (let i = 0; i < snap.docs.length; i++) {
      const element = snap.docs[i].data();
      mapProfileData[element['profileid']] = ![null,undefined].includes(element['user_ref']) ? element['user_ref'].id : null
    }
  })
  let mapTier = {}
  await admin.firestore().collection("tier").get().then(tierSnap => {
    for (let i = 0; i < tierSnap.docs.length; i++) {
      const element = tierSnap.docs[i].data();
      mapTier[element['id']] = element['tier']
    }
  })
  let profileData = null
  await admin.firestore().collection("participant metadata").doc(profileid).get().then(_pmdSnap => {
    profileData = _pmdSnap.data()
  })
  let userid = mapProfileData[profileid]
  console.log("userid",userid,profileData['name']);
  //
  try {
    if(![null,undefined].includes(userid) && ![null,undefined].includes(profileData)){
      await admin.firestore().collection("user").doc(userid).get().then(async userSnap => {
        console.log("is user exist",userSnap.exists);
        if(userSnap.exists){
          await admin.firestore().collection("tier access config").get().then(async tierConfigSnap => {
            let configElement = tierConfigSnap.docs.map(e => e.data())
            await admin.firestore().collection("big aggregate level").where("profileid","==",profileid).get().then(async levelAggregateSnap => {
              let levelAggregateElement = levelAggregateSnap.docs.map(e => e.data())
              let tierUpdated = false
              let getTier = []
              //first checkby big level
              if(levelAggregateElement.length != 0){
                let getTierlevel = configElement.filter(e => e['tieraccessby'] === 'biglevel')
                for (let k = 0; k < getTierlevel.length; k++) {
                  for (let j = 0; j < getTierlevel[k]['biglevel'].length; j++) {
                    if(levelAggregateElement.some(e => getTierlevel[k]['biglevel'][j]['atcmodel'] === e['atcmodel'] && getTierlevel[k]['biglevel'][j]['biglevelid'].includes(e['level'].id))){
                      if(!getTier.includes(getTierlevel[k]['tierid'])){
                        getTier.push(getTierlevel[k]['tierid'])
                        tierUpdated = true
                      }
                    }
                  }
                }
              }else{console.log("profile doesn't has any level");}
              //second check by active journey product
              let activeJourney = profileData['activejourney'] ? profileData['activejourney'] : profileData['lastcompletedjourney']
              if(activeJourney && 
                (![null,undefined].includes(profileData['consumedproducts']) ? profileData['consumedproducts'].length != 0 : false) && 
                tierUpdated === false
              ){
                console.log("profile has active journey & product consumed");
                let getTierByProduct = configElement.filter(e => e['tieraccessby'] === 'product')
                for (let k = 0; k < getTierByProduct.length; k++) {
                  Object.prototype.hasOwnProperty.call(getTierByProduct[k]['productaccess'],activeJourney)
                  if(getTierByProduct[k]['productaccess'].prototype.hasOwnProperty.call(activeJourney)){
                    for (let j = 0; j < getTierByProduct[k]['productaccess'][activeJourney].length; j++) {
                      const productelement = getTierByProduct[k]['productaccess'][activeJourney][j];
                      let filterConsumedProducts = profileData['consumedproducts'].filter(e => e === productelement['productid'])
                      if(filterConsumedProducts.length >= productelement['count']){
                        if(!getTier.includes(getTierByProduct[k]['tierid'])){
                          getTier.push(getTierByProduct[k]['tierid'])
                          tierUpdated = true
                        }
                      }
                    }
                  }
                }
                if(tierUpdated === false){
                  console.log("tier not updated ,  active journey & consumed products are even available");
                  if(!getTier.includes("2yDtPQVMVqe80S8cB2DR")){
                    getTier.push("2yDtPQVMVqe80S8cB2DR")
                  }
                }
              }else{
                console.log("Active journey is null",activeJourney,"Or consumedProducts",profileData['consumedproducts']);
                if([null,undefined].includes(activeJourney)){
                  if(!getTier.includes("2UjrsgbxwY2nitzMSxRN")){
                    getTier.push("2UjrsgbxwY2nitzMSxRN")
                  }
                }else{
                  if(!getTier.includes("2yDtPQVMVqe80S8cB2DR")){
                    getTier.push("2yDtPQVMVqe80S8cB2DR")
                  }
                }
              }
              //update tier
              let convertToTierString = getTier.map(e => mapTier[e])
              console.log("tier",profileData['name'],getTier,convertToTierString);
              await admin.firestore().collection("user").doc(userid).set({
                tier:convertToTierString,
                metatier:getTier
              },{merge:true}).then(() => {
                admin.firestore().collection("participant metadata").doc(profileid).set({
                  tier:getTier
                },{merge:true})
              })
            })
          })
        }
      })
      return null
    }
  }catch (error) {
    await commonService.throwParticipantMetaDataException({
      profileid: profileid,
      failed: "updateParticipantMetadataTierAccess",
      triggerdoc: path,
      err: error.toString()
    })
  }
}

/*
exports.appointmentbooked = onDocumentCreated("/appointments/{docid}", async (snapshotdata) =>{
  var snapshot = snapshotdata.data
  if(snapshot.exists){
    var appointmentname = ""
    var duration;
    var bookedby = {
      name: "",
      email: ""
    }
    var date = ""
    var hosts = [{
      name: "",
      email: "",
      role: "",
    }]
    hosts = []
    var zoomurl = ""
    var zoomid = ""
    var zoompassword = ""

    // Main EIS Roles
    var mainRoles = ["eisroles/mz7tx7W02rx5VvaduaFT", "eisroles/IyvM6K3Sl90Tm5YZSp6W", "eisroles/f5wT99oyCANbIfXIfKCM", "eisroles/tUibFLhrQadcIT7FjENb"]

    await admin.firestore().doc(snapshot.data()["appointment"].path).get().then(appointmentDoc=>{
      var name = appointmentDoc.data()["appointmenttype"]
      var list = name.split(" ")
      var value = ""
      for (let i = 0; i < list.length; i++) {
        const element = list[i];
        if(element.toLowerCase() != "type"){
          value = value + " " + element
        }
        else{
          break
        }
      }
      appointmentname = value.trim()
      duration = appointmentDoc.data()["duration"].toString() + " Mins"
    })
    await admin.firestore().doc(snapshot.data()["bookedby"].path).get().then(profile=>{
      bookedby.name = profile.data()["name"]
      bookedby.email = profile.data()["email"]
    })
    var starttime = snapshot.data()["starttime"].toDate()
    var endtime = snapshot.data()["endtime"].toDate()
    var formatedStartTime = new Date(starttime.getFullYear(), starttime.getMonth(), starttime.getDate(), starttime.getHours()+5, starttime.getMinutes()+30, 0);
    var formatedEndTime = new Date(endtime.getFullYear(), endtime.getMonth(), endtime.getDate(), endtime.getHours()+5, endtime.getMinutes()+30, 0);
    date = formatedStartTime.toDateString() + " at " + (formatedStartTime.getHours()%12 || 12) + ":" + (formatedStartTime.getMinutes().toString().length == 1 ? ("0"+formatedStartTime.getMinutes().toString()) : formatedStartTime.getMinutes()) + (formatedStartTime.getHours() < 12 ? "AM" : "PM") + " - " + (formatedEndTime.getHours()%12 || 12) + ":" + (formatedEndTime.getMinutes().toString().length == 1 ? ("0"+formatedEndTime.getMinutes().toString()) : formatedEndTime.getMinutes()) + (formatedEndTime.getHours() < 12 ? "AM" : "PM") + " IST"
    var appointmentRoles = []
    for (let i = 0; i < snapshot.data()["appointmentrole"].length; i++) {
      const element = snapshot.data()["appointmentrole"][i];
      appointmentRoles.push(element.path)
    }
    appointmentRoles = Array.from(new Set(appointmentRoles))
    
    for (let i = 0; i < mainRoles.length; i++) {
      const mainelement = mainRoles[i];
      for (let j = 0; j < appointmentRoles.length; j++) {
        const roleelement = appointmentRoles[j];
        if(mainelement == roleelement){
          var mainHost = snapshot.data()["hostRole"][mainelement][0]
          console.log(mainHost.id)
          await admin.firestore().collection("EISzoomcontact").doc(mainHost.id).get().then(zoomcontact=>{
            if(zoomcontact.exists){
              zoomurl = zoomcontact.data()["zoomurl"]
              zoomid = zoomcontact.data()["zoomid"]
              zoompassword = zoomcontact.data()["zoompassword"]
            }
            else{
              console.log("NOT EXIST")
            }
          }).catch(err=>{
            console.log(err)
          });
          i = 1000
          j = 1000
        }
      }
    }
    
    for (let i = 0; i < appointmentRoles.length; i++) {
      const aptRole = appointmentRoles[i];
      const roleName = (await admin.firestore().doc(aptRole).get()).data()["role"].toLowerCase()
      for (let j = 0; j < snapshot.data()["hostRole"][aptRole].length; j++) {
        var host = snapshot.data()["hostRole"][aptRole][j];
        await admin.firestore().collection("EISzoomcontact").doc(host.id).get().then(async contact=>{
          if(contact.exists){
            hosts.push({
              name: contact.data()["name"],
              email: contact.data()["email"],
              role: roleName
            })
            if(zoomurl == ""){
              zoomurl = contact.data()["zoomurl"]
              zoomid = contact.data()["zoomid"]
              zoompassword = contact.data()["zoompassword"]
            }
          }
          else{
            await admin.firestore().doc(host.path).get().then(profile=>{
              hosts.push({
                name: profile.data()["name"],
                email: profile.data()["email"],
                role: roleName
              })
            })
          }
        }) 
      }
    }

    // Save Zoom Meeting Data
    await snapshot.ref.update({
      zoomurl: zoomurl,
      zoomid: zoomid,
      zoompassword: zoompassword,
    })

    // Send Email
    var dataModel = {
      product_name: "StarLabs - Scheduling",
      appointment: appointmentname,
      date: date,
      duration: duration,
      client: bookedby.name,
      zoomurl: zoomurl,
      zoomid: zoomid,
      zoompassword: zoompassword,
      company_name: "Antano & Harini",
    }
    // if(appointmentname.includes("Journey")){
    //   dataModel["assitancename"] = "Mr.Milan"
    //   dataModel["assitancenumber"] = "+91 80982 73877"
    // }
    // else if(appointmentname.includes("Critical") || appointmentname.includes("Light")){
    //   dataModel["assitancename"] = "Ms.Agalya Das"
    //   dataModel["assitancenumber"] = "+91 93611 38763"
    // }
    // else{
      dataModel["assitancename"] = "Ms.Dhivya D'cruz & Mr. Solomon"
      dataModel["assitancenumber"] = "+91 81225 51403"
    // }
    var names = []
    for (let i = 0; i < hosts.length; i++) {
      const hostName = hosts[i].name;
      names.push(hostName)
      if(hosts[i].role.includes("collaborator")){
        dataModel["implementation"] = dataModel["implementation"] == undefined ? ""+hostName : dataModel["implementation"] + ", " + hostName
      }
      else if(hosts[i].role.includes("shadow") && hosts[i].role.includes("implementation")){
        dataModel["implementationshadow"] = dataModel["implementationshadow"] == undefined ? ""+hostName : dataModel["implementationshadow"] + ", " + hostName
      }
      else if(!hosts[i].role.includes("shadow") && hosts[i].role.includes("implementation")){
        dataModel["implementation"] = dataModel["implementation"] == undefined ? ""+hostName : dataModel["implementation"] + ", " + hostName
      }
      else if(hosts[i].role.includes("diagnostic")){
        dataModel["diagnostic"] = dataModel["diagnostic"] == undefined ? ""+hostName : dataModel["diagnostic"] + ", " + hostName
      }
      else if(hosts[i].role.includes("clarity")){
        dataModel["accelerator"] = dataModel["accelerator"] == undefined ? ""+hostName : dataModel["accelerator"] + ", " + hostName
      }
      else if(hosts[i].role.includes("testimonial")){
        dataModel["sales"] = dataModel["sales"] == undefined ? ""+hostName : dataModel["sales"] + ", " + hostName
      }
      else{
        dataModel["host"] = dataModel["host"] == undefined ? ""+hostName : dataModel["host"] + ", " + hostName
      }
    }
    // Calendar Data
    var calendarData =
    "BEGIN:VCALENDAR\n" +
    "CALSCALE:GREGORIAN\n" +
    "METHOD:PUBLISH\n" +
    "PRODID:-//Test Cal//EN\n" +
    "VERSION:2.0\n" +
    "BEGIN:VEVENT\n" +
    "UID:test-1\n" +
    "DTSTART;VALUE=DATE:" + commonService.convertDate(starttime) +
    "\n" +
    "DTEND;VALUE=DATE:" + commonService.convertDate(endtime) +
    "\n" +
    "SUMMARY:" + appointmentname +
    "\n" +
    "SEQUENCE:0\n" +
    "DESCRIPTION:" + "Appointment Scheduled For " + appointmentname +
    "\n" +
    "ORGANIZER;CN="+names.join(', ')+":MAILTO:vignesh.s@soexcellence.com" +
    "\n" +
    "END:VEVENT\n" +
    "END:VCALENDAR";
    await commonService.postmarkClient.sendEmailWithTemplate({
      From: "starlabs@excellenceinstallation.com",
      To: bookedby.email,
      TemplateAlias: "appointment-scheduled",
      TemplateModel: dataModel,
      Attachments: [
        {
        "Name": "appointment.ics",
        "Content": Buffer.from(calendarData).toString('base64'),
        "ContentType": "text/calendar; charset=utf-8; method=REQUEST"
        }
      ],
    }).catch(err=>{
      console.log(err)
    });
    for (let i = 0; i < hosts.length; i++) {
      const element = hosts[i];
      await commonService.postmarkClient.sendEmailWithTemplate({
        From: "starlabs@excellenceinstallation.com",
        To: element.email,
        TemplateAlias: "appointment-scheduled",
        TemplateModel: dataModel,
        Attachments: [
          {
          "Name": "appointment.ics",
          "Content": Buffer.from(calendarData).toString('base64'),
          "ContentType": "text/calendar; charset=utf-8; method=REQUEST"
          }
        ],
      }).catch(err=>{
        console.log(err)
      });
    }

    // Send Notification
    var body = appointmentname + " is confirmed with " + names.join(', ') + " on " + commonService.monthName[starttime.getMonth()] + " " + starttime.getDate() + ", " + starttime.getFullYear() + " " + (formatedStartTime.getHours()%12 || 12) + ":" + (formatedStartTime.getMinutes().toString().length == 1 ? ("0"+formatedStartTime.getMinutes().toString()) : formatedStartTime.getMinutes()) + (formatedStartTime.getHours() < 12 ? "AM" : "PM")
    await commonService.saveNotificationRecord({
      title: "Your Appointment is confirmed with us!",
      message: body,
      subtitle: null,
      date: admin.firestore.FieldValue.serverTimestamp(),
      landingpage: null,
      logged: true,
      profileid: [snapshot.data()["bookedby"].id],
      sticky: false,
      notificationtype: "appointment",
      notificationimage: null,
      metadata: {
        appointmentid: snapshot.id
      }
    })
    var hostid = []
    var hostbody = bookedby.name + " has booked your slot for " +  appointmentname + " on " + commonService.monthName[starttime.getMonth()] + " " + starttime.getDate() + ", " + starttime.getFullYear() + " " + (formatedStartTime.getHours()%12 || 12) + ":" + (formatedStartTime.getMinutes().toString().length == 1 ? ("0"+formatedStartTime.getMinutes().toString()) : formatedStartTime.getMinutes()) + (formatedStartTime.getHours() < 12 ? "AM" : "PM")
    for (let i = 0; i < snapshot.data()["hosts"].length; i++) {
      const hosts = snapshot.data()["hosts"][i];
      hostid.push(hosts.id)
    }
    await commonService.saveNotificationRecord({
      title: "Your Slot is confirmed with " + bookedby.name,
      message: hostbody,
      subtitle: null,
      date: admin.firestore.FieldValue.serverTimestamp(),
      landingpage: null,
      logged: true,
      profileid: hostid,
      sticky: false,
      notificationtype: "appointment",
      notificationimage: null,
      metadata: {
        appointmentid: snapshot.id
      }
    })

    // Assign Host to Client
    // Diagnostics
    if(snapshot.data()["appointment"].path == "appointmenttype/AkOr1WLFFq2ttBIQQKYe"){
      var diagnosticPerson = snapshot.data()["hostRole"]["eisroles/mz7tx7W02rx5VvaduaFT"]
      var collaborator = snapshot.data()["hostRole"]["eisroles/aoe1uANIDQho8FfylFWN"]

      await admin.firestore().collection("customer_eismapping").doc(snapshot.data()["bookedby"].id).get().then(async eisMapping=>{
        var rolesPath = []
        var mappedEIS = {}
        if(eisMapping.exists){
          eisMapping.data()["roles"].forEach(ref=>{
            rolesPath.push(ref.path)
          })
          mappedEIS = eisMapping.data()["eisroles"]
        }

        // Implementation
        mappedEIS["eisroles/IyvM6K3Sl90Tm5YZSp6W"] = collaborator
        if(!rolesPath.includes("eisroles/IyvM6K3Sl90Tm5YZSp6W")){
          rolesPath.push("eisroles/IyvM6K3Sl90Tm5YZSp6W")
        }
        // Review
        mappedEIS["eisroles/f5wT99oyCANbIfXIfKCM"] = diagnosticPerson
        if(!rolesPath.includes("eisroles/f5wT99oyCANbIfXIfKCM")){
          rolesPath.push("eisroles/f5wT99oyCANbIfXIfKCM")
        }
        // Review Collaborator
        mappedEIS["eisroles/z12qMJ5tDzQqRyGrjujz"] = collaborator
        if(!rolesPath.includes("eisroles/z12qMJ5tDzQqRyGrjujz")){
          rolesPath.push("eisroles/z12qMJ5tDzQqRyGrjujz")
        }
        // Celebration
        mappedEIS["eisroles/tUibFLhrQadcIT7FjENb"] = diagnosticPerson
        if(!rolesPath.includes("eisroles/tUibFLhrQadcIT7FjENb")){
          rolesPath.push("eisroles/tUibFLhrQadcIT7FjENb")
        }
        // Celebration Collaborator
        mappedEIS["eisroles/Ns78YMfOrSRsrZr51fkA"] = collaborator
        if(!rolesPath.includes("eisroles/Ns78YMfOrSRsrZr51fkA")){
          rolesPath.push("eisroles/Ns78YMfOrSRsrZr51fkA")
        }

        var roleRef = []
        rolesPath.forEach(path=>{
          roleRef.push(admin.firestore().doc(path))
        })

        await admin.firestore().collection("customer_eismapping").doc(snapshot.data()["bookedby"].id).set({
          roles: roleRef,
          eisroles: mappedEIS,
          profile_ref: admin.firestore().doc(snapshot.data()["bookedby"].path)
        }, {merge: true})
      })
    }
    // Celebration
    else if(snapshot.data()["appointment"].path == "appointmenttype/gQR1GKk9no7YQqk2yoCW"){

      await admin.firestore().collection("customer_eismapping").doc(snapshot.data()["bookedby"].id).get().then(async eisMapping=>{
        var rolesPath = []
        var mappedEIS = {}
        if(eisMapping.exists){
          eisMapping.data()["roles"].forEach(ref=>{
            rolesPath.push(ref.path)
          })
          mappedEIS = eisMapping.data()["eisroles"]
        }

        // Implementation
        delete mappedEIS["eisroles/IyvM6K3Sl90Tm5YZSp6W"]
        if(rolesPath.includes("eisroles/IyvM6K3Sl90Tm5YZSp6W")){
           var impIndex = rolesPath.findIndex(e => e == "eisroles/IyvM6K3Sl90Tm5YZSp6W")
           rolesPath.splice(impIndex, 1)
        }
        // Review
        delete mappedEIS["eisroles/f5wT99oyCANbIfXIfKCM"]
        if(rolesPath.includes("eisroles/f5wT99oyCANbIfXIfKCM")){
          var revIndex = rolesPath.findIndex(e => e == "eisroles/f5wT99oyCANbIfXIfKCM")
          rolesPath.splice(revIndex, 1)
        }
        // Review Collaborator
        delete mappedEIS["eisroles/z12qMJ5tDzQqRyGrjujz"]
        if(rolesPath.includes("eisroles/z12qMJ5tDzQqRyGrjujz")){
          var revCIndex = rolesPath.findIndex(e => e == "eisroles/z12qMJ5tDzQqRyGrjujz")
          rolesPath.splice(revCIndex, 1)
        }
        // Celebration
        delete mappedEIS["eisroles/tUibFLhrQadcIT7FjENb"]
        if(rolesPath.includes("eisroles/tUibFLhrQadcIT7FjENb")){
          var celIndex = rolesPath.findIndex(e => e == "eisroles/tUibFLhrQadcIT7FjENb")
          rolesPath.splice(celIndex, 1)
        }
        // Celebration Collaborator
        delete mappedEIS["eisroles/Ns78YMfOrSRsrZr51fkA"]
        if(rolesPath.includes("eisroles/Ns78YMfOrSRsrZr51fkA")){
          var celCIndex = rolesPath.findIndex(e => e == "eisroles/Ns78YMfOrSRsrZr51fkA")
          rolesPath.splice(celCIndex, 1)
        }

        var roleRef = []
        rolesPath.forEach(path=>{
          roleRef.push(admin.firestore().doc(path))
        })

        await admin.firestore().collection("customer_eismapping").doc(snapshot.data()["bookedby"].id).set({
          roles: roleRef,
          eisroles: mappedEIS,
          profile_ref: admin.firestore().doc(snapshot.data()["bookedby"].path)
        }, {merge: true})
      })
    }

  }
})


exports.appointmentremainder = onSchedule({schedule: "every 5 minutes"}, async (event) => {
  var currentTime = new Date()
  // 5 Minutes
  var nextfive = new Date(new Date(currentTime).setMinutes(currentTime.getMinutes() + 5))
  console.log(currentTime.toTimeString(), nextfive.toTimeString())
  await admin.firestore().collection("appointments").where("cancelled", "==", false).where("starttime", ">=", currentTime).where("starttime", "<=", nextfive).get().then(async appt=>{
    console.log(appt.size)
    var profileid = []
    if(appt.docs.length != 0){
      for (let i = 0; i < appt.docs.length; i++) {
        const appDoc = appt.docs[i]
        const apptData = appDoc.data();
        var appointmentName = ""
        var appointmentTime = apptData["starttime"].toDate()
        var formatTime = (appointmentTime.getHours()%12 || 12) + ":" + (appointmentTime.getMinutes().toString().length == 1 ? ("0"+appointmentTime.getMinutes().toString()) : appointmentTime.getMinutes()) + (appointmentTime.getHours() < 12 ? "AM" : "PM")
        await admin.firestore().doc(apptData["appointment"].path).get().then(data=>{
          appointmentName = data.data()["appointmenttype"]
        }).catch(e => {})
        profileid.push(apptData["bookedby"].id)
        apptData["hosts"].forEach(e =>{
          profileid.push(e.id)
        })
        var title = appointmentName + " Reminder!"
        var message = "You have appointment scheduled in next 5 minutes"
        await commonService.saveNotificationRecord({
          title: title,
          message: message,
          subtitle: null,
          date: admin.firestore.FieldValue.serverTimestamp(),
          landingpage: null,
          logged: false,
          profileid: profileid,
          sticky: false,
          notificationtype: "appointmentreminder",
          notificationimage: null,
          metadata: {
            appointmentid: appDoc.id
          }
        })
      }
    }
  })

  // One Hour
  var starttime = new Date(new Date(currentTime).setMinutes(currentTime.getMinutes() + 55))
  var endtime = new Date(new Date(currentTime).setMinutes(currentTime.getMinutes() + 60))
  console.log(starttime.toTimeString(), endtime.toTimeString())
  await admin.firestore().collection("appointments").where("cancelled", "==", false).where("starttime", ">=", starttime).where("starttime", "<=", endtime).get().then(async appt=>{
    console.log(appt.size)
    var profileid = []
    if(appt.docs.length != 0){
      for (let i = 0; i < appt.docs.length; i++) {
        const appDoc = appt.docs[i]
        const apptData = appDoc.data();
        var appointmentName = ""
        var appointmentTime = apptData["starttime"].toDate()
        var formatTime = (appointmentTime.getHours()%12 || 12) + ":" + (appointmentTime.getMinutes().toString().length == 1 ? ("0"+appointmentTime.getMinutes().toString()) : appointmentTime.getMinutes()) + (appointmentTime.getHours() < 12 ? "AM" : "PM")
        await admin.firestore().doc(apptData["appointment"].path).get().then(data=>{
          appointmentName = data.data()["appointmenttype"]
        }).catch(e => {})
        profileid.push(apptData["bookedby"].id)
        apptData["hosts"].forEach(e =>{
          profileid.push(e.id)
        })
        var title = appointmentName + " Reminder!"
        var message = "You have appointment scheduled in next 1 hour"
        await commonService.saveNotificationRecord({
          title: title,
          message: message,
          subtitle: null,
          date: admin.firestore.FieldValue.serverTimestamp(),
          landingpage: null,
          logged: false,
          profileid: profileid,
          sticky: false,
          notificationtype: "appointmentreminder",
          notificationimage: null,
          metadata: {
            appointmentid: appDoc.id
          }
        })
      }
    }
  })
})

exports.resentAppointmentEmail = onRequest(async (req, res)=>{
  var appointmentID = req.query.appointmentid
  await admin.firestore().collection("appointments").doc(appointmentID).get().then(async snapshot=>{
    if(snapshot.exists){
      var appointmentname = ""
      var duration;
      var bookedby = {
        name: "",
        email: ""
      }
      var date = ""
      var hosts = [{
        name: "",
        email: "",
        role: "",
      }]
      hosts = []
      var zoomurl = ""
      var zoomid = ""
      var zoompassword = ""
  
      // Main EIS Roles
      var mainRoles = ["eisroles/mz7tx7W02rx5VvaduaFT", "eisroles/IyvM6K3Sl90Tm5YZSp6W", "eisroles/f5wT99oyCANbIfXIfKCM", "eisroles/tUibFLhrQadcIT7FjENb"]
  
      await admin.firestore().doc(snapshot.data()["appointment"].path).get().then(appointmentDoc=>{
        var name = appointmentDoc.data()["appointmenttype"]
        var list = name.split(" ")
        var value = ""
        for (let i = 0; i < list.length; i++) {
          const element = list[i];
          if(element.toLowerCase() != "type"){
            value = value + " " + element
          }
          else{
            break
          }
        }
        appointmentname = value.trim()
        duration = appointmentDoc.data()["duration"].toString() + " Mins"
      })
      await admin.firestore().doc(snapshot.data()["bookedby"].path).get().then(profile=>{
        bookedby.name = profile.data()["name"]
        bookedby.email = profile.data()["email"]
      })
      var starttime = snapshot.data()["starttime"].toDate()
      var endtime = snapshot.data()["endtime"].toDate()
      var formatedStartTime = new Date(starttime.getFullYear(), starttime.getMonth(), starttime.getDate(), starttime.getHours()+5, starttime.getMinutes()+30, 0);
      var formatedEndTime = new Date(endtime.getFullYear(), endtime.getMonth(), endtime.getDate(), endtime.getHours()+5, endtime.getMinutes()+30, 0);
      date = formatedStartTime.toDateString() + " at " + (formatedStartTime.getHours()%12 || 12) + ":" + (formatedStartTime.getMinutes().toString().length == 1 ? ("0"+formatedStartTime.getMinutes().toString()) : formatedStartTime.getMinutes()) + (formatedStartTime.getHours() < 12 ? "AM" : "PM") + " - " + (formatedEndTime.getHours()%12 || 12) + ":" + (formatedEndTime.getMinutes().toString().length == 1 ? ("0"+formatedEndTime.getMinutes().toString()) : formatedEndTime.getMinutes()) + (formatedEndTime.getHours() < 12 ? "AM" : "PM") + " IST"
      var appointmentRoles = []
      for (let i = 0; i < snapshot.data()["appointmentrole"].length; i++) {
        const element = snapshot.data()["appointmentrole"][i];
        appointmentRoles.push(element.path)
      }
      appointmentRoles = Array.from(new Set(appointmentRoles))
      
      for (let i = 0; i < mainRoles.length; i++) {
        const mainelement = mainRoles[i];
        for (let j = 0; j < appointmentRoles.length; j++) {
          const roleelement = appointmentRoles[j];
          if(mainelement == roleelement){
            var mainHost = snapshot.data()["hostRole"][mainelement][0]
            await admin.firestore().collection("EISzoomcontact").doc(mainHost.id).get().then(zoomcontact=>{
              if(zoomcontact.exists){
                zoomurl = zoomcontact.data()["zoomurl"]
                zoomid = zoomcontact.data()["zoomid"]
                zoompassword = zoomcontact.data()["zoompassword"]
              }
              else{
                console.log("NOT EXIST")
              }
            }).catch(err=>{
              console.log(err)
            });
            i = 1000
            j = 1000
          }
        }
      }
      
      for (let i = 0; i < appointmentRoles.length; i++) {
        const aptRole = appointmentRoles[i];
        const roleName = (await admin.firestore().doc(aptRole).get()).data()["role"].toLowerCase()
        for (let j = 0; j < snapshot.data()["hostRole"][aptRole].length; j++) {
          var host = snapshot.data()["hostRole"][aptRole][j];
          await admin.firestore().collection("EISzoomcontact").doc(host.id).get().then(async contact=>{
            if(contact.exists){
              hosts.push({
                name: contact.data()["name"],
                email: contact.data()["email"],
                role: roleName
              })
              if(zoomurl == ""){
                zoomurl = contact.data()["zoomurl"]
                zoomid = contact.data()["zoomid"]
                zoompassword = contact.data()["zoompassword"]
              }
            }
            else{
              await admin.firestore().doc(host.path).get().then(profile=>{
                hosts.push({
                  name: profile.data()["name"],
                  email: profile.data()["email"],
                  role: roleName
                })
              })
            }
          }) 
        }
      }
  
      var dataModel = {
        product_name: "StarLabs - Scheduling",
        appointment: appointmentname,
        date: date,
        duration: duration,
        client: bookedby.name,
        zoomurl: zoomurl,
        zoomid: zoomid,
        zoompassword: zoompassword,
        company_name: "Antano & Harini",
      }
      if(appointmentname.includes("Journey")){
        dataModel["assitancename"] = "Mr.Milan"
        dataModel["assitancenumber"] = "+91 8098273877"
      }
      else if(appointmentname.includes("Critical") || appointmentname.includes("Light")){
        dataModel["assitancename"] = "Ms.Agalya Das"
        dataModel["assitancenumber"] = "+91 9361138763"
      }
      else{
        dataModel["assitancename"] = "Ms.Varnekha"
        dataModel["assitancenumber"] = "+91 8754831381"
      }
      var names = []
      for (let i = 0; i < hosts.length; i++) {
        const hostName = hosts[i].name;
        names.push(hostName)
        if(hosts[i].role.includes("collaborator")){
          dataModel["implementation"] = dataModel["implementation"] == undefined ? ""+hostName : dataModel["implementation"] + ", " + hostName
        }
        else if(hosts[i].role.includes("shadow") && hosts[i].role.includes("implementation")){
          dataModel["implementationshadow"] = dataModel["implementationshadow"] == undefined ? ""+hostName : dataModel["implementationshadow"] + ", " + hostName
        }
        else if(!hosts[i].role.includes("shadow") && hosts[i].role.includes("implementation")){
          dataModel["implementation"] = dataModel["implementation"] == undefined ? ""+hostName : dataModel["implementation"] + ", " + hostName
        }
        else if(hosts[i].role.includes("diagnostic")){
          dataModel["diagnostic"] = dataModel["diagnostic"] == undefined ? ""+hostName : dataModel["diagnostic"] + ", " + hostName
        }
        else if(hosts[i].role.includes("clarity")){
          dataModel["accelerator"] = dataModel["accelerator"] == undefined ? ""+hostName : dataModel["accelerator"] + ", " + hostName
        }
        else if(hosts[i].role.includes("testimonial")){
          dataModel["sales"] = dataModel["sales"] == undefined ? ""+hostName : dataModel["sales"] + ", " + hostName
        }
        else{
          dataModel["host"] = dataModel["host"] == undefined ? ""+hostName : dataModel["host"] + ", " + hostName
        }
      }
      // Calendar Data
      var calendarData =
      "BEGIN:VCALENDAR\n" +
      "CALSCALE:GREGORIAN\n" +
      "METHOD:PUBLISH\n" +
      "PRODID:-//Test Cal//EN\n" +
      "VERSION:2.0\n" +
      "BEGIN:VEVENT\n" +
      "UID:test-1\n" +
      "DTSTART;VALUE=DATE:" + commonService.convertDate(starttime) +
      "\n" +
      "DTEND;VALUE=DATE:" + commonService.convertDate(endtime) +
      "\n" +
      "SUMMARY:" + appointmentname +
      "\n" +
      "SEQUENCE:0\n" +
      "DESCRIPTION:" + "Appointment Scheduled For " + appointmentname +
      "\n" +
      "ORGANIZER;CN="+names.join(', ')+":MAILTO:vignesh.s@soexcellence.com" +
      "\n" +
      "END:VEVENT\n" +
      "END:VCALENDAR";
      await commonService.postmarkClient.sendEmailWithTemplate({
        From: "starlabs@excellenceinstallation.com",
        To: bookedby.email,
        TemplateAlias: "appointment-scheduled",
        TemplateModel: dataModel,
        Attachments: [
          {
          "Name": "appointment.ics",
          "Content": Buffer.from(calendarData).toString('base64'),
          "ContentType": "text/calendar; charset=utf-8; method=REQUEST"
          }
        ],
      }).catch(err=>{
        console.log(err)
      });
      for (let i = 0; i < hosts.length; i++) {
        const element = hosts[i];
        await commonService.postmarkClient.sendEmailWithTemplate({
          From: "starlabs@excellenceinstallation.com",
          To: element.email,
          TemplateAlias: "appointment-scheduled",
          TemplateModel: dataModel,
          Attachments: [
            {
            "Name": "appointment.ics",
            "Content": Buffer.from(calendarData).toString('base64'),
            "ContentType": "text/calendar; charset=utf-8; method=REQUEST"
            }
          ],
        }).catch(err=>{
          console.log(err)
        });
      }
    }
  })
})

*/