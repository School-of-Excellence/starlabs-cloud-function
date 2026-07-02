// zoom_transcript_capture.js — standalone, additive integration that captures
// Zoom transcripts proactively, instead of racing the async transcript-
// availability timing synchronously at stage-crossing time
// (components/queuesystem.js processStage's zoom branch).
//
// This file makes ZERO changes to any existing function. It reacts to
// `zoom activitylog/{id}` document CREATES — a collection every Zoom webhook
// event already gets unconditionally logged into by the existing
// `zoomActivitylog` onRequest function (queuesystem.js:2466-2469,
// `admin.firestore().collection("zoom activitylog").add({timestamp, payload})`),
// before any event-type branching happens there. `zoomActivitylog` itself is
// untouched — this is a second, independent reader of a write it already makes.
//
// The webhook's top-level `event` type string (e.g. "recording.completed") is
// NOT persisted onto the logged doc — only `payload` is. So a recording-
// completed event is identified by the presence of `payload.object.recording_files`
// (a field unique to that event type; meeting.created/meeting.ended payloads
// don't carry it).
//
// Real captured `recording.completed` payloads for this account never include
// a TRANSCRIPT file (checked empirically — 0/3000 real logs), so the actual
// fetch is deferred to a Cloud Tasks task: first attempt 15 minutes after
// recording.completed, retried up to 3 total attempts with a fixed 15-minute
// gap (retryConfig below), then Cloud Tasks gives up. Firebase's v2 Tasks
// integration provisions/updates the underlying Cloud Tasks queue automatically
// on deploy — no manual `gcloud tasks queues create` step, no new dependency.
"use strict";

const admin = require("firebase-admin");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onTaskDispatched } = require("firebase-functions/v2/tasks");
const { getFunctions } = require("firebase-admin/functions");
const { defineSecret } = require("firebase-functions/params");

const zoomAccountId = defineSecret("ZOOM_ACCOUNTID");
const zoomClientId = defineSecret("ZOOM_CLIENTID");
const zoomClientSecret = defineSecret("ZOOM_CLIENTSECRET");

const INITIAL_DELAY_SECONDS = 15 * 60; // first attempt 15 min after recording.completed
const RETRY_GAP_SECONDS = 15 * 60; // fixed gap between retries (not exponential)
const MAX_ATTEMPTS = 3; // total attempts, including the first
const TASK_QUEUE_FUNCTION = "checkZoomTranscript";

// ---------- duplicated from components/queuesystem.js (getTranscript /
// convertVttToLLM, queuesystem.js:3667-3719) rather than imported, so this
// integration never requires touching that file. scripts/atc-queue-report.js
// already establishes this same copy-don't-import precedent for the same reason. ----------
function convertVttToLLM(vttText) {
  const lines = vttText.trim().split("\n");
  const entries = [];
  let currentSpeaker = null;
  let currentText = "";
  for (let l of lines) {
    l = l.trim();
    if (!l || l === "WEBVTT" || /^\d+$/.test(l) || /^\d{2}:\d{2}:\d{2}/.test(l)) continue;
    const match = l.match(/^(.+?):\s+(.+)$/);
    if (match) {
      const speaker = match[1].trim();
      const text = match[2].trim();
      if (speaker === currentSpeaker) {
        currentText += " " + text;
      } else {
        if (currentSpeaker) entries.push(`${currentSpeaker}: ${currentText}`);
        currentSpeaker = speaker;
        currentText = text;
      }
    }
  }
  if (currentSpeaker) entries.push(`${currentSpeaker}: ${currentText}`);
  return entries.join("\n");
}

