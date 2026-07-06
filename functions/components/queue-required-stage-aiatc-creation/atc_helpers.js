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

// Pure batching decision extracted from atcPodScheduler.
function shouldStartPod({ pendingCount, oldestAgeMin, minJobs, flushWaitMinutes }) {
  if (pendingCount === 0) return false;
  return (pendingCount >= minJobs) || (oldestAgeMin >= flushWaitMinutes);
}

module.exports = { extractAssistantFinalJson, buildUpLifeAspirationReport, pickPreviousStage, shouldStartPod };
