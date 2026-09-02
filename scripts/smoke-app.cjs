// Runs INSIDE the scratch app, against @flanj/sdk installed from a tarball.
//
// Parent role (no argv): stand up a fake collector and a fake provider, then
// spawn a one-shot child under `node -r @flanj/sdk/register`. Child role
// (`child`): make one HTTP call and return immediately — no keep-alive, so the
// process ends inside the batch processor's 1s unref'd export window.
//
// Passing means the published tarball resolves, loads, captures and flushes.
'use strict';
const http = require('node:http');
const { spawn } = require('node:child_process');

if (process.argv[2] === 'child') {
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
  return;
}

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
}

// 1. The entrypoints the exports map promises must resolve from a consumer's app.
for (const specifier of ['@flanj/sdk', '@flanj/sdk/register']) {
  try {
    require.resolve(specifier);
  } catch (err) {
    fail(`require.resolve('${specifier}') threw ${err.code || err.message}`);
  }
}
if (typeof require('@flanj/sdk').start !== 'function') fail("@flanj/sdk does not export start()");
console.log('resolved @flanj/sdk and @flanj/sdk/register');

// 2. A real one-shot run must deliver exactly one record.
let received = 0;
const collector = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url === '/v1/logs') {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        for (const rl of payload.resourceLogs || [])
          for (const sl of rl.scopeLogs || []) received += (sl.logRecords || []).length;
      } catch {
        /* a malformed body is a failure the record count will surface */
      }
    }
    res.statusCode = 200;
    res.end('{}');
  });
});
const provider = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end('{"id":"ch_1Mox","amount":"1200"}');
  });
});

collector.listen(0, '127.0.0.1', () =>
  provider.listen(0, '127.0.0.1', () => {
    const child = spawn(process.execPath, ['-r', '@flanj/sdk/register', __filename, 'child'], {
      env: {
        ...process.env,
        FLANJ_INTEGRATION_ID: 'smoke',
        // A BASE url on purpose: the SDK must normalize it to /v1/logs.
        FLANJ_OTLP_ENDPOINT: `http://127.0.0.1:${collector.address().port}`,
        TARGET_URL: `http://127.0.0.1:${provider.address().port}/v1/charges`
      },
      stdio: 'inherit'
    });
    child.on('close', (code) => {
      setTimeout(() => {
        collector.close();
        provider.close();
        if (code !== 0) fail(`the child exited ${code}`);
        if (received !== 1) fail(`expected exactly 1 exported record, got ${received}`);
        console.log('SMOKE OK: one-shot child under -r @flanj/sdk/register delivered 1 record');
      }, 500);
    });
  })
);
