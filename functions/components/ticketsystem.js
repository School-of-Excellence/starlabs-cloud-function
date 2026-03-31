// const admin = require('firebase-admin');
// const { onDocumentWritten } = require("firebase-functions/v2/firestore");
// const { IncomingWebhook } = require('@slack/client');
// const commonService = require('./service');

// Initialize Admin if not already
// if (!admin.apps.length) {
//   admin.initializeApp({
//     storageBucket: "gs://starlabs-test.firebasestorage.app/"
//   });
// }

// exports.TicketCreatedSlackNotification = onDocumentWritten("tickets/{ticketId}", async (event) => {
//   const before = event.data?.before;
//   const after = event.data?.after;

//   if (before && before.exists) {
//     console.log("This is an update, not a creation. Skipping Slack notification.");
//     return;
//   }

//   const data = after.data();
//   const ticketId = event.params.ticketId;

//   // Fetch Assigned User's Name
//   let assignedToName = "Unassigned";
//   if (data.assignedTo) {
//     try {
//       const userDoc = await admin.firestore().collection("profile_data").doc(data.assignedTo).get(); // ✅ FIXED
//       if (userDoc.exists) {
//         assignedToName = userDoc.data().name || assignedToName;
//       }
//     } catch (err) {
//       console.error("Failed to fetch assigned user's name:", err);
//     }
//   }

//   const category = Array.isArray(data.category) ? data.category.join(", ") : (data.category || "Unassigned");
//   const software = data.software || "Not specified";
//   const screen = data.screen || "Not specified"; 
//   const issue = data.issue || "No issue provided";
//   const priority = data.priority || "Unassigned";
//   const createdAt = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

//   const message = {
//     text: `🎫 *New Ticket Created*`,
//     blocks: [
//       {
//         type: "header",
//         text: { type: "plain_text", text: "🎫 New Ticket Created" },
//       },
//       {
//         type: "section",
//         fields: [
//           { type: "mrkdwn", text: `*Ticket ID:*\n${ticketId}` },
//           { type: "mrkdwn", text: `*Software:*\n${software}` },
//           { type: "mrkdwn", text: `*Screen:*\n${screen}` },
//           { type: "mrkdwn", text: `*Assigned To:*\n${assignedToName}` },
//           { type: "mrkdwn", text: `*Priority:*\n${priority}` },
//           { type: "mrkdwn", text: `*Category:*\n${category}` },
//           { type: "mrkdwn", text: `*Issue:*\n${issue}` },
//         ],
//       },
//     ],
//   };

//   try {

//     var slackWebhookURL = null
//     if(commonService.production){
//       slackWebhookURL = null // commonService.slackTicketingSystem
//     }
//     else{
//       slackWebhookURL = commonService.slackDevTest
//     }

//     // Slack Webhook
//     const webhook = new IncomingWebhook(slackWebhookURL);
//     await webhook.send(message);
//     console.log("✅ Slack notification sent for ticket:", ticketId);
//   } catch (err) {
//     console.error("Slack webhook failed:", err);
//   }
// });

// const functions = require('firebase-functions');
// const admin     = require('firebase-admin');
// const logger = functions.logger;
// const commonService = require('./service')
// if (!admin.apps.length) {
//   admin.initializeApp();
// }
// const db = admin.firestore();

// const FIELD_META = {
//   status:       { label: 'Status',      showDiff: false  },
//   priority:     { label: 'Priority',    showDiff: false  },
//   software:     { label: 'Software',    showDiff: false  },
//   issue:        { label: 'Title',       showDiff: false },
//   assignedTo:   { label: 'Assignment',  showDiff: false }, 
//   teamId:       { label: 'Team',        showDiff: false },
//   category:     { label: 'Category',    showDiff: false }, 
//   reminderDate: { label: 'Reminder',    showDiff: false }, 
//   mediaUrl:     { label: 'Attachment',  showDiff: false }, 
//   notes:        { label: 'Notes',       showDiff: false }, 
//   description:  { label: 'Description', showDiff: false },
// };

// const TRACKED_FIELDS = Object.keys(FIELD_META);

// function toArray(val) {
//   if (val == null) return [];
//   return Array.isArray(val) ? val : [val];
// }

