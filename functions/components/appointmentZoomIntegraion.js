const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const commonService = require('./service');
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const admin = require('firebase-admin');
const https = require('https'); // HTTP Request/Response
const axios = require("axios"); // Promise based HTTP Client
const { Buffer } = require('buffer');
const { onSchedule } = require("firebase-functions/v2/scheduler");
// zoom
const { defineSecret } = require('firebase-functions/params');
const zoomAccountId = defineSecret("ZOOM_ACCOUNTID");
const zoomClientId = defineSecret("ZOOM_CLIENTID");
const zoomClientSecret = defineSecret("ZOOM_CLIENTSECRET");
const zoomSDkClientId = defineSecret("ZOOM_SDK_CLIENTID");
const zoomSDKClientSecret = defineSecret("ZOOM_SDK_CLIENTSECRET");
const zoomWebhookSecretToken = defineSecret("ZOOM_WEBHOOK_SECRET_TOKEN")

// Request Scheduling
exports.requestScheduling = onRequest(async (req, res) => {
  try {
    var bodyData = req.body
    var name = bodyData["name"]
    var timestamp = bodyData["timestamp"]
    var appointment = bodyData["appointment"]
    var productname = bodyData["productname"]
    console.log(bodyData)
    console.log("Button Pressed", name, timestamp, appointment, productname)
    await slackScheduleRequest({
      name: name,
      appointment: appointment,
      productname: productname,
      timestamp: timestamp
    });
    const result = {
      success: true,
      message: "Request appointment",
      timestamp: timestamp,
    };
    res.status(200).json(result);
  } catch (error) {
    logger.error("Cloud Function Error:", error);
    res.status(500).send("Internal Server Error");
  }
});

async function slackScheduleRequest({name, timestamp, appointment, productname}) {
  var webhookUrl = commonService.production ? commonService.slackLogScheduling : commonService.slackDevTest
  if (!webhookUrl) {
    logger.warn("Slack webhook URL not configured");
    return;
  }
  try {
    const message = {
      text: "🗓️ New Appointment Request",
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🗓️ New Appointment Request",
          },
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*Name:*\n${name}`,
            },
            {
              type: "mrkdwn",
              text: `*Request time:*\n${timestamp}`,
            },
            {
              type: "mrkdwn",
              text: `*Appointment Type:*\n${appointment}`,
            },
            {
              type: "mrkdwn",
              text: `*Product Name:*\n${productname}`,
            },
          ],
        },
      ],
    };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status}`);
    }

    logger.info("Slack notification sent successfully");
  } catch (error) {
    logger.error("Failed to send Slack notification:", error);
  }
}

// Resend Appointment Email
exports.resentAppointmentEmail = onRequest({secrets: [zoomAccountId, zoomClientId, zoomClientSecret, zoomSDkClientId, zoomSDKClientSecret]}, async (req, res)=>{
  var appointmentID = req.query.appointmentid
  try {
    await admin.firestore().collection("appointments").doc(appointmentID).get().then(async snapshot=>{
      if(snapshot.exists){
        var appointmentname = ""
        var duration;
        var bookedby = {
          name: "",
          email: ""
        }
        var date = ""
        var hosts = [{
          name: "",
          email: "",
          role: "",
        }]
        hosts = []
        var zoomurl = ""

        // Fetch Appointment Data
        await admin.firestore().doc(snapshot.data()["appointment"].path).get().then(appointmentDoc=>{
          var name = appointmentDoc.data()["appointmenttype"]
          var list = name.split(" ")
          var value = ""
          for (let i = 0; i < list.length; i++) {
            const element = list[i];
            if(element.toLowerCase() != "type"){
              value = value + " " + element
            }
            else{
              break
            }
          }
          appointmentname = value.trim()
          duration = appointmentDoc.data()["duration"].toString() + " Mins"
        })

        // Fetch Participant Data
        await admin.firestore().doc(snapshot.data()["bookedby"].path).get().then(profile=>{
          bookedby.name = profile.data()["name"]
          bookedby.email = profile.data()["email"]
        })

        // Fetch Appointment Roles
        var appointmentRoles = []
        for (let i = 0; i < snapshot.data()["appointmentrole"].length; i++) {
          const element = snapshot.data()["appointmentrole"][i];
          appointmentRoles.push(element.path)
        }
        appointmentRoles = Array.from(new Set(appointmentRoles))
        for (let i = 0; i < appointmentRoles.length; i++) {
          const aptRole = appointmentRoles[i];
          const roleName = (await admin.firestore().doc(aptRole).get()).data()["role"].toLowerCase()
          for (let j = 0; j < snapshot.data()["hostRole"][aptRole].length; j++) {
            var host = snapshot.data()["hostRole"][aptRole][j];
            await admin.firestore().doc(host.path).get().then(profile=>{
              hosts.push({
                name: profile.data()["name"],
                email: profile.data()["email"],
                role: roleName
              })
            })
          }
        }

        var starttime = snapshot.data()["starttime"].toDate()
        var endtime = snapshot.data()["endtime"].toDate()
        var formatedStartTime = new Date(starttime.getFullYear(), starttime.getMonth(), starttime.getDate(), starttime.getHours()+5, starttime.getMinutes()+30, 0);
        var formatedEndTime = new Date(endtime.getFullYear(), endtime.getMonth(), endtime.getDate(), endtime.getHours()+5, endtime.getMinutes()+30, 0);
        date = formatedStartTime.toDateString() + " at " + (formatedStartTime.getHours()%12 || 12) + ":" + (formatedStartTime.getMinutes().toString().length == 1 ? ("0"+formatedStartTime.getMinutes().toString()) : formatedStartTime.getMinutes()) + (formatedStartTime.getHours() < 12 ? "AM" : "PM") + " - " + (formatedEndTime.getHours()%12 || 12) + ":" + (formatedEndTime.getMinutes().toString().length == 1 ? ("0"+formatedEndTime.getMinutes().toString()) : formatedEndTime.getMinutes()) + (formatedEndTime.getHours() < 12 ? "AM" : "PM") + " IST"
        
        // Generate Zoom link if appointment is within 24 hours
        var currentTime = new Date()
        var twentyfourHourFromNow = new Date(currentTime.getTime() + (24 * 60 * 60 * 1000))
        
        if(snapshot.data()["zoomdata"]){
          zoomurl = snapshot.data()["zoomdata"]['join_url']
        }
        if(starttime <= twentyfourHourFromNow && starttime >= currentTime && [null, undefined].includes(zoomurl)) {
          console.log("Appointment is within 24 hour, generating Zoom link...")

          // Request Zoom Meeting
          var requestedZoomResult = await commonService.generateZoomMeeting({
            requestpath: snapshot.ref.path,
            zoomAccountId: zoomAccountId.value(),
            zoomClientId: zoomClientId.value(),
            zoomClientSecret: zoomClientSecret.value(),
            zoomSDkClientId: zoomSDkClientId.value(),
            zoomSDKClientSecret: zoomSDKClientSecret.value()
          })

          if(requestedZoomResult){
            var zoomresult = requestedZoomResult["result"]
            console.log("zoom created ", zoomresult.data['join_url']);
            zoomurl = zoomresult.data['join_url'] 
          }   
        }

        // Send Email
        var dataModel = {
          subject: `Your appointment for ${appointmentname} is confirmed!`,
          product_name: "StarLabs - Scheduling",
          appointment: appointmentname,
          date: date,
          duration: duration,
          client: bookedby.name,
          company_name: "Antano & Harini",
        }
        if((zoomurl || "").trim().length != 0){
          dataModel["zoomurl"] = zoomurl
        }

        var names = []
        for (let i = 0; i < hosts.length; i++) {
          const hostName = hosts[i].name;
          names.push(hostName)
          if(hosts[i].role.includes("collaborator")){
            dataModel["implementation"] = dataModel["implementation"] == undefined ? ""+hostName : dataModel["implementation"] + ", " + hostName
          }
          else if(hosts[i].role.includes("shadow") && hosts[i].role.includes("implementation")){
            dataModel["implementationshadow"] = dataModel["implementationshadow"] == undefined ? ""+hostName : dataModel["implementationshadow"] + ", " + hostName
          }
          else if(!hosts[i].role.includes("shadow") && hosts[i].role.includes("implementation")){
            dataModel["implementation"] = dataModel["implementation"] == undefined ? ""+hostName : dataModel["implementation"] + ", " + hostName
          }
          else if(hosts[i].role.includes("diagnostic")){
            dataModel["diagnostic"] = dataModel["diagnostic"] == undefined ? ""+hostName : dataModel["diagnostic"] + ", " + hostName
          }
          else if(hosts[i].role.includes("clarity")){
            dataModel["accelerator"] = dataModel["accelerator"] == undefined ? ""+hostName : dataModel["accelerator"] + ", " + hostName
          }
          else if(hosts[i].role.includes("testimonial")){
            dataModel["sales"] = dataModel["sales"] == undefined ? ""+hostName : dataModel["sales"] + ", " + hostName
          }
          else{
            dataModel["host"] = dataModel["host"] == undefined ? ""+hostName : dataModel["host"] + ", " + hostName
          }
        }
        // Calendar Data
        var calendarData =
        "BEGIN:VCALENDAR\n" +
        "CALSCALE:GREGORIAN\n" +
        "METHOD:PUBLISH\n" +
        "PRODID:-//Test Cal//EN\n" +
        "VERSION:2.0\n" +
        "BEGIN:VEVENT\n" +
        "UID:test-1\n" +
        "DTSTART;VALUE=DATE:" + commonService.convertDate(starttime) +
        "\n" +
        "DTEND;VALUE=DATE:" + commonService.convertDate(endtime) +
        "\n" +
        "SUMMARY:" + appointmentname +
        "\n" +
        "SEQUENCE:0\n" +
        "DESCRIPTION:" + "Appointment Scheduled For " + appointmentname +
        "\n" +
        "ORGANIZER;CN="+names.join(', ')+":MAILTO:vignesh.s@soexcellence.com" +
        "\n" +
        "END:VEVENT\n" +
        "END:VCALENDAR";

        // Import Scheduler Email for CC
        var appointmentProduct = snapshot.data()["productid"]
        var model
        if(appointmentProduct){
          await admin.firestore().collection("products").doc(appointmentProduct).get().then(productMeta =>{
            if(productMeta.exists){
              model = productMeta.data()["atcmodel"]
            }
          })
        }
        var schedulerMail
        await admin.firestore().doc("/classify/mailscheduler").get().then(async scheduler =>{
          if(scheduler.exists && model){
            var schedulerData = scheduler.data()
            schedulerMail = (schedulerData[model] ?? []).join(", ")
          }
        })
        
        // Mail Participant
        await commonService.postmarkClient.sendEmailWithTemplate({
          From: "starlabs@excellenceinstallation.com",
          To: bookedby.email,
          Cc: schedulerMail,
          TemplateAlias: "appointment-scheduled-v2",
          TemplateModel: dataModel,
          Attachments: [
            {
            "Name": "appointment.ics",
            "Content": Buffer.from(calendarData).toString('base64'),
            "ContentType": "text/calendar; charset=utf-8; method=REQUEST"
            }
          ],
        }).catch(err=>{
          console.log(err)
        });

        // Mail Host
        var hostSubject = `Your appointment for ${appointmentname} is confirmed with ${bookedby.name}`
        var hostDataModel = dataModel
        hostDataModel["subject"] = hostSubject
        hostDataModel["zoomurl"] = commonService.production ? "https://breakthroughs.app/appointmentstudio" : "https://breakthroughs-test.web.app/appointmentstudio"
        // for (let i = 0; i < hosts.length; i++) {
        //   const element = hosts[i];
        var hostMail = hosts.map(e => e.email).join(", ")
          await commonService.postmarkClient.sendEmailWithTemplate({
            From: "starlabs@excellenceinstallation.com",
            To: hostMail,
            Cc: schedulerMail,
            TemplateAlias: "appointment-scheduled-v2",
            TemplateModel: hostDataModel,
            Attachments: [
              {
              "Name": "appointment.ics",
              "Content": Buffer.from(calendarData).toString('base64'),
              "ContentType": "text/calendar; charset=utf-8; method=REQUEST"
              }
            ],
          }).catch(err=>{
            console.log(err)
          });
        // }
      }
    })
    res.send("Success")
  } catch (error) {
    console.log("Error", error)
    res.send(JSON.stringify(error))
  }
  
})

