const admin = require("firebase-admin")
const throwParticipantMetaDataException = require("./service").throwParticipantMetaDataException
const { onDocumentWritten } = require("firebase-functions/v2/firestore")
const commonService = require('./service');

async function updateParticipantMetadataTierAccess(profileidArg, triggerPath){
  console.log("Tier update Triggered from", triggerPath)
  console.log("new update");
  const profileid = profileidArg
  let mapProfileData = {}
  let previousTier = []
  await admin.firestore().collection("profile_data").where("profileid","==",profileid).get().then(snap => {
    for (let i = 0; i < snap.docs.length; i++) {
      const element = snap.docs[i].data();
      mapProfileData[element['profileid']] = ![null,undefined].includes(element['user_ref']) ? element['user_ref'].id : null
    }
  })
  let mapTier = {}
  let mapTierMeta = {}
  await admin.firestore().collection("tier").get().then(tierSnap => {
    for (let i = 0; i < tierSnap.docs.length; i++) {
      const element = tierSnap.docs[i].data();
      mapTier[element['id']] = element['tier']
      mapTierMeta[element['id']] = element;
    }
  })
  let profileData = null
  await admin.firestore().collection("participant metadata").doc(profileid).get().then(_pdSnap => {
    profileData = _pdSnap.data()
  })
  let userid = mapProfileData[profileid]
  console.log("userid",userid,profileData['name']);
  //
  if(![null,undefined].includes(userid) && ![null,undefined].includes(profileData)){
    await admin.firestore().collection("user").doc(userid).get().then(async userSnap => {
      console.log("checking user_data exist : ",userSnap.exists);
      if(userSnap.exists){
        previousTier = userSnap.data()['metatier'] || []
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
                var map = {}
                if(Object.prototype.hasOwnProperty.call(getTierByProduct[k]['productaccess'], activeJourney)){
                  console.log(getTierByProduct[k]['productaccess'][activeJourney]);
                  console.log(profileData['consumedproducts']);
                  for (let j = 0; j < getTierByProduct[k]['productaccess'][activeJourney].length; j++) {
                    const productelement = getTierByProduct[k]['productaccess'][activeJourney][j];
                    let filterConsumedProducts = profileData['consumedproducts'].filter(e => e === productelement['productid'])
                    console.log("filterConsumedProducts",filterConsumedProducts);
                    if(filterConsumedProducts.length >= productelement['count']){
                      if(!getTier.includes(getTierByProduct[k]['tierid'])){
                        getTier.push(getTierByProduct[k]['tierid'])
                        console.log(getTierByProduct[k]['tierid']);
                        tierUpdated = true
                      }
                    }
                  }
                }
              }
              if(tierUpdated === false){
                console.log("tier not updated ,  in active journey & consumed products are even available");
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
            console.log("tier",profileData['name'], getTier, convertToTierString);
            await admin.firestore().collection("user").doc(userid).set({
              tier: convertToTierString,
              metatier: getTier
            },{merge:true}).then(async () => {
              admin.firestore().collection("participant metadata").doc(profileid).set({
                tier:getTier
              },{merge:true})
              const newTierAdded = getTier.filter(t => !previousTier.includes(t))
              const removedTier = previousTier.filter(t => !getTier.includes(t));
              if (newTierAdded.length === 0 && removedTier.length === 0) {
                console.log("No Change")
                return;
              } else {
                for (let i = 0; i < newTierAdded.length; i++) {
                  const element = newTierAdded[i];
                  const tiermeta = mapTierMeta[element]
                  if(!tiermeta) continue
                  await commonService.saveNotificationRecord({
                    title: `${tiermeta['tier']} - UNLOCKED`,
                    message: tiermeta['tierUpgrademessage'] || "",
                    subtitle: null,
                    date: admin.firestore.FieldValue.serverTimestamp(),
                    landingpage: null,
                    logged: true,
                    profileid: [profileid],
                    sticky: false,
                    notificationtype: "ahupdate",
                    notificationimage: null,
                    metadata: {}
                  })
                }
                for (let i = 0; i < removedTier.length; i++) {
                  const element = removedTier[i];
                  const tiermeta = mapTierMeta[element]
                  if(!tiermeta) continue
                  await commonService.saveNotificationRecord({
                    title: `${tiermeta['tier']} - LOCKED`,
                    message: tiermeta['tierdowngrademessage'] || "",
                    subtitle: null,
                    date: admin.firestore.FieldValue.serverTimestamp(),
                    landingpage: null,
                    logged: true,
                    profileid: [profileid],
                    sticky: false,
                    notificationtype: "ahupdate",
                    notificationimage: null,
                    metadata: {}
                  })
                } 
              }

            })
          })
        })
      }
    })
  }
}

