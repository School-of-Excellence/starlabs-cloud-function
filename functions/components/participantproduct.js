const admin = require('firebase-admin');
const { onDocumentWritten , onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onRequest } = require('firebase-functions/v2/https');

// Initiate Delivery Sequence to Participant Delivery Sequence
exports.participantsproductinitiated = onDocumentWritten('/participantsproduct/{id}',async (change) => {
  console.log("Participant Product Triggered", change.data.after.ref.path)
  var beforeStatus = null
  var afterStatus = null
  var participantProductdata = {}
  if(change.data.before.exists){
    beforeStatus = change.data.before.data()["status"]
  }
  if(change.data.after.exists){
    participantProductdata = change.data.after.data()
    afterStatus = participantProductdata["status"] || null
  }
  console.log("Status Before/After", beforeStatus, afterStatus)
  if(beforeStatus == null && afterStatus == "initiated"){
    if(participantProductdata['unlimited'] == true){
      await addProduct(participantProductdata);
    }
    var batch = admin.firestore().batch();
    let sequenceList = []
    // Product Delivery Option
    await admin.firestore().collection('productToDeliverySequence').where('product', '==', participantProductdata['productref']).get().then( async sequenceQuery => {
      if(sequenceQuery.docs.length > 1) {
        console.log("more product reference found in product to delivery sequence")
      }
      if(sequenceQuery.docs.length != 0){
        if([null,undefined].includes(participantProductdata['deliverytype'])){
          var deliveryOptions = sequenceQuery.docs[0].data()["deliveryoptions"] || []
          sequenceList = deliveryOptions[deliveryOptions.length - 1]["deliverysequence"]
        }else{
          for (let i = 0; i < sequenceQuery.docs.length; i++) {
            const deliveryoption = sequenceQuery.docs[i].data()["deliveryoptions"];
            for (let j = 0; j < deliveryoption.length; j++) {
              const option = deliveryoption[j];
              if(option["deliverytype"] == participantProductdata['deliverytype']){
                sequenceList = option['deliverysequence']
                break;
              }
            }
          } 
        }
      }
      else{
        console.log("productToDeliverSequence has no document");
      }
    });

    console.log("Delivery Sequence Fetch", sequenceList.length)

    if(sequenceList.length != 0){
      // Participant Delivery Sequence
      await admin.firestore().collection('participantdeliverysequence').doc(participantProductdata['profileid']).get().then(async snap => {
        let participantdata = snap.data()
        var productIndex = participantdata["products"].findIndex(e => e["participantproductid"] == participantProductdata['docid'])
        if(productIndex == -1){
          console.log("Product sequence missing", participantProductdata['docid'])
          participantdata["products"].push({
            participantproductid: participantProductdata['docid'],
            productref: participantProductdata["productref"],
            delivery: []
          })
          productIndex = participantdata["products"].length - 1
        }
        else{
          console.log("Found Participant Product Sequence", participantProductdata['docid'])
        }
        var selectedproduct = participantdata["products"][productIndex]
        if((selectedproduct["delivery"] || []).length == 0){
          // create delivery list & deliverables
          let delivery = [];
          let updatedeliveryRef = null;
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

            var deliveryid = admin.firestore().collection("deliverables").doc().id;
            
            if(a == 0){
              updatedeliveryRef = admin.firestore().collection("deliverables").doc(deliveryid)
            }
            
            var deliverableData = {
              deliveryref: sequenceRef,
              fileref: [],
              participantproductid: participantProductdata['docid'],
              profileid: participantProductdata['profileid'],
              status: null,
              type: type,
            }
            batch.set(admin.firestore().collection("deliverables").doc(deliveryid), deliverableData)
            // await admin.firestore().collection("deliverables").doc(deliveryid).set()
            delivery[a] = {
              sequenceref: admin.firestore().collection("deliverables").doc(deliveryid),
              status: a == 0 ? "ready" : null,
              type: type,
              label: label,
              description: description
            }
          }
          // update delivery to Product
          selectedproduct["delivery"] = delivery
          batch.update(snap.ref, participantdata)
          await batch.commit().then(async () =>{
            // finally update the deliverable status as ready so startParticipantNextDeliverySequence will trigger
            if(updatedeliveryRef != null){
              await updatedeliveryRef.update({
                status: "ready",
              }).then(()=>{
                console.log("Deliverable changed to ready");
              }).catch((error)=>{
                console.log("Oops error while updating deliverables", error);
              });
            }
          })
        }
      });
    }
  }

  // product is cancelled
  if (beforeStatus != afterStatus && (afterStatus == "shifted" || afterStatus == "cancelled" || afterStatus == "completed")) {
    const participantproductid = change.data.before.data()['docid'];
    
    try {
      const deliverableSnapshot = await admin.firestore()
        .collection("deliverables")
        .where('participantproductid', '==', participantproductid)
        .where('status',  'in',  ['ready', 'ongoing'])
        .get();
      
      if (!deliverableSnapshot.empty) {
        const batch = admin.firestore().batch();
        
        deliverableSnapshot.docs.forEach(doc => {
          batch.update(doc.ref, { status: null });
        });
        
        // Commit the batch
        await batch.commit();
        console.log(`Updated ${deliverableSnapshot.size} deliverables for participant: ${participantproductid}`);
      } else {
        console.log(`No deliverables found to update for participant: ${participantproductid}`);
      }
      
    } catch (error) {
      console.error('Error updating deliverables:', error);
      throw error; 
    }
  }
    
});

