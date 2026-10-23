// Imported FIRST by test/suite/psn-custom.test.js: pin a timezone with daylight saving time so
// day buckets, 04:00 schedule slots and the March DST change are deterministic on any machine.
process.env.TZ = 'America/New_York';
