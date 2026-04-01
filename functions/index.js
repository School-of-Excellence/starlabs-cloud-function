//components imports
const commonService = require("./components/service");
const ticketSystem = require("./components/ticketsystem");
const achievementSystem = require("./components/achievements");
const appointmentSystem = require("./components/appointment");
const atcSystem = require("./components/ATC");
const bigAssignmentSystem = require("./components/big-assignment");
const bigLevelAggregate = require("./components/big-level-aggregate");
const clientIssueSystem = require("./components/clientissue");
const communication = require("./components/communication")
const contentSystem = require("./components/content");
const eiflixTierSystem = require("./components/eiflix-tier");
const exportsAndAlerts = require("./components/exports-alerts")
const interimReportSystem = require("./components/interimreport");
const participantMetaDataSystem = require("./components/participantmetadata");
const participantModeSystem = require("./components/participantmode");
const participantProductSystem = require("./components/participantproduct");
const queueSystem = require("./components/queuesystem");
const salescrmUpdates = require("./components/salescrm-updates")
const userRegistration = require("./components/user_registration")
const wishlist = require("./components/wishlist")
const watsonUpdates = require("./components/watson-updates")
const openViduSystem = require("./components/openVidu")
const AWS_endpont = require("./components/AWS_endpoint")

// Ticket System
exports.TicketCreatedSlackNotification = ticketSystem.TicketCreatedSlackNotification; // w - "tickets/{ticketId}"

//Achievements
// no deployment needs validation
// exports.likeNotification = achievementSystem.likeNotification // c - '/Achievements/posts/postcollection/{postid}/likes/{id}'
// exports.commentNotification = achievementSystem.commentNotification // c - '/Achievements/posts/postcollection/{postid}/comments/{id}'
// exports.comment_likes_Notification = achievementSystem.comment_likes_Notification // c - '/Achievements/posts/postcollection/{postid}/comments/{commentid}/commentlikes/{id}'
exports.onBreakthroughsPosted = achievementSystem.onBreakthroughsPosted

//Appointments
exports.requestScheduling = appointmentSystem.requestScheduling // on request just sends slack message
exports.resentAppointmentEmail = appointmentSystem.resentAppointmentEmail // on request
exports.computeSlot = appointmentSystem.computeSlot // c - "/availability/{docid}"
exports.appointmentbooked = appointmentSystem.appointmentbooked // c - "/appointments/{docid}"
exports.appointmentcancelled = appointmentSystem.appointmentcancelled // u - "/appointments/{docid}"
exports.requestApptCancel = appointmentSystem.requestApptCancel // on request
exports.deliveryhoursCreate = appointmentSystem.deliveryhoursCreate // u - '/deliverytime/{id}'
exports.availabilityScheduler = appointmentSystem.availabilityScheduler // schedule "00 00 * * *"
exports.profileAvailability = appointmentSystem.profileAvailability // on request
exports.approveOfftime = appointmentSystem.approveOfftime // on request
exports.appointmentremainder = appointmentSystem.appointmentremainder // schedule "every 5 minutes"
// exports.appointmentLinkRegenarate = appointmentSystem.appointmentLinkRegenarate

//ATC
exports.procedureOnWrite = atcSystem.procedureOnWrite // w - "/atc_alpha/{atc_id}/corrections/{adjustmentid}/procedures/{procedureid}"
exports.validateATCtoAlpha = atcSystem.validateATCtoAlpha // u - "atc_to_validate/{id}"
exports.updateAuthorUIDInAtcAlpha = atcSystem.updateAuthorUIDInAtcAlpha // w - "atc_alpha/{atcalphaid}"

//big-assignments
exports.createBigParticipantAssignment = bigAssignmentSystem.createBigParticipantAssignment // c - "big assignment/{docid}"
exports.onUpdateBigAssignment = bigAssignmentSystem.onUpdateBigAssignment // u - "big assignment/{docid}"
exports.updateBigParticipantsAssignment = bigAssignmentSystem.updateBigParticipantsAssignment // w - "big participants assignments/{docid}"
exports.bigAssignmentParticipantConfirmation = bigAssignmentSystem.bigAssignmentParticipantConfirmation // http - from wati message

//big-level-aggregate
exports.bigLevelProfileReset = bigLevelAggregate.bigLevelProfileReset // http - from big aggragate screen
exports.aggregateBigLevelFromActivityLog = bigLevelAggregate.aggregateBigLevelFromActivityLog // c - "queue activity log/{docid}"

