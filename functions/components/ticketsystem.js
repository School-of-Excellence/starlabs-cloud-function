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