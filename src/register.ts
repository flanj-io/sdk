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
 * Reads: FLANJ_INTEGRATION_ID, FLANJ_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_LOGS_ENDPOINT /
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
import { SDK_NAME, SDK_VERSION } from './version';

export const handle: FlanjHandle = start();

flushOnExit(handle);

// One line, once, naming where capture is going — the whole failure class this
// SDK had was silence. FLANJ_QUIET=1 turns it off.
if (process.env.FLANJ_QUIET !== '1') {
  process.stderr.write(
    `[flanj] ${SDK_NAME} ${SDK_VERSION} capturing http/https bodies -> ${handle.endpoint} ` +
      `(integration=${handle.integration}). Set FLANJ_QUIET=1 to silence this line.\n`
  );
}
