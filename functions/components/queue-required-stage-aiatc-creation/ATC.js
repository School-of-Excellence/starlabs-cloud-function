// Firestore
const { getFirestore } = require("firebase-admin/firestore");
const adminDefault = getFirestore();
const adminATC = getFirestore("firestore-atc");

const firestoreField = require("firebase-admin/firestore").FieldValue;

const { onDocumentWritten, onDocumentUpdated } = require("firebase-functions/v2/firestore")
//components imports
const commonService = require('../service');
const { alertAtc } = require('./atc_alerts');
//slack
var IncomingWebhook = require('@slack/client').IncomingWebhook;

exports.procedureOnWrite = onDocumentWritten({document: "/atc_alpha/{atc_id}/corrections/{adjustmentid}/procedures/{procedureid}", database: "firestore-atc"}, async (data)=>{
  var atcBatch = adminATC.batch()
  var before = data.data.before
  var after = data.data.after
  var changeagent = []
  var participantId = null
  if(before.exists){
    if(before.data()["assigned_to"] != null && before.data()["assigned_to"] != undefined){
      changeagent = changeagent.concat(before.data()["assigned_to"].map(e => e.id))
    }
  }
  if(after.exists){
    if(after.data()["assigned_to"] != null && after.data()["assigned_to"] != undefined){
      changeagent = changeagent.concat(after.data()["assigned_to"].map(e => e.id))
    }
  }

  var atcid = data.params.atc_id
  var implementationagent = []
  var lastactivities = []
  var atcmodel = null
  var queueid = null
  // Procedure
  var totalprocedure = 0
  var totalprocedurepending = 0
  var totalprocedurecompleted = 0
  var totalmandatoryprocedure = 0
  var totalmandatoryprocedurepending = 0
  var totalmandatoryprocedurecompleted = 0
  var totalassignedprocedure = 0
  var totalautogeneralized = 0

  var procedurependinglist = []
  var procedurecompletedlist = []
  // Adjustment
  var totaladjustment = 0
  var totaladjustmentpending = 0
  var totaladjustmentcompleted = 0
  var totalmandatoryadjustment = 0
  var totalmandatoryadjustmentpending = 0
  var totalmandatoryadjustmentcompleted = 0

  // Implementation Agent Meta Data
  var implementationagentcount = {}
  var procedureLog = []

  //implementationDoneBy
  var totalImplementationdoneby = []
  var specialistinvolved = []
  var procedureCompletionCountBySpecialist = {}
  await adminATC.collection("atc_alpha").doc(atcid).get().then(async atc=>{
    var atcData = atc.data()
    participantId = atcData['profileid']
    atcmodel = atcData["product"]
    queueid = atcData["queueid"] != null && atcData["queueid"] != undefined ? atcData["queueid"] : null
    await atc.ref.collection("corrections").where("isdelete","==",false).get().then(async adjustmentDoc=>{
      totaladjustment += adjustmentDoc.docs.length
      for (let i = 0; i < adjustmentDoc.docs.length; i++) {
        const adjustment = adjustmentDoc.docs[i];
        var adjAgent = []
        var implementationdoneby = []
        await adjustment.ref.collection("procedures").where("isdelete","==",false).get().then(async procedureDoc=>{
          var procedureData = procedureDoc.docs.map(e => e.data())
          totalprocedure += procedureData.length
          for (let j = 0; j < procedureData.length; j++) {
            const procedure = procedureData[j];
            // console.log("procedure[last_activity]",procedure["last_activity"]);
            if(procedure["last_activity"] != null && procedure["last_activity"] != undefined){
              // console.log("typeof",typeof(procedure["last_activity"]));
              if(typeof(procedure["last_activity"]) != "string"){
                lastactivities.push(procedure["last_activity"].toDate())
              }else{
                lastactivities.push(new Date(procedure["last_activity"]))
              }
            }
            if(procedure["assigned_to"] != null && procedure["assigned_to"] != undefined){
              totalassignedprocedure += 1
              adjAgent = adjAgent.concat(procedure["assigned_to"].map(e => e.id))
              implementationagent = implementationagent.concat(adjAgent)
              procedure["assigned_to"].forEach(e =>{
                procedure["agent"] = e.id
                procedureLog.push(procedure)
              })
            }
            if(procedure["status"] == "completed"){
              totalprocedurecompleted += 1
              implementationdoneby = implementationdoneby.concat(![null,undefined].includes(procedure["assigned_to"]) ? procedure["assigned_to"].map(e => e.id) : [])
              totalImplementationdoneby = totalImplementationdoneby.concat(![null,undefined].includes(procedure["assigned_to"]) ? procedure["assigned_to"].map(e => e.id) : [])

              if(![null,undefined].includes(procedure['name']) && ![null,undefined].includes(procedure['name'].id)){
                procedurecompletedlist.push(procedure['name'].id)
                if(![null,undefined].includes(procedure["assigned_to"])){
                  for (const e of procedure["assigned_to"]) {
                    procedureCompletionCountBySpecialist[e.id] = procedureCompletionCountBySpecialist[e.id] || {}
                    procedureCompletionCountBySpecialist[e.id][procedure['name'].id] = (procedureCompletionCountBySpecialist[e.id][procedure['name'].id] || 0) + 1
                  }
                }
              }
            }
            else{
              totalprocedurepending += 1

              if(![null,undefined].includes(procedure['name'])){
                procedurependinglist.push(procedure['name'].id)
              }
            }
            if(procedure["mandatory"]){
              totalmandatoryprocedure += 1
              if(procedure["status"] == "completed"){
                totalmandatoryprocedurecompleted += 1
              }
              else{
                totalmandatoryprocedurepending += 1
              }
            }
            if(procedure["autogeneralized"] == true){
              totalautogeneralized += 1
            }
          }
          totaladjustmentcompleted += (procedureData.length == procedureData.filter(e => (e["status"] == "completed" || e["autogeneralized"] == true)).length) ? 1 : 0;
          totalmandatoryadjustment += (procedureData.filter(e => e["mandatory"]).length != 0) ? 1 : 0;
          totalmandatoryadjustmentcompleted += (procedureData.filter(e => e["mandatory"]).length != 0 && procedureData.filter(e => e["mandatory"]).length == procedureData.filter(e => e["mandatory"] && (e["status"] == "completed" || e["autogeneralized"] == true)).length) ? 1 : 0;
          // await adjustment.ref.update({
          //   implementationagent: Array.from(new Set(adjAgent))
          // });
          atcBatch.update(adjustment.ref, {
            implementationagent: Array.from(new Set(adjAgent)),
            implementationdoneby:Array.from(new Set(implementationdoneby))
          })
        })
      }
    })
    totaladjustmentpending = totaladjustment - totaladjustmentcompleted
    totalmandatoryadjustmentpending = totalmandatoryadjustment - totalmandatoryadjustmentcompleted
    lastactivities.sort((a,b) => b-a)
    specialistinvolved = specialistinvolved.concat(
      atcData["author"] ? atcData["author"].map(e => e.id) : [],
      atcData["mentor"] ? atcData["mentor"] : []
    )
    atcBatch.update(atc.ref, {
      specialistinvolved:Array.from(new Set(specialistinvolved)),
      lastactivity: lastactivities.length != 0 ? lastactivities[0] : null,
      implementationagent: Array.from(new Set(implementationagent)),
      implementationdoneby:Array.from(new Set(totalImplementationdoneby)),
      totalassignedprocedure: totalassignedprocedure,
      totalprocedure: totalprocedure,
      totalprocedurepending: totalprocedurepending,
      totalprocedurecompleted: totalprocedurecompleted,
      totalmandatoryprocedure: totalmandatoryprocedure,
      totalmandatoryprocedurepending: totalmandatoryprocedurepending,
      totalmandatoryprocedurecompleted: totalmandatoryprocedurecompleted,
      totaladjustment: totaladjustment,
      totaladjustmentpending: totaladjustmentpending,
      totaladjustmentcompleted: totaladjustmentcompleted,
      totalmandatoryadjustment: totalmandatoryadjustment,
      totalmandatoryadjustmentpending: totalmandatoryadjustmentpending,
      totalmandatoryadjustmentcompleted: totalmandatoryadjustmentcompleted,
      procedurependinglist : procedurependinglist,
      procedurecompletedlist : procedurecompletedlist,
      implspecialistproceduremap : procedureCompletionCountBySpecialist
    })
    await atcBatch.commit()
    // await aggregateClientATC(atc.data()["profileid"])
    for (let i = 0; i < changeagent.length; i++) {
      const element = changeagent[i];
      // await aggregateSpecialistATC(element)
    }
  })
  
  // Activity Log
  var beforeData = before.exists ? before.data() : {}
  var afterData = after.exists ? after.data() : {}
  var exisitingActivity = []
  var newActivity = []
  console.log("procedure status", beforeData["status"], afterData["status"])
  if(beforeData["status"] != "completed" && afterData["status"] == "completed"){
    var sourceref = after.ref
    await adminDefault.collection("activitylog").where("sourceref", "==", sourceref).get().then(activity=>{
      activity.docs.forEach(doc=>{
        var data = doc.data()
        exisitingActivity.push(data)
      })
    })
    console.log("Exisiting Acitivity", exisitingActivity.length)
    if(afterData["bigactivity"] != null && afterData["bigactivity"] != undefined){
      var activityList = Object.keys(afterData["bigactivity"])
      if(activityList.length != 0){
        for (let i = 0; i < activityList.length; i++) {
          const activity = activityList[i];
          var participantList = afterData["bigactivity"][activity]
          participantList.forEach(profileid=>{
            var docid = adminDefault.collection("activitylog").doc().id
            newActivity.push({
              created: firestoreField.serverTimestamp(),
              activity: activity,
              activitydate: afterData["last_activity"] != null && afterData["last_activity"] != undefined ? afterData["last_activity"].toDate() : null,
              atcmodel: atcmodel,
              docid: docid,
              profileid: profileid,
              queueid: queueid,
              source: "atc procedure",
              sourceref: after.ref,
              participantid: participantId
            })
          })
        }
      }
    }
    console.log("New Acitivity", newActivity.length)
    var batch = adminDefault.batch()
    for (let i = 0; i < newActivity.length; i++) {
      const log = newActivity[i];
      if(exisitingActivity.filter(e => e["profileid"] == log["profileid"] && e["activity"] == log["activity"]).length == 0){
        batch.set(adminDefault.collection("activitylog").doc(log["docid"]), log)
      }
    }
    for (let i = 0; i < exisitingActivity.length; i++) {
      const log = exisitingActivity[i];
      if(newActivity.filter(e => e["profileid"] == log["profileid"] && e["activity"] == log["activity"]).length == 0){
        batch.delete(adminDefault.collection("activitylog").doc(log["docid"]))
      }
    }
    if(newActivity.length != 0 || exisitingActivity.length != 0){
      await batch.commit().then(result=>{
        console.log("Batch updated", result.length)
      }).catch(err =>{
        console.log(err)
      })
    }
  }
})