async function addProduct(participantsproduct){
  try {
    console.log('PP DATA',participantsproduct);
    
    const batch = admin.firestore().batch();
    let ppData = {...participantsproduct};
    let pjpRef;
    let jppRef;
    let pjpData = {};
    let jppData = {};
    let sequenceorder = 0;

    await admin.firestore().collection('participantjourneyproduct').where('profileid', '==', participantsproduct['profileid']).where("journeystatus", "in", ["initiated", "ongoing"]).get().then((pjpdoc)=>{
      if(pjpdoc.docs.length > 0){
        let foundDoc = null;
        pjpdoc.docs.forEach(doc => {
          const data = doc.data();
          const participantProducts = data.participantproducts || [];
          
          const hasMatchingId = participantProducts.some(product => 
            product.participantproductid === participantsproduct['docid']
          );
          
          if (hasMatchingId && !foundDoc) {
            foundDoc = doc;
          }
        });

        if (foundDoc) {
          pjpRef = foundDoc.ref;
          pjpData = foundDoc.data();
        } else {
          console.log('No Participant Journey Product Found');
        }

      }else{
        console.log('No Participant Journey Product Found');
      }
    });

    if(!pjpRef || Object.keys(pjpData).length == 0){
      return
    }

    await admin.firestore().collection('journeyproductpurchase').doc(pjpData['purchaseref'].id).get().then((jppdoc)=>{
      if(jppdoc.exists){
        jppRef = jppdoc.ref;
        jppData = jppdoc.data();
      }else{
        console.log('No Journey Product Purchase Found');
      }
    });

    await admin.firestore().collection('participantsproduct').where('profileid','==',participantsproduct['profileid']).get().then((ppdoc)=>{
      if(ppdoc.docs.length > 0){
        sequenceorder = ppdoc.docs.length + 1
      }else{
        console.log('No Participant Products found');
      }
    });

    const ppdocRef = admin.firestore().collection('participantsproduct').doc();

    // ppData['docid'] = ppdocRef.id;
    // ppData['status'] = null;
    // ppData['minimumpayment'] = 0;
    // ppData['sequenceorder'] = sequenceorder;
    // ppData['statusdate'] = null;
    // ppData['tentativestart'] = null;

    var newProductData = {
      docid: ppdocRef.id,
      journeyref: null,
      productref: ppData["productref"],
      packageref: ppData["packageref"],
      tentativestart: null,
      minimumpayment: 0,
      status: null,
      sequenceorder: sequenceorder,
      subscriptionstart: ppData["subscriptionstart"] || null,
      subscriptionend: ppData["subscriptionend"] || null,
      unlimited: ppData["unlimited"] ?? false,
      profileid: ppData["profileid"],
      deliverytype: null
    }

    //updating participantjourneyproduct
    const participantproducts = {
      participantproductid : newProductData['docid'],
      productref : newProductData.productref
    }
    pjpData['participantproducts'].push(participantproducts);
    pjpData['productref'].push(newProductData.productref);

    //updating journeyproductpurchase
    jppData['productref'].push(newProductData.productref);

    batch.set(ppdocRef,newProductData);
    batch.set(pjpRef,pjpData,{merge:true});
    batch.set(jppRef,jppData,{merge:true});

    batch.commit().then(()=>{
      console.log("Batch Updated Successfully");
    }).catch((error)=>{
      console.log('Batch Error',error);
    });
  } catch (error) {
    console.log("Error Adding New Product")
    console.log(error)
  }
}

