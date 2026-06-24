const admin = require('firebase-admin');
//components imports
const commonService = require('./service');
// v2 functions
const { onSchedule} = require("firebase-functions/v2/scheduler");
const { onMessagePublished} = require("firebase-functions/v2/pubsub");
const { GoogleAuth } = require('google-auth-library');

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

const projectId = process.env.GCLOUD_PROJECT;
const db = admin.firestore();


// Backup Scheduler v2 chatgpt optimised
exports.scheduledFirestoreExport = onSchedule({schedule: "every 12 hours", memory: "4GiB", timeoutSeconds: 540}, async (context) => {
  const BATCH_SIZE = 50;
  const projectId = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT;
  const bucket = commonService.production ? 'gs://firestore_schedule_backup' : 'gs://firestoretest_schedule_backup';

  // One shared timestamp for the whole run, reused across all databases.
  // ISO format with colons, matching Firestore's own auto-generated folder format.
  const runTimestamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  console.log("Projectid", projectId);
  console.log("=== Environment Check ===");
  console.log("GOOGLE_APPLICATION_CREDENTIALS:", process.env.GOOGLE_APPLICATION_CREDENTIALS);
  console.log("GOOGLE_CLOUD_PROJECT:", process.env.GOOGLE_CLOUD_PROJECT);
  console.log("GCP_PROJECT:", process.env.GCP_PROJECT);
  console.log("GCLOUD_PROJECT:", process.env.GCLOUD_PROJECT);
  console.log("=== Run Info ===");
  console.log("Run timestamp:", runTimestamp);
  console.log("Bucket:", bucket);

  // --- Build the (default) database collection list (dynamic discovery + extras) ---
  let defaultCollectionIds = [];
  try {
    const collectionsSnapshot = await admin.firestore().listCollections();
    const filteredCollections = collectionsSnapshot
      .map(e => e["_queryOptions"].collectionId)
      .filter(collectionId => collectionId !== 'notifications' && collectionId !== 'app exception log');

    defaultCollectionIds = Array.from(new Set([
      ...filteredCollections,
      ...['blacklistrows', 'authors', 'corrections', 'procedures', 'messages', 'reports', 'adjustment', 'watchedVideos']
    ]));
  } catch (err) {
    console.error('Error listing collections for (default) database:', err);
    // Continue: other databases use hardcoded lists and are unaffected.
  }
  console.log("(default) collectionIds", defaultCollectionIds.length);

  // --- Database configuration ---
  // (default): discovered above.
  // firestore-atc / firestore-forms: hardcoded lists only, no discovery.
  const databases = [
    {
      id: '(default)',
      collectionIds: defaultCollectionIds
    },
    {
      id: 'firestore-atc',
      collectionIds: [
        'atc_alpha', 'atc_to_validate', 'triple atc', 'corrections', 'procedures',
        'atc_notes', 'revision', 'temporary_ATC', 'temporary_edit_ATC',
        'temporary_tripleatc', 'temporary_edit_tripleATC', 'ai_generated_atc_summary',
        'ai_generated_atc_summary_backup', 'queue_atc_generation'
      ]
    },
    {
      id: 'firestore-forms',
      collectionIds: [
        'temporary_forms', 'formsByClient', 'formsByClient log'
      ]
    }
  ];

  const failedDatabases = [];

  // --- Export loop: one database at a time ---
  for (const db of databases) {
    const databaseName = client.databasePath(projectId, db.id);
    const outputUriPrefix = `${bucket}/${runTimestamp}_${db.id}`;

    console.log(`=== Exporting database: ${db.id} ===`);
    console.log("Database name:", databaseName);
    console.log("Output prefix:", outputUriPrefix);
    console.log("Collection count:", db.collectionIds.length);

    if (db.collectionIds.length === 0) {
      console.warn(`Skipping database ${db.id}: no collections to export.`);
      continue;
    }

    // Copy so splice does not mutate the config.
    const remaining = [...db.collectionIds];
    const batches = [];
    while (remaining.length > 0) {
      batches.push(remaining.splice(0, BATCH_SIZE));
    }

    let dbHadError = false;
    for (const batch of batches) {
      try {
        const response = await client.exportDocuments({
          name: databaseName,
          outputUriPrefix: outputUriPrefix,
          collectionIds: batch,
        });
        console.log(`[${db.id}] Export batch successful. Operation: ${response[0]['name']}`);
      } catch (err) {
        dbHadError = true;
        console.error(`[${db.id}] Error exporting batch: `, err);
        // Log and continue: other batches and other databases still attempted.
      }
    }

    if (dbHadError) {
      failedDatabases.push(db.id);
    }
  }

  // --- Final status ---
  if (failedDatabases.length > 0) {
    console.error('Databases with export failures:', failedDatabases);
    throw new Error(`Export failed for databases: ${failedDatabases.join(', ')}`);
  }

  console.log('All database exports completed successfully.');
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


/**
 * Extract collection ID from log entry
 */
function extractCollectionId(metadata) {
  if (!metadata || !metadata.request) {
    return 'unknown';
  }
  
  const request = metadata.request;
  
  // Listen operation
  const listenCollection = request.addTarget?.query?.structuredQuery?.from?.[0]?.collectionId;
  if (listenCollection) return listenCollection;
  
  // RunQuery
  const queryCollection = request.structuredQuery?.from?.[0]?.collectionId;
  if (queryCollection) return queryCollection;
  
  // Direct collectionId
  if (request.collectionId) return request.collectionId;
  
  // Write operations
  const writePath = request.writes?.[0]?.update?.name;
  if (writePath && writePath.includes('documents')) {
    const parts = writePath.split('/');
    const docIndex = parts.indexOf('documents');
    if (docIndex >= 0 && docIndex + 1 < parts.length) {
      return parts[docIndex + 1];
    }
  }
  
  // From parent
  const parent = request.parent;
  if (parent && parent.includes('documents')) {
    const parts = parent.split('/');
    const docIndex = parts.indexOf('documents');
    if (docIndex >= 0 && docIndex + 1 < parts.length) {
      return parts[docIndex + 1];
    }
  }
  
  return 'unknown';
}
 
/**
 * Determine operation type
 */
function getOperationType(metadata) {
  if (!metadata || !metadata.authorizationInfo) {
    return { isRead: false, isWrite: false };
  }
  
  const hasDataRead = metadata.authorizationInfo.some(
    auth => auth.permissionType === 'DATA_READ'
  );
  const hasDataWrite = metadata.authorizationInfo.some(
    auth => auth.permissionType === 'DATA_WRITE'
  );
  
  return { isRead: hasDataRead, isWrite: hasDataWrite };
}
 
/**
 * Analyze logs and save to Firestore
 */
async function analyzeDailyAuditLogs() {
  console.log('Starting daily Firestore audit log analysis...');
  console.log(`Project: ${projectId}`);
  console.log(`Time: ${new Date().toISOString()}`);
  
  const now = new Date();
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  
  // Create document ID in format: date_month_year
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const docId = `${day}_${month}_${year}`;
  
  console.log(`Document ID: ${docId}`);
  
  try {
    console.log('Fetching logs using REST API...');
    
    // 1. Initialize Auth Client
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/logging.read']
    });
    const client = await auth.getClient();
    
    const filter = `resource.type="audited_resource" AND protoPayload.serviceName="firestore.googleapis.com" AND timestamp >= "${yesterday.toISOString()}" AND timestamp <= "${now.toISOString()}"`;
    
    console.log('Filter:', filter);
  
    
    // 2. Fetch logs with pagination (REST API max pageSize is 1000)
    let entries = [];
    let pageToken = undefined;
    const MAX_LOGS = 50000;
    
    do {
      const response = await client.request({
        url: 'https://logging.googleapis.com/v2/entries:list',
        method: 'POST',
        data: {
          resourceNames: [`projects/${projectId}`],
          filter: filter,
          pageSize: 1000,
          pageToken: pageToken
        }
      });
      
      const batch = response.data.entries || [];
      entries = entries.concat(batch);
      pageToken = response.data.nextPageToken;
      
      console.log(`Fetched batch of ${batch.length}. Total so far: ${entries.length}`);
      
      // Stop if we hit our arbitrary 50000 limit
      if (entries.length >= MAX_LOGS) {
        entries = entries.slice(0, MAX_LOGS);
        break; 
      }
    } while (pageToken);
    
    console.log(`Final total: Found ${entries.length} entries`);
 
    if (!entries || entries.length === 0) {
      console.log('No audit logs found for the last 24 hours');
      
      await db.collection('firestore_audit_log').doc(docId).set({
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        date: docId,
        totalLogs: 0,
        processedCount: 0,
        unknownCount: 0,
        collections: [],
        status: 'no_data'
      });
      
      return { success: true, message: 'No logs found' };
    }
 
    // Analyze by collection
    const collectionStats = {};
    let unknownCount = 0;
    let processedCount = 0;
 
    entries.forEach(entry => {
      // 3. The REST API puts all our target data directly in `protoPayload`
      const metadata = entry.protoPayload;
      
      if (!metadata) {
        unknownCount++;
        return;
      }
 
      const method = metadata.methodName || 'unknown';
      const collectionId = extractCollectionId(metadata);
      const { isRead, isWrite } = getOperationType(metadata);
 
      if (collectionId === 'unknown') {
        unknownCount++;
      } else {
        processedCount++;
      }
 
      if (!collectionStats[collectionId]) {
        collectionStats[collectionId] = {
          reads: 0,
          writes: 0,
          total: 0,
          methods: {}
        };
      }
 
      if (isRead) collectionStats[collectionId].reads++;
      if (isWrite) collectionStats[collectionId].writes++;
      collectionStats[collectionId].total++;
 
      const shortMethod = method.split('.').pop();
      collectionStats[collectionId].methods[shortMethod] = 
        (collectionStats[collectionId].methods[shortMethod] || 0) + 1;
    });
 
    console.log(`Processed ${processedCount} operations`);
 
    // Sort collections by total operations
    const sortedCollections = Object.entries(collectionStats)
      .filter(([collection]) => collection !== 'unknown')
      .sort((a, b) => b[1].total - a[1].total)
      .map(([name, stats]) => ({
        name,
        reads: stats.reads,
        writes: stats.writes,
        total: stats.total,
        readPercentage: parseFloat(((stats.reads / stats.total) * 100).toFixed(1)),
        writePercentage: parseFloat(((stats.writes / stats.total) * 100).toFixed(1)),
        topMethods: Object.entries(stats.methods)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([method, count]) => ({ method, count }))
      }));
 
    const totalOps = entries.length;
 
    // Prepare document to save
    const statsDocument = {
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      date: docId,
      analysisDate: now.toISOString(),
      timeRange: {
        start: yesterday.toISOString(),
        end: now.toISOString()
      },
      summary: {
        totalLogs: totalOps,
        processedCount,
        unknownCount,
        totalCollections: sortedCollections.length
      },
      collections: sortedCollections,
      topCollections: sortedCollections.slice(0, 10),
      status: 'success'
    };
 
    // Save with date_month_year format ID
    await db.collection('firestore_audit_log').doc(docId).set(statsDocument);
    console.log(`Saved analysis to Firestore: ${docId}`);
 
    // Also save as "latest"
    await db.collection('firestore_audit_log').doc('latest').set(statsDocument);
    console.log('Updated latest stats document');
 
    console.log('Analysis complete!');
    console.log(`Top 3 collections: ${sortedCollections.slice(0, 3).map(c => c.name).join(', ')}`);
 
    return {
      success: true,
      message: `Analyzed ${totalOps} logs, ${sortedCollections.length} collections`,
      documentId: docId
    };
 
  } catch (error) {
    console.error('Error during analysis:', error);
    console.error('Error stack:', error.stack);
    
    await db.collection('firestore_audit_log').doc(docId).set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      date: docId,
      status: 'error',
      error: {
        message: error.message,
        stack: error.stack
      }
    });
 
    throw error;
  }
}
 

//  Scheduled function - runs at 12:00 PM IST daily
 
exports.dailyFirestoreAuditAnalysis = onSchedule({schedule: "0 12 * * *", timeZone: "Asia/Kolkata", region: "asia-south1", timeoutSeconds: 540,memory: "1GiB"}, async (event) => {
	 try {
      const result = await analyzeDailyAuditLogs();
      console.log('Function completed successfully:', result);
      return result;
    } catch (error) {
      console.error('Function failed:', error);
      throw error;
    }
})
  