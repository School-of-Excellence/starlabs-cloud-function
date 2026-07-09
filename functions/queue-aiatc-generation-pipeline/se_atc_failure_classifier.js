/**
 * se_atc_failure_classifier.js — queue-aiatc-generation-pipeline (usage dashboard)
 *
 * Pure, dependency-free classifier that maps the freeform failure signals already
 * present on a terminal ATC job (the `reason` passed to requeueJob, the model's
 * `finishReason`, the raw `error` string, and whether the output was empty) into a
 * SMALL fixed set of categories. The freeform `error` string stays on the job doc
 * for per-record drill-down; this category is what the usage rollup tallies so the
 * dashboard can chart *why* reports fail.
 *
 * Imported by components/pod-execution-pipeline/pod_jobs.js at the terminal-state writes.
 *
 * Categories (keep this list in sync with the dashboard legend):
 *   infer_timeout    — inference exceeded the timeout
 *   infer_error      — inference call failed (network / pod /infer error)
 *   empty_output     — call "succeeded" but produced no usable output
 *   bad_json         — output present but not parseable as the expected JSON
 *   pod_unavailable  — no pod / pod create or availability failure
 *   max_attempts     — gave up after the attempts cap (root cause not otherwise known)
 *   unknown          — none of the above matched
 */
"use strict";

const CATEGORIES = Object.freeze({
  INFER_TIMEOUT: "infer_timeout",
  INFER_ERROR: "infer_error",
  EMPTY_OUTPUT: "empty_output",
  BAD_JSON: "bad_json",
  POD_UNAVAILABLE: "pod_unavailable",
  MAX_ATTEMPTS: "max_attempts",
  UNKNOWN: "unknown",
});

/**
 * Classify a terminal failure. All inputs optional; matching is order-sensitive
 * (most specific signal first) and case-insensitive on the text signals.
 *
 * @param {object} sig
 * @param {string} [sig.reason]        requeue/termination reason (e.g. "infer error: timeout", "stuck processing")
 * @param {string} [sig.finishReason]  model finish reason (e.g. "stop", "max_tokens", "error")
 * @param {string} [sig.error]         raw error message stored on the doc
 * @param {boolean} [sig.emptyOutput]  true when the output was missing/blank
 * @returns {string} one of CATEGORIES.*
 */
function classifyFailure(sig = {}) {
  const reason = String(sig.reason || "").toLowerCase();
  const error = String(sig.error || "").toLowerCase();
  const finishReason = String(sig.finishReason || "").toLowerCase();
  const text = `${reason} ${error}`;

  // 1) Timeout — most specific, can hide inside a generic "infer error".
  if (/(timeout|timed out|deadline|etimedout|abort)/.test(text)) {
    return CATEGORIES.INFER_TIMEOUT;
  }

  // 2) Pod / availability problems.
  if (/(no pod|pod unavailable|pod create|no podid|pod not ready|unhealthy|halted)/.test(text)) {
    return CATEGORIES.POD_UNAVAILABLE;
  }

  // 3) Bad / unparseable output.
  if (/(bad json|invalid json|json parse|parse error|unparse|malformed)/.test(text)) {
    return CATEGORIES.BAD_JSON;
  }

  // 4) Empty output — explicit flag wins; also catch the textual hint.
  if (sig.emptyOutput === true || /(empty output|no output|blank output)/.test(text)) {
    return CATEGORIES.EMPTY_OUTPUT;
  }

  // 5) Inference call errors (network/pod /infer) once timeouts are ruled out.
  if (/(infer error|inference|http|fetch|network|econnrefused|enotfound|5\d\d)/.test(text)) {
    return CATEGORIES.INFER_ERROR;
  }
  // finishReason signalling a hard error (and not a clean stop).
  if (finishReason && finishReason !== "stop" && finishReason === "error") {
    return CATEGORIES.INFER_ERROR;
  }

  // 6) Hit the attempts cap with no more specific signal.
  if (/(attempts=|max attempt|attempts cap|requeue)/.test(text)) {
    return CATEGORIES.MAX_ATTEMPTS;
  }

  return CATEGORIES.UNKNOWN;
}

module.exports = { classifyFailure, CATEGORIES };
