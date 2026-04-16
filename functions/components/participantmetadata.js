
const admin = require("firebase-admin");
const {onDocumentCreated,onDocumentWritten} = require("firebase-functions/v2/firestore");
const https = require("https")
const commonService = require('./service');
const { onSchedule } = require("firebase-functions/scheduler");
const axios = require("axios");

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

    const activeJourneyList = journeyProductProfile.filter(e => ["initiated", "ongoing", "completed"].includes(e["journeystatus"]) && ![null, undefined, ''].includes(e['journeyref']));
    const nullJourneyList = journeyProductProfile.filter(e => [null].includes(e["journeystatus"]) && ![null, undefined, ''].includes(e['journeyref']));
    const cancelledJourneyList = journeyProductProfile.filter(e => ["cancelled"].includes(e["journeystatus"]) && ![null, undefined, ''].includes(e['journeyref']));

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
    };

    let ongoingJourney = [];
    let completedjourney = [];
    const cancelledJourney = [...cancelledJourneyList];

    if (['banned', 'late'].includes(participantdashboardData['customerstatus'])) {
      newData.customerstatus = participantdashboardData['customerstatus'];
    } else if (activeJourneyList.length != 0) {
      activeJourneyList.forEach(journeyElement => {
        if (["initiated", "ongoing"].includes(journeyElement["journeystatus"])) {
          ongoingJourney.push(journeyElement);
        } else if (journeyElement["journeystatus"] == "completed") {
          completedjourney.push(journeyElement);
        }
      });

      if (ongoingJourney.length != 0) {
        ongoingJourney = ongoingJourney.sort((a, b) => b["subscriptionend"]?.toDate() - a["subscriptionend"]?.toDate());
        const currentDate = new Date();
        const currentOngoing = ongoingJourney.find(e => e["journeystatus"] == "ongoing");
        const currentInitiated = ongoingJourney.find(e => e["journeystatus"] == "initiated");

        const liveJourney = currentOngoing ?? currentInitiated ?? ongoingJourney[0];
        const hasSubscription = liveJourney["subscriptionend"] && liveJourney["subscriptionend"].toDate() >= currentDate;

        if (liveJourney && hasSubscription) {
          if (ongoingJourney.length == 1 && cancelledJourney.length == 0 && completedjourney.length == 0) {
            newData.customerstatus = "active";
            newData.activejourney = liveJourney["journeyref"]?.id ?? null;
            newData.purchasedate = liveJourney["purchasedate"]?.toDate() ?? null;
            newData.subscriptionstart = liveJourney["subscriptionstart"]?.toDate() ?? null;
            newData.subscriptionend = liveJourney["subscriptionend"]?.toDate() ?? null;
          } else {
            newData.customerstatus = "none";
            newData['participantmode'] = null;
          }
        } else if (liveJourney && !hasSubscription) {
          newData.customerstatus = "none";
          newData['participantmode'] = null;
        }
      } else if (completedjourney.length == 1 && ongoingJourney.length == 0 && cancelledJourney.length == 0) {
        newData.customerstatus = "non active";
        newData['participantmode'] = 'Exploration Mode';
        newData['lastcompletedjourney'] = completedjourney[0]["journeyref"]?.id ?? null;
        newData['lastsubscriptionstart'] = completedjourney[0]["subscriptionstart"]?.toDate() ?? null;
        newData['lastsubscriptionend'] = completedjourney[0]["subscriptionend"]?.toDate() ?? null;
      } else {
        newData.customerstatus = "none";
        newData['participantmode'] = null;
      }
    } else if (cancelledJourney.length == 1 && ongoingJourney.length == 0 && completedjourney.length == 0 && nullJourneyList.length == 0) {
      newData.customerstatus = "discontinued";
      newData['participantmode'] = null;
      newData['lastsubscribedjourney'] = cancelledJourney[0]["journeyref"]?.id ?? null;
      newData['lastsubscriptionstart'] = cancelledJourney[0]["subscriptionstart"]?.toDate() ?? null;
      newData['lastsubscriptionend'] = cancelledJourney[0]["subscriptionend"]?.toDate() ?? null;
    } else {
      newData.customerstatus = "none";
      newData['participantmode'] = null;
    }

    try {
      await admin.firestore().collection("participant metadata").doc(profileid).set(newData, { merge: true });
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
  let profileid = newdoc['profileid']
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
  if(oldProductStatus != newProductStatus || olddoc["packageref"] != newdoc["packageref"]){
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

              const response = await axios.post(webhookUrl, payload);
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
  let profileid = ![null,undefined].includes(newdoc) ? newdoc['profileid'] : olddoc['profileid']
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

exports.atcdata_to_pmd = onDocumentWritten("atc_apha/{docid}",async (change) => {
  const olddoc = change.data.before.data()
  const newdoc = change.data.after.data()
  let profileId = newdoc['profileid'] ? newdoc['profileid'] : null
  if(!olddoc && newdoc || olddoc && newdoc){
    if(profileId != null){
      console.log("profileid",profileId);
      admin.firestore().collection('atc_alpha').where('type','==','online').where('isdelete','==',false).where('profileid','==',profileId).get().then(async atcsnap => {
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