// Uses the installed selector, but fake accounts and a local fake upstream only.
// node test_fable_routing.mjs "$(command -v teamclaude)"
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { applyFableRouting } from './teamclaude-fable-routing.mjs';

const entry = pathToFileURL(realpathSync(process.argv[2]));
const { AccountManager } = await import(new URL('./account-manager.js', entry));
const { createProxyServer } = await import(new URL('./server.js', entry));
const now = Date.now();
const hour = 3600000;
function fleet() {
  const m = new AccountManager([
    { name: 'later-pinned', type: 'api', apiKey: 'fake-later', priority: 0 },
    { name: 'soonest', type: 'api', apiKey: 'fake-soonest' },
  ], 0.98, 0, 1);
  for (const [i, a] of m.accounts.entries()) {
    Object.assign(a.quota, {
      unified5h: 0.1, unified5hReset: now + hour,
      unified7d: 0.1, unified7dReset: now + (i + 1) * hour,
      modelWeekly: { '7d_oi': { utilization: 0.2, reset: now + (2 - i) * hour } },
    });
  }
  return m;
}

// Prove this fixture reproduces the original wrong account before installing.
assert.equal(fleet().getActiveAccount().name, 'later-pinned');
applyFableRouting(AccountManager);
applyFableRouting(AccountManager); // repeated preload is harmless
const m = fleet();
const [later, first] = m.accounts;
const socket = {};
m._affinity.set(socket, later);
assert.equal(await m.acquireAccount(null, 0, null, socket), first);
// Cap spill is allowed, but the next sequential request must return to first.
assert.equal(await m.acquireAccount(null, 0, null, socket), later);
const queued = m.acquireAccount(null, 1000, null, socket);
m.releaseAccount(first);
assert.equal(await queued, first);
m.releaseAccount(first);
m.releaseAccount(later);
assert.equal(await m.acquireAccount(null, 0, null, socket), first);
m.releaseAccount(first);
assert.equal(m.getActiveAccount(new Set([first])), later);
first.enabled = false;
assert.equal(m.getActiveAccount(), later);
first.enabled = true;
first._403KeptActiveAt = now;
assert.equal(m.getActiveAccount(), later);
delete first._403KeptActiveAt;
first.quota.unified5h = 0.99;
assert.equal(m.getActiveAccount(), later);
first.quota.unified5h = 0.1;
assert.equal(m.getActiveAccount(), first);
// Reset rollover is applied immediately, even on a previously pinned socket.
first.quota.modelWeekly['7d_oi'].reset = now - 1;
assert.equal(await m.acquireAccount(null, 0, null, socket), later);
m.releaseAccount(later);
for (const reset of [null, undefined, 'bad', NaN, Infinity, now - 1]) {
  later.quota.modelWeekly['7d_oi'].reset = reset;
  assert.equal(m._weeklyResetTime(later), Infinity);
}
later.quota.unified7dFableReset = now + hour;
assert.equal(m._weeklyResetTime(later), now + hour);
assert.equal(m.getStatus().routingPolicy, 'fable-reset');

// Exercise actual proxy forwarding and 429 failover; never contacts Anthropic.
const routed = [];
let refuseFirst = false;
const upstream = createServer((req, res) => {
  const key = req.headers['x-api-key'];
  routed.push(key);
  res.writeHead(refuseFirst && key === 'fake-soonest' ? 429 : 200,
    { 'Content-Type': 'application/json' });
  res.end('{}');
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const live = fleet();
const proxy = createProxyServer(live, {
  proxy: { apiKey: 'fake-proxy' },
  upstream: `http://127.0.0.1:${upstream.address().port}`,
  sessionAffinity: true, activeWarmup: false,
});
try {
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const url = `http://127.0.0.1:${proxy.address().port}`;
  const request = async () => {
    const r = await fetch(`${url}/v1/models`);
    await r.text();
    assert.equal(r.status, 200);
  };
  await request();
  assert.equal(routed.at(-1), 'fake-soonest');
  refuseFirst = true;
  await request();
  assert.deepEqual(routed.slice(-2), ['fake-soonest', 'fake-later']);
  refuseFirst = false;
  await request();
  assert.equal(routed.at(-1), 'fake-soonest');
  const status = await (await fetch(`${url}/teamclaude/status`)).json();
  assert.equal(status.routingPolicy, 'fable-reset');
  assert.equal(status.currentAccount, 'soonest');
} finally {
  proxy.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => upstream.close(r))]);
}
console.log('Fable routing: selection, rollover, pinning, queue, safety and HTTP failover passed');
