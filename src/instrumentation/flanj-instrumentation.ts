import type { MeterProvider, TracerProvider } from '@opentelemetry/api';
import type { LoggerProvider } from '@opentelemetry/api-logs';
import type { Instrumentation, InstrumentationConfig } from '@opentelemetry/instrumentation';

/**
 * The base the two http capture instrumentations extend, in place of OTel's
 * `InstrumentationBase`.
 *
 * It satisfies OTel's `Instrumentation` interface — these objects can still be
 * handed to `registerInstrumentations()` — but it deliberately does NOT bring
 * `InstrumentationBase`'s module-hook machinery, for two reasons:
 *
 * 1. **Flanj never used it.** Both classes returned `[]` from `init()` and patch
 *    the already-loaded core modules directly, because require-in-the-middle
 *    (RITM) does not re-fire for core modules loaded before the SDK starts.
 * 2. **Constructing it broke OTel.** `InstrumentationBase` instantiates
 *    `RequireInTheMiddleSingleton` in a field initializer, which installs a hook
 *    over `Module.prototype.require` AND `process.getBuiltinModule` that caches
 *    every core module it sees. Starting Flanj first therefore filled that cache
 *    with `http`/`https` before the app registered
 *    `@opentelemetry/instrumentation-http`, whose patch then never ran: zero OTel
 *    spans, no error, while Flanj kept capturing.
 *
 * What is left is small and honest: config, an enabled flag, and two hooks for
 * the subclass. The tracer/meter/logger setters are no-ops — Flanj emits its
 * records through the logger provider `start()` owns, and reads span context
 * from the API's active context, so it needs neither provider.
 */
export abstract class FlanjInstrumentation<ConfigType extends InstrumentationConfig>
  implements Instrumentation<ConfigType>
{
  readonly instrumentationName: string;
  readonly instrumentationVersion: string;

  private currentConfig!: ConfigType;
  private active = false;

  constructor(instrumentationName: string, instrumentationVersion: string, config: ConfigType) {
    this.instrumentationName = instrumentationName;
    this.instrumentationVersion = instrumentationVersion;
    // Before enable(), and through the same setter a caller would use later: a
    // subclass that validates config (trustedProxies) fails HERE, in start().
    this.setConfig(config);
    if (this.getConfig().enabled !== false) this.enable();
  }

  getConfig(): ConfigType {
    return this.currentConfig;
  }

  setConfig(config: ConfigType): void {
    // First level copied so it cannot be mutated from outside; nested values are not.
    this.currentConfig = { enabled: true, ...config };
  }

  /** Whether this instrumentation is capturing. An installed patch checks it on every call. */
  isEnabled(): boolean {
    return this.active;
  }

  enable(): void {
    if (this.active) return;
    this.active = true;
    this.patch();
  }

  disable(): void {
    if (!this.active) return;
    // Flip FIRST: a patch we cannot remove (another library wrapped on top of
    // it) reads this on every call and becomes a pass-through immediately.
    this.active = false;
    this.unpatch();
  }

  setTracerProvider(_tracerProvider: TracerProvider): void {
    // no-op: capture records carry span context read from the active context.
  }

  setMeterProvider(_meterProvider: MeterProvider): void {
    // no-op: this instrumentation emits no metrics.
  }

  setLoggerProvider(_loggerProvider: LoggerProvider): void {
    // no-op: records go to the logger `start()` wired to `onCapture`.
  }

  /** Install the patches. Called by `enable()`, at most once per enabled cycle. */
  protected abstract patch(): void;

  /** Remove them again. Called by `disable()` AFTER `isEnabled()` has gone false. */
  protected abstract unpatch(): void;
}