// Compute slot for Every Appointment based on the given Availability
exports.computeSlot = onDocumentCreated("/availability/{docid}", async (snapshotdata) =>{
  var snapshot = snapshotdata.data
  var documentData = snapshot.data()
  var starttime = new Date(documentData.starttime.toDate())
  var endtime = new Date(documentData.endtime.toDate())

  var preferedAppointment = []
  for (let i = 0; i < documentData.appointments.length; i++) {
    const element = documentData.appointments[i].path;
    await admin.firestore().doc(element).get().then(appointment=>{
      var apptData = appointment.data()
      preferedAppointment.push({
        id: appointment.id,
        duration: apptData["duration"],
        groupappointment: apptData["groupappointment"] != null && apptData["groupappointment"] != undefined ? apptData["groupappointment"] : null,
        maxbooking: apptData["maxbooking"] != null && apptData["maxbooking"] != undefined ? apptData["maxbooking"] : null
      })
    })
  }
  preferedAppointment = preferedAppointment.sort((a, b)=> b.duration - a.duration)

  var slots = []
  for (let i = 0; i < preferedAppointment.length; i++) {
    var appointmentStart = starttime
    var appointmentEnd = endtime
    while (appointmentEnd > appointmentStart) {
      const appointment = preferedAppointment[i];
      var hour = parseInt((appointment.duration/60))
      var minute = (appointment.duration%60)
  
      var slotStart = new Date(appointmentStart)
      var slotEnd = new Date(new Date(appointmentStart).setHours(slotStart.getHours() + hour, slotStart.getMinutes() + minute, 0))
  
      appointmentStart = new Date(new Date(slotStart).setMinutes(slotStart.getMinutes() + 30, 0))
  
      if(appointmentEnd >= slotEnd){
        var slotData = {
          id: appointment.id,
          slotstart: slotStart,
          slotend: slotEnd,
          booked: false,
          available: true
        }
        if(appointment.groupappointment != null){
          slotData["groupappointment"] = appointment.groupappointment
        }
        if(appointment.maxbooking != null){
          slotData["maxbooking"] = appointment.maxbooking
        }
        slots.push(slotData)
      } 
    }
  }

  for (let i = 0; i < preferedAppointment.length; i++) {
    var appointmentSlot = slots.filter(e => e.id === preferedAppointment[i].id)
    var value = {}
    value[preferedAppointment[i].id] = appointmentSlot
    await snapshot.ref.update(value).catch(err=>{
      console.log(err)
    })
  }
})

