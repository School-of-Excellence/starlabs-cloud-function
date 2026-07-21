const admin = require('firebase-admin');
const { getFirestore } = require("firebase-admin/firestore");
//components imports
const commonService = require('./service');
const { alertAtc } = require('./queue-required-stage-aiatc-creation/atc_alerts');
const { buildUpLifeAspirationReport, pickPreviousStage } = require("./queue-required-stage-aiatc-creation/atc_helpers");
const { resolveStageData } = require("./queue-required-stage-aiatc-creation/atc_generation_resolver");
const { recordDropoff } = require("../queue-aiatc-generation-pipeline/se_atc_telemetry");
// v2 functions
const { onDocumentCreated , onDocumentWritten , onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
//
const axios = require("axios"); // Promise based HTTP Client
const https = require('https'); // HTTP Request/Response
const { Buffer } = require('buffer');
const { Readable, PassThrough } = require('stream');
const fs = require('fs');
const path = require('path');
const os = require('os');
//storage
const bucket = admin.storage().bucket()
//ffmpeg
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path
const ffmpeg = require('fluent-ffmpeg')
ffmpeg.setFfmpegPath(ffmpegPath)
//zoom
const { defineSecret } = require('firebase-functions/params');
const zoomAccountId = defineSecret("ZOOM_ACCOUNTID");
const zoomClientId = defineSecret("ZOOM_CLIENTID");
const zoomClientSecret = defineSecret("ZOOM_CLIENTSECRET");
const zoomSDkClientId = defineSecret("ZOOM_SDK_CLIENTID");
const zoomSDKClientSecret = defineSecret("ZOOM_SDK_CLIENTSECRET");
const zoomWebhookSecretToken = defineSecret("ZOOM_WEBHOOK_SECRET_TOKEN")

const crypto = require("crypto");

exports.onQueueStageChange = onDocumentWritten({
    document: "queue_token/{id}",
    secrets: [zoomAccountId, zoomClientId, zoomClientSecret],
  }, async (change) =>{
  var beforeData = change.data.before.exists ? change.data.before.data() : {};
  var afterData = change.data.after.exists ? change.data.after.data() : {};
  const queueTokenId = change.params.id;

  var profileid = afterData["profile_id"];
  var queue = afterData["variationid"] != null ? admin.firestore().collection("queue variation").doc(afterData["variationid"]).path : afterData["queueref"]?.path;

  // Get Profile Data
  let profiledata = null
  await admin.firestore().collection("profile_data").doc(profileid).get().then(async profilesnap => {
    profiledata = profilesnap.data()
  })

  var queueData = {};
  const queueDocSnap = await admin.firestore().doc(afterData["queueref"].path).get();
  if(afterData["queueref"]) {
    await admin.firestore().doc(afterData["queueref"].path).get().then(queueDoc => {
      if (queueDoc.exists) {
        queueData = queueDoc.data();
      }
    });
  }

  // get slot title if variation id exists
  let getSlotTitle = () => null;

  if (afterData['variationid']) {
    const queuePlanningSnap = await admin.firestore()
      .collection('queue planning')
      .where('queueref', '==', afterData['queueref'])
      .where('variationlist', 'array-contains', afterData['variationid'])
      .get();

    const planDoc = queuePlanningSnap.docs[0];

    if (planDoc) {
      const planning = planDoc.data()['planning'] || [];
      
      const slots = planning.flatMap(plan =>
        (plan['segments'] || []).flatMap(segment =>
          (segment['slots'] || []).map(slot => ({
            ...slot,
            segmentid: segment['segmentid']  
          }))
        )
      );

      getSlotTitle = (slotValue, stageName) => {
        const matchedSlot = slots.find(slot =>
          slot['segmentid'] === slotValue['segmentid'] &&
          slot['stagename'] === stageName &&
          slot['startdate']?.seconds === slotValue['startdate']?.seconds &&
          slot['enddate']?.seconds === slotValue['enddate']?.seconds
        );
        return matchedSlot?.['title'];
      };
    }
  }

  try {
      let beforeSelectedSlots = Object.keys(beforeData['selectedstageslot'] || {});
      let afterSelectedSlots = Object.keys(afterData['selectedstageslot'] || {});

      const addedKeys = afterSelectedSlots.filter(key => !beforeSelectedSlots.includes(key));
      const removedKeys = beforeSelectedSlots.filter(key => !afterSelectedSlots.includes(key));

      let countrycode = (![null, undefined].includes(profiledata['countrycode']) ? profiledata['countrycode'] : '+91').replace(/\+/g, "")

      // Process added keys
      for (const key of addedKeys) {
        const addedValue = afterData['selectedstageslot'][key];

        try {
          commonService.sendSlotConfirmationToSlackChannel(addedValue, 'Confirmed', afterData);
        } catch (slackError) {
          console.error(`Slack notification failed for key ${key}:`, slackError.message);
        }

        // Only Scope Enhancement and Evolution Prep Orientation slots send a WATI
        // confirmation — decided by the added slot's stage (key).
        const isPrepStage = key === 'Evolution Prep Orientation';
        const isScopeEnhancement = key === 'Scope Enhancement';
        const isGuidedOrientation = key === 'Guided Pre ATC Orientation' || key === 'Guided Self ATC Orientation';
        const isDiagnostics = key === 'Diagnostics';
        const formattedTitle = getSlotTitle(addedValue, key);

        try {
          await commonService.saveNotificationRecord({
            title: 'Slot Confirmed',
            message: `✅ Your ${key} slot has been confirmed for ${formattedTitle}`,
            subtitle: null,
            date: admin.firestore.FieldValue.serverTimestamp(),
            landingpage: null,
            logged: true,
            profileid: [profileid],
            sticky: false,
            notificationtype: 'queue',
            notificationimage: null,
            metadata: { ...afterData }
          });
          console.log(`Push notification sent for confirmed slot | key: ${key}`);
        } catch (pushError) {
          console.error(`Push notification failed for key ${key}:`, pushError.message);
        }

        if (!isPrepStage && !isScopeEnhancement && !isGuidedOrientation && !isDiagnostics) {
          console.log(`Skipping WATI — key "${key}" is not a confirmable stage`);
          continue;
        }
        try {
          const startDate = addedValue['startdate'];
          const formattedDate = startDate._seconds
            ? new Date(startDate._seconds * 1000).toLocaleString('en-IN', {
              dateStyle: 'medium',
              timeStyle: 'short',
              timeZone: 'Asia/Kolkata'
            }) : startDate.toDate ? startDate.toDate().toLocaleString('en-IN', {   dateStyle: 'medium',   timeStyle: 'short',   timeZone: 'Asia/Kolkata' }) : String(startDate);

          // const phoneNumber = `${countrycode}${profiledata['number']}`;
          const phoneNumber = `${profiledata['number']}`;
          let waticontent = null;

          if(isDiagnostics) {
            waticontent = {
              phonenumber: phoneNumber,
              body: {
                parameters: [
                  { name: 'name', value: profiledata['name'] },
                  { name: 'date_time_slot_title', value: formattedTitle },
                ]
              }
            };
          } else {
            waticontent = {
              phonenumber: phoneNumber,
              body: {
                parameters: [
                  { name: 'name', value: profiledata['name'] },
                  { name: 'date_time_slot', value: formattedTitle },
                ]
              }
            };
          }
          // await commonService.sendToWhatsappViaWati(waticontent);

          const parameterConfig = waticontent['body']['parameters'].map(param => ({
            excelColumn: null,
            fillType: 'static',
            metadataField: null,
            name: param.name,
            staticValue: param.value
          }));
          console.log('Triggered Wati Archive Creation');

          const templateId = isPrepStage ? 'ep_slot_confirmed_msg_after2ndjuly' : isScopeEnhancement ? 'se_slot_confirmed_msg_until2ndjuly' : isGuidedOrientation ? 'guided_slot_confirmed_msg_after2ndjuly': 'diag_slot_confirmed_msg_until2ndjuly';

          var map = {
            numbers: [parseInt(waticontent['phonenumber'])],
            numbermap: { [`${waticontent['phonenumber']}`]: profileid },
            broadcastname: 'Individual',
            paramFillMode: 'static',
            parameterConfig: parameterConfig,
            params: [],
            profileid: [profileid],
            templateid: null,
            watitemplateid: templateId,
            type: 'queue',
            metadata: { ...afterData }
          }

          console.log("Added Slot", map);
          const response = await commonService.createWatiArchiveDocument(map);
          console.log('WATI ARCHIVE RESPONSE', response);

          console.log(`WATI sent for key ${key} | Date: ${formattedTitle} | Phone: ${phoneNumber}`);
        } catch (watiError) {
          console.error(`WATI failed for key ${key}:`, watiError.message);
        }
      }

      // Process removed keys
      for (const key of removedKeys) {
        const removedValue = beforeData['selectedstageslot'][key];
        try {
          commonService.sendSlotConfirmationToSlackChannel(removedValue, 'Reverted', afterData);
        } catch (slackError) {
          console.error(`Slack notification failed for key ${key}:`, slackError.message);
        }

        try {
          const startDate = removedValue['startdate'];
          const formattedDate = startDate._seconds
          ? new Date(startDate._seconds * 1000).toLocaleString('en-IN', {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: 'Asia/Kolkata'
          }) : startDate.toDate ? startDate.toDate().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : String(startDate);

          const formattedTitle = getSlotTitle(removedValue, key);

          // push notification for revert slot
          try {
            await commonService.saveNotificationRecord({
              title: 'Slot Reverted',
              message: `Your ${key} slot has been reverted for ${formattedTitle}`,
              subtitle: null,
              date: admin.firestore.FieldValue.serverTimestamp(),
              landingpage: null,
              logged: true,
              profileid: [profileid],
              sticky: false,
              notificationtype: 'queue',
              notificationimage: null,
              metadata: { ...afterData }
            });
            console.log(`Push notification sent for reverted slot | key: ${key}`);
          } catch (pushError) {
            console.error(`Push notification failed for key ${key}:`, pushError.message);
          }

          const phoneNumber = `${profiledata['number']}`;

          const waticontent = {
            phonenumber: phoneNumber,
            body: {
              parameters: [
                { name: 'name', value: profiledata['name'] },
                { name: 'date_time_slot', value: formattedTitle },
              ]
            }
          };

          // await commonService.sendToWhatsappViaWati(waticontent);

          const parameterConfig = waticontent['body']['parameters'].map(param => ({
            excelColumn: null,
            fillType: 'static',
            metadataField: null,
            name: param.name,
            staticValue: param.value
          }));
          console.log('Triggered Wati Archive Creation');

          map = {
            numbers: [parseInt(waticontent['phonenumber'])],
            numbermap: { [`${waticontent['phonenumber']}`]: profileid },
            broadcastname: 'Individual',
            paramFillMode: 'static',
            parameterConfig: parameterConfig,
            params: [],
            profileid: [profileid],
            templateid: null,
            watitemplateid: 'app_slot_revert_automate_app_to_wati_v1',
            type: 'queue',
            metadata: {...afterData}
          }

          console.log("Reverted Slot", map);
          const response = await commonService.createWatiArchiveDocument(map);
          console.log('WATI ARCHIVE RESPONSE', response);

          console.log(`WATI sent for key ${key} | Date: ${formattedTitle} | Phone: ${phoneNumber}`);

        } catch (watiError) {
          console.error(`WATI failed for key ${key}:`, watiError.message);
        }
        console.log('Removed:', key, removedValue);
      }
    } catch (error) {
    console.log('Error processing slot changes:', error);
  }

  // Update Touch Point - Token Created
  if(!change.data.before.exists && change.data.after.exists){
    try {
      await commonService.updateParticipantTouchPoint({
        label: `Token Created - ${queueData["queuename"]}`,
        notes: "",
        touchpoint: "Queue Token Created",
        touchpointdate: admin.firestore.FieldValue.serverTimestamp(),
        profileid: afterData["profileid"],
        parentreference: change.data.after.ref,
        metadata: {
          queueref: afterData["queueref"],
        }
      })
    } catch (error) {
      console.log("Touch Point Error - Completed", error.toString())
    }
  }

  // Update Participant Metadata
  if(beforeData["stage"] != afterData["stage"] && afterData["stage"] == "completed"){
    try {
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
            triggerdoc: change.data.after.ref.path,
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
        },{merge:true}).catch(async err =>{
          await commonService.throwParticipantMetaDataException({
            profileid: profileid,
            failed: "participant metadata update",
            triggerdoc: change.data.after.ref.path,
            err: err.toString() 
          })
        })
      })
    } catch (error) {
      await commonService.throwParticipantMetaDataException({
        profileid: profileid,
        failed: "queue token",
        triggerdoc: change.data.after.ref.path,
        err: error.toString() 
      })
    }

    // Update Touch Point - Completed
    try {
      await commonService.updateParticipantTouchPoint({
        label: `Completed - ${queueData["queuename"]}`,
        notes: "",
        touchpoint: "Queue Completed",
        touchpointdate: admin.firestore.FieldValue.serverTimestamp(),
        profileid: afterData["profileid"],
        parentreference: change.data.after.ref,
        metadata: {
          queueref: afterData["queueref"],
        }
      })
    } catch (error) {
      console.log("Touch Point Error - Completed", error.toString())
    }
  }


  // Send Push Notification on Stage change
  if(beforeData["currentstage"] != afterData["currentstage"]){
    try {
      var data = {...afterData}
      var message = `You’ve moved to the ${afterData["currentstage"]} stage in the ${afterData["queuename"]}. Please open the app to continue.`
      // "Your Token: " + afterData["tokennumber"] + " for " + afterData["queuename"] + " has been moved to " + afterData["currentstage"] + " stage"
      await admin.firestore().doc(queue).get().then(queue=>{
        data["stages"] = queue.data()["stages"]
      })
      await commonService.saveNotificationRecord({
        title: "Your queue has progressed",
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
    } catch (error) {
      console.log("Error on Sending Push Notification", error.toString())
    }

    // Update Touch Point - Completed
    try {
      await commonService.updateParticipantTouchPoint({
        label: `Moved to '${afterData["currentstage"]}' in ${queueData["queuename"]}`,
        notes: "",
        touchpoint: "Queue Stage Moved",
        touchpointdate: admin.firestore.FieldValue.serverTimestamp(),
        profileid: afterData["profileid"],
        parentreference: change.data.after.ref,
        metadata: {
          queueref: afterData["queueref"],
        }
      })
    } catch (error) {
      console.log("Touch Point Error - Stage Moved", error.toString())
    }

    // creating queue_atc_generation document where atc is created from ai.
    // Triggered for the stage that JUST completed (the previous stage). processStage
    // gates internally on that stage's atcrequiredstages entry having generateatc===true.
    try{
      const previousStage = await resolvePreviousStage({
        queueData,
        tokenData: afterData,
        currentStage: afterData["currentstage"],
      });
      if (!previousStage){console.log("no previous stage resolved")}
      else{
        await processStage({
          queueData,
          queueRef: queueDocSnap.ref,
          tokenData: afterData,
          queueTokenId,
          currentStage: previousStage,
        });
      }
    }catch (error){
      console.log("queue_atc_genration collection creation error",error.toString())
      await alertAtc("critical", `queue_atc_generation creation failed for token ${queueTokenId}: ${error.message}`, {
        stage: "Stage 0", extra: { queueTokenId, currentstage: afterData["currentstage"], stack: error.stack },
      }).catch(() => {});
    }
  }

  // Send Wati Update
  try {
    let firststage = null
    let laststage = null
    let excludequeuestage = [null]
    // Get Queue Data
    let queueGenerationDoc = null
    await admin.firestore().doc(afterData['queueref'].path).get().then(queuesnap => {
      queueGenerationDoc = queuesnap.data()
      firststage = queueGenerationDoc['stages'][0]
      laststage = queueGenerationDoc['stages'][queueGenerationDoc['stages'].length -1]
      excludequeuestage.push(firststage)
      excludequeuestage.push(laststage)
    })

    if(queueGenerationDoc['iscommunicationsdisabled'] != true){
      // Send Welcome Message
      if(!change.data.before.exists && change.data.after.exists){
        console.log("Queue Token Created");
        console.log(afterData['tokenstatus'], afterData['stagestatus'] == 'Approved');
        if(afterData['tokenstatus'] === 'Active' && afterData['stagestatus'] === 'Approved' && firststage === afterData['currentstage']){
          let countrycode = (![null,undefined].includes(profiledata['countrycode']) ? profiledata['countrycode'] : '+91').replace(/\+/g,"")
          
          let waticontent = {
            phonenumber : `${profiledata['number']}`,
            body : {
              parameters: [
                {name: 'name', value: profiledata['name']},
                {name: 'tokenumber', value: afterData['tokennumber']}
              ],
              broadcast_name: queueGenerationDoc['queuewelcometemplate'],
              template_name: queueGenerationDoc['queuewelcometemplate']
            }
          };

          console.log('wati content',waticontent);
          // await commonService.sendToWhatsappViaWati(waticontent)

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
            numbermap: { [`${waticontent['phonenumber']}`]: profileid },
            broadcastname: 'Individual',
            paramFillMode: 'static',
            parameterConfig: parameterConfig,
            params: [],
            profileid: [profileid],
            templateid: null,
            watitemplateid: queueGenerationDoc['queuewelcometemplate'],
            type: 'queue',
            metadata: {...afterData}
          });
          console.log('WATI ARCHIVE RESPONSE', response);

        }
      }
      else if(change.data.before.exists && change.data.after.exists){
        console.log("Token Update");
        if(beforeData['currentstage'] != afterData['currentstage']){          
          // send message to slack channel events (eventSlackTrigger)
          if(!excludequeuestage.includes(afterData['currentstage'])){
            var url
            if(commonService.production){
              url = await commonService.getWebhookUrl("slackEvent") // Production
            }
            else{
              url = await commonService.getWebhookUrl("slackDevTest") // Test
            }
            if(url != undefined){
              var webhook = new commonService.IncomingWebhook(url);
              let message = `${afterData['currentstage']} : ${profiledata['name']}`
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
          let queueGenerationDocData = queueGenerationDoc
          if (afterData['currentstage'] === laststage) {
            console.log("currentstage", afterData['currentstage'] + "wati message sending started");
            //wati
            let countrycode = (![null, undefined].includes(profiledata['countrycode']) ? profiledata['countrycode'] : '+91').replace(/\+/g, "")
            let waticontent = {
              phonenumber: `${profiledata['number']}`,
              body: {
                parameters: [
                  { name: 'productname', value: afterData['productname'] },
                  { name: 'name', value: profiledata['name'] },
                ],
                broadcast_name: 'queuecompletion_v3',
                template_name: 'queuecompletion_v3'
              }
            }
            // await commonService.sendToWhatsappViaWati(waticontent)

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
              numbermap: { [`${waticontent['phonenumber']}`]: profileid },
              broadcastname: 'Individual',
              paramFillMode: 'static',
              parameterConfig: parameterConfig,
              params: [],
              profileid: [profileid],
              templateid: null,
              watitemplateid: 'queuecompletion_v3',
              type: 'queue',
              metadata: {...afterData}
            });
            console.log('WATI ARCHIVE RESPONSE', response);

          }

          // when moved to next stage check stage action type if form or lint based action we have to send notification via email wati and mobile app.
          if(queueGenerationDocData['stageproperty'][afterData['currentstage']]?.['actiontype'] === 'form'){
            console.log("action type form");
            //email
              let clientModel = {
                name:profiledata['name'],
                stage: afterData['currentstage'],
                productname: afterData['productname']
              }
              console.log("sending email");
              // await commonService.postmarkClient.sendEmailWithTemplate({
              //   From: "starlabs@excellenceinstallation.com",
              //   To: profiledata["email"],
              //   TemplateAlias: "queue_stage_formtype",
              //   TemplateModel: clientModel,
              // }).catch(err=>{
              //   console.log(err)
              // });

              await commonService.createEmailArchiveDocument({
                emailData : clientModel,
                datamodel : clientModel,
                attachments : [],
                emailTo : [profiledata["email"]],
                emailMap : {[profiledata["email"]] : profileid},
                fileURL : '',
                from:'starlabs@excellenceinstallation.com',
                notes : '',
                profileId : [profileid],
                postmarkTemplateId: '31423529',
                templateAlias:'queue_stage_formtype',
                type: 'queue',
                metadata: {...afterData}
              });

            // mobileapp
              console.log("sending app notification");
              await commonService.saveNotificationRecord({
                title: "Hello "+profiledata['name'],
                message: `You are ready for the ${afterData['currentstage']} stage. Please open your breakthroughs app and complete the process`,
                subtitle: null,
                date: admin.firestore.FieldValue.serverTimestamp(),
                landingpage: null,
                logged: false,
                profileid: [profiledata['profileid']],
                sticky: false,
                notificationtype: "queue",
                notificationimage: null,
                metadata: {...afterData},
              });
              //wati
              let countrycode = (![null,undefined].includes(profiledata['countrycode']) ? profiledata['countrycode'] : '+91').replace(/\+/g,"")
              let waticontent = {
                phonenumber : `${profiledata['number']}`,
                body : {
                  parameters: [
                    {name: 'name', value: profiledata['name']},
                    {name: 'stage', value: afterData['currentstage']}
                  ],
                  broadcast_name: 'queue_stage_formtype_v3',
                  template_name: 'queue_stage_formtype_v3'
                }
              }
              console.log('wati content',waticontent);
              // await commonService.sendToWhatsappViaWati(waticontent);

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
                numbermap: { [`${waticontent['phonenumber']}`]: profileid },
                broadcastname: 'Individual',
                paramFillMode: 'static',
                parameterConfig: parameterConfig,
                params: [],
                profileid: [profileid],
                templateid: null,
                watitemplateid: 'queue_stage_formtype_v3',
                type: 'queue',
                metadata: {...afterData}
              });
              console.log('WATI ARCHIVE RESPONSE', response);

          }else if(queueGenerationDocData['stageproperty'][afterData['currentstage']]['actiontype'] === 'link'){
            console.log("action type link");
            //email
            let clientModel = {
              name:profiledata['name'],
              stage:afterData['currentstage'],
              url:queueGenerationDocData['stageproperty'][afterData['currentstage']]['actionresource'],
              productname:afterData['productname']
            }
            console.log("sending link email");
            // await commonService.postmarkClient.sendEmailWithTemplate({
            //   From: "starlabs@excellenceinstallation.com",
            //   To: profiledata["email"],
            //   TemplateAlias: "queue_stage_actiontype_link",
            //   TemplateModel: clientModel,
            // }).catch(err=>{
            //   console.log(err)
            // });

            await commonService.createEmailArchiveDocument({
              emailData : clientModel,
              datamodel : clientModel,
              attachments : [],
              emailTo : [profiledata["email"]],
              emailMap : {[profiledata["email"]] : profiledata['profileid']},
              fileURL : '',
              from:'starlabs@excellenceinstallation.com',
              notes : '',
              profileId : [profileid],
              postmarkTemplateId: '31423534',
              templateAlias:'queue_stage_actiontype_link',
              type: 'queue',
              metadata: {...afterData}
            });

            // mobileapp
            console.log("sending app notification");
            await commonService.saveNotificationRecord({
              title: "Hello "+profiledata['name'],
              message: `You are ready for the ${afterData['currentstage']} stage, Our specialist will invite you for the ${afterData['currentstage']}, and you’ll receive the call link via WhatsApp and Email.`,
              subtitle: null,
              date: admin.firestore.FieldValue.serverTimestamp(),
              landingpage: null,
              logged: false,
              profileid: [profiledata['profileid']],
              sticky: false,
              notificationtype: "queue",
              notificationimage: null,
              metadata: {...afterData},
            })
            // await sendNotification({
            //   title: "Hello "+profiledata['name'],
            //   body: `You are ready for the ${afterData['currentstage']} stage, Please check your Whatsapp/ Email.`,
            //   tag: afterData['docid'],
            //   profileid: [profiledata['profileid']],
            //   logtype: null
            // })
            //wati
            let countrycode = (![null,undefined].includes(profiledata['countrycode']) ? profiledata['countrycode'] : '+91').replace(/\+/g,"")
            let waticontent = {
              phonenumber : `${profiledata['number']}`,
              body : {
                parameters: [
                  {name: 'name', value: profiledata['name']},
                  {name: 'stage', value: afterData['currentstage']},
                  {name: 'url', value: queueGenerationDocData['stageproperty'][afterData['currentstage']]['actionresource']}
                ],
                broadcast_name: 'queue_stage_linktype_v4',
                template_name: 'queue_stage_linktype_v4'
              }
            }
            console.log('wati content',waticontent);
            // await commonService.sendToWhatsappViaWati(waticontent);

          
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
              numbermap: { [`${waticontent['phonenumber']}`]: profileid },
              broadcastname: 'Individual',
              paramFillMode: 'static',
              parameterConfig: parameterConfig,
              params: [],
              profileid: [profileid],
              templateid: null,
              watitemplateid: 'queue_stage_linktype_v4',
              type: 'queue',
              metadata: {...afterData}
            });
            console.log('WATI ARCHIVE RESPONSE', response);
            
          } //action type link
        }
      }
    }
  } catch (error) {
    console.log("Error Sending Wati Update", error.toString()) 
  }  
})

