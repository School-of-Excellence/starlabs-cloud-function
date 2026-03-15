const admin = require('firebase-admin');
//components imports
const commonService = require('./service');
// v2 functions
const { onDocumentCreated , onDocumentWritten , onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const https = require('https'); // HTTP Request/Response
var IncomingWebhook = require('@slack/client').IncomingWebhook;


exports.salesCRMConvertedLeads = onRequest({
  maxInstances: 5,
  memory: "512MiB",
  timeoutSeconds: 300,
  cors: true,
	invoker: "public"
}, async (req, res) => {
  try {
    // Explicit CORS headers for additional safety
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    let leaddata = req.body;
    console.log("Received leaddata:", leaddata);

    if (leaddata['initiated'] != null && leaddata['initiated'] != undefined) {
      await admin.firestore().collection("profile_data").where('email', '==', leaddata['initiated']['email']).get().then(async snap => {
        console.log("length", snap.docs.length, snap.empty);
        if (snap.docs.length === 0) {
          console.log("email not exist");
          res.status(200).json({ data: 'notexist' });
        } else {
          console.log("email exist");
          let profileid = snap.docs[0].data()['profileid'];
          let isJourneyThere = false;
            
          await admin.firestore().collection("journeyproductpurchase").where('profileid', '==', profileid).get().then(async jppsnap => {
            if (jppsnap.docs.length != 0) {
              isJourneyThere = true;
            }
          });
          res.status(200).json({ data: 'exist', journey: isJourneyThere });
        }
      });

    } else if (leaddata['completed'] != null && leaddata['completed'] != undefined) {
      // Fixed: Use && instead of ||
      if (leaddata['completed']['email'] != null && leaddata['completed']['email'] != undefined) {
        console.log("completed", leaddata['completed']);
        await admin.firestore().collection("salesleads").doc(leaddata['completed']['docid']).get().then(async (saleleadsnap) => {
          if (saleleadsnap.exists) {
            console.log("Exist in salesleads");
            const status = saleleadsnap.data()['status'];
            
            if (status != "Approved" || status == "Rejected") {
              console.log("status", status, "onupdate");
              await commonService.updateSalesLead(leaddata, true).then(() => {
                res.status(200).json({ data: 'updated' });
                console.log(leaddata['completed']['journeytype'], "customer data submitted successfully");
              }).catch(err => { 
                console.log(err);
                res.status(500).json({ error: 'Update failed' });
              });
            } else {
              // Status is "Approved" and not "Rejected"
              res.status(200).json({ data: 'already_approved' });
            }
          } else {
            console.log("Not Exist in salesleads");
            await commonService.updateSalesLead(leaddata, false).then(async () => {
              res.status(200).json({ data: 'created' });
              console.log(leaddata['completed']['journeytype'], "customer data submitted successfully");
              await commonService.sendSalesCaptureToSalesChannel(leaddata['completed']);
            }).catch(err => { 
              console.log(err);
              res.status(500).json({ error: 'Creation failed' });
            });
          }
        });
      } else {
        res.status(400).json({ data: 'error', message: 'Email is required in completed data' });
      }
    } else {
      console.log("there is error in sending data");
      res.status(400).json({ data: 'error', message: 'Invalid data format' });
    }
  } catch (error) {
    console.error("Error in salesCRMConvertedLeads:", error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

exports.updateJourneyDataToSalesCRM = onDocumentWritten('journey/{journeyid}', async (change) => {
  console.log("Function Triggered");
	let newdoc = change.data.after.data();
	var url;
	if (commonService.production) {
		url = "https://us-central1-salesleadcrm.cloudfunctions.net/getJourneyDataFromStarlabs"
	} else {
		url = "https://us-central1-salescrm-test-19.cloudfunctions.net/getJourneyDataFromStarlabs"
	}

	const options = {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(newdoc)
	};

	await fetch(url, options).then((response) => {
		console.log(response.status, 'Data Sent Successfully')
	}).catch((error) => {
		console.error(error, 'Error while sending data')
	});
});

exports.updateProductDataToSalesCRM = onDocumentWritten('products/{id}', (change) => {
	let newdoc = change.data.after.data();

	var url
	if (commonService.production) {
		url = "https://us-central1-salesleadcrm.cloudfunctions.net/getProductDataFromStarlabs"
	} else {
		url = "https://us-central1-salescrm-test-19.cloudfunctions.net/getProductDataFromStarlabs"
	}

	const options = {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(newdoc)
	};

	fetch(url, options).then((response) => {
		console.log(response.status, 'Data Sent Successfully')
	}).catch((error) => {
		console.error(error, 'Error while sending data')
	});
});

exports.updateJourneyProductDataToSalesCRM = onDocumentWritten('journey-to-product/{id}', (change) => {
  let newdoc = change.data.after.data();
  const docId = change.data.after.id;

  const dataToSend = {
    ...newdoc,
    id: docId
  };

  Object.keys(dataToSend).forEach(key => {
    const value = dataToSend[key];

    if (value && typeof value === 'object' && value.path) {
      const pathParts = value.path.split('/');
      dataToSend[key] = pathParts[pathParts.length - 1]; 
    }

    if (Array.isArray(value)) {
      dataToSend[key] = value.map(item => {
        if (item && typeof item === 'object' && item.path) {
          const pathParts = item.path.split('/');
          return pathParts[pathParts.length - 1];
        }
        return item;
      });
    }
  });

  var url;
  if (commonService.production) {
    url = "https://us-central1-salesleadcrm.cloudfunctions.net/getJourneyProductDataFromStarlabs";
  } else {
    url = "https://us-central1-salescrm-test-19.cloudfunctions.net/getJourneyProductDataFromStarlabs";
  }

  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(dataToSend)
  };

  fetch(url, options)
    .then((response) => {
      console.log(response.status, 'Data Sent Successfully');
    })
    .catch((error) => {
      console.error(error, 'Error while sending data');
    });
});

exports.updatePackageDesignDataToSalesCRM = onDocumentWritten('package design/{packagedesignid}', (change) => {
	let newdoc = change.data.after.data();
	var url
	if (commonService.production) {
		url = "https://us-central1-salesleadcrm.cloudfunctions.net/getPackageDataFromStarlabs?data="
	} else {
		url = "https://us-central1-salescrm-test-19.cloudfunctions.net/getPackageDataFromStarlabs?data="
	}
	console.log("http", url);
	var sendData = url + JSON.stringify(newdoc);
	https.get(sendData, (response) => {
		console.log(response);
	})
});

exports.salesCaptureSlackIntegration = onRequest({region: "us-central1", cors:true},async (req,res) => {
// functions.https.onRequest(async (req,res) => {
//   cors(req, res, async () => {
    console.log("string",req.query.data);
    let leaddata = JSON.parse(req.query.data)
    console.log("sending slack message initiated");
    console.log(leaddata);
    var mapJourney = {}
    var mapProduct = {}
    await admin.firestore().collection("journey").get().then(async journeysnap => {
      for (let i = 0; i < journeysnap.docs.length; i++) {
        const journeyelement = journeysnap.docs[i].data();
        mapJourney[journeyelement['id']]=journeyelement['journey']
      }
    })
    await admin.firestore().collection("products").get().then(async productsnap => {
      for (let i = 0; i < productsnap.docs.length; i++) {
        const productelement = productsnap.docs[i].data();
        mapProduct[productelement['id']]=productelement['product']
      }
    })
    //
    let addonarray = []
    for (let i = 0; i < leaddata['addons'].length; i++) {
      addonarray.push(mapProduct[leaddata['addons'][i]])
    }
    let arraybonus  = []
    for (let i = 0; i < leaddata['bonus'].length; i++) {
      arraybonus.push(mapProduct[leaddata['bonus'][i]])
    }
    //concantenating slack message
    let message = {
        "blocks": [
          {
            "type": "divider"
          },
          {
            "type": "header",
            "text": {
              "type": "plain_text",
              "text": `Sales Capture : ${leaddata['journeytype']}`
            }
          },
          {
            "type": "section",
            "text": {
              "type": "plain_text",
              "text": `Name : ${leaddata['name']}`
            }
          },
          {
            "type": "section",
            "text": {
              "type": "plain_text",
              "text": `Email : ${leaddata['email']}`
            }
          },
          {
            "type": "section",
            "text": {
              "type": "plain_text",
              "text": `Mobile : ${leaddata['mobile']}`
            }
          },
          {
            "type": "section",
            "text": {
              "type": "plain_text",
              "text": `Journey : ${mapJourney[leaddata['journey']]}`
            }
          },
          {
            "type": "section",
            "text": {
              "type": "plain_text",
              "text": `Addons : ${addonarray.join()}`
            }
          },
          {
            "type": "section",
            "text": {
              "type": "plain_text",
              "text": `Bonus : ${arraybonus.join()}`
            }
          },
          {
            "type": "section",
            "text": {
              "type": "plain_text",
              "text": `Total Purchase Value : ${leaddata['totalpurchasevalue']}`
            }
          },
          {
            "type": "section",
            "text": {
              "type": "plain_text",
              "text": `Initial payment : ${leaddata['initialpayment']}`
            }
          },
          {
            "type": "section",
            "text": {
              "type": "plain_text",
              "text": `Installment Amount : ${leaddata['installmentamount']}`
            }
          },
          {
            "type": "section",
            "text": {
              "type": "plain_text",
              "text": `Purchase Date : ${leaddata['purchasedate'].substring(0,10)}`,
            }
          },
          {
            "type": "section",
            "text": {
              "type": "plain_text",
              "text": `Sales Person : ${leaddata['salespersonname']}\n`,
            }
          },
          {
            "type": "image",
            "image_url":`${leaddata['paymentsnapshot']}`,
            "alt_text": "inspiration"
          }
        ]
      }
    //
    var url
    if(commonService.production){
      url = commonService.slackSaleCapture // Production
    }
    else{
      url = commonService.slackDevTest // Test
    }
    console.log("slack message",message);
    var webhook = new IncomingWebhook(url);
    webhook.send(message,function(err, header, statusCode, body) {
      if (err) {
        console.log('Error:', err);
      } else {
        res.send(true)
        console.log('Received', statusCode, 'from Slack');
      }
    });
//   })
});

exports.sendSlackNotificationSaleRejection = onDocumentUpdated({document:'salesleads/{id}',region: 'us-central1', cors: true},async (change) => {
// functions.firestore.document("salesleads/{id}").onUpdate(async (change) => {
  var beforeData = change.data?.before.data();
  var afterData = change.data?.after.data();
  if(afterData['status'] == 'Rejected'){
    let leaddata = afterData
    console.log("sending slack message initiated");
    console.log(leaddata);
    var mapJourney = {}
    var mapProduct = {}
    await admin.firestore().collection("journey").get().then(async journeysnap => {
      for (let i = 0; i < journeysnap.docs.length; i++) {
        const journeyelement = journeysnap.docs[i].data();
        mapJourney[journeyelement['id']]=journeyelement['journey']
      }
    })
    await admin.firestore().collection("products").get().then(async productsnap => {
      for (let i = 0; i < productsnap.docs.length; i++) {
        const productelement = productsnap.docs[i].data();
        mapProduct[productelement['id']]=productelement['product']
      }
    })
    //
    let addonarray = []
    for (let i = 0; i < leaddata['addons'].length; i++) {
      addonarray.push(mapProduct[leaddata['addons'][i]])
    }
    let arraybonus  = []
    for (let i = 0; i < leaddata['bonus'].length; i++) {
      arraybonus.push(mapProduct[leaddata['bonus'][i]])
    }
    //concantenating slack message
    let message = {
      "blocks": [
        {
          "type": "divider"
        },
        {
          "type": "header",
          "text": {
            "type": "plain_text",
            "text": `Sales Rejected : ${leaddata['journeytype']}`
          }
        },
        {
          "type": "section",
          "text": {
            "type": "plain_text",
            "text": `Name : ${leaddata['name']}`
          }
        },
        {
          "type": "section",
          "text": {
            "type": "plain_text",
            "text": `Email : ${leaddata['email']}`
          }
        },
        {
          "type": "section",
          "text": {
            "type": "plain_text",
            "text": `Mobile : ${leaddata['phonenumber']}`
          }
        },
        {
          "type": "section",
          "text": {
            "type": "plain_text",
            "text": `Journey : ${![null,undefined].includes(leaddata['journey']) ? mapJourney[leaddata['journey']] : null}`
          }
        },
        {
          "type": "section",
          "text": {
            "type": "plain_text",
            "text": `Addons : ${addonarray.join()}`
          }
        },
        {
          "type": "section",
          "text": {
            "type": "plain_text",
            "text": `Bonus : ${arraybonus.join()}`
          }
        },
        {
          "type": "section",
          "text": {
            "type": "plain_text",
            "text": `Sales Person : ${leaddata['salespersonname']}\n`,
          }
        },
        {
          "type": "section",
          "text": {
            "type": "plain_text",
            "text": `Rejected Reason : ${leaddata['rejectnotes']}\n`,
          }
        },
      ]
    }
    //
    var url
    if(commonService.production){
      url = commonService.slackSaleRejection // Production
    }
    else{
      url = commonService.slackDevTest // Test
    }
    console.log("slack message",message);
    var webhook = new IncomingWebhook(url);
    webhook.send(message,function(err, header, statusCode, body) {
      if (err) {
        console.log('Error:', err);
      } else {
        // context.send(true)
        console.log('Received', statusCode, 'from Slack');
      }
    });
  }

  // timeline log
  if(beforeData['status'] != afterData['status'] && afterData['status'] == 'Approved'){
    let touchpoint = "";
    switch (afterData['journeytype']) {
      case 'upgrade':
        touchpoint = 'Sale Upgrade';
        break;
      case 'downgrade':
        touchpoint = 'Sale Downgrade';
        break;
      case 'cancelled':
        touchpoint = 'Sale Cancelled';
        break;
      case 'addons':
        touchpoint = 'Addon Purchased';
        break;
      default:
        touchpoint = 'New Sale';
    }

    var journeyname = ""
    var addonsName = ""
    if(afterData["journey"]){
      await admin.firestore().collection("journey").doc(afterData["journey"]).get().then(journeyDoc =>{
        if(journeyDoc.exists){
          journeyname = journeyDoc.data()["journey"]
        }
      })
    }
    else if((afterData["addons"] || []).length != 0){
      await admin.firestore().collection("products").where("id", "in", afterData["addons"]).get().then(productList =>{
        var namelist = []
        for (let i = 0; i < productList.docs.length; i++) {
          const productData = productList.docs[i].data();
          if(!namelist.includes(productData["product"])) namelist.push(productData["product"])
        }
      addonsName = namelist.join(", ")
      })
    }
    
    await commonService.updateParticipantTouchPoint({
      label: `${touchpoint}: ${journeyname ||addonsName}`,
      notes: "",
      touchpoint: touchpoint,
      touchpointdate: afterData['purchasedate'].toDate(),
      profileid: afterData["profileid"],
      parentreference: change.data.after.ref,
      metadata: {
        journey: afterData["journey"] || null,
        addons: afterData["addons"] || null,
        bonus: afterData["bonus"] || null
      }
    })

    /*
    const bonusRefs = afterData['bonus'].map(bonusid => 
      admin.firestore().collection('products').doc(bonusid)
    );
    const addonRef = afterData['addons'] && afterData['addons'].length > 0 ? admin.firestore().collection('products').doc(afterData['addons'][0]) : null;
    const journeyRef = afterData['journey'] ?  admin.firestore().collection('journey').doc(afterData['journey']) : null;
    let activityname;
    switch (afterData['journeytype']) {
      case 'upgrade':
        activityname = 'saleupgraded';
        break;
      case 'downgrade':
        activityname = 'saledowngraded';
        break;
      case 'cancelled':
        activityname = 'salecancelled';
        break;
      case 'addons':
        activityname = 'salepurchased';
        break;
      default:
        activityname = 'salepurchased';
    }

    var data = {
      activityname : activityname,
      addonproductref : addonRef,
      journeyref : journeyRef,
      logid : afterData['docid'],
      activitydate : afterData['purchasedate'],
      bonusproductref : bonusRefs,
      created : new Date(),
      profileid : afterData['profileid'],
      leadsref : admin.firestore().collection('salesleads').doc(afterData['docid'])
    }
    console.log(data);
    const docRef = admin.firestore().collection('timeline log').doc(afterData['docid']);
    await docRef.set(data);
    */
  }
});

exports.salesCRMProfilestatus = onRequest(async (req, res) => {
  console.log("captureddate",req.query);
  
  const paymentPlans = ['bulk', 'enach', 'enach-axis', 'enach-icici', 'fully paid', 'pdc','manual', 'razorpay','manual','none'];
  const profilestatus = req.query.profilestatus;
  const paymentplanassureddate = ![null,undefined,''].includes(req.query.paymentplanassureddate) ? new Date(req.query.paymentplanassureddate) : null;
  const docid = req.query.participantjourneyproductid;
  const paymentid = req.query.paymentid;
  const salesleaddocid = req.query.docid;

  console.log('Received profilestatus:', profilestatus);
  console.log('Received docid:', docid);

  if (!docid) {
    return res.status(400).send("Missing required query parameter: participantjourneyproductid");
  }

  // Modified check for profilestatus to explicitly handle empty string
  if (profilestatus === undefined) {
    return res.status(400).send("Missing required query parameter: profilestatus");
  }

  if (paymentPlans.includes(profilestatus)) {
    try {
      console.log(`Updating profile status to '${profilestatus}' for document ID '${docid}'`);
      
      await admin.firestore().collection("participantjourneyproduct").doc(docid).update({
        paymentplan: profilestatus === 'none' ? null : profilestatus,
        paymentplanassureddate: profilestatus === 'none' ? null : paymentplanassureddate
      });

      await admin.firestore().collection("salesleads").doc(salesleaddocid).update({
        paymentplan: profilestatus === 'none' ? null : profilestatus,
        paymentplanassureddate: profilestatus === 'none' ? null : paymentplanassureddate
      });        

      console.log('Update completed successfully');
      res.status(200).send("Profile status updated successfully.");
    } catch (error) {
      console.error("Error updating profile status:", error);
      res.status(500).send("Error updating profile status: " + error.message);
    }
  } else {
    console.log('Invalid profile status:', profilestatus);
    res.status(400).send("Invalid profile status.");
  }
});