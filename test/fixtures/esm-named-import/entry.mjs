// The documented zero-code shape: the app never imports the SDK at all — it is
// preloaded with `node --import <register> entry.mjs` (or `-r`).
import { run } from './run-calls.mjs';

await run();