// function serialize(val) {
//   if (val == null) return 'null';
//   if (val instanceof admin.firestore.Timestamp) return `ts:${val.seconds}`;
//   if (Array.isArray(val)) return JSON.stringify([...val].sort());
//   return JSON.stringify(val);
// }

// function getChangedFields(before, after) {
//     return TRACKED_FIELDS.filter(
//     f => serialize(before[f]) !== serialize(after[f])
//   );
// }

// function buildUpdateBody(changedFields){
//   const labels = changedFields
//     .map(f => FIELD_META[f]?.label)
//     .filter(Boolean);
//   return labels.length > 0 ? `${labels.join(', ')} updated` : '';
// }

// function chunk(arr, size) {
//   const out = [];
//   for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
//   return out;
// }

// async function getTeamMemberIds(teamId) {
//   const snap = await db.collection('teams').doc(teamId).get();
//   if (!snap.exists) {
//     logger.warn('Team not found', { teamId });
//     return [];
//   }
//   const d = snap.data();
//   return d['memberIds'] ?? d['members'] ?? d['member_ids'] ?? d['memberRefs'] ?? [];
// }

// async function resolveRecipients(opts) {
//   const { teamId, assignedTo = [], oldTeamId, oldAssignedTo = [], reportedBy } = opts;

//   const recipients = new Set();
//   const add = (ids) => ids.forEach(id => id && recipients.add(id));

//   const teamFetches = [];
//   if (teamId)                            teamFetches.push(getTeamMemberIds(teamId));
//   if (oldTeamId && oldTeamId !== teamId) teamFetches.push(getTeamMemberIds(oldTeamId));

//   const teamResults = await Promise.all(teamFetches);
//   teamResults.forEach(add);

//   add(assignedTo);
//   add(oldAssignedTo);
//   if (reportedBy) recipients.add(reportedBy);

//   return Array.from(recipients);
// }

// async function sendToRecipients(recipientIds, title, body, data) {
//   if (recipientIds.length === 0) return;
//   const date = admin.firestore.Timestamp.now();
//   await commonService.saveNotificationRecord({
//     title,
//     message:          body,
//     date,
//     landingpage: "https://bugtrackingsystem.web.app",
//     notificationtype: "ticketsystem",
//     metadata:         data,
//     profileid:        recipientIds,
//     logged:           true,
//   });
//   logger.info('Notification record saved', { title, recipients: recipientIds.length });
// }

// // Cloud Function

// const { onDocumentWritten } = require('firebase-functions/v2/firestore');
// exports.onTicketChanged = onDocumentWritten('tickets/{ticketId}', async (event) => {
//     const after  = event.data.after.exists  ? event.data.after.data()  : null;
//     const before = event.data.before.exists ? event.data.before.data() : null;
//     const ticketId = event.params.ticketId;

//     const ticketTitle = (after ?? before)?.issue?.trim() || 'Untitled ticket';

//     // CASE 3: Ticket deleted
//     if (after?.isDeleted && !before?.isDeleted) {
//       const recipients = await resolveRecipients({
//         teamId:     after.teamId,
//         assignedTo: toArray(after.assignedTo),
//         reportedBy: after.reportedBy,
//       });

//       await sendToRecipients(
//         recipients,
//         '🗑️ Ticket deleted',
//         ticketTitle,
//         { ticketId, eventType: 'deleted' }
//       );
//       return;
//     }

//     if (!after || after.isDeleted) return;

//     // CASE 1: New ticket created 
//     if (!before) {
//       if (!after.teamId && toArray(after.assignedTo).length === 0) return;

//       const recipients = await resolveRecipients({
//         teamId:     after.teamId,
//         assignedTo: toArray(after.assignedTo),
//         reportedBy: after.reportedBy,
//       });

//       await sendToRecipients(
//         recipients,
//         '🎫 New ticket assigned',
//         ticketTitle,
//         { ticketId, eventType: 'created', teamId: after.teamId ?? '' }
//       );
//       return;
//     }

//     // CASE 2: Ticket updated 
//     const changedFields = getChangedFields(before, after);
//     if (changedFields.length === 0) return;
//     const body = buildUpdateBody(changedFields);
//     if (!body) return;

//     const changedSet = new Set(changedFields);

