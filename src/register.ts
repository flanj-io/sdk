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
 * Reads: FLANJ_INTEGRATION_ID, FLANJ_OTLP_ENDPOINT, OTEL_SERVICE_NAME,
 * FLANJ_BODY_CAP_BYTES, FLANJ_IGNORE_URLS. The SDK always ignores its own OTLP
 * exporter host so a co-located collector can't cause a capture feedback loop.
 */
import { start } from './index';

start();
