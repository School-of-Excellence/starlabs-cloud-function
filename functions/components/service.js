const admin = require('firebase-admin');

const { Timestamp } = require('firebase-admin/firestore');
// Process Imports
const process = require("process") // NodeJS Process

// Get the current Firebase project ID
const projectId = process.env.GCLOUD_PROJECT;

// Define your production project ID(s)
const PRODUCTION_PROJECTS = ['fir-sample-aae4a']; // <-- replace with your real project ID

// Compute the production flag
const production = PRODUCTION_PROJECTS.includes(projectId);

console.log(`Project ID: ${projectId}`);
console.log(`Production Mode: ${production}`);

// Initialize App
admin.initializeApp({
	storageBucket: production == false ? "gs://starlabs-test.firebasestorage.app/" : "gs://fir-sample-aae4a.appspot.com"
});

const bucket = admin.storage().bucket()
const {Buffer} = require("buffer");
const https = require('https'); // HTTP Request/Response

const KJUR = require('jsrsasign');

const monthName = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];

// Post Mark
const postmark = require("postmark");
const postmarkClient = new postmark.ServerClient(production ? "67d8b50e-1208-4913-8265-695f57e43939" : '70e65ec0-ddd4-49fe-908b-24838ff4a8f7'); // Postmark email:

// Event wati Server ID
const eventWatiServerId = '101723';

const axios = require("axios"); // Promise based HTTP Client

var IncomingWebhook = require('@slack/client').IncomingWebhook; // Slack Webhook

async function getWebhookUrl(docid) {
	try {
		const doc = await admin.firestore().collection('slack webhookurls').doc(docid).get();
		if (!doc.exists) {
			console.log(`[getWebhookUrl] No webhook found for docid: ${docid}`);
			return null;
		}
		const url = doc.data()["webhookurl"];
		if (!url) {
			console.log(`[getWebhookUrl] webhookurl field missing for docid: ${docid}`);
			return null;
		}
		return url;
	} catch (error) {
		console.log(`[getWebhookUrl] failed for ${docid}:`, error);
		return null;
	}
}

// Split Array into Multiple Array
function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

// Save Notification Record
async function saveNotificationRecord({title = "", message = "", subtitle = null, date = "", notificationimage = null, notificationtype = null, landingpage = null, sticky = false, logged = false, metadata = {}, profileid = []}){
    console.log('Save notification runnning');
	var docid = admin.firestore().collection("notificationrecord").doc().id
    var notificationRecordData = {
    title: title,
    message: message,
    subtitle: subtitle,
    date: date,
    notificationimage: notificationimage,
    notificationtype: notificationtype,
    landingpage: landingpage,
    sticky: sticky,
    logged: logged,
    metadata: metadata,
    profileid: profileid,
    success: false
  }
  await admin.firestore().collection("notificationrecord").doc(docid).set(notificationRecordData).then(() =>{
    console.log("Notification Record Saved");
  }).catch(err =>{
    console.log("Unable to store Notification Record", err)
  })
}

function convertDate(date) {
  var event = date.toISOString();
  event = event.split("T")[0];
  event = event.split("-");
  event = event.join("");
  console.log(event)
  return event;
}

async function uploadImageFromUrl(fileURL, filename) {  
  try {
    // Fetch the file using https
    const fileData = await fetchFile(fileURL);
    
    // Create a file name and upload to Firebase Storage
    const fileName = filename;
    const file = bucket.file(fileName);
    await file.save(fileData, {
      metadata: { 
        contentType: getMimeType(fileURL)
      },
    });
    // Generate a signed URL
    const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/chatmedia/${encodeURIComponent(fileName)}?alt=media`;
    console.log("Uploaded file URL:", publicUrl);
    return publicUrl;
  } catch (error) {
    console.error("Error:", error);
  }  
}

function fetchFile(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to fetch file: ${response.statusCode}`));
      }
      const data = [];
      response.on("data", (chunk) => data.push(chunk));
      response.on("end", () => resolve(Buffer.concat(data)));
    }).on("error", (error) => reject(error));
  });
}

const getMimeType = (url) => {
  const mimeTypes = {
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip',
    '.gzip': 'application/gzip',
    '.tar': 'application/x-tar',
    '.mp4': 'video/mp4',
    '.avi': 'video/x-msvideo',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  };

  const extension = url.slice(url.lastIndexOf('.')).toLowerCase();
  return mimeTypes[extension] || 'application/octet-stream';
};

