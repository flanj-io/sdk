/**
 * Zero-code entry point.
 *
 * Start Vinifera with nothing but a preload, configured entirely from the environment:
 *
 *   node -r @vinifera/sdk/register app.js
 *   # or
 *   NODE_OPTIONS="-r @vinifera/sdk/register" node app.js
 *
 * or, from code, a single side-effecting import at the very top of your entrypoint:
 *
 *   import '@vinifera/sdk/register';   // ESM
 *   require('@vinifera/sdk/register'); // CJS
 *
 * Reads: VINIFERA_INTEGRATION_ID, VINIFERA_OTLP_ENDPOINT, OTEL_SERVICE_NAME,
 * VINIFERA_BODY_CAP_BYTES, VINIFERA_IGNORE_URLS. The SDK always ignores its own OTLP
 * exporter host so a co-located collector can't cause a capture feedback loop.
 */
import { start } from './index';

start();
