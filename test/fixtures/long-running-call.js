// A long-running service: one captured HTTP call, then it stays up.
//
// Stands in for a pod holding its last batch when the orchestrator sends
// SIGTERM. Run under `node -r <dist/register.js>`, that batch must still ship.
'use strict';
const http = require('node:http');

// Keep-alive: without this the process would exit and `beforeExit` — not the
// signal path — would be the thing under test.
setInterval(() => {}, 60_000);

const req = http.request(
  process.env.TARGET_URL,
  { method: 'POST', headers: { 'content-type': 'application/json' } },
  (res) => {
    res.on('data', () => {});
    res.on('end', () => process.stdout.write('called\n'));
  }
);
req.on('error', (err) => {
  process.stderr.write(`request failed: ${err.message}\n`);
  process.exit(1);
});
req.end('{"amount":1200}');
