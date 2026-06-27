'use strict';

// Integration smoke: boot the real http server and hit its routes. Run: node test/server.smoke.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const reg = require('../src/registry');
const watch = require('../src/watch');

function get(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
      })
      .on('error', reject);
  });
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-srv-'));
  reg.register({ repoPath: '/r/smoke', pid: process.pid, startedAt: 'x', projectName: 'Smoke', provider: 'jira', tracker: 'BUN' }, home);

  const server = watch.createServer({ home });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const index = await get(port, '/');
    assert.strictEqual(index.status, 200);
    assert.match(index.type, /text\/html/);
    assert.match(index.body, /Bunshin/);
    console.log('  ok - GET / returns the dashboard HTML');

    const status = await get(port, '/status');
    assert.strictEqual(status.status, 200);
    assert.match(status.type, /application\/json/);
    const payload = JSON.parse(status.body);
    assert.strictEqual(payload.repos.length, 1);
    assert.strictEqual(payload.repos[0].projectName, 'Smoke');
    console.log('  ok - GET /status returns valid aggregated JSON');

    const missing = await get(port, '/nope');
    assert.strictEqual(missing.status, 404);
    console.log('  ok - unknown route 404s');

    console.log('\nserver.smoke.js: 3 passed');
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
