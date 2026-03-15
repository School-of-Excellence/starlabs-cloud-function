const admin = require("firebase-admin");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const cors = require('cors')({origin:true})

exports.bigLevelProfileReset = onRequest(async(req, res) => {
  // console.log(req.body);
  return cors(req,res,async () => {
      try {
        const profileid = req.body['profileid']
        const atcModel = req.body['atcmodel']
        const biglvlid = req.body['level']
        const fullyreset = req.body['fullyreset']
        console.log(profileid,atcModel,biglvlid,fullyreset, "profileid,atcModel,biglvlid");
        
        let query = admin.firestore().collection("big aggregate level").where("profileid","==",profileid);
        if(fullyreset === false){
          query = query.where('atcmodel',"==",atcModel);
        }
        await query.get().then(async changes => {
          console.log("big aggregate level",changes.docs.length,profileid);
          let batch = admin.firestore().batch()
          for (let i = 0; i < changes.docs.length; i++) {
            const ref = changes.docs[i].ref;
            batch.delete(ref)
          }
          await batch.commit().then(() => {
            console.log("big aggregate level profile are deleted",profileid);
          })
        })

        let queryarchive = admin.firestore().collection("big aggregate level archives").where("profileid","==",profileid);
        if(fullyreset === false){
          queryarchive = queryarchive.where('atcmodel',"==",atcModel);
        }
        await queryarchive.get().then(async changes => {
          console.log("big aggregate level archives",changes.docs.length);
          if(changes.docs.length > 0){
            let batch = admin.firestore().batch()
            for (let i = 0; i < changes.docs.length; i++) {
              const ref = changes.docs[i].ref;
              batch.delete(ref)
            }
            await batch.commit().then(() => {
              console.log("big aggregate level archives profile are deleted",profileid);
            })
          }
        })
        // get bigactivity
        let mapActivity = {}
        await admin.firestore().collection("bigactivity").get().then(snap => {
          for (let i = 0; i < snap.docs.length; i++) {
            const element = snap.docs[i];
            const data = snap.docs[i].data()
            mapActivity[element.id] = data
          }
        })
        //get big level
        let mapbiglevel = {}
        let lastBigLevelSequence = null
        let lastLevelDoc = null
        await admin.firestore().collection('biglevel').orderBy("sequence",'desc').get().then(async res => {
          for (let i = 0; i < res.docs.length; i++) {
            const element = res.docs[i].data();
            if(i === 0){lastBigLevelSequence = element['sequence']}
            if(element['sequence'] === (res.docs.length - 3)){
              lastLevelDoc = element
            }
            mapbiglevel[element['docid']] = element
          }
        })
        //get atcmodel level config
        let  mapconfiguration = {}
        let  mapconfigurationbylevel = {}
        await admin.firestore().collection('atcmodel level config').get().then(async res => {
          for (let j = 0; j < res.docs.length; j++) {
            const element = res.docs[j].data();
            const compoundKey = `${element['primaryactivity'].id}_${element['atcmodel']}`.replace(/ /g,"");
            const levelcompoundKey = `${element['level'].id}_${element['atcmodel']}`.replace(/ /g,"");
            mapconfiguration[compoundKey] = element;
            mapconfigurationbylevel[levelcompoundKey] = element
          }
        })

        if(![null,undefined].includes(biglvlid) && biglvlid.length != 0 && fullyreset === false){
          let id = admin.firestore().collection("big aggregate level").doc().id
          let leveltoatcmodelkey = `${biglvlid}_${atcModel}`.replace(/ /g,"");
          let data = {
            atcmodel : atcModel,
            profileid : profileid,
            id : id,
            level : admin.firestore().collection("biglevel").doc(biglvlid),
            regular : mapconfigurationbylevel[leveltoatcmodelkey]['metrics'],
            lastupdated : new Date()
          }
          await admin.firestore().collection("big aggregate level").doc(id).set(data)
          console.log("big aggregate document created");
        }


        let queueActivityLogQuery =  admin.firestore().collection("queue activity log").where("profileid","==",profileid);
        if(fullyreset === false){
          queueActivityLogQuery = queueActivityLogQuery.where('atcmodel',"==",atcModel);
        }
        await queueActivityLogQuery.orderBy("activitydate","asc").get().then(async snap => {
          console.log("queue activity log documents",snap.docs.length);
          for (let i = 0; i < snap.docs.length; i++) {
            console.log("*****",i,"******")
            const element = snap.docs[i].data();
            await bigLevelAggregate(
              element,
              mapActivity,
              mapbiglevel,
              lastBigLevelSequence,
              lastLevelDoc,
              mapconfiguration,
              mapconfigurationbylevel
            )
          }
        })

        res.json({ success: true, message: 'Reset completed' });
      } catch (error) {
        console.log(error);
        res.json({ success: false, message: 'error on resetting profile' });
      }
  })
})

