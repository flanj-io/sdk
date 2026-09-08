import { describe, it, expect } from 'vitest';
import type { InstrumentationConfig } from '@opentelemetry/instrumentation';
import { FlanjInstrumentation } from './flanj-instrumentation';

/**
 * The base the two capture instrumentations extend in place of OTel's
 * `InstrumentationBase`. What matters here is the lifecycle contract the
 * subclasses rely on — construction patches, `disable()` reports disabled
 * BEFORE it unpatches (a layer we cannot remove reads that flag on every call),
 * and both are idempotent.
 */

interface ProbeConfig extends InstrumentationConfig {
  label?: string;
}

class Probe extends FlanjInstrumentation<ProbeConfig> {
  /**
   * `declare`, never a field INITIALIZER: the base constructor calls `enable()`
   * → `patch()`, which runs BEFORE a subclass field would be assigned — the
   * same trap the real instrumentations avoid by building their layer mark
   * inside `patch()` and their trusted-proxy set inside `setConfig()`.
   */
  declare events: string[] | undefined;
  /** `isEnabled()` as observed from inside `unpatch()`. */
  declare enabledDuringUnpatch: boolean | undefined;

  constructor(config: ProbeConfig = {}) {
    super('flanj/probe', '0.0.0', config);
  }

  /** Every patch/unpatch, in order. */
  get log(): string[] {
    return this.events ?? [];
  }

  protected patch(): void {
    this.events = [...this.log, 'patch'];
  }

  protected unpatch(): void {
    this.enabledDuringUnpatch = this.isEnabled();
    this.events = [...this.log, 'unpatch'];
  }
}

describe('FlanjInstrumentation', () => {
  it('patches on construction and reports itself enabled', () => {
    const probe = new Probe();

    expect(probe.log).toEqual(['patch']);
    expect(probe.isEnabled()).toBe(true);
  });

  it('does not patch when constructed disabled', () => {
    const probe = new Probe({ enabled: false });

    expect(probe.log).toEqual([]);
    expect(probe.isEnabled()).toBe(false);
  });

  it('is already disabled when `unpatch()` runs', () => {
    // A layer buried under another library's wrapper cannot be removed; it goes
    // inert by reading `isEnabled()` on every call, so the flag must flip first.
    const probe = new Probe();

    probe.disable();

    expect(probe.enabledDuringUnpatch).toBe(false);
  });

  it('ignores a repeated enable() or disable()', () => {
    const probe = new Probe();

    probe.enable();
    probe.disable();
    probe.disable();

    expect(probe.log).toEqual(['patch', 'unpatch']);
  });

  it('patches again after a disable/enable cycle', () => {
    const probe = new Probe();

    probe.disable();
    probe.enable();

    expect(probe.log).toEqual(['patch', 'unpatch', 'patch']);
    expect(probe.isEnabled()).toBe(true);
  });

  it('defaults `enabled` to true and copies the config’s first level', () => {
    const config: ProbeConfig = { label: 'a' };
    const probe = new Probe(config);

    config.label = 'mutated';

    expect(probe.getConfig()).toEqual({ enabled: true, label: 'a' });
  });

  it('exposes the name and version it was constructed with', () => {
    const probe = new Probe();

    expect(probe.instrumentationName).toBe('flanj/probe');
    expect(probe.instrumentationVersion).toBe('0.0.0');
  });
});
