// Imported first by test/suite/server-db.test.js: pins the test process to UTC so
// in-process day buckets are deterministic. Child servers get their own TZ explicitly.
process.env.TZ = 'UTC';