exports.aggregateBigLevelFromActivityLog = onDocumentCreated("queue activity log/{docid}",async (change) => {
  
  let mapActivity = {}
  await admin.firestore().collection("bigactivity").get().then(snap => {
    for (let i = 0; i < snap.docs.length; i++) {
      const element = snap.docs[i];
      const data = snap.docs[i].data()
      mapActivity[element.id] = data
    }
  })

  // get biglevel documents
  let mapbiglevel = {}
  let lastBigLevelSequence = null
  let lastleveldoc = null
  await admin.firestore().collection('biglevel').orderBy("sequence",'desc').get().then(async res => {
    for (let i = 0; i < res.docs.length; i++) {
      const element = res.docs[i].data();
      if(i === 0){lastBigLevelSequence = element['sequence']}
      if(element['sequence'] === (res.docs.length - 3)){
        lastleveldoc = element
      }
      mapbiglevel[element['docid']] = element
    }
  })

  // get atcmodel configration
  let  mapconfiguration = {}
  let  mapconfigurationbylevel = {}
  await admin.firestore().collection('atcmodel level config').get().then(async res => {
    for (let j = 0; j < res.docs.length; j++) {
      const element = res.docs[j].data();
      const compoundKey = `${element['primaryactivity'].id}_${element['atcmodel']}`.replace(/ /g,"");
      const levelcompoundKey = `${element['level'].id}_${element['atcmodel']}`.replace(/ /g,"");
      mapconfiguration[compoundKey] = element;
      mapconfigurationbylevel[levelcompoundKey] = element
    }
  })

  await bigLevelAggregate(
    change.data.data(),
    mapActivity,
    mapbiglevel,
    lastBigLevelSequence,
    lastleveldoc,
    mapconfiguration,
    mapconfigurationbylevel
  )
 
})


