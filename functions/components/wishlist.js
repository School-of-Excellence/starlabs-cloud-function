const admin = require('firebase-admin');
const commonService = require('./service');
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
var postmark = require("postmark");
var postmarkClient = new postmark.ServerClient("67d8b50e-1208-4913-8265-695f57e43939"); // Postmark email:


exports.evolutionFamilyWishlistOnWrite = onDocumentWritten("/evolutionwishlistlog/{docid}",async (changedata) => {
  let change = changedata.data
  let newDoc = change.after.data()
  console.log("doc id test", changedata.params.docid);
  if (newDoc && newDoc['status'] === "sent" && newDoc['contacts'] && newDoc['contacts'].length !== 0) {
    await admin.firestore().collection("profile_data").doc(newDoc['profileid']).get().then(async (profileSnap) => {
      var profileData = profileSnap.data()
      let allPromises = [];
      for (let i = 0; i < newDoc['contacts'].length; i++) {
        const element = newDoc['contacts'][i];
        element['docid'] = newDoc['docid']
        element['profilename'] = profileData['name']
        if(element['type'].trim() === 'number'){
          let waticontent = {
            phonenumber : `${element['contact'].trim().replace(/^\+\d{1,3}/, '')}`,
            body : {
              parameters: [
                {name: 'name', value:profileData['name']},
                {name : 'receivername',value:element['name']},
                {name : 'gender1',value:'their'},
                {name : 'gender2',value:'they'},
                {name: 'link', value: "evolutionwishlist?data=" + encodeURIComponent(JSON.stringify(element))},
              ],
              broadcast_name: 'evolution_wishlist_prod_v12',
              template_name: 'evolution_wishlist_prod_v12'
            }
          }

          const parameterConfig = waticontent['body']['parameters'].map(param => ({
            excelColumn: null,
            fillType: 'static',
            metadataField: null,
            name: param.name,
            staticValue: param.value
          }));

          console.log('Triggered Wati Archive Creation');

          allPromises.push(
            // await commonService.sendToWhatsappViaWati(waticontent)
            
            await commonService.createWatiArchiveDocument({
              numbers: [parseInt(waticontent['phonenumber'])],
              numbermap: { [`${waticontent['phonenumber']}`]: profileData['profileid'] },
              broadcastname: 'Individual',
              paramFillMode: 'static',
              parameterConfig: parameterConfig,
              params: [],
              profileid: [profileData['profileid']],
              templateid: null,
              watitemplateid: 'evolution_wishlist_prod_v12',
            }),
            
            console.log('WATI ARCHIVE RESPONSE')

          );
        }else if(element['type'].trim() === 'gmail'){
          console.log("email");
          var clientModel = {
            participantname:profileData['name'],
            dearname:element['name'],
            link:"https://breakthroughs.app/evolutionwishlist?data=" + encodeURIComponent(JSON.stringify(element))
          }
          allPromises.push(
            await postmarkClient.sendEmailWithTemplate({
              From: "starlabs@excellenceinstallation.com",
              To:element['contact'].trim(),
              TemplateAlias: "evolution_wishlist",
              TemplateModel: clientModel,
            }).catch(err=>{
              console.log(err)
            })
          );
        }else{
          console.log("not a known type",element['type']);
        }
      }
      await Promise.all(allPromises);
      await admin.firestore().collection("evolutionwishlistlog").doc(changedata.params.docid).update({
        status: "sended"
      });
    })
  }
  if(newDoc && newDoc['status'] === "sended" && newDoc['contacts']) {
    let receivedCount = 0;
    const totalContacts = newDoc['contacts'].length;
    for (const contact of newDoc['contacts']) {
      if (contact.status === "received") {
        receivedCount++;
      }
    }
    if (receivedCount === totalContacts) {
      await admin.firestore().collection("evolutionwishlistlog").doc(changedata.params.docid).update({
        status: "completed",
        closed:false
      });
    }
  }
});