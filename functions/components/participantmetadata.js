
const admin = require("firebase-admin");
const {onDocumentCreated,onDocumentWritten} = require("firebase-functions/v2/firestore");
const https = require("https")
const commonService = require('./service');
const { onSchedule } = require("firebase-functions/scheduler");
const axios = require("axios");

// True only when running under the Firebase Functions emulator (firebase-tools sets FUNCTIONS_EMULATOR=true
// in every runtime it spawns). Used to skip external Watson/CRM webhook mirrors under the emulator, where
// those hosts hang ~60s per call and starve the shared functions runtime. This is deliberately NOT keyed on
// commonService.production: the real `development` deploy (starlabs-test) is also non-production but IS meant
// to mirror to the test Watson/CRM, so we must skip only in the emulator — never in a real deploy.
const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === "true";

const throwParticipantMetaDataException = require("./service").throwParticipantMetaDataException
const updateParticipantMetadataTierAccess = require("./eiflix-tier").updateParticipantMetadataTierAccess

exports.profiledata_to_participantmetadata = onDocumentWritten("profile_data/{id}",async (change) => {
  let olddoc = ![null,undefined].includes(change.data.before.data()) ? change.data.before.data() : {}
  olddoc['name'] = ![null,undefined].includes(olddoc['name']) ? olddoc['name']:null
  olddoc['email'] = ![null,undefined].includes(olddoc['email']) ? olddoc['email']:null
  olddoc['number'] = ![null,undefined].includes(olddoc['number']) ? olddoc['number']:null
  olddoc['countrycode'] = ![null,undefined].includes(olddoc['countrycode']) ? olddoc['countrycode']:null
  olddoc['testuser'] = ![null,undefined].includes(olddoc['testuser']) ? olddoc['testuser']:null
  olddoc['participantmode'] = ![null,undefined].includes(olddoc['participantmode']) ? olddoc['participantmode']:null
  olddoc['dateofbirth'] = ![null,undefined].includes(olddoc['dateofbirth']) ? olddoc['dateofbirth'].toDate().toISOString():null
  let newdoc = change.data.after.data()
  console.log("newdoc",change.data.after.exists);
  console.log(olddoc['dateofbirth'],(newdoc['dateofbirth'] != undefined && newdoc['dateofbirth'] != null ? newdoc['dateofbirth'].toDate().toISOString() : null));
  if(change.data.after.exists){
    if(
      olddoc['name'] != newdoc['name'] || 
      olddoc['email'] != newdoc['email'] || 
      olddoc['number'] != newdoc['number'] || 
      olddoc['countrycode'] != newdoc['countrycode'] || 
      olddoc['testuser'] != newdoc['testuser'] || 
      olddoc['participantmode'] != newdoc['participantmode'] || 
      olddoc['profile'] != newdoc['profile'] || 
      olddoc['profileimg'] != newdoc['profileimg'] || 
      olddoc['dateofbirth'] != (newdoc['dateofbirth'] != undefined && newdoc['dateofbirth'] != null ? newdoc['dateofbirth'].toDate().toISOString() : null)
    ){
      console.log("function started to update number,email,name");
      console.log('profileid',newdoc['name'],newdoc['profileid']);
      let data = newdoc
      await admin.firestore().collection("participant metadata").doc(data['profileid']).set({
        profileid:data['profileid'],
        name : data['name'],
        email : data['email'],
        countrycode : data['countrycode'],
        phonenumber : data['number'],
        testuser : ![null,undefined].includes(data['testuser']) ? data['testuser'] : false,
        participantmode : ![null,undefined].includes(data['participantmode']) ? data['participantmode'] : null,
        dateofbirth : ![null,undefined].includes(data['dateofbirth']) ? data['dateofbirth'] : null,
        profile : ![null,undefined].includes(data['profile']) ? data['profile'] : null,
        profileimg : ![null,undefined].includes(data['profileimg']) ? data['profileimg'] : null,
        notes : ![null,undefined].includes(data['notes']) ? data['notes'] : null,
      },{
        merge:true
      }).then(() => {
        console.log("updated in participant metadata",newdoc['profileid']);
      })

      let WatsonWebhookUrl = "";

      if (commonService.production) {
        WatsonWebhookUrl = "https://us-central1-watsonproduction-becde.cloudfunctions.net/updateParticipantProfile";
      } else {
        WatsonWebhookUrl = "https://us-central1-watson-test-19.cloudfunctions.net/updateParticipantProfile";
      }

      try {
        // Skip the external Watson mirror ONLY under the emulator: there this host HANGS ~60s per call
        // (no prod-firewall on server-side CF HTTP), and the pile-up of 60s-timeout invocations starves the
        // shared functions runtime and delays the calculateParticipantMode self-cascade past the specs'
        // polls. Real dev/prod deploys still mirror as before. Fire-and-forget side-effect, never asserted.
        if (!IS_EMULATOR) await axios.post(WatsonWebhookUrl, {
          profileid: data['profileid'],
          type: 'profile',
          profileimg: ![null, undefined].includes(data['profileimg'])
            ? data['profileimg']
            : ![null, undefined].includes(data['profile'])
              ? data['profile']
              : null,
        });
        console.log("Watson Webhook sent successfully");
      } catch (webhookError) {
        console.error("Watson Webhook failed:", webhookError.message);
      }

    }else{
      console.log("this function is to update number,email,name,testuser,participantmode,dateofbirth no change in these field");
    }
  }else if(!change.data.after.exists){
    console.log("profile data deleted");
    let data = olddoc
    await admin.firestore().collection('participant metadata').doc(data['profileid']).delete().then(() => {
      console.log(data['name'],data['profileid'],"document successfully deleted in participant metadata");
    })
  }
  //updating tier access when user is created
  if(!olddoc && newdoc || olddoc && newdoc){
    let oldDocUserRef = olddoc ? olddoc['user_ref'] ? olddoc['user_ref'].id : null : null
    let newDocUserRef = newdoc ? newdoc['user_ref'] ? newdoc['user_ref'].id : null : null
    if(oldDocUserRef != newDocUserRef){
      console.log(olddoc['user_ref'], newdoc['user_ref']);
      await updateParticipantMetadataTierAccess(newdoc['profileid'],change.data.after.ref.path)
    }
  }
})

exports.RecommendedPlaylistTrigger_to_pmd = onDocumentCreated("recommended mix playlist/{docid}", async (snapshot) => {
  if(snapshot.data.exists){
    let data = snapshot.data.data()
    let mapcontent = {}
    mapcontent[data['id']] = data['list'].map(e=> e.id)
    console.log(mapcontent, 'mapcontent');
    await admin.firestore().collection("participant metadata").doc(data['profileid']).get().then(async profilesnap => {
      let dashboardcontent = profilesnap.data()[data['type']] || {}
      console.log(dashboardcontent, 'dashboardcontent');
      let mergecontent = {...mapcontent,...dashboardcontent}
      console.log(mergecontent);
      profilesnap.ref.set({
        [data['type']] : mergecontent
      },{merge:true}).then(() => {
        console.log("document updated");
      }).catch(err => {
        console.log(err);
      })
    })
  }
})