// New Appointment Booked
exports.appointmentbooked = onDocumentCreated({document : "/appointments/{docid}", secrets: [zoomAccountId, zoomClientId, zoomClientSecret, zoomSDkClientId, zoomSDKClientSecret]}, async (snapshotdata) =>{
  var snapshot = snapshotdata.data
  if(snapshot.exists){
    var appointmentname = ""
    var duration;
    var bookedby = {
      name: "",
      email: ""
    }
    var date = ""
    var hosts = [{
      name: "",
      email: "",
      role: "",
    }]
    hosts = []
    var zoomurl = ""

    // Fetch Appointment Data
    await admin.firestore().doc(snapshot.data()["appointment"].path).get().then(appointmentDoc=>{
      var name = appointmentDoc.data()["appointmenttype"]
      var list = name.split(" ")
      var value = ""
      for (let i = 0; i < list.length; i++) {
        const element = list[i];
        if(element.toLowerCase() != "type"){
          value = value + " " + element
        }
        else{
          break
        }
      }
      appointmentname = value.trim()
      duration = appointmentDoc.data()["duration"].toString() + " Mins"
    })

    // Fetch Participant Data
    await admin.firestore().doc(snapshot.data()["bookedby"].path).get().then(profile=>{
      bookedby.name = profile.data()["name"]
      bookedby.email = profile.data()["email"]
    })

    // Fetch Appointment Roles
    var appointmentRoles = []
    for (let i = 0; i < snapshot.data()["appointmentrole"].length; i++) {
      const element = snapshot.data()["appointmentrole"][i];
      appointmentRoles.push(element.path)
    }
    appointmentRoles = Array.from(new Set(appointmentRoles))
    for (let i = 0; i < appointmentRoles.length; i++) {
      const aptRole = appointmentRoles[i];
      const roleName = (await admin.firestore().doc(aptRole).get()).data()["role"].toLowerCase()
      for (let j = 0; j < snapshot.data()["hostRole"][aptRole].length; j++) {
        var host = snapshot.data()["hostRole"][aptRole][j];
        await admin.firestore().doc(host.path).get().then(profile=>{
          hosts.push({
            name: profile.data()["name"],
            email: profile.data()["email"],
            role: roleName
          })
        })
      }
    }

    var starttime = snapshot.data()["starttime"].toDate()
    var endtime = snapshot.data()["endtime"].toDate()
    var formatedStartTime = new Date(starttime.getFullYear(), starttime.getMonth(), starttime.getDate(), starttime.getHours()+5, starttime.getMinutes()+30, 0);
    var formatedEndTime = new Date(endtime.getFullYear(), endtime.getMonth(), endtime.getDate(), endtime.getHours()+5, endtime.getMinutes()+30, 0);
    date = formatedStartTime.toDateString() + " at " + (formatedStartTime.getHours()%12 || 12) + ":" + (formatedStartTime.getMinutes().toString().length == 1 ? ("0"+formatedStartTime.getMinutes().toString()) : formatedStartTime.getMinutes()) + (formatedStartTime.getHours() < 12 ? "AM" : "PM") + " - " + (formatedEndTime.getHours()%12 || 12) + ":" + (formatedEndTime.getMinutes().toString().length == 1 ? ("0"+formatedEndTime.getMinutes().toString()) : formatedEndTime.getMinutes()) + (formatedEndTime.getHours() < 12 ? "AM" : "PM") + " IST"
    
    // Generate Zoom link if appointment is within 24 hour
    var currentTime = new Date()
    var twentyfourHourFromNow = new Date(currentTime.getTime() + (24 * 60 * 60 * 1000)) 
    
    if(starttime <= twentyfourHourFromNow && starttime >= currentTime) {
      console.log("Appointment is within 24 hour, generating Zoom link...")

      // Request Zoom Meeting
      var requestedZoomResult = await commonService.generateZoomMeeting({
        requestpath: snapshot.ref.path,
        zoomAccountId: zoomAccountId.value(),
        zoomClientId: zoomClientId.value(),
        zoomClientSecret: zoomClientSecret.value(),
        zoomSDkClientId: zoomSDkClientId.value(),
        zoomSDKClientSecret: zoomSDKClientSecret.value()
      })

      if(requestedZoomResult){
        var zoomresult = requestedZoomResult["result"]
        console.log("zoom created ", zoomresult.data['join_url']);
        zoomurl = zoomresult.data['join_url'] 
      }
    }

    // Send Email
    var dataModel = {
      subject: `Your appointment for ${appointmentname} is confirmed!`,
      product_name: "StarLabs - Scheduling",
      appointment: appointmentname,
      date: date,
      duration: duration,
      client: bookedby.name,
      company_name: "Antano & Harini",
    }
    if((zoomurl || "").trim().length != 0){
      dataModel["zoomurl"] = zoomurl
    }

    // var hostDataModel = {
    //   subject: `Your appointment for ${appointmentname} is confirmed with ${bookedby.name}`,
    //   product_name: "StarLabs - Scheduling",
    //   appointment: appointmentname,
    //   date: date,
    //   duration: duration,
    //   client: bookedby.name,
    //   zoomurl: commonService.production ? "https://breakthroughs.app/appointmentstudio" : "https://breakthroughs-test.web.app/appointmentstudio",
    //   company_name: "Antano & Harini",
    // }
    var names = []
    for (let i = 0; i < hosts.length; i++) {
      const hostName = hosts[i].name;
      names.push(hostName)
      if(hosts[i].role.includes("collaborator")){
        dataModel["implementation"] = dataModel["implementation"] == undefined ? ""+hostName : dataModel["implementation"] + ", " + hostName
      }
      else if(hosts[i].role.includes("shadow") && hosts[i].role.includes("implementation")){
        dataModel["implementationshadow"] = dataModel["implementationshadow"] == undefined ? ""+hostName : dataModel["implementationshadow"] + ", " + hostName
      }
      else if(!hosts[i].role.includes("shadow") && hosts[i].role.includes("implementation")){
        dataModel["implementation"] = dataModel["implementation"] == undefined ? ""+hostName : dataModel["implementation"] + ", " + hostName
      }
      else if(hosts[i].role.includes("diagnostic")){
        dataModel["diagnostic"] = dataModel["diagnostic"] == undefined ? ""+hostName : dataModel["diagnostic"] + ", " + hostName
      }
      else if(hosts[i].role.includes("clarity")){
        dataModel["accelerator"] = dataModel["accelerator"] == undefined ? ""+hostName : dataModel["accelerator"] + ", " + hostName
      }
      else if(hosts[i].role.includes("testimonial")){
        dataModel["sales"] = dataModel["sales"] == undefined ? ""+hostName : dataModel["sales"] + ", " + hostName
      }
      else{
        dataModel["host"] = dataModel["host"] == undefined ? ""+hostName : dataModel["host"] + ", " + hostName
      }
    }
    // Calendar Data
    var calendarData =
    "BEGIN:VCALENDAR\n" +
    "CALSCALE:GREGORIAN\n" +
    "METHOD:PUBLISH\n" +
    "PRODID:-//Test Cal//EN\n" +
    "VERSION:2.0\n" +
    "BEGIN:VEVENT\n" +
    "UID:test-1\n" +
    "DTSTART;VALUE=DATE:" + commonService.convertDate(starttime) +
    "\n" +
    "DTEND;VALUE=DATE:" + commonService.convertDate(endtime) +
    "\n" +
    "SUMMARY:" + appointmentname +
    "\n" +
    "SEQUENCE:0\n" +
    "DESCRIPTION:" + "Appointment Scheduled For " + appointmentname +
    "\n" +
    "ORGANIZER;CN="+names.join(', ')+":MAILTO:vignesh.s@soexcellence.com" +
    "\n" +
    "END:VEVENT\n" +
    "END:VCALENDAR";

    // Import Scheduler Email for CC
    var appointmentProduct = snapshot.data()["productid"]
    var model
    if(appointmentProduct){
      await admin.firestore().collection("products").doc(appointmentProduct).get().then(productMeta =>{
        if(productMeta.exists){
          model = productMeta.data()["atcmodel"]
        }
      })
    }
    var schedulerMail
    await admin.firestore().doc("/classify/mailscheduler").get().then(async scheduler =>{
      if(scheduler.exists && model){
        var schedulerData = scheduler.data()
        schedulerMail = (schedulerData[model] ?? []).join(", ")
      }
    })
    
    // Mail Participant
    await commonService.postmarkClient.sendEmailWithTemplate({
      From: "starlabs@excellenceinstallation.com",
      To: bookedby.email,
      Cc: schedulerMail,
      TemplateAlias: "appointment-scheduled-v2",
      TemplateModel: dataModel,
      Attachments: [
        {
        "Name": "appointment.ics",
        "Content": Buffer.from(calendarData).toString('base64'),
        "ContentType": "text/calendar; charset=utf-8; method=REQUEST"
        }
      ],
    }).catch(err=>{
      console.log(err)
    });

    // Mail Host
    var hostSubject = `Your appointment for ${appointmentname} is confirmed with ${bookedby.name}`
    var hostDataModel = dataModel
    hostDataModel["subject"] = hostSubject
    hostDataModel["zoomurl"] = commonService.production ? "https://breakthroughs.app/appointmentstudio" : "https://breakthroughs-test.web.app/appointmentstudio"
    // for (let i = 0; i < hosts.length; i++) {
    //   const element = hosts[i];
      var hostemail = hosts.map(e => e.email).join(", ")
      await commonService.postmarkClient.sendEmailWithTemplate({
        From: "starlabs@excellenceinstallation.com",
        To: hostemail,
        Cc: schedulerMail,
        TemplateAlias: "appointment-scheduled-v2",
        TemplateModel: hostDataModel,
        Attachments: [
          {
          "Name": "appointment.ics",
          "Content": Buffer.from(calendarData).toString('base64'),
          "ContentType": "text/calendar; charset=utf-8; method=REQUEST"
          }
        ],
      }).catch(err=>{
        console.log(err)
      });
    // }
    // Send Notification
    var body = "Your " + appointmentname + " is confirmed with " + names.join(', ') + " on " + commonService.monthName[starttime.getMonth()] + " " + starttime.getDate() + ", " + starttime.getFullYear() + " " + (formatedStartTime.getHours()%12 || 12) + ":" + (formatedStartTime.getMinutes().toString().length == 1 ? ("0"+formatedStartTime.getMinutes().toString()) : formatedStartTime.getMinutes()) + (formatedStartTime.getHours() < 12 ? "AM" : "PM")
    await commonService.saveNotificationRecord({
      title: "Your appointment is confirmed ✅",
      message: body,
      subtitle: null,
      date: admin.firestore.FieldValue.serverTimestamp(),
      landingpage: null,
      logged: true,
      profileid: [snapshot.data()["bookedby"].id],
      sticky: false,
      notificationtype: "appointment",
      notificationimage: null,
      metadata: {
        appointmentid: snapshot.id
      }
    })
    var hostid = []
    var hostbody = bookedby.name + " has booked a slot with you for " +  appointmentname + " on " + commonService.monthName[starttime.getMonth()] + " " + starttime.getDate() + ", " + starttime.getFullYear() + " " + (formatedStartTime.getHours()%12 || 12) + ":" + (formatedStartTime.getMinutes().toString().length == 1 ? ("0"+formatedStartTime.getMinutes().toString()) : formatedStartTime.getMinutes()) + (formatedStartTime.getHours() < 12 ? "AM" : "PM")
    for (let i = 0; i < snapshot.data()["hosts"].length; i++) {
      const hosts = snapshot.data()["hosts"][i];
      hostid.push(hosts.id)
    }
    await commonService.saveNotificationRecord({
      title: "Your slot is confirmed ✅",
      message: hostbody,
      subtitle: null,
      date: admin.firestore.FieldValue.serverTimestamp(),
      landingpage: null,
      logged: true,
      profileid: hostid,
      sticky: false,
      notificationtype: "appointment",
      notificationimage: null,
      metadata: {
        appointmentid: snapshot.id
      }
    })

    // Assign Host to Client
    // Diagnostics
    if(snapshot.data()["appointment"].path == "appointmenttype/AkOr1WLFFq2ttBIQQKYe"){
      var diagnosticPerson = snapshot.data()["hostRole"]["eisroles/mz7tx7W02rx5VvaduaFT"]
      var collaborator = snapshot.data()["hostRole"]["eisroles/aoe1uANIDQho8FfylFWN"]

      await admin.firestore().collection("customer_eismapping").doc(snapshot.data()["bookedby"].id).get().then(async eisMapping=>{
        var rolesPath = []
        var mappedEIS = {}
        if(eisMapping.exists){
          eisMapping.data()["roles"].forEach(ref=>{
            rolesPath.push(ref.path)
          })
          mappedEIS = eisMapping.data()["eisroles"]
        }

        // Implementation
        mappedEIS["eisroles/IyvM6K3Sl90Tm5YZSp6W"] = collaborator
        if(!rolesPath.includes("eisroles/IyvM6K3Sl90Tm5YZSp6W")){
          rolesPath.push("eisroles/IyvM6K3Sl90Tm5YZSp6W")
        }
        // Review
        mappedEIS["eisroles/f5wT99oyCANbIfXIfKCM"] = diagnosticPerson
        if(!rolesPath.includes("eisroles/f5wT99oyCANbIfXIfKCM")){
          rolesPath.push("eisroles/f5wT99oyCANbIfXIfKCM")
        }
        // Review Collaborator
        mappedEIS["eisroles/z12qMJ5tDzQqRyGrjujz"] = collaborator
        if(!rolesPath.includes("eisroles/z12qMJ5tDzQqRyGrjujz")){
          rolesPath.push("eisroles/z12qMJ5tDzQqRyGrjujz")
        }
        // Celebration
        mappedEIS["eisroles/tUibFLhrQadcIT7FjENb"] = diagnosticPerson
        if(!rolesPath.includes("eisroles/tUibFLhrQadcIT7FjENb")){
          rolesPath.push("eisroles/tUibFLhrQadcIT7FjENb")
        }
        // Celebration Collaborator
        mappedEIS["eisroles/Ns78YMfOrSRsrZr51fkA"] = collaborator
        if(!rolesPath.includes("eisroles/Ns78YMfOrSRsrZr51fkA")){
          rolesPath.push("eisroles/Ns78YMfOrSRsrZr51fkA")
        }

        var roleRef = []
        rolesPath.forEach(path=>{
          roleRef.push(admin.firestore().doc(path))
        })

        await admin.firestore().collection("customer_eismapping").doc(snapshot.data()["bookedby"].id).set({
          roles: roleRef,
          eisroles: mappedEIS,
          profile_ref: admin.firestore().doc(snapshot.data()["bookedby"].path)
        }, {merge: true})
      })
    }
    // Celebration
    else if(snapshot.data()["appointment"].path == "appointmenttype/gQR1GKk9no7YQqk2yoCW"){

      await admin.firestore().collection("customer_eismapping").doc(snapshot.data()["bookedby"].id).get().then(async eisMapping=>{
        var rolesPath = []
        var mappedEIS = {}
        if(eisMapping.exists){
          eisMapping.data()["roles"].forEach(ref=>{
            rolesPath.push(ref.path)
          })
          mappedEIS = eisMapping.data()["eisroles"]
        }

        // Implementation
        delete mappedEIS["eisroles/IyvM6K3Sl90Tm5YZSp6W"]
        if(rolesPath.includes("eisroles/IyvM6K3Sl90Tm5YZSp6W")){
           var impIndex = rolesPath.findIndex(e => e == "eisroles/IyvM6K3Sl90Tm5YZSp6W")
           rolesPath.splice(impIndex, 1)
        }
        // Review
        delete mappedEIS["eisroles/f5wT99oyCANbIfXIfKCM"]
        if(rolesPath.includes("eisroles/f5wT99oyCANbIfXIfKCM")){
          var revIndex = rolesPath.findIndex(e => e == "eisroles/f5wT99oyCANbIfXIfKCM")
          rolesPath.splice(revIndex, 1)
        }
        // Review Collaborator
        delete mappedEIS["eisroles/z12qMJ5tDzQqRyGrjujz"]
        if(rolesPath.includes("eisroles/z12qMJ5tDzQqRyGrjujz")){
          var revCIndex = rolesPath.findIndex(e => e == "eisroles/z12qMJ5tDzQqRyGrjujz")
          rolesPath.splice(revCIndex, 1)
        }
        // Celebration
        delete mappedEIS["eisroles/tUibFLhrQadcIT7FjENb"]
        if(rolesPath.includes("eisroles/tUibFLhrQadcIT7FjENb")){
          var celIndex = rolesPath.findIndex(e => e == "eisroles/tUibFLhrQadcIT7FjENb")
          rolesPath.splice(celIndex, 1)
        }
        // Celebration Collaborator
        delete mappedEIS["eisroles/Ns78YMfOrSRsrZr51fkA"]
        if(rolesPath.includes("eisroles/Ns78YMfOrSRsrZr51fkA")){
          var celCIndex = rolesPath.findIndex(e => e == "eisroles/Ns78YMfOrSRsrZr51fkA")
          rolesPath.splice(celCIndex, 1)
        }

        var roleRef = []
        rolesPath.forEach(path=>{
          roleRef.push(admin.firestore().doc(path))
        })

        await admin.firestore().collection("customer_eismapping").doc(snapshot.data()["bookedby"].id).set({
          roles: roleRef,
          eisroles: mappedEIS,
          profile_ref: admin.firestore().doc(snapshot.data()["bookedby"].path)
        }, {merge: true})
      })
    }

  }
})

