const admin = require('firebase-admin');
//components imports
const commonService = require('./service');
// v2 functions
const { onSchedule} = require("firebase-functions/v2/scheduler");
const { onMessagePublished} = require("firebase-functions/v2/pubsub")

//https
const https = require('https'); // HTTP Request/Response
//slack
var IncomingWebhook = require('@slack/client').IncomingWebhook;
// process imports
const process = require("process") // NodeJS Process
const { Buffer } = require('buffer');
// google cloud
const firestore = require('@google-cloud/firestore'); // Google Cloud Platform
const client = new firestore.v1.FirestoreAdminClient(); // Connect Client to Google Cloud Platform


// Backup Scheduler v2 chatgpt optimised
exports.scheduledFirestoreExport = onSchedule({schedule: "every 12 hours", memory: "4GiB", timeoutSeconds: 540}, async (context) => {
  let collectionIds = [];
  let subCollectionsName = []; // Declare with let

  // Get collections
  const collectionsSnapshot = await admin.firestore().listCollections();
  const filteredCollections = collectionsSnapshot.map(e => e["_queryOptions"].collectionId).filter(collectionId => collectionId !== 'notifications' && collectionId !== 'app exception log');

  // const collectionListHasSubCollection = ['Achievements', 'Prescribers', 'atc_alpha', 'atc_to_validate', 'clientissue', 'issue_tracker', 'supportdesk', 'transcribed_atc', 'transcribed_atc_alpha', 'transcribed_atc_to_validate', 'triple atc', 'user', 'versioned_atc'];
  // const filteredCollections2 = collectionsSnapshot.filter(col => collectionListHasSubCollection.includes(col.id));

  // // Get subcollections
  // subCollectionsName = await getSubCollections(filteredCollections2);
  

  collectionIds = Array.from(new Set([...filteredCollections, ...['blacklistrows','authors','corrections','procedures','messages','reports','adjustment','watchedVideos']]));
  console.log("collectionIds",collectionIds.length);

  const BATCH_SIZE = 50; // Adjust based on your system's capacity
  const batches = [];

  // Create batches for export
  while (collectionIds.length > 0) {
    batches.push(collectionIds.splice(0, BATCH_SIZE));
  }

  const bucket = commonService.production ? 'gs://firestore_schedule_backup' : 'gs://firestoretest_schedule_backup';
  const projectId = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT;
  const databaseName = client.databasePath(projectId, '(default)');
	console.log("Projectid", projectId)

	console.log("=== Environment Check ===");
	console.log("GOOGLE_APPLICATION_CREDENTIALS:", process.env.GOOGLE_APPLICATION_CREDENTIALS);
	console.log("GOOGLE_CLOUD_PROJECT:", process.env.GOOGLE_CLOUD_PROJECT);
	console.log("GCP_PROJECT:", process.env.GCP_PROJECT);
	console.log("GCLOUD_PROJECT:", process.env.GCLOUD_PROJECT);

	console.log("=== Bucket Info ===");
	console.log("Database name:", databaseName);
	console.log("Bucket:", bucket);

  // Export each batch
  for (const batch of batches) {
    try {
      const response = await client.exportDocuments({
        name: databaseName,
        outputUriPrefix: bucket,
        collectionIds: batch,
      });
      console.log(`Export operation for batch successful. Operation Name: ${response[0]['name']}`);
    } catch (err) {
      console.error('Error exporting batch: ', err);
      throw new Error('Export operation failed');
    }
  }

  return null;
});


exports.slackBudgetAlert = onMessagePublished({topic: "Launch-Your-Legacy-budget-alert-slack", region: "us-central1"}, (event) => {
	
	// Decode the message data if it's base64 encoded
	// console.log(message.attributes);
	const message = event.data.message;
	const data = message.data ? JSON.parse(Buffer.from(message.data, 'base64').toString()) : null;
	// Log the message data and context
	// console.log('Received message:', data);
	// console.log(data['alertThresholdExceeded']);
	
	// console.log('Context:', context);
  
	var url = commonService.slackFirebaseBilling
	if(url){
	  let messageText = {
			"blocks": [
				{
					"type": "section",
					"text": {
						"type": "mrkdwn",
						"text": commonService.production ? "*<https://console.cloud.google.com/billing/017123-E0A05B-76B286|Launch Your Legacy>*" : "*<https://console.cloud.google.com/billing/01F069-A859E9-B60B0F|Test Billing (Starlabs, Watson and SalesCRM)>*"
					}
				},
				{
					"type": "section",
					"text": {
						"type": "mrkdwn",
						"text": `Threshold Exceeded : *${data['alertThresholdExceeded'] * 100} %*`
					}
				},
				{
					"type": "section",
					"text": {
						"type": "mrkdwn",
						"text": `Current Cost : *${data['costAmount']}*`
					}
				},
				{
					"type": "section",
					"text": {
						"type": "mrkdwn",
						"text": `Budget Amount : *${data['budgetAmount']}*`
					}
				}
			]
	  }
	  var webhook = new IncomingWebhook(url);
	  webhook.send(messageText,function(err, header, statusCode, body) {
		if (err) {
		  console.log('Error:', err);
		} else {
		  console.log('Received', statusCode, 'from Slack');
		}
	  });
	}
  
	return null;

})