async function sendToWhatsappViaWati(data) {

	var apikey = null;
	var serverid = null;
	await admin.firestore().collection("classify").doc("wati").get().then((wati) => {
		if(wati.exists) {
			const watiData = wati.data()[eventWatiServerId]
			apikey = watiData['watitoken'];
			serverid = eventWatiServerId;
		}
	})

	if (apikey != null && serverid != null) {
		const url = `https://live-server-${serverid}.wati.io/api/v1/sendTemplateMessage?whatsappNumber=${data.phonenumber}`;
		const options = {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				Authorization: 'Bearer ' + apikey
			},
			body: JSON.stringify(data.body)
		};

		try {
			console.log('Sending to Wati - URL:', url);
			console.log('Sending to Wati - Body:', JSON.stringify(data.body, null, 2));

			const res = await fetch(url, options);

			console.log('Wati Response Status:', res.status);
			console.log('Wati Response StatusText:', res.statusText);
			console.log('Wati Response OK:', res.ok);
			console.log('Wati Response Content-Type:', res.headers.get('content-type'));

			const text = await res.text();
			console.log('Wati Response Body Length:', text.length);
			console.log('Wati Response Body:', text);

			if (!text) {
				console.log('Empty response from Wati API');
				return {
					success: res.ok,
					status: res.status,
					message: 'Empty response from Wati'
				};
			}

			try {
				const jsonData = JSON.parse(text);
				console.log('Wati Parsed JSON:', jsonData);
				return jsonData;
			} catch (parseError) {
				console.log('Non-JSON response:', text);
				return {
					success: res.ok,
					status: res.status,
					data: text
				};
			}
		} catch (err) {
			console.error('Error sending WhatsApp message:', err);
			throw err;
		}
	}
}

async function throwParticipantMetaDataException(exception){
  let data = {...exception,...{updateddate:new Date()}}
  await admin.firestore().collection('participantmetadata exception').add(data)
}

async function getUnusedZoomAccount() {
  const db = admin.firestore()
  try {
    // First, query for unused accounts
    const querySnapshot = await db.collection('zoomaccount')
      .where("accounttype", "==", "licensed")
      .where('inuse', '==', false)
      .limit(1)
      .get();
    
    if (querySnapshot.empty) {
      console.log('No unused zoom accounts available');
      return null;
    }

    // Get the document reference for the first unused account
    const accountDoc = querySnapshot.docs[0];
    const accountRef = accountDoc.ref;
    console.log("accountDoc.data()['email']",accountDoc.data()['email']);
    
		// Check Queue Live Assignment
    await db.collection("live assignment").where("status","==","live").where("zoomdata.host_email","==",accountDoc.data()['email']).get().then(async livesnap => {
      console.log("livesnap.docs.length Assignment", livesnap.docs.length);
      if(livesnap.docs.length > 0){
        await accountRef.update({inuse:true, useby: livesnap.docs[0].ref.path})
      }
    })

		// Check Appointment
		var currentDate = new Date()
		await db.collection("appointments").where("cancelled", "==", false).where("endtime", ">=", currentDate).where("zoomdata.host_email", "==", accountDoc.data()['email']).get().then(async livesnap => {
      console.log("livesnap.docs.length Appointment", livesnap.docs.length);
      if(livesnap.docs.length > 0){
        await accountRef.update({inuse:true, useby: livesnap.docs[0].ref.path})
      }
    })
    
    // Use a transaction to safely update the account
    return await db.runTransaction(async (transaction) => {
      const accountSnapshot = await transaction.get(accountRef);
      
      if (!accountSnapshot.exists) {
        throw new Error('Account document no longer exists');
      }
      
      const accountData = accountSnapshot.data();
      if (accountData.inuse === true) {
        // Account was claimed by someone else between our query and transaction
        throw new Error('Account already in use');
      }
      
      // Update the account to mark it as in use
      transaction.update(accountRef, { inuse: true })
      console.log(accountRef.id, 'updated');
        
      
      // Return the account data with the updated inuse status
      console.log("accountData.email",accountData.email);
      
      return accountData.email
      
    }).catch(error => {
      // If the transaction fails due to concurrent access, we can retry
      if (error.message === 'Account already in use') {
        console.log('Account was already claimed, retrying...');
        return getUnusedZoomAccount(); // Recursive retry
      }
      throw error;
    });
    
  } catch (error) {
    console.error('Error allocating zoom account:', error);
    throw error;
  }
}

async function generateSignature(key, secret, meetingNumber, role) {
  const iat = Math.round(new Date().getTime() / 1000) - 30
  const exp = iat + 60 * 60 * 2
  const oHeader = { alg: 'HS256', typ: 'JWT' }
  const oPayload = {
    sdkKey: key,
    appKey: key,
    mn: meetingNumber,
    role: role,
    iat: iat,
    exp: exp,
    tokenExp: exp
  }
  const sHeader = JSON.stringify(oHeader)
  const sPayload = JSON.stringify(oPayload)
  const sdkJWT = KJUR.jws.JWS.sign('HS256', sHeader, sPayload, secret)
  return sdkJWT
}

