/**
 * Zero-code entry point.
 *
 * Start Flanj with nothing but a preload, configured entirely from the environment:
 *
 *   node -r @flanj/sdk/register app.js
 *   # or
 *   NODE_OPTIONS="-r @flanj/sdk/register" node app.js
 *
 * or, from code, a single side-effecting import at the very top of your entrypoint:
 *
 *   import '@flanj/sdk/register';   // ESM
 *   require('@flanj/sdk/register'); // CJS
 *
 * It switches on BOTH capture paths this SDK has: HTTP request/response bodies on
 * `node:http`/`node:https`, and — when an MCP client package is installed — every MCP
 * client's `tools/list` and `tools/call`. The MCP half is feature-detected: with no
 * `@modelcontextprotocol` package present nothing is patched, nothing is imported and
 * nothing fails. `import flanj.register` in the Python SDK is the same entry minus the
 * HTTP half, which Python does not have.
 *
 * Reads: FLANJ_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_LOGS_ENDPOINT /
 * OTEL_EXPORTER_OTLP_ENDPOINT), OTEL_SERVICE_NAME, FLANJ_BODY_CAP_BYTES, FLANJ_IGNORE_URLS,
 * FLANJ_TRUSTED_PROXIES, FLANJ_FLUSH_TIMEOUT_MS, FLANJ_QUIET. The SDK always ignores its own OTLP
 * exporter host so a co-located collector can't cause a capture feedback loop.
 *
 * The handle is **kept**, not discarded: it is the only flush/shutdown path, and without it a
 * process that exits inside the batch processor's 1s export window ships nothing (see
 * `flush-on-exit.ts`). It is exported so an app that preloads this module can still reach it.
 */
import { start, type FlanjHandle } from './index';
import { flushOnExit } from './flush-on-exit';
import { patchInstalledMcpClientsSync, registerMcpAutoInstrumentation } from './mcp/auto-instrument';
import { SDK_NAME, SDK_VERSION } from './version';

export const handle: FlanjHandle = start();

flushOnExit(handle);

/**
 * MCP auto-instrumentation, and the startup line that reports it.
 *
 * Both halves of each dual MCP package are patched SYNCHRONOUSLY, here, inside
 * the preload: the `require` build with `require`, and the `import` build with
 * `require(esm)` on the file the `import` condition names. An application can
 * call a tool in its own module body, and on Node 24 an ESM entry point starts
 * running before anything this preload started asynchronously has settled, so
 * nothing that settles later can be relied on to be in time.
 *
 * `registerMcpAutoInstrumentation` repeats the synchronous pass (it is
 * idempotent) and then finishes with a real `import()` whatever that pass had
 * to defer: the `import` half on a Node without `require(esm)` (20.16–20.18,
 * 22.3–22.11). Anything installed and still unpatched at the end is reported on
 * the one-time capture warning, rather than left silent.
 *
 * The one startup line waits for both — its whole job is to say what is actually
 * being captured, and a line printed before detection would have to guess. Both
 * MCP methods are patched on the PROTOTYPE, so a `Client` constructed in the
 * meantime is instrumented anyway.
 *
 * Exported so a test (and an app that wants to await the full startup) can join it.
 */
const mcpOptions = { logger: handle.logger, bodyCapBytes: handle.bodyCapBytes };
const patchedSync = patchInstalledMcpClientsSync(mcpOptions);

export const mcpReady: Promise<string[]> = registerMcpAutoInstrumentation(mcpOptions)
  .catch(() => patchedSync)
  .then((patched) => {
    // One line, once, naming where capture is going and what it covers — the whole
    // failure class this SDK had was silence. FLANJ_QUIET=1 turns it off.
    try {
      if (process.env.FLANJ_QUIET !== '1') {
        const capturing =
          patched.length > 0 ? 'capturing http/https bodies and MCP client calls' : 'capturing http/https bodies';
        process.stderr.write(
          `[flanj] ${SDK_NAME} ${SDK_VERSION} ${capturing} -> ${handle.endpoint} ` +
            `(service.name=${handle.serviceName}). Set FLANJ_QUIET=1 to silence this line.\n`
        );
      }
    } catch {
      /* a broken stderr must not become a crash — and see the final catch below */
    }
    return patched;
  })
  // This promise is created by a PRELOAD and nobody is required to await it, so a
  // rejection here would be an unhandled rejection — which Node turns into a
  // process crash. A capture path may never take the application down.
  .catch(() => patchedSync);