// Move Validated ATC to Alpha
exports.validateATCtoAlpha = onDocumentUpdated({document: "atc_to_validate/{id}", database: "firestore-atc"}, async (snap) => {
  var change = snap.data
  var beforeData = change.before.data()
  var afterData = change.after.data()
  if(beforeData["status"] != "validated" && afterData["status"] == "validated"){
    afterData["atcid"] = change.after.id
    // afterData["prescription_date"] = afterData["prescription_date"] != null ? afterData["prescription_date"].toDate() : null
    // afterData["visibilityexpiry"] = afterData["visibilityexpiry"] != null ? afterData["visibilityexpiry"].toDate() : null
    await adminATC.collection("atc_alpha").doc(afterData["atcid"]).set(afterData)
    await change.after.ref.collection("corrections").get().then(async adjlist=>{
      for (let i = 0; i < adjlist.docs.length; i++) {
        const adj = adjlist.docs[i];
        await adminATC.collection("atc_alpha").doc(afterData["atcid"]).collection("corrections").doc(adj.id).set(adj.data())
        adj.ref.collection("procedures").get().then(async procedurelist =>{
          for (let j = 0; j < procedurelist.docs.length; j++) {
            const pro = procedurelist.docs[j];
            await adminATC.collection("atc_alpha").doc(afterData["atcid"]).collection("corrections").doc(adj.id).collection("procedures").doc(pro.id).set(pro.data())
          }
        })
      }
    })
    if(afterData['directiveassignmentref'] != null || afterData['directiveassignmentref'] != undefined){
      await adminDefault.doc(afterData['directiveassignmentref'].path).update({
        status: "validated"
      })
    }
  }
})

