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
 *   RUNPOD_API_KEY          — RunPod API key
 *   SE_TRANSCRIBE_CALLBACK_URL — full HTTPS URL of this project's
 *                                seLiveTranscribeCallback function
 *                                e.g. https://us-central1-fir-sample-aae4a.cloudfunctions.net/seLiveTranscribeCallback
 */

const admin = require("firebase-admin");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const runpodApiKey = defineSecret("RUNPOD_API_KEY");
const callbackUrl  = defineSecret("SE_TRANSCRIBE_CALLBACK_URL");

const ENDPOINT_ID = "5bghabyldgu2tj";
const RUNPOD_RUN_URL = `https://api.runpod.ai/v2/${ENDPOINT_ID}/run`;

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

function assignSpeakers(segs, profileName) {
  const profileFirst = profileName ? profileName.split(" ")[0] : "";
  const speakers = [...new Set(segs.map(s => s.speaker).filter(Boolean))].sort();
  if (!speakers.length) return { mapping: {}, coachName: "Coach", confidence: "no-speakers" };

  const mentions = Object.fromEntries(speakers.map(sp => [sp, 0]));
  if (profileFirst) {
    const pat = new RegExp(`\\b${profileFirst.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    for (const s of segs) {
      if (s.speaker && pat.test(s.text || "")) mentions[s.speaker]++;
    }
  }

  let coachSp;
  const hasMentions = Object.values(mentions).some(v => v > 0);
  if (hasMentions) {
    coachSp = speakers.reduce((a, b) => mentions[a] >= mentions[b] ? a : b);
  } else {
    coachSp = segs[0]?.speaker || speakers[0];
  }

  const mapping = {};
  for (const sp of speakers) {
    mapping[sp] = sp === coachSp ? "Coach" : (profileName || sp);
  }
  return { mapping, coachName: "Coach", confidence: hasMentions ? "high" : "low(first-speaker fallback)" };
}

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
  { document: "live assignment/{id}", secrets: [runpodApiKey, callbackUrl] },
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
        // .trim() is load-bearing: a trailing newline in the secret makes RunPod's
        // webhook POST silently fail (malformed URL) → the transcript never comes back.
        webhook: callbackUrl.value().trim(),
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
