/**
 * Shared harness for the option-(a) emulator integration tests.
 *
 * These tests drive ONE inner pipeline function at a time against the local
 * Firestore emulator (three named databases: default, firestore-atc,
 * firestore-forms). They never touch production — `firebase emulators:exec`
 * sets FIRESTORE_EMULATOR_HOST, which redirects every admin-SDK Firestore call
 * to the throwaway sandbox.
 *
 * Order matters: components/service.js calls admin.initializeApp() at module
 * load, and ATC.js / queue_atc_generation.js capture getFirestore() handles at
 * load — so the project env + service.js must be set up BEFORE any component is
 * required. Test files require this helper first (it does that), then require
 * the component under test.
 */
"use strict";

const PROJECT = process.env.GCLOUD_PROJECT || "fir-sample-aae4a";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set. Run via `npm run test:integration` " +
      "(it wraps jest in `firebase emulators:exec --only firestore`)."
  );
}

// Make sure the admin SDK resolves a project id without ADC.
process.env.GCLOUD_PROJECT = PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT;

// Initialize the app the same way production does (service.js is the first
// require in index.js). This calls admin.initializeApp() exactly once.
require("../../components/service");

const { getFirestore } = require("firebase-admin/firestore");

const defaultDb = getFirestore();
const atcDb = getFirestore("firestore-atc");
const formsDb = getFirestore("firestore-forms");

const HOST = process.env.FIRESTORE_EMULATOR_HOST;

// Wipe every document in one emulator database via its REST clear endpoint.
async function clearDatabase(databaseId) {
  const url = `http://${HOST}/emulator/v1/projects/${PROJECT}/databases/${encodeURIComponent(
    databaseId
  )}/documents`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`clear ${databaseId} failed: ${res.status} ${await res.text()}`);
  }
}

// Clear all three databases. Call in beforeEach so each test starts clean.
async function clearAll() {
  await Promise.all([
    clearDatabase("(default)"),
    clearDatabase("firestore-atc"),
    clearDatabase("firestore-forms"),
  ]);
}

// Standard atc_alerts mock factory — captures alertAtc/notifySlack instead of
// POSTing to the hardcoded Slack webhook. Used via jest.mock in each test file.
function atcAlertsMock() {
  return {
    alertAtc: jest.fn(async () => {}),
    notifySlack: jest.fn(async () => {}),
    DEFAULT_WEBHOOK: "mock-webhook",
  };
}

module.exports = {
  PROJECT,
  defaultDb,
  atcDb,
  formsDb,
  clearAll,
  clearDatabase,
  atcAlertsMock,
};
