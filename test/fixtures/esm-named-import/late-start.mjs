// The defect shape: the app's http module is imported FIRST and the SDK SECOND.
// Static imports evaluate in source order, so early-import.mjs takes its
// `{ request, get, createServer }` bindings while they are still the originals,
// and only then does register.js start the SDK and patch node:http.
import './early-import.mjs';
import '../../../dist/register.js';
import { run } from './run-calls.mjs';

await run();
