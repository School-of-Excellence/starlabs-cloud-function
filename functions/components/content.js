const admin = require('firebase-admin');
const commonService = require('./service');
const { onDocumentCreated,onDocumentWritten} = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler")
const { onRequest } = require("firebase-functions/v2/https");
const cors = require("cors")({ origin: true });
const process = require("process") // NodeJS Process
const https = require('https'); // HTTP Request/Response

//publitio
const PublitioAPI = require('publitio_js_sdk').default
const {defineSecret} = require("firebase-functions/params");
const { publitioApi } = require('publitio_js_sdk');
const publitioSecret = defineSecret("PUBLITIO_SECRET")
const publitioKey = defineSecret("PUBLITIO_KEY")


exports.communityPostHLS = onDocumentWritten({
  document : '/community post/{id}',
  secrets:[publitioKey,publitioSecret]
}, async (snapshot) => {
    const publitio = new PublitioAPI(publitioKey.value(),publitioSecret.value())
    var change = snapshot.data
    var doc = change.after
    var data = change.after.data()
    var oldData = change.before.exists ? change.before.data() : {}
    if(data != null && data != undefined && (data["type"] == "story" || data["type"] == "post")){
      var videos = data["videos"] != null && data["videos"] != undefined ? data["videos"] : []
      for (let j = 0; j < videos.length; j++) {
        var item = videos[j];
  
        // Video
        var url = item["video"]
        var oldVideos = oldData["videos"] == null || oldData["videos"] == undefined ? [] : oldData["videos"]
        if(url != null && url != undefined){
          console.log(oldVideos.filter(e => e["video"] == url && (e["hls"] != null && e["hls"] != undefined)).length, "URL", url)
          if(oldVideos.filter(e => e["video"] == url && (e["hls"] != null && e["hls"] != undefined)).length == 0){
            await publitio.uploadRemoteFile({file_url: url, privacy: 1, option_hls: 0, folder: "CommunityStories"}).then(async data => {
              console.log(data)
              // /*
              if(data.code == 201){
                var value = {
                  hls_preview:data['url_preview'],
                  hls_thumbnail:data['url_thumbnail'],
                  hls_short:data['url_short'],
                  hls_stream:data['url_stream'],
                  hls_download:data['url_download'],
                  hls_embed:data['url_embed'],
                  responsepublitio:data
                }
                item["hls"] = value
  
                // Create 480P Version
                await publitio.call('/files/versions/create/' + data['id'], 'POST', {
                  extension: 'mp4',
                  options: 'h_480'
                }).then(async data => {
                  await doc.ref.update({
                    videos: videos,
                    convertedtohls: videos.every(e => e["hls"] != null && e["hls"] != undefined)
                  }).then(async () => {
                    console.log('document updated successfully')
                  })
                  console.log("Version Created ---------", data) 
                }).catch((error) => {
                  console.log("Error Call ******", error)
                })
              }
              // */
            })
          }
        }
  
        // thumbnail
        if(oldVideos.filter(e => e["thumbnail"] == item["thumbnail"] && (e["thumbnailhls"] != null && e["thumbnailhls"] != undefined)).length == 0){
          await publitio.uploadRemoteFile({file_url: item["thumbnail"], privacy: 1, option_hls: 0, folder: "CommunityStories"}).then(async data => {
            console.log(data)
            // /*
            if(data.code == 201){
              var value = {
                responsepublitio:data
              }
              item["thumbnailhls"] = value
              // Create 360P Version
              await publitio.call('/files/versions/create/' + data['id'], 'POST', {
                extension: 'jpg',
                options: 'q_50'
              }).then(async data => {
                await doc.ref.update({
                  videos: videos,
                  convertedtohls: videos.every(e => e["hls"] != null && e["hls"] != undefined)
                }).then(async () => {
                  console.log('document updated successfully')
                })
                console.log("Version Created ---------", data) 
              }).catch((error) => {
                console.log("Error Call ******", error)
              })
            }
          })
        }
      }
    }
})

exports.videoAskHLS = onDocumentCreated({
  document:'/participantvideoask/{id}',
  secrets:[publitioKey,publitioSecret]
}, async (snap) => {
    const publitio = new publitioApi(publitioKey.value(),publitioSecret.value())
    var document = snap.data
    var data = document.data()
    var fileURL = data["fileurl"]
    await publitio.uploadRemoteFile({file_url: fileURL, privacy: 1, option_hls: 0, folder: "VideoAsk"}).then(async result => {
      console.log(result)
      // /*
      if(result.code == 201){
        // Create 480P Version
        await publitio.call('/files/versions/create/' + result['id'], 'POST', {
          extension: 'mp4',
          options: 'h_480'
        }).then(async data => {
          await document.ref.update({
            hls: result,
            convertedtohls: true
          }).then(async () => {
            console.log('document updated successfully')
          })
          console.log("Version Created ---------", data) 
        }).catch((error) => {
          console.log("Error Call ******", error)
        })
      }
      // */
    })
})

