const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const logger = functions.logger;
const commonService = require('./service')
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

const FIELD_META = {
  status:       { label: 'Status',      showDiff: false  },
  priority:     { label: 'Priority',    showDiff: false  },
  software:     { label: 'Software',    showDiff: false  },
  issue:        { label: 'Title',       showDiff: false },
  assignedTo:   { label: 'Assignment',  showDiff: false }, 
  teamId:       { label: 'Team',        showDiff: false },
  category:     { label: 'Category',    showDiff: false }, 
  reminderDate: { label: 'Reminder',    showDiff: false }, 
  mediaUrl:     { label: 'Attachment',  showDiff: false }, 
  notes:        { label: 'Notes',       showDiff: false }, 
  description:  { label: 'Description', showDiff: false },
};

const TRACKED_FIELDS = Object.keys(FIELD_META);

function toArray(val) {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

function serialize(val) {
  if (val == null) return 'null';
  if (val instanceof admin.firestore.Timestamp) return `ts:${val.seconds}`;
  if (Array.isArray(val)) return JSON.stringify([...val].sort());
  return JSON.stringify(val);
}

function getChangedFields(before, after) {
    return TRACKED_FIELDS.filter(
    f => serialize(before[f]) !== serialize(after[f])
  );
}

function buildUpdateBody(changedFields){
  const labels = changedFields
    .map(f => FIELD_META[f]?.label)
    .filter(Boolean);
  return labels.length > 0 ? `${labels.join(', ')} updated` : '';
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function getTeamMemberIds(teamId) {
  const snap = await db.collection('teams').doc(teamId).get();
  if (!snap.exists) {
    logger.warn('Team not found', { teamId });
    return [];
  }
  const d = snap.data();
  return d['memberIds'] ?? d['members'] ?? d['member_ids'] ?? d['memberRefs'] ?? [];
}

async function resolveRecipients(opts) {
  const { teamId, assignedTo = [], oldTeamId, oldAssignedTo = [], reportedBy } = opts;

  const recipients = new Set();
  const add = (ids) => ids.forEach(id => id && recipients.add(id));

  const teamFetches = [];
  if (teamId)                            teamFetches.push(getTeamMemberIds(teamId));
  if (oldTeamId && oldTeamId !== teamId) teamFetches.push(getTeamMemberIds(oldTeamId));

  const teamResults = await Promise.all(teamFetches);
  teamResults.forEach(add);

  add(assignedTo);
  add(oldAssignedTo);
  if (reportedBy) recipients.add(reportedBy);

  return Array.from(recipients);
}

async function sendToRecipients(recipientIds, title, body, data) {
  if (recipientIds.length === 0) return;
  const date = admin.firestore.Timestamp.now();
  await commonService.saveNotificationRecord({
    title,
    message:          body,
    date,
    landingpage: "https://bugtrackingsystem.web.app",
    notificationtype: "ticketsystem",
    metadata:         data,
    profileid:        recipientIds,
    logged:           true,
  });
  logger.info('Notification record saved', { title, recipients: recipientIds.length });
}

// Cloud Function

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
exports.onTicketChanged = onDocumentWritten('tickets/{ticketId}', async (event) => {
    const after  = event.data.after.exists  ? event.data.after.data()  : null;
    const before = event.data.before.exists ? event.data.before.data() : null;
    const ticketId = event.params.ticketId;

    const ticketTitle = (after ?? before)?.issue?.trim() || 'Untitled ticket';

    // CASE 3: Ticket deleted
    if (after?.isDeleted && !before?.isDeleted) {
      const recipients = await resolveRecipients({
        teamId:     after.teamId,
        assignedTo: toArray(after.assignedTo),
        reportedBy: after.reportedBy,
      });

      await sendToRecipients(
        recipients,
        '🗑️ Ticket deleted',
        ticketTitle,
        { ticketId, eventType: 'deleted' }
      );
      return;
    }

    if (!after || after.isDeleted) return;

    // CASE 1: New ticket created 
    if (!before) {
      if (!after.teamId && toArray(after.assignedTo).length === 0) return;

      const recipients = await resolveRecipients({
        teamId:     after.teamId,
        assignedTo: toArray(after.assignedTo),
        reportedBy: after.reportedBy,
      });

      await sendToRecipients(
        recipients,
        '🎫 New ticket assigned',
        ticketTitle,
        { ticketId, eventType: 'created', teamId: after.teamId ?? '' }
      );
      return;
    }

    // CASE 2: Ticket updated 
    const changedFields = getChangedFields(before, after);
    if (changedFields.length === 0) return;
    const body = buildUpdateBody(changedFields);
    if (!body) return;

    const changedSet = new Set(changedFields);

    const recipients = await resolveRecipients({
      teamId:        after.teamId,
      assignedTo:    toArray(after.assignedTo),
      oldTeamId:     changedSet.has('teamId')     ? before.teamId                  : null,
      oldAssignedTo: changedSet.has('assignedTo') ? toArray(before.assignedTo)     : [],
      reportedBy:    after.reportedBy,
    });

    await sendToRecipients(
      recipients,
      `Ticket Updated`,
      body,
      { ticketId, eventType: 'updated', changedFields: changedFields.join(',') }
    );
  });