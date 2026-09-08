'use strict';
/**
 * One child process that registers OpenTelemetry's own `HttpInstrumentation`
 * (spans into an InMemorySpanExporter) and/or the Flanj SDK, in the order
 * `PROBE_ORDER` names, then drives ONE real http call (egress + ingress) and
 * prints what each side saw as a single JSON line on stdout.
 *
 *   PROBE_ORDER = otel-only | flanj-only | otel-first | flanj-first
 *
 * Both instrumentations patch the same two functions on the same core module,
 * so this is the only honest oracle for "do they coexist": counts from a real
 * process, not a unit-level assertion about wrappers.
 */
const PROBE_ORDER = process.env.PROBE_ORDER;
const SDK_ENTRY = process.env.SDK_ENTRY;

const flanjRecords = [];
let spanExporter;

function setupOtel() {
  const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
  const { InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { registerInstrumentations } = require('@opentelemetry/instrumentation');
  spanExporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  provider.register();
  registerInstrumentations({ instrumentations: [new HttpInstrumentation()], tracerProvider: provider });
}

function setupFlanj() {
  const { start } = require(SDK_ENTRY);
  // A processor instead of the OTLP exporter: this probe is about who patches
  // what, so nothing should leave the process.
  return start({
    integration: 'coexistence-probe',
    processor: {
      onEmit(record) {
        const a = record.attributes ?? {};
        flanjRecords.push({
          direction: a['flanj.direction'],
          method: a['flanj.http.method'],
          target: a['flanj.http.target']
        });
      },
      forceFlush: async () => {},
      shutdown: async () => {}
    }
  });
}

if (PROBE_ORDER === 'otel-first') {
  setupOtel();
  setupFlanj();
} else if (PROBE_ORDER === 'flanj-first') {
  setupFlanj();
  setupOtel();
} else if (PROBE_ORDER === 'otel-only') {
  setupOtel();
} else if (PROBE_ORDER === 'flanj-only') {
  setupFlanj();
} else {
  throw new Error(`unknown PROBE_ORDER: ${PROBE_ORDER}`);
}

const http = require('node:http');

const server = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end('{"id":"ch_1Mox","amount":1200}');
  });
});

function report() {
  const spans = (spanExporter ? spanExporter.getFinishedSpans() : []).map((s) => ({ name: s.name, kind: s.kind }));
  process.stdout.write(JSON.stringify({ order: PROBE_ORDER, spans, flanjRecords }) + '\n');
  process.exit(0);
}

function lookupLoopback(_hostname, opts, cb) {
  // An EXTERNAL hostname (so Flanj classifies the edge external and captures
  // bodies) resolved to the in-process loopback listener — the shape
  // `test/integration/http-capture.spec.ts` uses.
  if (opts && opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
  else cb(null, '127.0.0.1', 4);
}

function post(url) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' }, lookup: lookupLoopback },
      (res) => {
        res.on('data', () => {});
        res.on('end', resolvePromise);
      }
    );
    req.on('error', reject);
    req.end('{"amount":1200}');
  });
}

function get(url) {
  // Through `http.get`, NOT `http.request`: OTel's `get` patch calls the
  // request function it captured at patch time rather than the module's current
  // `request`, so this is the path where a stacked wrapper could be skipped
  // entirely — or run twice.
  return new Promise((resolvePromise, reject) => {
    const req = http.get(url, { lookup: lookupLoopback }, (res) => {
      res.on('data', () => {});
      res.on('end', resolvePromise);
    });
    req.on('error', reject);
  });
}

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  try {
    await post(`http://api.acme.test:${port}/v1/charges`);
    await get(`http://api.acme.test:${port}/v1/charges`);
  } catch (err) {
    process.stderr.write(`probe call failed: ${err.message}\n`);
    process.exit(1);
  }
  // Let both sides finish their end-of-call work before counting.
  setTimeout(() => {
    server.close();
    report();
  }, 250);
});