exports.totalparticipant_tierupdate = onDocumentWritten("/tier access config/{docid}",async (change) => {
  let mapProfileData = {}
  await admin.firestore().collection("profile_data").get().then(snap => {
    for (let i = 0; i < snap.docs.length; i++) {
      const element = snap.docs[i].data();
      mapProfileData[element['profileid']] = ![null,undefined].includes(element['user_ref']) ? element['user_ref'].id : null
    }
  })
  let mapTier = {}
  let mapTierMeta = {}
  await admin.firestore().collection("tier").get().then(tierSnap => {
    for (let i = 0; i < tierSnap.docs.length; i++) {
      const element = tierSnap.docs[i].data();
      mapTier[element['id']] = element['tier']
      mapTierMeta[element['id']] = element;
    }
  })
  let tierAccessConfigData = []
  await admin.firestore().collection("tier access config").get().then(async tierConfigSnap => {
    tierAccessConfigData = tierConfigSnap.docs.map(e => e.data())
  })
  let mapUserData = {}
  await admin.firestore().collection("user").get().then(snap => {
    for (let i = 0; i < snap.docs.length; i++) {
      const element = snap.docs[i].data();
      // previousTier = element['metatier'] || []
      mapUserData[snap.docs[i].id] = element
    }
  })
  let mapBigLvlData = {}
  await admin.firestore().collection("big aggregate level").get().then(async levelAggregateSnap => {
    for (let i = 0; i < levelAggregateSnap.docs.length; i++) {
      const element = levelAggregateSnap.docs[i].data();
      mapBigLvlData[element['profileid']] = mapBigLvlData[element['profileid']] || []
      mapBigLvlData[element['profileid']].push(element)
    }
  })

  admin.firestore().collection("participant metadata").get().then(async snap => {
    console.log("Total length,",snap.docs.length);
    let elementData = snap.docs.map( e => e.data()).filter(element => element["name"] != null && (![null,undefined].includes(element["financialstatus"]) ? !['discontinued','banned','late'].includes(element["financialstatus"]) :true))
    let batch = admin.firestore().batch()
    let n = 0
    for (let i = 0; i < elementData.length; i++){
      const participantdashboardelement = elementData[i];
      // console.log("--------------------------------------------------------------------");
      // console.log(i);
      let profileData = participantdashboardelement
      let profileid = participantdashboardelement['profileid']
      let userid = mapProfileData[profileid]
      // console.log("userid",userid,profileData['name'],profileData['tier']);
      if(![null,undefined].includes(userid)){
        // console.log("checking user_data exist : ",mapUserData.hasOwnProperty(userid));
        if(Object.prototype.hasOwnProperty.call(mapUserData,userid)){
          let previousTier = mapUserData[userid]['metatier'] || [] 
          let configElement = tierAccessConfigData
          let levelAggregateElement = mapBigLvlData['profileid'] ? mapBigLvlData['profileid'] : []
          let tierUpdated = false
          let getTier = []
          //first checkby big level
          if(levelAggregateElement.length != 0){
            let getTierlevel = configElement.filter(e => e['tieraccessby'] === 'biglevel')
            for (let k = 0; k < getTierlevel.length; k++){
              for (let j = 0; j < getTierlevel[k]['biglevel'].length; j++) {
                if(levelAggregateElement.some(e => getTierlevel[k]['biglevel'][j]['atcmodel'] === e['atcmodel'] && getTierlevel[k]['biglevel'][j]['biglevelid'].includes(e['level'].id))){
                  if(!getTier.includes(getTierlevel[k]['tierid'])){
                    getTier.push(getTierlevel[k]['tierid'])
                    tierUpdated = true
                  }
                }
              }
            }
          }else{
            // console.log("profile doesn't has any level");
          }
          //second check by active journey product
          let activeJourney = profileData['activejourney'] ? profileData['activejourney'] : profileData['lastcompletedjourney']
          if(activeJourney && 
            (![null,undefined].includes(profileData['consumedproducts']) ? profileData['consumedproducts'].length != 0 : false)&& 
            tierUpdated === false
          ){
            // console.log("profile has active journey & product consumed");
            let getTierByProduct = configElement.filter(e => e['tieraccessby'] === 'product')
            for (let k = 0; k < getTierByProduct.length; k++) {
              if(Object.prototype.hasOwnProperty.call(getTierByProduct[k]['productaccess'],activeJourney)){
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
              // console.log("tier not updated in active journey & consumed products are even available");
              if(!getTier.includes("2yDtPQVMVqe80S8cB2DR")){
                getTier.push("2yDtPQVMVqe80S8cB2DR")
              }
            }
          }else{
            // console.log("Active journey is null",activeJourney,"Or consumedProducts",profileData['consumedproducts']);
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
          let convertToTierString = getTier.map(e => mapTier[e])
          // console.log("tier",profileData['name'],getTier,convertToTierString);
          batch.set(admin.firestore().collection("user").doc(userid),{
            tier:convertToTierString,
            metatier:getTier
          },{merge:true})
          n++
          batch.set(admin.firestore().collection("participant metadata").doc(profileid),{tier:getTier,},{merge:true})
          n++
          if(n != 0 && n%500 == 0){
            await batch.commit().then(() => {
              console.log("batch size",n/500);
              batch = admin.firestore().batch()
            })
          }
          const newTierAdded = getTier.filter(t => !previousTier.includes(t))
          const removedTier = previousTier.filter(t => !getTier.includes(t))
          if (newTierAdded.length === 0 && removedTier.length === 0) {
            console.log("No Change for", profileid)
          } else {
            for (let i = 0; i < newTierAdded.length; i++) {
              const element = newTierAdded[i];
              const tiermeta = mapTierMeta[element]
              if (!tiermeta) continue
              await commonService.saveNotificationRecord({
                title: `${tiermeta['tier']} - UNLOCKED`,
                message: tiermeta['tierUpgrademessage'] || "",
                subtitle: null,
                date: admin.firestore.FieldValue.serverTimestamp(),
                landingpage: null,
                logged: true,
                profileid: [profileid],
                sticky: false,
                notificationtype: "ahupdate",
                notificationimage: null,
                metadata: {}
              })
            }
            for (let i = 0; i < removedTier.length; i++) {
              const element = removedTier[i];
              const tiermeta = mapTierMeta[element]
              if (!tiermeta) continue
              await commonService.saveNotificationRecord({
                title: `${tiermeta['tier']} - LOCKED`,
                message: tiermeta['tierdowngrademessage'] || "",
                subtitle: null,
                date: admin.firestore.FieldValue.serverTimestamp(),
                landingpage: null,
                logged: true,
                profileid: [profileid],
                sticky: false,
                notificationtype: "ahupdate",
                notificationimage: null,
                metadata: {}
              })
            }
          }
        }
      }
    }
    await batch.commit().then(() => {
      console.log("done",n);
    })
  }).catch(async err => {
    await throwParticipantMetaDataException({
      profileid: null,
      failed: "totalparticipant_tierupdate ",
      triggerdoc: change.data.after.ref.path,
      err: err.toString()
    })
  })
})

module.exports = {
  updateParticipantMetadataTierAccess
}