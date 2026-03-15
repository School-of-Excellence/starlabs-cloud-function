const admin = require('firebase-admin');
const commonService = require('./service');
const { onDocumentCreated } = require("firebase-functions/v2/firestore");

// Post Like Notification
exports.likeNotification = onDocumentCreated('/Achievements/posts/postcollection/{postid}/likes/{id}', async (snapshotdata)=>{
  var snapshot = snapshotdata.data
  var data = snapshot.data();
  console.log(snapshot.id);

  // Need Updation
  var count = (await admin.firestore().collection("Achievements").doc( "posts").collection("postcollection").doc(data.postid).collection("likes").get()).size;
  if(count > 0){
    await admin.firestore().collection("Achievements").doc("posts").collection("postcollection").doc(data.postid).get().then(async postDoc=>{
      if(postDoc.exists){
        var postData = postDoc.data()
        var profileData = (await admin.firestore().collection("profile_data").doc(postData["profileid"]).get()).data()
        var profileName = profileData["name"]
        var postmessage = postData["postmessage"]

        await commonService.saveNotificationRecord({
          profileid: [postData["profileid"]],
          date: admin.firestore.FieldValue.serverTimestamp(),
          title: `You Got a Like, ${profileName}`,
          message: `${count} people liked your post: ${postmessage}`,
          subtitle: null,
          logged: false,
          sticky: false,
          notificationimage: (postData["postimagelist"] || []).length == 0 ? null : postData["postimagelist"][0],
          landingpage: null,
          notificationtype: "like",
          metadata: {
            postid: postDoc.id,
            postmessage: postmessage
          }
        })
      }
    })
  }

  /*
  await admin.firestore().collection("Achievements").doc("posts").collection("postcollection").doc(data.postid).get().then(val=>{
    uid = val.data().uid;
    postmessage = val.data().postmessage;
    postcategory = val.data().postcategory
    name = val.data().name;
  }).then(async ()=>{
    await admin.firestore().collection("FCM_token").where("uid", "==", uid).where("active", "==", true).get().then(doc=>{
      doc.forEach(value=>{
        tokens.push(value.data().FCM_id)
      })
    }).then(async ()=>{

      if(snapshot.data().uid != uid){
        await admin.firestore().collection("notifications").doc(uid).set({
          "name" : name,
          "read" : false,
        }, {merge : true}).then(async ()=>{
          await admin.firestore().collection("notifications").doc(uid).collection("logs").where("type" , "==", "like").where("postid" , "==", context.params.postid).get().then(async logs=>{
            if(logs.docs.length == 0){
              await admin.firestore().collection("notifications").doc(uid).collection("logs").add({
                "type" : "like",
                "postid" : context.params.postid,
                "count" : count,
                "postmessage" : postmessage,
                "date" : admin.firestore.FieldValue.serverTimestamp()
              }).then(id=>{
                console.log("Notification ID: " + id.id)
              })
            }
            else{
              logs.docs[0].ref.update({
                "type" : "like",
                "postid" : context.params.postid,
                "count" : count,
                "postmessage" : postmessage,
                "date" : admin.firestore.FieldValue.serverTimestamp()
              }).then(id=>{
                console.log("Notification ID: " + logs.docs[0])
              })
            }
          })
        })
      }

      let message = {
        "notification": {
          "title": name + " got new notification",
          "body": count + " People Liked Your Achievement: "+postmessage,
        },
        "content_available": true,
        "mutable_content": true,
        "data": {
          "accountuid" : uid,
          "type" : "likepost",
          "postid" : context.params.postid,
          "likeid" : context.params.id,
          "reference" : snapshot.ref.path.toString(),
          "click_action": "FLUTTER_NOTIFICATION_CLICK",
        },
        "android": {
          "notification": {
            "color": '#ffffff',
            "tag" : data.postid,
            "sound": "default",
          },
        },
        "apns": {
          "payload": {
            "aps": {
              "badge": 1,
              "sound": "default",
            },
          },
          "headers": {
            'apns-collapse-id': data.postid
          }
        },
        // "tokens": tokens,
        "topic": topicName
      };
      await firebaseMessaging.subscribeToTopic(tokens, topicName).then(value=>{
        console.log("Subscribed Success -", value.successCount, "Failed", value.failureCount, " ErrorList", value.errors.map(e => e.error).join(", "))
      })
      await firebaseMessaging.send(message).then(res=>{
        // console.log("Batch", i+1, "/", splitToken.length, res)
      }).catch(err=>{
        console.log("Unable to Send Notification", err)
      })
      await firebaseMessaging.unsubscribeFromTopic(tokens, topicName).then(value=>{
        console.log("Unsubscribed Success -", value.successCount, "Failed", value.failureCount, " ErrorList", value.errors.map(e => e.error).join(", "))
      })
    })
  })
  */
});

