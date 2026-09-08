/**
 * OpenTelemetry's own http instrumentation, as a PRELOAD — the shape an app
 * already running OTel has, and the one Flanj has to survive next to.
 *
 * Loaded with `--import`, AFTER `@opentelemetry/instrumentation/hook.mjs` so
 * import-in-the-middle can rewrite `node:http` for ESM importers, and BEFORE
 * `@flanj/sdk/register`. Every finished span is written to fd 1 on exit as one
 * `__SPANS__{...}` line, which the spec parses out of the child's stdout.
 */
import { writeSync } from 'node:fs';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

// The SDK's own OTLP export POSTs are http calls like any other, and OTel would
// span them. Flanj already refuses to capture its own exporter host; do the same
// here so the span counts are about the app's traffic only.
const otlpHost = hostOf(process.env.FLANJ_OTLP_ENDPOINT);

registerInstrumentations({
  tracerProvider: provider,
  instrumentations: [
    new HttpInstrumentation({
      ignoreOutgoingRequestHook: (options) => {
        const host = `${options.hostname ?? options.host ?? ''}:${options.port ?? ''}`;
        return otlpHost !== undefined && host.includes(otlpHost);
      }
    })
  ]
});

process.on('exit', () => {
  const spans = exporter.getFinishedSpans().map((span) => ({
    name: span.name,
    kind: span.kind,
    target: span.attributes['url.full'] ?? span.attributes['http.url'] ?? span.attributes['url.path'] ?? span.attributes['http.target']
  }));
  // writeSync, not process.stdout.write: on 'exit' a pipe write can be dropped.
  writeSync(1, `__SPANS__${JSON.stringify(spans)}\n`);
});

/** `host:port` of a URL, or undefined when unset/unparseable. */
function hostOf(url) {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
