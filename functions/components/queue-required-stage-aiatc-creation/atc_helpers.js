// atc_helpers.js — pure, side-effect-free helpers for the ATC pipeline.
// NO firebase/admin imports, NO module-level side effects. Safe to require in
// unit tests without a live Firebase.

// ---------- Extract assistant final JSON from raw output ----------
function extractAssistantFinalJson(raw) {
  if (typeof raw !== 'string') return raw;
  const marker = /assistantfinal/i;
  const m = raw.match(marker);
  const tail = m ? raw.slice(m.index + m[0].length) : raw;

  const start = tail.indexOf('{');
  if (start === -1) return raw;

  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < tail.length; i++) {
    const ch = tail[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const jsonStr = tail.slice(start, i + 1);
        try {
          return JSON.parse(jsonStr);
        } catch {
          return jsonStr;
        }
      }
    }
  }
  return raw;
}

// ---------- Validate the ATC output structure ----------
// The output contract (prompts/prompt_1_ai_atc_generator.md:252-311): Part 1 prose,
// then a `---JSON---` delimiter line, then ONE JSON object with the required
// top-level keys. A non-empty response can still be a BROKEN ATC — e.g. the
// reasoning model exhausts its context and stops before emitting the JSON block,
// or emits truncated/unparseable JSON. This detects that so the caller can reject
// it instead of shipping a blank-structure ATC.

const ATC_REQUIRED_KEYS = [
  "participant_type", "form_type", "adjustments", "ecological_review", "areas_needing_more_data",
];

// Parse the FIRST balanced {...} JSON object found in `text`. Respects string
// literals + escapes so braces inside strings don't miscount. Returns the parsed
// object, or null if none is found / it doesn't parse.
function parseBalancedObject(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

// Pull the ATC JSON object out of raw model output. Prefers the region after the
// `---JSON---` delimiter the current prompt asks for; falls back to the harmony/
// gpt-oss `assistantfinal` channel marker; finally tries the whole string.
function extractAtcJson(raw) {
  if (typeof raw !== "string" || !raw) return null;
  const delimIdx = raw.lastIndexOf("---JSON---");
  if (delimIdx !== -1) {
    const obj = parseBalancedObject(raw.slice(delimIdx + "---JSON---".length));
    if (obj) return obj;
  }
  const m = raw.match(/assistantfinal/i);
  if (m) {
    const obj = parseBalancedObject(raw.slice(m.index + m[0].length));
    if (obj) return obj;
  }
  return parseBalancedObject(raw);
}

// Structural validity of a completed ATC's raw output. Returns
// { ok, reason, parsed }. ok=false (with a human reason) means the output is
// present but does NOT contain a usable ATC structure — treat like a failed
// generation (requeue / send back to pending).
function validateAtcStructure(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "empty output", parsed: null };
  }
  const obj = extractAtcJson(raw);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, reason: "no parseable ATC JSON object", parsed: null };
  }
  const missing = ATC_REQUIRED_KEYS.filter((k) => !(k in obj));
  if (missing.length) {
    return { ok: false, reason: `missing keys: ${missing.join(", ")}`, parsed: obj };
  }
  if (!Array.isArray(obj.adjustments) || obj.adjustments.length === 0) {
    return { ok: false, reason: "adjustments empty or not an array", parsed: obj };
  }
  return { ok: true, reason: "", parsed: obj };
}

async function buildUpLifeAspirationReport(data, formname) {
  const formdata = [];
  data.forEach((item) => {
    const q = item.questions.trim();
    if (typeof item.answer === "string") {
      formdata.push(`${q}: ${item.answer.trim()}`);
    }
    if (Array.isArray(item.answer) && item.answer.length > 0) {
      formdata.push(`${q}: ${JSON.stringify(item.answer)}`);
    }
  });
  return `What did the person come for in the ${formname}? : \n\n${JSON.stringify(formdata)}`;
}

// Pure array logic extracted from resolvePreviousStage.
function pickPreviousStage(stages, currentStage) {
  const idx = stages.findIndex((s) => s === currentStage);
  if (idx <= 0) return null;
  return stages[idx - 1];
}

// Has the token moved PAST `stage` in its active stage list?
//
// A currentstage that is not on the list at all counts as CROSSED, not "before":
// token variations legitimately drop trailing stages (Transfered / Completed), so
// an indexOf-only test reports terminal participants as not-yet-crossed. Mirrors the
// V2 ops screen's isCrossed so the "did they cross" question has ONE definition.
function hasCrossedStage(stages, currentStage, stage) {
  const target = stages.indexOf(stage);
  if (target < 0) return false;              // stage isn't on this flow → nothing to cross
  const at = stages.indexOf(currentStage);
  if (at < 0) return true;                   // off-list currentstage → terminal → crossed
  return at > target;
}

// The reconciliation set: every generateatc stage the token has already crossed.
//
// The old trigger created a gen doc for exactly ONE transition — the move from a
// generateatc stage to the stage immediately after it (pickPreviousStage). A stage
// skip, a variation reorder, a form submitted after the move, or a crossing that
// predates the pipeline all slipped through permanently, with no retry. This returns
// EVERY crossed generateatc stage instead, so the caller can ensure a doc exists for
// each (processStage is idempotent — it no-ops when the doc is already there). Every
// later token write becomes a self-healing retry.
function crossedGenerateStages(queueData, currentStage, activeStages) {
  const stages = Array.isArray(activeStages) && activeStages.length
    ? activeStages : (queueData && queueData.stages) || [];
  return ((queueData && queueData.atcrequiredstages) || [])
    .filter((s) => s && s.generateatc === true && s.stage &&
                   hasCrossedStage(stages, currentStage, s.stage))
    .map((s) => s.stage);
}

// Pure batching decision extracted from atcPodScheduler.
function shouldStartPod({ pendingCount, oldestAgeMin, minJobs, flushWaitMinutes }) {
  if (pendingCount === 0) return false;
  return (pendingCount >= minJobs) || (oldestAgeMin >= flushWaitMinutes);
}

module.exports = {
  extractAssistantFinalJson, buildUpLifeAspirationReport, pickPreviousStage, shouldStartPod,
  extractAtcJson, validateAtcStructure, ATC_REQUIRED_KEYS,
  hasCrossedStage, crossedGenerateStages,
};