exports.purchaselabel_to_pmd = onDocumentWritten('journeyproductpurchase/{docid}',async (change) => {
  let olddoc = change.data.before.data()
  let newdoc = change.data.after.data()
  if([null,undefined].includes(olddoc)){console.log("onCreate");}
  if(olddoc != null && newdoc != null){console.log('onUpdate');}
  if([null,undefined].includes(newdoc)){console.log("onDelete");}
  let profileid = ![null,undefined].includes(newdoc) ? newdoc['profileid'] : olddoc['profileid']
  try {
    let participantJourneyProductArray = []
    let purchaselabel = []
    var liveJourney = null
    let mapJourney = {}
    let higherOrderPurchase = null

    await admin.firestore().collection('journey').get().then(journey => {
      for (let i = 0; i < journey.docs.length; i++) {
        const element = journey.docs[i].data();
        mapJourney[element['id']] = element
      }
    })

    await admin.firestore().collection('participantjourneyproduct').where('profileid','==',profileid).get().then(async snap => {
      var journeyProductProfile = snap.docs.map(e => e.data())
      console.log(journeyProductProfile.length);
      
      var activeJourneyList = journeyProductProfile.filter(e => [null, "initiated", "ongoing", "completed"].includes(e["journeystatus"]))
      console.log(activeJourneyList);
      
      if(activeJourneyList.length != 0){
        var ongoingJourney = []
        var completedjourney = []
        activeJourneyList.forEach(journeyElement =>{
          if([null, "initiated", "ongoing"].includes(journeyElement["journeystatus"])){
            ongoingJourney.push(journeyElement)
          }
          else if(journeyElement["journeystatus"] == "completed"){
            completedjourney.push(journeyElement)
          }
        })
        console.log(completedjourney);
        
        if(completedjourney.length != 0){
          console.log(ongoingJourney.length, 'length');
          if(ongoingJourney.length == 0){
            liveJourney = completedjourney[0]
            console.log(liveJourney, 'liveJourney');
          }
        }

        if(ongoingJourney.length != 0){
          ongoingJourney = ongoingJourney.sort((a, b) => b["subscriptionend"].toDate() - a["subscriptionend"].toDate())
          var currentOngoing = ongoingJourney.find(e => e["journeystatus"] == "ongoing")
          var currentInitiated = ongoingJourney.find(e => e["journeystatus"] == "initiated")
          if(![null, undefined].includes(currentOngoing)){
            liveJourney = currentOngoing
          }
          else if(![null, undefined].includes(currentInitiated)){
            liveJourney = currentInitiated
          }
          else{
            liveJourney = ongoingJourney[0]
          }
        }  
        
        higherOrderPurchase = activeJourneyList.reduce((higherOrderJourney, currentJourney) => {
          if(![null, undefined].includes(mapJourney[currentJourney['journeyref']]) && ![null, undefined].includes(mapJourney[higherOrderJourney['journeyref']]) &&
             ![null, undefined].includes(mapJourney[currentJourney['journeyref'].id]['sequence']) && 
             ![null, undefined].includes(mapJourney[higherOrderJourney['journeyref'].id]['sequence']))
          mapJourney[currentJourney['journeyref'].id]['sequence'] < mapJourney[higherOrderJourney['journeyref'].id]['sequence'] ? currentJourney : higherOrderJourney;
        })
        
      }  
    })  
  
    console.log(liveJourney, 'liveJourney');
      
    if (liveJourney && liveJourney['journeyref']) {
      participantJourneyProductArray.push(liveJourney['purchaseref'].id);
    }

    await admin.firestore().collection('journeyproductpurchase').where('profileid','==',profileid).get().then(async purchasesnap => {
      for (let i = 0; i < purchasesnap.docs.length; i++) {
        const element = purchasesnap.docs[i];
        var elementData = element.data()
        if(participantJourneyProductArray.includes(element.id)){
          if(![null, undefined].includes(elementData['watsonpurchaselabel']) && ![null, undefined].includes(elementData['journeyref'])){
            purchaselabel.push(elementData['watsonpurchaselabel'])
          }
        }
      }
    })
    let higherOrderPurchaseJourney = ![null,undefined].includes(higherOrderPurchase) ? higherOrderPurchase['journeyref'].id : null

    console.log(purchaselabel, 'purchaselabel');
    console.log(profileid, "profileid");
    console.log(higherOrderPurchaseJourney, 'higherOrderPurchaseJourney');
    
    await admin.firestore().collection('participant metadata').doc(profileid).set({
      purchase : purchaselabel,
      higherorderpurchase : higherOrderPurchaseJourney
    },{
      merge:true
    }).catch(async err =>{
      await throwParticipantMetaDataException({
        profileid: profileid,
        failed: "purchase",
        triggerdoc: change.data.after.ref.path,
        err: err.toString(),
      })
    })
  } 
  catch (err) {
    await throwParticipantMetaDataException({
      profileid: profileid,
      failed: "purchase",
      triggerdoc: change.data.after.ref.path,
      err: err.toString() 
    })
  }

}) 