// Appointment Cancelled
exports.appointmentcancelled = onDocumentUpdated("/appointments/{docid}", async (snapshotdata)=>{
  var snapshot = snapshotdata.data
  var oldData = snapshot.before.data();
  var newData = snapshot.after.data();
  var appointmentName;
  var appointmentdate;
  var bookedby = {
    name: "",
    email: ""
  };
  var hosts = [];

  // Appointment Attended
  if(oldData["attended"] != true && newData["attended"] == true){
    // Update Touch Point
    try {
      await admin.firestore().doc(newData["appointment"].path).get().then(appointmentDoc=>{
        appointmentName = appointmentDoc.data()["appointmenttype"]
      })
      await commonService.updateParticipantTouchPoint({
        label: `${appointmentName} Appointment`,
        notes: "",
        touchpoint: "Appointment Scheduled",
        touchpointdate: newData["starttime"].toDate(),
        profileid: newData["bookedby"].id,
        parentreference: snapshot.after.ref,
        metadata: {
          appointmentref: newData["appointment"],
        }
      })
    } catch (error) {
      console.log("Touch Point Error - Appointment Scheduled", error.toString())
    }
  }

  // Appointment Cancelled
  if(!oldData["cancelled"] && newData["cancelled"]){

    // Revoke Zoom ID
    if(newData["zoomdata"]){
      var zoomEmail = newData["zoomdata"]["host_email"]
      await admin.firestore().collection("zoomaccount").where("email", "==", zoomEmail).get().then(emailaccount=>{
        emailaccount.docs.forEach(async doc=>{
          await doc.ref.update({
            hostid: null,
            inuse : false,
            useby: null
          })
        })
      }).catch(err =>{
        console.log(err)
      })
    }

    await admin.firestore().doc(newData["appointment"].path).get().then(appointmentDoc=>{
      appointmentName = appointmentDoc.data()["appointmenttype"]
    })
    var time = newData["starttime"].toDate()
    var formatedTime = new Date(time.getFullYear(), time.getMonth(), time.getDate(), time.getHours()+5, time.getMinutes()+30, 0);
    appointmentdate = formatedTime.toDateString() + " at " + (formatedTime.getHours()%12 || 12) + ":" + (formatedTime.getMinutes().toString().length == 1 ? ("0"+formatedTime.getMinutes().toString()) : formatedTime.getMinutes()) + " " + (formatedTime.getHours() < 12 ? "AM" : "PM") + " IST"
    await admin.firestore().doc(newData["bookedby"].path).get().then(profile=>{
      bookedby.name = profile.data()["name"]
      bookedby.email = profile.data()["email"]
    })
    for (let i = 0; i < newData["hosts"].length; i++) {
      const element = newData["hosts"][i];
      await admin.firestore().collection("EISzoomcontact").doc(element.id).get().then(async contact=>{
        if(contact.exists){
          hosts.push({
            name: contact.data()["name"],
            email: contact.data()["email"],
          })
        }
        else{
          await admin.firestore().doc(element.path).get().then(profile=>{
            hosts.push({
              name: profile.data()["name"],
              email: profile.data()["email"],
            })
          })
        }
      })
    }

    // Import Scheduler Email for CC
    var appointmentProduct = newData["productid"]
    var model
    if(appointmentProduct){
      await admin.firestore().collection("products").doc(appointmentProduct).get().then(productMeta =>{
        if(productMeta.exists){
          model = productMeta.data()["atcmodel"]
        }
      })
    }
    var schedulerMail
    await admin.firestore().doc("/classify/mailscheduler").get().then(async scheduler =>{
      if(scheduler.exists && model){
        var schedulerData = scheduler.data()
        schedulerMail = (schedulerData[model] ?? []).join(", ")
      }
    })
  
    // Sent To Client
    var localHostName = []
    for (let i = 0; i < hosts.length; i++) {
      const element = hosts[i].name;
      localHostName.push(element)
    }
  
    var clientModel = {
      product_name: "StarLabs - Scheduling",
      subject: "Your Appointment for " + appointmentName + " has been cancelled",
      name: bookedby.name,
      type: "Appointment",
      appointment: appointmentName,
      person: localHostName.join(', '),
      date: appointmentdate,
      company_name: "Antano & Harini",
    }
    await commonService.postmarkClient.sendEmailWithTemplate({
      From: "starlabs@excellenceinstallation.com",
      To: bookedby.email,
      Cc: schedulerMail,
      TemplateAlias: "appointment-cancelled",
      TemplateModel: clientModel,
    }).catch(err=>{
      console.log(err)
    });
    // Send To Hosts
    for (let i = 0; i < hosts.length; i++) {
      const element = hosts[i];
      var hostModel = {
        product_name: "StarLabs - Scheduling",
        subject: "Your Slot for " + appointmentName + " has been cancelled",
        name: element.name,
        type: "Slot",
        appointment: appointmentName,
        person: bookedby.name,
        date: appointmentdate,
        company_name: "Antano & Harini",
      }
      await commonService.postmarkClient.sendEmailWithTemplate({
        From: "starlabs@excellenceinstallation.com",
        To: element.email,
        Cc: schedulerMail,
        TemplateAlias: "appointment-cancelled",
        TemplateModel: hostModel
      }).catch(err=>{
        console.log(err)
      });
    }

    // Send Notification
    var body = "Your " + appointmentName + " has been Cancelled"
    await commonService.saveNotificationRecord({
      title: "Appointment cancelled",
      message: body,
      subtitle: null,
      date: admin.firestore.FieldValue.serverTimestamp(),
      landingpage: null,
      logged: true,
      profileid: [snapshot.after.data()["bookedby"].id],
      sticky: false,
      notificationtype: "appointment",
      notificationimage: null,
      metadata: {
        appointmentid: snapshot.after.id
      }
    })
    var hostid = []
    var hostbody = "Your slot with " + bookedby.name + + " for " + appointmentName + " has been cancelled"
    for (let i = 0; i < snapshot.after.data()["hosts"].length; i++) {
      const hosts = snapshot.after.data()["hosts"][i];
      hostid.push(hosts.id)
    }
    await commonService.saveNotificationRecord({
      title: "Slot cancelled",
      message: hostbody,
      subtitle: null,
      date: admin.firestore.FieldValue.serverTimestamp(),
      landingpage: null,
      logged: true,
      profileid: hostid,
      sticky: false,
      notificationtype: "appointment",
      notificationimage: null,
      metadata: {
        appointmentid: snapshot.after.id
      }
    })
  }
})

