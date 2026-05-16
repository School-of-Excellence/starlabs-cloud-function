const admin = require('firebase-admin');
const commonService = require('./service');
const { onDocumentCreated , onDocumentWritten , onDocumentUpdated } = require("firebase-functions/v2/firestore");

exports.slackInterimCrossOver = onDocumentCreated("/interim crossover/{docid}",async (snap) => {
    var context = snap.data
    const data = context.data()
    let url = null
    if(commonService.production === true){
      url = commonService.slackEvolutionProgress // production
    }else{
      url = commonService.slackDevTest //test
    }
    if(url != null){
      // admin.firestore().collection("participant AEL").doc(newData[data['aelid']]).get().then(snap => {
        // if(snap.exists){
          admin.firestore().collection("profile_data").doc(data['profileid']).get().then( profileSnap => {
            if(profileSnap.exists){
              let message = {
                "blocks": [
                  {
                    "type": "section",
                    "text": {
                      "type": "mrkdwn",
                      "text": `*${profileSnap.data()['name']}*`
                    }
                  },
                  {
                    "type": "rich_text",
                    "elements": []
                  }
                ]
              }
              for (const key in data['metric']) {
                message.blocks[0].elements.push({
                    "type": "rich_text_section",
                    "elements": [
                      {
                        "type": "text",
                        "text": `${key} : ${data['metric']['startpoint']} to ${data['metric']['endpoint']}`
                      }
                    ]
                  })
              }
              var webhook = new commonService.IncomingWebhook(url);
              webhook.send(message,function(err, header, statusCode, body) {
                if (err) {
                  console.log('Error:', err);
                } else {
                  console.log('Received', statusCode, 'from Slack');
                }
              });
            }else console.log("profile data doc not found");
          })
        // }else console.log("participant AEL doc not found");
      // })
    }
})

exports.slackLoveLetter = onDocumentCreated("/love letter/{docid}", async (snap) => {
    var context = snap.data
    const data = context.data()
    let url = null
    if(commonService.production === true){
      url = commonService.slackLoveLetter // production
    }else{
      url = commonService.slackDevTest //test
    }
    if(url != null){
      admin.firestore().collection("profile_data").doc(data['profileid']).get().then( profileSnap => {
        if(profileSnap.exists){
          let message = {
            "blocks": [
              {
                "type": "header",
                "text": {
                  "type": "plain_text",
                  "text": `${profileSnap.data()['name']} :heart: `
                }
              },
              {
                "type": "section",
                "text": {
                  "type": "mrkdwn",
                  "text": `*${data['loveletter']}*`,
                }
              }
            ]
          }
          var webhook = new commonService.IncomingWebhook(url);
          webhook.send(message,function(err, header, statusCode, body) {
            if (err) {
              console.log('Error:', err);
            } else {
              console.log('Received', statusCode, 'from Slack');
            }
          });
        }else console.log("profile data doc not found");
      })
    }
})

exports.slackAskAH = onDocumentCreated("/ask AH/{docid}", async (snap) => {
    var context = snap.data
    const data = context.data()
    let url = null
    if(commonService.production === true){
      url = commonService.slackAskAH // production
    }else{
      url = commonService.slackDevTest //test
    }
    if(url != null){
      await admin.firestore().collection("profile_data").doc(data['profileid']).get().then( profileSnap => {
        if(profileSnap.exists){
          let message = {
            "blocks": [
              {
                "type": "header",
                "text": {
                  "type": "plain_text",
                  "text": `${profileSnap.data()['name']}`
                }
              },
              {
                "type": "section",
                "text": {
                  "type": "mrkdwn",
                  "text": `*Ask A&H* : ${data['askah']}`,
                }
              },
              {
                "type": "section",
                "text": {
                  "type": "mrkdwn",
                  "text": `*Installation Ask A&H* : ${data['installationaskah']}`,
                }
              },
            ]
          }
          var webhook = new commonService.IncomingWebhook(url);
          webhook.send(message,function(err, header, statusCode, body) {
            if (err) {
              console.log('Error:', err);
            } else {
              console.log('Received', statusCode, 'from Slack');
            }
          });
        }else console.log("profile data doc not found");
      })
    }
})