// Update Big Invitation to Product (Invitation accepted by specialist)
exports.biginvitationAccepted = onDocumentUpdated("biginvitation/{id}", async (change) => {
  let snapshot = change.data
  var beforedata = snapshot.before.exists ? snapshot.before.data() : {}
  var afterdata = snapshot.after.exists ? snapshot.after.data() : {}
  if(beforedata["status"] != "accepted" && afterdata["status"] == "accepted"){
    await admin.firestore().collection("participantsproduct").where("profileid", "==", afterdata["profileid"]).where("deliverymode", "==", "Big Mode").get().then(async bigproduct=>{
      var bigProductData = bigproduct.docs.map(e => e.data())
      var existingInvitation = bigProductData.filter(e => e["biginvitationref"] != null && e["biginvitationref"] != undefined && e["biginvitationref"].path == snapshot.after.ref.path)
      if(existingInvitation.length == 0){
        var newBigProduct = bigProductData.find(e => e["status"] == null)
        if(newBigProduct != undefined && newBigProduct != null){
          await admin.firestore().collection("participantsproduct").doc(newBigProduct["docid"]).update({
            status: "initiated",
            eventref: afterdata["eventref"],
            biginvitationref: snapshot.after.ref
          })
        }
      }
    })
  }
})

// Generate Zoom Link For Queue Studio
exports.studioZoomLink = onDocumentCreated({
  document : "live assignment/{id}",
  secrets : [zoomAccountId,zoomClientId,zoomClientSecret,zoomSDkClientId,zoomSDKClientSecret],
} , async (snapshot)=>{
    let liveassignment = snapshot.data
    const liveassignmentData = liveassignment.data()
    console.log("liveassignment.id",liveassignment.id);
    
    let participantTokenData = {}
    
    console.log("Fetching... queue token");
    await admin.firestore().collection("queue_token").where("liveassignmentid", "==", liveassignment.id).get().then(token=>{
      token.forEach(doc=>{
        participantTokenData = doc.data()
        console.log(participantTokenData['currentstage']);
      })
    })

    console.log("Fetched queue token", participantTokenData);
    
    let queueData = {}
    if(participantTokenData['currentstage']){
      await admin.firestore().collection("queue generation").doc(participantTokenData['queueref'].id).get().then(snap=>{
        queueData = snap.data()
        console.log(queueData['queuestartdate']);
      })
    }
      console.log("queue data fetched");
      
      //old structure liveassignmentData["zoomlinkrequired"] != false now zoom enabling not for queue now zoom enabling per stage
      const stageKey = participantTokenData['currentstage'];
      console.log("Stage Key", stageKey)
      const enableZoom = queueData['stageproperty'][stageKey]['enablezoom']
      console.log("Enable Zoom", enableZoom)

      if(enableZoom){
        const studioid = liveassignmentData["studioid"]
        var openViduEnabled = false
        // Check Studio Type
        await admin.firestore().collection("queue studio pairing").doc(studioid).get().then(studioDoc =>{
          if(studioDoc.exists){
            openViduEnabled = studioDoc.data()["openvidu"] || false
          }
        })

        // Map profile data
        var mapProfile = {}
        let profileArray = []
        if(liveassignmentData['participantid']) profileArray.push(liveassignmentData['participantid'])
        if(liveassignmentData['participantsactivity'] && Object.keys(liveassignmentData['participantsactivity']).length > 0){ 
          let participantActivityProfileIds = Object.keys(liveassignmentData['participantsactivity'])
          profileArray = [...profileArray,...participantActivityProfileIds]
        }
        if(liveassignmentData['bonusactivity'] && Object.keys(liveassignmentData['bonusactivity']).length > 0){ 
          let participantActivityProfileIds = Object.keys(liveassignmentData['bonusactivity'])
          profileArray = [...profileArray,...participantActivityProfileIds]
        }
        profileArray = Array.from(new Set(profileArray));
        for (let i = 0; i < profileArray.length; i = i+30) {
          const slicedProfileArray =  profileArray.slice(i,i+30)
          await admin.firestore().collection("profile_data").where("profileid","in",slicedProfileArray).get().then(profile=>{
            profile.docs.forEach(p=>{
              mapProfile[p.id] = p.data()
            })
          })
        }
        console.log("profileArray",profileArray.length);
        console.log("mapProfile",Object.keys(mapProfile).length);

        // Setup Participant Link
        var zoomRequestResult = null
        var participantStudioLink
        if(commonService.production){
          participantStudioLink = "https://breakthroughs.app/participantstudio"
        }
        else{
          participantStudioLink = "https://breakthroughs-test.web.app/participantstudio"
        }

        if(openViduEnabled){
          await liveassignment.ref.update({
            zoomdata: {
              host_email: "soe1@soexcellence.com",
              start_url: "Link Broken"
            }
          })
        }
        else {
          // Generate Zoom Link
          let getZoomAccountEmail = await commonService.getUnusedZoomAccount()
          console.log("getZoomAccountEmail",getZoomAccountEmail);
          if(![null,undefined].includes(getZoomAccountEmail)){
            var zoomaccountData = {email : getZoomAccountEmail}
            console.log("zoomaccountData['email']",zoomaccountData['email']);

            // Get Participant Activity
            const keys = Object.keys(liveassignmentData['participantsactivity']);
            let objectKeys = keys;
            let participantactivity = [];
            for (let j = 0; j < objectKeys.length; j++) {
              const element = objectKeys[j];
              participantactivity.push(mapProfile[element]['name'])
            }

            var flatternarray = '';    
            // Get Bons Participant
            if(liveassignmentData['bonusactivityparticipant'] != undefined && liveassignmentData['bonusactivityparticipant'] != null ){
              var names = [];
              for (let i = 0; i < liveassignmentData['bonusactivityparticipant'].length; i++) {
                const element = liveassignmentData['bonusactivityparticipant'][i];
                names.push(mapProfile[element]['name'])
              }
              flatternarray = names.join(", ")
            }

            // Zoom Topic ID
            var time = new Date();
            const finaltime = time.toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true });
            var zoomTopic = `${mapProfile[liveassignmentData['participantid']]['name']} with ${participantactivity.join(", ")}`;
            // Append Bonus Activity Specialist with zoom topic
            if(flatternarray.trim().length != 0){
              zoomTopic = zoomTopic + ` (${flatternarray})`
            }
            // Append Stagename & Time
            zoomTopic = zoomTopic + ` - ${liveassignmentData['stagename']} Studio - ${finaltime}`
            console.log("Zoom Topic", zoomTopic)

            // Server To Server
            var accountid = zoomAccountId.value()
            var clientid = zoomClientId.value()
            var clientsecret = zoomClientSecret.value()
            const tokenResponse = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountid}&client_id=${clientid}&client_secret=${clientsecret}`, {
              method: 'POST'
            });
            const tokenData = await tokenResponse.json();

            try {
              const email = zoomaccountData["email"]; //host email id;
              const zoomresult = await axios.post("https://api.zoom.us/v2/users/" + email + "/meetings", {
                "topic": zoomTopic,
                "type": 1,
                "start_time": new Date(),
                "timezone": "India",
                "host_email": zoomaccountData["email"],
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
              let sdkclientid = zoomSDkClientId.value()
              let sdkclientsecret = zoomSDKClientSecret.value()
              // let signature  = await commonService.generateSignature(sdkclientid, sdkclientsecret, zoomresult.data['id'], 1)
              var hostSignature = await commonService.generateSignature(sdkclientid, sdkclientsecret, zoomresult.data['id'], 1)
              var participantSignature = await commonService.generateSignature(sdkclientid, sdkclientsecret, zoomresult.data['id'], 0)

              // Mark Zoom Email inuse: true,
              await admin.firestore().collection("zoomaccount").where("email", "==", getZoomAccountEmail).get().then(emailaccount=>{
                emailaccount.docs.forEach(doc=>{
                  doc.ref.update({
                    inuse: true,
                    hostid: zoomresult.data["host_id"],
                    useby: snapshot.data.ref.path
                  })
                })
              })
              // Ensure Host Email is updated
              if(zoomresult.data["host_email"] == null || zoomresult.data["host_email"] == undefined){
                zoomresult.data["host_email"] = zoomaccountData["email"]
              }
              console.log("zoom created ", zoomresult.data['join_url']);
              zoomRequestResult = zoomresult.data

              // Update Live Assignment
              await liveassignment.ref.update({
                // signature: hostSignature,
                hostsignature: hostSignature,
                participantsignature: participantSignature,
                zoomdata: zoomresult.data,
                // Keep a history of EVERY Zoom meeting id this call ever had, so the
                // zoomActivitylog webhook can still map events to this live
                // assignment after a regenerate overwrites zoomdata.id. Matching on
                // the mutable zoomdata.id alone drops events during regenerate churn.
                zoomMeetingIds: admin.firestore.FieldValue.arrayUnion(zoomresult.data['id']),
                // When the join token expires — lets the studio show an accurate
                // "link expired → regenerate" state (derived from the same TTL).
                linkExpiresAt: commonService.signatureExpiryDate()
              })
            } catch (zoomError) {
              console.log("Zoom Link Not Generated", zoomError.message);
              console.log("Error 1", JSON.stringify(zoomError.message));
              console.log("Error 2", JSON.stringify(zoomError))
            }

          }
          else{
            await liveassignment.ref.update({
              zoomdata: {
                host_email: "soe1@soexcellence.com",
                start_url: "Link Broken"
              }
            })
          }
        }

        // Send Slack
        let slackMessage = {
          "blocks": [
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Participant Name*: ${mapProfile[liveassignmentData["participantid"]]["name"]}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Specialist Name*: ${liveassignmentData["pairing"].map(e => mapProfile[e]["name"]).join(", ")}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Stage*: ${liveassignmentData["stagename"]}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Participant Studio Link*: ${participantStudioLink}`
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `*Meeting Created In*: ${openViduEnabled ? "OpenVidu" : "Zoom"}`
              }
            },
          ]
        }
        if(openViduEnabled){
          let participantMeetingLink
          if(commonService.production){
            participantMeetingLink = `https://breakthroughs.app/joinroom/${liveassignmentData["docid"]}`
          }
          else{
            participantMeetingLink = `https://breakthroughs-test.web.app/joinroom/${liveassignmentData["docid"]}`
          }
          slackMessage.blocks.push({
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": `*OpenVidu Meeting ID*: ${participantMeetingLink}`
            }
          })
        }
        else{
          if(zoomRequestResult == null){
            zoomRequestResult = {
              start_url: "No Link Generated",
              join_url: "No Link Generated"
            }
          }
          slackMessage.blocks.push({
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": `*Zoom Host URL*: ${zoomRequestResult["start_url"]}`
            }
          })
          slackMessage.blocks.push({
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": `*Zoom Join URL*: ${zoomRequestResult["join_url"]}`
            }
          })
        }
        await slackQueueZoomLink(slackMessage).catch(err =>{
          console.log("Slack Failed")
          console.log(err)
        })

        // Send Email
        var clientModel = {
          company_name: "Antano & Harini",
          product_name: "StarLabs",
          stagename: liveassignmentData["stagename"],
          clientname: mapProfile[liveassignmentData["participantid"]]["name"],
          specialistname: liveassignmentData["pairing"].map(e => mapProfile[e]["name"]).join(", "),
          joinurl: participantStudioLink
        }
        var receiverList = [liveassignmentData["participantid"]]
        for (let i = 0; i < receiverList.length; i++) {
          const receiver = receiverList[i];

          // await commonService.postmarkClient.sendEmailWithTemplate({
          //   From: "starlabs@excellenceinstallation.com",
          //   To: mapProfile[receiver]["email"],
          //   TemplateAlias: "queuestudioinvitation",
          //   TemplateModel: clientModel,
          // }).catch(err=>{
          //   console.log(err)
          // }); 

          await commonService.createEmailArchiveDocument({
            emailData : clientModel,
            datamodel : clientModel,
            attachments : [],
            emailTo : [mapProfile[receiver]["email"]],
            emailMap : {[mapProfile[receiver]["email"]] : receiver},
            fileURL : '',
            from:'starlabs@excellenceinstallation.com',
            notes : '',
            profileId : [receiver],
            postmarkTemplateId: '42760699',
            templateAlias:'queuestudioinvitation',
            type: 'queue',
            metadata: {...participantTokenData}
          });

        }

        // Send Watti
        let countrycode = ![null,undefined].includes(mapProfile[liveassignmentData['participantid']]['countrycode']) ? mapProfile[liveassignmentData['participantid']]['countrycode'] : '+91'
        let waticontent = {
          phonenumber : `${mapProfile[liveassignmentData['participantid']]['number']}`,
          body : {
            parameters: [
              {name: 'name', value: mapProfile[liveassignmentData['participantid']]['name']},
              {name: 'stage', value: liveassignmentData["stagename"]},
              {name: 'url', value: participantStudioLink},
              {name: 'eis', value: liveassignmentData["pairing"].map(e => mapProfile[e]["name"]).join(", ")},
              {name: 'product', value:participantTokenData['productname']},
            ],
            broadcast_name: 'queue_link_generationv2',
            template_name: 'queue_link_generationv2'
          }
        }

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
          numbermap: { [`${waticontent['phonenumber']}`]: liveassignmentData['participantid'] },
          broadcastname: 'Individual',
          paramFillMode: 'static',
          parameterConfig: parameterConfig,
          params: [],
          profileid: [liveassignmentData['participantid']],
          templateid: null,
          watitemplateid: 'queue_link_generationv2',
          type: 'queue',
          metadata: {...participantTokenData}
        });
        console.log('WATI ARCHIVE RESPONSE', response);

        // await commonService.sendToWhatsappViaWati(waticontent).catch(err =>{
        //   console.log("Watti Message Failed")
        //   console.log(err)
        // })
      }
    
    // Activity Log
    let atcModel = null
    if(participantTokenData['productref'] != undefined){
      await admin.firestore().doc(participantTokenData['productref'].path).get().then(productSnap => {
        atcModel = productSnap.data()['atcmodel']
      })
    }
    //get atcModel from queue variation
    if(![null,undefined].includes(participantTokenData['variationid'])){
      await admin.firestore().collection("queue variation").doc(participantTokenData['variationid']).get().then(async variationSnap => {
        if(variationSnap.exists){
          if(![null,undefined].includes(variationSnap.data()['atcmodel'])){
            console.log("Atc model from queue variation",variationSnap.data()['atcmodel']);
            atcModel = variationSnap.data()['atcmodel']
          }
        }
      })
    }
  
    if(liveassignmentData["participantsactivity"] != null && liveassignmentData["participantsactivity"] != undefined){
      var batch = admin.firestore().batch()
      // Compulsory Activity
      var participantsactivity = Object.keys(liveassignmentData["participantsactivity"])
      for (let i = 0; i < participantsactivity.length; i++) {
        const profileid = participantsactivity[i];
        var activity = liveassignmentData["participantsactivity"][profileid]
        var docid = admin.firestore().collection("studio activity log").doc().id
        batch.set(admin.firestore().collection("studio activity log").doc(docid), {
          created: admin.firestore.FieldValue.serverTimestamp(),
          activity: activity,
          activitydate: liveassignmentData["created"] != null && liveassignmentData["created"] != undefined ? liveassignmentData["created"].toDate() : null,
          docid: docid,
          profileid: profileid,
          participantid:liveassignmentData['participantid'],
          queueid: liveassignmentData["queueid"],
          source: "studio",
          sourceref: liveassignment.ref,
          atcmodel: atcModel
        })
      }
      // Bonus Activity
      if(liveassignmentData["bonusactivity"] != null && liveassignmentData["bonusactivity"] != undefined){
        var bonusactivity = Object.keys(liveassignmentData["bonusactivity"])
        for (let i = 0; i < bonusactivity.length; i++) {
          const profileid = bonusactivity[i];
          let activity = liveassignmentData["bonusactivity"][profileid]
          let docid = admin.firestore().collection("studio activity log").doc().id
          batch.set(admin.firestore().collection("studio activity log").doc(docid), {
            created: admin.firestore.FieldValue.serverTimestamp(),
            activity: activity,
            activitydate: liveassignmentData["created"] != null && liveassignmentData["created"] != undefined ? liveassignmentData["created"].toDate() : null,
            docid: docid,
            profileid: profileid,
            participantid:liveassignmentData['participantid'],
            queueid: liveassignmentData["queueid"],
            source: "studio",
            sourceref: liveassignment.ref,
            atcmodel: atcModel
          })
        }
      }
      // Batch update
      if(participantsactivity.length != 0){
        await batch.commit().then(result=>{
          console.log("Log Batch done", result.length)
        }).catch(err =>{
          console.log(err)
        })
      }
    } 
})

