// A one-shot script on GLOBAL fetch(): exactly one POST, then it returns.
//
// fetch() is Node's bundled undici, which never touches node:http. Run under
// `node -r <dist/register.js>` it must still deliver exactly one record, before
// the process ends inside the batch processor's 1s unref'd export window.
'use strict';

fetch(process.env.TARGET_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"amount":1200}'
})
  .then((res) => res.text())
  .then(() => process.stdout.write('called\n'))
  .catch((err) => {
    process.stderr.write(`fetch failed: ${err.message}\n`);
    process.exitCode = 1;
  });
