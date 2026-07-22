/**
 * Scope-Enhancement live transcription pipeline.
 *
 * Two functions:
 *
 * 1. seLiveTranscribeSubmit  — Firestore trigger on "live assignment/{id}"
 *    Fires when the doc's `dropboxlink` is set or CHANGED to a new value — i.e.
 *    the manual (re)generation path: paste/replace the Dropbox audio URL and a
 *    fresh WhisperX transcript is produced and written back over any existing
 *    one. Submits a job to the RunPod serverless WhisperX endpoint and stores
 *    the returned jobId on the doc so the callback can route the result back.
 *
 *    Keying on the dropboxlink *changing* (not on a status flag) is deliberate:
 *    none of this pipeline's own write-backs (queued / processing / captured /
 *    failed) touch `dropboxlink`, so they never re-trigger a submission — this
 *    is what prevents both a resubmit loop and the duplicate-submission race
 *    from the intermediate "queued" write.
 *
 * 2. seLiveTranscribeCallback — HTTP webhook receiver
 *    RunPod calls this URL when the transcription job completes.
 *    Writes transcript_text / transcript_raw onto the live assignment doc.
 *
 * Required secrets:
 *   RUNPOD_API_KEY — RunPod API key
 *
 * Callback URL (no secret): resolved by resolveCallbackUrl() from
 *   classify/se_transcribe { callbackurl }  — optional override
 *   else derived            https://us-central1-<project>.cloudfunctions.net/seLiveTranscribeCallback
 */

const admin = require("firebase-admin");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const runpodApiKey = defineSecret("RUNPOD_API_KEY");

const ENDPOINT_ID = "5bghabyldgu2tj";
const RUNPOD_RUN_URL = `https://api.runpod.ai/v2/${ENDPOINT_ID}/run`;

// ── callback URL ──────────────────────────────────────────────────────────────
// Where RunPod POSTs the finished job. This used to be the SE_TRANSCRIBE_CALLBACK_URL
// secret; that secret was removed in c4013e5 ("Move Slack webhooks to Firestore,
// remove hardcoded URLs") which left this whole function commented out and
// unbuildable. It is now resolved the same way as the other runtime config in this
// codebase — an optional Firestore override with a derived default:
//
//   classify/se_transcribe { callbackurl: "https://..." }   ← optional override
//   otherwise              https://us-central1-<project>.cloudfunctions.net/seLiveTranscribeCallback
//
// The derived default is the address of THIS project's own seLiveTranscribeCallback,
// so no environment needs configuring for the pipeline to work.
const CALLBACK_CONFIG_DOCID = "se_transcribe";

// .trim() is load-bearing and applied to BOTH sources: a trailing newline makes
// RunPod's webhook POST silently fail (malformed URL) and the transcript never comes
// back. That was the root cause fixed in 932d23f — do not remove it.
async function resolveCallbackUrl() {
  try {
    const snap = await admin.firestore().collection("classify").doc(CALLBACK_CONFIG_DOCID).get();
    const configured = snap.exists ? (snap.data() || {}).callbackurl : null;
    if (configured && String(configured).trim()) return String(configured).trim();
  } catch (err) {
    console.warn(`resolveCallbackUrl: classify/${CALLBACK_CONFIG_DOCID} read failed, using derived URL:`, err.message);
  }
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error("cannot derive callback URL: no GCLOUD_PROJECT in env");
  return `https://us-central1-${project}.cloudfunctions.net/seLiveTranscribeCallback`.trim();
}
exports.resolveCallbackUrl = resolveCallbackUrl;

// ── trigger gate ──────────────────────────────────────────────────────────────
// Pure decision: submit a transcription job iff `dropboxlink` is present AND just
// changed. Exported for unit testing — this is the guard that prevents the
// resubmit loop and duplicate-submission race (the pipeline's own write-backs
// never change dropboxlink, so they never pass this gate).
function shouldSubmitTranscription(before, after) {
  const linkNow    = ((after && after.dropboxlink)  || "").trim();
  const linkBefore = ((before && before.dropboxlink) || "").trim();
  return !!linkNow && linkNow !== linkBefore;
}
exports.shouldSubmitTranscription = shouldSubmitTranscription;

// ── transcript formatters ─────────────────────────────────────────────────────