exports.journey_to_pmd = onDocumentWritten('participantjourneyproduct/{docid}', async (change) => {
  let olddoc = change.data.before.exists ? change.data.before.data() : null;
  let newdoc = change.data.after.exists ? change.data.after.data() : null;

  console.log("old doc", olddoc);
  console.log("new doc", newdoc);

  let profileid = newdoc?.['profileid'] ?? olddoc?.['profileid'];

  if (!profileid) {
    console.log("No profileid found, exiting");
    return null;
  }

  if (!olddoc) { console.log("onCreate"); }
  else if (olddoc && newdoc) { console.log('onUpdate'); }
  else if (!newdoc) { console.log("onDelete"); }

  var journeyName = null;
  if (newdoc?.["journeyref"]) {
    try {
      const journeySnap = await admin.firestore().doc(newdoc["journeyref"].path).get();
      journeyName = journeySnap.exists ? journeySnap.data()["journey"] : null;
    } catch (e) {
      console.log("Error fetching journey name", e);
    }
  }

  try {
    console.log("Try Block", profileid);

    var participantdashboardData = {};
    const pdSnap = await admin.firestore().collection("participant metadata").doc(profileid).get();
    if (pdSnap.exists) {
      participantdashboardData = pdSnap.data();
    }

    if (olddoc && newdoc && olddoc['onboarded'] !== true && newdoc['onboarded'] === true) {
      try {
        await commonService.updateParticipantTouchPoint({
          label: (journeyName || "Journey") + " Onboarded",
          notes: "",
          touchpoint: "Journey Onboarded",
          touchpointdate: newdoc["onboardedtime"]?.toDate() ?? new Date(),
          profileid: newdoc["profileid"],
          parentreference: change.data.after.ref,
          metadata: {
            journeyref: newdoc["journeyref"],
          }
        });
      } catch (error) {
        console.log("Touch Point Error - Appointment Scheduled", error.toString());
      }
    }

    const snap = await admin.firestore().collection('participantjourneyproduct').where('profileid', '==', profileid).get();
    var journeyProductProfile = snap.docs.map(e => e.data());

    const activeJourneyList = journeyProductProfile.filter((e) => ["initiated", "ongoing", "completed"].includes(e["journeystatus"]) && ![null, undefined, ""].includes(e["journeyref"]));
    const nullJourneyList = journeyProductProfile.filter((e) => [null].includes(e["journeystatus"]) && ![null, undefined, ""].includes(e["journeyref"]));
    const cancelledJourneyList = journeyProductProfile.filter((e) => ["cancelled"].includes(e["journeystatus"]) && ![null, undefined, ""].includes(e["journeyref"]));
    const closedLastJourneyList = journeyProductProfile.filter((e) => ["closed lost"].includes(e["journeystatus"]) && ![null, undefined, ""].includes(e["journeyref"]));

    const refOf = (journey) =>
      admin.firestore().doc(
        `/participantjourneyproduct/${journey["docid"] ?? journey["_docId"]}`,
      );

    const newData = {
      activejourney: null,
      subscriptionstart: null,
      subscriptionend: null,
      customerstatus: null,
      lastcompletedjourney: null,
      lastsubscribedjourney: null,
      lastsubscriptionstart: null,
      lastsubscriptionend: null,
      purchasedate: null,
      purchaseref: null,
      lastsubscribedpurchaseref: null,
    };

    let ongoingJourney = [];
    let completedjourney = [];
    const cancelledJourney = [...cancelledJourneyList];

    if (["banned", "late"].includes(participantdashboardData["customerstatus"])) {
      newData.customerstatus = participantdashboardData["customerstatus"];
    } else if (nullJourneyList.length > 0 || closedLastJourneyList.length > 0) {
      newData.customerstatus = "none";
      newData["participantmode"] = null;
    } else if (activeJourneyList.length != 0) {
      activeJourneyList.forEach((journeyElement) => {
        if (["initiated", "ongoing"].includes(journeyElement["journeystatus"])) {
          ongoingJourney.push(journeyElement);
        } else if (journeyElement["journeystatus"] == "completed") {
          completedjourney.push(journeyElement);
        }
      });

      if (ongoingJourney.length != 0) {
        ongoingJourney = ongoingJourney.sort((a, b) => b["subscriptionend"]?.toDate() - a["subscriptionend"]?.toDate(),);
        const currentDate = new Date();
        const currentOngoing = ongoingJourney.find((e) => e["journeystatus"] == "ongoing",);
        const currentInitiated = ongoingJourney.find((e) => e["journeystatus"] == "initiated",);

        const liveJourney = currentOngoing ?? currentInitiated ?? ongoingJourney[0];
        const hasSubscription = liveJourney["subscriptionend"] && liveJourney["subscriptionend"].toDate() >= currentDate;

        if (liveJourney && hasSubscription) {
          if (ongoingJourney.length == 1 && cancelledJourney.length == 0 && completedjourney.length == 0) {
            newData.customerstatus = "active";
            newData.activejourney = liveJourney["journeyref"]?.id ?? null;
            newData.purchasedate = liveJourney["purchasedate"]?.toDate() ?? null;
            newData.subscriptionstart = liveJourney["subscriptionstart"]?.toDate() ?? null;
            newData.subscriptionend = liveJourney["subscriptionend"]?.toDate() ?? null;
            newData.purchaseref = refOf(liveJourney);
          } else {
            newData.customerstatus = "none";
            newData["participantmode"] = null;
          }
        } else if (liveJourney && !hasSubscription) {
          newData.customerstatus = "none";
          newData["participantmode"] = null;
        }
      } else if (completedjourney.length == 1 && ongoingJourney.length == 0 && cancelledJourney.length == 0) {
        newData.customerstatus = "non active";
        newData["participantmode"] = "Exploration Mode";
        newData["lastcompletedjourney"] = completedjourney[0]["journeyref"]?.id ?? null;
        newData["lastsubscriptionstart"] = completedjourney[0]["subscriptionstart"]?.toDate() ?? null;
        newData["lastsubscriptionend"] = completedjourney[0]["subscriptionend"]?.toDate() ?? null;
        newData.lastsubscribedpurchaseref = refOf(completedjourney[0]);
      } else {
        newData.customerstatus = "none";
        newData["participantmode"] = null;
      }
    } else if (cancelledJourney.length == 1 && ongoingJourney.length == 0 && completedjourney.length == 0) {
      newData.customerstatus = "discontinued";
      newData["participantmode"] = null;
      newData["lastsubscribedjourney"] = cancelledJourney[0]["journeyref"]?.id ?? null;
      newData["lastsubscriptionstart"] = cancelledJourney[0]["subscriptionstart"]?.toDate() ?? null;
      newData["lastsubscriptionend"] = cancelledJourney[0]["subscriptionend"]?.toDate() ?? null;
      newData.lastsubscribedpurchaseref = refOf(completedjourney[0]);
    } else {
      newData.customerstatus = "none";
      newData["participantmode"] = null;
    }

    try {
      await admin.firestore().collection("participant metadata").doc(profileid).set(newData, { merge: true });

      let CrmWebhookUrl = "";
      let WatsonWebhookUrl = "";

      if (commonService.production) {
        CrmWebhookUrl = "https://us-central1-salesleadcrm.cloudfunctions.net/updatepersonfromstarlabs";
        WatsonWebhookUrl = "https://us-central1-watsonproduction-becde.cloudfunctions.net/updateParticipantProfile";
      } else {
        CrmWebhookUrl = "https://us-central1-salescrm-test-19.cloudfunctions.net/updatepersonfromstarlabs";
        WatsonWebhookUrl = "https://us-central1-watson-test-19.cloudfunctions.net/updateParticipantProfile";
      }

      try {
        if (!IS_EMULATOR) await axios.post(CrmWebhookUrl, {
          profileid: profileid,
          ...newData
        });
        console.log("SalesCRM Webhook sent successfully");
      } catch (webhookError) {
        console.error("SalesCRM Webhook failed:", webhookError.message);
      }

      try {
        // Skip the external Watson mirror ONLY under the emulator: there this host HANGS ~60s per call
        // (no prod-firewall on server-side CF HTTP), and the pile-up of 60s-timeout invocations starves the
        // shared functions runtime and delays the calculateParticipantMode self-cascade past the specs'
        // polls. Real dev/prod deploys still mirror as before. Fire-and-forget side-effect, never asserted.
        if (!IS_EMULATOR) await axios.post(WatsonWebhookUrl, {
          type: 'subscription',
          profileid: profileid,
          ...newData
        });
        console.log("Watson Webhook sent successfully");
      } catch (webhookError) {
        console.error("Watson Webhook failed:", webhookError.message);
      }
    } catch (err) {
      await throwParticipantMetaDataException({
        profileid: profileid,
        failed: "activejourney",
        triggerdoc: change.data.after.ref?.path ?? change.data.before.ref?.path,
        err: err.toString()
      });
    }

    // Update Tier Access
    if ([null, undefined].includes(participantdashboardData["profileid"])) {
      console.log("No Profile");
      await throwParticipantMetaDataException({
        profileid: profileid,
        failed: "activejourney",
        triggerdoc: change.data.after.ref?.path ?? change.data.before.ref?.path,
        err: "no profile exist"
      });
      await updateParticipantMetadataTierAccess(profileid, change.data.after.ref?.path ?? change.data.before.ref?.path);
    } else {
      console.log("participantdashboardData[activejourney]", participantdashboardData["activejourney"], "newData.activejourney", newData.activejourney);
      if ((olddoc?.['journeystatus'] != newdoc?.['journeystatus']) || participantdashboardData["activejourney"] != newData.activejourney) {
        await updateParticipantMetadataTierAccess(profileid, change.data.after.ref?.path ?? change.data.before.ref?.path);
      }
    }

    if (olddoc && newdoc && [null, undefined, "", false].includes(olddoc['onboarded']) && newdoc['onboarded'] === true) {
      const salesLeadId = newdoc['salesleadsref']?.id;
      const onboardedDate = newdoc['onboardedtime']?.toDate();

      if (salesLeadId && onboardedDate) {
        var url;
        if (commonService.production) {
          url = "https://us-central1-salesleadcrm.cloudfunctions.net/Profilestatusupdate?profilestatus=" + 'onboarded' + "&convertedleadsid=" + salesLeadId + "&onboardeddate=" + onboardedDate;
        } else {
          url = "https://us-central1-salescrm-test-19.cloudfunctions.net/Profilestatusupdate?profilestatus=" + 'onboarded' + "&convertedleadsid=" + salesLeadId + "&onboardeddate=" + onboardedDate;
        }
        console.log("Calling URL", url);
        https.get(url);
      }
    }

    return null;
  } catch (err) {
    console.log("error", err);
    await throwParticipantMetaDataException({
      profileid: profileid,
      failed: "activejourney",
      triggerdoc: change.data.after.ref?.path ?? change.data.before.ref?.path,
      err: err.toString()
    });
  }
});