async function getTranscript(meetingId) {
  if (!meetingId) throw new Error("meetingId is required");
  const accountId = zoomAccountId.value();
  const clientId = zoomClientId.value();
  const clientSecret = zoomClientSecret.value();

  const tokenResponse = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}&client_id=${clientId}&client_secret=${clientSecret}`,
    { method: "POST" }
  );
  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) throw new Error("Failed to get Zoom access token");

  const accessToken = tokenData.access_token;
  const recordingResponse = await fetch(
    `https://api.zoom.us/v2/meetings/${meetingId}/recordings`,
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
  if (!recordingResponse.ok) {
    const err = await recordingResponse.json().catch(() => ({}));
    throw new Error(err.message || "Recording not found");
  }
  const recordingData = await recordingResponse.json();
  const transcriptFile = recordingData.recording_files?.find((f) => f.file_type === "TRANSCRIPT");
  if (!transcriptFile) throw new Error("No transcript found. Enable Audio Transcript in Zoom settings.");

  const transcriptResponse = await fetch(`${transcriptFile.download_url}?access_token=${accessToken}`);
  if (!transcriptResponse.ok) throw new Error("Failed to download transcript file");
  const vttContent = await transcriptResponse.text();

  return {
    meetingId,
    topic: recordingData.topic,
    start_time: recordingData.start_time,
    duration: recordingData.duration,
    transcript_raw: vttContent,
    transcript_text: convertVttToLLM(vttContent),
    download_url: transcriptFile.download_url,
  };
}

// ---------- Plain processors (exposed for integration tests, same convention
// as components/queuesystem.js exports.processStage / exports.resolvePreviousStage) ----------

// `enqueue` is injectable so tests can assert on call args without needing a
// real Cloud Tasks queue (the Firestore emulator suite has no Tasks emulator).
async function handleActivityLogCreate(logData, { enqueue } = {}) {
  const payload = logData && logData.payload;
  const recordingFiles = payload && payload.object && payload.object.recording_files;
  if (!Array.isArray(recordingFiles) || recordingFiles.length === 0) {
    return; // not a recording.completed payload — nothing to do
  }

  const meetingId = payload.object.id;
  if (!meetingId) return console.log("enqueueZoomTranscriptFetch: recording payload missing meeting id");

  // zoomdata.id is written at meeting-booking time (studioZoomLink,
  // queuesystem.js:1017-1022), long before recording.completed fires, so
  // it's always available here — same lookup zoomActivitylog itself uses
  // (queuesystem.js:2546).
  const liveAssignmentSnap = await admin.firestore().collection("live assignment")
    .where("zoomdata.id", "==", meetingId).get();
  if (liveAssignmentSnap.empty) {
    return console.log(`enqueueZoomTranscriptFetch: no live assignment for meeting ${meetingId}`);
  }
  const liveAssignmentDoc = liveAssignmentSnap.docs[0];
  if (liveAssignmentDoc.data().transcript_text) {
    return console.log(`enqueueZoomTranscriptFetch: transcript already captured for ${liveAssignmentDoc.id}`);
  }

  const doEnqueue = enqueue || ((data, opts) => getFunctions().taskQueue(TASK_QUEUE_FUNCTION).enqueue(data, opts));
  try {
    await doEnqueue(
      { meetingId, liveAssignmentId: liveAssignmentDoc.id },
      {
        scheduleDelaySeconds: INITIAL_DELAY_SECONDS,
        // Explicit id de-dupes against a resent recording.completed webhook
        // for the same live assignment while a task for it is already queued.
        id: `zoom-transcript-${liveAssignmentDoc.id}`,
      }
    );
    console.log(`enqueueZoomTranscriptFetch: queued transcript fetch for live assignment ${liveAssignmentDoc.id} (meeting ${meetingId}), first attempt in ${INITIAL_DELAY_SECONDS / 60}min`);
  } catch (err) {
    if (err && err.code === "functions/task-already-exists") {
      return console.log(`enqueueZoomTranscriptFetch: task already queued for ${liveAssignmentDoc.id}`);
    }
    console.error(`enqueueZoomTranscriptFetch: failed to enqueue for meeting ${meetingId}: ${err.message}`);
  }
}

