// Four captureable events, every one through a binding taken in early-import.mjs:
// a POST via `request`, a GET via `get`, and one hit on an own `createServer`
// (egress via `get` + ingress on the server) — then exit, so the register
// entry's beforeExit flush has to deliver all four.
import { postWithNamedRequest, getWithNamedGet, listenWithNamedCreateServer } from './early-import.mjs';

export async function run() {
  const target = process.env.TARGET_URL;
  await postWithNamedRequest(target, '{"amount":1200}');
  await getWithNamedGet(target);
  const own = await listenWithNamedCreateServer();
  await getWithNamedGet(own.url);
  await own.close();
  process.stdout.write('called\n');
}