exports.ATCevolutionProgress = onDocumentUpdated("/interimreport log/{docid}", async (snap) => {
  var oldData = snap.data.before.exists ? snap.data.before.data() : {}
  var newData = snap.data.after.exists ? snap.data.after.data() : {}

  var previousReportList = oldData["reports"] ?? []
  var currentReportList = newData["reports"] ?? []

  if(!previousReportList.includes("evolutionprogress") && currentReportList.includes("evolutionprogress")){
    console.log("Updating Evolution Progress", newData["profileid"])

    const { getFirestore } = require("firebase-admin/firestore");
    const adminATC = getFirestore("firestore-atc");
    var atcBatch = adminATC.batch()

    let batch = admin.firestore().batch()
    var metaBatch = admin.firestore().batch()
    var aelBatch = admin.firestore().batch()
    var mapAelAtc = {}
    var mapProfileATCprogress = {}
    await adminATC.collection("atc_alpha").where("profileid", "==", newData["profileid"]).where("isdelete", "==", false).where("product", "in", ["A&H","A&H ATC","Expanding Horizon","uP!","LYL","B!G",]).get().then(async atcList =>{
      console.log("Total ATC", atcList.docs.length)
      for (let i = 0; i < atcList.docs.length; i++) {
        const alphaelement = atcList.docs[i].data();

        if(alphaelement['isdelete'] != true && [null,'validated', undefined].includes(alphaelement['status'])){  
          let evolutionprogress = {}
          let evolutionyearwasted = 0
          let evolutionyearsaved = 0
          let extendedlifeimpact = {}
          let adjustmentaware = 0
          let adjustmentunaware = 0
          let specialistInvolved = Array.from(new Set([...(alphaelement['author'] || []).map(e => e.id),...(alphaelement['mentor'] || []),...(alphaelement['validator'] || []).map(e =>e.id)]))
          
          await atcList.docs[i].ref.collection("corrections").where("isdelete","==",false).get().then(async correctionSnap => {
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
          var updateData = {
            totaladjustmentaware: adjustmentaware,
            totaladjustmentunaware: adjustmentunaware,
            evolutionyearwasted: evolutionyearwasted,
            evolutionyearsaved: evolutionyearsaved,
            extendedlifeimpact: extendedlifeimpact,
            specialistinvolved: Array.from(new Set(Object.keys(extendedlifeimpact))),
            evolutionprogress: evolutionprogress
          }

          console.log("ATC Report", alphaelement["atcid"], i+1, "/", atcList.size)

          // Update Current ATC
          // console.log("ATC Progress", updateData)
          atcBatch.update(atcList.docs[i].ref, updateData)

          // Update Specialist - Extended Life Impact
          // console.log("Participants ELY", Object.keys(extendedlifeimpact))
          for (const key in extendedlifeimpact){
            batch.set(admin.firestore().collection("participants ely").doc(key), {
              [alphaelement['atcid']] : extendedlifeimpact[key]
            },{merge:true})
          }

          // Aggregate Overall Profile Progress
          mapProfileATCprogress[alphaelement["profileid"]] = mapProfileATCprogress[alphaelement["profileid"]] || {}
          mapProfileATCprogress[alphaelement["profileid"]] = {
            evolutionyearwasted: (mapProfileATCprogress[alphaelement["profileid"]]["evolutionyearwasted"] || 0) + evolutionyearwasted,
            evolutionyearsaved: (mapProfileATCprogress[alphaelement["profileid"]]["evolutionyearsaved"] || 0) + evolutionyearsaved,
            totaladjustmentaware: (mapProfileATCprogress[alphaelement["profileid"]]["totaladjustmentaware"] || 0) + adjustmentaware,
            totaladjustmentunaware: (mapProfileATCprogress[alphaelement["profileid"]]["totaladjustmentunaware"] || 0) + adjustmentunaware,
            evolutionprogress: mapProfileATCprogress[alphaelement["profileid"]]["evolutionprogress"] || {}
          }

          for (const name in evolutionprogress) {
            mapProfileATCprogress[alphaelement["profileid"]]["evolutionprogress"][name] = (mapProfileATCprogress[alphaelement["profileid"]]["evolutionprogress"][name] || 0) + evolutionprogress[name]
          }

          if(i != 0 && (i % 1000) == 0){
            await batch.commit().then(() =>{
              console.log("Batch", i%1000)
            })
            batch = admin.firestore().batch()
          }
        }
      }
    })

    console.log("------------------------------------------------------")

    // Update Participant AEL
    for (const aelid in mapAelAtc) {
      // console.log("AEL Updates", aelid, mapAelAtc[aelid])
      aelBatch.update(admin.firestore().collection("participant AEL").doc(aelid), mapAelAtc[aelid])
    }

    // Update Participant Metadata
    for (const profileid in mapProfileATCprogress) {
      // console.log("Metadata", profileid, mapProfileATCprogress[profileid])
      metaBatch.update(admin.firestore().collection("participant metadata").doc(profileid), mapProfileATCprogress[profileid])
    }

    await batch.commit().then(res =>{
      console.log(res.length)
    })
    await atcBatch.commit().then(res =>{
      console.log(res.length)
    })
    await metaBatch.commit().then(res =>{
      console.log(res.length)
    })
    await aelBatch.commit().then(res =>{
      console.log(res.length)
    })
  }
})