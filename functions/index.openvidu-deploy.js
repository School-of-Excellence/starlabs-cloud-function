// Temporary deploy entry — OpenVidu/LiveKit functions only.
// Avoids loading ATC.js (which binds firestore-atc at module load)
// and prevents Firestore rate limit errors during Firebase CLI analysis.
// Restore package.json "main" to "index.emulator.js" after deploy.
//
// Keep this file in sync with index.js. The 2026-07-16 multi-provider refactor
// moved every AWS infra function out of openVidu.js into AWS_endpoint.js; this
// file still read five of them off openVidu.js, where they resolve to undefined
// — a targeted deploy naming them would fail, or worse, be read as "removed from
// source" against a live project. Fixed below, and the OCI twins added.
const openViduSystem = require('./components/openVidu');
const AWS_endpoint = require('./components/AWS_endpoint');
const OCI_endpoint = require('./components/OCI_endpoint');

// ---- Shared LiveKit dispatcher (provider-aware) ----
exports.createOpenViduToken      = openViduSystem.createOpenViduToken;
exports.openViduStartRecording   = openViduSystem.openViduStartRecording;
exports.openViduStopRecording    = openViduSystem.openViduStopRecording;
exports.onEventOpenVidu          = openViduSystem.onEventOpenVidu;
exports.onEventOci               = openViduSystem.onEventOci;
exports.openViduCloseRoom        = openViduSystem.openViduCloseRoom;
exports.muteParticipant          = openViduSystem.muteParticipant;
exports.kickParticipant          = openViduSystem.kickParticipant;
exports.flushOpenviduCallQuality = openViduSystem.flushOpenviduCallQuality;

// ---- AWS infrastructure ----
exports.getSignedUrlAWS          = AWS_endpoint.getSignedUrlAWS;
exports.CheckMasternodeStatus    = AWS_endpoint.CheckMasternodeStatus;
exports.awsEventWebhook          = AWS_endpoint.awsEventWebhook;
exports.startMasterNodeHTTP      = AWS_endpoint.startMasterNodeHTTP;
exports.stopMasterNodeHTTP       = AWS_endpoint.stopMasterNodeHTTP;
exports.scaleMediaNodes          = AWS_endpoint.scaleMediaNodes;

// ---- OCI infrastructure ----
exports.getSignedUrlOci          = OCI_endpoint.getSignedUrlOci;
exports.CheckOciNodeStatus       = OCI_endpoint.CheckOciNodeStatus;
exports.startOciMasterHTTP       = OCI_endpoint.startOciMasterHTTP;
exports.stopOciMasterHTTP        = OCI_endpoint.stopOciMasterHTTP;
exports.scaleOciMediaNodes       = OCI_endpoint.scaleOciMediaNodes;
exports.ociEventWebhook          = OCI_endpoint.ociEventWebhook;
