// Temporary deploy entry — OpenVidu/LiveKit functions only.
// Avoids loading ATC.js (which binds firestore-atc at module load)
// and prevents Firestore rate limit errors during Firebase CLI analysis.
// Restore package.json "main" to "index.emulator.js" after deploy.
const openViduSystem = require('./components/openVidu');
const AWS_endpoint = require('./components/AWS_endpoint');

exports.createOpenViduToken      = openViduSystem.createOpenViduToken;
exports.openViduStartRecording   = openViduSystem.openViduStartRecording;
exports.openViduStopRecording    = openViduSystem.openViduStopRecording;
exports.onEventOpenVidu          = openViduSystem.onEventOpenVidu;
exports.openViduCloseRoom        = openViduSystem.openViduCloseRoom;
exports.CheckMasternodeStatus    = openViduSystem.CheckMasternodeStatus;
exports.awsEventWebhook          = openViduSystem.awsEventWebhook;
exports.startMasterNodeHTTP      = openViduSystem.startMasterNodeHTTP;
exports.stopMasterNodeHTTP       = openViduSystem.stopMasterNodeHTTP;
exports.scaleMediaNodes          = openViduSystem.scaleMediaNodes;
exports.muteParticipant          = openViduSystem.muteParticipant;
exports.kickParticipant          = openViduSystem.kickParticipant;
exports.flushOpenviduCallQuality = openViduSystem.flushOpenviduCallQuality;
exports.getSignedUrlAWS          = AWS_endpoint.getSignedUrlAWS;
