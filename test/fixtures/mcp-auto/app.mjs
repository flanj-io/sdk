// The application: it constructs an MCP client and calls a tool. It never
// imports or mentions flanj — the whole point of the zero-code entry.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const client = new Client();
await client.listTools();
await client.callTool({ name: 'get_balance', arguments: { account_id: 'acct_1' } });
console.log('called');