// Request Appointment Cancel
exports.requestApptCancel = onRequest(async (req, res)=>{
  var appointmentid = req.query.appointmentid
  await admin.firestore().collection("appointments").doc(appointmentid).get().then(async appt=>{
    var appointmentTypeID = appt.data()["appointment"].id
    var selectedSlot = {
      start: new Date(appt.data()["starttime"].toDate()),
      end: new Date(appt.data()["endtime"].toDate())
    }
    var startdateString = selectedSlot.start.toString()
    var enddateString = selectedSlot.end.toString()
    var slotData = appt.data()["slotdata"]
    await admin.firestore().collection("appointments").doc(appointmentid).update({
      cancelled: true,
      cancelledon: admin.firestore.FieldValue.serverTimestamp()
    })

    for (let i = 0; i < slotData.length; i++) {
      const element = slotData[i];
      await admin.firestore().collection("availability").doc(element.id).get().then(async availability=>{
        var chosenAppointment = availability.data()
        for (let j = 0; j < chosenAppointment["appointments"].length; j++) {
          const chosenelement = chosenAppointment["appointments"][j];
          var computedSlots = chosenAppointment[chosenelement.id]
          if(computedSlots != null || computedSlots != undefined){
            for (let k = 0; k < computedSlots.length; k++) {
              const slotelement = computedSlots[k];
              var slotStart = new Date(slotelement.slotstart.toDate())
              var slotEnd = new Date(slotelement.slotend.toDate())
              if((slotStart >= selectedSlot.start && slotStart < selectedSlot.end) || (slotEnd > selectedSlot.start && slotEnd < selectedSlot.end) || (selectedSlot.start >= slotStart && selectedSlot.start < slotEnd)){
                var slotStartString = slotStart.toString()
                var slotEndString = slotEnd.toString()
                if(chosenelement.id == appointmentTypeID && element.index == k && slotStartString == startdateString && slotEndString == enddateString){
                  if(slotelement["groupappointment"] == true){
                    slotelement["totalbooked"] = slotelement["totalbooked"] - 1
                    if(slotelement["totalbooked"] == 0){
                      slotelement.booked = false
                    }
                  }
                  else{
                    slotelement.booked = false
                  }
                }
                if(!slotelement.booked){
                  slotelement.available = true
                }
              }
            }
          }
        }
        await availability.ref.update(chosenAppointment).catch(err=>{
          console.log(element.id)
        })
      }).catch(err=>{
        console.log(err)
      })
    }

    // await updateDeliveryStatus(admin.firestore().collection("appointments").doc(appointmentid).path, "ready")
    await admin.firestore().collection("deliverables").where("fileref", "array-contains", admin.firestore().collection("appointments").doc(appointmentid)).get().then(async deliverable=>{
       for (let i = 0; i < deliverable.docs.length; i++) {
        const doc = deliverable.docs[i];
        await doc.ref.update({
          status: "ready"
        })
      }
    })
  })
  res.send("Cancelled Appt")
})

// On Availability Scheduled
exports.deliveryhoursCreate = onDocumentUpdated('/deliverytime/{id}',async snapshotdata=>{
  var snapshot = snapshotdata.data
  const profileid = snapshot.data()["profileid"];
  var url
  if(commonService.production){
    url = "https://us-central1-fir-sample-aae4a.cloudfunctions.net/profileAvailability?profileid=" + profileid
  }
  else{
    url = "https://us-central1-starlabs-test.cloudfunctions.net/profileAvailability?profileid=" + profileid
  }
  https.get(url, (response)=>{})
})

// Schedule Specialist Availability by Weekly Availabilty
exports.availabilityScheduler = onSchedule({schedule: "00 00 * * *"}, async (event) => {
  await admin.firestore().collection("deliverytime").get().then(async time=>{
    for (let i = 0; i < time.docs.length; i++) {
      const profileid = time.docs[i].id;
      var url
      if(commonService.production){
        url = "https://us-central1-fir-sample-aae4a.cloudfunctions.net/profileAvailability?profileid=" + profileid
      }
      else{
        url = "https://us-central1-starlabs-test.cloudfunctions.net/profileAvailability?profileid=" + profileid
      }
      https.get(url, (response)=>{})
    }
  })
})