//     const recipients = await resolveRecipients({
//       teamId:        after.teamId,
//       assignedTo:    toArray(after.assignedTo),
//       oldTeamId:     changedSet.has('teamId')     ? before.teamId                  : null,
//       oldAssignedTo: changedSet.has('assignedTo') ? toArray(before.assignedTo)     : [],
//       reportedBy:    after.reportedBy,
//     });

//     await sendToRecipients(
//       recipients,
//       `Ticket Updated`,
//       body,
//       { ticketId, eventType: 'updated', changedFields: changedFields.join(',') }
//     );
//   });

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const commonService = require('./service');
const { IncomingWebhook } = require('@slack/client');

if (!admin.apps.length) admin.initializeApp();

const db = admin.firestore();
const { onDocumentWritten } = require('firebase-functions/v2/firestore');

const watchedFields = {
  status: 'Status',
  priority: 'Priority',
  software: 'Software',
  issue: 'Title',
  assignedTo: 'Assignment',
  teamId: 'Team',
  category: 'Category',
  reminderDate: 'Reminder',
  mediaUrl: 'Attachment',
  notes: 'Notes',
  description: 'Description'
};

exports.onTicketChanged = onDocumentWritten('tickets/{ticketId}', async (event) => {
  const ticketId = event.params.ticketId;
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after  = event.data.after.exists  ? event.data.after.data()  : null;

  const ticketTitle = (after || before)?.issue || 'Untitled ticket';

  async function getTeamMembers(teamId) {
    if (!teamId) return [];
    const team = await db.collection('teams').doc(teamId).get();
    if (!team.exists) return [];
    return team.data().memberIds || [];
  }

  async function getRecipients(currentData, previousData) {
    const recipients = [];

    // fetch both teams at the same time instead of waiting on each
    const [currentTeamMembers, oldTeamMembers] = await Promise.all([
      getTeamMembers(currentData?.teamId),
      getTeamMembers(previousData?.teamId)
    ]);

    recipients.push(...currentTeamMembers);

    // only add old team members if the team actually changed
    if (previousData?.teamId && previousData.teamId !== currentData?.teamId) {
      recipients.push(...oldTeamMembers);
    }

    if (currentData?.assignedTo) {
      const assigned = Array.isArray(currentData.assignedTo) ? currentData.assignedTo : [currentData.assignedTo];
      recipients.push(...assigned);
    }

    if (previousData?.assignedTo) {
      const oldAssigned = Array.isArray(previousData.assignedTo) ? previousData.assignedTo : [previousData.assignedTo];
      recipients.push(...oldAssigned);
    }

    if (currentData?.reportedBy) {
      recipients.push(currentData.reportedBy);
    }

    return [...new Set(recipients)];
  }

  async function sendNotification(recipients, title, message, extraData) {
    if (!recipients.length) return;
    await commonService.saveNotificationRecord({
      title: title,
      message: message,
      date: admin.firestore.Timestamp.now(),
      landingpage: 'https://bugtrackingsystem.web.app',
      notificationtype: 'ticketsystem',
      metadata: { ticketId, ...extraData },
      profileid: recipients,
      logged: true,
    });
  }

  // ticket was soft deleted
  if (after?.isDeleted && !before?.isDeleted) {
    const recipients = await getRecipients(after, null);
    await sendNotification(recipients, '🗑️ Ticket deleted', ticketTitle, { eventType: 'deleted' });
    return;
  }

  if (!after || after.isDeleted) return;

  // new ticket created — skip if no team or assignee
  if (!before) {
    if (!after.teamId && !after.assignedTo) return;
    const recipients = await getRecipients(after, null);
    await sendNotification(recipients, '🎫 New ticket assigned', ticketTitle, { eventType: 'created' });
    return;
  }

  // ticket updated — check which fields changed
  const changedFields = [];
  for (const field in watchedFields) {
    const beforeVal = JSON.stringify(before[field] ?? null);
    const afterVal  = JSON.stringify(after[field]  ?? null);
    if (beforeVal !== afterVal) {
      changedFields.push(field);
    }
  }

  if (!changedFields.length) return;

  const message = changedFields.map(f => watchedFields[f]).join(', ') + ' updated';
  const recipients = await getRecipients(after, before);
  await sendNotification(recipients, 'Ticket Updated', message, {
    eventType: 'updated',
    changedFields: changedFields.join(',')
  });
});