// Post Comment Notification
exports.commentNotification = onDocumentCreated('/Achievements/posts/postcollection/{postid}/comments/{id}',async (snapshotdata)=>{
  var firebaseMessaging = admin.messaging()
  var snapshot = snapshotdata.data
  var topicName = snapshot.id
  var data = snapshot.data();
  console.log(snapshot.id);

  var name;
  var payload;
  var uid;
  var tokens = [];
  // var count = await (await admin.firestore().collection("Achievements").doc("posts").collection("postcollection").doc(data.postid).collection("comments").get()).size.toString();

  await admin.firestore().collection("Achievements").doc("posts").collection("postcollection").doc(data.postid).get().then(async val=>{
    uid = val.data().uid;

    name = val.data().name;
    var achievement = val.data().topic;
    var consequences = val.data().postmessage;

    if(snapshot.data().uid != uid){
      await admin.firestore().collection("notifications").doc(uid).set({
        "name" : name,
        "read" : false,
      }, {merge : true}).then(async ()=>{
        await admin.firestore().collection("notifications").doc(uid).collection("logs").add({
          "type" : "comment",
          "postid" : snapshotdata.params.postid,
          "name" : data.name,
          "uid" : data.uid,
          "postmessage": val.data().postmessage,
          "date" : admin.firestore.FieldValue.serverTimestamp()
        })
      })
    }

    payload = {
      "notification" : {
        "title" : name + " got new notification",
        "body" : data.name+" Commented On Your Achievement " + val.data().postmessage,
        "sound" : "default",
      },
      "data" : {
        "accountuid" : uid,
        "type" : "commentpost",
        "postid" : snapshotdata.params.postid,
        "commentid" : snapshot.id,
        "reference" : snapshot.ref.path.toString(),
        "click_action": "FLUTTER_NOTIFICATION_CLICK",
      },
      "topic": topicName
    }
  }).then(async ()=>{
    await admin.firestore().collection("FCM_token").where("uid", "==", uid).where("active", "==", true).get().then(doc=>{
      doc.forEach(value=>{
          tokens.push(value.data().FCM_id)
      })
    }).then(async ()=>{
      await firebaseMessaging.subscribeToTopic(tokens, topicName).then(value=>{
        console.log("Subscribed Success -", value.successCount, "Failed", value.failureCount, " ErrorList", value.errors.map(e => e.error).join(", "))
      })
      await firebaseMessaging.send(payload).then(res=>{
        // console.log("Batch", i+1, "/", splitToken.length, res)
      }).catch(err=>{
        console.log("Unable to Send Notification", err)
      })
      await firebaseMessaging.unsubscribeFromTopic(tokens, topicName).then(value=>{
        console.log("Unsubscribed Success -", value.successCount, "Failed", value.failureCount, " ErrorList", value.errors.map(e => e.error).join(", "))
      })
    })
  })
});

