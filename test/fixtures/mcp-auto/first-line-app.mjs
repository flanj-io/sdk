// An ESM application that calls its MCP client on its FIRST line — both calls
// start before this module awaits anything. Only a client patched before the
// application started running can capture them; a patch that lands a tick later
// captures neither, and says nothing.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const client = new Client();
const listed = client.listTools();
const called = client.callTool({ name: 'get_balance', arguments: { account_id: 'acct_1' } });
await Promise.all([listed, called]);
console.log('called');