//client issue system
exports.ticketfromwebsite = clientIssueSystem.ticketfromwebsite // onRequest
exports.ticketMsgNotification = clientIssueSystem.ticketMsgNotification // c - '/clientissue/{docid}/messages/{messageid}'
exports.slackCustomerSupport = clientIssueSystem.slackCustomerSupport // w - "clientissue/{id}"
exports.ticketCreated = clientIssueSystem.ticketCreated // c - "clientissue/{id}"
exports.ticketCreatedV2 = clientIssueSystem.ticketCreatedV2 // c - "clientissue/{id}"
exports.autoCloseTickets = clientIssueSystem.autoCloseTickets 
exports.dashboardcustomersupport = clientIssueSystem.dashboardcustomersupport // w - "clientissue/{id}"

//communication
exports.notifyMobileApp = communication.notifyMobileApp // c - "/notificationrecord/{id}"
exports.SupportDeskToSlack = communication.SupportDeskToSlack // c - '/supportdesk/{docid}/messages/{messageid}'
// exports.emailArchiveTriggerOnWrite = communication.emailArchiveTriggerOnWrite // w - "email archive/{docid}"
exports.watiResponseCapture = communication.watiResponseCapture // onrequest
exports.myOperatorCalls = communication.myOperatorCalls // onrequest
exports.createPostMarkEmailTemplate = communication.createPostMarkEmailTemplate // u - 'email templates/{docid}',
exports.sendBatchEmailTest = communication.sendBatchEmailTest // On Create 'email Archive/{docid}'
exports.sendBatchEmail = communication.sendBatchEmail // On Request
exports.postmarkResponseCapture = communication.postmarkResponseCapture // on request
// exports.sendValidationMail = communication.sendValidationMail; // onRequest
exports.sendWhatsAppBroadcastCreated = communication.sendWhatsAppBroadcastCreated // c - 'wati archive/{docid}'
exports.sendWhatsAppBroadcast = communication.sendWhatsAppBroadcast // c - 'On Request'
exports.slackLoginEvent = communication.slackLoginEvent // c - "loginlog/{docid}"
// exports.createTwilioWhatsAppTemplate = communication.createTwilioWhatsAppTemplate // c - 'twilio_templates/{docid}'

//contentSystem
exports.communityPostHLS = contentSystem.communityPostHLS // w - '/community post/{id}'
exports.videoAskHLS = contentSystem.videoAskHLS // c - '/participantvideoask/{id}'
exports.slackContentConsumption = contentSystem.slackContentConsumption // c - "content analytics/{docid}"
exports.buffermixToRecommendedPlaylist = contentSystem.buffermixToRecommendedPlaylist // c - "buffermix archive/{docid}"
exports.ConvertUrltoHLS = contentSystem.ConvertUrltoHLS // w - '/episodes/{id}'
exports.UnconvertedUrltoHLS = contentSystem.UnconvertedUrltoHLS // schedule 'every 6 hours'
exports.generalContentUpdate = contentSystem.generalContentUpdate
exports.uploadContentToPublitio = contentSystem.uploadContentToPublitio

//eiflix tier
exports.totalparticipant_tierupdate = eiflixTierSystem.totalparticipant_tierupdate // w - "/tier access config/{docid}"

// exports & alerts
if(commonService.production){
  exports.scheduledFirestoreExport = exportsAndAlerts.scheduledFirestoreExport // schedule "every 12 hours"
}
exports.slackBudgetAlert = exportsAndAlerts.slackBudgetAlert // onMessagePublished "Launch-Your-Legacy-budget-alert-slack"
// 
//interim report
exports.slackInterimCrossOver = interimReportSystem.slackInterimCrossOver // c - "/interim crossover/{docid}"
exports.slackLoveLetter = interimReportSystem.slackLoveLetter // c - "/love letter/{docid}"
exports.slackAskAH = interimReportSystem.slackAskAH //  c - "/ask AH/{docid}"
exports.ATCevolutionProgress = interimReportSystem.ATCevolutionProgress

