// Imported FIRST by test/suite/settings-system.test.js.
// Pins the process time zone (scheduled sync times and daily buckets are local time, see README
// "TZ") and clears environment switches that would change app behaviour, so the suite is
// deterministic wherever it runs.
process.env.TZ = 'America/New_York';
// (the app reads its settings as VESTIGO_X, else PLAYTRACKER_X: both names are cleared)
for (const k of [
  ...['CORS_ORIGIN', 'SECURE_COOKIE', 'PASSWORD', 'LOG_FILE'].flatMap((x) => [`VESTIGO_${x}`, `PLAYTRACKER_${x}`]),
  'LOG_REQUESTS', 'LOG_FORMAT', 'LOG_LEVEL',
]) delete process.env[k];
