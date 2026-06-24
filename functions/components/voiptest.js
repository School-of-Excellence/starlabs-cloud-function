const { onRequest } = require("firebase-functions/v2/https");
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

exports.testVoipCall = onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');

  const email  = req.query.email  || req.body.email;
  const action = req.query.action || req.body.action || 'trigger';
  const stage  = req.query.stage  || req.body.stage  || 'Test Stage';

  if (!email) {
    res.status(400).json({ error: 'email is required' });
    return;
  }

  const tokenSnap = await admin.firestore()
    .collection('FCM_token')
    .where('email', '==', email)
    .where('active', '==', true)
    .limit(1)
    .get();

  if (tokenSnap.empty) {
    res.status(404).json({ error: 'No active FCM token found for ' + email });
    return;
  }

  const fcmToken = tokenSnap.docs[0].data().FCM_id;

  await admin.messaging().send({
    token: fcmToken,
    android: { priority: 'high' },
    data: {
      type:      'studio_invitation_call',
      action:    action,
      docid:     'test-doc-' + Date.now().toString(),
      localtest: 'true',
      stage:     stage,
    }
  });

  res.json({
    success: true,
    message: action === 'trigger'
      ? 'Call triggered to ' + email
      : 'Call cut for ' + email
  });
});