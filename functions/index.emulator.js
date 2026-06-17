// ============================================================================
// index.emulator.js — FILTERED entry point for the Firebase EMULATOR (queue e2e
// CI/CD gate). Re-exports ONLY the 16 queue / studio / B!G + upstream
// participant-metadata triggers that the queue e2e suite exercises.
//
// WHY this file exists (do NOT load the full index.js into the emulator):
//   - The full `index.js` requires `./components/ATC`, which binds the
//     off-limits `firestore-atc` named DB at MODULE LOAD (ATC.js top-level
//     `getFirestore("firestore-atc")`). That DB must never be provisioned for
//     CI (CLAUDE.md hard constraint). Requiring ATC.js here would pull that
//     bind into module load / deploy analysis.
//   - This entry requires only queuesystem / big-assignment / participantmode
//     / participantmetadata — none of which require ATC.js at module load, and
//     whose own `getFirestore("firestore-atc")` calls are LAZY (inside handler
//     bodies we exercise against the ephemeral demo emulator only), so module
//     load is firestore-atc-free.
//
// Mirrors the golden `index.cicd.js` re-export set, verified against the new
// starlabs-cloud-function repo (all 16 exports present, 2026-06-17).
// Loaded by the emulator via firebase.emulator.json functions.source/codebase.
// ============================================================================

const queueSystem = require("./components/queuesystem");
const bigAssignmentSystem = require("./components/big-assignment");
const participantModeSystem = require("./components/participantmode");
const participantMetaDataSystem = require("./components/participantmetadata");

// --- queue system (11) ---
exports.onQueueStageChange = queueSystem.onQueueStageChange;                                   // w - "queue_token/{id}"
exports.biginvitationAccepted = queueSystem.biginvitationAccepted;                             // u - "biginvitation/{id}"
exports.studioZoomLink = queueSystem.studioZoomLink;                                           // c - "live assignment/{id}"
exports.studioZoomLinkDeactivate = queueSystem.studioZoomLinkDeactivate;                       // u - "live assignment/{id}"
exports.queueParticipantPositionUpdate = queueSystem.queueParticipantPositionUpdate;           // c - "queue stage log/{id}"
exports.particpantFormSubmit_SlackIntegration = queueSystem.particpantFormSubmit_SlackIntegration; // c - "formsByClient/{id}"
exports.inviteToStudio = queueSystem.inviteToStudio;                                           // c - "studioinvitation/{docid}"
exports.onQueueTokenCreateUpdateProductMode = queueSystem.onQueueTokenCreateUpdateProductMode; // c - "queue_token/{docid}"
exports.bulkReadyInvitation = queueSystem.bulkReadyInvitation;                                 // c - "bulk invitation/{docid}"
exports.invitationAccepted = queueSystem.invitationAccepted;                                   // u - "studioinvitation/{docid}"
exports.CreateQueueActivityLogV2 = queueSystem.CreateQueueActivityLogV2;                       // u - "live assignment/{docid}"

// --- big assignment (1) ---
exports.createBigParticipantAssignment = bigAssignmentSystem.createBigParticipantAssignment;   // c - "big assignment/{docid}"

// --- participant mode (1) ---
exports.calculateParticipantMode = participantModeSystem.calculateParticipantMode;             // w - "participantsproduct/{id}"

// --- participant metadata upstream triggers (3) ---
exports.profiledata_to_participantmetadata = participantMetaDataSystem.profiledata_to_participantmetadata; // w - profile_data
exports.journey_to_pmd = participantMetaDataSystem.journey_to_pmd;                             // w - "participantjourneyproduct/{docid}"
exports.productsdata_to_pmd = participantMetaDataSystem.productsdata_to_pmd;                   // w - "participantsproduct/{docid}"
