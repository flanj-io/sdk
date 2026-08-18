import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';

/** ExportResultCode.SUCCESS === 0 in @opentelemetry/core; inlined to avoid the dep. */
const SUCCESS = 0;

/** Minimal in-memory logs exporter for asserting emitted records in tests. */
export class InMemoryLogExporter implements LogRecordExporter {
  readonly records: ReadableLogRecord[] = [];

  export(logs: ReadableLogRecord[], resultCallback: (result: { code: number }) => void): void {
    this.records.push(...logs);
    resultCallback({ code: SUCCESS });
  }

  async shutdown(): Promise<void> {
    // no-op
  }

  reset(): void {
    this.records.length = 0;
  }
}