// Create Specialist Availability by Weekly Availabilty
exports.profileAvailability = onRequest(async (req, res)=>{
  var profileid = req.query.profileid
  var weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
  var firstDay = new Date()
  var shadowingRoles = []
  await admin.firestore().collection("eisroles").where("experiencelevel", "==", "Shadowing").get().then(shadowRole=>{
    for (let i = 0; i < shadowRole.docs.length; i++) {
      const role = shadowRole.docs[i];
      shadowingRoles.push(role.ref.path)
    }
  })
  var myappointments = []
  await admin.firestore().collection("Roles-To-EIS").where("assigned_eis", "array-contains", admin.firestore().collection("profile_data").doc(profileid)).get().then(async assignedRoles=>{
    var roles = []
    assignedRoles.forEach(doc=>{
      roles.push(doc.data()["assigned_role_ref"]["path"])
    })
    if(roles.length != 0){
      await admin.firestore().collection("AppointmentType-To-Roles").get().then(appointment=>{
        var data = []
        for (let a = 0; a < appointment.docs.length; a++) {
          const doc = appointment.docs[a];
          var required = doc.data()["required_role"] != null ? doc.data()["required_role"] : []
          var additional = doc.data()["additional_role"] != null ? doc.data()["additional_role"] : []
          var requiredPath = []
          var additionalPath = []
          required.forEach(ref=>{
            requiredPath.push(ref.path)
          })
          additional.forEach(ref=>{
            additionalPath.push(ref.path)
          })
          for (let b = 0; b < roles.length; b++) {
            const rolePath = roles[b];
            if(requiredPath.includes(rolePath)){
              data.push(doc.data()["assigned_appttype_ref"].path)
              break
            }
            else if(additionalPath.includes(rolePath) && !shadowingRoles.includes(rolePath)){
              data.push(doc.data()["assigned_appttype_ref"].path)
              break
            }
          }
        }
        data = Array.from(new Set(data))
        myappointments = data.map(e => admin.firestore().doc(e))
      })
    }
  })

  await admin.firestore().collection("deliverytime").doc(profileid).get().then(async time=>{
    var newSlotStart
    var newSlotEnd
    if(time.exists){
      const specialistHours = time.data();
      var timezone = specialistHours["timezone"]
      for (let j = 1; j < weekday.length; j++) {
        const day = weekday[j];
        var dates = []
        for (let a = 1; a <= 15; a++) {
          var checkdate = new Date(new Date().setDate(firstDay.getDate() + a))
          if(checkdate.getDay() == j){
            dates.push(checkdate)
          }
        }
        for (let k = 0; k < dates.length; k++) {
          const date = dates[k];
          var starttime = new Date(new Date(date).setHours(0 - (timezone.hour), 0 - (timezone.minute), 0, 0, 0))
          var endtime = new Date(new Date(date).setHours(23 - (timezone.hour), 59 - (timezone.minute), 59, 0, 0))
          // Check Off Time
          var offTimeList = []
          await admin.firestore().collection("offtime").where("status", "==", "approved").where("profileid", "==", profileid).where("date", ">=", starttime).where("date", "<=", endtime).get().then(offtime=>{
            offTimeList = offtime.docs.map(e => e.data())
          })
          if(offTimeList.filter(e => e.fullday).length == 0){
            await admin.firestore().collection("availability").where("profileref", "==", admin.firestore().collection("profile_data").doc(profileid)).where("starttime", ">=", starttime).where("starttime", "<=", endtime).get().then(async existingAvailability=>{
              // Delete Additional Available Slots
              for (let a = 0; a < existingAvailability.docs.length; a++) {
                const existingSlot = existingAvailability.docs[a];
                const existingData = existingSlot.data()
                var alreadyBooked = false
                for (let b = 0; b < existingData["appointments"].length; b++) {
                  const appt = existingData["appointments"][b].id;
                  alreadyBooked = existingData[appt].filter(e => e.booked).length != 0
                  if(alreadyBooked){
                    break;
                  }
                }   
                if(!alreadyBooked){
                  var deleteSlot = false
                  for (let b = 0; b < specialistHours[day].length; b++) {
                    const splitStartHour = specialistHours[day][b]["starttime"].split(":");
                    const splitEndHour = specialistHours[day][b]["endtime"].split(":");
                    var newSlotStart = new Date(new Date(date).setHours(splitStartHour[0] - (timezone.hour), splitStartHour[1] - (timezone.minute), 0, 0))
                    var newSlotEnd = new Date(new Date(date).setHours(splitEndHour[0] - (timezone.hour), splitEndHour[1] - (timezone.minute), 0, 0))
                    if(newSlotStart.valueOf() != existingData["starttime"].toDate().valueOf() && newSlotEnd.valueOf() != existingData["endtime"].toDate().valueOf()){
                      deleteSlot = true
                    }
                    else{
                      deleteSlot = false
                      break;
                    }
                  }
                  if(deleteSlot){
                    await existingSlot.ref.delete().catch(e =>{
                      console.log(e)
                    })
                  }
                }             
              }
              if(existingAvailability.size == 0){
                for (let a = 0; a < specialistHours[day].length; a++) {
                  const splitStartHour = specialistHours[day][a]["starttime"].split(":");
                  const splitEndHour = specialistHours[day][a]["endtime"].split(":");
                  newSlotStart = new Date(new Date(date).setHours(splitStartHour[0] - (timezone.hour), splitStartHour[1] - (timezone.minute), 0, 0))
                  newSlotEnd = new Date(new Date(date).setHours(splitEndHour[0] - (timezone.hour), splitEndHour[1] - (timezone.minute), 0, 0))
                  // Create Slot
                  await createSlot(newSlotStart, newSlotEnd, profileid, myappointments, offTimeList)
                }
              }
              else{
                for (let x = 0; x < specialistHours[day].length; x++) {
                  const splitStartHour = specialistHours[day][x]["starttime"].split(":");
                  const splitEndHour = specialistHours[day][x]["endtime"].split(":");
                  newSlotStart = new Date(new Date(date).setHours(splitStartHour[0] - (timezone.hour), splitStartHour[1] - (timezone.minute), 0, 0))
                  newSlotEnd = new Date(new Date(date).setHours(splitEndHour[0] - (timezone.hour), splitEndHour[1] - (timezone.minute), 0, 0))
                  var similarSlots = existingAvailability.docs.filter(e => 
                    (e.data()["starttime"].toDate() >= newSlotStart && e.data()["starttime"].toDate() < newSlotEnd) || 
                    (e.data()["endtime"].toDate() > newSlotStart && e.data()["endtime"].toDate() <= newSlotEnd) ||
                    (newSlotStart >= e.data()["starttime"].toDate() && newSlotStart < e.data()["endtime"].toDate()) ||
                    (newSlotEnd > e.data()["starttime"].toDate() && newSlotEnd <= e.data()["endtime"].toDate()) ||
                    (e.data()["starttime"].toDate().valueOf() == newSlotStart.valueOf() && e.data()["endtime"].toDate().valueOf() && newSlotEnd.valueOf())
                  )
                  if(similarSlots.length == 0){
                    // Create Slot
                    await createSlot(newSlotStart, newSlotEnd, profileid, myappointments, offTimeList)
                  }
                  else{
                    var slotBooked = false
                    for (let y = 0; y < similarSlots.length; y++) {
                      const oldSlot = similarSlots[y].data();
                      for (let z = 0; z < oldSlot["appointments"].length; z++) {
                        const appt = oldSlot["appointments"][z].id;
                        slotBooked = oldSlot[appt].filter(e => e.booked).length != 0
                        if(slotBooked){
                          z = 1000
                          y = 1000
                          break
                        }
                      }
                    }
                    if(!slotBooked){
                      var create = true
                      for (let a = 0; a < similarSlots.length; a++) {
                        if(newSlotStart.valueOf() == similarSlots[a].data()["starttime"].toDate().valueOf() && newSlotEnd.valueOf() == similarSlots[a].data()["endtime"].toDate().valueOf()){
                          create = false
                        }
                        else{
                          await similarSlots[a].ref.delete().catch(e =>{});
                        }
                      }
                      if(create){
                        // Create Slot
                        await createSlot(newSlotStart, newSlotEnd, profileid, myappointments, offTimeList)
                      }
                    }
                  }
                }
              }
            })
          }
        }
      }
    }
  })
  res.send(profileid + " Availability Created")
})

async function createSlot(slotStart, slotEnd, profileid, appointments, offtime){
  var offtimeSlot = offtime.filter(e => 
    (e["starttime"].toDate() >= slotStart && e["starttime"].toDate() < slotEnd) || 
    (e["endtime"].toDate() > slotStart && e["endtime"].toDate() <= slotEnd) ||
    (slotStart >= e["starttime"].toDate() && slotStart < e["endtime"].toDate()) ||
    (slotEnd > e["starttime"].toDate() && slotEnd <= e["endtime"].toDate()) ||
    (e["starttime"].toDate().valueOf() == slotStart.valueOf() && e["endtime"].toDate().valueOf() && slotEnd.valueOf())
  )
  var docID =  admin.firestore().collection("availability").doc().id
  if(appointments.length != 0 && offtimeSlot.length == 0){
    await admin.firestore().collection("availability").doc(docID).set({
      id: docID,
      starttime: slotStart,
      endtime: slotEnd,
      profileref: admin.firestore().collection("profile_data").doc(profileid),
      appointments: appointments,
      weeklyhours: true
    })
  }
}

// Update Slots based on Off-Time
exports.approveOfftime = onRequest(async(req, res)=>{
  var offid = req.query.offid
  await admin.firestore().collection("offtime").doc(offid).get().then(async offtime=>{
    if(offtime.exists){
      var offData = offtime.data()
      if(offData["status"] == "approved"){
        var starttime = offData["starttime"].toDate()
        var endtime = offData["endtime"].toDate()
        var availabilityId = []
        await admin.firestore().collection("availability").where("profileref", "==", admin.firestore().collection("profile_data").doc(offData["profileid"])).get().then(async existingAvailability=>{
          availabilityId = existingAvailability.docs.map(e => e.data()).filter(e =>
            (e["starttime"].toDate() >= starttime && e["starttime"].toDate() < endtime) || 
            (e["endtime"].toDate() > starttime && e["endtime"].toDate() <= endtime) ||
            (starttime >= e["starttime"].toDate() && starttime < e["endtime"].toDate()) ||
            (endtime > e["starttime"].toDate() && endtime <= e["endtime"].toDate()) ||
            (e["starttime"].toDate().valueOf() == starttime.valueOf() && e["endtime"].toDate().valueOf() && endtime.valueOf())
          ).map(e => e.id)
        })
        for (let i = 0; i < availabilityId.length; i++) {
          const id = availabilityId[i];
          await admin.firestore().collection("availability").doc(id).delete()
        }
        await admin.firestore().collection("appointments").where("hosts", "array-contains", admin.firestore().collection("profile_data").doc(offData["profileid"])).get().then(async appt=>{
          for (let i = 0; i < appt.docs.length; i++) {
            const apptData = appt.docs[i];
            if((apptData.data()["slotdata"].filter(e => availabilityId.includes(e.id)).length) != 0){
              await apptData.ref.update({
                cancelled: true,
                cancelledon: admin.firestore.FieldValue.serverTimestamp()
              })
            }
          }
        })
      }
    }
  })
})

