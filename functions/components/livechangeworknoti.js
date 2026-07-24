const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const admin = require('firebase-admin');
const commonService = require('./service');

exports.liveChangeWorkStatusNotification = onDocumentUpdated({
  document: 'livechangework/{docid}',
  region: 'us-central1',
  cors: true,
}, async (change) => {

  let previousData = change.data?.before.data();
  let currentData = change.data?.after.data();

  if (!previousData || !currentData) {
    console.log("Missing before/after data, skipping");
    return;
  }

  const procedurename = currentData['procedurename'] || "a procedure";
  const doerid = currentData['doerid'] || null;
  const beneficiaryid = currentData['beneficiaryid'] || null;

  const newDoerStatus = currentData['doerstatus'];
  const newBeneficiaryStatus = currentData['beneficiarystatus'];

  const VALID_STATUSES = ["completed", "incomplete"];

  const doerStatusJustSet = previousData['doerstatus'] == null && VALID_STATUSES.includes(newDoerStatus);
  const beneficiaryStatusJustSet = previousData['beneficiarystatus'] == null && VALID_STATUSES.includes(newBeneficiaryStatus);

  // doerstatus set (null -> completed/incomplete) -> notify beneficiary
  if (doerStatusJustSet && beneficiaryid) {
    console.log(`Doer status set to "${newDoerStatus}" on "${procedurename}", notifying beneficiary ${beneficiaryid}`);

    await commonService.saveNotificationRecord({
      title: "Procedure Status Updated",
      message: `The doer has marked "${procedurename}" as ${newDoerStatus}.`,
      subtitle: null,
      date: admin.firestore.FieldValue.serverTimestamp(),
      landingpage: null,
      logged: false,
      profileid: [beneficiaryid],
      sticky: false,
      notificationtype: "livechangework",
      notificationimage: null,
      metadata: {
        livechangeworkref: change.data.after.ref
      }
    });
  }

  // beneficiarystatus set (null -> completed/incomplete) -> notify doer
  if (beneficiaryStatusJustSet && doerid) {
    console.log(`Beneficiary status set to "${newBeneficiaryStatus}" on "${procedurename}", notifying doer ${doerid}`);

    await commonService.saveNotificationRecord({
      title: "Procedure Status Updated",
      message: `The beneficiary has marked "${procedurename}" as ${newBeneficiaryStatus}.`,
      subtitle: null,
      date: admin.firestore.FieldValue.serverTimestamp(),
      landingpage: null,
      logged: false,
      profileid: [doerid],
      sticky: false,
      notificationtype: "livechangework",
      notificationimage: null,
      metadata: {
        livechangeworkref: change.data.after.ref
      }
    });
  }
});