exports.productsdata_to_pmd = onDocumentWritten('participantsproduct/{docid}',async (change) => {
  let olddoc = change.data.before.data()
  let newdoc = change.data.after.data()
  let oldProductStatus
  let newProductStatus
  // Null-safe profileid: on a CREATE there is no `before`, on a DELETE there is no `after`. Reading
  // newdoc['profileid'] unconditionally threw on every delete (killing this shared-runtime trigger and,
  // under the emulator's single sequential runtime, starving the very next invocation). Mirror the
  // correct pattern already used by eventparticipationdata_to_pmd below.
  let profileid = ![null, undefined].includes(newdoc) ? newdoc['profileid'] : (olddoc ? olddoc['profileid'] : null)
  let mapPackage = {}
  //product status update condition
  if([null,undefined].includes(olddoc)){
    oldProductStatus = null
    newProductStatus = newdoc['status']
    console.log("onCreate");
  }
  else if(olddoc != null && newdoc != null){
    oldProductStatus = olddoc['status']
    newProductStatus = newdoc['status']
    console.log('onUpdate');
  }
  else if([null,undefined].includes(newdoc)){
    oldProductStatus = olddoc['status']
    newProductStatus = null
    console.log("onDelete");
  }
  console.log('product status change',oldProductStatus != newProductStatus);
  // Null-safe: on CREATE olddoc is undefined, on DELETE newdoc is undefined. When the status is
  // unchanged (e.g. a create with status:null — the PM-SEED case) the first operand is false and the
  // packageref comparison is evaluated, so both sides must tolerate an absent snapshot.
  if(oldProductStatus != newProductStatus || (olddoc || {})["packageref"] != (newdoc || {})["packageref"]){
    //get package name
    await admin.firestore().collection('package').get().then(async packagesnap => {
      for (let i = 0; i < packagesnap.docs.length; i++) {
        const element = packagesnap.docs[i].data();
        mapPackage[element['docid']] = element['package']
      }
    })

    try {
      var participantdashboardData = {}
      await admin.firestore().collection("participant metadata").doc(profileid).get().then(async pdSnap => {
        if(pdSnap.exists){
          participantdashboardData = pdSnap.data()
          if(participantdashboardData["productcount"] == null || participantdashboardData["productcount"] == undefined){
            participantdashboardData["productcount"] = {}
          }
        }
        else{
          await throwParticipantMetaDataException({
            profileid: profileid,
            failed: "activeproduct",
            triggerdoc: change.data.after.ref.path,
            err: "no profile exist" 
          })
        }
      })

      await admin.firestore().collection('participantsproduct').where('profileid', '==', profileid).orderBy('sequenceorder', 'asc').get().then(async productsnap => {
        var participantsProductList = productsnap.docs.map(e => e.data())
        var newData = {
          activeproduct: [],
          consumedproducts : [],
          unconsumedproducts : [],
          gifts : [],
          addons : [],
          bonus : [],
          productcount : {}
        }
        
        for (let i = 0; i < participantsProductList.length; i++) {
          const participantsProductData = participantsProductList[i];
          var productId = participantsProductData["productref"].id
          if(participantsProductData["status"] == null){
            newData.unconsumedproducts.push(productId)
          }
          else if(participantsProductData["status"] == "completed"){
            newData.consumedproducts.push(productId)
          }
          else if(["initiated", "ongoing"].includes(participantsProductData["status"])){
            newData.activeproduct.push(productId)
          }
          newData.productcount[productId] = newData.productcount[productId] || 0
          newData.productcount[productId] += 1
          if(![null, undefined].includes(participantsProductData["packageref"])){
            var packageRealName = mapPackage[participantsProductData["packageref"].id]
            if(packageRealName == "A&H Gift"){
              newData.gifts.push(productId)
            }
            else if(packageRealName == "Addons"){
              newData.addons.push(productId)
            }
            else if(packageRealName == "Bonus"){
              newData.bonus.push(productId)
            }
          }
        }

        Object.keys(participantdashboardData["productcount"]).forEach(existingKey =>{
          if([null, undefined].includes(newData.productcount[existingKey])){
            newData.productcount[existingKey] = admin.firestore.FieldValue.delete()
          }
        })

        await admin.firestore().collection("participant metadata").doc(profileid).set(newData, {merge: true}).then(async ()=>{

        if ((oldProductStatus != newProductStatus) && newdoc) {
          console.log('yes works')

          let webhookUrl = "";

          if (commonService.production) {
            webhookUrl = "https://us-central1-salesleadcrm.cloudfunctions.net/updatepersonfromstarlabs";
          } else {
            webhookUrl = "https://us-central1-salescrm-test-19.cloudfunctions.net/updatepersonfromstarlabs";
          }

          const formattedStatusDate = {};

          if (newdoc.statusdate) {
            Object.keys(newdoc.statusdate).forEach(key => {
              const value = newdoc.statusdate[key];
              formattedStatusDate[key] = value?.toDate ? value.toDate().toISOString() : value;
            });
          }

          try {
              const payload = {
                profileid: profileid,
                product: {
                  product: newdoc.productref?.id || null,
                  status: newProductStatus || null,
                  journey: newdoc.packageref?.id || null,
                  statusdate: formattedStatusDate  || null
                  // ...(newProductStatus === "initiated" && {
                  //   initiateddate: new Date().toISOString()
                  // })
                }
              };

              // Emulator only: skip the external CRM mirror (it hangs ~60s) — see the Watson note above.
              const response = !IS_EMULATOR ? await axios.post(webhookUrl, payload) : { status: 'skipped(emulator)' };
              console.log("Webhook sent:", response.status);

            } catch (error) {
              console.error("Message:", error.message);
            }

          console.log("Webhook triggered due to status change");
        }

          /*
          // timeline log
          var docid = newdoc['docid']+newdoc['status']
          var data = {
            logid: docid,
            created: new Date(),
            activityname: "product"+newdoc['status'],
            productref: newdoc["productref"],
            activitydate: [null, undefined].includes(newdoc["statusdate"][newdoc['status']]) ? null : newdoc["statusdate"][newdoc['status']],
            profileid: newdoc["profileid"],
            participantproductid:newdoc['docid']
          }
          await admin.firestore().collection('timeline log').doc(docid).set(data).then(() => {
            console.log("timelog updated for the participantproduct",newdoc['docid']);
          })
          */
        }).catch(async(err) =>{
          await throwParticipantMetaDataException({
            profileid: profileid,
            failed: "participantproduct",
            triggerdoc: change.data.after.ref.path,
            err: err.toString() 
          })
        })

        // Tier Access
        if(!arraysEqual(participantdashboardData["consumedproducts"] || [], newData.consumedproducts)){
          await updateParticipantMetadataTierAccess(profileid,change.data.after.ref.path)
          console.log("tier access updated");
        }
      })
      
    } catch (err) {
      await throwParticipantMetaDataException({
        profileid: profileid,
        failed: "participant product",
        triggerdoc: change.data.after.ref.path,
        err: err.toString() 
      })
    }
  }else{
    return null;
  }
})

