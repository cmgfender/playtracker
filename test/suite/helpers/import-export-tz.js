// Imported first by test/suite/import-export.test.js: pin the process time zone before any
// app module runs, so local-day assertions (DST days, midnight crossings) are deterministic.
process.env.TZ = 'America/New_York';
