'use strict';
/**
 * One child process that registers OpenTelemetry's `UndiciInstrumentation`
 * (spans into an InMemorySpanExporter) and/or the Flanj SDK, in the order
 * `PROBE_ORDER` names, then drives two real `fetch()` calls (POST + GET) and
 * prints what each side saw as one JSON line on stdout.
 *
 *   PROBE_ORDER = otel-only | flanj-only | otel-first | flanj-first
 *
 * OTel's undici instrumentation observes through `diagnostics_channel`; Flanj
 * composes a dispatcher interceptor. Neither may cost the other a call.
 */
const PROBE_ORDER = process.env.PROBE_ORDER;
const SDK_ENTRY = process.env.SDK_ENTRY;
const http = require('node:http');

// An EXTERNAL hostname (so Flanj captures bodies) resolved to the in-process
// listener: an Agent of Node's BUNDLED undici, installed as the global
// dispatcher before either instrumentation starts — the shape of an app that
// configured its own agent.
void globalThis.Headers; // loads the bundled undici, which creates the default Agent
const SLOT = Symbol.for('undici.globalDispatcher.1');
const Agent = Object.getPrototypeOf(globalThis[SLOT]).constructor;
const loopback = new Agent({
  connect: {
    lookup(_host, opts, cb) {
      if (opts && opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
      else cb(null, '127.0.0.1', 4);
    }
  }
});
globalThis[SLOT] = loopback;
if (Symbol.for('undici.globalDispatcher.2') in globalThis) globalThis[Symbol.for('undici.globalDispatcher.2')] = loopback;

const flanjRecords = [];
let spanExporter;

function setupOtel() {
  const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
  const { InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
  const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici');
  const { registerInstrumentations } = require('@opentelemetry/instrumentation');
  spanExporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  provider.register();
  registerInstrumentations({ instrumentations: [new UndiciInstrumentation()], tracerProvider: provider });
}

function setupFlanj() {
  const { start } = require(SDK_ENTRY);
  return start({
    processor: {
      onEmit(record) {
        const a = record.attributes ?? {};
        flanjRecords.push({
          direction: a['flanj.direction'],
          method: a['flanj.http.method'],
          target: a['flanj.http.target'],
          requestBody: a['flanj.http.request.body'],
          traceId: a['flanj.corr.trace_id']
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

const traceparents = [];
const server = http.createServer((req, res) => {
  traceparents.push(req.headers.traceparent ?? null);
  req.on('data', () => {});
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end('{"id":"ch_1Mox","amount":1200}');
  });
});

server.listen(0, '127.0.0.1', async () => {
  const base = `http://api.acme.test:${server.address().port}`;
  try {
    const post = await fetch(`${base}/v1/charges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"amount":1200}'
    });
    await post.text();
    const get = await fetch(`${base}/v1/charges/ch_1Mox`);
    await get.text();
  } catch (err) {
    process.stderr.write(`probe call failed: ${err.message}\n`);
    process.exit(1);
  }
  setTimeout(() => {
    server.close();
    const spans = (spanExporter ? spanExporter.getFinishedSpans() : []).map((s) => ({
      name: s.name,
      kind: s.kind,
      traceId: s.spanContext().traceId
    }));
    process.stdout.write(JSON.stringify({ order: PROBE_ORDER, spans, flanjRecords, traceparents }) + '\n');
    process.exit(0);
  }, 250);
});
