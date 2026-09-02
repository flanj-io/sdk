// A one-shot script: makes exactly one captured HTTP call, then returns.
//
// Nothing keeps the loop alive afterwards, so the process ends WELL INSIDE the
// BatchLogRecordProcessor's 1s unref'd export window. Run under
// `node -r <dist/register.js>`, it must still deliver its record.
'use strict';
const http = require('node:http');

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
  process.exitCode = 1;
});
req.end('{"amount":1200}');
