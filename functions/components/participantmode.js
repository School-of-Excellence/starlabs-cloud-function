const admin = require('firebase-admin');
const commonService = require('./service');
const { onDocumentCreated , onDocumentWritten , onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");

// Calculate Participant Mode
exports.calculateParticipantMode = onDocumentWritten('/participantsproduct/{id}', async (snap) => {
  var change = snap.data
  var currentDate = new Date()
  var nextmodeDate

  await admin.firestore().doc("/Atestdate/date").get().then(data=>{
    if(data.exists){
      var docdata = data.data()
      if(docdata["date"] != null && docdata["date"] != undefined) currentDate = docdata["date"].toDate()
    }
  })

  var beforeData = change.before.exists ? change.before.data() : {}
  var afterData = change.after.exists ? change.after.data() : {}

  if (JSON.stringify(beforeData) === JSON.stringify(afterData)) {
    return null;
  }

  var productData = (await admin.firestore().doc(afterData["productref"].path).get()).data()

  // New Product Added - Ensure Mode Data Updated
  if((!change.before.exists && change.after.exists)){
    var newData = {
      deliveryplanning: productData["deliveryplanning"],
      deliverymode: productData["mode"]
    }
    if(afterData["status"] == null){
      var currentmode = productData["deliveryplanning"] == "normal" ? "Journey Planning Mode" : "Journey Priority Planning Mode"
      newData["mode"] = currentmode
      newData["nextmode"] = null
      newData["nextmodedate"] = null
      // afterData["mode"] = currentmode
    }
    await change.after.ref.update(newData)
  }

  // Product Initiated/Ongoing
  if([null, undefined].includes(beforeData["status"]) && ["initiated", "ongoing"].includes(afterData["status"])){
    // Update Touch Point - Initiated
    if(afterData["status"] == "initiated"){
      // Update Initiated Date
      var initiatedDate = (afterData["statusdate"] || {})["initiated"]
      if([null, undefined].includes(initiatedDate)){
        change.after.ref.update({
          "statusdate.initiated": admin.firestore.FieldValue.serverTimestamp(),
        })
      }
      await commonService.updateParticipantTouchPoint({
        label: `${productData["product"]} Initiated`,
        notes: "",
        touchpoint: "Product Initiated",
        touchpointdate: initiatedDate ? initiatedDate.toDate() : admin.firestore.FieldValue.serverTimestamp(),
        profileid: afterData["profileid"],
        parentreference: snap.data.after.ref,
        metadata: {
          productref: afterData["productref"],
        }
      })
    }

    // Update Priority Mode - If mode not updated
    if(afterData["deliverymode"] == "Priority Mode" && afterData["mode"] != "Priority Mode"){
      await change.after.ref.update({
        mode: "Priority Mode",
        nextmode: "Integration Mode",
        nextmodedate: null,
        "statusdate.prioritymode": admin.firestore.FieldValue.serverTimestamp()
      })
    }
  }

  // Product Completed
  if(beforeData["status"] != "completed" && afterData["status"] == "completed"){
    var completedTimestamp = afterData["statusdate"] != null ? afterData["statusdate"]["completed"] : null
    if(completedTimestamp == null || completedTimestamp == undefined){
      nextmodeDate = null
      if(productData["integrationdays"]){
        nextmodeDate = new Date()
        nextmodeDate.setDate(new Date().getDate() + productData["integrationdays"])
        nextmodeDate.setHours(0, 0, 0, 0)
      }
      await change.after.ref.update({
        mode: "Integration Mode",
        "statusdate.completed": currentDate,
        "statusdate.integrationmode": currentDate,
        nextmode: "Performance Mode",
        nextmodedate: nextmodeDate
      })
    }
    else{
      var mode = null
      var nextmode = null
      var nextmodedate = null
      var completionDate = completedTimestamp.toDate()
      var integrationdays = productData["integrationdays"]
      var performancedays = productData["performancedays"]
      var extendedperformancedays = productData["extendedperformancedays"]
      if(integrationdays != null && performancedays != null && extendedperformancedays != null && integrationdays != undefined && performancedays != undefined && extendedperformancedays != undefined){
        let timedifference = Math.floor((currentDate.getTime() - completionDate.getTime()) / 1000 / 60 / 60 / 24)
        console.log("Time Difference", timedifference, "integration -", integrationdays, "Performance -", performancedays, "Extended Perform", extendedperformancedays)
        if(timedifference < integrationdays){
          mode = "Integration Mode",
          nextmode = "Performance Mode",
          nextmodedate = new Date(completionDate)
          nextmodedate.setDate(completionDate.getDate() + integrationdays)
          // new Date(new Date(currentDate).setDate(new Date(completionDate).setDate(completionDate.getDate() + integrationdays)))
        }
        else if(timedifference < (integrationdays + performancedays)){
          mode = "Performance Mode"
          nextmode = "Extended Performance Mode",
          nextmodedate = new Date(completionDate)
          nextmodedate.setDate(completionDate.getDate() + integrationdays + performancedays)
          // new Date(new Date(currentDate).setDate(new Date(completionDate).setDate(completionDate.getDate() + integrationdays + performancedays)))
        }
        else if(timedifference < (integrationdays + performancedays + extendedperformancedays)){
          mode = "Extended Performance Mode"
          nextmode = "After Extended Performance Mode",
          nextmodedate = new Date(completionDate)
          nextmodedate.setDate(completionDate.getDate() + integrationdays + performancedays + extendedperformancedays)
          // new Date(new Date(currentDate).setDate(new Date(completionDate).setDate(completionDate.getDate() + integrationdays + performancedays + extendedperformancedays)))
        }
        else{
          mode = "After Extended Performance Mode"
          nextmode = null,
          nextmodedate = null
        }
        var nextModeData = {
          mode: mode,
          nextmode: nextmode,
          nextmodedate: nextmodedate,
        }
        nextModeData[`statusdate.${mode.replaceAll(" ", "").toLowerCase()}`] = admin.firestore.FieldValue.serverTimestamp()
        await change.after.ref.update(nextModeData)
      }
      else{
        console.log("Integration period not updated.")
      }
    }

    // Update Touch Point - Completed
    await commonService.updateParticipantTouchPoint({
      label: `${productData["product"]} Completed`,
      notes: "",
      touchpoint: "Product Completed",
      touchpointdate: completedTimestamp ? completedTimestamp.toDate() : admin.firestore.FieldValue.serverTimestamp(),
      profileid: afterData["profileid"],
      parentreference: snap.data.after.ref,
      metadata: {
        productref: afterData["productref"],
      }
    })
  }

  // Product Cancelled & Shifted
  if(beforeData["status"] != afterData["status"] && ["cancelled", "shifted"].includes(afterData["status"])){
    var newModeData = {
      mode: null,
      nextmode: null,
      nextmodedate: null
    }
    var changedStatusDate = (afterData["statusdate"] || {})[afterData["status"]]
    if(changedStatusDate == null || changedStatusDate == undefined){
      newModeData[`statusdate.${afterData["status"]}`] = admin.firestore.FieldValue.serverTimestamp()
    }
    await change.after.ref.update(newModeData)

    await commonService.updateParticipantTouchPoint({
      label: `${productData["product"]} ${afterData["status"] == "cancelled" ? "Cancelled" : "Shifted"}`,
      notes: "",
      touchpoint: afterData["status"] == "cancelled" ? "Product Cancelled" : "Product Shifted",
      touchpointdate: changedStatusDate ? changedStatusDate.toDate() : admin.firestore.FieldValue.serverTimestamp(),
      profileid: afterData["profileid"],
      parentreference: snap.data.after.ref,
      metadata: {
        productref: afterData["productref"],
      }
    })
  }

  // Mode Changed
  if(beforeData["mode"] != afterData["mode"]){
    var batch = admin.firestore().batch()
    var modeList = (await admin.firestore().collection("modes").orderBy("sequence").get()).docs.map(e => e.data()["mode"])
    console.log("Mode Sequence", modeList.toString())
    // Update Mode Sequence
    await admin.firestore().collection("participantsproduct").where("profileid", "==", afterData["profileid"]).get().then(async(snap)=>{
      var mapParticipantProducts = snap.docs.reduce((r,a) => {
        var data = a.data()
        r[data['profileid']] = r[data['profileid']] || []
        if(data["mode"] != null && data["mode"] != undefined) r[data['profileid']].push(data["mode"]);
        return r
      },{})
      for(const key in mapParticipantProducts){
        var sort = Array.from(new Set(mapParticipantProducts[key])).sort((a, b) => modeList.indexOf(a) - modeList.indexOf(b))
        console.log("Participant Mode Sequence", sort.toString())
        batch.set(admin.firestore().collection("participant metadata").doc(key), {
          productmode: sort
        }, {merge: true})

        let participantMode = null;
        await admin.firestore().collection("participant metadata").doc(key).get().then((metadata)=> {
          if(metadata.exists) {
            const data = metadata.data();

            if(![null, undefined, ""].includes(data['customerstatus'])) {
              const customerstatus = data['customerstatus'];

              if(customerstatus == 'active') {
                participantMode = sort.length != 0 ? sort[0] : "Journey Planning Mode"
              } else if(customerstatus == 'non active') {
                participantMode = 'Exploration Mode';
              } else if([null, undefined, '', 'discontinued'].includes(customerstatus)) {
                participantMode = null;
              }
            }
          }
        })

        batch.update(admin.firestore().collection("profile_data").doc(key), {
          participantmode: participantMode
        })
      }
    })
    await batch.commit().then(result=>{
      console.log("Batch Done", result.length)
    })

    if(afterData["mode"] != null){
      //create participant mode checklist
      let obj = {
        aelid: afterData['aelid'] || null,
        docid:admin.firestore().collection("participant mode checklist").doc().id,
        participantproductid:afterData['docid'],
        productref:afterData['productref'],
        profileid:afterData['profileid'],
        widget:[],
        mode:afterData['mode'],
        createddate:new Date()
      }
      await admin.firestore().collection("product mode config").where('productref','==',afterData['productref']).where('mode',"==",afterData['mode']).get().then(async productModeConfigSnap => {
        if(productModeConfigSnap.docs.length != 0){
          obj['widget'] = productModeConfigSnap.docs[0].data()['widgets']
          await admin.firestore().collection("participant mode checklist").doc(obj['docid']).set(obj,{merge:true}).then(async () => {
            let id = admin.firestore().collection("evolution log").doc().id
            await admin.firestore().collection("evolution log").doc(id).set({
              aelid: afterData['aelid'] || null,
              docid:id,
              participantproductid:afterData['docid'],
              productref:afterData['productref'],
              profileid:afterData['profileid'],
              mode:afterData['mode'],
              productstatus:afterData['status'],
              logdate:new Date()
            }).then(() => {
              console.log("evolution log & participant mode checklist");
            }).catch(err => {console.log(err);})
          }).catch(err => {console.log(err);})
        }
      })

      // Save Mode Changed Date
      var currentModeDate = (afterData["statusdate"] || {})[afterData["mode"].replaceAll(" ", "").toLowerCase()]
      if(currentModeDate == null || currentModeDate == undefined){
        var newDate = {}
        newDate[`statusdate.${afterData["mode"].replaceAll(" ", "").toLowerCase()}`] = admin.firestore.FieldValue.serverTimestamp()
        await change.after.ref.update(newDate)
      }

      // Update Touch Point - Mode
      await commonService.updateParticipantTouchPoint({
        label: `${productData["product"]}: ${afterData["mode"]}`,
        notes: `Moved from ${beforeData["mode"]}`,
        touchpoint: "Product Mode Update",
        touchpointdate: currentModeDate ? currentModeDate.toDate() : admin.firestore.FieldValue.serverTimestamp(),
        profileid: afterData["profileid"],
        parentreference: snap.data.after.ref,
        metadata: {
          productref: afterData["productref"],
        }
      })
    }
  }

  // Participant Tentative Date Updated
  if(afterData["participanttentativedate"] != null){
    var beforeTentative = beforeData["participanttentativedate"] == null || beforeData["participanttentativedate"] == undefined ? null : beforeData["participanttentativedate"].toDate().toDateString()
    var afterTentative = afterData["participanttentativedate"].toDate().toDateString()
    console.log("Before Date", beforeData["participanttentativedate"] != null ? beforeData["participanttentativedate"].toDate() : null)
    console.log("After Date", afterData["participanttentativedate"].toDate())
    console.log("Before", beforeTentative, "After", afterTentative)
    if(beforeTentative != afterTentative){
      var timedifference = Math.floor((afterData["participanttentativedate"].toDate().getTime() - currentDate.getTime()) / 1000 / 60 / 60 / 24)
      console.log("Time Difference", timedifference)
      if(timedifference >= 30){
        nextmodeDate = new Date(afterData["participanttentativedate"].toDate())
        nextmodeDate.setDate(afterData["participanttentativedate"].toDate().getDate() - 30)
        await change.after.ref.update({
          mode: "Early Preparation Mode",
          nextmode: "Preparation Mode",
          nextmodedate: nextmodeDate
          // new Date(new Date(currentDate).setDate(new Date(afterData["participanttentativedate"].toDate()).setDate(afterData["participanttentativedate"].toDate().getDate() - 30)))
        })
      }
      else if(timedifference >= 15){
        nextmodeDate = new Date(afterData["participanttentativedate"].toDate())
        nextmodeDate.setDate(afterData["participanttentativedate"].toDate().getDate() - 15)
        await change.after.ref.update({
          mode: "Preparation Mode",
          nextmode: "Priority Mode",
          nextmodedate: nextmodeDate
          // new Date(new Date(currentDate).setDate(new Date(afterData["participanttentativedate"].toDate()).setDate(afterData["participanttentativedate"].toDate().getDate() - 15)))
        })
      }
      else{
        await change.after.ref.update({
          mode: "Priority Mode",
          status: "ongoing",
          nextmode: "Integration Mode",
          nextmodedate: null
        })
      }
    }
  }

  // Instantiated
  if(beforeData['status'] != afterData['status'] && afterData['status'] === 'completed'){
    await admin.firestore().collection("participantsproduct").where("profileid", "==", afterData["profileid"]).where("productref","==",afterData['productref']).orderBy("sequenceorder","asc").get().then(async snap=>{
      let productlist = snap.docs.map(e => e.data())
      let productInstantiated = null
      let batch = admin.firestore().batch()
      for (let i = 0; i < productlist.length; i++) {
        const element = productlist[i];
        if(productInstantiated != 'yes'){
          if(element['status'] === 'completed') element['instantiated'] = 'done'
          else {
            element['instantiated'] = 'yes'
            productInstantiated = 'yes'
          }
        }else {
          if(element['status'] === 'completed') element['instantiated'] = 'done'
          else element['instantiated'] = 'no'
        }
        let ref = admin.firestore().collection("participantsproduct").doc(element['docid'])
        batch.update(ref,element)
      }
      await batch.commit()
    })
  }  
})

exports.productNextModeUpdate = onSchedule({schedule : "05 00 * * *", region: "asia-south1", timeZone: "Asia/Kolkata"},async (context)=>{
  var batch = admin.firestore().batch()
  var batchCount = 0
  var mapProductData = {}
  await admin.firestore().collection("products").get().then(list=>{
    list.docs.forEach(doc=>{
      var data = doc.data()
      mapProductData[doc.id] = data
    })
  })

  var mapEventData = {}
  var startdate = new Date()
  startdate.setHours(0,0,0,0)
  var enddate = new Date()
  enddate.setHours(23,59,59,59)
  console.log(startdate, enddate, " ---- ", startdate.toDateString(), enddate.toDateString())
  await admin.firestore().collection("participantsproduct").where("nextmodedate", ">=", startdate).where("nextmodedate", "<=", enddate).get().then(async modechange=>{
    console.log(modechange.docs.length)
    console.log(modechange.docs.map(e => e.id))
    for (let i = 0; i < modechange.docs.length; i++) {
      const doc = modechange.docs[i];
      var data = doc.data()
      var nextMode = data["nextmode"]
      var productref = data["productref"]
      var productIntegration = mapProductData[productref.id]["integrationdays"]
      var productPerformance = mapProductData[productref.id]["performancedays"]
      var productExtendedPerformance = mapProductData[productref.id]["extendedperformancedays"]
      var newData = {}
      if(nextMode == "After Extended Performance Mode"){
        newData = {
          previousmode: data["mode"],
          mode: nextMode,
          nextmode: null,
          nextmodedate: null,
          "statusdate.extendedperformancecompleteddate": new Date()
        }
      }
      else if(nextMode == "Extended Performance Mode"){
        newData = {
          previousmode: data["mode"],
          mode: nextMode,
          nextmode: "After Extended Performance Mode",
          nextmodedate: new Date(startdate.getFullYear(), startdate.getMonth(), startdate.getDate() + (productExtendedPerformance != null && productExtendedPerformance != undefined ? productExtendedPerformance : 0)),
          "statusdate.performancecompleteddate": new Date()
        }
      }
      else if(nextMode == "Performance Mode"){
        newData = {
          previousmode: data["mode"],
          mode: nextMode,
          nextmode: "Extended Performance Mode",
          nextmodedate: new Date(startdate.getFullYear(), startdate.getMonth(), startdate.getDate() + (productPerformance != null && productPerformance != undefined ? productPerformance : 0)),
          "statusdate.integrationcompleteddate": new Date()
        }
      }
      else if(nextMode == "Integration Mode" && !["Event Mode", "Installation Event Mode", "Big Mode"].includes(data["mode"])){
        newData = {
          previousmode: data["mode"],
          mode: nextMode,
          nextmode: "Performance Mode",
          nextmodedate: new Date(startdate.getFullYear(), startdate.getMonth(), startdate.getDate() + (productIntegration != null && productIntegration != undefined ? productIntegration : 0))
        }
      }
      else if(["Event Mode", "Installation Event Mode", "Big Mode", "Preparation Mode"].includes(nextMode)){
        newData = {
          previousmode: data["mode"],
          mode: nextMode,
          nextmode: null,
          nextmodedate: null
        }
        if(data["eventref"]){
          if([null, undefined].includes(mapEventData[data["eventref"].path])){
            await admin.firestore().collection("event_collection").orderBy("end_date", "desc").get().then(event =>{
              for (let i = 0; i < event.docs.length; i++) {
                const doc = event.docs[i];
                var data = doc.data()
                mapEventData[data["eventref"].path] = {
                  start: data["start_date"].toDate(),
                  end: data["end_date"].toDate()
                }
              }
            })
            await admin.firestore().collection("queue generation").orderBy("queueenddate", "desc").get().then(event =>{
              for (let i = 0; i < event.docs.length; i++) {
                const doc = event.docs[i];
                var data = doc.data()
                mapEventData[data["eventref"].path] = {
                  start: data["queuestartdate"].toDate(),
                  end: data["queueenddate"].toDate()
                }
              }
            })
          }
          if(![null, undefined].includes(mapEventData[data["eventref"].path])){
            var startDate = mapEventData[data["eventref"].path]["start"]
            var endDate = mapEventData[data["eventref"].path]["end"]

            if(nextMode == "Preparation Mode"){
              newData["nextmode"] = mapProductData[data["productref"].id]["mode"]
              newData["nextmodedate"] = new Date(startDate)
            }
            else{
              newData["nextmode"] = "Integration Mode"
              newData["nextmodedate"] = new Date(endDate)
              newData["nextmodedate"].setDate(endDate.getDate() + 1)
            }
          }
          // await admin.firestore().doc(data["eventref"].path).get().then(eventSnap =>{
          //   if(eventSnap.exists){
          //     var eventData = eventSnap.data()
          //     var endDate = eventData[eventSnap.ref.parent.id == "event collection" ? "end_date" : "queueenddate"].toDate()
          //     newData["nextmodedate"] = new Date(endDate)
          //     newData["nextmodedate"].setDate(endDate.getDate() + 1)
          //   }
          // })
        }
      }
      else if(nextMode == "Priority Mode"){
        newData = {
          previousmode: data["mode"],
          mode: nextMode,
          nextmode: "Integration Mode",
          nextmodedate: null,
        }
      }
      if(newData["mode"]){
        batch.update(doc.ref, newData)
        batchCount += 1
      }
      if(batchCount % 500 == 0){
        await batch.commit().then(()=>{
          batch = admin.firestore().batch()
        })
      }
    }
    await batch.commit()
  })
})

exports.onEventApprovalProductMode = onDocumentWritten("event participation request/{docid}", async (change) => {
  var snapshot = change.data
  var beforeData = snapshot.before.exists ? snapshot.before.data() : {}
  var afterData = snapshot.after.exists ? snapshot.after.data() : {}
  var nextmodedate
  if(!["approved", "attended"].includes(beforeData["status"]) && ["approved", "attended"].includes(beforeData["status"])){
    var eventData = (await admin.firestore().doc(afterData["eventref"].path).get()).data()
    var eventStart = eventData["start_date"].toDate()
    var eventEnd = eventData["start_date"].toDate()
    let currentdate = new Date()
    if(eventStart >= currentdate){
      let diff = Math.abs(eventStart.getTime() - currentdate.getTime())
      let days = Math.ceil(diff/(1000*3600*24))
      console.log("diff in days",days);
      if(days >= 30){
        console.log("more than 30 days",days);
        nextmodedate = new Date(new Date(eventStart).setDate(eventStart.getDate() - 30))
        await updateParticipantDocument("Early Preparation Mode", snapshot.after.ref, "Preparation Mode", nextmodedate)
      }else if(days >= 1 && days <= 30){
        console.log("less than 30 days",days);
        await updateParticipantDocument("Preparation Mode", snapshot.after.ref, "Installation Event Mode", eventStart)
      }else{
        console.log("on that day",days);
        nextmodedate = new Date(new Date(eventEnd).setDate(eventEnd.getDate() + 1))
        await updateParticipantDocument(null, snapshot.after.ref, "Integration Mode", nextmodedate)
      }
    }else{
      if(currentdate < eventEnd){
        nextmodedate = new Date(new Date(eventEnd).setDate(eventEnd.getDate() + 1))
        await updateParticipantDocument(null, snapshot.after.ref, "Integration Mode", nextmodedate)
      }else{
        console.log("currentdate over than enddate");
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