async function slackQueueZoomLink(message){
  var url
  if(commonService.production){
    url = await commonService.getWebhookUrl("slackEvent") // Production
  }
  else{
    url = await commonService.getWebhookUrl("slackDevTest") // Test
  }
  var webhook = new commonService.IncomingWebhook(url);
  await webhook.send(message, function(err, header, statusCode, body) {
    if (err) {
      console.log('Error:', err);
    } else {
      console.log('Received', statusCode, 'from Slack');
    }
  });
}

exports.studioZoomLinkDeactivate = onDocumentUpdated("live assignment/{id}", async (snapshot)=>{
    var liveassignment = snapshot.data
    var beforeexists = liveassignment.before.exists
    var afterexits = liveassignment.after.exists
    if(beforeexists && afterexits){
      //
      var liveassignmentData = liveassignment.after.data()
      var beforeStatus = liveassignment.before.data()["status"]
      var afterStatus = liveassignmentData["status"]
      console.log(beforeStatus, afterStatus)
      if(beforeStatus != "completed" && afterStatus == "completed"){

        // Update OpenVidu
        await admin.firestore().collection("openviduroom").doc(liveassignmentData["docid"]).get().then(async openViduDoc =>{
          if(openViduDoc.exists){
            await openViduDoc.ref.update({
              active: false
            }).catch(err =>{
              console.log(liveassignmentData["docid"])
              console.error(err)
            })
          }
        })

        // Update Zoom Email
        var zoomdata = liveassignmentData["zoomdata"]
        if(zoomdata != null && zoomdata != undefined){
          var email = zoomdata["host_email"]
          if(email != null && email != undefined){
            await admin.firestore().collection("zoomaccount").where("email", "==", email.toLowerCase()).get().then(async account=>{
              account.docs.forEach(async doc=>{
                await admin.firestore().doc(doc.ref.path).update({
                  inuse: false,
                  hostid: null,
                  useby: null
                }).catch(err =>{
                  console.log(err)
                  console.log(doc.ref.path)
                })
              })
            })
            await admin.firestore().collectionGroup("logs").where("zoomdata.host_email", "==", email).get().then(async notification=>{
              notification.docs.forEach(async doc=>{
                await admin.firestore().doc(doc.ref.path).update({
                  read: true
                }).catch(err =>{
                  console.log(err)
                  console.log(doc.ref.path)
                })
              })
            }).catch(err =>{
              console.log(err)
            })
            
          }

          //update big opportunitie
          let mapProfileToQueue = {}
          await admin.firestore().collection("live assignment").where("pairing","array-contains-any",liveassignmentData['pairing']).get().then(async liveSnap => {
            await admin.firestore().collection("queue generation").get().then(async queueSnap => {
              let opportunitielength = queueSnap.docs.map(e => e.data()).filter(e => e['delete'] != true).length
              console.log("live assignment",liveSnap.docs.length);
              for (let i = 0; i < liveSnap.docs.length; i++) {
                const element = liveSnap.docs[i].data();
                (element['pairing'] || []).forEach(e => {
                  if(liveassignmentData['pairing'].includes(e)){
                    mapProfileToQueue[e] = mapProfileToQueue[e] || []
                    if(!mapProfileToQueue[e].includes(element['queueid'])){
                      mapProfileToQueue[e].push(element['queueid'])
                    }
                  }
                })
              }
              let batch = admin.firestore().batch()
              let profilelist = Object.keys(mapProfileToQueue)
              let n = 0
              for (let i = 0; i < profilelist.length; i++){
                const profileid = profilelist[i];
                let pmdref = admin.firestore().collection("participant metadata").doc(profileid)
                batch.set(pmdref,{
                  totalstudioopportunitiesused:mapProfileToQueue[profileid].length,
                  studioevents:mapProfileToQueue[profileid]
                },{merge:true})
                n++
                if(n != 0 && n%450 === 0){
                  await batch.commit().then(() => {
                    console.log("batch",n%450);
                    batch = admin.firestore().batch()
                  })
                }
              }
              await batch.commit().then(() => {
                console.log("done");
              })
            })
          })
  
        }
      }
    }
})

exports.studioZoomLinkRegenerate = onRequest({secrets:[zoomAccountId,zoomClientId,zoomClientSecret,zoomSDkClientId,zoomSDKClientSecret],cors: true, },async (req, res)=>{
  console.log(req.query.zoomdata, 'zoomdata');
  var liveassignmentData
  var oldZoomData = JSON.parse(req.query.zoomdata)
  // var oldZoomData = req.query.zoomdata
  var liveassignmentid = req.query.liveassignmentid
  var selectedEmail = null
  // get liveassignment data
  await admin.firestore().collection('live assignment').doc(liveassignmentid).get().then(res => {
    liveassignmentData = res.data()
  })

  // Fetch Queue Token Data
  var participantTokenData = {}
  await admin.firestore().collection("queue_token").where("liveassignmentid", "==", liveassignmentid).get().then(token=>{
    token.forEach(doc=>{
      participantTokenData = doc.data()
    })
  })

  const studioid = liveassignmentData["studioid"]
  var openViduEnabled = false
  // Check Studio Type
  await admin.firestore().collection("queue studio pairing").doc(studioid).get().then(studioDoc =>{
    if(studioDoc.exists){
      openViduEnabled = studioDoc.data()["openvidu"] || false
    }
  })

  // Map profile data
  var mapProfile = {}
  let profileArray = []
  if(liveassignmentData['participantid']) profileArray.push(liveassignmentData['participantid'])
  if(liveassignmentData['participantsactivity'] && Object.keys(liveassignmentData['participantsactivity']).length > 0){ 
    let participantActivityProfileIds = Object.keys(liveassignmentData['participantsactivity'])
    profileArray = [...profileArray,...participantActivityProfileIds]
  }
  if(liveassignmentData['bonusactivity'] && Object.keys(liveassignmentData['bonusactivity']).length > 0){ 
    let participantActivityProfileIds = Object.keys(liveassignmentData['bonusactivity'])
    profileArray = [...profileArray,...participantActivityProfileIds]
  }
  profileArray = Array.from(new Set(profileArray));
  for (let i = 0; i < profileArray.length; i = i+30) {
    const slicedProfileArray =  profileArray.slice(i,i+30)
    await admin.firestore().collection("profile_data").where("profileid","in",slicedProfileArray).get().then(profile=>{
      profile.docs.forEach(p=>{
        mapProfile[p.id] = p.data()
      })
    })
  }
  console.log("profileArray",profileArray.length);
  console.log("mapProfile",Object.keys(mapProfile).length);

  var participantStudioLink
  if(commonService.production){
    participantStudioLink = "https://breakthroughs.app/participantstudio"
  }
  else{
    participantStudioLink = "https://breakthroughs-test.web.app/participantstudio"
  }

  // Validate Zoom Availability
  var hostemail = oldZoomData["host_email"]
  console.log("hostemail",hostemail);
  
  await admin.firestore().collection("zoomaccount").where("email", "==", hostemail).where("inuse", "==", true).get().then(async account=>{
    if(account.size == 0){ // Not used
      selectedEmail = hostemail
    }
    else{ // Being Used
      await admin.firestore().collection("live assignment").where("zoomdata.host_email", "==", hostemail).where("status", "==", "live").get().then(async assignment=>{
        var id = assignment.docs.map(e => e.id)
        if(id.includes(liveassignmentid) && assignment.docs.length == 1){ 
          console.log("used by the studio",id);
          // Used by this Studio
          selectedEmail = hostemail
        }else{ 
          console.log("not used by the studio");
          selectedEmail = await commonService.getUnusedZoomAccount()
          console.log("selectedEmail",selectedEmail);
        }
      })
    }
  })

  // Get Participant Activity
  const keys = Object.keys(liveassignmentData['participantsactivity']);
  let objectKeys = keys;
  let participantactivity = [];
  for (let j = 0; j < objectKeys.length; j++) {
    const element = objectKeys[j];
    participantactivity.push(mapProfile[element]['name'])
  }

  var flatternarray = '';    
  // Get Bons Participant
  if(liveassignmentData['bonusactivityparticipant'] != undefined && liveassignmentData['bonusactivityparticipant'] != null ){
    var names = [];
    for (let i = 0; i < liveassignmentData['bonusactivityparticipant'].length; i++) {
      const element = liveassignmentData['bonusactivityparticipant'][i];
      names.push(mapProfile[element]['name'])
    }
    flatternarray = names.join(", ")
  }

  // Zoom Topic ID
  var time = new Date();
  const finaltime = time.toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true });
  let zoomTopic = `${mapProfile[liveassignmentData['participantid']]['name']} with ${participantactivity.join(", ")}`;
  // Append Bonus Activity Specialist with zoom topic
  if(flatternarray.trim().length != 0){
    zoomTopic = zoomTopic + ` (${flatternarray})`
  }
  // Append Stagename & Time
  zoomTopic = zoomTopic + ` - ${liveassignmentData['stagename']} Studio - ${finaltime}`
  console.log("Zoom Topic", zoomTopic)

  // Server To Server
  var accountid = zoomAccountId.value()
  var clientid = zoomClientId.value()
  var clientsecret = zoomClientSecret.value()
  const tokenResponse = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountid}&client_id=${clientid}&client_secret=${clientsecret}`, {
    method: 'POST'
  });
  const tokenData = await tokenResponse.json();

  // Robust regenerate: END the previous meeting on Zoom FIRST so the host account
  // is freed and the NEW meeting can start. Without this, if the old meeting is
  // still live on the account, Zoom rejects the new one with "you have another
  // meeting in progress" (studio scenarios 1 & 2). Best-effort — a meeting that is
  // already ended / not found just returns an error we swallow.
  const oldMeetingId = oldZoomData && oldZoomData['id'];
  if (oldMeetingId) {
    try {
      await axios.put(`https://api.zoom.us/v2/meetings/${oldMeetingId}/status`,
        { action: 'end' },
        { headers: { 'Authorization': 'Bearer ' + tokenData.access_token, 'content-type': 'application/json' } });
      console.log('[regenerate] ended old meeting', oldMeetingId);
    } catch (e) {
      console.warn('[regenerate] could not end old meeting', oldMeetingId,
        'status=', e && e.response && e.response.status,
        'body=', e && e.response ? JSON.stringify(e.response.data) : (e && e.message));
    }
  }

  if(selectedEmail != null && selectedEmail != undefined)
  try {
    const email = selectedEmail; //host email id;
    const zoomresult = await axios.post("https://api.zoom.us/v2/users/" + email + "/meetings", {
      "topic": zoomTopic,
      "type": 1,
      "start_time": new Date(),
      "timezone": "India",
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
        "waiting_room": false,
        "allow_multiple_devices": true
      }
    }, {
      headers: {
        'Authorization': 'Bearer ' + tokenData.access_token,
        'content-type': 'application/json'
      }
    });
    if(zoomresult.data["host_email"] == null || zoomresult.data["host_email"] == undefined){
      zoomresult.data["host_email"] = selectedEmail
    }
    let sdkclientid = zoomSDkClientId.value()
    let sdkclientsecret = zoomSDKClientSecret.value()
    // let signature  = await commonService.generateSignature(sdkclientid,sdkclientsecret,zoomresult.data['id'],1)
    let hostSignature  = await commonService.generateSignature(sdkclientid, sdkclientsecret, zoomresult.data['id'], 1)
    let participantSignature  = await commonService.generateSignature(sdkclientid, sdkclientsecret, zoomresult.data['id'], 0)

    // Mark Zoom Email inuse: true,
    await admin.firestore().collection("zoomaccount").where("email", "==", selectedEmail).get().then(emailaccount=>{
      emailaccount.docs.forEach(doc=>{
        doc.ref.update({
          hostid: zoomresult.data["host_id"],
          inuse: true,
          useby: admin.firestore().collection("live assignment").doc(liveassignmentid).path
        })
      })
    })

    // Ensure Host Email is updated
    if(zoomresult.data["host_email"] == null || zoomresult.data["host_email"] == undefined){
      zoomresult.data["host_email"] = selectedEmail
    }
    console.log("zoom created ", zoomresult.data['join_url']);

    // Update Live Assignment
    await admin.firestore().collection("live assignment").doc(liveassignmentid).update({
      // signature: hostSignature,
      hostsignature: hostSignature,
      participantsignature: participantSignature,
      zoomdata: zoomresult.data,
      // Append this regenerated meeting id to the history so the webhook can still
      // map its events after zoomdata.id moves on (see studioZoomLink).
      zoomMeetingIds: admin.firestore.FieldValue.arrayUnion(zoomresult.data['id']),
      // Refresh the expiry for the new token (same TTL) so the studio's
      // "expired" state resets after a regenerate.
      linkExpiresAt: commonService.signatureExpiryDate()
    })

    // Send Slack
    let slackMessage = {
      "blocks": [
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*Participant Name*: ${mapProfile[liveassignmentData["participantid"]]["name"]}`
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*Specialist Name*: ${liveassignmentData["pairing"].map(e => mapProfile[e]["name"]).join(", ")}`
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*Stage*: ${liveassignmentData["stagename"]}`
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*Participant Studio Link*: ${participantStudioLink}`
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*Meeting Created In*: ${openViduEnabled ? "OpenVidu" : "Zoom"}`
          }
        },
      ]
    }
    if(openViduEnabled){
      let participantMeetingLink
      if(commonService.production){
        participantMeetingLink = `https://breakthroughs.app/joinroom/${liveassignmentData["docid"]}`
      }
      else{
        participantMeetingLink = `https://breakthroughs-test.web.app/joinroom/${liveassignmentData["docid"]}`
      }
      slackMessage.blocks.push({
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `*OpenVidu Meeting ID*: ${participantMeetingLink}`
        }
      })
    }
    else{
      slackMessage.blocks.push({
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `*Zoom Host URL*: ${zoomresult.data["start_url"]}`
        }
      })
      slackMessage.blocks.push({
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `*Zoom Join URL*: ${zoomresult.data["join_url"]}`
        }
      })
    }
    await slackQueueZoomLink(slackMessage).catch(err =>{
      console.log("Slack Failed")
      console.log(err)
    })

    // Send Email
    var clientModel = {
      company_name: "Antano & Harini",
      product_name: "StarLabs",
      stagename: liveassignmentData["stagename"],
      clientname: mapProfile[liveassignmentData["participantid"]]["name"],
      specialistname: liveassignmentData["pairing"].map(e => mapProfile[e]["name"]).join(", "),
      joinurl: participantStudioLink
    }
    var receiverList = [liveassignmentData["participantid"]]
    for (let i = 0; i < receiverList.length; i++) {
      const receiver = receiverList[i];
      // await commonService.postmarkClient.sendEmailWithTemplate({
      //   From: "starlabs@excellenceinstallation.com",
      //   To: mapProfile[receiver]["email"],
      //   TemplateAlias: "queuestudioinvitation",
      //   TemplateModel: clientModel,
      // }).catch(err=>{
      //   console.log(err)
      // }); 

      await commonService.createEmailArchiveDocument({
        emailData : clientModel,
        datamodel : clientModel,
        attachments : [],
        emailTo : [mapProfile[receiver]["email"]],
        emailMap : {[mapProfile[receiver]["email"]] : receiver},
        fileURL : '',
        from:'starlabs@excellenceinstallation.com',
        notes : '',
        profileId : [receiver],
        postmarkTemplateId: '42760699',
        templateAlias:'queuestudioinvitation',
        type: 'queue',
        metadata: {...participantTokenData}
      });

    }

    // Send Watti
    let countrycode = ![null,undefined].includes(mapProfile[liveassignmentData['participantid']]['countrycode']) ? mapProfile[liveassignmentData['participantid']]['countrycode'] : '+91'
    let waticontent = {
      phonenumber : `${mapProfile[liveassignmentData['participantid']]['number']}`,
      body : {
        parameters: [
          {name: 'name', value: mapProfile[liveassignmentData['participantid']]['name']},
          {name: 'stage', value: liveassignmentData["stagename"]},
          {name: 'url', value: participantStudioLink},
          {name: 'eis', value: liveassignmentData["pairing"].map(e => mapProfile[e]["name"]).join(", ")},
          {name: 'product', value:participantTokenData['productname']},
        ],
        broadcast_name: 'queue_link_generationv2',
        template_name: 'queue_link_generationv2'
      }
    }
    // await commonService.sendToWhatsappViaWati(waticontent).catch(err =>{
    //   console.log("Watti Message Failed")
    //   console.log(err)
    // })

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
      numbermap: { [`${waticontent['phonenumber']}`]: liveassignmentData['participantid'] },
      broadcastname: 'Individual',
      paramFillMode: 'static',
      parameterConfig: parameterConfig,
      params: [],
      profileid: [liveassignmentData['participantid']],
      templateid: null,
      watitemplateid: 'queue_link_generationv2',
      type: 'queue',
      metadata: {...participantTokenData}
    });
    console.log('WATI ARCHIVE RESPONSE', response);
  }
  catch(err){
    console.log(err)
  }
  res.send("success")
})

