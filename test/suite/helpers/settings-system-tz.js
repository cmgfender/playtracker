// Imported FIRST by test/suite/settings-system.test.js.
// Pins the process time zone (scheduled sync times and daily buckets are local time, see README
// "TZ") and clears environment switches that would change app behaviour, so the suite is
// deterministic wherever it runs.
process.env.TZ = 'America/New_York';
for (const k of [
  'PLAYTRACKER_CORS_ORIGIN', 'PLAYTRACKER_SECURE_COOKIE', 'PLAYTRACKER_PASSWORD', 'PLAYTRACKER_LOG_FILE',
  'LOG_REQUESTS', 'LOG_FORMAT', 'LOG_LEVEL',
]) delete process.env[k];