//participant metadata
exports.profiledata_to_participantmetadata = participantMetaDataSystem.profiledata_to_participantmetadata // w - profile_data
exports.RecommendedPlaylistTrigger_to_pmd = participantMetaDataSystem.RecommendedPlaylistTrigger_to_pmd // c - "recommended mix playlist/{docid}"
// exports.QueueEventUpdate_to_pmd = participantMetaDataSystem.QueueEventUpdate_to_pmd // w - '/queue_token/{id}'
exports.purchaselabel_to_pmd = participantMetaDataSystem.purchaselabel_to_pmd // w - 'journeyproductpurchase/{docid}'
exports.journey_to_pmd = participantMetaDataSystem.journey_to_pmd // w - 'participantjourneyproduct/{docid}'
exports.productsdata_to_pmd = participantMetaDataSystem.productsdata_to_pmd // w - 'participantsproduct/{docid}'
exports.eventparticipationdata_to_pmd = participantMetaDataSystem.eventparticipationdata_to_pmd // w - "event participation request/{docid}"
exports.atcdata_to_pmd = participantMetaDataSystem.atcdata_to_pmd // w - "atc_apha/{docid}"
exports.participantAELData_to_pmd = participantMetaDataSystem.participantAELData_to_pmd // w - "/participant AEL/{docid}"
exports.participantsely_to_pmd = participantMetaDataSystem.participantsely_to_pmd // w - "/participants ely/{docid}"
exports.bigAggregateLevelUpdate_to_pmd = participantMetaDataSystem.bigAggregateLevelUpdate_to_pmd // w - "/big aggregate level/{docid}"
exports.subscriptionend_JourneystatusUpdate = participantMetaDataSystem.subscriptionend_JourneystatusUpdate // Check subscription ended

//participant mode 
exports.calculateParticipantMode = participantModeSystem.calculateParticipantMode // w - '/participantsproduct/{id}'
exports.productNextModeUpdate = participantModeSystem.productNextModeUpdate // schedule func "05 00 * * *"
// exports.installationEventMode = participantModeSystem.installationEventMode // schedule func "00 00 * * *"
// exports.eventMode = participantModeSystem.eventMode // schedule func "00 00 * * *"
// exports.IntegrationModeEvent = participantModeSystem.IntegrationModeEvent // schedule func "00 00 * * *"
// exports.priorityMode = participantModeSystem.priorityMode // schedule func "00 00 * * *"
// exports.performanceMode = participantModeSystem.performanceMode // schedule func "00 00 * * *"
// exports.extendedPerformanceMode = participantModeSystem.extendedPerformanceMode // schedule func "00 00 * * *"
// exports.afterextendedPerformanceMode = participantModeSystem.afterextendedPerformanceMode // schedule func "00 00 * * *"
// exports.priorityPreparationMode = participantModeSystem.priorityPreparationMode // schedule func 'every 24 hours'
// exports.queuePreparationMode = participantModeSystem.queuePreparationMode // schedule func 'every 24 hours'
// exports.eventPreparationMode = participantModeSystem.eventPreparationMode // schedule func 'every 24 hours'
exports.onEventApprovalProductMode = participantModeSystem.onEventApprovalProductMode // w - "event participation request/{docid}"

//participant product
exports.participantsproductinitiated = participantProductSystem.participantsproductinitiated // w - '/participantsproduct/{id}'
exports.startParticipantNextDeliverySequence = participantProductSystem.startParticipantNextDeliverySequence // u - "deliverables/{id}"
exports.participantJourneyproductSocialcommitupdate = participantProductSystem.participantJourneyproductSocialcommitupdate // on request

