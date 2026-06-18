// Jest config for the emulator-backed integration suite (option-a, per-handler).
// Run via `npm run test:integration`, which wraps this in
// `firebase emulators:exec --only firestore` so FIRESTORE_EMULATOR_HOST is set.
module.exports = {
  testMatch: ["**/test/integration/**/*.test.js"],
  testTimeout: 30000,
  // Tests share one emulator instance and clear it between cases, so they must
  // not run in parallel. (npm script also passes --runInBand.)
  maxWorkers: 1,
};
