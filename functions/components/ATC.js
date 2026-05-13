// Firestore
const { getFirestore } = require("firebase-admin/firestore");
const adminDefault = getFirestore();
const adminATC = getFirestore("firestore-atc");

const firestoreField = require("firebase-admin/firestore").FieldValue;

const path = require('path');
const fs = require('fs');
const { onDocumentWritten, onDocumentUpdated } = require("firebase-functions/v2/firestore")
//components imports
const commonService = require('./service');
//slack
var IncomingWebhook = require('@slack/client').IncomingWebhook;
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");

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
        url = commonService.slackEvolutionProgress //production
      }else{
        url = commonService.slackDevTest //test
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

const RUBRICS_PROMPT_DOCID = "rubrics_prompt";
const RUBRICS_TYPE = "rubrics scoring";
const ALLOWED_PRODUCTS = ["uP!", "LYL", "B!G", "CPM"];
const ALLOWED_STATUS = ["validated", null, undefined];
const RUN_JOBREQUEST_URL = "https://us-central1-ai-project-4e149.cloudfunctions.net/run_jobrequest";
const functionsApiKey = defineSecret("FUNCTIONS_SHARED_SECRET");
const ANALYSIS_PROMPT_PATH = path.join(__dirname, "..", "prompts", "prompt_3_analysis.md");
const ANALYSIS_PROMPT = fs.readFileSync(ANALYSIS_PROMPT_PATH, "utf8");

// ---------- Cloud Function: triggered on create of atc_alpha ----------
exports.onAtcAlphaCreate = onDocumentCreated(
  { document: "atc_alpha/{atcid}", secrets: [functionsApiKey], database: "firestore-atc" },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    await processAtcAlphaDoc(snap.ref, snap.data());
  }
);

