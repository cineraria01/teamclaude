import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const frame = data => `data: ${JSON.stringify(data)}\n\n`;
const capacity = frame({ type: 'error', error: { code: 'server_is_overloaded', message: 'This model is disabled.' } });
const failed = frame({ type: 'response.failed', response: { status: 'failed', output: [], error: { code: 'server_is_overloaded' } } });
const success = frame({ type: 'response.output_text.delta', delta: 'OK' }) + frame({ type: 'response.completed', response: { output: [] } });

async function fixture(t, respond, count = 3) {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ account: req.headers['chatgpt-account-id'], body });
    respond(req, res, requests.length);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const manager = new AccountManager(Array.from({ length: count }, (_, i) => ({
    name: `account-${i}`, provider: 'codex', type: 'oauth', accessToken: `fixture-${i}`,
    accountId: `${i}`, expiresAt: Date.now() + 3600000,
  })));
  const proxy = createProxyServer(manager, {
    provider: 'codex', upstream: `http://127.0.0.1:${upstream.address().port}`,
    activeWarmup: false, codexUsageRefresh: false, continuityMode: true,
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const server of [proxy, upstream]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
  const send = () => fetch(`http://127.0.0.1:${proxy.address().port}/codex/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-6-astra', input: [], stream: true }),
    signal: AbortSignal.timeout(3000),
  });
  return { requests, manager, send };
}

for (const rejection of ['stream-error', 'stream-failed', 'http-503']) {
  test(`quota switch followed by ${rejection} tries the next account with the same request`, async t => {
    const { requests, send } = await fixture(t, (req, res) => {
      const account = req.headers['chatgpt-account-id'];
      if (account === '0') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end('{"error":{"code":"rate_limit_exceeded"}}');
      } else if (account === '1' && rejection === 'http-503') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":{"code":"server_is_overloaded"}}');
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const bytes = account === '1'
          ? ': keepalive\r\n\r\n' + (rejection === 'stream-failed' ? failed : capacity)
          : success;
        res.write(bytes.slice(0, 23));
        res.end(bytes.slice(23));
      }
    });
    const response = await send();
    assert.equal(response.status, 200);
    assert.equal(await response.text(), success);
    assert.deepEqual(requests.map(r => r.account), ['0', '1', '2']);
    assert.ok(requests.every(r => r.body === requests[0].body));
  });
}

test('capacity on every account is bounded and preserves the final error', async t => {
  const { requests, manager, send } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(capacity);
  });
  assert.equal(await (await send()).text(), capacity);
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map(r => r.account)).size, 3);
  assert.ok(manager.accounts.every(a => a.status === 'active' && a.inflight === 0));
});

for (const responseBody of [success + capacity, frame({ type: 'error', error: { code: 'other_error' } }), 'data: null\n\n', '', ':'.repeat(65537)]) {
  test(`does not replay output, unrelated errors, empty or oversized prefixes (${responseBody.length} bytes)`, async t => {
    const { requests, send } = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(responseBody);
    });
    assert.equal(await (await send()).text(), responseBody);
    assert.equal(requests.length, 1);
  });
}

test('generic HTTP 503 is not replayed as a capacity rejection', async t => {
  const { requests, send } = await fixture(t, (_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"code":"internal_error"}}');
  });
  const response = await send();
  assert.equal(response.status, 503);
  assert.match(await response.text(), /not replayed/);
  assert.equal(requests.length, 1);
});

test('capacity SSE without Content-Type still switches accounts for an explicit stream request', async t => {
  const { requests, send } = await fixture(t, (req, res) => {
    res.writeHead(200);
    res.end(req.headers['chatgpt-account-id'] === '0' ? capacity : success);
  }, 2);
  assert.equal(await (await send()).text(), success);
  assert.deepEqual(requests.map(r => r.account), ['0', '1']);
});