async function bigLevelAggregate(activitylogdoc,mapActivity,mapbiglevel,lastBigLevelSequence,lastleveldoc,mapconfiguration,mapconfigurationbylevel){
  let currentlevelDoc = activitylogdoc;
  let atcmodelDoc = currentlevelDoc['atcmodel']
  let profileid = currentlevelDoc['profileid']
  console.log("atcmodelDoc",atcmodelDoc);
  
  let level
  let docid
  let currentsequence
  let afterData

  let concatLastLevelToAtcmodel = `${lastleveldoc['docid']}_${atcmodelDoc}`.replace(/ /g,"");
  console.log("lastBigLevelSequence",lastBigLevelSequence);
  console.log("fromLastToThirdLevelDoc",lastleveldoc['level']);
  console.log("concatLastLevelToAtcmodel",concatLastLevelToAtcmodel);
  // console.log(currentlevelDoc['activity']);
  console.log("incoming activity",mapActivity[currentlevelDoc['activity']]['activity']);
  
  // get configration for activity
  let activityConfigKey = `${currentlevelDoc['activity']}_${atcmodelDoc}`.replace(/ /g,"")
  // console.log("activityConfigKey",activityConfigKey,mapconfiguration.hasOwnProperty(activityConfigKey));
  let participantatcmodel
  if(Object.prototype.hasOwnProperty.call(mapconfiguration,activityConfigKey)){
    participantatcmodel = mapconfiguration[activityConfigKey]
  }
  if(![null,undefined].includes(participantatcmodel)){
    // console.log("participantatcmodel",participantatcmodel);
    // console.log(participantatcmodel['level'].id, 'levelcheck');
    afterData =  mapbiglevel[participantatcmodel['level'].id]['sequence']
    console.log("incoming activity sequence",afterData);
  }

  // get participant atcmodel aggregate
  await admin.firestore().collection('big aggregate level').where('profileid', '==', profileid).where('atcmodel', '==',  atcmodelDoc).get().then(async snap => {
    let aggregate = null
    if(snap.docs.length != 0){
      console.log("doc exist");
      aggregate = snap.docs[0].data();
      level = aggregate['level']
      docid = aggregate['id']
    }else{
      // big aggregate level doc doesnot exist
      console.log("doc not exist");
      if(![null,undefined].includes(participantatcmodel)){
        //1.check sequence greater than 17 can be added as regular level
        if(afterData >= (lastBigLevelSequence - 2) && afterData <= lastBigLevelSequence){
          console.log("incoming sequence within range of last three sequence");
          aggregate = await createNewDoc(profileid,participantatcmodel,currentlevelDoc,"big aggregate level",currentlevelDoc['queueid'])
          level = aggregate['level']
          docid = aggregate['id']
        }else{//2.if less than 18 then regular level sequence
          console.log("incoming sequence is lesser than last three sequence hence incoming activity mark as fasttrack");
          let findConfig 
          if(Object.prototype.hasOwnProperty.call(mapconfigurationbylevel,concatLastLevelToAtcmodel)){
            findConfig = mapconfigurationbylevel[concatLastLevelToAtcmodel]
          }
          if(![null,undefined].includes(findConfig)){
            console.log("found last level config");
            aggregate = await createNewDoc(profileid,findConfig,currentlevelDoc,"big aggregate level",currentlevelDoc['queueid'])
            level = aggregate['level']
            docid = aggregate['id']
          }
        }
      }else{
        console.log("activity log is not mapped in atc model config");
      }
    }
    console.log("big aggregate level docid",docid);
    console.log("current level",level.id,mapbiglevel[level.id]['level']);
    // get document reference
    const ref = admin.firestore().collection('big aggregate level').doc(docid) 
    const docSnapshot =  await ref.get();
    let regulardoc = docSnapshot.data()['regular'] ? docSnapshot.data()['regular'] : []
    let fasttrackdoc = docSnapshot.data()['fasttrack'] ? docSnapshot.data()['fasttrack'] : []
    let warmupdoc = docSnapshot.data()['warmup'] ?  docSnapshot.data()['warmup'] : []
    let specialactivityDoc = docSnapshot.data()['specialactivity'] ?  docSnapshot.data()['specialactivity'] : []
    let boosteractivityDoc = docSnapshot.data()['boosteractivity'] ?  docSnapshot.data()['boosteractivity'] : []

    // get sequence of level
    currentsequence = mapbiglevel[level.id]['sequence']
    console.log("currentsequence",currentsequence);

    // checking does activity is special 
    if(mapActivity[currentlevelDoc['activity']]['activitytype'] === "special"){
      await handleSpecialActivity('special',specialactivityDoc,currentlevelDoc,profileid,level,ref,null)
    } // check if booster activity
    else if(mapActivity[currentlevelDoc['activity']]['activitytype'] === "booster"){
      await handleSpecialActivity('booster',boosteractivityDoc,currentlevelDoc,profileid,level,ref,null)
    } // check activity in regular or fastract or warmup
    else if(![null,undefined].includes(afterData)){
      // check activity in regular
      let getRegularMetricIndex = regulardoc.findIndex(e => e['activity'].id === currentlevelDoc['activity'])
      let regularlevel
      if(afterData >= currentsequence && getRegularMetricIndex != -1){
        if(regulardoc.length != 0){
          console.log("*** in regualar ****");
          for (let i = 0; i < regulardoc.length; i++) {
            const element = regulardoc[i];
            regularlevel = level
            if(element['activity'].id === currentlevelDoc['activity']){
              element['completed'] = (element['completed'] || 0) + 1
              console.log("incoming activity updated in regular");
            }
          }
          const updatedregularData = { regular: regulardoc };
          await ref.update(updatedregularData);

          // check whether regular level is completed
          if(regulardoc && regulardoc.every(doc => doc['completed'] >= doc['metric']) && currentsequence != 0){
            console.log('** resetting regular... **');
            let sequence = mapbiglevel[regularlevel.id]['sequence']
            let updatelevel
            const getsequence = sequence - 1
            // get regular level for current level
            if(getsequence >= 1){
              for (const key in mapbiglevel) {
                if (Object.hasOwnProperty.call(mapbiglevel, key)) {
                  const element = mapbiglevel[key];
                  if (element['sequence'] === getsequence) {
                    updatelevel = element['docid']
                  }
                }
              }
              console.log(updatelevel , 'updatelevel');
              let configuration
              for (const compoundKey in mapconfiguration) {
                // if (mapconfiguration.hasOwnProperty(compoundKey)){
                  const element = mapconfiguration[compoundKey];
                  if (element['level'].id === updatelevel && element['atcmodel'].replace(/ /g,"") === atcmodelDoc.replace(/ /g,"")) {
                    configuration = element;
                    console.log("update level atc model config found");
                  }
                // }
              }
              // console.log(configuration, 'configration');
              // get ongoing fasttrack
              for (let j = 0; j < fasttrackdoc.length; j++){
                const converttoregular = fasttrackdoc[j];
                const convertlevel =  converttoregular['level']
                if(mapbiglevel[convertlevel.id]['sequence'] >= getsequence) {
                  fasttrackdoc.splice(j, 1)
                  j--;
                  console.log("lower fast tract doc removed");
                }
              }
              let updatelevelregular = configuration['metrics'].map(e => {
                e['completed'] = 0
                return e
              })
              // reset document
              ref.set({
                atcmodel : currentlevelDoc['atcmodel'],
                level : configuration['level'],
                profileid : profileid,
                lastupdated : new Date(),
                id : docid,
                regular : updatelevelregular,
                fasttrack : fasttrackdoc,
                boosteractivity : boosteractivityDoc,
                specialactivity : specialactivityDoc,
                warmup:[]
              },{merge:true})
              let archiveData = docSnapshot.data()
              archiveData['regular'] = regulardoc
              admin.firestore().collection('big aggregate level archives').doc(docid).set(archiveData)
              console.log("archive created");
              // admin.firestore().collection("participant big initial level").doc(profileid).set({
              //   [currentlevelDoc['atcmodel']] : configuration['level']
              // })
            }else{
              console.log("participant at his top most level");
            }
            // console.log(regulardoc, 'regularmetrics');
          }else{
            console.log("every metric hasn't been completed yet");
          }
        }
      }
      // check activity in fasttrack
      else if(afterData < currentsequence){
        console.log("*** in fasttract ***");
        // let levelupcount = docSnapshot.data()['levelupcount'] || 0
        let fasttrackdoc = docSnapshot.data()['fasttrack'] ? docSnapshot.data()['fasttrack'] : []
        let indexlevel = fasttrackdoc.findIndex(e => e.level.id === participantatcmodel['level'].id)
        console.log(indexlevel, 'indexlevel');
        if(indexlevel != -1){
          const element = fasttrackdoc[indexlevel];
          const metrics = element['metrics']
          const stabilizations = element['stabilization']
          const validations = element['validation']
          const getsequence = mapbiglevel[element['level'].id]['sequence']
          if(validations.every(e => e['completed'] < e['metric'])){
            for (let l = 0; l < validations.length; l++) {
              const validation = validations[l];
              if(validation['activity'].id === currentlevelDoc['activity']){
                validation['completed'] = (validation['completed'] || 0) + 1
                // levelupcount = levelupcount+1
                console.log("validation metric updated");
              }
            }
          }else{
            for (let k = 0; k < stabilizations.length; k++) {
              const stabilization = stabilizations[k];
              if(stabilization['activity'].id === currentlevelDoc['activity']){
                stabilization['completed'] = (stabilization['completed'] || 0) + 1
                // levelupcount = levelupcount+1
                console.log("stabilization metric updated");
              }
            }
          }
          const updatedfasttrackData = { 
            fasttrack: fasttrackdoc,
            // levelupcount:levelupcount
          };
          await ref.update(updatedfasttrackData);
          let archiveData = docSnapshot.data()
          archiveData['fasttrack'] = fasttrackdoc.map(e => e)
          // get regular level for current level
          if(element && stabilizations.every(doc => doc['completed'] >= doc['metric']) && validations.every(doc => doc['completed'] >= doc['metric'])){
            let fasttracklevel =  element['level']
            let sequence = mapbiglevel[fasttracklevel.id]['sequence']
            console.log('**** resetting fasttrack ****');
            let updatelevel
            let updatelevelsequence = sequence
            if(updatelevelsequence >= 1){
              for (const key in mapbiglevel) {
                if (Object.hasOwnProperty.call(mapbiglevel, key)) {
                  const element = mapbiglevel[key];
                  if (element['sequence'] === updatelevelsequence) {
                    updatelevel = element['docid']
                  }
                }
              }
              console.log(updatelevel , 'updatelevel');
              let configuration
              for (const compoundKey in mapconfiguration) {
                // if (mapconfiguration.hasOwnProperty(compoundKey)) {
                  const element = mapconfiguration[compoundKey];
                  if (element['level'].id === updatelevel && element['atcmodel'].replace(/ /g,"") === atcmodelDoc.replace(/ /g,"")) {
                    configuration = element;
                    console.log("update level act model config found");
                  }
                // }
              }
              // console.log(configuration, 'configration');
              let updatelevelregular = configuration['metrics'].map(e => {
                e['completed'] = 0
                return e
              })
              // check any lower level is there in fasttrack
              for (let m = 0; m < fasttrackdoc.length; m++) {
                const element = fasttrackdoc[m];
                if(mapbiglevel[element['level'].id]['sequence'] >= updatelevelsequence){
                  fasttrackdoc.splice(m,1)
                  m--
                }
              }
              // reset document
              ref.set({
                atcmodel : currentlevelDoc['atcmodel'],
                level : configuration['level'],
                // levelupcount : levelupcount,
                profileid : profileid,
                lastupdated : new Date(),
                id : docid,
                regular : updatelevelregular,
                fasttrack : fasttrackdoc,
                boosteractivity : boosteractivityDoc,
                specialactivity : specialactivityDoc,
                warmup:[]
              },{merge:true})
              admin.firestore().collection('big aggregate level archives').doc(docid).set(archiveData)
              console.log("archive created from fasttrack");
              // console.log(regulardoc, 'regularmetrics')
              // admin.firestore().collection("participant big initial level").doc(profileid).set({
              //   [currentlevelDoc['atcmodel']] : configuration['level']
              // })
            }else{
              console.log("participant at his top level");
            }
          }else{console.log("fast track every metric not completed yet");}
        }else{
          console.log('no fasttrack');
          const existingData = docSnapshot.exists ? docSnapshot.data() : {};
          const fasttrackArray = existingData.fasttrack || [];
          let stabilizationvalidity
          // let validationvalidity
          let levelupcount = existingData['levelupcount'] || 0
          participantatcmodel['validation'].forEach(validation => {
            validation['completed'] = 0
            // validationvalidity = validation['validity']
            // validation['validationaddeddate'] = new Date()
            // const expirationDate = new Date();
            // expirationDate.setDate(expirationDate.getDate() + validationvalidity);
            // validation['validationexpirydate'] = new Date(expirationDate.getTime());
            if(validation['activity'].id === currentlevelDoc['activity']){
              validation['completed'] += 1
              // levelupcount = levelupcount + 1
            }
          })

          participantatcmodel['stabilization'].forEach(stabilization => {
            stabilization['completed'] = 0
            stabilizationvalidity =  stabilization['validity']
            // stabilization['stabilizationaddeddate'] = new Date()
            // const expirationDate = new Date();
            // expirationDate.setDate(expirationDate.getDate() + stabilizationvalidity);
            // stabilization['stabilizationexpirydate'] = new Date(expirationDate.getTime());
          })

          fasttrackArray.push({
            level : participantatcmodel['level'],
            stabilization : participantatcmodel['stabilization'] || [],
            validation : participantatcmodel['validation'] || [],
            validationaddeddate:new Date(),
            // validationexpirydate : new Date(new Date().setDate(new Date().getDate() + validationvalidity)),
            stabilizationaddeddate : new Date(),
            stabilizationexpirydate : new Date(new Date().setDate(new Date().getDate() + stabilizationvalidity))
          })
          // console.log(fasttrackArray);
          ref.set({
            atcmodel : currentlevelDoc['atcmodel'],
            fasttrack : fasttrackArray,
            id : ref.id,
            profileid : profileid,
            level : level,
            // levelupcount:levelupcount,
            lastupdated : new Date()
          },{merge:true}).catch(err => {
            console.log("new doc set for fasttract",err);
          })
        }
      }// check warmup
      else if(afterData > currentsequence){
        await handleWarmupActivity(profileid,warmupdoc,currentlevelDoc,3,level,null)
      }
    }else{
      console.log("activity log is not mapped in atc model config");
    }
  }).catch(err => {
    console.log("query error",err);
  })
}