exports.slackContentConsumption = onDocumentCreated("content analytics/{docid}", async (document) => {
    var snapshot = document.data
    var data = snapshot.data()
    var videoname = data["videoname"]
    var profilename = (await admin.firestore().collection("profile_data").doc(data["profileid"]).get()).data()["name"]
    var url = null
    if(commonService.production){
      url = commonService.slackLogVideoWatch
    }
    else{
      url = commonService.slackDevTest
    }
    if(url != null){
      var webhook = new commonService.IncomingWebhook(url);
      var message = `${profilename} has started ${data["type"] == "solarvoice" ? "Listening to" : "watching the video"} - ${videoname}
      To get full details:
      https://app.posthog.com/person/${data['profileid']}#activeTab=events
      `;
      console.log(message.toString())
      webhook.send(message, function(err, header, statusCode, body) {
        if (err) {
          console.log('Error:', err);
        } else {
          console.log('Received', statusCode, 'from Slack');
        }
      });
    }
})

//from buffermix archive to recommended playlist
exports.buffermixToRecommendedPlaylist = onDocumentCreated("buffermix archive/{docid}", async(snap) => {
    var snapshot = snap.data
    if(snapshot.exists){
      console.log(snap.params.docid);
      console.log(snapshot.data()['docid']);
      let data = snapshot.data()
      let dataRef = snapshot.ref
      console.log(dataRef.path);
      let listOfRecommendedPlaylist = []
      //
      for (let i = 0; i < data['profileid'].length; i++) {
        const profileid = data['profileid'][i];
        console.log(i);
        let contentTypes = ['eiflix','solarvoice','generalcontent'] 
        for (let j = 0; j < contentTypes.length; j++) {
          if(data[contentTypes[j]].length != 0){
            console.log(contentTypes[j]);
            let doc = {}
            doc['profileid'] = profileid
            doc['title'] = data['title']
            doc['description'] = data['description']
            doc['expiredate'] = data['expiredate']
            doc['bufferdocref'] = dataRef
            doc['date'] = data['date'].toDate()
            let docid = admin.firestore().collection("recommended mix playlist").doc().id
            doc['id'] = docid
            doc['type'] = contentTypes[j]
            doc['list'] = data[contentTypes[j]]
            doc['personalised'] = data['personalised']
            if(data['personalised']){
              doc['recommendedby'] = data['recommendedby']
              doc['recommendedbyname'] = data['recommendedbyname']
            }
            listOfRecommendedPlaylist.push(doc)
          }
        }
      }
      //
      let batch = admin.firestore().batch()
      for (let i = 0; i < listOfRecommendedPlaylist.length; i++) {
        const element = listOfRecommendedPlaylist[i];
        let ref = admin.firestore().collection("recommended mix playlist").doc(element['id'])
        batch.set(ref,element)
        if(i != 0 && i%400 == 0){
          await batch.commit().then(() => {
            batch = admin.firestore().batch()
            console.log("batch commited",i%400);
          }).catch(err => {
            console.log(err);
          })
        }
      }
      // total batch commit
      await batch.commit().then(() => {
        dataRef.update({status:"completed"})
        console.log("document updated");
      }).catch(err => {
        console.log(err);
      })
    }
})

exports.ConvertUrltoHLS = onDocumentWritten({
  document : '/episodes/{id}',
  secrets : [publitioKey,publitioSecret],
},async (change) => {
  
  const publitio = new PublitioAPI(publitioKey.value(),publitioSecret.value())

  let previousData = change.data.before.exists ? change.data.before.data() : {};
  let newData = change.data.after.exists ? change.data.after.data() : {};

  var thumbnailhls = null
  // Thumbnail Upload
  if(previousData["imageUrl"] != newData["imageUrl"]){
    await publitio.uploadRemoteFile({file_url: newData["imageUrl"], privacy: 1, option_hls: 0}).then(async data => {
      console.log("Thumbnail Change", data)
      if(data.code == 201){
        thumbnailhls = data
      }
    })
  }
  else{
    console.log("Thumbnail No Change")
  }
  // Video Upload
  if(previousData["videoUrl"] != newData["videoUrl"]){
    publitio.uploadRemoteFile({file_url: newData['videoUrl'], privacy: 1, option_hls: 1}).then(async data => {
      console.log("Video Change", data)
      if(data.code == 201){
        await change.data.after.ref.update({
          convertedtohls: true,
          hsl_preview: data['url_preview'],
          hsl_thumbnail: data['url_thumbnail'],
          hsl_short: data['url_short'],
          hsl_stream: data['url_stream'],
          hsl_download: data['url_download'],
          hsl_embed: data['url_embed'],
          responsepublitio: data,
          thumbnailhls: thumbnailhls
        }).then(async () => {
          console.log('document updated successfully')
        })
      }
    })
  }
  else{
    console.log("Video No Change")
  }
})

