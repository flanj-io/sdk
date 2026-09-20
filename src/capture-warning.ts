/**
 * Say something, once, the first time capture fails.
 *
 * Every capture step in this SDK is fenced: a failure means "we stopped collecting",
 * never "the app broke". That is the right trade — but it also means a broken
 * capture path is completely silent, and the failure mode of silence is a user who
 * believes they have coverage they do not have. A collector showing nothing looks
 * exactly like an application making no calls.
 *
 * So: the FIRST failure prints one line to stderr, and nothing after it. Not a logger
 * (this SDK does not own the application's logging configuration, and a library that
 * starts emitting into someone's log pipeline is its own problem), and not per-call
 * (a failing capture path fails on every call, and a flood is how people learn to
 * ignore a warning).
 *
 * `export-failure-warning.ts` is the same one-line-once shape for the other half —
 * a capture that succeeded and then failed to leave the process.
 */

/** Set to any non-empty value to silence the warning (a user who has read it once). */
export const SILENCE_ENV = 'FLANJ_SILENCE_CAPTURE_WARNINGS';

/** Emit the line; overridable so tests can capture it. */
export type WarnFn = (message: string) => void;

let warned = false;
const warnedKeys = new Set<string>();

function defaultWarn(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    /* a broken stderr must not become the failure we were reporting */
  }
}

/** The line itself, so a test can assert the text without a stderr round-trip. */
export function captureFailureMessage(err: unknown, what: string): string {
  return (
    `[flanj] ${what} failed and capture has stopped for it: ${describe(err)}. ` +
    `Your application is unaffected; this is the only warning. ` +
    `Set ${SILENCE_ENV}=1 to silence it.`
  );
}

/** Print one line, once, naming what failed and why. */
export function warnCaptureFailed(err: unknown, what: string, warn: WarnFn = defaultWarn): void {
  if (warned) return;
  // Mark BEFORE the env check, like the Python SDK: silencing suppresses the line,
  // it does not arm a later one.
  warned = true;
  if (process.env[SILENCE_ENV]) return;
  warn(captureFailureMessage(err, what));
}

/**
 * Print `message` once per `key` for the life of the process.
 *
 * For conditions that are not failures but that silently reduce what is captured.
 * Same channel and same silencing variable as {@link warnCaptureFailed}.
 */
export function warnOnce(key: string, message: string, warn: WarnFn = defaultWarn): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  if (process.env[SILENCE_ENV]) return;
  warn(message);
}

/** Test-only: forget that any warning was printed. */
export function resetCaptureWarningsForTests(): void {
  warned = false;
  warnedKeys.clear();
}

/** `ErrorName: message`, the shape Python's `type(exc).__name__`/`str(exc)` gives. */
function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return `${typeof err}: ${String(err)}`;
}