async function generateZoomMeeting({zoomEmail = null, zoomAccountId, zoomClientId, zoomClientSecret, zoomSDkClientId, zoomSDKClientSecret, requestpath}){
	let getZoomAccountEmail
	try {
		getZoomAccountEmail = zoomEmail != null ? zoomEmail : await getUnusedZoomAccount()
		console.log("getZoomAccountEmail", getZoomAccountEmail);

		if (!getZoomAccountEmail) {
      throw new Error("No available Zoom account email found");
    }

		if(![null,undefined].includes(getZoomAccountEmail)){
			var zoomaccountData = {email : getZoomAccountEmail}
			console.log("zoomaccountData['email']", zoomaccountData['email']);

			// Server To Server
			var accountid = zoomAccountId
			var clientid = zoomClientId
			var clientsecret = zoomClientSecret

			const tokenResponse = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountid}&client_id=${clientid}&client_secret=${clientsecret}`, {
				method: 'POST'
			});

			if (!tokenResponse.ok) {
				const errText = await tokenResponse.text();
				throw new Error(`OAuth token request failed: ${tokenResponse.status} - ${errText}`);
			}

			const tokenData = await tokenResponse.json();
			const email = zoomaccountData["email"]; //host email id;
			const zoomresult = await axios.default.post("https://api.zoom.us/v2/users/" + email + "/meetings", {
				"type": 1,
				"start_time": new Date(),
				"timezone": "India",
				"host_email": zoomaccountData["email"],
				"settings": {
					"host_video": true,
					"participant_video": true,
					"cn_meeting": false,
					"in_meeting": true,
					"join_before_host": true,
					"mute_upon_entry": false,
					"watermark": false,
					"use_pmi": false,
					"approval_type": 1,
					"audio": "both",
					// "auto_recording": "local",
					"enforce_login": false,
					"registrants_email_notification": false,
					"waiting_room": true,
					"allow_multiple_devices": true,
				}
			}, {
				headers: {
					'Authorization': 'Bearer ' + tokenData.access_token,
					'content-type': 'application/json'
				}
			});
			let sdkclientid = zoomSDkClientId
			let sdkclientsecret = zoomSDKClientSecret
			let signature  = await generateSignature(sdkclientid,sdkclientsecret,zoomresult.data['id'],1)

			console.log("Update Zoom Account", getZoomAccountEmail)
			await admin.firestore().collection("zoomaccount").where("email", "==", getZoomAccountEmail).get().then(async emailaccount=>{
				var zoombatch = admin.firestore().batch()
				emailaccount.docs.forEach(doc=>{
					zoombatch.update(doc.ref, {
						hostid: zoomresult.data["host_id"],
						inuse : true,
						useby: requestpath
					})
				})
				await zoombatch.commit().then((res) =>{
					console.log("Zoom Batch updated", res)
				}).catch(err =>{
					console.log("Issue updating Zoom Account", err)
				})
			})

			if(zoomresult.data["host_email"] == null || zoomresult.data["host_email"] == undefined){
				zoomresult.data["host_email"] = zoomaccountData["email"]
			}

			await admin.firestore().doc(requestpath).update({
				signature: signature,
      	zoomdata: zoomresult.data,
				zoomerror: null
			})

			return {result: zoomresult, zoomaccount: zoomaccountData, signature: signature}
		}
	}
	catch (error) {
    let errMsg = "Unknown error";

    if (error.response?.data?.message) {
      errMsg = `Zoom API Error: ${error.response.data.message}`;
    } else if (error.response) {
      errMsg = `Zoom API Error: ${error.response.status} ${error.response.statusText}`;
    } else if (error.message) {
      errMsg = error.message;
    } else {
      errMsg = JSON.stringify(error);
    }

    console.error("Zoom Link Not Generated:", errMsg);

    // Try to log in Firestore if requestpath is available
    if (requestpath) {
      try {
        await admin.firestore().doc(requestpath).update({
          zoomerror: errMsg
        });
      } catch (fireErr) {
        console.error("Failed to log error in Firestore:", fireErr.message);
      }
    }

		// Revoke Zoom EMail
		if(getZoomAccountEmail){
			await admin.firestore().collection("zoomaccount").where("email", "==", getZoomAccountEmail).get().then(async emailaccount=>{
				var zoombatch = admin.firestore().batch()
				emailaccount.docs.forEach(doc=>{
					zoombatch.update(doc.ref, {
						hostid: null,
						inuse : false,
						useby: null
					})
				})
				await zoombatch.commit().then((res) =>{
					console.log("Zoom Batch updated", res)
				}).catch(err =>{
					console.log("Issue updating Zoom Account", err)
				})
			})
		}
	}
}

// Function to process salescrm lead - salesCRMConvertedLeads
async function updateSalesLead(leaddata, flag) {
	console.log("Updating salesleads");
	let element = {
		docid: leaddata['completed']['docid'],
		profileid: leaddata['completed']['profileid'],
		name: ![null, undefined].includes(leaddata['completed']['name']) ? leaddata['completed']['name'] : null,
		firstname: ![null, undefined].includes(leaddata['completed']['firstname']) ? leaddata['completed']['firstname'] : null,
		lastname: ![null, undefined].includes(leaddata['completed']['lastname']) ? leaddata['completed']['lastname'] : null,
		phonenumber: ![null, undefined].includes(leaddata['completed']['mobile']) ? leaddata['completed']['mobile'] : null,
		countrycode: ![null, undefined].includes(leaddata['completed']['countrycode']) ? leaddata['completed']['countrycode'] : null,
		email: ![null, undefined].includes(leaddata['completed']['email']) ? leaddata['completed']['email'] : null,
		purchasedate: ![null, undefined].includes(leaddata['completed']['purchasedate']) ? new Date(leaddata['completed']['purchasedate']) : null,
		journey: ![null, undefined].includes(leaddata['completed']['journey']) ? leaddata['completed']['journey'] : null,
		addons: ![null, undefined].includes(leaddata['completed']['addons']) ? leaddata['completed']['addons'] : [],
		bonus: ![null, undefined].includes(leaddata['completed']['bonus']) ? leaddata['completed']['bonus'] : [],
		totalpurchasevalue: ![null, undefined].includes(leaddata['completed']['totalpurchasevalue']) ? leaddata['completed']['totalpurchasevalue'] : 0,
		initialpayment: ![null, undefined].includes(leaddata['completed']['initialpayment']) ? leaddata['completed']['initialpayment'] : 0,
		installmentamount: ![null, undefined].includes(leaddata['completed']['installmentamount']) ? leaddata['completed']['installmentamount'] : 0,
		journeytenure: ![null, undefined].includes(leaddata['completed']['journeytenure']) ? leaddata['completed']['journeytenure'] : 0,
		dueday: ![null, undefined].includes(leaddata['completed']['dueday']) ? leaddata['completed']['dueday'] : null,
		originalfee: ![null, undefined].includes(leaddata['completed']['originalfee']) ? leaddata['completed']['originalfee'] : null,
		installmentstartdate: ![null, undefined].includes(leaddata['completed']['installmentstartdate']) ? new Date(leaddata['completed']['installmentstartdate']) : null,
		purchaselabel: ![null, undefined].includes(leaddata['completed']['purchaselabel']) ? leaddata['completed']['purchaselabel'] : null,
		installmentatend: ![null, undefined].includes(leaddata['completed']['installmentatend']) ? leaddata['completed']['installmentatend'] : null,
		subscriptionfrompurchasedate: ![null, undefined].includes(leaddata['completed']['subscriptionfrompurchasedate']) ? leaddata['completed']['subscriptionfrompurchasedate'] : null,
		edited: flag,
		salespersonname: ![null, undefined].includes(leaddata['completed']['salespersonname']) ? leaddata['completed']['salespersonname'] : null,
		presalespersonname: ![null, undefined].includes(leaddata['completed']['presalespersonname']) ? leaddata['completed']['presalespersonname'] : null,
		presalesperson: ![null, undefined].includes(leaddata['completed']['presalesowner']) ? leaddata['completed']['presalesowner'] : null,
		notes: ![null, undefined].includes(leaddata['completed']['notes']) ? leaddata['completed']['notes'] : null,
		gstno: ![null, undefined].includes(leaddata['completed']['gstno']) ? leaddata['completed']['gstno'] : null,
		billingname: ![null, undefined].includes(leaddata['completed']['billingname']) ? leaddata['completed']['billingname'] : null,
		billingemail: ![null, undefined].includes(leaddata['completed']['billingemail']) ? leaddata['completed']['billingemail'] : null,
		billingnumber: ![null, undefined].includes(leaddata['completed']['billingnumber']) ? leaddata['completed']['billingnumber'] : null,
		billingaddress: ![null, undefined].includes(leaddata['completed']['billingaddress']) ? leaddata['completed']['billingaddress'] : null,
		tds: ![null, undefined].includes(leaddata['completed']['tds']) ? leaddata['completed']['tds'] : false,
		paymentid: ![null, undefined].includes(leaddata['completed']['paymentid']) ? leaddata['completed']['paymentid'] : null,
		firstcalldate: ![null, undefined].includes(leaddata['completed']['firstcalldate']) ? new Date(leaddata['completed']['firstcalldate']) : null,
		initialpaymentapproved: ![null, undefined].includes(leaddata['completed']['initialpaymentapproved']) ? leaddata['completed']['initialpaymentapproved'] : false,
		paymentplan: null,
		referral: [null, undefined].includes(leaddata['completed']['referral']) ? false : leaddata['completed']['referral'],
		schedulemode: [null, undefined].includes(leaddata['completed']['schedulemode']) ? false : leaddata['completed']['schedulemode'],
		assuredsalesperson: [null, undefined].includes(leaddata['completed']['assuredsalesperson']) ? false : leaddata['completed']['assuredsalesperson'],
	}


	if (![null, undefined].includes(leaddata['completed']['tentativeschedule']) && leaddata['completed']['tentativeschedule'].length != 0) {
		element['tentativeschedule'] = leaddata['completed']['tentativeschedule'].map(item => {
			let date = item.tentativestartdate;

			if (date instanceof Timestamp) {
				return item;
			} else if (date?.seconds || date?._seconds) {
				date = new Timestamp(date.seconds || date._seconds, date.nanoseconds || date._nanoseconds || 0);
			} else if (typeof date === 'string') {
				date = Timestamp.fromDate(new Date(date));
			} else if (date instanceof Date) {
				date = Timestamp.fromDate(date);
			}

			return {
				productid: item.productid,
				tentativestartdate: date
			};
		});
	}

	if (![null, undefined].includes(leaddata['completed']['tentativebonusschedule']) && leaddata['completed']['tentativebonusschedule'].length != 0) {
		element['tentativebonusschedule'] = leaddata['completed']['tentativebonusschedule'].map(item => {
			let date = item.tentativestartdate;

			if (date instanceof Timestamp) {
				return item;
			} else if (date?.seconds || date?._seconds) {
				date = new Timestamp(date.seconds || date._seconds, date.nanoseconds || date._nanoseconds || 0);
			} else if (typeof date === 'string') {
				date = Timestamp.fromDate(new Date(date));
			} else if (date instanceof Date) {
				date = Timestamp.fromDate(date);
			}

			return {
				productid: item.productid,
				tentativestartdate: date
			};
		});
	}

	if (leaddata['completed']['screenshot'].length != 0) {
		let list = [];
		for (let i = 0; i < leaddata['completed']['screenshot'].length; i++) {
			const image = leaddata['completed']['screenshot'][i];
			list.push(decodeURIComponent(image));
		}
		element['paymentsnapshot'] = list;
	}

	if (![null, undefined].includes(leaddata['completed']['installmentsData'])) {
		var array = [];
		for (let i = 0; i < leaddata['completed']['installmentsData'].length; i++) {
			const data = leaddata['completed']['installmentsData'][i];
			data['installmentstartdate'] = new Date(data['installmentstartdate']);
			array.push(data);
		}
		element['installmentsData'] = array
	}

	if (leaddata['completed']['journeytype'] === 'new' || leaddata['completed']['journeytype'] === 'addons') {
		element['opportunities_consumed'] = ![null, undefined].includes(leaddata['completed']['opportunities_consumed']) ? leaddata['completed']['opportunities_consumed'] : null,
		element['watsonpurchaseid'] = ![null, undefined].includes(leaddata['completed']['watsonpurchaseid']) ? leaddata['completed']['watsonpurchaseid'] : null,
		element['watsonparticipantid'] = ![null, undefined].includes(leaddata['completed']['watsonparticipantid']) ? leaddata['completed']['watsonparticipantid'] : null,
		element['journeyproductpurchaseid'] = ![null, undefined].includes(leaddata['completed']['journeyproductpurchaseid']) ? leaddata['completed']['journeyproductpurchaseid'] : null,
		element['participantjourneyproductid'] = ![null, undefined].includes(leaddata['completed']['participantjourneyproductid']) ? leaddata['completed']['participantjourneyproductid'] : null
		element['enachLink'] = ![null, undefined].includes(leaddata['completed']['enachlink']) ? leaddata['completed']['enachlink'] : null
	}

	if (leaddata['completed']['journeytype'] === 'upgrade') {
		element['opportunities_consumed'] = ![null, undefined].includes(leaddata['completed']['opportunities_consumed']) ? leaddata['completed']['opportunities_consumed'] : null,
		element['watsonparticipantid'] = ![null, undefined].includes(leaddata['completed']['watsonparticipantid']) ? leaddata['completed']['watsonparticipantid'] : null,
		element['upgradefromwatsonpurchaseid'] = ![null, undefined].includes(leaddata['completed']['upgradefromwatsonpurchaseid']) ? leaddata['completed']['upgradefromwatsonpurchaseid'] : null,
		element['upgradefromdocid'] = ![null, undefined].includes(leaddata['completed']['upgradefromdocid']) ? leaddata['completed']['upgradefromdocid'] : null
		element['upgradefromwatsonparticipantid'] = ![null, undefined].includes(leaddata['completed']['upgradefromwatsonparticipantid']) ? leaddata['completed']['upgradefromwatsonparticipantid'] : null,
		element['upgradefromjourneyproductpurchaseid'] = ![null, undefined].includes(leaddata['completed']['upgradefromjourneyproductpurchaseid']) ? leaddata['completed']['upgradefromjourneyproductpurchaseid'] : null,
		element['upgradefromparticipantjourneyproductid'] = ![null, undefined].includes(leaddata['completed']['upgradefromparticipantjourneyproductid']) ? leaddata['completed']['upgradefromparticipantjourneyproductid'] : null,
		element['upgradetowatsonpurchaseid'] = ![null, undefined].includes(leaddata['completed']['upgradetowatsonpurchaseid']) ? leaddata['completed']['upgradetowatsonpurchaseid'] : null
		element['upgradetojourneyproductpurchaseid'] = ![null, undefined].includes(leaddata['completed']['upgradetojourneyproductpurchaseid']) ? leaddata['completed']['upgradetojourneyproductpurchaseid'] : null
		element['upgradetoparticipantjourneyproductid'] = ![null, undefined].includes(leaddata['completed']['upgradetoparticipantjourneyproductid']) ? leaddata['completed']['upgradetoparticipantjourneyproductid'] : null
		element['upgradetodocid'] = ![null, undefined].includes(leaddata['completed']['upgradetodocid']) ? leaddata['completed']['upgradetodocid'] : null
		element['carryover'] = ![null, undefined].includes(leaddata['completed']['carryover']) ? leaddata['completed']['carryover'] : null
		element['installmentatend'] = ![null, undefined].includes(leaddata['completed']['installmentatend']) ? leaddata['completed']['installmentatend'] : null
		element['previousjourney'] = ![null, undefined].includes(leaddata['completed']['previousjourney']) ? leaddata['completed']['previousjourney'] : null
	}

	if (leaddata['completed']['journeytype'] === 'downgrade') {
		element['watsonparticipantid'] = ![null, undefined].includes(leaddata['completed']['watsonparticipantid']) ? leaddata['completed']['watsonparticipantid'] : null,
		element['oweus'] = ![null, undefined].includes(leaddata['completed']['oweus']) ? leaddata['completed']['oweus'] : false,
		element['downgradefromdocid'] = ![null, undefined].includes(leaddata['completed']['downgradefromdocid']) ? leaddata['completed']['downgradefromdocid'] : null,
		element['downgradetodocid'] = ![null, undefined].includes(leaddata['completed']['downgradetodocid']) ? leaddata['completed']['downgradetodocid'] : null,
		element['downgradetonewpurchase'] = ![null, undefined].includes(leaddata['completed']['downgradetonewpurchase']) ? leaddata['completed']['downgradetonewpurchase'] : null,
		element['downgradefromwatsonpurchaseid'] = ![null, undefined].includes(leaddata['completed']['downgradefromwatsonpurchaseid']) ? leaddata['completed']['downgradefromwatsonpurchaseid'] : null,
		element['downgradefromjourneyproductpurchaseid'] = ![null, undefined].includes(leaddata['completed']['downgradefromjourneyproductpurchaseid']) ? leaddata['completed']['downgradefromjourneyproductpurchaseid'] : null,
		element['downgradefromparticipantjourneyproductid'] = ![null, undefined].includes(leaddata['completed']['downgradefromparticipantjourneyproductid']) ? leaddata['completed']['downgradefromparticipantjourneyproductid'] : null
		element['downgradetowatsonpurchaseid'] = ![null, undefined].includes(leaddata['completed']['downgradetowatsonpurchaseid']) ? leaddata['completed']['downgradetowatsonpurchaseid'] : null,
		element['downgradetojourneyproductpurchaseid'] = ![null, undefined].includes(leaddata['completed']['downgradetojourneyproductpurchaseid']) ? leaddata['completed']['downgradetojourneyproductpurchaseid'] : null,
		element['downgradetoparticipantjourneyproductid'] = ![null, undefined].includes(leaddata['completed']['downgradetoparticipantjourneyproductid']) ? leaddata['completed']['downgradetoparticipantjourneyproductid'] : null
	}

	if (leaddata['completed']['journeytype'] === 'cancelled') {
		element['oweus'] = ![null, undefined].includes(leaddata['completed']['oweus']) ? leaddata['completed']['oweus'] : false,
		element['canceldocid'] = ![null, undefined].includes(leaddata['completed']['canceldocid']) ? leaddata['completed']['canceldocid'] : null
		element['watsonpurchaseid'] = ![null, undefined].includes(leaddata['completed']['watsonpurchaseid']) ? leaddata['completed']['watsonpurchaseid'] : null,
		element['watsonparticipantid'] = ![null, undefined].includes(leaddata['completed']['watsonparticipantid']) ? leaddata['completed']['watsonparticipantid'] : null,
		element['journeyproductpurchaseid'] = ![null, undefined].includes(leaddata['completed']['journeyproductpurchaseid']) ? leaddata['completed']['journeyproductpurchaseid'] : null,
		element['participantjourneyproductid'] = ![null, undefined].includes(leaddata['completed']['participantjourneyproductid']) ? leaddata['completed']['participantjourneyproductid'] : null
	}

	if (flag === false) { element['date'] = new Date() }
	if (flag === false) { element['journeytype'] = ![null, undefined].includes(leaddata['completed']['journeytype']) ? leaddata['completed']['journeytype'] : null }
	if (flag === false && leaddata['status'] == 'Rejected') { element['status'] = null }
	await admin.firestore().collection("salesleads").doc(leaddata['completed']['docid']).set(element, { merge: true })
}

// Function to send sales approval data to slack - salesCRMConvertedLeads
async function sendSalesCaptureToSalesChannel(value) {
	console.log("sending slack message initiated");
	let leaddata = value;
	var mapJourney = {};
	var mapProduct = {};

	await admin.firestore().collection("journey").get().then(async journeysnap => {
		for (let i = 0; i < journeysnap.docs.length; i++) {
			const journeyelement = journeysnap.docs[i].data();
			mapJourney[journeyelement['id']] = journeyelement['journey']
		}
	});

	await admin.firestore().collection("products").get().then(async productsnap => {
		for (let i = 0; i < productsnap.docs.length; i++) {
			const productelement = productsnap.docs[i].data();
			mapProduct[productelement['id']] = productelement['product']
		}
	});

	let addonarray = [];
	for (let i = 0; i < leaddata['addons'].length; i++) {
		addonarray.push(mapProduct[leaddata['addons'][i]['addons']])
	}

	let arraybonus = [];
	for (let i = 0; i < leaddata['bonus'].length; i++) {
		arraybonus.push(mapProduct[leaddata['bonus'][i]])
	}

	console.log(leaddata);
	console.log(addonarray);
	console.log(arraybonus);

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
				"type": "image",
				"image_url": `${decodeURIComponent(leaddata['screenshot'])}`,
				"alt_text": "inspiration"
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Name* : ${leaddata['name']}`
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Email* : ${leaddata['email']}`
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Mobile* : ${leaddata['mobile']}`
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Journey* : ${![null, undefined].includes(leaddata['journey']) ? mapJourney[leaddata['journey']] : null}`
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Addons* : ${addonarray.join()}`
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Bonus* : ${arraybonus.join()}`
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Sales Person* : ${leaddata['salespersonname']}\n`,
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Pre Sales Person* : ${leaddata['presalespersonname']}\n`,
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Total Purchase Value* : ${leaddata['totalpurchasevalue']}`
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Initial payment* : ${leaddata['initialpayment']}`
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Installment Amount* : ${leaddata['installmentamount']}`
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Purchase Date* : ${leaddata['purchasedate'].toDate ? leaddata['purchasedate'].toDate().toLocaleDateString('en-CA') : new Date(leaddata['purchasedate']).toLocaleDateString('en-CA')}`,
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Notes* : ${leaddata['notes']}`,
				}
			},
		]
	}

	if (leaddata['journeytype'] == 'new') {
		message['blocks'].push({
			"type": "section",
			"text": {
				"type": "mrkdwn",
				"text": `*ICICI ENACH Link* : ${leaddata['enachlink'][0]}`,
			}
		},);

		message['blocks'].push({
			"type": "section",
			"text": {
				"type": "mrkdwn",
				"text": `*AXIS ENACH Link* : ${leaddata['enachlink'][1]}`,
			}
		},);

	}

	var url
	if (production) {
		if(value['hiddenpipeline']) {
			url = await getWebhookUrl("hiddenSalesChannel")
		} else {
			url = await getWebhookUrl("slackSaleCapture") // Production
		}
	} else {
		url = await getWebhookUrl("slackDevTest") // Test
	}
	if (!url) {
		console.log("[sendSalesCaptureToSalesChannel] webhook url not found, skipping slack post");
		return;
	}
	console.log("slack message", message);
	var webhook = new IncomingWebhook(url);
	webhook.send(message, function (err, header, statusCode, body) {
		if (err) {
			console.log('Error:', err);
		} else {
			console.log('Received', statusCode, 'from Slack');
		}
	});
}

