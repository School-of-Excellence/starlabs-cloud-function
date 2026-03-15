const admin = require('firebase-admin');
const { onRequest } = require("firebase-functions/v2/https");
const axios = require("axios");
const commonService = require('./service');

exports.dashboardPaymentplanWatsonRequest = onRequest(async (req, res) => {
    var email = req.query.email
    var paymentplan = req.query.paymentplan
    var customerStatus = req.query.customerstatus
    var lastpaymentdate = new Date(req.query.lastpaymentdate)
    var profileid = req.query.profileid
    var pp_totalpaid = req.query.pp_totalpaid
    var pp_totalpurchasevalue = req.query.pp_totalpurchasevalue
    const mapDataParam = req.query.mapdata;
    let mapData = null;
    console.log(lastpaymentdate);
    console.log("email", email, "paymentplan", paymentplan);
    if (profileid) {
        var docRef = admin.firestore().collection('participant metadata').doc(profileid)
        try {
            const docSnapshot = await docRef.get();
            const updates = {};
            if (paymentplan) updates.paymentplan = paymentplan;
            if (customerStatus) updates.financialstatus = customerStatus;
            if (lastpaymentdate) updates.lastpaymentdate = lastpaymentdate;
            if (pp_totalpaid) updates.pp_totalpaid = pp_totalpaid;
            if (pp_totalpurchasevalue) updates.pp_totalpurchasevalue = pp_totalpurchasevalue;

            if (mapDataParam && mapDataParam !== 'null') {
                try {
                    mapData = JSON.parse(decodeURIComponent(mapDataParam));

                    if (mapData && mapData.date && typeof mapData.date === 'object' && mapData.date._seconds !== undefined) {
                        mapData.date = new admin.firestore.Timestamp(mapData.date._seconds, mapData.date._nanoseconds);
                    }

                    updates.financedata = mapData;
                    console.log("Parsed mapdata:", mapData);
                } catch (parseError) {
                    console.error("Error parsing mapdata:", parseError);
                    mapData = null;
                }
            } else {
                updates.financedata = null;
            }

            if (Object.keys(updates).length > 0 && docSnapshot.exists) {
                await docRef.update(updates);
                res.status(200).send("Document updated successfully.");

                let webhookUrl = "";
                if (commonService.production) {
                 webhookUrl = "https://us-central1-salesleadcrm.cloudfunctions.net/updatepersonfromstarlabs";
                } else {
                 webhookUrl = "https://us-central1-salescrm-test-19.cloudfunctions.net/updatepersonfromstarlabs";
                }

                try {
                    await axios.post(webhookUrl, {
                        profileid,
                        email,
                        ...updates,
                        updatedAt: new Date().toISOString()
                    });

                    console.log("Webhook sent successfully");
                    }catch (webhookError) {
                    console.error("Webhook failed:", webhookError.message);
                    }
                    
            } else {
                res.status(400).send("No valid fields provided for update.");
            }
        } catch (error) {
            console.error("Error updating document:", error);
            res.status(500).send("Error updating document.");
        }
    } else {
        console.log("Profile ID not found");
        res.status(400).send("Profile ID not found.");
    }
})