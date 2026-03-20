const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const commonService = require('./service');
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const admin = require('firebase-admin');
const https = require('https'); // HTTP Request/Response
const { Buffer } = require('buffer');
const { onSchedule } = require("firebase-functions/v2/scheduler");
const cors = require("cors")({ origin: true });

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
exports.resentAppointmentEmail = onRequest(async (req, res)=>{
  cors(req, res, async () => {
    // Handle preflight request
    if (req.method === "OPTIONS") {
      return res.status(204).send('');
    }
    var appointmentID = req.query.appointmentid;
    console.log("Appointment ID:", appointmentID);
    
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
        var zoomid = ""
        var zoompassword = ""
    
        // Main EIS Roles
        var mainRoles = ["eisroles/mz7tx7W02rx5VvaduaFT", "eisroles/IyvM6K3Sl90Tm5YZSp6W", "eisroles/f5wT99oyCANbIfXIfKCM", "eisroles/tUibFLhrQadcIT7FjENb"]
    
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
        await admin.firestore().doc(snapshot.data()["bookedby"].path).get().then(profile=>{
          bookedby.profileid = profile.id
          bookedby.name = profile.data()["name"]
          bookedby.email = profile.data()["email"]
        })
        var starttime = snapshot.data()["starttime"].toDate()
        var endtime = snapshot.data()["endtime"].toDate()
        var formatedStartTime = new Date(starttime.getFullYear(), starttime.getMonth(), starttime.getDate(), starttime.getHours()+5, starttime.getMinutes()+30, 0);
        var formatedEndTime = new Date(endtime.getFullYear(), endtime.getMonth(), endtime.getDate(), endtime.getHours()+5, endtime.getMinutes()+30, 0);
        date = formatedStartTime.toDateString() + " at " + (formatedStartTime.getHours()%12 || 12) + ":" + (formatedStartTime.getMinutes().toString().length == 1 ? ("0"+formatedStartTime.getMinutes().toString()) : formatedStartTime.getMinutes()) + (formatedStartTime.getHours() < 12 ? "AM" : "PM") + " - " + (formatedEndTime.getHours()%12 || 12) + ":" + (formatedEndTime.getMinutes().toString().length == 1 ? ("0"+formatedEndTime.getMinutes().toString()) : formatedEndTime.getMinutes()) + (formatedEndTime.getHours() < 12 ? "AM" : "PM") + " IST"
        var appointmentRoles = []
        for (let i = 0; i < snapshot.data()["appointmentrole"].length; i++) {
          const element = snapshot.data()["appointmentrole"][i];
          appointmentRoles.push(element.path)
        }
        appointmentRoles = Array.from(new Set(appointmentRoles))
        
        for (let i = 0; i < mainRoles.length; i++) {
          const mainelement = mainRoles[i];
          for (let j = 0; j < appointmentRoles.length; j++) {
            const roleelement = appointmentRoles[j];
            if(mainelement == roleelement){
              var mainHost = snapshot.data()["hostRole"][mainelement][0]
              await admin.firestore().collection("EISzoomcontact").doc(mainHost.id).get().then(zoomcontact=>{
                if(zoomcontact.exists){
                  zoomurl = zoomcontact.data()["zoomurl"]
                  zoomid = zoomcontact.data()["zoomid"]
                  zoompassword = zoomcontact.data()["zoompassword"]
                }
                else{
                  console.log("NOT EXIST")
                }
              }).catch(err=>{
                console.log(err)
              });
              i = 1000
              j = 1000
            }
          }
        }
        
        for (let i = 0; i < appointmentRoles.length; i++) {
          const aptRole = appointmentRoles[i];
          const roleName = (await admin.firestore().doc(aptRole).get()).data()["role"].toLowerCase()
          for (let j = 0; j < snapshot.data()["hostRole"][aptRole].length; j++) {
            var host = snapshot.data()["hostRole"][aptRole][j];
            await admin.firestore().collection("EISzoomcontact").doc(host.id).get().then(async contact=>{
              if(contact.exists){
                hosts.push({
                  profileid:contact.id,
                  name: contact.data()["name"],
                  email: contact.data()["email"],
                  role: roleName
                })
                if(zoomurl == ""){
                  zoomurl = contact.data()["zoomurl"]
                  zoomid = contact.data()["zoomid"]
                  zoompassword = contact.data()["zoompassword"]
                }
              }
              else{
                await admin.firestore().doc(host.path).get().then(profile=>{
                  hosts.push({
                    profileid:contact.id,
                    name: profile.data()["name"],
                    email: profile.data()["email"],
                    role: roleName
                  })
                })
              }
            }) 
          }
        }
    
        var dataModel = {
          product_name: "StarLabs - Scheduling",
          appointment: appointmentname,
          date: date,
          duration: duration,
          client: bookedby.name,
          zoomurl: zoomurl,
          zoomid: zoomid,
          zoompassword: zoompassword,
          company_name: "Antano & Harini",
        }
        if(appointmentname.includes("Journey")){
          dataModel["assitancename"] = "Mr.Milan"
          dataModel["assitancenumber"] = "+91 8098273877"
        }
        else if(appointmentname.includes("Critical") || appointmentname.includes("Light")){
          dataModel["assitancename"] = "Ms.Agalya Das"
          dataModel["assitancenumber"] = "+91 9361138763"
        }
        else{
          dataModel["assitancename"] = "Ms.Varnekha"
          dataModel["assitancenumber"] = "+91 8754831381"
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

        let attachments = [
          {
          "Name": "appointment.ics",
          "Content": Buffer.from(calendarData).toString('base64'),
          "ContentType": "text/calendar; charset=utf-8; method=REQUEST"
          }
        ]
        await commonService.createEmailArchiveDocument({
          emailData : dataModel,
          datamodel : dataModel,
          attachments : attachments,
          emailTo : [bookedby.email],
          emailMap : [{[bookedby['email']] : bookedby.profileid}],
          fileURL : '',
          from:'starlabs@excellenceinstallation.com',
          notes : '',
          profileId : [bookedby.profileid],
          postmarkTemplateId: '24973955',
          templateAlias:'appointment-scheduled'
        }).then(()=>{
          console.log('Sent for email archive');
        });

        // await commonService.postmarkClient.sendEmailWithTemplate({
        //   From: "starlabs@excellenceinstallation.com",
        //   To: bookedby.email,
        //   TemplateAlias: "appointment-scheduled",
        //   TemplateModel: dataModel,
        //   Attachments: [
        //     {
        //     "Name": "appointment.ics",
        //     "Content": Buffer.from(calendarData).toString('base64'),
        //     "ContentType": "text/calendar; charset=utf-8; method=REQUEST"
        //     }
        //   ],
        // }).catch(err=>{
        //   console.log(err)
        // });
        
        for (let i = 0; i < hosts.length; i++) {
          const element = hosts[i];
          await commonService.createEmailArchiveDocument({
            datamodel : dataModel,
            attachments : attachments,
            emailTo : [element.email],
            emailMap : [{[element.email] : element.profileid}],
            fileURL : '',
            from:'starlabs@excellenceinstallation.com',
            notes : '',
            profileId : [element.profileid],
            postmarkTemplateId: '24973955',
            templateAlias:'appointment-scheduled'
          }).then(()=>{
            console.log('Sent to email archive creation');
          });
          // await commonService.postmarkClient.sendEmailWithTemplate({
          //   From: "starlabs@excellenceinstallation.com",
          //   To: element.email,
          //   TemplateAlias: "appointment-scheduled",
          //   TemplateModel: dataModel,
          //   Attachments: [
          //     {
          //     "Name": "appointment.ics",
          //     "Content": Buffer.from(calendarData).toString('base64'),
          //     "ContentType": "text/calendar; charset=utf-8; method=REQUEST"
          //     }
          //   ],
          // }).catch(err=>{
          //   console.log(err)
          // });
        }
      }
    })
    return res.status(200).send("Email Sent");
  })
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
exports.appointmentbooked = onDocumentCreated("/appointments/{docid}", async (snapshotdata) =>{
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
    var zoomid = ""
    var zoompassword = ""

    // Main EIS Roles
    var mainRoles = ["eisroles/mz7tx7W02rx5VvaduaFT", "eisroles/IyvM6K3Sl90Tm5YZSp6W", "eisroles/f5wT99oyCANbIfXIfKCM", "eisroles/tUibFLhrQadcIT7FjENb"]

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
    await admin.firestore().doc(snapshot.data()["bookedby"].path).get().then(profile=>{
      bookedby.name = profile.data()["name"]
      bookedby.email = profile.data()["email"]
    })
    var starttime = snapshot.data()["starttime"].toDate()
    var endtime = snapshot.data()["endtime"].toDate()
    var formatedStartTime = new Date(starttime.getFullYear(), starttime.getMonth(), starttime.getDate(), starttime.getHours()+5, starttime.getMinutes()+30, 0);
    var formatedEndTime = new Date(endtime.getFullYear(), endtime.getMonth(), endtime.getDate(), endtime.getHours()+5, endtime.getMinutes()+30, 0);
    date = formatedStartTime.toDateString() + " at " + (formatedStartTime.getHours()%12 || 12) + ":" + (formatedStartTime.getMinutes().toString().length == 1 ? ("0"+formatedStartTime.getMinutes().toString()) : formatedStartTime.getMinutes()) + (formatedStartTime.getHours() < 12 ? "AM" : "PM") + " - " + (formatedEndTime.getHours()%12 || 12) + ":" + (formatedEndTime.getMinutes().toString().length == 1 ? ("0"+formatedEndTime.getMinutes().toString()) : formatedEndTime.getMinutes()) + (formatedEndTime.getHours() < 12 ? "AM" : "PM") + " IST"
    var appointmentRoles = []
    for (let i = 0; i < snapshot.data()["appointmentrole"].length; i++) {
      const element = snapshot.data()["appointmentrole"][i];
      appointmentRoles.push(element.path)
    }
    appointmentRoles = Array.from(new Set(appointmentRoles))
    
    for (let i = 0; i < mainRoles.length; i++) {
      const mainelement = mainRoles[i];
      for (let j = 0; j < appointmentRoles.length; j++) {
        const roleelement = appointmentRoles[j];
        if(mainelement == roleelement){
          var mainHost = snapshot.data()["hostRole"][mainelement][0]
          console.log(mainHost.id)
          await admin.firestore().collection("EISzoomcontact").doc(mainHost.id).get().then(zoomcontact=>{
            if(zoomcontact.exists){
              zoomurl = zoomcontact.data()["zoomurl"]
              zoomid = zoomcontact.data()["zoomid"]
              zoompassword = zoomcontact.data()["zoompassword"]
            }
            else{
              console.log("NOT EXIST")
            }
          }).catch(err=>{
            console.log(err)
          });
          i = 1000
          j = 1000
        }
      }
    }
    
    for (let i = 0; i < appointmentRoles.length; i++) {
      const aptRole = appointmentRoles[i];
      const roleName = (await admin.firestore().doc(aptRole).get()).data()["role"].toLowerCase()
      for (let j = 0; j < snapshot.data()["hostRole"][aptRole].length; j++) {
        var host = snapshot.data()["hostRole"][aptRole][j];
        await admin.firestore().collection("EISzoomcontact").doc(host.id).get().then(async contact=>{
          if(contact.exists){
            hosts.push({
              name: contact.data()["name"],
              email: contact.data()["email"],
              role: roleName
            })
            if(zoomurl == ""){
              zoomurl = contact.data()["zoomurl"]
              zoomid = contact.data()["zoomid"]
              zoompassword = contact.data()["zoompassword"]
            }
          }
          else{
            await admin.firestore().doc(host.path).get().then(profile=>{
              hosts.push({
                name: profile.data()["name"],
                email: profile.data()["email"],
                role: roleName
              })
            })
          }
        }) 
      }
    }

    // Save Zoom Meeting Data
    await snapshot.ref.update({
      zoomurl: zoomurl,
      zoomid: zoomid,
      zoompassword: zoompassword,
    })

    // Send Email
    var dataModel = {
      product_name: "StarLabs - Scheduling",
      appointment: appointmentname,
      date: date,
      duration: duration,
      client: bookedby.name,
      zoomurl: zoomurl,
      zoomid: zoomid,
      zoompassword: zoompassword,
      company_name: "Antano & Harini",
    }
    // if(appointmentname.includes("Journey")){
    //   dataModel["assitancename"] = "Mr.Milan"
    //   dataModel["assitancenumber"] = "+91 80982 73877"
    // }
    // else if(appointmentname.includes("Critical") || appointmentname.includes("Light")){
    //   dataModel["assitancename"] = "Ms.Agalya Das"
    //   dataModel["assitancenumber"] = "+91 93611 38763"
    // }
    // else{
      dataModel["assitancename"] = "Ms.Dhivya D'cruz & Mr. Solomon"
      dataModel["assitancenumber"] = "+91 81225 51403"
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
    const attachments = [
      {
      "Name": "appointment.ics",
      "Content": Buffer.from(calendarData).toString('base64'),
      "ContentType": "text/calendar; charset=utf-8; method=REQUEST"
      }
    ]
    await commonService.createEmailArchiveDocument({
      emailData : dataModel,
      datamodel : dataModel,
      attachments : attachments,
      emailTo : [bookedby.email],
      emailMap : [{[bookedby['email']] : bookedby.profileid}],
      fileURL : '',
      from:'starlabs@excellenceinstallation.com',
      notes : '',
      profileId : [bookedby.profileid],
      postmarkTemplateId: '24973955',
      templateAlias:'appointment-scheduled'
    });
    
    // await commonService.postmarkClient.sendEmailWithTemplate({
    //   From: "starlabs@excellenceinstallation.com",
    //   To: bookedby.email,
    //   TemplateAlias: "appointment-scheduled",
    //   TemplateModel: dataModel,
    //   Attachments: [
    //     {
    //     "Name": "appointment.ics",
    //     "Content": Buffer.from(calendarData).toString('base64'),
    //     "ContentType": "text/calendar; charset=utf-8; method=REQUEST"
    //     }
    //   ],
    // }).catch(err=>{
    //   console.log(err)
    // });
    for (let i = 0; i < hosts.length; i++) {
      const element = hosts[i];

      await commonService.createEmailArchiveDocument({
        datamodel : dataModel,
        attachments : attachments,
        emailTo : [element.email],
        emailMap : [{[element.email] : element.profileid}],
        fileURL : '',
        from:'starlabs@excellenceinstallation.com',
        notes : '',
        profileId : [element.profileid],
        postmarkTemplateId: '24973955',
        templateAlias:'appointment-scheduled'
      });

      // await commonService.postmarkClient.sendEmailWithTemplate({
      //   From: "starlabs@excellenceinstallation.com",
      //   To: element.email,
      //   TemplateAlias: "appointment-scheduled",
      //   TemplateModel: dataModel,
      //   Attachments: [
      //     {
      //     "Name": "appointment.ics",
      //     "Content": Buffer.from(calendarData).toString('base64'),
      //     "ContentType": "text/calendar; charset=utf-8; method=REQUEST"
      //     }
      //   ],
      // }).catch(err=>{
      //   console.log(err)
      // });
      // 
    }

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

    // await commonService.postmarkClient.sendEmailWithTemplate({
    //   From: "starlabs@excellenceinstallation.com",
    //   To: bookedby.email,
    //   TemplateAlias: "appointment-cancelled",
    //   TemplateModel: clientModel,
    // }).catch(err=>{
    //   console.log(err)
    // });

    await commonService.createEmailArchiveDocument({
      emailData : clientModel,
      datamodel : clientModel,
      attachments : [],
      emailTo : [bookedby.email],
      emailMap : [{[bookedby['email']] : bookedby.profileid}],
      fileURL : '',
      from:'starlabs@excellenceinstallation.com',
      notes : '',
      profileId : [bookedby.profileid],
      postmarkTemplateId: '24640180',
      templateAlias:'appointment-cancelled'
    }).then(()=>{
      console.log('Sent for email archive');
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

      // await commonService.postmarkClient.sendEmailWithTemplate({
      //   From: "starlabs@excellenceinstallation.com",
      //   To: element.email,
      //   TemplateAlias: "appointment-cancelled",
      //   TemplateModel: hostModel
      // }).catch(err=>{
      //   console.log(err)
      // });

      await commonService.createEmailArchiveDocument({
        emailData : clientModel,
        datamodel : clientModel,
        attachments : [],
        emailTo : [bookedby.email],
        emailMap : [{[bookedby['email']] : bookedby.profileid}],
        fileURL : '',
        from:'starlabs@excellenceinstallation.com',
        notes : '',
        profileId : [bookedby.profileid],
        postmarkTemplateId: '24640180',
        templateAlias:'appointment-cancelled'
      }).then(()=>{
        console.log('Sent for email archive');
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
      var weekOffDays = specialistHours["weekoff"] || []
      for (let j = 1; j < weekday.length; j++) {
        const day = weekday[j];
        var dates = []
        for (let a = 1; a <= 15; a++) {
          var checkdate = new Date(new Date().setDate(firstDay.getDate() + a))

          if(weekOffDays.includes(day)){
            // Delete WeekOff Days
            var starttime = new Date(new Date(checkdate).setHours(0 - (timezone.hour), 0 - (timezone.minute), 0, 0, 0))
            var endtime = new Date(new Date(checkdate).setHours(23 - (timezone.hour), 59 - (timezone.minute), 59, 0, 0))
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
                  // var deleteSlot = false
                  // for (let b = 0; b < (specialistHours[day] || []).length; b++) {
                  //   const splitStartHour = specialistHours[day][b]["starttime"].split(":");
                  //   const splitEndHour = specialistHours[day][b]["endtime"].split(":");
                  //   var newSlotStart = new Date(new Date(date).setHours(splitStartHour[0] - (timezone.hour), splitStartHour[1] - (timezone.minute), 0, 0))
                  //   var newSlotEnd = new Date(new Date(date).setHours(splitEndHour[0] - (timezone.hour), splitEndHour[1] - (timezone.minute), 0, 0))
                  //   if(newSlotStart.valueOf() != existingData["starttime"].toDate().valueOf() && newSlotEnd.valueOf() != existingData["endtime"].toDate().valueOf()){
                  //     deleteSlot = true
                  //   }
                  //   else{
                  //     deleteSlot = false
                  //     break;
                  //   }
                  // }
                  // if(deleteSlot){
                    await existingSlot.ref.delete().catch(e =>{
                      console.log(e)
                    })
                  // }
                }             
              }
            })

          }
          else{
            if(checkdate.getDay() == j){
              dates.push(checkdate)
            }
          }
        }
        for (let k = 0; k < dates.length; k++) {
          const date = dates[k];
          starttime = new Date(new Date(date).setHours(0 - (timezone.hour), 0 - (timezone.minute), 0, 0, 0))
          endtime = new Date(new Date(date).setHours(23 - (timezone.hour), 59 - (timezone.minute), 59, 0, 0))
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
exports.appointmentremainder = onSchedule({schedule: "every 5 minutes"}, async (event) => {
  var currentTime = new Date()
  // 5 Minutes
  var nextfive = new Date()
  nextfive.setMinutes(currentTime.getMinutes() + 5)
  console.log("Five Minutes Time", currentTime.toTimeString(), nextfive.toTimeString())
  await admin.firestore().collection("appointments").where("cancelled", "==", false).where("starttime", ">=", currentTime).where("starttime", "<=", nextfive).get().then(async appt=>{
    console.log("Next 5 Mins Appt", appt.size)
    var profileid = []
    if(appt.docs.length != 0){
      for (let i = 0; i < appt.docs.length; i++) {
        const appDoc = appt.docs[i]
        const apptData = appDoc.data();
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

  // One Hour
  var starttime = new Date()
  starttime.setMinutes(currentTime.getMinutes() + 55)
  var endtime = new Date()
  endtime.setMinutes(currentTime.getMinutes() + 65)
  console.log("Next One Hour", starttime.toTimeString(), endtime.toTimeString())
  await admin.firestore().collection("appointments").where("cancelled", "==", false).where("starttime", ">=", starttime).where("starttime", "<=", endtime).get().then(async appt=>{
    console.log("Next 1 Hour Appt", appt.size)
    var profileid = []
    if(appt.docs.length != 0){
      for (let i = 0; i < appt.docs.length; i++) {
        const appDoc = appt.docs[i]
        const apptData = appDoc.data();
        var appointmentName = ""
        await admin.firestore().doc(apptData["appointment"].path).get().then(data=>{
          appointmentName = data.data()["appointmenttype"]
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

        // Wati Remainder
        try {
          var profileData = (await admin.firestore().collection("profile_data").doc(apptData["bookedby"].id).get()).data()
          if(profileData["number"]){
            let countrycode = (![null,undefined].includes(profileData['countrycode']) ? profileData['countrycode'] : '+91').replace(/\+/g,"")

            // Convert Firestore timestamp to Date
            var appointmentTime = new Date(apptData["starttime"].toDate());

            // Format directly to IST using toLocaleString
            var formatTime = appointmentTime.toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            }) + " IST";

            const watiParams = [
              { name: 'name', value: profileData['name'] },
              { name: 'session', value: appointmentName },
              { name: 'timing', value: formatTime }
            ]

            console.log("Params", watiParams)

            const waticontent = {
              phonenumber: `${countrycode}${profileData['number']}`,
              body: {
                parameters: watiParams,
                broadcast_name: 'onboarding_1hr_reminder_v1',
                template_name: 'onboarding_1hr_reminder_v1'
              }
            };

            const parameterConfig = watiParams.map(param => ({
              excelColumn: null,
              fillType: 'static',
              metadataField: null,
              name: param.name,
              staticValue: param.value
            }));
            console.log('Triggered Wati Archive Creation');
            
            const response = await commonService.createWatiArchiveDocument({
              numbers: [parseInt(profileData['number'])],
              numbermap : {[`${profileData['number']}`] : profileData.id},
              broadcastname : 'Individual',
              paramFillMode: 'static',
              parameterConfig: parameterConfig,
              params: [],
              profileid: [profileData.id],
              templateid: null,
              watitemplateid: 'onboarding_1hr_reminder_v1',
            });
            console.log('WATI ARCHIVE RESPONSE', response);
            
            // await commonService.sendToWhatsappViaWati(waticontent).catch(err =>{
            //   console.log("Wati Appointment Remainder Error")
            //   console.log(err)
            // });
          }
        } catch (error) {
          console.log("Wati Appointment Remainder Exception")
          console.log(error)
        }
      }
    }
  })
  
  // Scheduled Saved Notifications
  await admin.firestore().collection("savednotifications")
  .where("schedule", "==", true)
  .where("sent", "==", false)
  .where("scheduledat", ">=", currentTime)
  .where("scheduledat", "<=", nextfive)
  .get().then(async notiSnap => {
    console.log("Saved Notifications:", notiSnap.size)
    if (notiSnap.docs.length != 0) {
      for (let i = 0; i < notiSnap.docs.length; i++) {
        const notiDoc = notiSnap.docs[i]
        const notiData = notiDoc.data()
        var profileID = (notiData["profiles"] || []).map(p => p)
        if (profileID.length > 0) {
          await commonService.saveNotificationRecord({
            title: notiData["title"] || "",
            message: notiData["message"] || "",
            subtitle: notiData["subtitle"] || null,
            date: admin.firestore.FieldValue.serverTimestamp(),
            landingpage: notiData["landingpage"] || null,
            logged: notiData["logged"] ? true : false,
            profileid: profileID,
            sticky: notiData["sticky"] || false,
            notificationtype: "ahupdate",
            notificationimage: notiData["notificationimage"] || null,
            metadata: notiData["metadata"] || {}
          })
          await notiDoc.ref.update({ schedule: false, sent: true, sentat: admin.firestore.FieldValue.serverTimestamp() })
          console.log("Saved notification sent:", notiDoc.id)
        }
      }
    }
  }).catch(err => {
    console.log("Saved Notification Error:", err)
  })
})