exports.queueParticipantPositionUpdate = onDocumentCreated("queue stage log/{queueStageLogId}", async (snap) => {
  let snapshot = snap.data
  let docData = snapshot.data()
  let queueref = docData['queueref']
  let queueGenerationDoc = {}
  console.log("queueref", queueref.path);
  await admin.firestore().doc(queueref.path).get().then(queueGenerationDocSnap => {
    queueGenerationDoc = queueGenerationDocSnap.data()
  })
  console.log("queueGenerationDoc", queueGenerationDoc['queuename']);

  var stageProperty = queueGenerationDoc["stageproperty"]
  if (stageProperty[docData["currentstage"]]["compulsoryactivity"].length != 0) {
    let batch = admin.firestore().batch()
    await admin.firestore().collection("queue_token").where('queueref', '==', queueref).where("currentstage", "==", docData["currentstage"]).where('tokenstatus', '==', 'Active').orderBy("logdate", "asc").get().then(async queueTokenSnap => {
      console.log("Current Stage length", docData["currentstage"], queueTokenSnap.docs.length);
      var preassignedMap = {}
      var waitingList = []
      var queuedList = []
      for (let i = 0; i < queueTokenSnap.size; i++) {
        var tokenDoc = queueTokenSnap.docs[i]
        var tokenData = tokenDoc.data()
        var preassigned = (tokenData["preassigned"] != null && tokenData["preassigned"] != undefined) ? tokenData["preassigned"] : {}
        var stagePreassigned = preassigned[docData["currentstage"]] != null && preassigned[docData["currentstage"]] != undefined
          ? preassigned[docData["currentstage"]]
          : []

        if (stagePreassigned.length != 0) {
          batch.update(tokenDoc.ref, { queueposition: null })
          stagePreassigned.forEach(studio => {
            preassignedMap[studio] = preassignedMap[studio] != null ? preassignedMap[studio] : [];
            preassignedMap[studio].push(tokenDoc);
          })
        } else if (tokenData["status"] == "ready") {
          waitingList.push(tokenDoc);
        } else {
          batch.update(tokenDoc.ref, { queueposition: null });
        }
      }

      let waitingPositionCounter = 1;
      waitingList.forEach((waiting) => {
        batch.update(waiting.ref, { queueposition: waitingPositionCounter++ });
      })

      await batch.commit().then(() => {
        console.log("batch updated");
      })
    })
  }

  if (docData["currentstage"] != docData["previousstage"] && stageProperty[docData["previousstage"]]["compulsoryactivity"].length != 0) {
    let batch = admin.firestore().batch()
    await admin.firestore().collection("queue_token").where('queueref', '==', queueref).where("currentstage", "==", docData["previousstage"]).where('tokenstatus', '==', 'Active').orderBy("logdate", "asc").get().then(async queueTokenSnap => {
      console.log("Previous Stage length", docData["previousstage"], queueTokenSnap.docs.length);
      var preassignedMap = {}
      var waitingList = []
      var queuedList = []
      for (let i = 0; i < queueTokenSnap.size; i++) {
        var tokenDoc = queueTokenSnap.docs[i]
        var tokenData = tokenDoc.data()
        var preassigned = (tokenData["preassigned"] != null && tokenData["preassigned"] != undefined) ? tokenData["preassigned"] : {}
        var stagePreassigned = preassigned[docData["previousstage"]] != null && preassigned[docData["previousstage"]] != undefined
          ? preassigned[docData["previousstage"]]
          : [];

        if (stagePreassigned.length != 0) {
          batch.update(tokenDoc.ref, { queueposition: null })
          stagePreassigned.forEach(studio => {
            preassignedMap[studio] = preassignedMap[studio] != null ? preassignedMap[studio] : [];
            preassignedMap[studio].push(tokenDoc);
          })
        } else if (tokenData["status"] == "ready") {
          waitingList.push(tokenDoc);
        } else {
          batch.update(tokenDoc.ref, { queueposition: null });
        }
      }

      let waitingPositionCounter = 1;
      waitingList.forEach((waiting) => {
        batch.update(waiting.ref, { queueposition: waitingPositionCounter++ });
      })

      await batch.commit().then(() => {
        console.log("batch updated");
      })
    })
  }
})

exports.particpantFormSubmit_SlackIntegration = onDocumentCreated({document: "formsByClient/{id}", database: "firestore-forms"} , async (snapshot) => {
  let change = snapshot.data
  let data = change.data()
  
  // Update Touch Point - Form Submitted
  try {
    await commonService.updateParticipantTouchPoint({
      label: `Form Submitted - ${data["formname"]}`,
      notes: "",
      touchpoint: "Form Submitted",
      touchpointdate: data["date"].toDate(),
      profileid: data["profileid"],
      parentreference: snapshot.data.ref,
    })
  } catch (error) {
    console.log("Touch Point Error - Form Submitted", error.toString())
  }


  //concantenating slack message
  // let mapProfile = {}
  let mapProfile = {}
  await admin.firestore().collection("profile_data").where("profileid","==",data['profileid']).get().then(async snap => {
    for (let i = 0; i < snap.docs.length; i++) {
      const element = snap.docs[i].data();
      mapProfile[element['profileid']] = element
    }
  })
  //
  let mapform = {}
  await admin.firestore().collection('delivery forms').get().then(snap => {
    for (let i = 0; i < snap.docs.length; i++) {
      const element = snap.docs[i].data();
      mapform[element['formname']] = element['docid']
    }
  })
  if(mapform[data["formname"]] != data["formid"] && (mapform[data["formname"]] != undefined && mapform[data["formname"]] != null)){
    console.log(mapform[data["formname"]], "/", data["formid"])
    // let ref = admin.firestore().collection('formsByClient').doc(data['docid'])
    console.log("docid",data['docid'],"formid", data['formid'], mapform[data["formname"]]);
    await change.ref.update({
      formid :  mapform[data["formname"]]
    })
  }

  var url = null
  if(commonService.production){
    url = await commonService.getWebhookUrl(data['formid'])
    // mapFormByUrl[data['formid']] || null // Production
  }
  else{
    url = await commonService.getWebhookUrl("slackDevTest") // Test
  }
  //
  console.log("formname",data['formname']);
  let message = {
    "blocks":[
      {
        "type": "header",
        "text": {
          "type": "plain_text",
          "text": `Participant Name : ${mapProfile[data['profileid']]['name']}`
        }
      },
      {
        "type": "section",
        "text": {
          "type": "plain_text",
          "text": `Form : ${data['formname']}`
        }
      },
      {
        "type": "section",
        "text": {
          "type": "plain_text",
          "text": `Submitted Date : ${new Date(data['date'].toDate()).toDateString()}`
        }
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text":` `
        }
      }
    ]
  }
  let index = message['blocks'][0]['type'] === 'header' ? 3 : 0
  for (let i = 0; i < data['formarray'].length; i++) {
    const element = data['formarray'][i];
    let concateMessage = ` `
    ///
      if(!["video","audio","array","label"].includes(element['type'])){
        if(![null,undefined].includes(element['fieldname'])){
          // message['blocks'][index]["text"]["text"] = message['blocks'][index]["text"]["text"] + `*${element['fieldname'].replace(/\n/g," ")}*\n`
          // message['blocks'][index]["text"]["text"] = message['blocks'][index]["text"]["text"] + `    ${(![null,undefined,""].includes(element['value']) ? (element['type'] === 'date' ? new Date(element['value'].toDate()).toDateString() : element['value']): " ")}\n`
          concateMessage = concateMessage + `*${element['fieldname'].replace(/\n/g," ")}*\n`
          concateMessage = concateMessage + `    ${(![null,undefined,""].includes(element['value']) ? (element['type'] === 'date' ? new Date(element['value'].toDate()).toDateString() : element['value']): " ")}\n`
        }
      }else if(element['type'] === "array"){
        if(![null,undefined].includes(element['fieldname'])){
          // message['blocks'][index]["text"]["text"] = message['blocks'][index]["text"]["text"] + `*${element['fieldname'].replace(/\n/g," ")}*\n`
          concateMessage = concateMessage + `*${element['fieldname'].replace(/\n/g," ")}*\n`
          for (let j = 0; j < element['value'].length; j++) {
            const arrayelement = element['value'][j];
            for (const key in arrayelement) {
              // message['blocks'][index]["text"]["text"] = message['blocks'][index]["text"]["text"] + `    ${key.trim().replace(/\t/g,"")} : ${(![null,undefined,""].includes(arrayelement[key]) ? arrayelement[key]: " ")}\n`
              concateMessage = concateMessage + `    ${key.trim().replace(/\t/g,"")} : ${(![null,undefined,""].includes(arrayelement[key]) ? arrayelement[key]: " ")}\n`
            }
          }
        }
      }
    ////
      console.log(JSON.stringify(message).length);
      if((JSON.stringify(message).length + concateMessage.length) > 2900 ){
        if((JSON.stringify(message).length + concateMessage.length) < 3000){
          message['blocks'][index]['text']['text'] = message['blocks'][index]['text']['text'] + concateMessage
          console.log(JSON.stringify(message).length);
          // console.log(message['blocks'][index]['text']['text']);
          if(url != null){
            await formSlackMessageV3(url,message)
          }
          message['blocks'] = [{
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text":` `
            }
          }]
          index = message['blocks'][0]['type'] === 'header' ? 3 : 0
        }else{
          console.log(JSON.stringify(message).length);
          // console.log(message['blocks'][index]['text']['text']);
          if(url != null){
            await formSlackMessageV3(url,message)
          }
          message['blocks'] = [{
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text":` ` + concateMessage
            }
          }]
          index = message['blocks'][0]['type'] === 'header' ? 3 : 0
        }
      }else{
        message['blocks'][index]['text']['text'] = message['blocks'][index]['text']['text'] + concateMessage
      }
    /////
  }
  // console.log("last",message['blocks'][index]['text']['text']);
  if(url != null) await formSlackMessageV3(url,message)
  console.log(JSON.stringify(message).length);

  // Migrate AEL Form
  var aelFormID = ["KqHfM292QPXRLpv9RQNi", "xGhIkwZfSjhUC1sv1tlw"]
  if(aelFormID.includes(data["formid"])){
    var formData = data;
    const formDoc = snapshot.data.ref

    var formField = formData["formarray"].filter(e => e["type"] == "DropDown")
    var category = formField.map(e => e["fieldname"].trim())

    var aelid = admin.firestore().collection("participant AEL").doc().id
    var aeldata = {
      "formid": formDoc.id,
      "docid": aelid,
      "created": formData["date"].toDate(),
      "productref": null,
      "arenaevents": null,
      "atcmodel": "uP!",
      "evolutiontype": "full",
      "category": category,
      "status": "ongoing",
      "valueofextendedyear": "",
      "profileid": formData["profileid"],
      // "tentativestart": new Date(2024, 6, 13),
      // "tentativeend": new Date(2024, 7, 31),
      "crossovermetric": {},
      "reallifesituation": null,
      // "rsvpid": mapRSVP[data["profile_id"]]["docid"]
      "queueid": data["queueref"]?.id ?? null
    }
    var crossoverid = admin.firestore().collection("interim crossover").doc().id;
    var crossoverdata = {
      "docid": crossoverid,
      "aelid": aelid,
      "created": formData["date"].toDate(),
      "metric": {},
      "profileid": formData["profileid"],
    }
    for (let i = 0; i < formField.length; i++) {
      var item = formField[i];
      var splitvalue = item["value"].split("to")
      if(splitvalue.length == 2){
        crossoverdata["metric"][item["fieldname"].trim()] = {
          "startpoint": splitvalue[0].trim(),
          "endpoint": splitvalue[1].trim(),
          "metric": null
        };
        aeldata["crossovermetric"][item["fieldname"].trim()] = {
          "startpoint": splitvalue[0].trim(),
          "endpoint": splitvalue[1].trim(),
          "metric": null
        };
      }
    }
    // console.log(category, aeldata.crossovermetric, formDoc.id)
    var batch = admin.firestore().batch()
    batch.set(admin.firestore().collection("participant AEL").doc(aelid), aeldata)
    batch.set(admin.firestore().collection("interim crossover").doc(crossoverid), crossoverdata)
    await batch.commit().then(async() =>{
      await formDoc.update({
        aelid: aelid
      })
    })
  }
})

async function formSlackMessageV3(url,message){
  var webhook = new commonService.IncomingWebhook(url);
  await webhook.send((message),function(err, header, statusCode, body) {
    if (err) {
      console.log('Error:', err);
    }else{
      console.log('Received', statusCode, 'from Slack');
    }
  }).then(()=> {}).catch(err => {console.log(err);})
}

// Studio Invitation
exports.inviteToStudio = onDocumentCreated("studioinvitation/{docid}",async(snap) =>{
  let snapshot = snap.data;
  console.log(snapshot);
  
  if(snapshot.exists){
    var inviteData = snapshot.data()

    // Fetch Queue Token Data
    var participantTokenData = {}
    await inviteData['tokenref'].get().then(token => {
      if (token.exists) {
        participantTokenData = token.data();
      }
    })
    await commonService.saveNotificationRecord({
      title: `${inviteData["stage"]} invitation received.`,
      message: "Our specialist has invited you for the '" + inviteData["stage"] + "' Call. Please open the app, accept the invitation, and join the call from your laptop.",
      subtitle: null,
      date: admin.firestore.FieldValue.serverTimestamp(),
      landingpage: null,
      logged: false,
      profileid: [inviteData['profileid']],
      sticky: false,
      notificationtype: "studio invitation",
      notificationimage: null,
      metadata: snap.data.data()
    })
    // sendNotification({
    //   title: "Confirm Availability",
    //   body: "You have been invited for the next stage '" + inviteData["stage"] + "'. Please confirm your availability.",
    //   logtype: null,
    //   tag: snapshot.id,
    //   profileid: [inviteData["profileid"]],
    // })
    //whatsapp
    admin.firestore().collection("profile_data").doc(inviteData["profileid"]).get().then( async profilesnap => {
      let profileData = profilesnap.data()
      let countrycode = (![null,undefined].includes(profileData['countrycode']) ? profileData['countrycode'] : '+91').replace(/\+/g,"")
      let waticontent = {
        phonenumber : `${profileData['number']}`,
        body : {
          parameters: [
            {name: 'name', value: profileData['name']},
            {name: 'stage', value: inviteData["stage"]}
          ],
          broadcast_name: "bulkinvitetemplate_v3",
          template_name: "bulkinvitetemplate_v3"
        }
      }
      console.log('wati content',waticontent);
      // await commonService.sendToWhatsappViaWati(waticontent)

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
        numbermap: { [`${waticontent['phonenumber']}`]: profileData['profileid'] },
        broadcastname: 'Individual',
        paramFillMode: 'static',
        parameterConfig: parameterConfig,
        params: [],
        profileid: [profileData['profileid']],
        templateid: null,
        watitemplateid: 'bulkinvitetemplate_v3',
        type: 'queue',
        metadata: snap.data.data()
      });
      console.log('WATI ARCHIVE RESPONSE', response);

    })
  }
})

