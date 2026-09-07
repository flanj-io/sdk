import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';

/**
 * Shared harness for the integration specs that spawn REAL children under the
 * built `dist/register.js`: an in-process OTLP/HTTP receiver that flattens every
 * `flanj.*` log record POSTed to /v1/logs, a plain JSON provider the children can
 * call (on a different port to the receiver), and the child-process plumbing.
 */

export interface OtlpReceiver {
  base: string;
  /** Every `flanj.*` log record POSTed to /v1/logs, flattened. */
  records: Record<string, unknown>[];
  close: () => Promise<void>;
}

export async function startReceiver(): Promise<OtlpReceiver> {
  const records: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/v1/logs') {
        for (const record of parseLogRecords(Buffer.concat(chunks).toString('utf8'))) {
          records.push(record);
        }
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    records,
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

/** Pull the log records out of one OTLP/HTTP JSON export body. */
function parseLogRecords(body: string): Record<string, unknown>[] {
  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const resourceLog of payload?.resourceLogs ?? []) {
    for (const scopeLog of resourceLog?.scopeLogs ?? []) {
      for (const record of scopeLog?.logRecords ?? []) out.push(record);
    }
  }
  return out;
}

export interface Provider {
  /** The URL the children are told to call (`TARGET_URL`). */
  url: string;
  close: () => Promise<void>;
}

/** A plain provider the children can call, on a DIFFERENT port to the receiver. */
export async function startProvider(): Promise<Provider> {
  const server: Server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.statusCode = 200;
      res.end('{"id":"ch_1Mox","amount":"1200"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/charges`,
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

export function childEnv(receiver: OtlpReceiver, targetUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TARGET_URL: targetUrl,
    FLANJ_INTEGRATION_ID: 'acme-payments',
    FLANJ_OTLP_ENDPOINT: receiver.base, // a BASE url — normalization is part of the path under test
    FLANJ_QUIET: '1'
  };
}

export interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Wait until `check()` holds, or give up after `timeoutMs` (the caller asserts). */
export async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

export function onExit(child: ChildProcess): Promise<ChildResult> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
  return new Promise((resolvePromise) => {
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

/** Some platforms report a signal death as 128+n rather than a signal name. */
export function exitSignalOf(code: number | null): string | null {
  return code === 128 + 15 ? 'SIGTERM' : null;
}

/** OTLP JSON attributes (`[{key, value:{stringValue|intValue|…}}]`) as a flat record. */
export function attributesOf(record: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const attribute of (record?.attributes as any[]) ?? []) {
    const value = attribute?.value ?? {};
    out[attribute.key] =
      value.stringValue ??
      (value.intValue !== undefined ? Number(value.intValue) : undefined) ??
      value.boolValue ??
      value.doubleValue;
  }
  return out;
}