// Function to send sales approval data to slack - salesCRMConvertedLeads
async function sendSlotConfirmationToSlackChannel(value, status, profile) {
	let slotdata = value;
	let mapVariation = {};
	let mapSegment = {};

	console.log("sending slack message initiated", slotdata);

	await admin.firestore().collection("queue variation").get().then((variation)=> {
		if(variation.docs.length != 0) {
			for (let i = 0; i < variation.docs.length; i++) {
				const element = variation.docs[i];
				mapVariation[element.id] = element.data();
			}
		} else {
			console.log("Variation Not Found");
		}
	})

	await admin.firestore().collection("segments").get().then((segements)=> {
		if(segements.docs.length != 0) {
			for (let i = 0; i < segements.docs.length; i++) {
				const element = segements.docs[i];
				mapSegment[element.id] = element.data();
			}
		} else {
			console.log("Segments Not Found");
		}
	})

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
					"text": `Slot ${status}`
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Name* : ${profile['profile_name']}`
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Stage* : ${slotdata['stagename']}`
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Segment* : ${mapSegment[slotdata['segmentid']]['segmentname']}`
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Variation* : ${mapVariation[slotdata['variationid']]['variationname']}`
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Slot Start Date* : ${slotdata['startdate']?.toDate ? slotdata['startdate'].toDate().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : new Date(slotdata['startdate']).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}`,
				}
			},
			{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Slot End Date* : ${slotdata['enddate']?.toDate ? slotdata['enddate'].toDate().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : new Date(slotdata['enddate']).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}`,
				}
			},
			...(slotdata['title'] ? [{
				"type": "section",
				"text": {
					"type": "mrkdwn",
					"text": `*Title* : ${slotdata['title']}`
				}
			}] : []),
		]
	}

	var url
	if (production) {
		url = await getWebhookUrl("queueSelectionLog") // Production
	} else {
		url = await getWebhookUrl("slackDevTest") // Test
	}
	if (!url) {
		console.log("[sendSlotConfirmationToSlackChannel] webhook url not found, skipping slack post");
		return;
	}
	console.log("slack message", message);
	var webhook = new IncomingWebhook(url);
	webhook.send(message, function (err, header, statusCode, body) {
		if (err) {
			console.log('Error:', err);
		} else {
			console.log('Received', statusCode, 'from Slack');
		}
	});
}