// Start Next Delivery Item
exports.startParticipantNextDeliverySequence = onDocumentUpdated("deliverables/{id}", async (change) => {
  let snapshot  = change.data
  let oldDoc = snapshot.before.exists ? snapshot.before.data() : {}
  let newDoc = snapshot.after.exists ? snapshot.after.data() : {}
  let deliveryData = newDoc;
  let newDocRef = snapshot.after.ref;
  console.log("NEW DOC STATUS", oldDoc['status'], "-", newDoc['status'], newDocRef.path);

  // Update Delivery Sequence for Double Checking
  await admin.firestore().collection("participantdeliverysequence").doc(newDoc['profileid']).get().then(async participantDeliverySequenceSnap => {
    let participantData = participantDeliverySequenceSnap.data();
    let productIndex = participantData['products'].findIndex( e => e['participantproductid'] === newDoc['participantproductid'])
    if(productIndex != -1){
      var productDelivery = participantData['products'][productIndex]['delivery'] || []
      let deliverySequenceIndex = productDelivery.findIndex( e => e['sequenceref'].path === newDocRef.path)
      if(deliverySequenceIndex != -1){
        participantData['products'][productIndex]['delivery'][deliverySequenceIndex]["status"] = newDoc['status']
        console.log("Batch update Delivery Sequence")
        await admin.firestore().doc(participantDeliverySequenceSnap.ref.path).update({
          products: participantData['products']
        })
      }
    }
  })

  
  // Ongoing Delivery
  if(oldDoc['status'] != newDoc['status'] && newDoc['status'] == "ongoing"){
    if(newDoc["type"] == "appointment"){
      await admin.firestore().collection("participantsproduct").doc(newDoc["participantproductid"]).update({
        status: "ongoing",
        mode: "Priority Mode",
        nextmode: "Integration Mode",
        nextmodedate: null
      })
    }
  }

  // Start Delivery
  if(oldDoc['status'] != newDoc['status'] && newDoc['status'] == "ready"){
    console.log("New Deliverable changed into ready");

    var participantProductData = {}
    await admin.firestore().collection("participantsproduct").doc(deliveryData["participantproductid"]).get().then(productQuery =>{
      if(productQuery.exists){
        participantProductData = productQuery.data()
      }
    })

    var fileRef = null
    var eventTime = {
      startdate: null,
      enddate: null
    }
    var productData = null
    if(["queue", "event", "fieldwork"].includes(deliveryData["type"])){
      const productRef = admin.firestore().doc(participantProductData['productref'].path);
      productData = (await productRef.get()).data()
    }
    if(deliveryData["type"] == "event" || deliveryData["type"] == "fieldwork"){
      console.log("Delivery Type 1", deliveryData["type"])
      await admin.firestore().collection("event participation request").where("participantproductid", "==", participantProductData["docid"]).get().then(async requestQuery =>{
        if(requestQuery.docs.length != 0){
          fileRef = requestQuery.docs[0].ref
          await admin.firestore().doc(participantProductData['eventref'].path).get().then(eventSnap =>{
            var eventData = eventSnap.data()
            eventTime.startdate = eventData["start_date"].toDate()
            eventTime.enddate = eventData["end_date"].toDate()
          })
        }
      })
    }
    else if (deliveryData["type"] == "queue") {
      console.log("Delivery Type 2", deliveryData["type"]);
    
      const queueTokenRef = admin.firestore().collection("queue_token");
      const profileRef = admin.firestore().collection("profile_data").doc(participantProductData['profileid']);
      const profileData = (await profileRef.get()).data();
      const queueRef = admin.firestore().doc(participantProductData['eventref'].path);
      const queueData = (await queueRef.get()).data();
    
      eventTime.startdate = queueData["queuestartdate"].toDate();
      eventTime.enddate = queueData["queueenddate"].toDate();
    
      const queueId = participantProductData['eventref'].id;
      const counterRef = admin.firestore().collection("queue_token_counter").doc(queueId);
    
      let tokenCreated = false;
      let attempts = 0;
      const maxAttempts = 10; 
      const deliveryRef = newDocRef.path; 
    
      while (!tokenCreated && attempts < maxAttempts) {
        attempts++;
        console.log(`Token creation attempt ${attempts} for delivery: ${deliveryRef}`);
        
        try {
          await admin.firestore().runTransaction(async (transaction) => {
            // Check capacity first (most efficient)
            const activeTokensSnap = await transaction.get(
              queueTokenRef
                .where("queueref", "==", participantProductData['eventref'])
                .where("stagestatus", "==", "Approved")
                .where("tokenstatus", "==", "Active")
            );
    
            const totalActiveTokens = activeTokensSnap.size;
            const queueCapacity = queueData["totalcapacity"] || 999;
    
            if (totalActiveTokens >= queueCapacity) {
              console.log(`Queue capacity reached: ${totalActiveTokens}/${queueCapacity}`);
              tokenCreated = true; 
              return;
            }
    
            // Get current counter
            const counterSnap = await transaction.get(counterRef);
            let currentValue = 0;
    
            if (counterSnap.exists) {
              currentValue = counterSnap.data().value || 0;
            } else {
              console.log(`Initializing counter for queue: ${queueId}`);
              // Initialize counter
              const lastTokenSnap = await transaction.get(
                queueTokenRef.orderBy("tokennumber", "desc").limit(1)
              );
              if (!lastTokenSnap.empty) {
                currentValue = lastTokenSnap.docs[0].data().tokennumber || 0;
              }
              console.log(`Counter initialized with value: ${currentValue}`);
            }
    
            const tokenno = currentValue + 1;
            console.log(`Assigning token number: ${tokenno} to delivery: ${deliveryRef}`);
    
            // Update counter first
            transaction.set(counterRef, { 
              value: tokenno, 
              lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
              lastDelivery: newDocRef 
            }, { merge: true });
    
            // Create token
            const newTokenRef = queueTokenRef.doc();
            const firststage = queueData["stages"] && queueData["stages"].length > 0 ? queueData["stages"][0] : "default";
            const profilename = profileData["name"] || "Unknown";
            const productname = productData["product"] || "Unknown";
            const queuename = queueData["queuename"] || "Unknown";
    
            const tokenData = {
              docid: newTokenRef.id,
              tokennumber: tokenno,
              profile_name: profilename,
              profile_id: participantProductData['profileid'],
              currentstage: firststage,
              quicknotes: null,
              people_involved: null,
              tokenstatus: 'Active',
              productref: participantProductData['productref'],
              productname: productname,
              createdon: admin.firestore.Timestamp.now(),
              queueref: participantProductData['eventref'],
              queuename: queuename,
              stagestatus: 'Approved',
              denynote: null,
              logdate: admin.firestore.Timestamp.now(),
              variationid: participantProductData['queuevariationid'] || null,
              deliveryRef: newDocRef, // For tracking
              participantproductid: participantProductData["docid"], // For tracking
              createdAttempt: attempts
            };

            if(participantProductData["requestedslot"]){
              tokenData["selectedstageslot"] = {}
              tokenData["selectedstageslot"][participantProductData["requestedslot"]["stagename"]] = participantProductData["requestedslot"]
            }
    
            transaction.set(newTokenRef, tokenData);
            fileRef = newTokenRef;
            tokenCreated = true;
    
            console.log(`✅ Queue token ${tokenno} created successfully for delivery: ${deliveryRef}`);
          });
    
        } catch (error) {
          console.log(`❌ Transaction attempt ${attempts} failed for delivery ${deliveryRef}:`, error.message);
          
          if (attempts >= maxAttempts) {
            console.error(`🚨 FAILED to create token after ${maxAttempts} attempts for delivery: ${deliveryRef}`);
            
            // Log the failure to a collection for debugging
            // try {
            //   await admin.firestore().collection("token_creation_failures").add({
            //     deliveryRef: deliveryRef,
            //     queueId: queueId,
            //     participantId: participantProductData['profileid'],
            //     error: error.message,
            //     attempts: attempts,
            //     timestamp: admin.firestore.FieldValue.serverTimestamp()
            //   });
            // } catch (logError) {
            //   console.error("Failed to log error:", logError);
            // }
            break;
          }
          
          // Better exponential backoff with jitter
          const baseDelay = 50; // Start with 50ms
          const maxDelay = 3000; // Max 3 seconds
          const jitter = Math.random() * 100; // Add randomness
          const delay = Math.min(baseDelay * Math.pow(2, attempts) + jitter, maxDelay);
          
          console.log(`⏳ Retrying in ${delay.toFixed(0)}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    

    // Update Event FileRef - Mode
    if(fileRef != null){
      console.log("Got File Ref", fileRef.path)
      var batch = admin.firestore().batch()
      console.log("Batch update Deliverable Ongoing")
      batch.update(newDocRef, {
        fileref: admin.firestore.FieldValue.arrayUnion(fileRef),
        status: "ongoing"
      })

      await admin.firestore().collection("participantdeliverysequence").doc(newDoc['profileid']).get().then(async participantDeliverySequenceSnap => {
        let participantData = participantDeliverySequenceSnap.data();
        let productIndex = participantData['products'].findIndex( e => e['participantproductid'] === newDoc['participantproductid'])
        if(productIndex != -1){
          var productDelivery = participantData['products'][productIndex]['delivery'] || []
          let deliverySequenceIndex = productDelivery.findIndex( e => e['sequenceref'].path === newDocRef.path)
          if(deliverySequenceIndex != -1){
            participantData['products'][productIndex]['delivery'][deliverySequenceIndex]["status"] = "ongoing"
            console.log("Batch update Delivery Sequence")
            batch.update(participantDeliverySequenceSnap.ref, {
              products: participantData['products']
            })
          }
        }
      })

      // Calculate Event Mode
      var currentDate = new Date()
      var eventStartDate = eventTime.startdate
      var eventEndDate  = eventTime.enddate
      console.log("Event Date",  eventStartDate, eventEndDate)
      var newMode = null
      var nextmode = null
      var nextmodedate = null;
      if(eventStartDate >= currentDate){
        let diff = Math.abs(eventStartDate.getTime() - currentDate.getTime())
        let days = Math.ceil(diff/(1000*3600*24))
        console.log("diff in days", days);
        if(days > 30){
          newMode = "Early Preparation Mode"
          nextmode = "Preparation Mode"
          nextmodedate = new Date(eventStartDate)
          nextmodedate.setDate(eventStartDate.getDate() - 30)
          // new Date(new Date(currentDate).setDate(new Date(eventStartDate).setDate(eventStartDate.getDate() - 30)))
        }
        else if(days >= 1 && days <= 30){
          newMode = "Preparation Mode"
          nextmode = productData["mode"]
          nextmodedate = eventStartDate
        }
        else{
          newMode = productData["mode"]
          nextmode = "Integration Mode"
          nextmodedate = new Date(eventEndDate)
          nextmodedate.setDate(eventEndDate.getDate() + 1)
          // new Date(new Date(currentDate).setDate(new Date(eventEndDate).setDate(eventEndDate.getDate() + 1)))
        }
      }
      else{
        if(currentDate <= eventEndDate){
          newMode = productData["mode"]
          nextmode = "Integration Mode"
          nextmodedate = new Date(eventEndDate)
          nextmodedate.setDate(eventEndDate.getDate() + 1)
          // new Date(new Date(currentDate).setDate(new Date(eventEndDate).setDate(eventEndDate.getDate() + 1)))
        }
      }
      if(newMode != null){
        batch.update(admin.firestore().collection("participantsproduct").doc(deliveryData["participantproductid"]), {
          mode: newMode,
          nextmode: nextmode,
          nextmodedate: nextmodedate,
          status: "ongoing",
          "statusdate.ongoing": admin.firestore.FieldValue.serverTimestamp()
        })
      }
      await batch.commit().then(() =>{
        console.log("Successfully initiated Product.", participantProductData["docid"])
      })
    }
  }

  if (newDoc && newDoc['fileref'] && newDoc['fileref'].length != 0) {
    for (let i = 0; i < newDoc['fileref'].length; i++) {
      const element = newDoc['fileref'][i];

      var map = {
        'deliveryRef': newDocRef,
      }

      if (newDoc['participantproductid']) {
        map['participantproductid'] = newDoc['participantproductid'];
      }

      element.update(map).catch(err =>
        console.error('Failed to update:', err)
      );
    }
  }

  // Delivery Activity Completed
  if(oldDoc['status'] != newDoc['status'] && newDoc['status'] == "completed"){
    // Check Next Delivery
    await admin.firestore().collection("participantdeliverysequence").doc(newDoc['profileid']).get().then(async participantDeliverySequenceSnap => {
      let participantData = participantDeliverySequenceSnap.data();
      let productIndex = participantData['products'].findIndex( e => e['participantproductid'] === newDoc['participantproductid'])
      if(productIndex != -1){
        var productDelivery = participantData['products'][productIndex]['delivery'] || []
        let deliverySequenceIndex = productDelivery.findIndex( e => e['sequenceref'].path === newDocRef.path)
        if(deliverySequenceIndex != -1){
          var batch = admin.firestore().batch()
          participantData['products'][productIndex]['delivery'][deliverySequenceIndex]["status"] = "completed"
          // Start Next Delivery
          if((deliverySequenceIndex + 1) < productDelivery.length){
            var nextDeliveryItem = participantData['products'][productIndex]['delivery'][deliverySequenceIndex + 1]
            nextDeliveryItem["status"] = "ready"
            batch.update(participantDeliverySequenceSnap.ref, {
              products: participantData['products']
            })
            batch.update(nextDeliveryItem["sequenceref"], {
              status: "ready"
            })
            await batch.commit().then(() => {
              console.log("Next Delivery Activity is marked Ready.", newDocRef.path)
            })
          }
          else{
            batch.update(admin.firestore().collection("participantsproduct").doc(newDoc["participantproductid"]), {
              status: "completed"
            })
            await batch.commit().then(() => {
              console.log("Last Delivery Activity Completed.", newDocRef.path)
            })
          }
        }
      }
    })
  }
});


exports.participantJourneyproductSocialcommitupdate = onRequest(async (req, res) => {
  console.log(req)
  console.log(req.params);
  console.log(req.query);
  var profileid = req.query.profileid
  var purchaseid = req.query.purchaseid
  var participantpurchase 
  var participantpurchaseid
  console.log("profileid",profileid,"purchaseid",purchaseid);
  if(profileid != null || profileid != undefined || purchaseid != undefined ||  purchaseid != null){
    await admin.firestore().collection('journeyproductpurchase').where('profileid', '==', profileid).where('watsonpurchaseid', '==', purchaseid).get().then(res => {
      for(let i=0; i< res.docs.length; i++){
        participantpurchase = res.docs[i].data()
      }
      console.log(participantpurchase['participantjourneyproductref'].id)
      participantpurchaseid = participantpurchase['participantjourneyproductref'].id
    })
    await admin.firestore().collection('participantjourneyproduct').doc(participantpurchaseid).update({
      socialcommit: 'received',
      paymentmadeby : 'nach'
    })
  }
  // cors(req, res, async () => {
  //   // Your Cloud Function code here
  //   let participantdata = JSON.parse(req.body)
  //   console.log(participantdata);
  //   var participantpurchase 
  //   var participantpurchaseid
  //   await admin.firestore().collection('journeyproductpurchase').where('profileid', '==', participantdata['profileid']).where('watsonpurchaseid', '==', participantdata['purchaseid']).get().then(res => {
  //     for(let i=0; i< res.docs.length; i++){
  //      participantpurchase = res.docs[i].data()
  //     }
  //     console.log(participantpurchase['participantjourneyproductref'].id)
  //     participantpurchaseid = participantpurchase['participantjourneyproductref'].id
  //  })
  //  await admin.firestore().collection('participantjourneyproduct').doc(participantpurchaseid).update({
  //    socialcommit: 'received',
  //    paymentmadeby : 'nach'
  //  })
  // })
})


