const admin = require('firebase-admin');
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { IncomingWebhook } = require('@slack/client');
const commonService = require('./service');

// Initialize Admin if not already
// if (!admin.apps.length) {
//   admin.initializeApp({
//     storageBucket: "gs://starlabs-test.firebasestorage.app/"
//   });
// }

exports.TicketCreatedSlackNotification = onDocumentWritten("tickets/{ticketId}", async (event) => {
  const before = event.data?.before;
  const after = event.data?.after;

  if (before && before.exists) {
    console.log("This is an update, not a creation. Skipping Slack notification.");
    return;
  }

  const data = after.data();
  const ticketId = event.params.ticketId;

  // Fetch Assigned User's Name
  let assignedToName = "Unassigned";
  if (data.assignedTo) {
    try {
      const userDoc = await admin.firestore().collection("profile_data").doc(data.assignedTo).get(); // ✅ FIXED
      if (userDoc.exists) {
        assignedToName = userDoc.data().name || assignedToName;
      }
    } catch (err) {
      console.error("Failed to fetch assigned user's name:", err);
    }
  }

  const category = Array.isArray(data.category) ? data.category.join(", ") : (data.category || "Unassigned");
  const software = data.software || "Not specified";
  const screen = data.screen || "Not specified"; 
  const issue = data.issue || "No issue provided";
  const priority = data.priority || "Unassigned";
  const createdAt = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  const message = {
    text: `🎫 *New Ticket Created*`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🎫 New Ticket Created" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Ticket ID:*\n${ticketId}` },
          { type: "mrkdwn", text: `*Software:*\n${software}` },
          { type: "mrkdwn", text: `*Screen:*\n${screen}` },
          { type: "mrkdwn", text: `*Assigned To:*\n${assignedToName}` },
          { type: "mrkdwn", text: `*Priority:*\n${priority}` },
          { type: "mrkdwn", text: `*Category:*\n${category}` },
          { type: "mrkdwn", text: `*Issue:*\n${issue}` },
        ],
      },
    ],
  };

  try {

    var slackWebhookURL = null
    if(commonService.production){
      slackWebhookURL = null // commonService.slackTicketingSystem
    }
    else{
      slackWebhookURL = commonService.slackDevTest
    }

    // Slack Webhook
    const webhook = new IncomingWebhook(slackWebhookURL);
    await webhook.send(message);
    console.log("✅ Slack notification sent for ticket:", ticketId);
  } catch (err) {
    console.error("Slack webhook failed:", err);
  }
});
