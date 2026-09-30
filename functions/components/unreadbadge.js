const admin = require('firebase-admin');

// App-icon unread badge for the Breakthroughs app.
// Badge = unread chats + (general notification unread ? 1 : 0)
//   unread chats → supportchat docs where members contains the user's UID and
//                  isdelete == false, counted in code where pendingcount[UID] > 0
//   notification → notifications/{UID}.read == false (set by storeNotificationLogs,
//                  cleared by the app when the Notification Log opens or a general push is tapped)
// Same rule as the app's lib/Services/UnreadBadgeService.dart.

// Chat-side pushes — badge = chats + (notifications/{uid}.read == false ? 1 : 0).
const CHAT_BADGE_TYPES = ["groupchat", "channel", "supportticket"];
// Chat pushes whose conversation counts in the badge — Android tag chat_<recordid>.
const COUNTED_CHAT_TYPES = ["groupchat"];
// No badge for studio invitation / call pushes.
const NO_BADGE_TYPES = ["studio invitation"];
// Android tag prefixes — the app clears these from the tray when the badge reaches 0.
const CHAT_TAG_PREFIX = "chat_";
const NOTIFICATION_TAG_PREFIX = "notif_";
const BADGE_CONCURRENCY = 20;

// Chat pushes always carry the badge; general pushes only when logged (logged → read:false,
// so +1). Non-logged general pushes leave the badge as it is.
function badgeApplies(notificationType, logged) {
  if (NO_BADGE_TYPES.includes(notificationType)) return false;
  return CHAT_BADGE_TYPES.includes(notificationType) || logged === true;
}

function notificationTag(notificationType, logged, recordId) {
  if (COUNTED_CHAT_TYPES.includes(notificationType)) return `${CHAT_TAG_PREFIX}${recordId}`;
  if (logged === true && !CHAT_BADGE_TYPES.includes(notificationType) && !NO_BADGE_TYPES.includes(notificationType)) return `${NOTIFICATION_TAG_PREFIX}${recordId}`;
  return recordId;
}

function hasPendingFor(pendingcount, uid) {
  if (!pendingcount || typeof pendingcount !== "object") return false;
  return (parseInt(pendingcount[uid] ?? 0, 10) || 0) > 0;
}

// Returns Set<chatid> of unread supportchat docs for the user.
async function getUnreadChats(uid) {
  const chats = new Set();
  if (!uid) return chats;
  const chatDocs = await admin.firestore().collection("supportchat").where("members", "array-contains", uid).where("isdelete", "==", false).get();
  chatDocs.forEach(doc => {
    if (hasPendingFor(doc.data().pendingcount, uid)) chats.add(doc.id);
  });
  return chats;
}

async function isNotificationUnread(uid) {
  const notificationDoc = await admin.firestore().collection("notifications").doc(uid).get();
  return notificationDoc.exists && notificationDoc.data().read === false;
}

// Badge for each recipient: { [profileid]: count }. A recipient whose count fails (or has no
// uid) is left out, so their push goes without a badge rather than a wrong one.
//   recipients — [{ profileid, uid }]
//   notificationType, metaData, logged — from the notificationrecord doc
async function getBadgeCounts(recipients, notificationType, metaData, logged) {
  const badgeCounts = {};
  const isChatPush = CHAT_BADGE_TYPES.includes(notificationType);

  // Timing guard for group pushes: the sender's app increments pendingcount right after
  // writing the message, so the push can be built before that lands. Count the pushed
  // group if the triggering message is still pending for the recipient.
  let guardChatId = null;
  let guardPending = [];
  if (notificationType === "groupchat" && metaData?.groupref && metaData?.messageid) {
    guardChatId = String(metaData.groupref);
    try {
      const messageDoc = await admin.firestore().collection("supportchat").doc(guardChatId).collection("messages").doc(String(metaData.messageid)).get();
      guardPending = messageDoc.exists ? (messageDoc.data().pending || []) : [];
    } catch (err) {
      console.error("Badge guard message fetch failed:", err);
    }
  }

  for (let i = 0; i < recipients.length; i += BADGE_CONCURRENCY) {
    await Promise.all(recipients.slice(i, i + BADGE_CONCURRENCY).map(async ({ profileid, uid }) => {
      if (!uid) return;
      try {
        const chats = await getUnreadChats(uid);
        if (guardChatId && guardPending.includes(uid)) chats.add(guardChatId);
        // Logged push → storeNotificationLogs has just set read:false, so +1 without a read.
        const notificationUnread = logged === true ? true : (isChatPush ? await isNotificationUnread(uid) : false);
        badgeCounts[profileid] = chats.size + (notificationUnread ? 1 : 0);
      } catch (err) {
        console.error(`Badge count failed for ${profileid}:`, err);
      }
    }));
  }

  return badgeCounts;
}

module.exports = {
  CHAT_BADGE_TYPES,
  COUNTED_CHAT_TYPES,
  CHAT_TAG_PREFIX,
  NOTIFICATION_TAG_PREFIX,
  badgeApplies,
  notificationTag,
  hasPendingFor,
  getUnreadChats,
  isNotificationUnread,
  getBadgeCounts,
};