function arraysEqual(arr1, arr2) {
  // Check if lengths are the same
  if (arr1.length !== arr2.length) {
    return false;
  }
  // Use every() to check if all elements are equal
  return arr1.every((value, index) => value === arr2[index]);
}

exports.eventparticipationdata_to_pmd = onDocumentWritten("event participation request/{docid}",async (change) => {
  let olddoc = change.data.before.data()
  let newdoc = change.data.after.data()
  let profileid = ![null,undefined].includes(newdoc) ? newdoc['profileid'] : olddoc['profileid'];
  if([null,undefined].includes(olddoc)){console.log("onCreate");}
  else if(olddoc != null && newdoc != null){console.log('onUpdate');}
  else if([null,undefined].includes(newdoc)){console.log("onDelete");}

  if(olddoc && olddoc["status"] != newdoc["status"]){
    try {
      var participantdashboardData = {}
      await admin.firestore().collection("participant metadata").doc(profileid).get().then(async pdSnap => {
        if(pdSnap.exists){
          participantdashboardData = pdSnap.data()
          participantdashboardData["productevent"] = participantdashboardData["productevent"] || {}
        }
        else{
          await throwParticipantMetaDataException({
            profileid: profileid,
            failed: "event participation request",
            triggerdoc: change.data.after.ref.path,
            err: "no profile exist" 
          })
        }
      })

      var profileEventAttended = {}
      await admin.firestore().collection("event participation request").where("profileid","==",profileid).where("status", "==", "attended").get().then(attendedlist => {
        for (let i = 0; i < attendedlist.docs.length; i++) {
          const element = attendedlist.docs[i];
          var attendedData = element.data()
          profileEventAttended[attendedData["productref"].id] = profileEventAttended[attendedData["productref"].id] || []
          profileEventAttended[attendedData["productref"].id].push(attendedData["eventref"].id)
        }
        Object.keys(participantdashboardData["productevent"]).forEach(productid =>{
          if([null, undefined].includes(profileEventAttended[productid])){
            console.log(profileid)
            profileEventAttended[productid] = admin.firestore.FieldValue.delete()
          }
        })
      })

      await admin.firestore().collection('participant metadata').doc(profileid).set({
        productevent : profileEventAttended
      },{
        merge : true
      }).then(async () => {
        /*
        // timeline log
        var docid = newdoc['docid']
        var data = {
          logid: docid,
          created: new Date(),
          activityname: "event"+newdoc['status'],
          productref: newdoc["productref"],
          activitydate: [null, undefined].includes(newdoc["eventdate"][newdoc['status']]) ? null : newdoc["eventdate"][newdoc['status']],
          profileid: newdoc["profileid"],
          eventid:newdoc['eventref'].id,
        }
        await admin.firestore().collection('timeline log').doc(docid).set(data).then(() => {
          console.log("timelog updated for the event request",newdoc['docid']);
        })
        */
      }).
      catch(async err =>{
        await throwParticipantMetaDataException({
          profileid: profileid,
          failed: "event participantion request",
          triggerdoc: change.data.after.ref.path,
          err: err.toString()
        })
      })

    }catch (err) {
      await throwParticipantMetaDataException({
        profileid: profileid,
        failed: "event participantion request",
        triggerdoc: change.data.after.ref.path,
        err: err.toString()
      })
    }
  }
})


