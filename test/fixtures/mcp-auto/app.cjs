// The same application written in CommonJS: it must be instrumented too. In a
// dual package this reaches a DIFFERENT `Client` class object from the ESM half.
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');

const client = new Client();
client
  .listTools()
  .then(() => client.callTool({ name: 'get_balance', arguments: { account_id: 'acct_1' } }))
  .then(() => console.log('called'));
