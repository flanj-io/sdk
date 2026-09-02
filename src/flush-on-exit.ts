import type { FlanjHandle } from './index';

/** Signals we flush on before re-raising. */
const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/** Cap on how long a shutdown flush may block termination. Env: FLANJ_FLUSH_TIMEOUT_MS. */
const DEFAULT_FLUSH_TIMEOUT_MS = 5000;

/**
 * Make a process that ends lose nothing.
 *
 * `BatchLogRecordProcessor` schedules its export on a **1s `unref`'d timer**, so
 * a process that exits inside that window — a one-shot script, a CLI, a pod's
 * last batch on SIGTERM — takes its records with it. `flush()` and `shutdown()`
 * are the only ways out, and the zero-code entry has no user code to call them.
 *
 * - `beforeExit`: the event loop drained and the process is about to end
 *   naturally. Async work here keeps it alive until the flush resolves. (It does
 *   NOT fire on `process.exit()` or an uncaught exception — nothing can.)
 * - `SIGTERM` / `SIGINT`: shut down, then **re-raise** the signal so the exit
 *   status stays the signal's (128+n) rather than a fabricated 0. Our listener
 *   is registered with `once`, so the re-raise hits the default action (or any
 *   listener the host app registered of its own).
 *
 * Every path is bounded: installing a signal listener suppresses Node's default
 * termination, so a wedged exporter must never be able to make the process
 * unkillable.
 */
export function flushOnExit(handle: FlanjHandle): void {
  process.once('beforeExit', () => {
    void bounded(handle.flush());
  });

  for (const signal of SIGNALS) {
    process.once(signal, () => {
      void bounded(handle.shutdown()).then(() => {
        // Listener already removed by `once`: this re-raise terminates with the
        // signal's own status unless the host app is handling it too.
        process.kill(process.pid, signal);
      });
    });
  }
}

/** Await `work`, but never longer than the flush budget, and never reject. */
async function bounded(work: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, flushTimeoutMs());
    timer.unref();
  });
  try {
    await Promise.race([work.catch(() => undefined), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function flushTimeoutMs(): number {
  const raw = process.env.FLANJ_FLUSH_TIMEOUT_MS;
  if (!raw) return DEFAULT_FLUSH_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FLUSH_TIMEOUT_MS;
}
