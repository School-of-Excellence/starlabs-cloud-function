exports.cutStudioCall = onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');

  const docid = req.query.docid || req.body.docid;

  if (!docid) {
    res.status(400).json({ error: 'docid is required' });
    return;
  }

  // Step 1: Fetch the studioinvitation doc by docid
  const invitationSnap = await admin.firestore()
    .collection('studioinvitation')
    .doc(docid)
    .get();

  if (!invitationSnap.exists) {
    res.status(404).json({ 
      error: 'No studioinvitation found for docid ' + docid 
    });
    return;
  }

  const invitationData = invitationSnap.data();
  const profileid = invitationData.profileid;
  const studioid = invitationData.studioid || "";
  const tokenrefPath = invitationData.tokenref?.path || "";  
  const stage = invitationData.stage || "";

  if (!profileid) {
    res.status(400).json({ 
      error: 'No profileid found in studioinvitation doc' 
    });
    return;
  }

  // Step 2: Fetch all active FCM tokens for this participant
  // A single participant can be logged in on multiple devices
  const profileRef = admin.firestore().collection('profile_data').doc(profileid);

  const tokenSnap = await admin.firestore()
    .collection('FCM_token')
    .where('profile_ref', '==', profileRef)
    .where('active', '==', true)
    .get();

  if (tokenSnap.empty) {
    res.status(404).json({ 
      error: 'No active FCM tokens found for profileid ' + profileid 
    });
    return;
  }

  console.log(`Cutting call for profileid ${profileid} across ${tokenSnap.docs.length} active device(s)`);

  // Step 3: Send cut FCM to all active tokens for this participant
  const sendPromises = tokenSnap.docs.map(tokenDoc => {
    const fcmToken = tokenDoc.data().FCM_id;
    const deviceOS = tokenDoc.data().device_os;
    return admin.messaging().send({
      token: fcmToken,
      android: { priority: 'high' },
      data: {
        type:     'studio_invitation_call',
        action:   'cut',
        docid:    docid,
        studioid: studioid,
        tokenref: tokenrefPath,
        stage:    stage,
      }
    }).then(() => {
      console.log(`Cut sent to profileid ${profileid} on ${deviceOS} token ${fcmToken}`);
    }).catch(err => {
      console.error(`Failed to send cut to token ${fcmToken} for profileid ${profileid}:`, err);
    });
  });

  await Promise.all(sendPromises);

  res.json({
    success: true,
    message: `Call cut for profileid ${profileid}`,
    docid,
    profileid,
    studioid,
    tokenref: tokenrefPath,
    devicesCut: tokenSnap.docs.length,
  });
});