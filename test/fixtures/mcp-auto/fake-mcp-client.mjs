/**
 * A stand-in for `@modelcontextprotocol/sdk`'s `Client`, planted into an
 * isolated node_modules tree by `test/integration/register-mcp.spec.ts`.
 *
 * It is deliberately only as real as the wrapper's feature detection needs:
 * `callTool` / `listTools` on the PROTOTYPE (that is what the auto-patch
 * shadows), a transport carrying a URL (that is the edge key), and the
 * handshake accessor for the server's identity. Nothing here imports flanj.
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