exports.atcdata_to_pmd = onDocumentWritten({document: "atc_apha/{docid}", database: "firestore-atc"},async (change) => {

  const { getFirestore } = require("firebase-admin/firestore");
  const adminATC = getFirestore("firestore-atc");

  const olddoc = change.data.before.data()
  const newdoc = change.data.after.data()
  let profileId = newdoc['profileid'] ? newdoc['profileid'] : null
  if(!olddoc && newdoc || olddoc && newdoc){
    if(profileId != null){
      console.log("profileid",profileId);
      adminATC.collection('atc_alpha').where('type','==','online').where('isdelete','==',false).where('profileid','==',profileId).get().then(async atcsnap => {
        console.log("atc_alpha document length",atcsnap.docs.length);
        let atcData = {}
        for (let i = 0; i < atcsnap.docs.length; i++) {
          const element = atcsnap.docs[i].data();
          let authorIds = element['author'].map(e => e.id)
          let validatorIds = element['validator'] ? element['validator'].map(e => e.id) : []
          let atcDocData = {
            atcid:element['atcid'],
            prescription_date:element['prescription_date'],
            atcmodel:element['product'] ? element['product'] : null,
            author:authorIds,
            mentor:element['mentor'] ? element['mentor'] : [],
            validator:validatorIds,
          }
          atcData['mapparticipantatc'] = atcData['mapparticipantatc'] || {}
          atcData['mapparticipantatc'][element['atcid']] = atcDocData
    
          atcData['atccount'] = (atcData['atccount'] || 0) + 1;
    
          const items = ['evolutionyearsaved','evolutionyearwasted'];
          items.forEach(item => {
            atcData[item] = (atcData[item] || 0) + (element[item] || 0);
          })
    
          atcData['atcmodel'] = atcData['atcmodel'] || [];
          if(element['product']){atcData['atcmodel'].push(element['product'])}
    
          atcData['participantatc'] = atcData['participantatc'] || []
          atcData['participantatc'].push(element['atcid'])
    
          for (const key in element['evolutionprogress'] || {}){
            atcData['evolutionprogress'] = atcData['evolutionprogress'] || {}
            atcData['evolutionprogress'][key] = (atcData['evolutionprogress'][key] || 0) + (element['evolutionprogress'][key] || 0) 
          }
    
          atcData['totaladjustmentaware'] = element['totaladjustmentaware'] || null
          atcData['totaladjustmentunaware'] = element['totaladjustmentunaware'] || null
    
        }
        let mapParticicipantMetaData = {}
        await admin.firestore().collection("participant metadata").doc(profileId).get().then(async snap => {
          if(snap.exists){
            console.log("mapparticipantatc exist");
            const element = snap.data();
            mapParticicipantMetaData['mapparticipantatc'] = element['mapparticipantatc'] || {}
            mapParticicipantMetaData['evolutionprogress'] = element['evolutionprogress'] || {}
          }else{
            console.log("mapparticipantatc doesn't exist");
          }
        });
    
        const items = ['mapparticipantatc','evolutionprogress'];
        items.forEach(item => {
          Object.keys(mapParticicipantMetaData[item]).forEach(key => {
            if([null,undefined].includes(atcData[item][key])){
              atcData[item][key] = admin.firestore.FieldValue.delete()
            }
          });
        })
        
        admin.firestore().collection("participant metadata").doc(profileId).set(atcData,{merge:true}).catch(async(error) => {
          await throwParticipantMetaDataException({
            profileid: profileId,
            failed: "atc_alpha",
            triggerdoc: change.data.after.ref.path,
            err: error.toString()
          })
        })
      })
    }else{
      console.log('document profileid value null','atc document id',change.params.docid);
      await throwParticipantMetaDataException({
        profileid: profileId,
        failed: "atc_alpha",
        triggerdoc: change.data.after.ref.path,
        err: "profileid null"
      })
    }
  }
})

exports.participantAELData_to_pmd = onDocumentWritten("/participant AEL/{docid}",async (change) => {
  let newDoc = change.data.after.data()
  const profileId = newDoc['profileid']
  try {
  await admin.firestore().collection("participant AEL").where("profileid","==",profileId).orderBy("created",'desc').get().then(async aelSnap => {
    let updateDoc = {
      currentael:[],
      completedael:[]
    }
    for (let i = 0; i < aelSnap.docs.length; i++) {
      const element = aelSnap.docs[i].data();
      console.log("status",element['status']);
      if(element['status'] === 'ongoing'){
        updateDoc['currentael'].push({
          status:element['status'],
          atcmodel:element['atcmodel'],
          created:element['created'].toDate(),
          crossovermetric : element['crossovermetric']
        })
      }
      if(element['status'] === 'completed'){
        updateDoc['completedael'].push({
          status:element['status'],
          atcmodel:element['atcmodel'],
          created:element['created'].toDate(),
          crossovermetric : element['crossovermetric']
        })
      }
    }
    await admin.firestore().collection("participant metadata").doc(profileId).set(updateDoc,{merge:true}).catch(async (err) => {
      await throwParticipantMetaDataException({
        profileid: profileId,
        failed: "participant AEL",
        triggerdoc: change.data.after.ref.path,
        err: err.toString()
      })
    })
  })
  } catch (error) {
    await throwParticipantMetaDataException({
      profileid: profileId,
      failed: "participant AEL",
      triggerdoc: change.data.after.ref.path,
      err: error.toString()
    })
  }
})

exports.participantsely_to_pmd = onDocumentWritten("/participants ely/{docid}",async (change) => {
  let oldDoc = change.data.before.data()
  let newDoc = change.data.after.data()
  let docid = change.data.after.id
  console.log("docid as profileid",docid);

  if (JSON.stringify(oldDoc) === JSON.stringify(newDoc)) {
    return null;
  }

  let noChanges = true
  if([null,undefined].includes(oldDoc)){
    noChanges = false
  }else if(oldDoc && newDoc){
    noChanges = await areFlatNumberInNewDocIdenticalInOldDoc(oldDoc,newDoc)
  }
  console.log("noChanges",noChanges);
  if(!noChanges){
    let listofactids = Object.keys(newDoc)
    let validatedAtcList = []
    let atcidDeletedList = {}
    for (let i = 0; i < listofactids.length; i=i+10) {
      const slicedelement = listofactids.slice(i,i+10);
      await admin.firestore().collection("atc_alpha").where("atcid","in",slicedelement).get().then(snap => {
        snap.forEach(doc => {
          let atcData = doc.data()
          if(atcData['isdelete'] != true && [null,'validated',undefined].includes(atcData['status'])){
            validatedAtcList.push(doc.id)
          }
        })
      })
    }
    // console.log("validatedAtcList",validatedAtcList);
    // console.log("listofactids",listofactids);
    
    for (const atcid of listofactids) {
      if(!validatedAtcList.includes(atcid)){
        atcidDeletedList[atcid] = admin.firestore.FieldValue.delete()
      }
    }
    console.log("atcidDeletedList",Object.keys(atcidDeletedList));
    
    let extendedlifeimpactcount = 0
    for (const element of validatedAtcList) {
      extendedlifeimpactcount = extendedlifeimpactcount + newDoc[element]
    }
    console.log("extendedlifeimpactcount",extendedlifeimpactcount);
    await admin.firestore().collection("participant metadata").doc(docid).set({
      extendedlifeimpact : extendedlifeimpactcount
    },{merge:true}).catch(async(err) => {
      await throwParticipantMetaDataException({
        profileid: docid,
        failed: "participants ely",
        triggerdoc: change.data.after.ref.path,
        err: err.toString()
      })
    })
    if(Object.keys(atcidDeletedList).length > 0){
      await change.data.after.ref.update(atcidDeletedList).then(()=> {
        console.log("deleted atc list");
      })
    }
  }
})

async function areFlatNumberInNewDocIdenticalInOldDoc(olddoc, newdoc) {
  const keys2 = Object.keys(newdoc);
  for (const key of keys2) {
    if(!(key in olddoc)) return false
    if(olddoc[key] !== newdoc[key]) return false
  }
  return true;
}

