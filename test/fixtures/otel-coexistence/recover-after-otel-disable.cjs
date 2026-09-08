'use strict';
/**
 * The documented interaction, as a child process.
 *
 * `shimmer.unwrap` — what OTel's `_unwrap` calls — restores the OUTERMOST
 * wrapper's original. So disabling OTel's http instrumentation at runtime while
 * Flanj sits on top of it pops FLANJ's layer and leaves OTel's own installed.
 * That is shimmer's behaviour, shared by every library that patches this way,
 * and the README says so; this reports what actually happens, and that
 * `disable()` + `enable()` on our instrumentations brings capture back.
 */
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');

const otel = new HttpInstrumentation();
registerInstrumentations({ instrumentations: [otel] });

const { start } = require(process.env.SDK_ENTRY);
const captured = [];
const handle = start({
  integration: 'coexistence-probe',
  processor: {
    onEmit(record) {
      captured.push(record.attributes?.['flanj.direction']);
    },
    forceFlush: async () => {},
    shutdown: async () => {}
  }
});

const http = require('node:http');

otel.disable();

const server = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end('{"id":"ch_1Mox"}');
  });
});

function drive(port) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      `http://api.acme.test:${port}/v1/charges`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        lookup: (_hostname, opts, cb) =>
          opts && opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => setTimeout(resolvePromise, 150));
      }
    );
    req.on('error', reject);
    req.end('{"amount":1200}');
  });
}

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  try {
    await drive(port);
    const whileEvicted = captured.length;

    for (const instrumentation of [handle.instrumentation, handle.serverInstrumentation]) {
      instrumentation.disable();
      instrumentation.enable();
    }
    await drive(port);

    process.stdout.write(
      JSON.stringify({ whileEvicted, afterReenable: captured.length - whileEvicted }) + '\n'
    );
  } catch (err) {
    process.stderr.write(`recovery probe failed: ${err.message}\n`);
    process.exit(1);
  }
  server.close();
  process.exit(0);
});
