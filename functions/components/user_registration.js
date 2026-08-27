const admin = require('firebase-admin');
//components imports
const commonService = require('./service');
// v2 functions
const { onDocumentCreated , onDocumentWritten , onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onRequest,onCall, HttpsError  } = require("firebase-functions/v2/https");
// https
const https = require('https'); // HTTP Request/Response
var IncomingWebhook = require('@slack/client').IncomingWebhook;
const axios = require('axios');


exports.createProfile_registeredUser = onDocumentCreated({document:"user_data/{docid}",runWith:{timeoutSeconds:540}},async (userData)=>{
	console.log("New UserData created: " + userData.data.data().email)
	const newData = userData.data.data()
  // var dummyURL = null // "https://firebasestorage.googleapis.com/v0/b/fir-sample-aae4a.appspot.com/o/profile-image-png-14.png?alt=media&token=ce6361d2-690c-4742-bba7-dbb90e193080"
	
	var profileData = null
	var batch = admin.firestore().batch()
	
	await admin.firestore().collection("profile_data").where("email", "==", newData.email).get().then(async profileDoc=>{
		if(profileDoc.size == 0){
			console.log("profile Data not exists")
			var profile_id = admin.firestore().collection("profile_data").doc().id;
			var role_id = admin.firestore().collection("roles_of_users").doc().id;

      // Create Profile
			var profileRef = admin.firestore().collection("profile_data").doc(profile_id)
			var roleRef = admin.firestore().collection("users_roles").doc(role_id)
			var newProfileData = {
				name : newData.name,
        countrycode : newData.countrycode != undefined && newData.countrycode != null ? newData.countrycode.toString() : null,
				number : newData.number != undefined && newData.number != null ? newData.number.toString() : null,
				profile : null,
				email : newData.email,
				user_ref : userData.data.ref,
				created : admin.firestore.FieldValue.serverTimestamp(),
				enable : true,
				block : false,
				profileid : profile_id,
				role_ref : admin.firestore().collection("users_roles").doc(role_id)
			}
			var newRoleData = {
				name : newData.name,
				profile_ref : admin.firestore().collection("profile_data").doc(profile_id),
				admin : false,
				ahmember : false,
				changeagent : false,
				eitfellowship : false,
				eitapprentice: false,
				eitcoordinator : false,
				eventcoordinator : false,
				participant : true,
				transcriber : false,
				verifier : false,
				chatxadmin : false,
				supportdesk : false,
			}
			batch.set(profileRef, newProfileData, {merge: true})
			batch.set(roleRef, newRoleData, {merge: true})
			profileData = newProfileData
		}
		else{
			console.log("Profile Already exists size: " + profileDoc.size.toString())
      //  Update profile
			profileData = profileDoc.docs[0].data()
			profileData["user_ref"] = userData.data.ref
			profileData["countrycode"] = profileData["countrycode"] != null ? profileData["countrycode"].toString() : newData.countrycode != null ? newData.countrycode.toString() : null,
			profileData["number"] = profileData["number"] != null ? profileData["number"].toString() : newData.number != null ? newData.number.toString() : null
			batch.update(profileDoc.docs[0].ref, profileData)
			// Update Role
      var profileRoleid = profileData["role_ref"].id
			batch.update(admin.firestore().collection("users_roles").doc(profileRoleid), {participant : true})
		}

    // Copy to User
		batch.set(admin.firestore().collection("user").doc(userData.data.id), {
			username: profileData["name"],
      email: profileData["email"],
      id: userData.data.id,
      tier: []
		})

		// Update Participant Metadata
		if(profileData){
			batch.set(admin.firestore().collection("participant metadata").doc(profileData["profileid"]), {
				profileid: profileData["profileid"],
        name : profileData["name"],
        email : profileData["email"],
        phonenumber : profileData['number'],
        countrycode: profileData['countrycode'],
				firebaseuserref: userData.data.ref
			}, {merge: true})
		}

		await batch.commit().then(value =>{
			console.log("Sucessfully registered", profileData["name"], value.length)
		}).catch(err =>{
			console.log("Registeration Failed", profileData["name"], err)
		})
	})
});
//for workshop
exports.sendEmailOTPNewUsers = onCall(
  {
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (request) => {
    try {
      const { email, name } = request.data;
      if (!email || !email.includes('@')) {
        throw new HttpsError('invalid-argument', 'Valid email is required');
      }
      if (!name) {
        throw new HttpsError('invalid-argument', 'Name is required');
      }
      try {
        const existingUser = await admin.auth().getUserByEmail(email);
        if (existingUser) {
          throw new HttpsError('already-exists', 'An account with this email already exists');
        }
      } catch (error) {
        if (error.code !== 'auth/user-not-found') {
          throw error;
        }
      }
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiryTime = admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + 5 * 60 * 1000)
      );
      const otpDoc = await admin.firestore().collection('emailOTPs').add({
        email: email.toLowerCase().trim(),
        otp: otp,
        name: name,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: expiryTime,
        verified: false,
        attempts: 0,
      });
      const templateData = {
        name: name,
        otp: otp,
        email: email,
        validity: '5 minutes',
      };
      await commonService.postmarkClient.sendEmailWithTemplate({
        From: "starlabs@excellenceinstallation.com",
        To: email,
        TemplateAlias: "register-otp-newuser",
        TemplateModel: templateData,
      });

      // await commonService.createEmailArchiveDocument({
      //   emailData: templateData,
      //   datamodel: templateData,
      //   attachments: [],
      //   emailTo: [email],
      //   emailMap: { [email]: null },
      //   fileURL: '',
      //   from: 'starlabs@excellenceinstallation.com',
      //   notes: '',
      //   profileId: [null],
      //   postmarkTemplateId: '42066392',
      //   templateAlias: 'register-otp-newuser'
      // });

      console.log(`OTP sent to ${email}: ${otpDoc.id}`);
      return {
        success: true,
        message: 'OTP sent successfully',
        otpId: otpDoc.id,
        expiresAt: expiryTime.toDate().toISOString(),
      };

    } catch (error) {
      console.error('Error sending OTP:', error);
      if (error instanceof HttpsError) {
        throw error;
      }
      throw new HttpsError('internal', `Failed to send OTP: ${error.message}`);
    }
  }
);
exports.verifyEmailOTPNewUsers = onCall(
  {
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (request) => {
    try {
      // const { otpId, otp, password, phoneNumber, countryCode, refferedby, refferedprofile, subscriber } = request.data;
      const { otpId, otp, password, phoneNumber, countryCode, refferedby, refferedprofile, subscriber, tags } = request.data;
      if (!otpId || !otp || !password) {
        throw new HttpsError('invalid-argument', 'OTP ID, OTP, and password are required');
      }
      if (password.length < 6) {
        throw new HttpsError('invalid-argument', 'Password must be at least 6 characters');
      }
      const otpDocRef = admin.firestore().collection('emailOTPs').doc(otpId);
      const otpDoc = await otpDocRef.get();
      if (!otpDoc.exists) {
        throw new HttpsError('not-found', 'Invalid OTP session');
      }
      const otpData = otpDoc.data();
      if (otpData.verified) {
        throw new HttpsError('failed-precondition', 'This OTP has already been used');
      }
      const now = admin.firestore.Timestamp.now();
      if (now.toMillis() > otpData.expiresAt.toMillis()) {
        throw new HttpsError('deadline-exceeded', 'OTP has expired. Please request a new one');
      }
      if (otpData.attempts >= 3) {
        throw new HttpsError('resource-exhausted', 'Maximum verification attempts exceeded. Please request a new OTP');
      }
      if (otpData.otp !== otp.trim()) {
        await otpDocRef.update({
          attempts: admin.firestore.FieldValue.increment(1),
        });
        const remainingAttempts = 3 - (otpData.attempts + 1);
        throw new HttpsError(
          'invalid-argument',
          `Invalid OTP. ${remainingAttempts} attempt${remainingAttempts !== 1 ? 's' : ''} remaining`
        );
      }
      let userRecord;
      try {
        userRecord = await admin.auth().createUser({
          email: otpData.email,
          password: password,
          displayName: otpData.name,
          emailVerified: true,
        });
        console.log('User created:', userRecord.uid);
		  var profileid = admin.firestore().collection("new_user_data").doc().id;
        const userData = {
          uid: userRecord.uid,
          profileid:profileid,
          name: otpData.name,
          email: otpData.email,
          phonenumber: phoneNumber || '',
          countryCode: countryCode || '+91',
          refferedby: refferedby || null,
          created: admin.firestore.FieldValue.serverTimestamp(),
          emailVerified: true,
          registrationMethod: 'emailotp',
          status: 'active',
          refferedprofile: refferedprofile || null,
          subscriber: subscriber || false,
          enable:true,
          workshoponly:true,
          tags: Array.isArray(tags) ? tags.filter(t => typeof t === 'string' && t.trim() !== '') : [],
        };
        await admin.firestore().collection('new_user_data').doc(profileid).set(userData);
        await otpDocRef.update({
          verified: true,
          verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
          userId: userRecord.uid,
        });
        try {
          await commonService.postmarkClient.sendEmailWithTemplate({
            From: "starlabs@excellenceinstallation.com",
            To: otpData.email,
            TemplateAlias: "welcome-email",
            TemplateModel: {
              name: otpData.name,
              email: otpData.email,
            },
          });
          const templateModel = {
            name: otpData.name,
            email: otpData.email,
          }
          // await commonService.createEmailArchiveDocument({
          //   emailData: templateModel,
          //   datamodel: templateModel,
          //   attachments: [],
          //   emailTo: [otpData.email],
          //   emailMap: { [otpData.email]: profileid },
          //   fileURL: '',
          //   from: 'starlabs@excellenceinstallation.com',
          //   notes: '',
          //   profileId: [profileid],
          //   postmarkTemplateId: '42066826',
          //   templateAlias: 'welcome-email'
          // });

        } catch (emailError) {
          console.error('Error sending welcome email:', emailError);
        }

        try {
          var apikey = null;
          var serverid = null;
          await admin.firestore().collection("classify").doc("eventwati").get().then((wati) => {
            if(wati.exists) {
            const watiData = wati.data();
            apikey = watiData['apikey'];
            serverid = watiData['serverid'];
            }
          })

          const WATI_BASE_URL = `https://live-mt-server.wati.io/${serverid}`;
          const WATI_API_TOKEN = apikey;
           let eiflix = commonService.production
              ? `https://eiflix.com/workshops`
              : `https://eiflix-workshop.web.app/workshops`;
            let messageText = "We’re excited to have you in our community! 💫 You’ve just taken the first step toward building your legacy. 🌱 Next: Enroll in the workshop to begin your transformations journey. ✅";
            let phonenumber = phoneNumber;
            const endpoint = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${phonenumber}`;
            const headers = {
              'Authorization': `Bearer ${WATI_API_TOKEN}`,
              'Content-Type': 'application/json',
            };

            const data = {
              template_name: 'eiflixworkshopv8',
              broadcast_name: 'Workshop Enrolled',
              parameters: [
                { name: 'name', value: otpData.name || '' },
                { name: 'link', value: `${eiflix} ` },
                { name: '1', value: messageText },
              ]
            };
          const response = await axios.post(endpoint, data, { headers });
          console.log('Message sent successfully:', response.data);

        } catch (whatsapperr) {
          console.error('Error whatss', whatsapperr);
          
        }

        return {
          success: true,
          message: 'Account created successfully',
          userId: userRecord.uid,
          email: otpData.email,
        };

      } catch (authError) {
        console.error('Error creating user:', authError);
        
        if (authError.code === 'auth/email-already-exists') {
          throw new HttpsError('already-exists', 'An account with this email already exists');
        }
        
        throw new HttpsError('internal', `Failed to create account: ${authError.message}`);
      }

    } catch (error) {
      console.error('Error verifying OTP:', error);
      
      if (error instanceof HttpsError) {
        throw error;
      }
      
      throw new HttpsError('internal', `Failed to verify OTP: ${error.message}`);
    }
  }
);

exports.resendEmailOTPNewUsers = onCall(
  {
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (request) => {
    try {
      const { email, name } = request.data;
      if (!email || !email.includes('@')) {
        throw new HttpsError('invalid-argument', 'Valid email is required');
      }

      const recentOTPs = await admin.firestore()
        .collection('emailOTPs')
        .where('email', '==', email.toLowerCase().trim())
        .where('createdAt', '>', admin.firestore.Timestamp.fromDate(new Date(Date.now() - 60000))) 
        .get();

      if (!recentOTPs.empty) {
        throw new HttpsError(
          'resource-exhausted',
          'Please wait 1 minute before requesting a new OTP'
        );
      }
      const oldOTPs = await admin.firestore()
        .collection('emailOTPs')
        .where('email', '==', email.toLowerCase().trim())
        .where('verified', '==', false)
        .get();

      const batch = admin.firestore().batch();
      oldOTPs.forEach(doc => {
        batch.update(doc.ref, { verified: true, invalidated: true });
      });
      await batch.commit();
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiryTime = admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + 5 * 60 * 1000)
      );
      const otpDoc = await admin.firestore().collection('emailOTPs').add({
        email: email.toLowerCase().trim(),
        otp: otp,
        name: name,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: expiryTime,
        verified: false,
        attempts: 0,
        resent: true,
      });
      const templateData = {
        name: name,
        otp: otp,
        email: email,
        validity: '5 minutes',
      };
      
      await commonService.postmarkClient.sendEmailWithTemplate({
        From: "starlabs@excellenceinstallation.com",
        To: email,
        TemplateAlias: "register-otp-newuser",
        TemplateModel: templateData,
      });
      
      // await commonService.createEmailArchiveDocument({
      //   emailData: templateData,
      //   datamodel: templateData,
      //   attachments: [],
      //   emailTo: [email],
      //   emailMap: { [email]: null },
      //   fileURL: '',
      //   from: 'starlabs@excellenceinstallation.com',
      //   notes: '',
      //   profileId: [null],
      //   postmarkTemplateId: '42066392',
      //   templateAlias: 'register-otp-newuser'
      // });

      console.log(`OTP resent to ${email}: ${otpDoc.id}`);
      return {
        success: true,
        message: 'OTP resent successfully',
        otpId: otpDoc.id,
        expiresAt: expiryTime.toDate().toISOString(),
      };

    } catch (error) {
      console.error('Error resending OTP:', error);
      if (error instanceof HttpsError) {
        throw error;
      }
      throw new HttpsError('internal', `Failed to resend OTP: ${error.message}`);
    }
  }
);

exports.newuserjoinedslackintegration = onDocumentCreated("new_user_data/{docid}", async (document) => {
  const snapshot = document.data;
  var data = snapshot.data();
  const name = data["name"];
  const phone = data["phonenumber"];
  const email = data["email"];
  var referralcode = data["refferedby"];
  const referredProfileId = data["refferedprofile"];
  const staticrefcode = await admin.firestore().collection("static meta data").doc('Subscriber Code').get();
  const referralcodesubscriber = staticrefcode.exists ? staticrefcode.data()["referralcode"] : null;
  
  let referredProfileName;
  // if (referralcode === 'AH2025') {
  if (referralcode === referralcodesubscriber) {
    referredProfileName = "SUBSCRIBER";
  } else if (referredProfileId) {
    const referredDoc = await admin.firestore().collection("profile_data").doc(referredProfileId).get();
    referredProfileName = referredDoc.exists ? referredDoc.data()["name"] : "Unknown";
  } else {
    referredProfileName = "Refferal";
  }

  try {
      const customerioPayload = {
        name: name,
        email: email,
        phonenumber: phone,
      };

      const customerioResponse = await fetch("https://api.customer.io/v1/webhook/a60ad03f3052e758", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(customerioPayload),
      });

      if (!customerioResponse.ok) {
        console.error("Customer.io webhook failed:", customerioResponse.status, await customerioResponse.text());
      } else {
        console.log("Customer.io webhook sent successfully:", customerioResponse.status);
      }
    } catch (err) {
      console.error("Error sending to Customer.io:", err);
    }
  let url;

  if (referralcode === referralcodesubscriber) {
    console.log('old web hook',referredProfileName)
    url = commonService.production
      ? await commonService.getWebhookUrl("slackWorkshopsubscribers")
      : await commonService.getWebhookUrl("slackDevTest");
  } else {
    console.log('new web hook',referredProfileName)
    url = commonService.production
      ? await commonService.getWebhookUrl("slackeiflixrefferals")
      : await commonService.getWebhookUrl("slackDevTest");
  }
  if (url) {
    const webhook = new commonService.IncomingWebhook(url);

    // const message = `
    // 🎉 *New EiFlix Registration!* 🎉

    // 👤 *Name:* ${name}
    // 📱 *Phone:* ${phone}
    // 📧 *Email:* ${email}
    // 🤝 *Referred By:* ${referredProfileName}

    // 🚀 *${name}* just joined EiFlix, referred by *${referredProfileName}*! 🌱
    // `;
    // const message = `
    // 🚀 *${name}* just joined EiFlix, referred by *${referredProfileName}*! 🌱
    // `;
    let message;
    // if (referralcode === 'AH2025') {
    if (referralcode === referralcodesubscriber) {
      message = `
      🚀 *${name}* just joined EiFlix as a *SUBSCRIBER*! 🌱
      `;
    } else {
      message = `
      🚀 *${name}* just joined EiFlix! 🌱
      `;
    // message = `
    // 🚀 *${name}* just joined EiFlix, referred by *${referredProfileName}*! 🌱
    // `;
    }
    console.log(message);

    webhook.send(message, (err, header, statusCode, body) => {
      if (err) {
        console.error("Error", err);
      } else {
        console.log("Message sent", statusCode);
      }
    });
  } else {
    console.warn("Slack webhook URL not configured.");
  }
});