async function updateParticipantTouchPoint({label = "", notes = "", touchpoint = "", touchpointdate = "", profileid = "", parentreference = "", metadata = {}}) {
	try {
		var docid = admin.firestore().collection("participant touchpoint").doc().id
		await admin.firestore().collection("participant touchpoint").doc(docid).set({
			docid: docid,
			logdate: admin.firestore.FieldValue.serverTimestamp(),
			label: label,
			notes: notes,
			touchpoint: touchpoint,
			touchpointdate: touchpointdate,
			profileid: profileid,
			parentreference: parentreference,
			metadata: metadata
		})

		await admin.firestore().collection("classify").doc("touchpoint").set({
			touchpointlist: admin.firestore.FieldValue.arrayUnion(touchpoint)
		}, {merge: true})
	} catch (error) {
		console.log("Touch Point Update Issue", error.toString())
	}
}

module.exports = {
	// slackDevTest, slackLogSupport, slackLogVideoWatch, slackAppLogin, slackTicketingSystem, slackEvent, slackSaleCapture, slackSaleRejection, slackEvolutionProgress, slackLoveLetter, slackAskAH, slackFirebaseBilling, slackLogScheduling, slackWorkshopQandA,slackWorkshopsubscribers,slackWorkshopsubscribersactivity,
	production,
	postmarkClient,
	monthName,
	chunkArray,
	saveNotificationRecord,
	convertDate,
	uploadImageFromUrl,
	sendToWhatsappViaWati,
	IncomingWebhook,
	throwParticipantMetaDataException,
	getUnusedZoomAccount,
	generateSignature,
	updateSalesLead,
	sendSalesCaptureToSalesChannel,
	sendSlotConfirmationToSlackChannel,
	updateParticipantTouchPoint,
	generateZoomMeeting,
	createEmailArchiveDocument,
	createWatiArchiveDocument,
	getWebhookUrl
}

