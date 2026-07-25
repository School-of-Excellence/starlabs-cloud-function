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
    var currentemi = req.query.currentemi
    const mapDataParam = req.query.mapdata;
    let mapData = null;
    console.log("query", req.query);
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
            if (currentemi) updates.currentemi = currentemi;

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
                console.log("Updates", updates);
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
                } catch (webhookError) {
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

exports.watsonEventParticipation = onRequest({ cors: true }, async (req, res) => {
    try {
        const db = admin.firestore();
        const eventid = req.query.eventid;
        const toIso = (t) => (t && typeof t.toDate === 'function') ? t.toDate().toISOString() : null;

        // --- No eventid: return the event list for the dropdown ---
        if (!eventid) {
            const snap = await db.collection('event collection').orderBy('end_date', 'desc').get();
            const events = snap.docs.map((d) => {
                const x = d.data() || {};
                return { id: d.id, name: x.name || '', start_date: toIso(x.start_date), end_date: toIso(x.end_date) };
            });
            return res.status(200).json({ events });
        }

        // --- eventid present: return confirmed participation requests for that event ---
        const eventRef = db.collection('event collection').doc(eventid);
        const reqSnap = await db.collection('event participation request')
            .where('eventref', '==', eventRef)
            .where('status', 'in', ['approved'])
            .get();

        const rows = [];
        const arenaRefs = [];
        const seenArena = new Set();
        reqSnap.docs.forEach((d) => {
            const x = d.data() || {};
            const productid = x.productref ? x.productref.id : null;
            // arenaeventid on the participation request -> doc in `arena events`.
            const arenaeventid = x.arenaeventid
                ? (typeof x.arenaeventid === 'string' ? x.arenaeventid : (x.arenaeventid.id || null))
                : null;
            rows.push({
                docid: x.docid || d.id, profileid: x.profileid || null,
                productid, productref: x.productref || null, arenaeventid, status: x.status || null,
            });
            // Deduped: the requests for one event share (essentially) one arena event,
            // so this is a single arena-events read regardless of participant count.
            if (arenaeventid && !seenArena.has(arenaeventid)) {
                seenArena.add(arenaeventid);
                arenaRefs.push(db.collection('arena events').doc(arenaeventid));
            }
        });

        // Read the referenced arena event(s); keep only participants whose arena
        // event has heroevent === true.
        const heroMap = {};
        if (arenaRefs.length) {
            const arenaDocs = await db.getAll(...arenaRefs);
            arenaDocs.forEach((ad) => {
                if (ad.exists) { heroMap[ad.id] = (ad.data() || {}).heroevent === true; }
            });
        }
        const heroRows = rows.filter((r) => r.arenaeventid && heroMap[r.arenaeventid] === true);
        // Not a hero event -> nothing to return; skip the product read entirely.
        if (!heroRows.length) {
            return res.status(200).json({ eventid, count: 0, participants: [] });
        }

        // Join product names in one batched read — only for the hero participants.
        const productRefs = [];
        const seenProducts = new Set();
        heroRows.forEach((r) => {
            if (r.productref && r.productid && !seenProducts.has(r.productid)) {
                seenProducts.add(r.productid);
                productRefs.push(r.productref);
            }
        });
        const productMap = {};
        if (productRefs.length) {
            const productDocs = await db.getAll(...productRefs);
            productDocs.forEach((pd) => {
                if (pd.exists) { const px = pd.data() || {}; productMap[pd.id] = px.product || px.name || ''; }
            });
        }

        const participants = heroRows.map((r) => ({
            docid: r.docid, profileid: r.profileid, productid: r.productid,
            arenaeventid: r.arenaeventid, status: r.status,
            product: productMap[r.productid] || r.productid || '',
        }));
        return res.status(200).json({ eventid, count: participants.length, participants });
    } catch (err) {
        console.error('watsonEventParticipation error', err);
        return res.status(500).json({ error: err.message });
    }
});

exports.syncETicketEligibility = onRequest(async (req, res) => {
    try {
        const d = req.body || {};
        const id = d.id;
        if (!id) return res.status(400).json({ error: 'missing id' });

        // Deleted in Watson -> remove the mirror doc here too.
        if (d._deleted === true) {
            await admin.firestore().collection('e-ticket eligibility').doc(id).delete();
            console.log('syncETicketEligibility: deleted', id);
            return res.status(200).json({ success: true, id, deleted: true });
        }

        // Store the FULL doc Watson sends — no field restriction. Recursively convert
        // ISO datetime strings back to Firestore Timestamps.
        const convert = (v) => {
            if (v === null || v === undefined) return v;
            if (typeof v === 'string') {
                return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? admin.firestore.Timestamp.fromDate(new Date(v)) : v;
            }
            if (Array.isArray(v)) return v.map(convert);
            if (typeof v === 'object') {
                const o = {};
                for (const k of Object.keys(v)) o[k] = convert(v[k]);
                return o;
            }
            return v;
        };

        const { id: _drop, ...rest } = d;
        const data = {
            ...convert(rest),
            docid: id,
            syncedfromwatsonat: admin.firestore.FieldValue.serverTimestamp(),
        };

        // Full replace (no merge) so the mirror exactly matches Watson — including
        // FIELD DELETIONS. Watson always sends the complete doc, so nothing is lost.
        await admin.firestore().collection('e-ticket eligibility').doc(id).set(data);
        console.log('syncETicketEligibility: stored', id);
        return res.status(200).json({ success: true, id });
    } catch (e) {
        console.error('syncETicketEligibility error', e);
        return res.status(500).json({ error: e.message });
    }
});