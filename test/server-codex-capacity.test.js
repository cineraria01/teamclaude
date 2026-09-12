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
  const send = (extra = {}) => fetch(`http://127.0.0.1:${proxy.address().port}/codex/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-6-astra', input: [], stream: true, ...extra }),
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

// A rejection that follows structural frames outside the old allowlist
// (queued, reasoning scaffolding, future bookkeeping) was relayed to the CLI as
// "Selected model is at capacity" instead of being replayed on an idle account.
test('overload after created/in_progress/queued/reasoning/unknown bookkeeping frames still switches accounts', async t => {
  const rejected = frame({ type: 'response.created', response: { output: [], usage: null } })
    + frame({ type: 'response.in_progress', response: { output: [] } })
    + frame({ type: 'response.queued', response: { output: [] } })
    + frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', summary: [], content: [] } })
    + frame({ type: 'response.reasoning_summary_part.added', part: { type: 'summary_text', text: '' } })
    + frame({ type: 'response.some_future_bookkeeping', sequence_number: 5 })
    + frame({ type: 'error', error: { type: 'server_error', code: 'slow_down', message: 'Selected model is at capacity. Please try a different model.' } });
  const { requests, send } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(req.headers['chatgpt-account-id'] === '0' ? rejected.replaceAll('\n', '\r\n') : success);
  }, 2);
  assert.equal(await (await send()).text(), success);
  assert.deepEqual(requests.map(r => r.account), ['0', '1']);
});

test('response.failed overload that also reports usage is a rejection, not delivered output', async t => {
  const rejected = frame({ type: 'response.created', response: { output: [] } })
    + frame({ type: 'response.failed', response: { output: [], usage: { input_tokens: 1200, output_tokens: 3 }, error: { code: 'server_is_overloaded' } } });
  const { requests, send } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(req.headers['chatgpt-account-id'] === '0' ? rejected : success);
  }, 2);
  assert.equal(await (await send()).text(), success);
  assert.deepEqual(requests.map(r => r.account), ['0', '1']);
});

test('a non-overload response.failed after structural frames is relayed verbatim without switching', async t => {
  const body = frame({ type: 'response.created', response: { output: [] } })
    + frame({ type: 'response.queued', response: { output: [] } })
    + frame({ type: 'response.failed', response: { output: [], error: { code: 'invalid_prompt', message: 'bad input' } } });
  const { requests, send } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body);
  }, 2);
  assert.equal(await (await send()).text(), body);
  assert.equal(requests.length, 1);
});

test('unknown bookkeeping frames before real output are relayed intact once output starts', async t => {
  const body = frame({ type: 'response.created', response: { output: [] } })
    + frame({ type: 'response.some_future_bookkeeping', sequence_number: 1 })
    + frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', content: [] } })
    + frame({ type: 'response.output_text.delta', delta: 'hello' })
    + frame({ type: 'response.completed', response: { output: [{ type: 'message' }], usage: { output_tokens: 1 } } });
  const { requests, send } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body);
  }, 2);
  assert.equal(await (await send()).text(), body);
  assert.equal(requests.length, 1);
});

// response.created / response.in_progress echo the request's instructions and
// tools, so a real Codex turn (MCP tool schemas) pushed the held prefix past the
// fixed 64 KiB cap before the overload frame. The probe was abandoned ("probe
// released by prefix over 64 KiB") and the rejection leaked to the CLI instead
// of being replayed on the idle account (2026-09-11 04:07 live failure).
const bigInstructions = '지시 instructions '.repeat(3 * 1024); // ~66 KB UTF-8, multi-byte
const echoFrame = type => frame({ type, response: { output: [], usage: null, instructions: bigInstructions, tools: [] } });
const capacityError = frame({ type: 'error', code: 'slow_down', message: 'Selected model is at capacity. Please try a different model.' });

test('overload after echo frames larger than 64 KiB still switches accounts', async t => {
  const rejected = echoFrame('response.created') + echoFrame('response.in_progress') + capacityError;
  const { requests, send } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(req.headers['chatgpt-account-id'] === '0' ? rejected : success);
  }, 2);
  assert.equal(await (await send({ instructions: bigInstructions })).text(), success);
  assert.deepEqual(requests.map(r => r.account), ['0', '1']);
});

test('large echo frames split across chunks mid-character are relayed intact once output starts', async t => {
  const bytes = Buffer.from(echoFrame('response.created') + echoFrame('response.in_progress')
    + frame({ type: 'response.output_text.delta', delta: '출력' })
    + frame({ type: 'response.completed', response: { output: [{ type: 'message' }], usage: { output_tokens: 1 } } }));
  const { requests, send } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let offset = 0;
    const step = () => {
      if (offset >= bytes.length) return res.end();
      const end = Math.min(bytes.length, offset + 7 * 1024 + 1); // odd size: splits multi-byte chars
      res.write(bytes.subarray(offset, end));
      offset = end;
      setImmediate(step);
    };
    step();
  });
  const received = Buffer.from(await (await send({ instructions: bigInstructions })).arrayBuffer());
  assert.equal(received.equals(bytes), true);
  assert.equal(requests.length, 1);
});

test('an echo prefix beyond the request-sized budget is abandoned and relayed verbatim without hanging', async t => {
  // Abandon keeps the stream alive; a >1 MiB single frame also exceeds the
  // usage buffer's partial-event cap, so late detection is best-effort here.
  const huge = 'x'.repeat(1200 * 1024); // > 1 MiB floor, request itself is tiny
  const bytes = frame({ type: 'response.created', response: { output: [], instructions: huge } }) + capacityError;
  const { requests, send } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(bytes);
  });
  assert.equal(await (await send()).text(), bytes);
  assert.equal(requests.length, 1);
});
