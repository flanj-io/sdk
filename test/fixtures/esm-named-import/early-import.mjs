// The app's http client module, evaluated BEFORE the SDK starts.
//
// An ESM named import of a builtin is a live binding into node:http's ESM
// facade — a slot Node fills from the CJS exports object when the facade is
// created and never touches again on its own. Patching `http.request` on the
// CJS exports (what the SDK does) therefore leaves `request` HERE pointing at
// the original function, unless the SDK re-syncs the facade afterwards
// (`module.syncBuiltinESMExports()`). Every helper below calls through the
// binding it captured at evaluation time — never through a property lookup.
import { request, get, createServer } from 'node:http';

/** POST a JSON body to `url` through the named `request` binding. */
export function postWithNamedRequest(url, body) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** GET `url` through the named `get` binding. */
export function getWithNamedGet(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

/** Serve JSON on a server built through the named `createServer` binding. */
export function listenWithNamedCreateServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/echo`,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}
