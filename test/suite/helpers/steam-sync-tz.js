// Imported FIRST by test/suite/steam-sync.test.js so every local-time computation (daily
// buckets, 04:00 schedule slots, DST) runs in a zone with daylight saving time.
process.env.TZ = 'America/New_York';