exports.onQueueTokenCreateUpdateProductMode = onDocumentCreated("queue_token/{docid}", async (snap) => {
  var snapshot = snap.data
  let queuetokendata = snapshot.data()
  let nextmodedate
  if(queuetokendata['tokenstatus'] === 'Active' && queuetokendata['stagestatus'] === 'Approved'){
    console.log("in condition");
    let currentdate = new Date()
    let queuestartdate = null
    let queueenddate = null
    await admin.firestore().doc(queuetokendata['queueref'].path).get().then(async queueGenSnap => {
      queuestartdate = queueGenSnap.data()['queuestartdate'].toDate()
      queueenddate = queueGenSnap.data()['queueenddate'].toDate()
      console.log("got end date");
    })
    if(queuestartdate != null){
      if(queuestartdate >= currentdate){
        let diff = Math.abs(queuestartdate.getTime() - currentdate.getTime())
        let days = Math.ceil(diff/(1000*3600*24))
        console.log("diff in days",days);
        if(days >= 30){
          console.log("more than 30 days",days);
          nextmodedate = new Date(new Date(queuestartdate).setDate(queuestartdate.getDate() - 30))
          await updateParticipantDocument("Early Preparation Mode", snapshot.ref, "Preparation Mode", nextmodedate)
        }else if(days >= 1 && days < 30){
          console.log("less than 30 days",days);
          await updateParticipantDocument("Preparation Mode", snapshot.ref, "Event Mode", queuestartdate)
        }else{
          console.log("on that day",days);
          nextmodedate = new Date(new Date(queueenddate).setDate(queueenddate.getDate() + 1))
          await updateParticipantDocument(null, snapshot.ref, "Integration Mode", nextmodedate)
        }
      }else{
        if(currentdate < queueenddate){
          console.log("queuestartdate",queuestartdate);
          console.log("currentdate",currentdate);
          console.log("queueenddate",queueenddate);
          nextmodedate = new Date(new Date(queueenddate).setDate(queueenddate.getDate() + 1))
          await updateParticipantDocument(null, snapshot.ref, "Integration Mode", nextmodedate)
        }else{
          console.log("currentdate over than enddate");
        }
      }
    }
  }
})
  
async function updateParticipantDocument(mode, ref, nextmode, nextmodedate){
  await admin.firestore().collection("deliverables").where("fileref","array-contains",ref).get().then(async deliverablesnap => {
    if(deliverablesnap.docs.length != 0){
      let participantproductid = deliverablesnap.docs[0].data()['participantproductid']
      await admin.firestore().collection("participantsproduct").doc(participantproductid).get().then(async ppidsnap => {
        let participantProductData = ppidsnap.data()
        if(mode != null){
          await ppidsnap.ref.update({
            mode:mode,
            nextmode: nextmode,
            nextmodedate: nextmodedate
          }).catch(err => {console.log(err);})
          console.log("in participant product",mode,"udpated");
        }else{
          await admin.firestore().doc(participantProductData['productref'].path).get().then(async productsnap => {
            await ppidsnap.ref.update({
              mode:productsnap.data()['mode'],
              nextmode: nextmode,
              nextmodedate: nextmodedate
            }).catch(err => {console.log(err);})
            console.log("in participant product product mode updated");
          })
        }
      })
    }else{
      console.log("no queuetoken ref in deliverable collection");
    }
  })
}

