import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Regression: the usage-parsing side buffer in streamResponse accounted its
// auxiliary reservation in *decoded text* bytes while reserving *raw* bytes.
// An upstream chunk that ends in the middle of a multi-byte UTF-8 character
// (routine for Korean output) desynchronised the ledger, and the next event
// boundary flush threw "Auxiliary response buffer reservation underflow" —
// leaving the client response open forever (headers sent, never ended).

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

function makeAccounts() {
  return new AccountManager([
    {
      name: 'a', provider: 'codex', type: 'oauth', accessToken: 'fixture-a',
      expiresAt: Date.now() + 3_600_000, priority: 0,
    },
  ], 0.98);
}

function captureConsoleErrors() {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore: () => { console.error = original; } };
}

// One SSE event whose data carries Korean text, delivered in three upstream
// chunks: the first ends after the FIRST byte of the 3-byte character '한',
// the second carries the rest of the event WITHOUT its "\n\n" boundary, and
// the third is the boundary alone — so the ledger drift has to survive one
// non-flushing chunk before the flush releases the (over-counted) total.
function splitEventAcrossMultibyteChar() {
  const event = Buffer.from(
    'event: response.output_text.delta\n'
    + 'data: {"type":"response.output_text.delta","delta":"안녕하세요 한국어 응답입니다"}\n\n',
  );
  const charStart = event.indexOf(Buffer.from('한'));
  assert.ok(charStart > 0, 'fixture must contain the multi-byte character');
  return [
    event.subarray(0, charStart + 1),
    event.subarray(charStart + 1, event.length - 2),
    event.subarray(event.length - 2),
  ];
}

const COMPLETED = Buffer.from(
  'event: response.completed\n'
  + 'data: {"type":"response.completed","response":{"id":"r1","status":"completed",'
  + '"usage":{"input_tokens":21,"output_tokens":7,"total_tokens":28}}}\n\n',
);

async function writeChunks(res, chunks) {
  for (const chunk of chunks) {
    res.write(chunk);
    await sleep(25); // separate TCP writes → separate reader chunks in the proxy
  }
}

test('a multi-byte character split across upstream SSE chunks does not desynchronise the usage buffer ledger', async () => {
  const chunks = splitEventAcrossMultibyteChar();
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk; // drain the request body
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    await writeChunks(res, [...chunks, COMPLETED]);
    res.end();
  });
  const manager = makeAccounts();
  const errors = captureConsoleErrors();
  let proxy;
  try {
    const upstreamPort = await listen(upstream);
    proxy = createProxyServer(manager, {
      provider: 'codex',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      codexUsageRefresh: false,
      sessionAffinity: false,
    });
    const proxyPort = await listen(proxy);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', stream: true, input: [{ role: 'user', content: 'x' }] }),
      signal: AbortSignal.timeout(5_000), // the bug left the response open forever
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.ok(body.includes('안녕하세요 한국어 응답입니다'), 'delta text must reach the client intact');
    assert.ok(body.includes('response.completed'), 'the stream must run to its terminal event');
    assert.deepEqual(
      errors.lines.filter(line => line.includes('underflow')),
      [],
      'no reservation ledger underflow may be logged',
    );
  } finally {
    errors.restore();
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('an event boundary split across chunks after a multi-byte character still flushes cleanly', async () => {
  // Boundary "\n\n" itself split: "\n" ends one chunk, "\n" starts the next —
  // plus the multi-byte split before it. Both edges of the byte-level splitter.
  const event = Buffer.from(
    'event: response.output_text.delta\n'
    + 'data: {"type":"response.output_text.delta","delta":"결과: 완료"}\n\n',
  );
  const charStart = event.indexOf(Buffer.from('완'));
  const chunks = [
    event.subarray(0, charStart + 2), // two of the three bytes of '완'
    event.subarray(charStart + 2, event.length - 1), // ... up to and including the first "\n"
    event.subarray(event.length - 1), // the second "\n"
    COMPLETED,
  ];
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk; // drain the request body
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    await writeChunks(res, chunks);
    res.end();
  });
  const manager = makeAccounts();
  const errors = captureConsoleErrors();
  let proxy;
  try {
    const upstreamPort = await listen(upstream);
    proxy = createProxyServer(manager, {
      provider: 'codex',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      codexUsageRefresh: false,
      sessionAffinity: false,
    });
    const proxyPort = await listen(proxy);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', stream: true, input: [{ role: 'user', content: 'x' }] }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.ok(body.includes('결과: 완료'));
    assert.ok(body.includes('response.completed'));
    assert.deepEqual(errors.lines.filter(line => line.includes('underflow')), []);
  } finally {
    errors.restore();
    await Promise.all([close(proxy), close(upstream)]);
  }
});
