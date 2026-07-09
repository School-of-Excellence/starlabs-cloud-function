// ---------------------------------------------------------------------------
// Shared Slack alerting for the ATC generation pipeline.
//
// Every stage of the pipeline (queuesystem → queue_atc_generation → ATC →
// runpod_ai) routes its failure/visibility messages through alertAtc() so the
// pipeline breaks loudly in Slack instead of silently in logs.
//
// Resolution order for the webhook:
//   1. explicit `webhookUrl` arg (e.g. promptCfg.SLACK_WEBHOOK_URL)
//   2. ATC_PIPELINE_SLACK_WEBHOOK env var
//   3. DEFAULT_WEBHOOK below (slackDevTest — swap to a dedicated channel later)
//
// notifySlack() is the raw poster (used by runpod_ai.js for pod-create
// failures); alertAtc() is the higher-level "level + context" wrapper.
// ---------------------------------------------------------------------------
const { logger } = require("firebase-functions");

// slackDevTest from components/service.js — replace with a dedicated
// #atc-pipeline channel webhook when one exists.
const DEFAULT_WEBHOOK = "https://hooks.slack.com/services/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";

const EMOJI = {
  info: ":information_source:",
  warn: ":warning:",
  critical: ":rotating_light:",
};

function resolveWebhook(webhookUrl) {
  return webhookUrl || process.env.ATC_PIPELINE_SLACK_WEBHOOK || DEFAULT_WEBHOOK;
}

// When ATC_ALERTS_SILENT is truthy, suppress the Slack POST (alerts still go to
// Cloud Logging via alertAtc's logger.* mirror). Used by offline backfills/replays
// so a one-off run can't flood the pipeline channel. Unset in the cloud => no-op.
function alertsSilenced() {
  return /^(1|true|yes|on)$/i.test(process.env.ATC_ALERTS_SILENT || "");
}

// Raw poster. `body` is `{text, attempts?}` or a string.
async function notifySlack(webhookUrl, body) {
  if (alertsSilenced()) return;
  const url = resolveWebhook(webhookUrl);
  if (!url) return;
  try {
    const base = typeof body === "string" ? { text: body } : body || {};
    const text = base.attempts
      ? `${base.text}\n\`\`\`${JSON.stringify(base.attempts, null, 2)}\`\`\``
      : base.text;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    logger.warn("atc_alerts notifySlack failed", { error: e.message });
  }
}

// High-level alert. level ∈ "info" | "warn" | "critical".
// `opts`: { webhookUrl?, stage?, extra? }
async function alertAtc(level, message, opts = {}) {
  const emoji = EMOJI[level] || EMOJI.warn;
  const stageTag = opts.stage ? `*[${opts.stage}]* ` : "";
  let text = `${emoji} ${stageTag}${message}`;
  if (opts.extra && Object.keys(opts.extra).length) {
    text += `\n\`\`\`${JSON.stringify(opts.extra, null, 2)}\`\`\``;
  }
  // Mirror to logs so alerts are also captured in Cloud Logging.
  (level === "critical" ? logger.error : logger.warn)(`ATC alert: ${message}`, opts.extra || {});
  await notifySlack(opts.webhookUrl, { text });
}

module.exports = { notifySlack, alertAtc, DEFAULT_WEBHOOK };