exports.UnconvertedUrltoHLS = onSchedule({
  schedule:'every 6 hours',
  secrets:[publitioKey,publitioSecret]
},async (context) => {
  const publitio = new PublitioAPI(publitioKey.value(),publitioSecret.value())
  await admin.firestore().collection('episodes').where("convertedtohls","==",false).get().then((res) => {
    res.forEach(async doc => {
      // console.log(doc.data()['responsepublitio'])
      if(doc.data()['responsepublitio'] === undefined){
        console.log(doc.data())
        publitio.uploadRemoteFile({file_url:doc.data()['videoUrl'], privacy: 1, option_hls: 1}).then( data => {
          console.log(data)
          if(data.code == 201){
            doc.ref.update({
              convertedtohls:true,
              hsl_preview:data['url_preview'],
              hsl_thumbnail:data['url_thumbnail'],
              hsl_short:data['url_short'],
              hsl_stream:data['url_stream'],
              hsl_download:data['url_download'],
              hsl_embed:data['url_embed'],
              responsepublitio:data
            }).then(() => {
              console.log('document updated successfully')
            }).catch(err => {
              console.log(err)
            })
          }
        })
      }
    })
  })
})

exports.generalContentUpdate = onDocumentWritten({document : '/content_urls/{id}'}, async (change) => {
  let previousData = change.data.before.exists ? change.data.before.data() : {};
  let newData = change.data.after.exists ? change.data.after.data() : {};

  if(previousData["thumbnail"] != newData["thumbnail"] || previousData["url"] != newData["url"]){
    var url = `https://us-central1-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/uploadContentToPublitio?contentid=${change.data.after.id}&contenttype=generalcontent`
    https.get(url);
  }
})

exports.uploadContentToPublitio = onRequest({secrets: [publitioKey, publitioSecret]}, async (req, res) => {
  cors(req, res, async () => {
    const contentID = req.query.contentid
    const contentType = req.query.contenttype

    var contentData = {}
    if(contentType == "generalcontent"){
      await admin.firestore().collection("content_urls").doc(contentID).get().then(async doc =>{
        if(doc.exists){
          const data = doc.data()
          contentData = {
            thumbnail: data["thumbnail"],
            videourl: data["url"],
            documentpath: doc.ref.path
          }
        }
      })
    }

    if(Object.keys(contentData).length != 0){
      await admin.firestore().doc(contentData["documentpath"]).update({
        hlsstatus: "uploading",
        convertedtohls: false
      })

      // Start Publitio Upload
      const publitio = new PublitioAPI(publitioKey.value(), publitioSecret.value())
      var newPublitioData = {}

      // Thumbnail
      if(contentData["thumbnail"]){
        await publitio.uploadRemoteFile({file_url: contentData["thumbnail"], privacy: 1, option_hls: 0}).then(async data => {
          console.log("Thumbnail Change", data)
          if(data.code == 201){
            newPublitioData["thumbnailhls"] = data
          }
        })
      }

      // Video
      if(contentData["videourl"]){
        await publitio.uploadRemoteFile({file_url: contentData["videourl"], privacy: 1, option_hls: 1}).then(async data => {
          console.log("Video Change", data)
          if(data.code == 201){
            newPublitioData["responsepublitio"] = data
          }
        })
      }

      if(Object.keys(newPublitioData).length != 0){
        newPublitioData["hlsstatus"] = "uploaded"
        newPublitioData["convertedtohls"] = true
        await admin.firestore().doc(contentData["documentpath"]).update(newPublitioData)
      }
      else{
        await admin.firestore().doc(contentData["documentpath"]).update({
          hlsstatus: "upload failed",
          convertedtohls: false
        })
      }
    }

    res.send(contentData)
  })
})