exports.bigAggregateLevelUpdate_to_pmd = onDocumentWritten("/big aggregate level/{docid}",(change) => {
  const newDoc = change.data.after.data()
  const oldDoc = change.data.before.data()
  let oldBigLevel = ![null,undefined].includes(oldDoc['level']) ? oldDoc['level'].id : null
  if(newDoc['level'].id != oldBigLevel){
    let mapatcmodeltobiglevel = {}
    admin.firestore().collection("big aggregate level").where("profileid","==",newDoc['profileid']).get().then(async snap => {
      for (let i = 0; i < snap.docs.length; i++) {
        const element = snap.docs[i].data();
        mapatcmodeltobiglevel[element['atcmodel']] = element['level'].id
      }
      await admin.firestore().collection("participant metadata").doc(newDoc['profileid']).get().then(async pdSnap => {
        if(pdSnap.exists){
          let curentData = pdSnap.data()['mapatcmodeltobiglevel'] || {}
          if(!mapsEqual(curentData,mapatcmodeltobiglevel)){
            await pdSnap.ref.update({
              mapatcmodeltobiglevel:mapatcmodeltobiglevel
            })
            await updateParticipantMetadataTierAccess(newDoc['profileid'],change.data.after.ref.path)
            console.log("done");
          }
        }else{
          console.log("not exist");
          await admin.firestore().collection("participant metadata").doc(newDoc['profileid']).set({
            mapatcmodeltobiglevel:mapatcmodeltobiglevel,
          },{merge:true})
          await updateParticipantMetadataTierAccess(newDoc['profileid'],change.data.after.ref.path)
          console.log("done");
        }
      })
    })
  }
})

function mapsEqual(map1, map2) {
  // Check if sizes are the same
  if (Object.keys(map1).length !== Object.keys(map2).length) {
    return false;
  }
  // Check if all key-value pairs are equal
  for (const key in map1) {
    let value = map1[key]
    if (map2[key] !== value) {
      return false
    }
  }
  return true;
}

exports.subscriptionend_JourneystatusUpdate = onSchedule({schedule : "05 00 * * *", region: "asia-south1", timeZone: "Asia/Kolkata"},async (context)=>{
  var batch = admin.firestore().batch()
  var batchCount = 0
  var subscriptionEndDate = new Date()
  subscriptionEndDate.setDate(subscriptionEndDate.getDate() + 1)
  subscriptionEndDate.setHours(5, 30, 0, 0)
  await admin.firestore().collection('participantjourneyproduct').where("journeystatus", "in", ["initiated", "ongoing"]).where('subscriptionend','<', subscriptionEndDate).get().then(async snap => {
    console.log(snap.docs.length);
    for (let i = 0; i < snap.docs.length; i++) {
      const doc = snap.docs[i];
      const data = doc.data();
      const status = data.journeystatus;
      if(([null, 'initiated', 'ongoing'].includes(status))){
        batch.update(doc.ref, {
          journeystatus : 'completed'
        })
        batchCount += 1
        if (batchCount === 500) {
          await batch.commit();
          console.log(`Committed batch of ${batchCount} documents.`);
          batch = admin.firestore().batch();
          batchCount = 0;
        }
      }
    }
    // Commit remaining documents
    if (batchCount > 0) {
      await batch.commit();
      console.log(`Committed final batch of ${batchCount} documents`);
    }
  })
})

/* =====================================================================
 * Face vectors — recompute ArcFace embeddings when a profile image changes.
 *   exports.updateFaceVectors — Firestore trigger on profile_data/{profileId}
 * Pipeline: SCRFD detect -> 5-point align (112x112) -> ArcFace embedding with
 * MobileFaceNet + ResNet50 -> L2-normalized 512-d. onnxruntime-node & sharp are
 * lazy-required inside the helpers so the other exports don't pay their
 * native-load cost on cold start. Helpers are `fv_`-prefixed to avoid name
 * collisions with the rest of this module.
 * ===================================================================== */
const FV_MODEL_URLS = {
  det: process.env.DET_URL || 'https://huggingface.co/immich-app/buffalo_s/resolve/main/detection/model.onnx',
  mbf: process.env.MBF_URL || 'https://huggingface.co/immich-app/buffalo_s/resolve/main/recognition/model.onnx',
  r50: process.env.R50_URL || 'https://huggingface.co/public-data/insightface/resolve/main/models/buffalo_l/w600k_r50.onnx',
};
const FV_DET_SIZE = 640;
const FV_INPUT = 112;
const FV_REF = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
  [41.5493, 92.3655], [70.7299, 92.2041],
];
let fv_sessions = null;

async function fv_fetchBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function fv_getSessions() {
  if (fv_sessions) return fv_sessions;
  const ort = require('onnxruntime-node');
  const [det, mbf, r50] = await Promise.all([
    fv_fetchBuffer(FV_MODEL_URLS.det), fv_fetchBuffer(FV_MODEL_URLS.mbf), fv_fetchBuffer(FV_MODEL_URLS.r50),
  ]);
  fv_sessions = {
    det: await ort.InferenceSession.create(det),
    mbf: await ort.InferenceSession.create(mbf),
    r50: await ort.InferenceSession.create(r50),
  };
  return fv_sessions;
}

const fv_area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
function fv_iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = fv_area(a) + fv_area(b) - inter;
  return u <= 0 ? 0 : inter / u;
}
function fv_nms(dets, iouThr) {
  const order = [...dets].sort((a, b) => b.score - a.score);
  const keep = [];
  while (order.length) {
    const best = order.shift();
    keep.push(best);
    for (let i = order.length - 1; i >= 0; i--) {
      if (fv_iou(best.box, order[i].box) > iouThr) order.splice(i, 1);
    }
  }
  return keep;
}

async function fv_detectFace(session, imgBuffer, origW, origH) {
  const ort = require('onnxruntime-node');
  const sharp = require('sharp');
  const scale = Math.min(FV_DET_SIZE / origW, FV_DET_SIZE / origH);
  const newW = Math.round(origW * scale);
  const newH = Math.round(origH * scale);
  const resized = await sharp(imgBuffer)
    .resize(newW, newH, { fit: 'fill' })
    .extend({ top: 0, left: 0, bottom: FV_DET_SIZE - newH, right: FV_DET_SIZE - newW, background: { r: 0, g: 0, b: 0 } })
    .removeAlpha().toColourspace('srgb').raw().toBuffer();
  const areaPx = FV_DET_SIZE * FV_DET_SIZE;
  const data = new Float32Array(3 * areaPx);
  for (let i = 0; i < areaPx; i++) {
    data[i] = (resized[i * 3] - 127.5) / 128.0;
    data[areaPx + i] = (resized[i * 3 + 1] - 127.5) / 128.0;
    data[2 * areaPx + i] = (resized[i * 3 + 2] - 127.5) / 128.0;
  }
  const feeds = {};
  feeds[session.inputNames[0]] = new ort.Tensor('float32', data, [1, 3, FV_DET_SIZE, FV_DET_SIZE]);
  const out = await session.run(feeds);
  const scores = [], bboxes = [], kpss = [];
  for (const name of session.outputNames) {
    const t = out[name];
    const last = t.dims[t.dims.length - 1];
    if (last === 1) scores.push(t);
    else if (last === 4) bboxes.push(t);
    else if (last === 10) kpss.push(t);
  }
  const byLen = (a, b) => b.data.length - a.data.length;
  scores.sort(byLen); bboxes.sort(byLen); kpss.sort(byLen);
  const strides = [8, 16, 32];
  const numAnchors = 2, thresh = 0.5;
  const dets = [];
  for (let s = 0; s < strides.length; s++) {
    const stride = strides[s];
    const feat = FV_DET_SIZE / stride;
    const score = scores[s].data, bbox = bboxes[s].data, kps = kpss[s].data;
    let idx = 0;
    for (let y = 0; y < feat; y++) {
      for (let x = 0; x < feat; x++) {
        for (let a = 0; a < numAnchors; a++, idx++) {
          if (score[idx] < thresh) continue;
          const cx = x * stride, cy = y * stride;
          const l = bbox[idx * 4] * stride, t = bbox[idx * 4 + 1] * stride;
          const r = bbox[idx * 4 + 2] * stride, b = bbox[idx * 4 + 3] * stride;
          const pts = [];
          for (let k = 0; k < 5; k++) {
            pts.push([
              (cx + kps[idx * 10 + k * 2] * stride) / scale,
              (cy + kps[idx * 10 + k * 2 + 1] * stride) / scale,
            ]);
          }
          dets.push({ score: score[idx], box: [(cx - l) / scale, (cy - t) / scale, (cx + r) / scale, (cy + b) / scale], kps: pts });
        }
      }
    }
  }
  if (dets.length === 0) return null;
  const keep = fv_nms(dets, 0.4);
  keep.sort((p, q) => fv_area(q.box) - fv_area(p.box));
  return keep[0];
}