// Send Appointment Remainder Before
exports.appointmentremainder = onSchedule({schedule: "*/5 * * * *", secrets:[zoomAccountId, zoomClientId, zoomClientSecret, zoomSDkClientId, zoomSDKClientSecret]}, async (event) => {
  var currentTime = new Date()
  // Next 5 Minutes
  var nextfive = new Date(new Date(currentTime).setMinutes(currentTime.getMinutes() + 5))
  console.log(currentTime.toTimeString(), nextfive.toTimeString())
  await admin.firestore().collection("appointments").where("cancelled", "==", false).where("starttime", ">=", currentTime).where("starttime", "<=", nextfive).get().then(async appt=>{
    console.log(appt.size)
    var profileid = []
    if(appt.docs.length != 0){
      for (let i = 0; i < appt.docs.length; i++) {
        const appDoc = appt.docs[i]
        const apptData = appDoc.data();

        // Fetch Appointment Data
        var appointmentName = ""
        await admin.firestore().doc(apptData["appointment"].path).get().then(data=>{
          appointmentName = data.data()["appointmenttype"]
        }).catch(e => {})

        profileid.push(apptData["bookedby"].id)
        apptData["hosts"].forEach(e =>{
          profileid.push(e.id)
        })
        var title = appointmentName + " Reminder!"
        var message = "Your appointment starts in 5 minutes"
        await commonService.saveNotificationRecord({
          title: title,
          message: message,
          subtitle: null,
          date: admin.firestore.FieldValue.serverTimestamp(),
          landingpage: null,
          logged: false,
          profileid: profileid,
          sticky: false,
          notificationtype: "appointmentreminder",
          notificationimage: null,
          metadata: {
            appointmentid: appDoc.id
          }
        })
      }
    }
  })

  // Next One Hour
  var starttime = new Date(new Date(currentTime).setMinutes(currentTime.getMinutes() + 55))
  var endtime = new Date(new Date(currentTime).setMinutes(currentTime.getMinutes() + 60))
  console.log(starttime.toTimeString(), endtime.toTimeString())
  await admin.firestore().collection("appointments").where("cancelled", "==", false).where("starttime", ">=", starttime).where("starttime", "<=", endtime).get().then(async appt=>{
    console.log(appt.size)
    var profileid = []
    if(appt.docs.length != 0){
      for (let i = 0; i < appt.docs.length; i++) {
        const appDoc = appt.docs[i]
        const apptData = appDoc.data();
        var appointmentName = ""

        // Fetch Appointment Data
        await admin.firestore().doc(apptData["appointment"].path).get().then(data=>{
          var ApptTypeData = data.data()
          appointmentName = ApptTypeData["appointmenttype"]
        }).catch(e => {})

        profileid.push(apptData["bookedby"].id)
        apptData["hosts"].forEach(e =>{
          profileid.push(e.id)
        })
        var title = appointmentName + " Reminder!"
        var message = "Your appointment is scheduled in 1 hour"
        await commonService.saveNotificationRecord({
          title: title,
          message: message,
          subtitle: null,
          date: admin.firestore.FieldValue.serverTimestamp(),
          landingpage: null,
          logged: false,
          profileid: profileid,
          sticky: false,
          notificationtype: "appointmentreminder",
          notificationimage: null,
          metadata: {
            appointmentid: appDoc.id
          }
        })
      }
    }
  })

  // Next 24 Hours
  var next24Hours = new Date(new Date(currentTime).setHours(currentTime.getHours() + 24))
  console.log(currentTime.toDateString(), next24Hours.toDateString(), currentTime.toTimeString(), next24Hours.toTimeString())
  await admin.firestore().collection("appointments").where("cancelled", "==", false).where("starttime", ">=", currentTime).where("starttime", "<=", next24Hours).get().then(async appt=>{
    for (let i = 0; i < appt.docs.length; i++) {
      const appDoc = appt.docs[i]
      const apptData = appDoc.data();

      var appointmentName = ""
      var duration = ""
      var appointmentStartTime = apptData["starttime"].toDate()
      var appointmentEndTime = apptData["endtime"].toDate()
      var formatedStartTime = new Date(appointmentStartTime.getFullYear(), appointmentStartTime.getMonth(), appointmentStartTime.getDate(), appointmentStartTime.getHours()+5, appointmentStartTime.getMinutes()+30, 0);
      var formatedEndTime = new Date(appointmentEndTime.getFullYear(), appointmentEndTime.getMonth(), appointmentEndTime.getDate(), appointmentEndTime.getHours()+5, appointmentEndTime.getMinutes()+30, 0);
      var date = formatedStartTime.toDateString() + " at " + (formatedStartTime.getHours()%12 || 12) + ":" + (formatedStartTime.getMinutes().toString().length == 1 ? ("0"+formatedStartTime.getMinutes().toString()) : formatedStartTime.getMinutes()) + (formatedStartTime.getHours() < 12 ? "AM" : "PM") + " - " + (formatedEndTime.getHours()%12 || 12) + ":" + (formatedEndTime.getMinutes().toString().length == 1 ? ("0"+formatedEndTime.getMinutes().toString()) : formatedEndTime.getMinutes()) + (formatedEndTime.getHours() < 12 ? "AM" : "PM") + " IST"

      // Generate Zoom Meeting URL
      if(apptData["zoomdata"] == null || apptData["zoomdata"] == undefined){

        // Fetch Appointment Data
        await admin.firestore().doc(apptData["appointment"].path).get().then(data=>{
          var ApptTypeData = data.data()
          appointmentName = ApptTypeData["appointmenttype"]
          duration = ApptTypeData["duration"].toString() + " Mins"
        }).catch(e => {})

        // Request Zoom Meeting
        var requestedZoomResult = await commonService.generateZoomMeeting({
          requestpath: appDoc.ref.path,
          zoomAccountId: zoomAccountId.value(),
          zoomClientId: zoomClientId.value(),
          zoomClientSecret: zoomClientSecret.value(),
          zoomSDkClientId: zoomSDkClientId.value(),
          zoomSDKClientSecret: zoomSDKClientSecret.value()
        })

        var zoomurl = null
        if(requestedZoomResult){
          var zoomresult = requestedZoomResult["result"]
          console.log("zoom created ", zoomresult.data['join_url']);
          zoomurl = zoomresult.data['join_url'] 
        }

        // Fetch Participant Data
        var bookedby = {
          name: "",
          email: ""
        }
        await admin.firestore().doc(apptData["bookedby"].path).get().then(profile=>{
          var profileData = profile.data()
          bookedby.name = profileData["name"]
          bookedby.email = profileData["email"]
        })

        // Fetch Appointment Role & Host Data
        var hosts = []
        var appointmentRoles = []
        for (let i = 0; i < apptData["appointmentrole"].length; i++) {
          const element = apptData["appointmentrole"][i];
          appointmentRoles.push(element.path)
        }
        appointmentRoles = Array.from(new Set(appointmentRoles))
        for (let i = 0; i < appointmentRoles.length; i++) {
          const aptRole = appointmentRoles[i];
          const roleName = (await admin.firestore().doc(aptRole).get()).data()["role"].toLowerCase()
          for (let j = 0; j < apptData["hostRole"][aptRole].length; j++) {
            var host = apptData["hostRole"][aptRole][j];
            await admin.firestore().doc(host.path).get().then(profile=>{
              hosts.push({
                name: profile.data()["name"],
                email: profile.data()["email"],
                role: roleName
              })
            })
          }
        }

        // Mail Participant
        var dataModel = {
          subject: `Meeting URL for ${appointmentName}`,
          product_name: "StarLabs - Scheduling",
          appointment: appointmentName,
          date: date,
          duration: duration,
          client: bookedby.name,
          zoomurl: zoomurl,
          company_name: "Antano & Harini",
        }
        for (let i = 0; i < hosts.length; i++) {
          const hostName = hosts[i].name;
          if(hosts[i].role.includes("collaborator")){
            dataModel["implementation"] = dataModel["implementation"] == undefined ? ""+hostName : dataModel["implementation"] + ", " + hostName
          }
          else if(hosts[i].role.includes("shadow") && hosts[i].role.includes("implementation")){
            dataModel["implementationshadow"] = dataModel["implementationshadow"] == undefined ? ""+hostName : dataModel["implementationshadow"] + ", " + hostName
          }
          else if(!hosts[i].role.includes("shadow") && hosts[i].role.includes("implementation")){
            dataModel["implementation"] = dataModel["implementation"] == undefined ? ""+hostName : dataModel["implementation"] + ", " + hostName
          }
          else if(hosts[i].role.includes("diagnostic")){
            dataModel["diagnostic"] = dataModel["diagnostic"] == undefined ? ""+hostName : dataModel["diagnostic"] + ", " + hostName
          }
          else if(hosts[i].role.includes("clarity")){
            dataModel["accelerator"] = dataModel["accelerator"] == undefined ? ""+hostName : dataModel["accelerator"] + ", " + hostName
          }
          else if(hosts[i].role.includes("testimonial")){
            dataModel["sales"] = dataModel["sales"] == undefined ? ""+hostName : dataModel["sales"] + ", " + hostName
          }
          else{
            dataModel["host"] = dataModel["host"] == undefined ? ""+hostName : dataModel["host"] + ", " + hostName
          }
        }

        // Import Scheduler Email for CC
        var appointmentProduct = apptData["productid"]
        var model
        if(appointmentProduct){
          await admin.firestore().collection("products").doc(appointmentProduct).get().then(productMeta =>{
            if(productMeta.exists){
              model = productMeta.data()["atcmodel"]
            }
          })
        }
        var schedulerMail
        await admin.firestore().doc("/classify/mailscheduler").get().then(async scheduler =>{
          if(scheduler.exists && model){
            var schedulerData = scheduler.data()
            schedulerMail = (schedulerData[model] ?? []).join(", ")
          }
        })

        await commonService.postmarkClient.sendEmailWithTemplate({
          From: "starlabs@excellenceinstallation.com",
          To: bookedby.email,
          Cc: schedulerMail,
          TemplateAlias: "appointment-scheduled-v2",
          TemplateModel: dataModel,
        }).catch(err=>{
          console.log(err)
        });
      }
    }
  })
})

