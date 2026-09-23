/**
 * Make global `fetch()` dial an EXTERNAL hostname (`api.acme.test`) and land on
 * an in-process loopback server: the fetch counterpart of the custom `lookup`
 * the http specs pass to `http.request`. An external name is what makes the
 * edge classify `external`, so bodies are captured.
 *
 * It installs, as the global dispatcher, an `Agent` of the undici Node BUNDLES
 * (its class is read off the dispatcher Node created, never a userland copy)
 * whose connector resolves every name to 127.0.0.1. Install it BEFORE `start()`:
 * the SDK then composes its capture layer on top of it, exactly as it would on
 * an app's own proxy agent. The returned function puts the original back.
 */

type Dispatcher = { dispatch: (...args: unknown[]) => unknown; close?: () => Promise<void> };

const CURRENT = Symbol.for('undici.globalDispatcher.1');
const NEXT = Symbol.for('undici.globalDispatcher.2');

function slot(): Record<symbol, Dispatcher | undefined> {
  return globalThis as unknown as Record<symbol, Dispatcher | undefined>;
}

/** The global dispatcher Node's bundled undici reads for every `fetch()`. */
export function currentGlobalDispatcher(): Dispatcher | undefined {
  // `Headers` is a lazy getter that loads the bundled undici, whose load
  // creates the default global Agent. `fetch` itself is a plain wrapper.
  void (globalThis as { Headers?: unknown }).Headers;
  return slot()[CURRENT];
}

export function setGlobalDispatcherForTest(dispatcher: Dispatcher): void {
  slot()[CURRENT] = dispatcher;
  if (NEXT in globalThis) slot()[NEXT] = dispatcher;
}

type AgentClass = new (opts?: unknown) => Dispatcher;
let bundledAgent: AgentClass | undefined;

/** The `Agent` class of Node's bundled undici, read before anything composed onto it. */
export function bundledAgentClass(): AgentClass {
  if (!bundledAgent) throw new Error('call installLoopbackGlobalDispatcher() first');
  return bundledAgent;
}

export function installLoopbackGlobalDispatcher(): () => void {
  const original = currentGlobalDispatcher();
  if (!original) throw new Error('this runtime has no global fetch dispatcher');
  const Agent = Object.getPrototypeOf(original).constructor as AgentClass;
  bundledAgent = Agent;
  const lookup = (_host: string, opts: { all?: boolean }, cb: (err: null, ...rest: unknown[]) => void): void => {
    if (opts && opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
    else cb(null, '127.0.0.1', 4);
  };
  const agent = new Agent({ connect: { lookup } });
  setGlobalDispatcherForTest(agent);
  return () => {
    setGlobalDispatcherForTest(original);
    void agent.close?.().catch(() => undefined);
  };
}