// `request` is the onTaskDispatched Request<T> (TaskContext & {data}) — real
// dispatches carry `retryCount` (0 on the first attempt) via the
// X-CloudTasks-TaskRetryCount header; tests pass a plain {data, retryCount} object.
async function handleTranscriptCheck(request) {
  const { meetingId, liveAssignmentId } = (request && request.data) || {};
  const attemptNumber = (request && request.retryCount || 0) + 1;
  const isFinalAttempt = attemptNumber >= MAX_ATTEMPTS;

  if (!meetingId || !liveAssignmentId) {
    return console.log("checkZoomTranscript: task payload missing meetingId/liveAssignmentId");
  }

  const liveAssignmentRef = admin.firestore().collection("live assignment").doc(liveAssignmentId);
  const liveAssignmentSnap = await liveAssignmentRef.get();
  if (!liveAssignmentSnap.exists) {
    return console.log(`checkZoomTranscript: live assignment ${liveAssignmentId} no longer exists`);
  }
  if (liveAssignmentSnap.data().transcript_text) {
    return console.log(`checkZoomTranscript: transcript already captured for ${liveAssignmentId}`);
  }

  try {
    const result = await getTranscript(meetingId);
    if (!result || !result.transcript_text || !result.transcript_text.trim()) {
      throw new Error(`empty transcript for meeting ${meetingId}`);
    }
    // Same field names queuesystem.js processStage stores on a
    // queue_atc_generation doc for a zoom source (queuesystem.js:3615-3621):
    // transcript_text, transcript_raw, zoom_topic, zoom_start_time, zoom_duration.
    await liveAssignmentRef.update({
      transcript_text: result.transcript_text,
      transcript_raw: result.transcript_raw,
      zoom_topic: result.topic,
      zoom_start_time: result.start_time,
      zoom_duration: result.duration,
      transcriptCapturedAt: admin.firestore.FieldValue.serverTimestamp(),
      transcriptCaptureStatus: "captured",
      transcriptCaptureAttempt: attemptNumber,
    });
    console.log(`checkZoomTranscript: captured transcript for live assignment ${liveAssignmentId} (meeting ${meetingId}) on attempt ${attemptNumber}/${MAX_ATTEMPTS}`);
  } catch (err) {
    console.error(`checkZoomTranscript: attempt ${attemptNumber}/${MAX_ATTEMPTS} failed for meeting ${meetingId}: ${err.message}`);
    if (isFinalAttempt) {
      // No further Cloud Tasks retry happens after this — flag the live
      // assignment doc so the miss is visible/queryable instead of the task
      // silently vanishing from the queue once attempts are exhausted.
      await liveAssignmentRef.set({
        transcriptCaptureStatus: "failed",
        transcriptCaptureAttempt: attemptNumber,
        transcriptCaptureFailedAt: admin.firestore.FieldValue.serverTimestamp(),
        transcriptCaptureLastError: err.message,
      }, { merge: true });
    }
    // Re-throw so Cloud Tasks/Cloud Logging records this attempt as a
    // failure (and, when not final, actually retries per retryConfig).
    throw err;
  }
}

// ---------- Cloud Function 1: detect recording.completed, enqueue a delayed task ----------
exports.enqueueZoomTranscriptFetch = onDocumentCreated(
  { document: "zoom activitylog/{id}" },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    await handleActivityLogCreate(snap.data());
  }
);

// ---------- Cloud Function 2: the delayed/retried fetch itself ----------
exports.checkZoomTranscript = onTaskDispatched(
  {
    secrets: [zoomAccountId, zoomClientId, zoomClientSecret],
    retryConfig: {
      maxAttempts: MAX_ATTEMPTS,
      minBackoffSeconds: RETRY_GAP_SECONDS,
      maxBackoffSeconds: RETRY_GAP_SECONDS,
      maxDoublings: 0, // fixed 15-min gap, not exponential
    },
    rateLimits: { maxConcurrentDispatches: 6 },
  },
  (request) => handleTranscriptCheck(request)
);

// Exposed for integration tests (not deployed functions) — same convention as
// components/queuesystem.js exports.processStage.
exports.handleActivityLogCreate = handleActivityLogCreate;
exports.handleTranscriptCheck = handleTranscriptCheck;
exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