exports.appointmentLinkRegenarate = onRequest({secrets:[zoomAccountId,zoomClientId,zoomClientSecret,zoomSDkClientId,zoomSDKClientSecret]}, async (req, res) => {
  // Add CORS headers
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  try {
    let appointmentid = req.query.appointmentid
    let appointmentData = null
    let oldZoomData = null
    let selectedEmail = null
    
    // Validate appointmentid parameter
    if (!appointmentid) {
      return res.status(400).json({
        success: false,
        error: "MISSING_APPOINTMENT_ID",
        message: "Appointment ID is required."
      });
    }

    // Get appointment data
    await admin.firestore().collection('appointments').doc(appointmentid).get().then(docSnapshot => {
      if (docSnapshot.exists) {
        appointmentData = docSnapshot.data()
        oldZoomData = appointmentData["zoomdata"]
      }
    }).catch(err => {
      console.log("Error getting appointment:", err)
    });

    if (!appointmentData) {
      return res.status(404).json({
        success: false,
        error: "APPOINTMENT_NOT_FOUND",
        message: "Appointment not found."
      });
    }

    // Validate Zoom Availability
    var hostemail = oldZoomData ? oldZoomData["host_email"] : null
    console.log("hostemail", hostemail);

    if (hostemail != null) {
      await admin.firestore().collection("zoomaccount").where("email", "==", hostemail).where("inuse", "==", true).get().then(async account => {
        if (account.size == 0) { // Not used
          selectedEmail = hostemail
        }
        else { // Being Used
          var currentDate = new Date()
          await admin.firestore().collection("appointments").where("cancelled", "==", false).where("endtime", ">=", currentDate).where("zoomdata.host_email", "==", hostemail).get().then(async assignment => {
            var id = assignment.docs.map(e => e.id)
            if (id.includes(appointmentid) && assignment.docs.length == 1) {
              console.log("used by the studio", id);
              // Used by this Studio
              selectedEmail = hostemail
            } else {
              console.log("not used by the studio");
              selectedEmail = await commonService.getUnusedZoomAccount()
              console.log("selectedEmail", selectedEmail);
            }
          })
        }
      }).catch(err => {
        console.log("Error checking zoom account availability:", err)
      });
    }

    var requestedZoomResult = await commonService.generateZoomMeeting({
      requestpath: admin.firestore().collection('appointments').doc(appointmentid).path,
      zoomAccountId: zoomAccountId.value(),
      zoomClientId: zoomClientId.value(),
      zoomClientSecret: zoomClientSecret.value(),
      zoomSDkClientId: zoomSDkClientId.value(),
      zoomSDKClientSecret: zoomSDKClientSecret.value(),
      zoomEmail: selectedEmail
    })

    var zoomurl = null
    if(requestedZoomResult){
      var zoomresult = requestedZoomResult["result"]
      console.log("zoom created ", zoomresult.data['join_url']);
      zoomurl = zoomresult.data['join_url'] 
    }

    // Mail Participant
    // Fetch Appointment Data
    var ApptTypeData = {}
    await admin.firestore().doc(appointmentData["appointment"].path).get().then(data=>{
      ApptTypeData = data.data()
    }).catch(e => {})
    var appointmentName = ApptTypeData["appointmenttype"]
    var duration = ApptTypeData["duration"].toString() + " Mins"
    var appointmentStartTime = appointmentData["starttime"].toDate()
    var appointmentEndTime = appointmentData["endtime"].toDate()
    var formatedStartTime = new Date(appointmentStartTime.getFullYear(), appointmentStartTime.getMonth(), appointmentStartTime.getDate(), appointmentStartTime.getHours()+5, appointmentStartTime.getMinutes()+30, 0);
    var formatedEndTime = new Date(appointmentEndTime.getFullYear(), appointmentEndTime.getMonth(), appointmentEndTime.getDate(), appointmentEndTime.getHours()+5, appointmentEndTime.getMinutes()+30, 0);
    var date = formatedStartTime.toDateString() + " at " + (formatedStartTime.getHours()%12 || 12) + ":" + (formatedStartTime.getMinutes().toString().length == 1 ? ("0"+formatedStartTime.getMinutes().toString()) : formatedStartTime.getMinutes()) + (formatedStartTime.getHours() < 12 ? "AM" : "PM") + " - " + (formatedEndTime.getHours()%12 || 12) + ":" + (formatedEndTime.getMinutes().toString().length == 1 ? ("0"+formatedEndTime.getMinutes().toString()) : formatedEndTime.getMinutes()) + (formatedEndTime.getHours() < 12 ? "AM" : "PM") + " IST"

    // Fetch Participant Data
    var bookedby = {
      name: "",
      email: ""
    }
    await admin.firestore().doc(appointmentData["bookedby"].path).get().then(profile=>{
      var profileData = profile.data()
      bookedby.name = profileData["name"]
      bookedby.email = profileData["email"]
    })
    
    var dataModel = {
      subject: `Meeting URL for ${appointmentName}`,
      product_name: "StarLabs - Scheduling",
      appointment: appointmentName,
      date: date,
      duration: duration,
      client: bookedby.name,
      zoomurl: zoomurl,
      company_name: "Antano & Harini",
    }

    // Import Scheduler Email for CC
    var appointmentProduct = appointmentData["productid"]
    var model
    if(appointmentProduct){
      await admin.firestore().collection("products").doc(appointmentProduct).get().then(productMeta =>{
        if(productMeta.exists){
          model = productMeta.data()["atcmodel"]
        }
      })
    }
    var schedulerMail
    await admin.firestore().doc("/classify/mailscheduler").get().then(async scheduler =>{
      if(scheduler.exists && model){
        var schedulerData = scheduler.data()
        schedulerMail = (schedulerData[model] ?? []).join(", ")
      }
    })

    await commonService.postmarkClient.sendEmailWithTemplate({
      From: "starlabs@excellenceinstallation.com",
      To: bookedby.email,
      Cc: schedulerMail,
      TemplateAlias: "appointment-scheduled-v2",
      TemplateModel: dataModel,
    }).catch(err=>{
      console.log(err)
    });

    res.send("Code Run Successfully")
  } catch (error) {
    console.log("Zoom Link Generation Error:", error.message);
    console.log("Full Error:", JSON.stringify(error, Object.getOwnPropertyNames(error)));

    // Handle specific Axios errors
    if (error.response) {
      const status = error.response.status;
      const errorData = error.response.data;
      
      console.log("Axios error status:", status);
      console.log("Axios error data:", errorData);
      
      if (status === 429) {
        return res.status(429).json({
          success: false,
          error: "RATE_LIMIT_EXCEEDED",
          message: "Too many requests to Zoom API. Please try again later."
        });
      } else if (status === 401) {
        return res.status(401).json({
          success: false,
          error: "ZOOM_AUTH_ERROR",
          message: "Zoom authentication failed. Please contact support."
        });
      } else if (status === 404) {
        return res.status(404).json({
          success: false,
          error: "ZOOM_USER_NOT_FOUND",
          message: "Zoom user not found. Please contact support."
        });
      } else {
        return res.status(500).json({
          success: false,
          error: "ZOOM_API_ERROR",
          message: `Zoom API error: ${errorData?.message || error.message}`
        });
      }
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({
        success: false,
        error: "NETWORK_ERROR",
        message: "Network error connecting to Zoom. Please try again."
      });
    } else {
      return res.status(500).json({
        success: false,
        error: "ZOOM_CREATION_FAILED",
        message: "Failed to create Zoom meeting. Please try again or contact support."
      });
    }
  }
});