function fmtTs(sec) {
  if (!sec) sec = 0;
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mss = ms % 1000;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(mss).padStart(3,"0")}`;
}

// Facilitator phrasings the COACH uses vs self-introduction phrasings the
// PARTICIPANT uses — used to decide which diarized speaker is the coach when the
// name-address signal alone is weak. Deliberately generic to coaching sessions.
const COACH_CUES = [
  /helping you/i, /scope enhancement/i, /tell me (something |a little )?about yourself/i,
  /can you hear me/i, /how are you (doing|today)/i, /\bget started\b/i, /before we (get|begin|start)/i,
  /let me explain/i, /shall we (start|begin)/i, /are you ready/i, /walk me through/i, /what do you do/i,
  /my role/i, /i('| wi)ll be (helping|facilitating|guiding)/i,
];
const PARTICIPANT_CUES = [
  /my name is/i, /i am (a|an|the) /i, /i'?m (a|an|the) /i, /i'?ve been/i, /i have been/i,
  /years of experience/i, /i work (with|in|as|for)/i, /about myself/i, /my age/i,
];

// Decide the diarized speaker→role mapping. The coach is the speaker who (a) most
// addresses the participant by name and (b) uses facilitator phrasing, minus any
// self-introduction phrasing (a strong participant tell). Only when nothing
// discriminates do we fall back to "the first (greeting) speaker is the coach".
// `confidence` reports how that decision was reached so downstream (ATC) can weigh
// it: high/medium = signal-driven, low = fallback, single/no-speakers = degenerate.
function assignSpeakers(segs, profileName) {
  const speakers = [...new Set(segs.map(s => s.speaker).filter(Boolean))].sort();
  if (!speakers.length) return { mapping: {}, coachName: "Coach", confidence: "no-speakers" };

  const profileFirst = profileName ? profileName.trim().split(/\s+/)[0] : "";
  // Match a prefix of the participant's first name — WhisperX often mis-spells
  // names ("Sangeetha" → "Sangeeta"/"Sagitta"), so an exact \bword\b match misses.
  const stem = profileFirst.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, Math.max(4, profileFirst.length - 2));
  const nameRe = stem.length >= 3 ? new RegExp(`\\b${stem}`, "i") : null;

  const stat = Object.fromEntries(speakers.map((sp) => [sp, { name: 0, coach: 0, part: 0 }]));
  for (const s of segs) {
    const sp = s.speaker; if (!sp || !stat[sp]) continue;
    const t = s.text || "";
    if (nameRe && nameRe.test(t)) stat[sp].name++;
    for (const re of COACH_CUES) if (re.test(t)) stat[sp].coach++;
    for (const re of PARTICIPANT_CUES) if (re.test(t)) stat[sp].part++;
  }
  const firstSp = segs.find((s) => s.speaker)?.speaker || speakers[0];

  if (speakers.length === 1) {
    // One diarized speaker — can't split coach vs participant; label as participant.
    return { mapping: { [speakers[0]]: profileName || speakers[0] }, coachName: "Coach", confidence: "single-speaker" };
  }

  const score = (sp) => stat[sp].name * 2 + stat[sp].coach * 2 - stat[sp].part * 2;
  const ranked = [...speakers].sort((a, b) => score(b) - score(a));
  const margin = score(ranked[0]) - score(ranked[1]);

  let coachSp, confidence;
  if (margin > 0) {
    coachSp = ranked[0];
    confidence = margin >= 3 ? "high" : "medium";
  } else {
    coachSp = firstSp;                       // greeting-first fallback
    confidence = "low(first-speaker fallback)";
  }

  const mapping = {};
  for (const sp of speakers) mapping[sp] = sp === coachSp ? "Coach" : (profileName || sp);
  return { mapping, coachName: "Coach", confidence };
}
exports.assignSpeakers = assignSpeakers;

function buildProse(segs, mapping) {
  const turns = [];
  for (const s of segs) {
    const t = (s.text || "").trim().replace(/\s+/g, " ");
    if (!t) continue;
    const sp = mapping[s.speaker] || s.speaker || "Unknown";
    if (turns.length && turns[turns.length - 1][0] === sp) {
      turns[turns.length - 1][1].push(t);
    } else {
      turns.push([sp, [t]]);
    }
  }
  return turns.map(([sp, txt]) => `${sp}: ${txt.join(" ")}`).join("\n") + "\n";
}

function buildVtt(segs, mapping) {
  const lines = ["WEBVTT", ""];
  let n = 0;
  for (const s of segs) {
    const t = (s.text || "").trim().replace(/\s+/g, " ");
    if (!t) continue;
    n++;
    const sp = mapping[s.speaker] || s.speaker || "Unknown";
    lines.push(String(n), `${fmtTs(s.start)} --> ${fmtTs(s.end)}`, `${sp}: ${t}`, "");
  }
  return lines.join("\n");
}

function fillSpeakers(segs) {
  let last = null;
  for (const s of segs) {
    if (s.speaker) last = s.speaker;
    else if (last) s.speaker = last;
  }
  const first = segs.find(s => s.speaker)?.speaker || "SPEAKER_00";
  for (const s of segs) { if (!s.speaker) s.speaker = first; }
  return segs;
}

function formatOutput(rawOutput, profileName) {
  const segs = fillSpeakers(rawOutput.segments || []);
  const { mapping, coachName, confidence } = assignSpeakers(segs, profileName);
  return {
    transcript_text: buildProse(segs, mapping),
    transcript_raw:  buildVtt(segs, mapping),
    coach:           coachName,
    confidence,
    audio_sec:       rawOutput.duration ? Math.round(rawOutput.duration) : null,
  };
}

// ── 1. Submit ─────────────────────────────────────────────────────────────────
exports.seLiveTranscribeSubmit = onDocumentWritten(
  { document: "live assignment/{id}", secrets: [runpodApiKey] },
  async (event) => {
    // Doc deleted — nothing to do.
    if (!event.data.after.exists) return null;

    const before = event.data.before.data() || {};
    const after  = event.data.after.data()  || {};

    // Only act when the dropbox URL is present AND just changed. Because none of
    // this pipeline's own write-backs alter `dropboxlink`, the queued/processing/
    // captured/failed writes all fall out here (link unchanged) — no loop, no
    // duplicate-submission race.
    if (!shouldSubmitTranscription(before, after)) return null;

    const docId      = event.params.id;
    const profileId  = after.participantid || after.profile_id || null;
    const profileName = after.profile_name || "";
    const videoUrl   = after.dropboxlink.trim();

    const db = admin.firestore();

    // Mark as queued immediately. This write does not change dropboxlink, so it
    // will not re-trigger this function. Clear any prior error from a past run.
    await db.collection("live assignment").doc(docId).set(
      {
        transcriptCaptureStatus: "queued",
        transcriptQueuedAt: admin.firestore.FieldValue.serverTimestamp(),
        transcriptCaptureLastError: admin.firestore.FieldValue.delete(),
      },
      { merge: true }
    );

    try {
      const body = {
        input: { audio_url: videoUrl, profileid: profileId, profile_name: profileName },
        webhook: await resolveCallbackUrl(),
      };

      const resp = await fetch(RUNPOD_RUN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${runpodApiKey.value()}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`RunPod ${resp.status}: ${text.slice(0, 300)}`);
      }

      const data = await resp.json();
      const jobId = data.id;
      if (!jobId) throw new Error(`RunPod response missing job id: ${JSON.stringify(data).slice(0, 300)}`);

      await db.collection("live assignment").doc(docId).set(
        { runpodJobId: jobId, transcriptCaptureStatus: "processing" },
        { merge: true }
      );

      console.log(`seLiveTranscribeSubmit: submitted job ${jobId} for doc ${docId} (${profileId})`);
    } catch (err) {
      console.error(`seLiveTranscribeSubmit: failed for doc ${docId}:`, err.message);
      await db.collection("live assignment").doc(docId).set(
        {
          transcriptCaptureStatus: "failed",
          transcriptCaptureLastError: String(err.message),
          transcriptCaptureFailedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    return null;
  }
);

// ── 2. Callback ───────────────────────────────────────────────────────────────
exports.seLiveTranscribeCallback = onRequest(
  { memory: "256MiB", timeoutSeconds: 60, cors: false },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("POST only");

    const payload = req.body || {};
    const jobId = payload.id;
    const status = payload.status;

    if (!jobId) return res.status(400).json({ error: "missing id" });

    // RunPod sends IN_PROGRESS pings too — only act on terminal states
    if (status !== "COMPLETED" && status !== "FAILED") {
      return res.status(200).json({ ok: true, note: "non-terminal status ignored" });
    }

    const db = admin.firestore();

    // Find the live assignment doc that owns this job
    const snap = await db
      .collection("live assignment")
      .where("runpodJobId", "==", jobId)
      .limit(1)
      .get();

    if (snap.empty) {
      console.warn(`seLiveTranscribeCallback: no doc found for jobId ${jobId}`);
      return res.status(200).json({ ok: true, note: "no matching doc" });
    }

    const docRef = snap.docs[0].ref;

    if (status === "FAILED") {
      const errMsg = payload.error || "RunPod job failed";
      await docRef.set(
        {
          transcriptCaptureStatus: "failed",
          transcriptCaptureLastError: String(errMsg).slice(0, 500),
          transcriptCaptureFailedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      console.error(`seLiveTranscribeCallback: job ${jobId} FAILED — ${errMsg}`);
      return res.status(200).json({ ok: true });
    }

    // COMPLETED — format raw WhisperX segments into prose + VTT
    const rawOutput = payload.output || {};
    if (!rawOutput.segments || !rawOutput.segments.length) {
      await docRef.set(
        {
          transcriptCaptureStatus: "failed",
          transcriptCaptureLastError: "RunPod returned no segments",
          transcriptCaptureFailedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      console.error(`seLiveTranscribeCallback: job ${jobId} returned no segments`);
      return res.status(200).json({ ok: true });
    }

    // read profile_name from the doc so speaker assignment is accurate
    const docSnap = await docRef.get();
    const profileName = docSnap.data()?.profile_name || "";
    const { transcript_text, transcript_raw, coach, confidence, audio_sec } =
      formatOutput(rawOutput, profileName);

    await docRef.set(
      {
        transcript_text,
        transcript_raw,
        transcriptCapturedAt:    admin.firestore.FieldValue.serverTimestamp(),
        transcriptCaptureStatus: "captured",
        coach,
        confidence,
        audio_sec,
        runpodJobId: admin.firestore.FieldValue.delete(),
      },
      { merge: true }
    );

    console.log(`seLiveTranscribeCallback: captured transcript for job ${jobId} → doc ${snap.docs[0].id}`);
    return res.status(200).json({ ok: true });
  }
);
