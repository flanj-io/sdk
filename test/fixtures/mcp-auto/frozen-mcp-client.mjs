/**
 * The ESM half of a dual MCP package whose `Client` cannot be patched: its
 * prototype is frozen, so the auto-patch cannot install its trampolines. The
 * application still works — it is the capture that is lost — and that loss must
 * be reported, not left silent. Planted by `test/integration/register-mcp.spec.ts`.
 */
export class Client {
  constructor() {
    this.transport = { url: 'https://mcp.acme.test/mcp' };
  }

  getServerVersion() {
    return { name: 'acme-payments-mcp', version: '3.2.0' };
  }

  async listTools() {
    return { tools: [{ name: 'get_balance', description: 'Balance of an account.' }] };
  }

  async callTool(params) {
    return { structuredContent: { account_id: params.arguments.account_id, balance: '1200' }, isError: false };
  }
}

Object.freeze(Client.prototype);