function fv_bilinear(rgb, w, h, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = x0 + 1, y1 = y0 + 1;
  const fx = x - x0, fy = y - y0;
  const at = (xx, yy, c) => {
    const cx = Math.min(Math.max(xx, 0), w - 1);
    const cy = Math.min(Math.max(yy, 0), h - 1);
    return rgb[(cy * w + cx) * 3 + c];
  };
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = at(x0, y0, c) * (1 - fx) + at(x1, y0, c) * fx;
    const bot = at(x0, y1, c) * (1 - fx) + at(x1, y1, c) * fx;
    out[c] = Math.round(top * (1 - fy) + bot * fy);
  }
  return out;
}
function fv_solve4(a, b) {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    [m[col], m[piv]] = [m[piv], m[col]];
    const d = m[col][col];
    if (Math.abs(d) < 1e-12) continue;
    for (let j = col; j <= 4; j++) m[col][j] /= d;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = m[r][col];
      for (let j = col; j <= 4; j++) m[r][j] -= f * m[col][j];
    }
  }
  return [m[0][4], m[1][4], m[2][4], m[3][4]];
}
function fv_similarity(src, dst) {
  const ata = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const atb = [0, 0, 0, 0];
  const addRow = (row, d) => {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) ata[i][j] += row[i] * row[j];
      atb[i] += row[i] * d;
    }
  };
  for (let k = 0; k < src.length; k++) {
    const [sx, sy] = src[k]; const [dx, dy] = dst[k];
    addRow([sx, -sy, 1, 0], dx);
    addRow([sy, sx, 0, 1], dy);
  }
  return fv_solve4(ata, atb);
}
function fv_align(rgb, w, h, srcPts) {
  const [a, b, tx, ty] = fv_similarity(srcPts, FV_REF);
  const det = a * a + b * b;
  const ia = a / det, ib = b / det;
  const out = new Uint8Array(FV_INPUT * FV_INPUT * 3);
  for (let y = 0; y < FV_INPUT; y++) {
    for (let x = 0; x < FV_INPUT; x++) {
      const dx = x - tx, dy = y - ty;
      const [r, g, bl] = fv_bilinear(rgb, w, h, ia * dx + ib * dy, -ib * dx + ia * dy);
      const o = (y * FV_INPUT + x) * 3;
      out[o] = r; out[o + 1] = g; out[o + 2] = bl;
    }
  }
  return out;
}

async function fv_embed(session, rgb112) {
  const ort = require('onnxruntime-node');
  const areaPx = FV_INPUT * FV_INPUT;
  const data = new Float32Array(3 * areaPx);
  for (let i = 0; i < areaPx; i++) {
    data[i] = (rgb112[i * 3] - 127.5) / 127.5;
    data[areaPx + i] = (rgb112[i * 3 + 1] - 127.5) / 127.5;
    data[2 * areaPx + i] = (rgb112[i * 3 + 2] - 127.5) / 127.5;
  }
  const feeds = {};
  feeds[session.inputNames[0]] = new ort.Tensor('float32', data, [1, 3, FV_INPUT, FV_INPUT]);
  const out = await session.run(feeds);
  const raw = out[session.outputNames[0]].data;
  let sum = 0;
  for (let i = 0; i < raw.length; i++) sum += raw[i] * raw[i];
  const norm = Math.sqrt(sum) || 1;
  return Array.from(raw, (v) => v / norm);
}

// image Buffer -> { mbf:[512], r50:[512] } or null (no face).
async function fv_computeVectors(imgBuffer) {
  const sharp = require('sharp');
  const sessions = await fv_getSessions();
  const meta = await sharp(imgBuffer).metadata();
  const face = await fv_detectFace(sessions.det, imgBuffer, meta.width, meta.height);
  if (!face) return null;
  const { data, info } = await sharp(imgBuffer)
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const aligned = fv_align(data, info.width, info.height, face.kps);
  return { mbf: await fv_embed(sessions.mbf, aligned), r50: await fv_embed(sessions.r50, aligned) };
}

const FV_IMAGE_FIELDS = ['profileimg', 'profile'];

// Declared directly on exports, exactly like the other triggers in this file.
exports.updateFaceVectors = onDocumentWritten(
  { document: 'profile_data/{profileId}', region: 'asia-south1', memory: '4GiB', timeoutSeconds: 300, concurrency: 1 },
  async (event) => {
    const after = event.data && event.data.after && event.data.after.data();
    if (!after) return;
    const before = (event.data && event.data.before && event.data.before.data()) || {};
    const profileId = event.params.profileId;

    const changed = {};
    for (const f of FV_IMAGE_FIELDS) {
      const url = after[f];
      if (typeof url === 'string' && url.trim() && url !== before[f]) changed[f] = url.trim();
    }
    if (Object.keys(changed).length === 0) return;
    console.log(`updateFaceVectors ${profileId}: ${Object.keys(changed).join(', ')}`);

    const doc = {
      profileid: profileId,
      name: after.name || null,
      models: ['mbf', 'r50'],
      dims: 512,
      source: 'cloud_function',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    let stored = 0;
    for (const [field, url] of Object.entries(changed)) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`image fetch ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        const vecs = await fv_computeVectors(buf);
        if (!vecs) { doc[`${field}_error`] = 'no face detected'; continue; }
        doc[`${field}_url`] = url;
        doc[`${field}_face_detected`] = true;
        doc[`${field}_mbf`] = vecs.mbf;
        doc[`${field}_r50`] = vecs.r50;
        stored++;
      } catch (e) {
        doc[`${field}_error`] = String(e && e.message ? e.message : e);
        console.error(`${profileId}/${field} failed`, e);
      }
    }
    if (stored > 0) {
      await admin.firestore().collection('face_detection').doc(profileId).set(doc, { merge: true });
      console.log(`${profileId}: stored ${stored} field(s)`);
    }
  }
);
