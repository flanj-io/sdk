'use strict';
/**
 * A second undici in the process: the app depends on userland `undici` 8 as
 * well as calling Node's global `fetch()`. undici 8 reads the global dispatcher
 * from `Symbol.for('undici.globalDispatcher.2')` — a slot Node's own undici 6
 * (Node 20–23) never writes — and an undici that finds its slot empty installs
 * a fresh Agent in BOTH slots, overwriting what Node's `fetch()` reads.
 *
 *   PROBE_ORDER = after-start   the SDK starts, THEN the app loads undici 8
 *               | before-start  undici 8 is loaded (and configured) first
 *
 * Every name resolves to the in-process listener, through whichever agent the
 * order makes global before the SDK starts. Prints one JSON line.
 */
const http = require('node:http');

const ORDER = process.env.PROBE_ORDER;
const SDK_ENTRY = process.env.SDK_ENTRY;
const V1 = Symbol.for('undici.globalDispatcher.1');
const V2 = Symbol.for('undici.globalDispatcher.2');

function lookup(_host, opts, cb) {
  if (opts && opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
  else cb(null, '127.0.0.1', 4);
}

const records = [];
function startFlanj() {
  const { start } = require(SDK_ENTRY);
  return start({
    processor: {
      onEmit(record) {
        const a = record.attributes ?? {};
        if (a['flanj.direction'] === 'client') records.push(`${a['flanj.http.method']} ${a['flanj.http.target']}`);
      },
      forceFlush: async () => {},
      shutdown: async () => {}
    }
  });
}

let undici;
let handle;
if (ORDER === 'after-start') {
  // Node's bundled Agent, made global before the SDK: the app's own configured agent.
  void globalThis.Headers;
  const NodeAgent = Object.getPrototypeOf(globalThis[V1]).constructor;
  // Installed the way undici's setGlobalDispatcher does: both slots, when the
  // bundled undici (7, on Node 24) keeps one in `.2` too.
  const agent = new NodeAgent({ connect: { lookup } });
  globalThis[V1] = agent;
  if (V2 in globalThis) globalThis[V2] = agent;
  handle = startFlanj();
  undici = require('undici');
} else if (ORDER === 'before-start') {
  undici = require('undici');
  undici.setGlobalDispatcher(new undici.Agent({ connect: { lookup } }));
  handle = startFlanj();
} else {
  throw new Error(`unknown PROBE_ORDER: ${ORDER}`);
}

const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
});

server.listen(0, '127.0.0.1', async () => {
  const base = `http://api.acme.test:${server.address().port}`;
  const bodies = {};
  try {
    bodies.nodeFetch = await (await fetch(`${base}/node-fetch`)).json();
    bodies.undiciFetch = await (await undici.fetch(`${base}/undici-fetch`)).json();
    const r = await undici.request(`${base}/undici-request`, { method: 'POST', body: '{"a":1}' });
    bodies.undiciRequest = await r.body.json();
  } catch (err) {
    process.stderr.write(`probe call failed: ${err && err.stack}\n`);
    process.exit(1);
  }
  setTimeout(() => {
    server.close();
    process.stdout.write(
      JSON.stringify({
        order: ORDER,
        undiciVersion: require('undici/package.json').version,
        capturing: handle.fetchInstrumentation.isCapturing(),
        records: records.sort(),
        bodies
      }) + '\n'
    );
    process.exit(0);
  }, 200);
});