async function createEmailArchiveDocument({
	datamodel = {}, // Object, only the data model
	attachments = [], // Array of Object, Attachmets for the Template
	emailTo = [], // Array of String, Emails
	emailMap = [], // Array of Map {email:profileid}
	fileURL = '', // String Excel URL
	from = '', // String From EMailID
	notes = '', // String
	profileId = '', // Array of String, Profile IDs
	postmarkTemplateId = 0, // Number Postmark Template ID 
	templateAlias = '', // String Postmark Template name
	type = null, // type of message
	metadata = null // metadata of individual message
}){

	console.log('Triggered Email Archive',{
		datamodel,
		attachments,
		emailTo,
		emailMap,
		fileURL,
		from,
		notes,
		profileId,
		postmarkTemplateId,
		templateAlias,
	});
	
	const now = new Date();
	const day = String(now.getDate()).padStart(2, '0');
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const year = now.getFullYear();
	const hours = String(now.getHours()).padStart(2, '0');
	const minutes = String(now.getMinutes()).padStart(2, '0');
	const seconds = String(now.getSeconds()).padStart(2, '0');
	let templateData = {};
	let broadcast_name = '';
	if(emailTo.length == 1){
		broadcast_name = `Individual_${day}_${month}_${year}_${hours}_${minutes}_${seconds}`
	} else {
	 	broadcast_name = `Broadcast_${day}_${month}_${year}_${hours}_${minutes}_${seconds}`
	}
	console.log('Broadcast Name',broadcast_name);
	
	await admin.firestore().collection('email templates').where('templatealias','==',templateAlias).limit(1).get().then(async(templatedoc)=>{
		
		if(templatedoc.docs.length != 0){
			templateData = templatedoc.docs[0].data();
			console.log('Email Template',templateData);

			const docid = admin.firestore().collection('email archive').doc().id

			var map = {
				docid : docid,
				body:templateData['htmlbody'],
				broadcastname: broadcast_name,
				createdby: 'automated',
				datamodel: datamodel,
				attachments: attachments,
				postmarkAttachments: attachments,
				date: new Date(),
				emailid: emailTo,
				emailmap: emailMap,
				fileUrl:fileURL,
				from:from,
				notes:notes,
				postmarktemplateid: postmarkTemplateId || null,
				profileid: profileId,
				sent: [],
				status:'send',
				servername: templateData['servername'] || null,
				subject: templateData['subject'],
				templatedocid:templateData['docid'],
				templateid:templateData['templateid'] || templateAlias || null,
				variableoption:'automated',
			}
			if(type) map['type'] = type;
			if(metadata) map['metadata'] = metadata;

			await admin.firestore().collection('email archive').doc(docid).set(map).then(()=>{
				console.log('Email Archive Created Successfully');
			}).catch((err)=>{
				console.error('Oops Error while creating email archive',err);
			});

		}else{
			console.error('NO Document Found in EMail Templates');
		}
	});

}

