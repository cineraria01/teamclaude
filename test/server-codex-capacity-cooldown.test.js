import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// After a Codex capacity rejection the account is parked for that model
// (capacityCooldown) until its deadline; the next real request after expiry
// probes it once, and a completed response clears the mark. Selection,
// pinning, affinity, rotation and recovery all honor the park, and the status
// API neither reports a cooling account as usable nor as the current account.
const model = 'gpt-6-astra';
const frame = data => `data: ${JSON.stringify(data)}\n\n`;
const success = frame({ type: 'response.completed', response: { output: [] } });
const overload = frame({ type: 'error', error: { code: 'server_is_overloaded' } });

function manager() {
  return new AccountManager([0, 1].map(i => ({
    name: `fixture-${i}`, accountUuid: `id-${i}`, accountId: `${i}`, provider: 'codex',
    type: 'oauth', accessToken: `fixture-${i}`, expiresAt: Date.now() + 3600000,
  })));
}

test('cooldown gates sticky, affinity, preferred, rotation, recovery, and one expired probe', () => {
  const am = manager();
  const [a, b] = am.accounts;
  const key = {};
  am._affinity.set(key, a);
  a.capacityCooldown = new Map([[model, Date.now() + 600000]]);
  a.quota.unified7d = 0.1;
  a.quota.unified7dReset = Date.now() + 3600000;
  const status = am.getStatus({ includeIdentity: true });
  assert.equal(status.currentAccountUuid, null);
  assert.equal(status.accounts[0].usable, false);
  assert.ok(status.accounts[0].capacityCooling[model] > Date.now());
  assert.deepEqual(status.accounts[1].capacityCooling, {});
  assert.equal(am._isAvailable(a, model), false);
  assert.equal(am._isAvailable(a, 'other-model'), true);
  assert.equal(am._tryAcquire(null, key, model), b);
  am.releaseAccount(b);
  assert.equal(am._tryAcquire(null, null, model, 'id-0'), null);
  b.capacityCooldown = new Map([[model, Date.now() + 600000]]);
  a.quota.unified5hReset = Date.now() - 100;
  assert.equal(am.getActiveAccount(null, model), null);
  assert.equal(am._recoverSoonest(model), null);
  assert.equal(am.rotateActiveAccount(model).rotated, false);
  assert.equal(am.anyUsable(null, model), false);
  a.capacityCooldown.set(model, Date.now() - 1);
  assert.equal(am._tryAcquire(null, null, model), a);
  assert.equal(am._tryAcquire(null, null, model), null);
  am.releaseAccount(a);
});

async function fixture(t, respond) {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk; // consume body
    requests.push(req.headers['chatgpt-account-id']);
    respond(req, res);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const am = manager();
  const proxy = createProxyServer(am, {
    provider: 'codex', upstream: `http://127.0.0.1:${upstream.address().port}`,
    activeWarmup: false, codexUsageRefresh: false, continuityMode: false,
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const server of [proxy, upstream]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
  const send = (extra = {}) => fetch(`http://127.0.0.1:${proxy.address().port}/codex/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: [], stream: true, ...extra }), signal: AbortSignal.timeout(3000),
  });
  return { am, requests, send };
}

test('all cooling sends zero upstream requests; expiry probes then re-parks and rotates repeatedly', async t => {
  let recovered = false;
  const { am, requests, send } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(recovered ? success : overload);
  });
  assert.equal(await (await send()).text(), overload);
  assert.deepEqual(requests, ['0', '1']);
  assert.equal((await send()).status, 429);
  assert.equal(requests.length, 2);
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const a of am.accounts) a.capacityCooldown.set(model, Date.now() - 1);
    assert.equal(await (await send()).text(), overload);
    assert.equal(requests.length, 4 + cycle * 2);
    assert.ok(am.accounts.every(a => a.capacityCooldown.get(model) > Date.now()));
  }
  recovered = true;
  am.accounts[0].capacityCooldown.set(model, Date.now() - 1);
  assert.equal(await (await send()).text(), success);
  assert.equal(am.accounts[0].capacityCooldown.has(model), false);
  assert.ok(am.accounts[0].capacityRecovered.get(model) > 0);
  assert.ok(am.getStatus().accounts[0].capacityRecovered[model] > 0);
});

test('a success already in flight cannot clear a newer cooldown', async t => {
  let finish;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { am, send } = await fixture(t, (_req, res) => {
    finish = () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(success); };
    started();
  });
  const pending = send();
  await ready;
  const account = am.accounts.find(a => a.inflight > 0);
  const until = Date.now() + 600000;
  account.capacityCooldown = new Map([[model, until]]);
  finish();
  assert.equal(await (await pending).text(), success);
  assert.equal(account.capacityCooldown.get(model), until);
});

test('Selected model is at capacity after cooldown re-parks and switches without leaking the error', async t => {
  const rejected = frame({ type: 'response.created', response: { output: [] } })
    + frame({ type: 'error', code: 'slow_down', message: 'Selected model is at capacity. Please try a different model.' });
  const { am, requests, send } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(req.headers['chatgpt-account-id'] === '0' ? rejected : success);
  });
  am.accounts[0].capacityCooldown = new Map([[model, Date.now() - 1]]);
  assert.equal(await (await send()).text(), success);
  assert.deepEqual(requests, ['0', '1']);
  assert.ok(am.accounts[0].capacityCooldown.get(model) > Date.now());
  assert.equal(am.getStatus({ includeIdentity: true }).accounts[0].usable, false);
});

test('late CRLF overload preserves delivered output but still parks the account for the next request', async t => {
  const bytes = frame({ type: 'response.output_text.delta', delta: 'already delivered' })
    + frame({ type: 'error', code: 'slow_down', message: 'Selected model is at capacity. Please try a different model.' });
  const { am, requests, send } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(bytes.replaceAll('\n', '\r\n'));
  });
  assert.equal(await (await send()).text(), bytes.replaceAll('\n', '\r\n'));
  assert.equal(requests.length, 1);
  assert.ok(am.accounts[0].capacityCooldown.get(model) > Date.now());
  assert.equal(am.accounts[1].capacityCooldown?.has(model) ?? false, false);
});