//queue system
// exports.queueStage = queueSystem.queueStage // w - "queue_token/{id}"
exports.onQueueStageChange = queueSystem.onQueueStageChange // w - "queue_token/{id}"
exports.biginvitationAccepted = queueSystem.biginvitationAccepted // u - "biginvitation/{id}"
exports.studioZoomLink = queueSystem.studioZoomLink // c - "live assignment/{id}"
exports.studioZoomLinkDeactivate = queueSystem.studioZoomLinkDeactivate // u - "live assignment/{id}"
exports.studioZoomLinkRegenerate = queueSystem.studioZoomLinkRegenerate // on request
// exports.watiQueueWelcomeNotification = queueSystem.watiQueueWelcomeNotification // w - "/queue_token/{queuetokenid}"
exports.queueParticipantPositionUpdate = queueSystem.queueParticipantPositionUpdate // c - "queue stage log/{queueStageLogId}"
exports.particpantFormSubmit_SlackIntegration = queueSystem.particpantFormSubmit_SlackIntegration // c - "formsByClient/{id}" 
exports.inviteToStudio = queueSystem.inviteToStudio // c - "studioinvitation/{docid}"
exports.onQueueTokenCreateUpdateProductMode = queueSystem.onQueueTokenCreateUpdateProductMode // c -"queue_token/{docid}"
exports.onQueueDateChange = queueSystem.onQueueDateChange // u - "queue generation/{docid}"
exports.onEventDateChange = queueSystem.onEventDateChange // u - "event collection/{docid}"
exports.zoomActivitylog = queueSystem.zoomActivitylog // onrequest
exports.bulkReadyInvitation = queueSystem.bulkReadyInvitation // c - "bulk invitation/{docid}"
exports.invitationAccepted = queueSystem.invitationAccepted // u - "studioinvitation/{docid}"
exports.queueavtest = queueSystem.queueavtest //  c - "queue avtest/{docid}"
exports.CreateQueueActivityLogV2 = queueSystem.CreateQueueActivityLogV2 // u - "live assignment/{docid}"
exports.queueParticipantTransfer = queueSystem.queueParticipantTransfer // c - "queue participant transfer/{docid}"

//salescrm - updates
exports.salesCRMConvertedLeads = salescrmUpdates.salesCRMConvertedLeads // on request
exports.updateJourneyDataToSalesCRM = salescrmUpdates.updateJourneyDataToSalesCRM // w - 'journey/{journeyid}'
exports.updateProductDataToSalesCRM = salescrmUpdates.updateProductDataToSalesCRM //w - 'products/{id}'
exports.updatePackageDesignDataToSalesCRM = salescrmUpdates.updatePackageDesignDataToSalesCRM // w - 'package design/{packagedesignid}'
exports.updateJourneyProductDataToSalesCRM = salescrmUpdates.updateJourneyProductDataToSalesCRM // w - 'journey-to-product/{id}'
exports.salesCaptureSlackIntegration = salescrmUpdates.salesCaptureSlackIntegration // onrequest
exports.sendSlackNotificationSaleRejection = salescrmUpdates.sendSlackNotificationSaleRejection // u - 'salesleads/{id}'
exports.salesCRMProfilestatus = salescrmUpdates.salesCRMProfilestatus // on request

//user registration
exports.createProfile_registeredUser = userRegistration.createProfile_registeredUser // c - "user_data/{docid}"

//wishlist
exports.evolutionFamilyWishlistOnWrite = wishlist.evolutionFamilyWishlistOnWrite // w - "/evolutionwishlistlog/{docid}"

// Watson
exports.dashboardPaymentplanWatsonRequest = watsonUpdates.dashboardPaymentplanWatsonRequest

// Chat
exports.ChatxNotification = communication.ChatxNotification

//workshop New User Login
exports.sendEmailOTPNewUsers = userRegistration.sendEmailOTPNewUsers
exports.verifyEmailOTPNewUsers = userRegistration.verifyEmailOTPNewUsers
exports.resendEmailOTPNewUsers = userRegistration.resendEmailOTPNewUsers
exports.newuserjoinedslackintegration = userRegistration.newuserjoinedslackintegration

//workshop Q&A
exports.workshopQandA = communication.workshopQandA
exports.workshopFormsSubmission = communication.workshopFormsSubmission
exports.workshopAssignment = communication.workshopAssignment

//workshop communication
exports.workshopenrolledwatti = communication.workshopenrolledwatti
exports.workshopprogressmessage = communication.workshopprogressmessage
exports.workshopprogressmessagev2 = communication.workshopprogressmessagev2

//product enquiry
exports.productenquiryfromeiflix = communication.productenquiryfromeiflix

// OpenVidu
// exports.createOpenViduToken = openViduSystem.createOpenViduToken
// exports.openViduStartRecording = openViduSystem.openViduStartRecording
// exports.openViduStopRecording = openViduSystem.openViduStopRecording
// exports.onEventOpenVidu = openViduSystem.onEventOpenVidu
// exports.openViduCloseRoom = openViduSystem.openViduCloseRoom
// exports.CheckMasternodeStatus = openViduSystem.CheckMasternodeStatus

// AWS
exports.getSignedUrlAWS = AWS_endpont.getSignedUrlAWS

//live changework
exports.livechangeworkadjustment = achievementSystem.livechangeworkadjustment