async function createWatiArchiveDocument({
	numbers = '', // Array of string numbers 
	numbermap = {}, // Object {'phonenumber': 'profileid'}
	broadcastname = '', // String
	paramFillMode = '', // String data fetch from static,metadata,excel
	parameterConfig = [{}], //Array of Object [{excelColumn: null,fillType: 'static',metadataField: null,name: param.namestaticValue: param.value}],
	params = [], // Array of parameter fields
	profileid = [], // Array of profileids
	templateid = '', // template ID from wati 
	watitemplateid = '', // String template name
	type = null, // type of message
	metadata = null // metadata of individual message
}){
	console.log('Started creating Wati Archive');
	
	const now = new Date();
	const day = String(now.getDate()).padStart(2, '0');
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const year = now.getFullYear();
	const hours = String(now.getHours()).padStart(2, '0');
	const minutes = String(now.getMinutes()).padStart(2, '0');
	const seconds = String(now.getSeconds()).padStart(2, '0');

	const broadCastName = `${broadcastname}_${day}_${month}_${year}_${hours}_${minutes}_${seconds}`

	const docid = admin.firestore().collection('wati archive').doc().id;

	try {

		var map = {
			docid: docid,
			body : null,
			numbers: numbers,
			createdby: null,
			date: new Date(),
			numbermap: numbermap,
			broadcastname: broadCastName,
			paramFillMode: paramFillMode,
			parameterConfig: parameterConfig,
			params: params,
			profileid: profileid,
			sentAt : new Date(),
			serverid: eventWatiServerId,
			serverurl: `https://live-mt-server.wati.io/${eventWatiServerId}`,
			status: 'sent',
			templateid: templateid,
			templatevalidated: true,
			validated: true,
			watitemplateid: watitemplateid
		};

		if(type) map['type'] = type;
		if(metadata) map['metadata'] = metadata;
		
		await admin.firestore().collection('wati archive').doc(docid).set(map).then(() => {
			console.log('Wati Archive Created Successfully');
			return 'Wati Archive Created Successfully';
		}).catch((err) => {
			console.error('Oops Error while creating Wati archive', err);
			return `Oops Error while creating Wati archive, ${err}`
		});
	} catch (error) {
		console.log('Oops error', error);
		return error;
	};
	
}