// ---------- Shared processor ----------
async function processAtcAlphaDoc(atcRef, atc) {
  const queueid = atc.queueid;
  const stagename = atc.stagename;
  if (!queueid || !stagename) {
    return console.log(`atc_alpha/${atcRef.id} missing queueid or stagename`);
  }

  // 1. Resolve queue generation doc + atcrequiredstages entry
  let queueSnap = null;
  queueSnap = await adminDefault.collection("queue generation").doc(queueid).get();
  if (!queueSnap.exists) return console.log(`queue generation/${queueid} not found`);
  const queueData = queueSnap.data();

  const atcrequiredstages = queueData.atcrequiredstages || [];
  const stageCfg = atcrequiredstages.find(
    (s) => s && s.stage === stagename && s.generateatc === true
  );
  if (!stageCfg) {
    return console.log(`stage ${stagename} not configured with generateatc=true`);
  }

  // 2. Filter the atc doc itself.
  if (atc.isdelete === true) return console.log(`atc ${atcRef.id} is deleted`);
  if (!ALLOWED_STATUS.includes(atc.status)) {
    return console.log(`atc ${atcRef.id} status ${atc.status} not allowed`);
  }
  if (!ALLOWED_PRODUCTS.includes(atc.product)) {
    return console.log(`atc ${atcRef.id} product ${atc.product} not allowed`);
  }

  // 3. Build procedure id -> suedoname map.
  const mapProcedure = {};
  const procedureSnap = await adminDefault.collection("procedures").orderBy("name", "asc").get();
  procedureSnap.forEach((doc) => {
    mapProcedure[doc.id] = doc.data()["suedoname"];
  });

  // 4. Walk corrections + procedures subcollections of THIS atc doc.
  const atc_data = [];
  const corrSnap = await atcRef.collection("corrections").get();
  console.log(`Corrections for ${atc.profileid}:`, corrSnap.docs.length);
  for (const corrDoc of corrSnap.docs) {
    const corrData = corrDoc.data();
    if (corrData.isdelete) continue;
    const obj = { adjustment: corrData.name, procedure: [] };
    const proceSnap = await corrDoc.ref.collection("procedures").get();
    for (const procedDoc of proceSnap.docs) {
      const procedData = procedDoc.data();
      if (procedData.isdelete !== true && procedData.name?.id) {
        obj.procedure.push(mapProcedure[procedData.name.id]);
      }
    }
    atc_data.push(obj);
  }
  const atcDataString = JSON.stringify(atc_data);
  console.log(`atcDataString for ${atcRef.id}:\n${atcDataString}`);

  // 5. Locate the existing queue_atc_generation doc whose output holds the
  //    generated ATC content for this profile/queue/stage.
  const profileid = atc.profileid;
  const genSnap = await adminATC.collection("queue_atc_generation")
    .where("profileid", "==", profileid)
    .where("queueref", "==", queueSnap.ref)
    .where("stage", "==", stagename)
    .get();

  let sourceGenDoc = null;
  for (const d of genSnap.docs) {
    const out = d.data().output;
    if (out && (typeof out !== "string" || out.trim() !== "")) {
      sourceGenDoc = d;
      break;
    }
  }
  if (!sourceGenDoc) {
    return console.log(`no queue_atc_generation with output for stage ${stagename}`);
  }
  const sourceGenData = sourceGenDoc.data();
  const queueTokenId = sourceGenData.queue_token_id;
  const generatedAtcContent = sourceGenData.output || "";
  if (!generatedAtcContent || (typeof generatedAtcContent === "string" && generatedAtcContent.trim() === "")) {
    return console.log(`generatedAtcContent empty for stage ${stagename}`);
  }

  // 6. Rebuild PARTICIPANT_TYPE + PARTICIPANT_DATA from the sibling pairing
  //    docs (form + zoom) that fed this AI ATC generation.
  const pairingstages = sourceGenData.pairingstages || [];
  const siblingsSnap = await adminATC.collection("queue_atc_generation")
    .where("profileid", "==", sourceGenData.profileid)
    .where("queue_token_id", "==", queueTokenId)
    .where("queueref", "==", sourceGenData.queueref)
    .get();

  const pairingDocsByStage = {};
  for (const d of siblingsSnap.docs) {
    const dd = d.data();
    if (pairingstages.includes(dd.stage)) pairingDocsByStage[dd.stage] = dd;
  }

  const allDocs = [sourceGenData];
  for (const stage of pairingstages) {
    if (stage === sourceGenData.stage) continue;
    const pd = pairingDocsByStage[stage];
    if (pd) allDocs.push(pd);
  }

  const formDocs = allDocs.filter((d) => d.type === "form");
  const zoomDocs = allDocs.filter((d) => d.type === "zoom");

  const participantType = formDocs.some((d) => /aspiration/i.test(d.stage || ""))
    ? "first_time"
    : "returning";
  const formType = formDocs.map((d) => d.stage).filter(Boolean).join(", ") || sourceGenData.stage || "";

  const renderForm = (d) => {
    const body = typeof d.data === "object" ? JSON.stringify(d.data) : String(d.data ?? "");
    return `${d.stage}: ${body}`;
  };
  const renderZoom = (d) => {
    const body = typeof d.data === "object"
      ? (d.data.transcript_text || JSON.stringify(d.data))
      : String(d.data ?? "");
    return `${d.stage}: ${body}`;
  };

  const participantDataSection = [
    formDocs.map(renderForm).join("\n\n"),
    zoomDocs.map(renderZoom).join("\n\n"),
  ].filter((s) => s && s.trim() !== "").join("\n\n");

  // 7. Locate CHECKPOINT_REPORT — the queue_atc_generation doc whose sourceref
  //    points to sourceGenDoc and whose type is 'checkpoint report'.
  let checkpointReport = "";
  const checkpointSnap = await adminATC.collection("queue_atc_generation")
    .where("sourceref", "==", sourceGenDoc.ref)
    .where("type", "==", "checkpoint report")
    .get();
  for (const d of checkpointSnap.docs) {
    const out = d.data().output;
    if (out && (typeof out !== "string" || out.trim() !== "")) {
      checkpointReport = typeof out === "string" ? out : JSON.stringify(out);
      break;
    }
  }
  if (!checkpointReport) {
    console.log(`no checkpoint report found for sourceGenDoc ${sourceGenDoc.id} — proceeding with empty CHECKPOINT_REPORT`);
  }

  // 8. Read rubrics prompt config (for systemprompt + podtemplateid).
  const promptSnap = await adminDefault.collection("classify").doc(RUBRICS_PROMPT_DOCID).get();
  if (!promptSnap.exists) return console.log(`classify/${RUBRICS_PROMPT_DOCID} missing`);
  const promptCfg = promptSnap.data();

  // 9. Compose the analysis prompt using prompt_3_analysis.md.
  const generatedAtcStr = typeof generatedAtcContent === "string"
    ? generatedAtcContent
    : JSON.stringify(generatedAtcContent);

    // `PARTICIPANT_TYPE: ${participantType}`,
    // `FORM_TYPE: ${formType}`,
    // `PARTICIPANT_DATA:\n${participantDataSection}`,

  const analysisBlock = [
    `VERIFIED_AI_ATC:\n${generatedAtcStr}`,
    `CHECKPOINT_REPORT:\n${checkpointReport}`,
    `SPECIALIST_ATC:\n${atcDataString}`,
  ].join("\n\n");

  const lastSentence="Begin the response now with the opening brace `{`. Do not output anything else before it."

  const prompt = `${ANALYSIS_PROMPT}\n\n${analysisBlock}\n\n${lastSentence}`;

  // 8. Create the new queue_atc_generation doc for rubrics scoring.
  const rubricsStageName = `rubrics_scoring_${stagename}`;
  const docid = adminATC.collection("queue_atc_generation").doc().id;
  const payload = {
    docid: docid,
    queueref: adminATC.doc(queueSnap.ref.path),
    profileid: profileid,
    queue_token_id: queueTokenId,
    stage: rubricsStageName,
    generateatc: true,
    type: RUBRICS_TYPE,
    pairingstages: [stagename],
    sourceref: atcRef,
    data: null,
    createdAt: new Date(),
    prompt: prompt,
    systemprompt: promptCfg.systemprompt,
    status: "pending",
    promptUpdatedAt: new Date(),
  };
  await adminATC.collection("queue_atc_generation").doc(docid).set(payload);
  console.log(`queue_atc_generation rubrics doc created ${docid} for atc ${atcRef.id}`);

  // 9. Kick off the pod via run_jobrequest.
  // await callRunJobRequest({ docid, promptCfg });
}

// ---------- run_jobrequest invocation ----------
async function callRunJobRequest({ docid, promptCfg }) {
  const podtemplateid = promptCfg.podtemplateid;
  if (!podtemplateid) {
    console.log("rubrics podtemplateid not configured — skipping run_jobrequest call");
    return;
  }

  const payload = {
    TEMPLATEID: podtemplateid,
    SLACK_WEBHOOK_URL: promptCfg.SLACK_WEBHOOK_URL || "",
    FIREBASE_FETCH_URL: promptCfg.FIREBASE_FETCH_URL || "",
    FIREBASE_SUBMIT_URL: promptCfg.FIREBASE_SUBMIT_URL || "",
    FIREBASE_COLLECTION_NAME: "queue_atc_generation",
    AUTO_TERMINATE: "true",
    DOC_ID: docid,
  };

  const resp = await fetch(RUN_JOBREQUEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": functionsApiKey.value() || process.env.FUNCTIONS_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    console.log(`run_jobrequest failed: ${resp.status} ${err}`);
    return;
  }
  const data = await resp.json().catch(() => ({}));
  console.log("run_jobrequest ok", data);
}