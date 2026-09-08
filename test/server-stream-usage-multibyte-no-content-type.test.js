import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// The exact 2026-09-08 incident combination, end to end:
//   1. the Codex backend omits Content-Type on a successful Responses SSE
//      (so only the request's stream=true identifies it as a stream), and
//   2. the upstream chunks split a multi-byte UTF-8 character (Korean output).
// Before the ledger fix this hung the client forever; before the Content-Type
// detection the usage was silently never counted. Both must hold together.

const COMPLETED = Buffer.from(
  'event: response.completed\n'
  + 'data: {"type":"response.completed","response":{"id":"r1","status":"completed",'
  + '"usage":{"input_tokens":21,"output_tokens":7,"total_tokens":28}}}\n\n',
);

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

function captureConsoleErrors() {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore: () => { console.error = original; } };
}

// Delta event with Korean text, cut so that: chunk 1 ends after the FIRST byte
// of the 3-byte '한'; chunk 2 ends after the FIRST "\n" of the event boundary;
// chunk 3 is the second "\n". Both edges of the byte-level splitter at once.
function incidentChunks() {
  const event = Buffer.from(
    'event: response.output_text.delta\n'
    + 'data: {"type":"response.output_text.delta","delta":"안녕하세요 한국어 응답입니다"}\n\n',
  );
  const charStart = event.indexOf(Buffer.from('한'));
  assert.ok(charStart > 0, 'fixture must contain the multi-byte character');
  return [
    event.subarray(0, charStart + 1),
    event.subarray(charStart + 1, event.length - 1),
    event.subarray(event.length - 1),
    COMPLETED,
  ];
}

test('Content-Type-less Codex SSE with a multi-byte split streams to completion and counts usage once', async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk; // drain the request body
    res.writeHead(200); // no Content-Type — the production Codex backend shape
    for (const chunk of incidentChunks()) {
      res.write(chunk);
      await sleep(25); // separate TCP writes → separate reader chunks in the proxy
    }
    res.end();
  });
  const manager = new AccountManager([
    {
      name: 'a', provider: 'codex', type: 'oauth', accessToken: 'fixture-a',
      expiresAt: Date.now() + 3_600_000, priority: 0,
    },
  ], 0.98);
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
      signal: AbortSignal.timeout(5_000), // the incident left this open forever
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), null, 'the upstream header set is forwarded as-is');
    assert.ok(body.includes('안녕하세요 한국어 응답입니다'), 'delta text must reach the client intact');
    assert.ok(body.includes('response.completed'), 'the stream must run to its terminal event');
    assert.equal(manager.accounts[0].usage.totalInputTokens, 21);
    assert.equal(manager.accounts[0].usage.totalOutputTokens, 7);
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