exports.updateAuthorUIDInAtcAlpha = onDocumentWritten({document: "atc_alpha/{atcalphaid}", database: "firestore-atc"} ,async (snapshot) => {

  let oldData = snapshot.data.before.exists ? snapshot.data.before.data() : {}
  let newData = snapshot.data.after.data()

  let oldAuthorIds = oldData ? oldData['author'] ? oldData['author'].map(e => e.id) : [] : []
  let newAuthorIds = newData['author'] ? newData['author'].map(e => e.id) : []

  if (JSON.stringify(oldAuthorIds) === JSON.stringify(newAuthorIds)) {
    return null;
  }

  if(JSON.stringify(oldAuthorIds) != JSON.stringify(newAuthorIds)){
    let authorUid = []
    for (let i = 0; i < newData['author'].length; i++) {
      const profileid = newData['author'][i].id;
      await adminDefault.collection("profile_data").doc(profileid).get().then(snap => {
        if(snap.exists){
          if(snap.data()['user_ref']) authorUid.push(snap.data()['user_ref'].id)
        }
      })
    }
    await snapshot.data.after.ref.update({
      authoruid:authorUid
    })
    console.log("authoruid",authorUid);
  }
  //
  console.log("newData['evolutionprogressdate'] undefined",newData['evolutionprogressdate'] === undefined);
  console.log("oldData['evolutionprogressdate'] undefined",oldData['evolutionprogressdate'] === undefined);
  
  /*
  if(![null,undefined].includes(newData['evolutionprogressdate'])){
    console.log("old",oldData['evolutionprogressdate'] != undefined ? new Date(oldData['evolutionprogressdate'].toDate()).toISOString() : null,"new",new Date(newData['evolutionprogressdate'].toDate()).toISOString());
    if(![null,undefined].includes(oldData['evolutionprogressdate']) ? new Date(oldData['evolutionprogressdate'].toDate()).toISOString() != new Date(newData['evolutionprogressdate'].toDate()).toISOString() : true){
      console.log("started atc query");
      let mapData = {}
      let mapAelAtc = {}
      let totalevolutionyearwasted = 0
      let totalevolutionyearsaved = 0
      let totalevolutionprogress = {}
      // let specialistExtendedLifeImpact = {}
      let totaladjustmentaware = 0
      let totaladjustmentunaware = 0
      let batch = admin.firestore().batch()
      await admin.firestore().collection("atc_alpha").where("profileid","==",newData['profileid']).where("product","in",["Expanding Horizon","B!G","CPM","LYL","uP!","A&H ATC"]).get().then(async atcSnap => {
        console.log(atcSnap.docs.length);
        for (let i = 0; i < atcSnap.docs.length; i++) {
          console.log("atc",i);
          const alphaelement = atcSnap.docs[i].data();
          if(alphaelement['isdelete'] != true && [null,'validated',undefined].includes(alphaelement['status'])){
            mapData[alphaelement['atcid']] = {}
            let evolutionprogress = {}
            let evolutionyearwasted = 0
            let evolutionyearsaved = 0
            let extendedlifeimpact = {}
            let adjustmentaware = 0
            let adjustmentunaware = 0
            let specialistInvolved = Array.from(new Set([...(alphaelement['author'] || []).map(e => e.id),...(alphaelement['mentor'] || []),...(alphaelement['validator'] || []).map(e =>e.id)]))
            await atcSnap.docs[i].ref.collection("corrections").where("isdelete","==",false).get().then(async correctionSnap => {
              for (let j = 0; j < correctionSnap.docs.length; j++) {
                const adjustmentelement = correctionSnap.docs[j].data();
                //getting adjustment awareness count
                if(![null,undefined].includes(adjustmentelement['awareness'])){
                  if(adjustmentelement['awareness']) adjustmentaware = adjustmentaware + 1
                  else adjustmentunaware = adjustmentunaware + 1
                }else adjustmentunaware = adjustmentunaware + 1
                //
                var implementationdoneby = []
                await correctionSnap.docs[j].ref.collection("procedures").get().then(async procedureDoc => {
                  for (let k = 0; k < procedureDoc.docs.length; k++) {
                  //  console.log("procedure",k);
                    const procedureData = procedureDoc.docs[k].data()
                    if(![null,undefined].includes(procedureData['assigned_to'])){
                      if(procedureData['status'] === 'completed'){
                        implementationdoneby = implementationdoneby.concat(procedureData['assigned_to'].map(e => e.id))
                      }
                    }
                  } 
                })
                adjustmentelement["implementationdoneby"] = Array.from(new Set(implementationdoneby))
                //
                evolutionyearsaved = Math.round(evolutionyearsaved + (![null,undefined].includes(adjustmentelement['savedyears'])  ? (typeof(adjustmentelement['savedyears']) === "string" ? parseFloat(adjustmentelement['savedyears']) : adjustmentelement['savedyears']) : 0))
                evolutionyearwasted = Math.round(evolutionyearwasted + (![null,undefined].includes(adjustmentelement['potentialyears']) ? (typeof(adjustmentelement['potentialyears']) === "string" ? parseFloat(adjustmentelement['potentialyears']) : adjustmentelement['potentialyears']) : 0))
                if(adjustmentelement['implementationdoneby'] != undefined){
                  adjustmentelement['implementationdoneby'].forEach(e => {
                    if(!specialistInvolved.includes(e)){
                      extendedlifeimpact[e] = (extendedlifeimpact[e] || 0) + Math.round(![null,undefined].includes(adjustmentelement['savedyears'])  ? (typeof(adjustmentelement['savedyears']) === "string" ? parseFloat(adjustmentelement['savedyears']) : adjustmentelement['savedyears']) : 0)
                    }
                  })
                }
                //
                if(![null,undefined].includes(adjustmentelement['totalhoursaved'])){
                  if(adjustmentelement['totalhoursaved']['sliderValue'] != undefined && adjustmentelement['totalhoursaved']['sliderValue'] != null) evolutionprogress[adjustmentelement['totalhoursaved']['sliderValue']] = (evolutionprogress[adjustmentelement['totalhoursaved']['sliderValue']] || 0) + 1
                  else evolutionprogress['not updated'] = (evolutionprogress['not updated'] || 0) + 1
                }else{
                  evolutionprogress['not updated'] = (evolutionprogress['not updated'] || 0) + 1
                }
    
              }
            })
    
            specialistInvolved.forEach(e => {
              extendedlifeimpact[e] =  evolutionyearsaved
            })
            if(![null,undefined].includes(alphaelement['aelid'])){
              mapAelAtc[alphaelement['aelid']] = mapAelAtc[alphaelement['aelid']] || {}
              mapAelAtc[alphaelement['aelid']]['evolutionyearwasted'] = (mapAelAtc[alphaelement['aelid']]['evolutionyearwasted'] || 0) + evolutionyearwasted
              mapAelAtc[alphaelement['aelid']]['evolutionyearsaved'] = (mapAelAtc[alphaelement['aelid']]['evolutionyearsaved'] || 0) + evolutionyearsaved
              mapAelAtc[alphaelement['aelid']]['totaladjustmentaware'] = (mapAelAtc[alphaelement['aelid']]['totaladjustmentaware'] || 0) + adjustmentaware
              mapAelAtc[alphaelement['aelid']]['totaladjustmentunaware'] = (mapAelAtc[alphaelement['aelid']]['totaladjustmentunaware'] || 0) + adjustmentunaware
            }
            mapData[alphaelement['atcid']]['totaladjustmentaware'] = adjustmentaware
            mapData[alphaelement['atcid']]['totaladjustmentunaware'] = adjustmentunaware
            mapData[alphaelement['atcid']]['evolutionyearwasted'] = evolutionyearwasted
            mapData[alphaelement['atcid']]['evolutionyearsaved'] = evolutionyearsaved
            mapData[alphaelement['atcid']]['extendedlifeimpact'] = extendedlifeimpact
            mapData[alphaelement['atcid']]['specialistinvolved'] = Object.keys(extendedlifeimpact)
            mapData[alphaelement['atcid']]['evolutionprogress'] = evolutionprogress
            totalevolutionyearwasted = totalevolutionyearwasted + evolutionyearwasted
            totalevolutionyearsaved = totalevolutionyearsaved + evolutionyearsaved
            totaladjustmentaware = totaladjustmentaware + adjustmentaware
            totaladjustmentunaware = totaladjustmentunaware + adjustmentunaware
    
            Object.entries(evolutionprogress).forEach(([name,count]) => {
              totalevolutionprogress[name] =  (totalevolutionprogress[name] || 0) + count
            })
    
            // await atcSnap.docs[i].ref.update(mapData[alphaelement['atcid']])
            batch.update(atcSnap.docs[i].ref,mapData[alphaelement['atcid']])
    
            // console.log("atc",alphaelement['atcid'],"done",mapData[alphaelement['atcid']]);
            for (const key in extendedlifeimpact){
              // console.log("participant ely",key,extendedlifeimpact[key]);
              batch.set(admin.firestore().collection("participants ely").doc(key),{
                [alphaelement['atcid']] : extendedlifeimpact[key]
              },{merge:true})
            }
          }
        }
        await batch.commit()
      })

      console.log("update in ael doc");
      for (const aelid in mapAelAtc) {
        await admin.firestore().collection("participant AEL").doc(aelid).update(mapAelAtc[aelid]).catch(err => {
          console.log("err on update ael doc",aelid);
        })
      }

      // console.log("update in particpant dashboard");
      // await admin.firestore().collection("participantdashboard").doc(newData['profileid']).update({
      //   evolutionyearwasted : totalevolutionyearwasted,
      //   evolutionyearsaved : totalevolutionyearsaved,
      //   evolutionprogress:totalevolutionprogress,
      //   totaladjustmentaware : totaladjustmentaware,
      //   totaladjustmentunaware : totaladjustmentunaware
      // })

      //participant metadata
      console.log("update in particpant metadata");
      let profileDocRef = admin.firestore().collection("participant metadata").doc(newData['profileid'])
      if((await profileDocRef.get()).exists){
        await admin.firestore().collection("participant metadata").doc(newData['profileid']).update({
          evolutionyearwasted : totalevolutionyearwasted,
          evolutionyearsaved : totalevolutionyearsaved,
          evolutionprogress:totalevolutionprogress,
          totaladjustmentaware : totaladjustmentaware,
          totaladjustmentunaware : totaladjustmentunaware
        })
      }
      //slack evolution progress update
      console.log(" slack update totalevolutionprogress",totalevolutionprogress);
      let url = null
      if(commonService.production === true){
        url = await commonService.getWebhookUrl("slackEvolutionProgress") //production
      }else{
        url = await commonService.getWebhookUrl("slackDevTest") //test
      }
      if(url != null){
        await admin.firestore().collection("profile_data").doc(newData['profileid']).get().then(snap => {
          if(snap.exists){
            let message = {
              "blocks": [
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": `*${snap.data()['name']}*`
                  }
                },
                {
                  "type": "rich_text",
                  "elements": [
                    
                  ]
                }
              ]
            }
            for (const key in totalevolutionprogress) {
              message.blocks[1].elements.push({
                  "type": "rich_text_section",
                  "elements": [
                    {
                      "type": "text",
                      "text": `${key} : ${totalevolutionprogress[key]}`
                    }
                  ]
                })
            }
            var webhook = new IncomingWebhook(url);
            webhook.send(message,function(err, header, statusCode, body) {
              if (err) {
                console.log('Error:', err);
              } else {
                console.log('Received', statusCode, 'from Slack');
              }
            });
          }else console.log("profile not found");
        })
      }else{
        console.log("url not defined");
      }
    }
  }
  */
})