// Calculate Mode when Queue date Change
exports.onQueueDateChange = onDocumentUpdated("queue generation/{docid}", async (snap) => {
  let snapshot = snap.data
  var beforeData = snapshot.before.data()
  var afterData = snapshot.after.data()
  console.log("Queue Start Date", afterData["queuestartdate"].toDate())
  if(beforeData["queuestartdate"].toDate().toDateString() != afterData["queuestartdate"].toDate().toDateString()){
    var newMode = null
    var nextmode = null
    var nextmodedate = null
    var currentDate = new Date()
    await admin.firestore().doc("/Atestdate/date").get().then(data=>{
      if(data.exists){
        var docdata = data.data()
        if(docdata["date"] != null && docdata["date"] != undefined) currentDate = docdata["date"].toDate()
      }
    })
    var queueStartDate = afterData["queuestartdate"].toDate()
    var queueEndDate = afterData["queueenddate"].toDate()
    console.log("Queue End Date", queueEndDate)
    if(queueStartDate >= currentDate){
      let diff = Math.abs(queueStartDate.getTime() - currentDate.getTime())
      let days = Math.ceil(diff/(1000*3600*24))
      console.log("diff in days", days);
      if(days > 30){
        newMode = "Early Preparation Mode"
        nextmode = "Preparation Mode"
        nextmodedate = new Date(currentDate)
        nextmodedate.setDate(queueStartDate.getDate() - 30)
        // new Date(new Date(currentDate).setDate(new Date(queueStartDate).setDate(queueStartDate.getDate() - 30)))
      }
      else if(days >= 1 && days <= 30){
        newMode = "Preparation Mode"
        nextmode = "Event Mode"
        nextmodedate = queueStartDate
      }
      else{
        newMode = "Event Mode"
        nextmode = "Integration Mode"
        nextmodedate = new Date(currentDate)
        nextmodedate.setDate(queueEndDate.getDate() + 1)
        // new Date(new Date(currentDate).setDate(new Date(queueEndDate).setDate(queueEndDate.getDate() + 1)))
      }
    }
    else{
      if(currentDate < queueEndDate){
        newMode = "Event Mode"
        nextmode = "Integration Mode"
        nextmodedate = new Date(currentDate)
        nextmodedate.setDate(queueEndDate.getDate() + 1)
        // new Date(new Date(currentDate).setDate(new Date(queueEndDate).setDate(queueEndDate.getDate() + 1)))
      }
    }
    console.log(newMode, nextmode, nextmodedate)
    if(newMode != null){
      var queueTokenList = (await admin.firestore().collection("queue_token").where("queueref", "==", snapshot.after.ref).where("tokenstatus", "==", "Active").where("stagestatus", "==", "Approved").get()).docs.map(e => e.ref)
      console.log("Total Queue Token", queueTokenList.length)
      var batch = admin.firestore().batch()
      var batchCount = 0
      for (let i = 0; i < queueTokenList.length; i+=10) {
        const sublist = queueTokenList.slice(i, i+10);
        await admin.firestore().collection("deliverables").where("fileref", "array-contains-any", sublist).get().then(async deliverables=>{
          for (let a = 0; a < deliverables.docs.length; a++) {
            const deliverablesDoc = deliverables.docs[a];
            var docData = deliverablesDoc.data()
            if(docData["participantproductid"] != null && docData["status"] != "completed"){
              batch.update(admin.firestore().collection("participantsproduct").doc(docData["participantproductid"]), {
                mode: newMode,
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
          batch = admin.firestore().batch()
        })
      }
      // await calculateBigMode({
      //   eventref: snapshot.after.ref,
      //   newmode: newMode == "Event Mode" ? "Big Mode" : newMode,
      //   nextmode: nextmode == "Event Mode" ? "Big Mode" : nextmode,
      //   nextmodedate: nextmodedate
      // })
    }
  }
})
  
// Calculate Mode when Event date Change
exports.onEventDateChange = onDocumentUpdated("event collection/{docid}", async (snap) => {
  let snapshot = snap.data
  var beforeData = snapshot.before.data()
  var afterData = snapshot.after.data()
  if(beforeData["start_date"].toDate().toDateString() != afterData["start_date"].toDate().toDateString()){
    var newMode = null
    var nextmode = null
    var nextmodedate = null
    var currentDate = new Date()
    await admin.firestore().doc("/Atestdate/date").get().then(data=>{
      if(data.exists){
        var docdata = data.data()
        if(docdata["date"] != null && docdata["date"] != undefined) currentDate = docdata["date"].toDate()
      }
    })
    var eventStartDate = afterData["start_date"].toDate()
    var eventEndDate = afterData["end_date"].toDate()
    if(eventStartDate >= currentDate){
      let diff = Math.abs(eventStartDate.getTime() - currentDate.getTime())
      let days = Math.ceil(diff/(1000*3600*24))
      console.log("diff in days", days);
      if(days > 30){
        newMode = "Early Preparation Mode"
        nextmode = "Preparation Mode"
        nextmodedate = new Date(eventStartDate)
        nextmodedate.setDate(eventStartDate.getDate() - 30)
        // new Date(new Date(eventStartDate).setDate(eventStartDate.getDate() - 30))
      }
      else if(days >= 1 && days <= 30){
        newMode = "Preparation Mode"
        nextmode = "Installation Event Mode"
        nextmodedate = eventStartDate
      }
      else{
        newMode = "Installation Event Mode"
        nextmode = "Integration Mode"
        nextmodedate = new Date(eventEndDate)
        nextmodedate.setDate(eventEndDate.getDate() + 1)
        // new Date(new Date(eventEndDate).setDate(eventEndDate.getDate() + 1))
      }
    }
    else{
      if(currentDate < eventEndDate){
        newMode = "Installation Event Mode"
        nextmode = "Integration Mode"
        nextmodedate = new Date(eventEndDate)
        nextmodedate.setDate(eventEndDate.getDate() + 1)
        // new Date(new Date(eventEndDate).setDate(eventEndDate.getDate() + 1))
      }
    }
    if(newMode != null){
      var mapProductMode = {}
      await admin.firestore().collection("products").orderBy("mode").get().then(async productsnap => {
        for (let i = 0; i < productsnap.docs.length; i++) {
          const element = productsnap.docs[i].data();
          mapProductMode[element['id']] = element['mode']
        }
      })
      await admin.firestore().collection("event participation request").where("eventref", "==", snapshot.after.ref).where("status", "in", ["approved", "attended"]).get().then(requestQuery =>{
        var batch = admin.firestore().batch()
        for (let i = 0; i < requestQuery.docs.length; i++) {
          const requestDoc = requestQuery.docs[i];
          var requestData = requestDoc.data()
          var requestedProductMode = mapProductMode[requestData["productref"].id] || null
          if(requestData["participantproductid"]){
            batch.update(admin.firestore().collection("participantsproduct").doc(requestData["participantproductid"]), {
              mode: newMode == "Installation Event Mode" ? requestedProductMode : newMode,
              nextmode: nextmode == "Installation Event Mode" ? requestedProductMode : nextmode,
              nextmodedate: nextmodedate
            })
          }
          else{
            updateParticipantDocument(
              newMode == "Installation Event Mode" ? requestedProductMode : newMode,
              requestDoc.ref,
              nextmode == "Installation Event Mode" ? requestedProductMode : nextmode,
              nextmodedate
            )
          }
        }
        batch.commit().then(() =>{
          console.log("Event Mode Updated...")
        })
      })
    }
  }
})


// Clear a participant's `participantReadyAt` (lobby "waiting" flag) reliably on
// tab close. The client's own Firestore write during `pagehide` usually never
// reaches the server (it queues in the closing tab's IndexedDB, which the
// specialist's separate browser never syncs), leaving the studio stuck on
// "Participant is waiting". The client sends a `navigator.sendBeacon` here
// instead — beacons are delivered by the browser even after the page is gone.
exports.clearParticipantReady = onRequest({ cors: true }, async (req, res) => {
  const id = (req.query && req.query.liveassignmentid) || (req.body && req.body.liveassignmentid);
  if (!id) { res.status(400).json({ error: 'missing liveassignmentid' }); return; }
  try {
    await admin.firestore().collection('live assignment').doc(String(id)).update({ participantReadyAt: null });
  } catch (e) {
    // Best-effort — the doc may not exist or already be cleared.
    console.warn('clearParticipantReady failed', id, e && e.message);
  }
  res.status(200).json(null);
});

let zoomClipTimings = [];
let zoomClipCount = 0;
exports.zoomActivitylog = onRequest({ memory: '2GiB',
  timeoutSeconds: 540,
  secrets:[zoomWebhookSecretToken,zoomAccountId,zoomClientId,zoomClientSecret,zoomSDkClientId,zoomSDKClientSecret]
}, async (request, response) => {
  var zoomEvent = request.body.event;
  console.log("Zoom Event:", zoomEvent);

  // Webhook request event type is a challenge-response check
  if (zoomEvent === 'endpoint.url_validation') {
    const hashForValidate = crypto.createHmac('sha256', zoomWebhookSecretToken.value()).update(request.body.payload.plainToken).digest('hex');
    response.status(200).json({
      "plainToken": request.body.payload.plainToken,
      "encryptedToken": hashForValidate
    });
    return;
  }

  console.log("meeting id",request.body.payload.object.id);

  try {
    await admin.firestore().collection("zoom activitylog").add({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      payload: request.body.payload,
    });
    if (zoomEvent === 'meeting.created' || zoomEvent === 'meeting.ended') {
      const inUse = zoomEvent === 'meeting.created';
      const account = await admin.firestore().collection("zoomaccount").where("hostid", "==", request.body.payload.object.host_id).get();
      const batch = admin.firestore().batch();
      account.forEach(doc => {
        var value = { inuse: inUse }
        if(!inUse){
          value["hostid"] = null
          value["useby"] = null
        }
        batch.update(doc.ref, value);
      });
      await batch.commit();
      //
      if(zoomEvent === 'meeting.ended'){
        console.log("big assignment trigger after meeting ended");
        console.log(request.body.payload.object.host_id);
        await admin.firestore().collection("big assignment").where("hostid","==",request.body.payload.object.host_id).get().then(async (bigAssignmentSnap) => {
          if(bigAssignmentSnap.docs.length != 0){
            const accountid = zoomAccountId.value();
            const clientid = zoomClientId.value();
            const clientsecret = zoomClientSecret.value();
            const tokenResponse = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountid}&client_id=${clientid}&client_secret=${clientsecret}`, {
              method: 'POST'
            });
            const tokenData = await tokenResponse.json();
            const meetingId = request.body.payload.object.id;
            const url = `https://api.zoom.us/v2/report/meetings/${meetingId}/participants`;
            const headers = { Authorization: `Bearer ${tokenData.access_token}` };
            const response = await axios.get(url, { headers });
            console.log("big assignment res",response.data.participants.length);
            if(response.data.participants && response.data.participants.length != 0){
              console.log("marking attendance for the participants");
              let batch = admin.firestore().batch()
              for (let i = 0; i < response.data.participants.length; i++) {
                const element = response.data.participants[i];
                // let getProfileId = element['user_email'].split("_")[0]
                let participantAssignmentId = element['customer_key']
                if(![null,undefined,""].includes(participantAssignmentId)){
                  let ref = admin.firestore().collection("big participants assignments").doc(participantAssignmentId)
                  batch.update(ref,{status:'completed'})
                  if(i != 0 && i%450 === 0){
                    await batch.commit().then(() => {
                      batch = admin.firestore().batch()
                      console.log("batch size",i/450);
                    })
                  }
                }else{
                  console.log("participantAssignmentId",participantAssignmentId);
                }
              }
              await batch.commit().then(() => {
                console.log("big participant attendance marking completed");
              })
            }
          }
        })

        // Presence log: stamp meeting end + duration onto `live assignment log`.
        try {
          const endObj = request.body.payload.object || {};
          const la = await getLiveAssignmentByMeeting(endObj.id);
          if (la) {
            const patch = {
              meetingEndedAt: admin.firestore.FieldValue.serverTimestamp(),
              // Which meeting ended — so the studio can ignore an OLD meeting's end
              // event after a regenerate (endedMeetingId != current zoomdata.id).
              endedMeetingId: endObj.id != null ? Number(endObj.id) : null,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            };
            if (endObj.start_time && endObj.end_time) {
              patch.meetingStartTimeZoom = endObj.start_time;
              patch.meetingEndTimeZoom = endObj.end_time;
              patch.durationSeconds = Math.max(0, Math.round((new Date(endObj.end_time).getTime() - new Date(endObj.start_time).getTime()) / 1000));
            }
            await admin.firestore().collection('live assignment log').doc(la.id).set(patch, { merge: true });
          }
        } catch (e) { console.warn('live assignment log (meeting.ended) failed', e); }
      }
      //
      response.status(200).json(null);
      return;
    }

    // Meeting started → stamp start time onto `live assignment log`.
    if (zoomEvent === 'meeting.started') {
      try {
        const obj = request.body.payload.object || {};
        const la = await getLiveAssignmentByMeeting(obj.id);
        if (la) {
          await admin.firestore().collection('live assignment log').doc(la.id).set({
            liveassignmentid: la.id,
            meetingId: obj.id,
            meetingStartedAt: admin.firestore.FieldValue.serverTimestamp(),
            meetingStartTimeZoom: obj.start_time || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      } catch (e) { console.warn('live assignment log (meeting.started) failed', e); }
      response.status(200).json(null);
      return;
    }

    // Participant/host joined or left → derive presence into `live assignment log`.
    // Identity is keyed by `customer_key` (= our profile id), which the client sets
    // at join (participant today; specialists once the screen change lands).
    if (zoomEvent === 'meeting.participant_joined' || zoomEvent === 'meeting.participant_left') {
      const obj = request.body.payload.object || {};
      const meetingId = obj.id;
      const p = obj.participant || {};
      const la = await getLiveAssignmentByMeeting(meetingId);
      if (!la) { response.status(200).json(null); return; }

      const joined = zoomEvent === 'meeting.participant_joined';
      const now = admin.firestore.FieldValue.serverTimestamp();
      const zoomTime = (joined ? p.join_time : p.leave_time) || null;
      const { role, profileId } = classifyZoomAttendee(p.customer_key, la.data);

      const patch = {
        liveassignmentid: la.id,
        meetingId: meetingId,
        updatedAt: now,
      };

      if (role === 'participant') {
        if (joined) {
          patch.participantInCallAt = now;
          patch.participantInCallAtZoom = zoomTime;
          patch.participantLeftAt = null;
        } else {
          patch.participantLeftAt = now;
          patch.participantLeftAtZoom = zoomTime;
        }
      } else {
        // specialist (or not-yet-identifiable host) → map keyed by profile id, with
        // a Zoom-uid fallback so nothing is lost until customerKey is set for hosts.
        const key = profileId || ('uid_' + (p.user_id || p.participant_uuid || p.id || 'unknown'));
        const spec = { name: p.user_name || null, role: role };
        if (joined) { spec.joinedAt = now; spec.joinedAtZoom = zoomTime; spec.leftAt = null; }
        else { spec.leftAt = now; spec.leftAtZoom = zoomTime; }
        patch.specialists = { [key]: spec };
      }

      await admin.firestore().collection('live assignment log').doc(la.id).set(patch, { merge: true });
      response.status(200).json(null);
      return;
    }

    if (zoomEvent === 'recording.completed') {
      var liveassignmentData;
      const accountid = zoomAccountId.value();
      const clientid = zoomClientId.value();
      const clientsecret = zoomClientSecret.value();
      const tokenResponse = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountid}&client_id=${clientid}&client_secret=${clientsecret}`, {
        method: 'POST'
      });
      const tokenData = await tokenResponse.json();
      const recordingInfo = request.body.payload.object;
      const meetingId = recordingInfo.id;
      console.log("meetingId", meetingId);

      const snapshot = await admin.firestore().collection('live assignment').where('zoomdata.id', '==', meetingId).get();
      if(snapshot.empty){
        console.log("No live assignment data");
        response.status(200).json(null);
        return;
      }

      liveassignmentData = snapshot.docs[0].data();
      console.log("liveassignmentData.cliptimings", liveassignmentData.cliptimings != undefined ? liveassignmentData.cliptimings.length : "undefined");
      
      if ([null, undefined].includes(liveassignmentData) || liveassignmentData.cliptimings === undefined) {
        response.status(200).json(null);
        return;
      } else {
        await fetchCloudRecording(meetingId, tokenData.access_token, liveassignmentData);
        console.log("end");
        response.status(200).json(null);
        return;
      }
    }

    if (zoomEvent === 'recording.transcript_completed') {
      const meetingId = request.body.payload.object.id;
      console.log("transcript completed for meetingId", meetingId);
      await handleRecordingTranscriptCompleted(meetingId);
      response.status(200).json(null);
      return;
    }

    response.status(200).json(null);
  } catch (error) {
    console.error("Error processing zoom event:", error);
    response.status(500).json({ error: 'Internal Server Error' });
  }
});

// ── Presence helpers for `live assignment log` (webhook-derived truth) ────────
// Resolve the live assignment that owns a Zoom meeting id. The webhook sends the
// meeting id as a STRING, but we store it as a NUMBER (zoomdata.id + zoomMeetingIds
// come from the Zoom REST response). So try BOTH forms. Prefer the full meeting-id
// history (survives regenerate churn); fall back to current zoomdata.id.
async function getLiveAssignmentByMeeting(meetingId) {
  try {
    const num = Number(meetingId);
    const candidates = [];
    if (!Number.isNaN(num)) candidates.push(num);          // numeric form (how we store it)
    candidates.push(String(meetingId));                    // string form (belt-and-braces)
    const col = admin.firestore().collection('live assignment');
    for (const v of candidates) {
      let snap = await col.where('zoomMeetingIds', 'array-contains', v).get();
      if (!snap.empty) {
        return { id: snap.docs[0].id, ref: snap.docs[0].ref, data: snap.docs[0].data() };
      }
      snap = await col.where('zoomdata.id', '==', v).get();
      if (!snap.empty) {
        return { id: snap.docs[0].id, ref: snap.docs[0].ref, data: snap.docs[0].data() };
      }
    }
    return null;
  } catch (e) {
    console.error('[presence] getLiveAssignmentByMeeting ERROR', e && e.message, e);
    return null;
  }
}

// Classify a Zoom attendee by `customer_key` (= our profile id):
//   participant → customer_key === the live assignment's participantid
//   specialist  → customer_key ∈ the live assignment's pairing[]
//   unknown     → no/unrecognised customer_key (e.g. a host before the screen
//                 change starts setting customerKey for specialists)
function classifyZoomAttendee(customerKey, la) {
  if (!customerKey) return { role: 'unknown', profileId: null };
  const participantId = (la && (la.participantid || (la.token && la.token.profile_id))) || null;
  if (participantId && customerKey === participantId) {
    return { role: 'participant', profileId: customerKey };
  }
  const pairing = la && Array.isArray(la.pairing) ? la.pairing : [];
  if (pairing.includes(customerKey)) {
    return { role: 'specialist', profileId: customerKey };
  }
  return { role: 'unknown', profileId: customerKey };
}

// Main function to fetch, process, and upload video clips
async function fetchCloudRecording(meetingId, token, liveassignmentData) {
  console.log('Token:', token);
  const url = `https://api.zoom.us/v2/meetings/${meetingId}/recordings`;
  const headers = { Authorization: `Bearer ${token}` };

  try {
    const response = await axios.get(url, { headers });
    console.log('Recording Data Received');

    const recordingData = response.data;
    const recordingFile = recordingData.recording_files[0];
    const fileUrl = `${recordingFile.download_url}?access_token=${token}`;
    console.log('File URL:', fileUrl);

    const recordingBuffer = await downloadRecording(fileUrl);
    console.log("Recording buffer downloaded");

    const clipTimings = liveassignmentData.cliptimings != undefined ? liveassignmentData.cliptimings : [];
    console.log('Clip Timings:', clipTimings.length);

    if (clipTimings.length === 0) {
      console.log('No clip timings found. Ending function.');
      return;
    }

    let i = 0;
    let totallength = clipTimings.length;
    const promises = [];

    for (const clip of clipTimings) {
      const meetingStartTime = new Date(response.data.start_time);
      console.log(meetingStartTime, 'meetingStartTime');
      const captureTimestamp = new Date(clip.timestamp);
      const beforetime = captureTimestamp.getTime() - 5000;
      console.log(beforetime, 'time');
      const durationInMillis = beforetime - meetingStartTime.getTime();

      const durationInSeconds = durationInMillis / 1000;
      console.log('Duration in seconds:', durationInSeconds);

      if (durationInSeconds < 0) {
        console.log('Skipping clip as duration is negative');
        continue;
      }

      promises.push(processVideo(recordingBuffer, durationInSeconds, clip, i, liveassignmentData, totallength));
      i++;
    }

    await Promise.all(promises);
    console.log("All clips processed");

  } catch (error) {
    console.error('Error fetching or processing recording:', error);
  }
}
  
// Function to download the recording
async function downloadRecording(fileUrl) {
  const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return response.data;
}
  
async function processVideo(inputBuffer, starttime, clip, index, liveassignmentData, totallength) {
  console.log("clip", clip, index);
  return new Promise((resolve, reject) => {
    const inputStream = new Readable();
    inputStream.push(inputBuffer);
    inputStream.push(null);
    const outputStream = new PassThrough();
    const outputBuffer = [];
    ffmpeg(inputStream)
      .setStartTime(starttime)
      .setDuration('10')
      .format('webm')
      .on('data', chunk => outputBuffer.push(chunk))
      .on('end', async () => {
        try {
          const finalBuffer = Buffer.concat(outputBuffer);
          console.log('Clip processed', finalBuffer);
          await uploadToFirebase(finalBuffer, clip);
          console.log(totallength, zoomClipCount);
          if (totallength === zoomClipCount) {
            console.log("zoomClipTimings", zoomClipTimings);
            await admin.firestore().collection('live assignment').doc(liveassignmentData.docid).update({
              cliptimings: zoomClipTimings
            });
            console.log('Updated Firestore with new clip timings');
          } else {
            console.log("No update");
          }
          resolve();
        } catch (err) {
          console.error('Error uploading clip:', err);
          reject(err);
        }
      })
      .on('error', err => {
        console.error('FFmpeg Error:', err);
        reject(err);
      })
      .pipe(outputStream, { end: true });
    outputStream.on('data', chunk => outputBuffer.push(chunk));
  });
}
  
async function uploadToFirebase(buffer, clip) {
  const filePath = `zoomvideoclips/${Date.now()}.mp4`;
  const file = bucket.file(filePath);
  await file.save(buffer, {
    contentType: 'video/mp4',
    public: true,
  });
  console.log('Video uploaded successfully:', filePath);
  const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
  console.log('Video public URL:', publicUrl);
  clip.clipurl = publicUrl;
  zoomClipTimings.push(clip);
  zoomClipCount++;
  return publicUrl;
}
// update captured video clipings

exports.bulkReadyInvitation = onDocumentCreated("bulk invitation/{docid}",async(snap)=>{
  var batch = admin.firestore().batch()
  let snapshot = snap.data
  var data = snapshot.data()
  var pendinginvitation = []
  await admin.firestore().collection("studioinvitation").where("queueref", "==", data["queueref"]).where("stage", '==', data['stage']).get().then(snap => {
    pendinginvitation = snap.docs.filter((doc) => doc.data()['expirydate'].toDate() > new Date())
  })
  console.log(pendinginvitation, 'pendinginvitation');
  
  await admin.firestore().collection("queue_token").where("queueref", "==", data["queueref"]).where("currentstage", "==", data["stage"]).orderBy("logdate").get().then(async tokenList=>{    
    var limitedToken = tokenList.docs.filter(e => e.data()["status"] == null || e.data()["status"] == undefined || e.data()["status"] == "queued" || e.data()['status'] == 'invited').map(e => e.data()).slice(0, data["totalinvited"])
    console.log("data['selectedparticipants']",data['selectedparticipants']);
    
    if(data['selectedparticipants'] != null && data['selectedparticipants'].length > 0){
      console.log("in data['selectedparticipants']");
      
      limitedToken = limitedToken.filter(e => data['selectedparticipants'].includes(e['profile_id']))
      console.log("limitedToken",limitedToken.length);
      
    }
    for (let i = 0; i < limitedToken.length; i++) {
      const token = limitedToken[i];
      if (!pendinginvitation.some(invitation => invitation.profileid === token['profileid'])) {
        console.log('working....');
        
        let docid = admin.firestore().collection("studioinvitation").doc().id
        if(token['status'] != 'invited'){
          batch.update(admin.firestore().collection("queue_token").doc(token["docid"]), {
            status: "invited"
          })
        }
        batch.set(admin.firestore().collection("studioinvitation").doc(docid), {
          clientresponse: null,
          createddate: admin.firestore.FieldValue.serverTimestamp(),
          docid: docid,
          expirydate: new Date(new Date().getTime() + data['duration']*60000),
          participantname: token["profile_name"],
          profileid: token["profile_id"],
          stage: data["stage"],
          type: "queued",
          bulkref: snapshot.ref,
          tokenref: admin.firestore().collection("queue_token").doc(token["docid"]),
          queueref: token['queueref'],
        })
      }
    }
    if(limitedToken.length != 0){
      await batch.commit()
    }
  })
})

exports.invitationAccepted = onDocumentUpdated("studioinvitation/{docid}",async(snap)=>{
  let snapshot = snap.data
  var beforedata = snapshot.before.data()
  var afterdata = snapshot.after.data()
  if(beforedata["clientresponse"] == null && afterdata["clientresponse"] == "approved" && afterdata["type"] == "queued"){
    await admin.firestore().doc(afterdata["tokenref"].path).update({
      status: "ready",
    })
    await admin.firestore().doc(afterdata["bulkref"].path).get().then(async bulkinvitation=>{
      var data = bulkinvitation.data()
      data["totalaccepted"] = (data["totalaccepted"] == null || data["totalaccepted"] == undefined ? 0 : data["totalaccepted"]) + 1
      await bulkinvitation.ref.update({
        totalaccepted: data["totalaccepted"]
      })
    })
  }
})

exports.queueavtest = onDocumentCreated("queue avtest/{docid}", async(snap)=>{
  let snapshot = snap.data
  var data = snapshot.data()
  var profileData = (await admin.firestore().collection("profile_data").doc(data["profileid"]).get()).data()
  var email = profileData["email"]
  var zoomlink = data["zoomlink"]
  var profileUID = profileData["user_ref"] != null && profileData["user_ref"] != undefined ? profileData["user_ref"].id : null

  // Fetch Queue Token Data
  var participantTokenData = {}
  await data['tokenref'].get().then(token => {
    token.forEach(doc => {
      participantTokenData = doc.data()
    })
  })

  //whatsapp
  let countrycode = (![null,undefined].includes(profileData['countrycode']) ? profileData['countrycode'] : '+91').replace(/\+/g,"")
  
  let waticontent = {
    phonenumber : `${profileData['number']}`,
    body : {
      parameters: [
        {name: 'name', value: profileData['name']},
        {name: 'link', value: zoomlink},
      ],
      broadcast_name: "audio_video_zoom_v3",
      template_name: "audio_video_zoom_v3"
    }
  }

  console.log('wati content',waticontent);

  // await commonService.sendToWhatsappViaWati(waticontent)

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
    numbermap: { [`${waticontent['phonenumber']}`]: profileData['profileid'] },
    broadcastname: 'Individual',
    paramFillMode: 'static',
    parameterConfig: parameterConfig,
    params: [],
    profileid: [profileData['profileid']],
    templateid: null,
    watitemplateid: 'audio_video_zoom_v3',
    type: 'queue',
    metadata: {...participantTokenData}
  });
  console.log('WATI ARCHIVE RESPONSE', response);

  // Email
  var messageModel = {
    queuename: data["queuename"],
    message: `Hi ${profileData['name']}, Join the below Zoom call for a bierf audio-video test to ensure you all set before your session with our specialist — Join from your laptop.`,
    product_name: "Breakthroughs",
    zoomlink: zoomlink,
    company_name: "Antano & Harini",
  }

  // await commonService.postmarkClient.sendEmailWithTemplate({
  //   From: "starlabs@excellenceinstallation.com",
  //   To: email,
  //   TemplateAlias: "queueavtest",
  //   TemplateModel: messageModel,
  // }).catch(err=>{
  //   console.log(err)
  // }); 

  await commonService.createEmailArchiveDocument({
    emailData: messageModel,
    datamodel: messageModel,
    attachments: [],
    emailTo: [email],
    emailMap: { [email]: data["profileid"] },
    fileURL: '',
    from: 'starlabs@excellenceinstallation.com',
    notes: '',
    profileId: [data["profileid"]],
    postmarkTemplateId: '33910948',
    templateAlias: 'queueavtest',
    type: 'queue',
    metadata: {...participantTokenData}
  });

  // App notification
  if(profileUID != null){
    var message = `Hi ${profileData['name']}, You’re invited for a brief audio-video test on Zoom to ensure everything is set before your session. The Zoom link has been sent to your email. Please join from your laptop.`
    await commonService.saveNotificationRecord({
      title: "Audio-Video Test Invitation",
      message: message,
      subtitle: null,
      date: admin.firestore.FieldValue.serverTimestamp(),
      landingpage: null,
      logged: true,
      profileid: [profileData['profileid']],
      sticky: false,
      notificationtype: "queue",
      notificationimage: null,
      metadata: {...participantTokenData}
    })
    
    // await admin.firestore().collection("notifications").doc(profileUID).set({
    //   "name" : profileData["name"],
    //   "read" : false,
    // }, {merge : true})
    // var message = `Hi ${profileData['name']}, you're invited to a bierf audio-video test in Zoom call to ensure you all set before your session with our specialist. The Zoom link has been sent to your email — Join from your laptop.`
    // await admin.firestore().collection("notifications").doc(profileUID).collection("logs").add({
    //   "type": null,
    //   "message": message,
    //   "date": new Date(),
    //   "read": false,
    // }).then(async()=>{
    //   await sendNotification({
    //     title: "Zoom Link For " + data["queuename"],
    //     body: message,
    //     tag: data["docid"],
    //     profileid: [profileData["profileid"]],
    //     logtype: null,
    //   }).catch(err =>{
    //     console.log(err)
    //   })
    // })
  }
})

// without constraints
// exports.createqueueActivityLog = onDocumentCreated("queue stage log/{docid}",async (change) => {
//   const newDoc = change.data();
//   let atcModel = null;
//   try {
//     // Get product reference
//     const productSnap = await admin.firestore().doc(newDoc['productref'].path).get();
//     atcModel = productSnap.data()['atcmodel'];
//     console.log("atcModel",atcModel);
    
//     // Get queue generation document
//     const queueGenerationSnap = await admin.firestore().doc(newDoc['queueref'].path).get();
//     const queueGenerationDoc = queueGenerationSnap.data();
//     console.log("queueGenerationDoc",queueGenerationDoc['queuename']);
    
//     let mapMarkAsCompleted = {};

//     // Process stage properties
//     for (const stagePropertyKey in queueGenerationDoc['stageproperty']) {
//       const filteredNextStage = queueGenerationDoc['stageproperty'][stagePropertyKey]['nextstage'] ? queueGenerationDoc['stageproperty'][stagePropertyKey]['nextstage'].filter(e => e['markascompleted'] === true) : []
//       for (const stage of filteredNextStage) {
//         mapMarkAsCompleted[stagePropertyKey] = mapMarkAsCompleted[stagePropertyKey] || [];
//         mapMarkAsCompleted[stagePropertyKey].push(stage['stage']);
//       }
//     }

//     // Get ATC model from queue variation if applicable
//     if (newDoc['variationid']) {
//       console.log('variationid',newDoc['variationid']);
//       const variationSnap = await admin.firestore().collection("queue variation").doc(newDoc['variationid']).get();
//       if (variationSnap.exists) {
//         const variationData = variationSnap.data();
//         if (variationData['atcmodel']) {
//           atcModel = variationData['atcmodel'];
//           console.log("updated atc model from vriation",atcModel);
//         }
//       }
//     }

//     // Check if the current stage is marked as completed
//     console.log("newDoc['previousstage']",newDoc['previousstage'],"newDoc['currentstage']",newDoc['currentstage']);
//     if (mapMarkAsCompleted[newDoc['previousstage']] && mapMarkAsCompleted[newDoc['previousstage']].includes(newDoc['currentstage'])) {
//       const queueStagelogSnap = await admin.firestore().collection("queue stage log")
//         .where("currentstage", "==", newDoc['previousstage'])
//         .where("profile_id", "==", newDoc['profile_id'])
//         .where("queueref", "==", newDoc['queueref'])
//         .where("logdate", "<", newDoc['logdate'].toDate())
//         .orderBy("logdate", "desc")
//         .get();

//       if (!queueStagelogSnap.empty) {
//         const previousQueueStageDoc = queueStagelogSnap.docs[0].data();
//         const batch = admin.firestore().batch();

//         if (previousQueueStageDoc['liveassignmentid']) {
//           const liveAssignmentSnap = await admin.firestore().collection("live assignment").doc(previousQueueStageDoc['liveassignmentid']).get();
//           const liveAssignmentDoc = liveAssignmentSnap.data();
//           // && liveAssignmentDoc['status'] === "completed"
//           if (liveAssignmentDoc && ![null,undefined].includes(liveAssignmentDoc['participantsactivity'])) {
//             for (const profileid in liveAssignmentDoc['participantsactivity']) {
//               const docid = admin.firestore().collection("queue activity log").doc().id;
//               const activitydoc = {
//                 activity: liveAssignmentDoc['participantsactivity'][profileid],
//                 activitydate: new Date(),
//                 atcmodel: atcModel,
//                 docid: docid,
//                 profileid: profileid,
//                 queueid: newDoc['queueref'].id,
//                 participantid: newDoc['profile_id'],
//                 source: "queue stage log",
//                 sourceref: queueStagelogSnap.docs[0].ref
//               };
//               batch.set(admin.firestore().collection("queue activity log").doc(docid), activitydoc);
//             }

//             if (liveAssignmentDoc['bonusactivity']) {
//               for (const profileid in liveAssignmentDoc['bonusactivity']) {
//                 const docid = admin.firestore().collection("queue activity log").doc().id;
//                 const activitydoc = {
//                   activity: liveAssignmentDoc['bonusactivity'][profileid],
//                   activitydate: new Date(),
//                   atcmodel: atcModel,
//                   docid: docid,
//                   profileid: profileid,
//                   queueid: newDoc['queueref'].id,
//                   participantid: newDoc['profile_id'],
//                   source: "queue stage log",
//                   sourceref: queueStagelogSnap.docs[0].ref
//                 };
//                 batch.set(admin.firestore().collection("queue activity log").doc(docid), activitydoc);
//               }
//             }
//           }
//         } else {
//           console.log("no live assignment id");
//         }

//         // Commit the batch and return the promise
//         await batch.commit();
//         console.log("activity log created");
//       } else {
//         console.log("No previous queue stage log found");
//       }
//     } else {
//       console.log("log is not marked as completed");
//     }
//   } catch (error) {
//     await admin.firestore().collection("error_logs_queueActivity").add({
//       error:JSON.stringify(error),
//       profileid:newDoc['profile_id'],
//       source:change.ref,
//       timestamp:new Date()
//     })
//   }
// });

exports.CreateQueueActivityLogV2 = onDocumentUpdated("live assignment/{docid}",async (snap) => {
  let change = snap.data
  var beforeData = change.before.data()
  var afterData = change.after.data()

  if (JSON.stringify(beforeData) === JSON.stringify(afterData)) {
    return null;
  }

  if(beforeData['isactivitydone'] != afterData['isactivitydone'] && afterData['isactivitydone'] == true && afterData['status'] == 'completed'){
    let getAtcModel = null
    await admin.firestore().collection("queue stage log").where("liveassignmentid","==",afterData['docid']).where("profile_id","==",afterData['participantid']).get().then( async queueLogSnap => {
      if(queueLogSnap.docs.length > 0){
        let queueLogData = queueLogSnap.docs[0].data()
        console.log(queueLogData['logdocid']);
        if(![null,undefined].includes(queueLogData['variationid'])){
          await admin.firestore().collection("queue variation").doc(queueLogData['variationid']).get().then(variationSnap => {
            if(variationSnap.exists){
              getAtcModel = variationSnap.data()['atcmodel']
            }
          })
        }else{
          await admin.firestore().doc(queueLogData['productref'].path).get().then(productSnap => {
            if(productSnap.exists){
              getAtcModel = productSnap.data()['atcmodel']
            }
          })
        }
      }
    })
    console.log("getAtcModel",getAtcModel);
    if(getAtcModel != null){
      let batch = admin.firestore().batch()
      const liveAssignmentDoc = afterData
      console.log("liveAssignmentDoc");
      if(![null,undefined].includes(liveAssignmentDoc['participantsactivity'])){
        console.log("participantsactivity");
        for (const profileid in liveAssignmentDoc['participantsactivity']){
          let docid = admin.firestore().collection("queue activity log").doc().id
          let activitydoc = {
            activity:liveAssignmentDoc['participantsactivity'][profileid],
            activitydate:new Date(),
            atcmodel:getAtcModel,
            docid:docid,
            profileid: profileid,
            queueid:liveAssignmentDoc['queueid'],
            participantid:liveAssignmentDoc['participantid'],
            source:"live assignment",
            stagename: liveAssignmentDoc['stagename'],
            sourceref: admin.firestore().collection('live assignment').doc(liveAssignmentDoc['docid'])
          }
          batch.set(admin.firestore().collection("queue activity log").doc(docid),activitydoc)
        }
        if(![null,undefined].includes(liveAssignmentDoc['bonusactivity'])){
          console.log("Bonus Activity");
          for (const profileid in liveAssignmentDoc['bonusactivity']) {
            let docid = admin.firestore().collection("queue activity log").doc().id
            let activitydoc = {
              activity:liveAssignmentDoc['bonusactivity'][profileid],
              activitydate:new Date(),
              atcmodel:getAtcModel,
              docid:docid,
              profileid:profileid,
              queueid:liveAssignmentDoc['queueid'],
              participantid:liveAssignmentDoc['participantid'],
              source:"live assignment",
              stagename: liveAssignmentDoc['stagename'],
              sourceref: admin.firestore().collection('live assignment').doc(liveAssignmentDoc['docid'])
            }
            batch.set(admin.firestore().collection("queue activity log").doc(docid),activitydoc)
          }
        }
      }
      batch.commit().then(() => {
        console.log("activity log created");
      })
    }else{
      console.log("couldn't able to get atcmodel");
    }
  }
})

exports.queueParticipantTransfer = onDocumentCreated("queue participant transfer/{docid}",async (event) => {
  const snap = event.data;
  
  if (!snap) {
    console.log("No data associated with the event");
    return;
  }
  
  const docData = snap.data();
  //scenarios
  // 1. New Product intiation
  // 2. Same Product add new deliverable & create token & before complete ongoing queue

  // get product delivery sequence
  let productRef = admin.firestore().collection("products").doc(docData['productto'])
  let sequenceList = []
  await admin.firestore().collection("productToDeliverySequence").where("product","==",productRef).get().then(querysnap => {
    if(querysnap.docs.length != 0){
      if([null,undefined].includes(docData['deliverytype'])){
        sequenceList = querysnap.docs[0].data()["deliveryoptions"][querysnap.docs[0].data()["deliveryoptions"].length - 1]['deliverysequence']
      }else{
        for (let i = 0; i < querysnap.docs.length; i++) {
          const deliveryoption = querysnap.docs[i].data()["deliveryoptions"];
          for (let j = 0; j < deliveryoption.length; j++) {
            const option = deliveryoption[j];
            if(option["deliverytype"] == docData['deliverytype']){
              sequenceList = option['deliverysequence']
              break;
            }
          }
        } 
      }
    }else{
      console.log("productToDeliverSequence has no document");
    }
  })

  //get journey product purchase
  let mapJourneyProduct = {}
  for (let i = 0; i < docData['selectedparticipants'].length; i=i+10){
    const participantList = docData['selectedparticipants'].slice(i,i+10).map(e => e['profile_id']);
    await admin.firestore().collection("journeyproductpurchase").where("profileid","in",participantList).get().then(jppSnap => {
      let jppData = jppSnap.docs.map(e => e.data())
      for (let j = 0; j < participantList.length; j++) {
        mapJourneyProduct[participantList[j]] = jppData.filter(e => e['profileid'] === participantList[j] && e['productref'].some(item => item.path === docData['selectedparticipants'][j]['productref'].path))[0]
      }
    })
  }
  // console.log(mapJourneyProduct);

  //map profile participantsproduct sequence
  let mapProfileToParticipantProductLastSequence = {}
  let mapProfileToParticpantProduct = {}
  for (let i = 0; i < docData['selectedparticipants'].length; i=i+10) {
    const participantList = docData['selectedparticipants'].slice(i,i+10).map(e => e['profile_id']);
    await admin.firestore().collection("participantsproduct").where("profileid","in",participantList).orderBy("sequenceorder","desc").get().then(ppSnap => {
      for (let j = 0; j < ppSnap.docs.length; j++) {
        const ppElement = ppSnap.docs[j].data();
        // console.log(ppElement['sequenceorder']);
        if( mapProfileToParticipantProductLastSequence[ppElement['profileid']] === undefined){
          mapProfileToParticipantProductLastSequence[ppElement['profileid']] = ppElement['sequenceorder']
        }
        mapProfileToParticpantProduct[ppElement['profileid']] =  mapProfileToParticpantProduct[ppElement['profileid']] || {}
        mapProfileToParticpantProduct[ppElement['profileid']][ppElement['docid']] = ppElement
      }
    })
  }

  let mapQueueTokenNotesTagsInfo = {}
  for (let i = 0; i < docData['selectedparticipants'].length; i=i+10) {
    const tokenDocIdList = docData['selectedparticipants'].slice(i,i+10).map(e => e['docid']);
    await admin.firestore().collection("queue_token").where("docid","in",tokenDocIdList).get().then(sourceTokenSnap => {
      for (let j = 0; j < sourceTokenSnap.docs.length; j++) {
        const sourceTokenData = sourceTokenSnap.docs[j].data();
        mapQueueTokenNotesTagsInfo[sourceTokenData['docid']] = {
          notes: sourceTokenData['notes'],
          notesList: sourceTokenData['notesList'],
          tags: sourceTokenData['tags']
        }
      }
    })
  }

  //get participant delivery sequence
  let mapParticipantDeleiverySequence = {}
  for (let i = 0; i < docData['selectedparticipants'].length; i=i+10) {
    const participantList = docData['selectedparticipants'].slice(i,i+10).map(e => e['profile_id']);
    console.log(participantList);
    await admin.firestore().collection("participantdeliverysequence").where("profileid","in",participantList).get().then(pdsSnap => {
      for (let j = 0; j < pdsSnap.docs.length; j++) {
        const pdselement = pdsSnap.docs[j].data();
        mapParticipantDeleiverySequence[pdselement['profileid']] = pdselement['products']
      }
    })
  }
  console.log("mapParticipantDeleiverySequence",Object.keys(mapParticipantDeleiverySequence).length);

  //get transfer queue firststage & queuename
  let queuefirststage = null
  let queuename = null
  let deliverablesRef = null;
  await admin.firestore().collection("queue generation").doc(docData['queueto']).get().then(queueSnap => {
    queuefirststage = queueSnap.data()['stages'][0]
    queuename = queueSnap.data()["queuename"]
  })

  //tranfer participant to selected queue & creating Queue Token
  const queueTokenCounterRef = admin.firestore().collection("queue_token_counter").doc(docData['queueto'])
  const counterSnap = await queueTokenCounterRef.get()
  if(!counterSnap.exists){
    let lastValue = 0
    await admin.firestore().collection("queue_token").orderBy("tokennumber","desc").limit(1).get().then(queueTokenSnap => {
      lastValue = queueTokenSnap.docs.length != 0 ? queueTokenSnap.docs[0].data()["tokennumber"] : 0
    })
    await queueTokenCounterRef.set({
      value: lastValue,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      lastDelivery: null
    },{merge:true})
  }

  // every profile to deliverables && participantdeliverysequence && queuetoken && particpantproductstatus update&& close existing deliverables && add new product to that profile
  let batch = admin.firestore().batch()
  let n = 0
  for (let i = 0; i < docData['selectedparticipants'].length; i++) {
    const tokenelement = docData['selectedparticipants'][i];
    console.log(i);
    console.log("mapParticipantDeleiverySequence length",mapParticipantDeleiverySequence[tokenelement['profile_id']].length);
    let productIndex = mapParticipantDeleiverySequence[tokenelement['profile_id']].findIndex(e => e["participantproductid"] == docData['mapParticipantProduct'][tokenelement['profile_id']])
    if(productIndex != -1){
      var selectedproduct = mapParticipantDeleiverySequence[tokenelement['profile_id']][productIndex]
      if(selectedproduct["delivery"].length == 0 && sequenceList.length != 0){
        // create delivery list & deliverables
        let delivery = []
        for (let a = 0; a < sequenceList.length; a++) {
          const sequenceRef = sequenceList[a]['activity'];
          var label = sequenceList[a]['label'];
          var description = sequenceList[a]['description'];
          var type = ""
          if(sequenceRef.path.includes("appointment")){
            type = "appointment"
          }
          else if(sequenceRef.path.includes("form")){
            type = "form"
          }
          else if(sequenceRef.path.includes("report")){
            type = "report"
          }
          else if(sequenceRef.path.includes("queue")){
            type = "queue"
          }
          else if(sequenceRef.path.includes("event")){
            type = "event"
          }
          else if(sequenceRef.path.includes("fieldwork")){
            type = "fieldwork"
          }
          else{
            type = "unknown"
          }
          //batching deliverable
          var deliveryid = admin.firestore().collection("deliverables").doc().id
          deliverablesRef = admin.firestore().collection("deliverables").doc(deliveryid)
          var deliverableData = {
            deliveryref: sequenceRef,
            fileref: [],
            participantproductid: docData['mapParticipantProduct'][tokenelement['profile_id']],
            profileid: tokenelement['profile_id'],
            status: null,
            type: type,
          }
          batch.set(deliverablesRef,deliverableData,{merge:true})
          n++
          //
          delivery[a] = {
            sequenceref: admin.firestore().collection("deliverables").doc(deliveryid),
            status: null,
            type: type,
            label: label,
            description: description
          }
        }

        var participantProductData = {}
        await admin.firestore().collection("participantsproduct").doc(docData['mapParticipantProduct'][tokenelement['profile_id']]).get().then(productQuery => {
          if (productQuery.exists) {
            participantProductData = productQuery.data()
          }
        })

        if(delivery[0].type === "queue" && deliverablesRef != null){
          //create queue token
          const queuedocid = admin.firestore().collection("queue_token").doc().id
          let currentTokenNo = null
          let attempts = 0
          const maxAttempts = 15
          while(currentTokenNo === null && attempts < maxAttempts){
            attempts++
            try{
              await admin.firestore().runTransaction(async (transaction) => {
                const counterTxnSnap = await transaction.get(queueTokenCounterRef)
                const currentValue = counterTxnSnap.exists ? (counterTxnSnap.data().value || 0) : 0
                const next = currentValue + 1
                transaction.set(queueTokenCounterRef,{
                  value: next,
                  lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                  lastDelivery: deliverablesRef
                },{merge:true})
                currentTokenNo = next
              })
            }catch(error){
              console.log(`Counter attempt ${attempts} failed for profile ${tokenelement['profile_id']}:`,error.message)
              if(attempts >= maxAttempts){
                console.error(`Failed to acquire token number after ${maxAttempts} attempts for profile: ${tokenelement['profile_id']}`)
                break;
              }
              const delay = Math.min(50 * Math.pow(2,attempts) + Math.random() * 200, 5000)
              await new Promise(resolve => setTimeout(resolve,delay))
            }
          }

          let queueData = {
            docid: queuedocid,
            tokennumber: currentTokenNo,
            profile_name: tokenelement['profile_name'],
            profile_id: tokenelement['profile_id'],
            currentstage: queuefirststage,
            quicknotes: null,
            people_involved: null,
            tokenstatus: 'Active',
            productref: productRef,
            productname: docData['productname'],
            createdon: admin.firestore.Timestamp.now(), 
            queueref:  admin.firestore().collection("queue generation").doc(docData['queueto']),
            queuename: queuename,
            stagestatus: 'Approved',
            denynote: null,
            logdate: admin.firestore.Timestamp.now(), 
            variationid: docData['variationid'],
            deliveryRef: deliverablesRef, 
            participantproductid: docData['mapParticipantProduct'][tokenelement['profile_id']],
            transferredfrom: admin.firestore().collection("queue generation").doc(docData['queuefrom']),
            tokentransferredfrom:admin.firestore().collection("queue_token").doc(tokenelement['docid']),
            notes: mapQueueTokenNotesTagsInfo[tokenelement['docid']]?.notes ?? "",
            notesList: mapQueueTokenNotesTagsInfo[tokenelement['docid']]?.notesList ?? [],
            tags: mapQueueTokenNotesTagsInfo[tokenelement['docid']]?.tags ?? [],
          }
          if (participantProductData["requestedslot"]) {
            queueData["selectedstageslot"] = {}
            queueData["selectedstageslot"][participantProductData["requestedslot"]["stagename"]] = participantProductData["requestedslot"]
          }
          batch.set(admin.firestore().collection("queue_token").doc(queuedocid),queueData)
          n++
          //update transferred ref in previousqueue
          let tokenelemnetref = admin.firestore().collection("queue_token").doc(tokenelement['docid'])
          batch.update(tokenelemnetref,{
            transferredto:admin.firestore().collection("queue generation").doc(docData['queueto']),
            tokentransferredto:admin.firestore().collection("queue_token").doc(queuedocid)
          })
          n++
          // updating fileref in deliverables
          batch.set(delivery[0]['sequenceref'],{
            fileref:admin.firestore.FieldValue.arrayUnion(admin.firestore().collection("queue_token").doc(queuedocid)),
            status:"ongoing"
          },{merge:true})
          n++
          //batching participantDeleiverySequence
          delivery[0]['status'] = "ongoing"
          mapParticipantDeleiverySequence[tokenelement['profile_id']][productIndex]["delivery"] = delivery
          let participantDeliverySequenceRef = admin.firestore().collection("participantdeliverysequence").doc(tokenelement['profile_id'])
          batch.update(participantDeliverySequenceRef,{
            products:mapParticipantDeleiverySequence[tokenelement['profile_id']]
          })
          n++

          let eventParticipationId = null;
          let arenaData = {};
          await admin.firestore().collection("arena events").doc(docData["arenaeventid"]).get().then((arenaevent) => {
            if (arenaevent.exists) {
              arenaData = arenaevent.data();
            }
          });

          await admin.firestore().collection("event participation request")
            .where("arenaeventid", "==", docData["arenaeventid"])
            .where("status", "in", ["requested"])
            .get()
            .then(async (request) => {

              const matchedDoc = request.docs.find(doc => doc.data()['profileid'] === tokenelement['profile_id']);

              if (matchedDoc) {
                eventParticipationId = matchedDoc.ref.id;
              } else {
                eventParticipationId = admin.firestore().collection("event participation request").doc().id;
              }

              var map = {
                eventref: arenaData["eventref"],
                productref: arenaData["productref"],
                status: "approved",
                profileid: tokenelement['profile_id'],
                participantproductid: docData['mapParticipantProduct'][tokenelement['profile_id']],
                arenaeventid: docData["arenaeventid"],
                initiatedfrom: 'shifted',
                docid: eventParticipationId
              }

              if(!matchedDoc) {
                map['doccreateddate'] = admin.firestore.Timestamp.now();
              }

              await admin.firestore().collection("event participation request").doc(eventParticipationId).set(map, { merge: true });
            });

          //updating participant product data status ongoing
          batch.update(admin.firestore().collection("participantsproduct").doc(docData['mapParticipantProduct'][tokenelement['profile_id']]),{
            eventref:admin.firestore().collection("queue generation").doc(docData['queueto']),
            status: 'ongoing',
            eventparticipationid: eventParticipationId, // charan
            deliverytype: docData['deliverytype'] ?? null, // charan
            arenaeventid: docData['arenaeventid'] ?? null, // charan
            queuevariationid: docData['variationid'] ?? null, // charan
            statusdate:{
              ongoing: admin.firestore.Timestamp.now()
            }
          })
          n++
          //batch commit
          if(i != 0 && n%400 === 0){
            batch.commit().then(() => {
              batch = admin.firestore().batch()
            })
          }
        }
      }//sequence check
    }//find productindex
  }
  await batch.commit()
  console.log("step one Done");
  //updating previous queue participantproduct for the selected participants
  batch = admin.firestore().batch()
  n = 0
  for (let i = 0; i < docData['selectedparticipants'].length; i=i+10) {
    const tokenRefList = docData['selectedparticipants'].slice(i,i+10).map(e => admin.firestore().collection("queue_token").doc(e['docid']))
    await admin.firestore().collection("deliverables").where("fileref","array-contains-any",tokenRefList).get().then(deliverableSnap => {
      for (let j = 0; j < deliverableSnap.docs.length; j++) {
        const deliverableElementRef = deliverableSnap.docs[j].ref;
        const deliverableElement = deliverableSnap.docs[j].data()
        //change deliverable to completed
        batch.update(deliverableElementRef,{status:"completed"})
        n++
        //update in participantsproduct
        batch.update(admin.firestore().collection("participantsproduct").doc(deliverableElement['participantproductid']),{
          status:"shifted",
          "statusdate.shifted":new Date()
        })
        n++
        //get aelid from transferredfrom participantproduct
        let currentAelId = null
        if(mapProfileToParticpantProduct[deliverableElement['profileid']] != undefined){
          console.log("deliverableElement['participantproductid']",deliverableElement['participantproductid']);
          if(mapProfileToParticpantProduct[deliverableElement['profileid']][deliverableElement['participantproductid']] != undefined){
            console.log("mapProfileToParticpantProduct[deliverableElement['profileid']][deliverableElement['participantproductid']]['aelid']",mapProfileToParticpantProduct[deliverableElement['profileid']][deliverableElement['participantproductid']]['aelid']);
            if(mapProfileToParticpantProduct[deliverableElement['profileid']][deliverableElement['participantproductid']]['aelid'] != undefined){
              currentAelId = mapProfileToParticpantProduct[deliverableElement['profileid']][deliverableElement['participantproductid']]['aelid']
            }
          }
        }
        //update in participant ael in ongoing participantproductid && update participantproductid in participant AEL Collection
        if(currentAelId != undefined && currentAelId != null){
          console.log("current aelid",currentAelId,"shifted participantproductid",docData['mapParticipantProduct'][deliverableElement['profileid']],);
          batch.update(admin.firestore().collection("participant AEL").doc(currentAelId),{
            participantproductid : admin.firestore.FieldValue.arrayUnion(docData['mapParticipantProduct'][deliverableElement['profileid']])
          })
          n++
          //updating aelid to shifted participant product
          batch.update(admin.firestore().collection("participantsproduct").doc(docData['mapParticipantProduct'][deliverableElement['profileid']]),{
            aelid:currentAelId,
          })
          n++
        }
        // update status in participantDeliverySequence
        if(mapParticipantDeleiverySequence[deliverableElement['profileid']] != undefined){
          for (let k = 0; k < mapParticipantDeleiverySequence[deliverableElement['profileid']].length; k++) {
            const pdsElement = mapParticipantDeleiverySequence[deliverableElement['profileid']][k];
            if(pdsElement['participantproductid'] === deliverableElement['participantproductid']){
              mapParticipantDeleiverySequence[deliverableElement['profileid']][k]['status'] = "shifted"
              let participantProductId = admin.firestore().collection("participantsproduct").doc().id
              mapParticipantDeleiverySequence[deliverableElement['profileid']].push({
                delivery:[],
                participantproductid:participantProductId,
                productref:pdsElement['productref'],
                status:null
              })
              mapParticipantDeleiverySequence[deliverableElement['profileid']][k]["delivery"].filter(e => e['sequenceref'].path === deliverableElementRef.path)[0]['status'] = "completed"
              batch.update(admin.firestore().collection("participantdeliverysequence").doc(deliverableElement['profileid']),{
                products:mapParticipantDeleiverySequence[deliverableElement['profileid']]
              })
              n++
              //updating productref in journey product purchase
              let journeyproductpurchaseref = admin.firestore().collection("journeyproductpurchase").doc(mapJourneyProduct[deliverableElement['profileid']]['docid'])
              let productRefArray = mapJourneyProduct[deliverableElement['profileid']]['productref'] || []
              productRefArray.push(pdsElement['productref'])
              batch.update(journeyproductpurchaseref,{
                productref : productRefArray
              })
              n++
              //update participantjourneyproduct 
              let participantjourneyproductref = mapJourneyProduct[deliverableElement['profileid']]['participantjourneyproductref']
              batch.update(participantjourneyproductref,{
                participantproducts:admin.firestore.FieldValue.arrayUnion({
                  participantproductid:participantProductId,
                  productref:pdsElement['productref']
                }),
                productref : productRefArray
              })
              n++
              //update participant product
              batch.set(admin.firestore().collection("participantsproduct").doc(participantProductId),{
                docid:participantProductId,
                productref:pdsElement['productref'],
                profileid:deliverableElement['profileid'],
                status:null,
                sequenceorder:mapProfileToParticipantProductLastSequence[deliverableElement['profileid']],
                journeyref:mapJourneyProduct[deliverableElement['profileid']]['journeyref'] || null,
                packageref:mapProfileToParticpantProduct[deliverableElement['profileid']][deliverableElement['participantproductid']]['packageref'],
                tentativestart:null,
                minimumpayment:null,
                subscriptionstart:null,
                subscriptionend:null,
                unlimited:false
              })
              n++
              break;
            }
          }
        }else{
          console.log("while closing deliverables doc participant delivery sequence profileid empty",deliverableElement['profileid']);
        }
      }
    })
    if(i != 0 && n%400 === 0){
      batch.commit().then(() => {
        batch = admin.firestore().batch()
      })
    }
  }
  await batch.commit()
  console.log("shifting product done");
})

// Previous stage = the one that just completed. Use queue variation stages
// when the token has variationid, else fall back to queue generation stages.
async function resolvePreviousStage({ queueData, tokenData, currentStage }) {
  let stages = queueData["stages"] || [];
  if (tokenData["variationid"]) {
    const variationSnap = await admin.firestore().collection("queue variation")
      .doc(tokenData["variationid"]).get();
    if (variationSnap.exists) {
      stages = variationSnap.data()["stages"] || stages;
    }
  }
  return pickPreviousStage(stages, currentStage);
}

// Map a resolver own-source failure reason to a telemetry drop-off reason key
// (se_atc_telemetry recordDropoff / DASHBOARD-DATA-CONTRACT reason set).
function ownFailureDropoffReason(reason) {
  const r = String(reason || "");
  if (r.startsWith("NO_FORM_SUBMISSION") || r.startsWith("NO_ACTIONRESOURCE")) return "no_form_submission";
  if (r.startsWith("NO_STUDIO_SESSION")) return "no_studio_session";
  if (r.startsWith("NO_LIVEASSIGNMENT")) return "no_liveassignment";
  if (r.startsWith("NO_ZOOM_MEETING") || r.startsWith("LIVEASSIGNMENT_NOT_FOUND")) return "no_zoom_meeting";
  if (r.startsWith("TRANSCRIPT_NOT_YET_CAPTURED")) return "transcript_fetch_failed";
  return "unknown_stage_type";
}

// ---------- Shared stage processor ----------
// Redesigned workflow (see atc_generation_resolver.js + functions/CLAUDE.md):
//   * gate on the stage's atcrequiredstages entry having generateatc===true
//   * resolve own + all pairing sources into a stagedata map (level-by-level
//     across the transferredfrom chain; zoom transcripts read off live assignment)
//   * OWN source unresolvable  → drop-off, NO doc (nothing to generate from)
//   * mandatory pairing missing → create a "dataincomplete" doc (button can retry)
//   * complete                  → create doc with NO status; S1 builds prompt + sets pending
// Every downstream field the pod claim-loop / dashboard / rollup depends on
// (camelCase createdAt/type/queue_token_id/queueref/data/sourceref) is preserved;
// `stagedata` is added.
async function processStage({ queueData, queueRef, tokenData, queueTokenId, currentStage }) {
  const adminATC = getFirestore("firestore-atc");
  const adminForms = getFirestore("firestore-forms");
  const defaultDb = admin.firestore();
  const atcrequiredstages = queueData["atcrequiredstages"] || [];
  const stageCfg = atcrequiredstages.find((s) => s.stage === currentStage);
  if (!stageCfg) return;

  const profileid = tokenData["profile_id"];

  // Gate: only generateatc===true stages produce a gen doc.
  if (stageCfg.generateatc !== true) {
    await recordDropoff("S0", "generateatc_false", { profileid, queueTokenId, stage: currentStage });
    return console.log(`generateatc!=true for stage ${currentStage} — no gen doc`);
  }

  // Resolve own + pairing sources (shared resolver — parity with the preview).
  const resolved = await resolveStageData({
    queueData, queueRef, tokenData, queueTokenId, profileid,
    stage: currentStage, stageCfg, defaultDb, formsDb: adminForms,
  });

  // Own-stage source unresolvable → no doc (drop-off), same as old behaviour.
  if (!resolved.ok) {
    const dropReason = ownFailureDropoffReason(resolved.reason);
    await alertAtc("warn", `Own-stage source unresolvable for "${currentStage}" (${resolved.reason}) — ATC job not created.`, {
      stage: "Stage 0", extra: { profileid, queueTokenId, reason: resolved.reason },
    });
    await recordDropoff("S0", dropReason, { profileid, queueTokenId, stage: currentStage });
    return console.log(`own source unresolvable for ${currentStage}: ${resolved.reason}`);
  }

  const { stagedata, status, ownSourceref, ownType } = resolved;

  // Dedup: same profile+token+queue+stage with the same own sourceref already exists.
  const existingSnap = await adminATC.collection("queue_atc_generation")
    .where("queueref", "==", adminATC.doc(queueRef.path))
    .where("profileid", "==", profileid)
    .where("queue_token_id", "==", queueTokenId)
    .where("stage", "==", currentStage)
    .get();
  if (!existingSnap.empty) {
    // sourceref is a path STRING now (was a cross-DB DocumentReference); normalize
    // so dedup still works against any legacy ref-shaped doc too.
    const srPath = (r) => (typeof r === "string" ? r : (r && r.path) || null);
    const existingSourceRef = srPath(existingSnap.docs[0].data()["sourceref"]);
    const ownPath = srPath(ownSourceref);
    if (existingSourceRef && ownPath && existingSourceRef === ownPath) {
      return console.log(`queue_atc_generation already exists for ${currentStage}`);
    }
  }

  const docid = adminATC.collection("queue_atc_generation").doc().id;
  const payload = {
    docid: docid,
    queueref: adminATC.doc(queueRef.path),
    profileid: profileid,
    queue_token_id: queueTokenId,
    stage: currentStage,
    generateatc: stageCfg.generateatc,
    type: ownType,                              // own-stage type (form|zoom) — byType rollup
    pairingstages: stageCfg.pairingstages || [], // stored as-is (object/array); read via stagedata, not .includes
    sourceref: ownSourceref,
    data: stagedata[currentStage].data,          // own-stage data (backward-compat)
    stagedata: stagedata,                        // NEW: full resolved own+pairing map
    createdAt: new Date(),
  };
  // "dataincomplete" blocks S1 + the pod loop until the button completes it.
  // When complete, leave status UNSET so onQueueAtcGenerationCreate (S1) builds
  // the prompt and sets "pending" — preserving the create⇒S1⇒(pending⇔prompt) invariant.
  if (status === "dataincomplete") payload.status = "dataincomplete";

  await adminATC.collection("queue_atc_generation").doc(docid).set(payload);
  console.log(`queue_atc_generation created ${docid} for stage ${currentStage} (status=${status})`);
}

// Exposed for integration tests (not deployed functions). onQueueStageChange
// drives these internally; tests call them directly to exercise the Stage-0
// ATC logic without the surrounding WATI/Zoom/Slack side effects.
exports.processStage = processStage;
exports.resolvePreviousStage = resolvePreviousStage;
exports.handleRecordingTranscriptCompleted = handleRecordingTranscriptCompleted;

// ---------- Helpers ----------
async function getTranscript(meetingId) {
  if (!meetingId) throw new Error("meetingId is required");
  const accountId =  zoomAccountId.value();
  const clientId = zoomClientId.value();
  const clientSecret = zoomClientSecret.value();

  const tokenResponse = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}&client_id=${clientId}&client_secret=${clientSecret}`,
    { method: "POST" }
  );
  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) throw new Error("Failed to get Zoom access token");

  const accessToken = tokenData.access_token;
  const recordingResponse = await fetch(
    `https://api.zoom.us/v2/meetings/${meetingId}/recordings`,
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
  if (!recordingResponse.ok) {
    const err = await recordingResponse.json();
    throw new Error(err.message || "Recording not found");
  }
  const recordingData = await recordingResponse.json();
  const transcriptFile = recordingData.recording_files?.find((f) => f.file_type === "TRANSCRIPT");
  if (!transcriptFile) throw new Error("No transcript found. Enable Audio Transcript in Zoom settings.");

  const transcriptResponse = await fetch(`${transcriptFile.download_url}?access_token=${accessToken}`);
  if (!transcriptResponse.ok) throw new Error("Failed to download transcript file");
  const vttContent = await transcriptResponse.text();

  return {
    meetingId,
    topic: recordingData.topic,
    start_time: recordingData.start_time,
    duration: recordingData.duration,
    transcript_raw: vttContent,
    transcript_text: convertVttToLLM(vttContent),
    download_url: transcriptFile.download_url,
  };
}

// Handles the "recording.transcript_completed" zoomActivitylog branch — this
// event fires once the transcript specifically is ready (separately from,
// and later than, "recording.completed"), so unlike that branch there's no
// timing race here: getTranscript's re-fetch of /meetings/{id}/recordings
// should reliably find the TRANSCRIPT file at this point.
// `fetchTranscript` is injectable so tests can avoid hitting the real Zoom API.
async function handleRecordingTranscriptCompleted(meetingId, { fetchTranscript = getTranscript } = {}) {
  if (!meetingId) return console.log("handleRecordingTranscriptCompleted: missing meetingId");

  const snapshot = await admin.firestore().collection('live assignment').where('zoomdata.id', '==', meetingId).get();
  if (snapshot.empty) {
    return console.log(`handleRecordingTranscriptCompleted: no live assignment for meeting ${meetingId}`);
  }
  const liveAssignmentDoc = snapshot.docs[0];
  if (liveAssignmentDoc.data().transcript_text) {
    // idempotent guard — Zoom may resend the same webhook event.
    return console.log(`handleRecordingTranscriptCompleted: transcript already captured for ${liveAssignmentDoc.id}`);
  }

  try {
    const result = await fetchTranscript(meetingId);
    if (!result || !result.transcript_text || !result.transcript_text.trim()) {
      throw new Error(`empty transcript for meeting ${meetingId}`);
    }
    await liveAssignmentDoc.ref.update({
      transcript_text: result.transcript_text,
      transcript_raw: result.transcript_raw,
      zoom_topic: result.topic,
      zoom_start_time: result.start_time,
      zoom_duration: result.duration,
      transcriptCapturedAt: admin.firestore.FieldValue.serverTimestamp(),
      transcriptCaptureStatus: "captured",
    });
    console.log(`handleRecordingTranscriptCompleted: captured transcript for live assignment ${liveAssignmentDoc.id} (meeting ${meetingId})`);
  } catch (err) {
    console.error(`handleRecordingTranscriptCompleted: failed for meeting ${meetingId}: ${err.message}`);
    await liveAssignmentDoc.ref.set({
      transcriptCaptureStatus: "failed",
      transcriptCaptureFailedAt: admin.firestore.FieldValue.serverTimestamp(),
      transcriptCaptureLastError: err.message,
    }, { merge: true });
  }
}

function convertVttToLLM(vttText) {
  const lines = vttText.trim().split("\n");
  const entries = [];
  let currentSpeaker = null;
  let currentText = "";

  for (let line of lines) {
    line = line.trim();
    if (
      !line ||
      line === "WEBVTT" ||
      /^\d+$/.test(line) ||
      /^\d{2}:\d{2}:\d{2}/.test(line)
    ) continue;

    const match = line.match(/^(.+?):\s+(.+)$/);
    if (match) {
      const speaker = match[1].trim();
      const text = match[2].trim();
      if (speaker === currentSpeaker) {
        currentText += " " + text;
      } else {
        if (currentSpeaker) entries.push(`${currentSpeaker}: ${currentText}`);
        currentSpeaker = speaker;
        currentText = text;
      }
    }
  }
  if (currentSpeaker) entries.push(`${currentSpeaker}: ${currentText}`);
  return entries.join("\n");
}