// Comments Like Notification
exports.comment_likes_Notification = onDocumentCreated('/Achievements/posts/postcollection/{postid}/comments/{commentid}/commentlikes/{id}',async (snapshotdata)=>{
  var firebaseMessaging = admin.messaging()
  var snapshot = snapshotdata.data
  var topicName = snapshot.id
  console.log("Comment Like ID: "+ snapshot.id);
  console.log("Comment ID: "+ snapshotdata.params.commentid);
  console.log("Post ID: "+ snapshotdata.params.postid);

  var name;
  var comment;
  var uid;
  var tokens = [];
  var count = await (await admin.firestore().collection("Achievements").doc("posts").collection("postcollection").doc(snapshotdata.params.postid).collection("comments").doc(snapshotdata.params.commentid).collection("commentlikes").get()).size.toString();

  await admin.firestore().collection("Achievements").doc("posts").collection("postcollection").doc(snapshotdata.params.postid).collection("comments").doc(snapshotdata.params.commentid).get().then(val=>{
    uid = val.data().uid;
    comment = val.data().comment;
    name = val.data().name;
  }).then(async ()=>{
    await admin.firestore().collection("FCM_token").where("uid", "==", uid).where("active", "==", true).get().then(doc=>{
      doc.forEach(value=>{
        tokens.push(value.data().FCM_id)
      })
    }).then(async ()=>{
      if(snapshot.data().uid != uid){
        await admin.firestore().collection("notifications").doc(uid).set({
          "name" : name,
          "read" : false,
        }, {merge : true}).then(async ()=>{
          await admin.firestore().collection("notifications").doc(uid).collection("logs").where("type" , "==", "commentlike").where("postid" , "==", snapshotdata.params.postid).where("commentid", "==", snapshotdata.params.commentid).get().then(async logs=>{
            if(logs.docs.length == 0){
              await admin.firestore().collection("notifications").doc(uid).collection("logs").add({
                "type" : "commentlike",
                "postid" : snapshotdata.params.postid,
                "commentid" : snapshotdata.params.commentid,
                "count" : count,
                "comment" : comment,
                "image" : null,
                "date" : admin.firestore.FieldValue.serverTimestamp()
              }).then(id=>{
                console.log("Notification ID: " + id.id)
              })
            }
            else{
              logs.docs[0].ref.update({
                "type" : "commentlike",
                "postid" : snapshotdata.params.postid,
                "commentid" : snapshotdata.params.commentid,
                "count" : count,
                "comment" : comment,
                "image" : null,
                "date" : admin.firestore.FieldValue.serverTimestamp()
              }).then(id=>{
                console.log("Notification ID: " + logs.docs[0])
              })
            }
          })
        })
      }

      let message = {
        "notification": {
          "title": name + " got new notification",
          "body": count + " People Liked Your Comment : " + comment,
        },
        "data": {
          "accountuid" : uid,
          "type" : "commentlike",
          "postid" : snapshotdata.params.postid,
          "commentid" : snapshotdata.params.commentid,
          "commentlikeid" : snapshot.id,
          "reference" : snapshot.ref.path.toString(),
          "click_action": "FLUTTER_NOTIFICATION_CLICK",
        },
        "android": {
          "notification": {
            "color": '#ffffff',
            "tag" : snapshotdata.params.commentid,
            "sound": "default",
          },
        },
        "apns": {
          "payload": {
            "aps": {
              "badge": 1,
              "sound": "default",
            },
          },
          "headers": {
            'apns-collapse-id': snapshotdata.params.commentid,
          }
        },
        // "tokens": tokens,
        "topic": topicName
      };
      await firebaseMessaging.subscribeToTopic(tokens, topicName).then(value=>{
        console.log("Subscribed Success -", value.successCount, "Failed", value.failureCount, " ErrorList", value.errors.map(e => e.error).join(", "))
      })
      await firebaseMessaging.send(message).then(res=>{
        // console.log("Batch", i+1, "/", splitToken.length, res)
      }).catch(err=>{
        console.log("Unable to Send Notification", err)
      })
      await firebaseMessaging.unsubscribeFromTopic(tokens, topicName).then(value=>{
        console.log("Unsubscribed Success -", value.successCount, "Failed", value.failureCount, " ErrorList", value.errors.map(e => e.error).join(", "))
      })
    })
  })
});

exports.onBreakthroughsPosted = onDocumentCreated('/Achievements/posts/postcollection/{postid}' ,async (snapshotdata)=>{
  var postData = snapshotdata.data.data()
  var postcategory = null

  await admin.firestore().doc(postData["postcategory"].path).get().then(doc =>{
    if(doc.exists){
      postcategory = doc.data()["type"]
    }
  })

  try {
    await commonService.updateParticipantTouchPoint({
      label: postcategory != null ? `New Post - ${postcategory}` : "New Post",
      notes: "",
      touchpoint: "Breakthroughs Posted",
      touchpointdate: postData["created"].toDate(),
      profileid: postData["profileid"],
      parentreference: snapshotdata.data.ref,
    })
  } catch (error) {
    console.log("Touch Point Error - Breakthrough Posted", error.toString())
  }
  /*
  var snapshot = snapshotdata.data
  var data = snapshot.data();
  // timeline log
  var docid = data['postid']
  var logdata = {
    logid: docid,
    created: new Date(),
    activityname: "achievement",
    postcategory: data["postcategory"],
    postmessage: data['postmessage'],
    activitydate: data['created'],
    profileid: data["profileid"],
    paralleltrajectory:data['paralleltrajectory'],
    uid : data['uid']
  }
  await admin.firestore().collection('timeline log').doc(docid).set(logdata).then(() => {
    console.log("timelog updated for the breakthrough",data['postid']);
  })
  */
})



// livechangework
exports.livechangeworkadjustment = onDocumentCreated("livechangework/{docid}",async (snapshotdata) => {
    const snapshot = snapshotdata.data;
    const documentData = snapshot.data();
    if (
      documentData.adjustment !== undefined &&
      documentData.adjustment !== null &&
      documentData.adjustment !== ''
    ) {      
      return;
    }
    const procedureRef = documentData.procedureref;
    const adjustRef = procedureRef?.parent?.parent;

    if (!adjustRef) {
      console.log("No ref");
      return;
    }
    const adjustSnap = await adjustRef.get();
    if (!adjustSnap.exists) {
      console.log("Adjustment not found");
      return;
    }
    const adjustmentName = adjustSnap.get("name");
    if (!adjustmentName) {
      console.log("No name");
      return;
    }
    await snapshot.ref.update({
      adjustment: adjustmentName
    });

    console.log("updated...", adjustmentName);
  }
);