const handleSpecialActivity = async(name,activityDoc,currentlevelDoc,profileid,level,ref,queueid) => {
  console.log(`**** ${name} Activity ****`);
  let getActivityIndex = activityDoc.findIndex(e => e['activity'].id === currentlevelDoc['activity'])
  if(getActivityIndex != -1) activityDoc[getActivityIndex]['completed'] = (activityDoc[getActivityIndex]['completed'] || 0) + 1
  else activityDoc.push({ activity : admin.firestore().collection("bigactivity").doc(currentlevelDoc['activity']),completed : 1})
  let doc = {
    atcmodel : currentlevelDoc['atcmodel'],
    profileid : profileid,
    level : level,
    id : ref.id,
    lastupdated : currentlevelDoc['activitydate'] != undefined ? currentlevelDoc['activitydate'].toDate() : new Date()
  }
  if(name === 'special'){doc['specialactivity'] = activityDoc}
  if(name === 'booster'){doc['boosteractivity'] = activityDoc}
  if(![null,undefined].includes(queueid)){doc['queueid'] = queueid}
  await updateDoc(ref,doc);
  console.log("handleSpecialActivity document updated",queueid)
}

const handleWarmupActivity = async(profileid,warmupdoc,currentlevelDoc,ref,level,queueid) => {
  console.log("*** warm up ***",warmupdoc);
  let getIndex = warmupdoc.findIndex(e => e['activity'].id === currentlevelDoc['activity'])
  if(getIndex != -1) warmupdoc[getIndex]['completed'] = (warmupdoc[getIndex]['completed'] || 0) + 1
  else warmupdoc.push({activity:admin.firestore().collection("bigactivity").doc(currentlevelDoc['activity']),completed:1})
  let doc = {
    atcmodel : currentlevelDoc['atcmodel'],
    warmup : warmupdoc,
    profileid : profileid,
    level : level,
    id : ref.id,
    lastupdated : currentlevelDoc['activitydate'] != undefined ? currentlevelDoc['activitydate'].toDate() : new Date()
  }
  if(![null,undefined].includes(queueid)){doc['queueid'] = queueid}
  await updateDoc(ref,doc);
  console.log("handleWarmupActivity document updated",queueid);
}

const createNewDoc = async (profileid, participantatcmodel,currentlevelDoc,collectionName,queueid) => {
  console.log("---- new aggregate level doc created ---- ");
  let id = admin.firestore().collection(collectionName).doc().id;
  let doc = {
    atcmodel: participantatcmodel.atcmodel,
    profileid: profileid,
    level: participantatcmodel.level,
    regular:  participantatcmodel['metrics'],
    id: id,
    lastupdated:currentlevelDoc['activitydate'] != undefined ? currentlevelDoc['activitydate'].toDate() : new Date()
  }
  if(![null,undefined].includes(queueid)){doc['queueid'] = queueid}
  await updateDoc(admin.firestore().collection(collectionName).doc(id),doc);
  console.log("createNewDoc document created",queueid,"docid",id);
  return doc
};

const updateDoc = async (ref, data, merge = true) => {
  await ref.set(data, { merge }).catch(err => console.log("Error updating document:", err));
};