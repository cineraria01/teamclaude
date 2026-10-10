import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agyAffinityKey,
  agyModelGroup,
  agyUsageFromResponse,
  buildAgyAuthUrl,
  buildAgyRunEnv,
  classifyAgy429,
  extractAgyOAuthClient,
  parseAgyCredentials,
  parseAgyQuotaSummary,
  parseAgyStoredLogin,
  readAgyKeychain,
  resolveAgyBin,
  resolveAgyOAuthClient,
  rewriteAgyProject,
} from '../src/agy.js';

// Obviously fake OAuth client values, assembled at runtime so no literal in
// this public repository resembles a real Google client id or secret.
const FAKE_CLIENT_ID = `${['1071006060591', 'fakeclient'].join('-')}.apps.googleusercontent.com`;
const FAKE_SECRET = ['GOCSPX', 'f'.repeat(28)].join('-');

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function storedLogin(overrides = {}) {
  return {
    token: {
      access_token: 'ya29.fake-access',
      token_type: 'Bearer',
      refresh_token: '1//fake-refresh',
      expiry: '2030-01-01T00:00:00Z',
    },
    auth_method: 'consumer',
    id_token: jwt({ sub: 'google-sub-1', email: 'pro@example.com', aud: FAKE_CLIENT_ID }),
    ...overrides,
  };
}

test('agy login parses from the go-keyring keychain value and from plain JSON identically', () => {
  const json = JSON.stringify(storedLogin());
  const keychain = `go-keyring-base64:${Buffer.from(json).toString('base64')}`;

  const fromKeychain = parseAgyCredentials(parseAgyStoredLogin(keychain));
  const fromFile = parseAgyCredentials(parseAgyStoredLogin(`${json}\n`));

  assert.deepEqual(fromKeychain, fromFile);
  assert.deepEqual(fromFile, {
    accessToken: 'ya29.fake-access',
    refreshToken: '1//fake-refresh',
    idToken: storedLogin().id_token,
    expiresAt: Date.parse('2030-01-01T00:00:00Z'),
    accountUuid: 'google-sub-1',
    email: 'pro@example.com',
    clientId: FAKE_CLIENT_ID,
  });
});

test('agy credentials require tokens and an id_token subject', () => {
  assert.throws(() => parseAgyCredentials({}), /token/);
  assert.throws(() => parseAgyCredentials(storedLogin({ token: { access_token: 'a' } })), /refresh_token/);
  assert.throws(() => parseAgyCredentials(storedLogin({ id_token: jwt({ email: 'x@example.com' }) })), /sub/);
});

test('readAgyKeychain asks security for service gemini / account antigravity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamagy-security-'));
  const fake = join(dir, 'security');
  await writeFile(fake, `#!/bin/sh
[ "$*" = "find-generic-password -s gemini -a antigravity -w" ] || exit 44
echo "go-keyring-base64:Zm9v"
`);
  await chmod(fake, 0o755);
  try {
    assert.equal(readAgyKeychain({ securityBin: fake }), 'go-keyring-base64:Zm9v');
    assert.throws(() => readAgyKeychain({ securityBin: join(dir, 'missing') }), /not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuth client is scanned from agy binary bytes: prefixed id and a 28-char secret', () => {
  const tooShort = ['GOCSPX', 'short'].join('-');
  const tooLong = ['GOCSPX', 'x'.repeat(29)].join('-');
  const binary = Buffer.concat([
    Buffer.from([0, 1, 2]),
    Buffer.from(`${tooShort}\0${tooLong}\0`),
    Buffer.from(`21071006060591-wrongnumber.apps.googleusercontent.com\0`),
    Buffer.from(`${FAKE_CLIENT_ID}\0${FAKE_SECRET}\0`),
    Buffer.from([0xff, 0xfe]),
  ]);

  assert.deepEqual(extractAgyOAuthClient(binary), { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_SECRET, secretCandidates: 1 });
  assert.deepEqual(extractAgyOAuthClient(Buffer.concat([binary, Buffer.from(FAKE_SECRET)])).clientSecret, FAKE_SECRET,
    'the same secret twice is still one candidate');
  assert.deepEqual(extractAgyOAuthClient(Buffer.from('nothing here')), { clientId: null, clientSecret: null, secretCandidates: 0 });
});

test('several distinct secret candidates are an error, never a guess', () => {
  const other = ['GOCSPX', 'g'.repeat(28)].join('-');
  const binary = Buffer.from(`${FAKE_CLIENT_ID}\0${FAKE_SECRET}\0${other}\0`);
  assert.deepEqual(extractAgyOAuthClient(binary), { clientId: FAKE_CLIENT_ID, clientSecret: null, secretCandidates: 2 });
  assert.throws(
    () => resolveAgyOAuthClient({ config: {}, binaryPath: '/fake/agy', readBinary: () => binary }),
    /2 candidate OAuth client secrets.*agyOAuthClientSecret/,
  );
  // A configured secret settles it without reading the ambiguity.
  assert.equal(resolveAgyOAuthClient({
    config: { agyOAuthClientSecret: 'configured-secret' },
    binaryPath: '/fake/agy',
    readBinary: () => binary,
  }).clientSecret, 'configured-secret');
});

test('token usage is counted once, from the final frame', () => {
  const usageMetadata = { promptTokenCount: 30, candidatesTokenCount: 8, totalTokenCount: 45 };
  assert.equal(agyUsageFromResponse({ candidates: [{ content: {} }], usageMetadata }), null);
  assert.deepEqual(agyUsageFromResponse({ candidates: [{ finishReason: 'STOP' }], usageMetadata }), { input: 30, output: 15 });
  assert.deepEqual(agyUsageFromResponse({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 7 } }),
    { input: 0, output: 7 });
  assert.equal(agyUsageFromResponse({ candidates: [{ finishReason: 'STOP' }] }), null);
  assert.equal(agyUsageFromResponse(undefined), null);
});

test('config override wins over the binary; otherwise id_token aud + binary secret', () => {
  let reads = 0;
  const readBinary = () => {
    reads += 1;
    return Buffer.from(`${FAKE_CLIENT_ID} ${FAKE_SECRET}`);
  };

  const configured = resolveAgyOAuthClient({
    config: { agyOAuthClientId: 'configured-id', agyOAuthClientSecret: 'configured-secret' },
    binaryPath: '/fake/agy',
    readBinary,
  });
  assert.deepEqual(configured, { clientId: 'configured-id', clientSecret: 'configured-secret', source: 'config' });
  assert.equal(reads, 0, 'a configured client never touches the binary');

  const scanned = resolveAgyOAuthClient({ config: {}, clientIdHint: 'aud-from-id-token', binaryPath: '/fake/agy', readBinary });
  assert.deepEqual(scanned, { clientId: 'aud-from-id-token', clientSecret: FAKE_SECRET, source: 'binary' });

  assert.throws(
    () => resolveAgyOAuthClient({ config: {}, binaryPath: '/fake/agy', readBinary: () => Buffer.from('none') }),
    /agyOAuthClientSecret/,
  );
});

test('model groups: gemini-* and unknown → gemini, claude-*/gpt-* → 3p, no model → none', () => {
  assert.equal(agyModelGroup('gemini-3.6-flash-low'), 'gemini');
  assert.equal(agyModelGroup('gemini-3.1-pro-high'), 'gemini');
  assert.equal(agyModelGroup('claude-opus-5-5-high'), '3p');
  assert.equal(agyModelGroup('claude-sonnet-5-5-low'), '3p');
  assert.equal(agyModelGroup('gpt-oss-120b-medium'), '3p');
  assert.equal(agyModelGroup('something-new'), 'gemini');
  assert.equal(agyModelGroup(null), null);
  assert.equal(agyModelGroup(''), null);
});

test('quota summary parses into 5h/weekly per group', () => {
  const groups = parseAgyQuotaSummary({
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: 'gemini-weekly', window: 'weekly', resetTime: '2026-10-17T03:33:37Z', remainingFraction: 0.75 },
          { bucketId: 'gemini-5h', window: '5h', resetTime: '2026-10-10T08:33:37Z', remainingFraction: 1 },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { bucketId: '3p-weekly', window: 'weekly', resetTime: '2026-10-17T03:33:37Z', remainingFraction: 0.1 },
          // proto3 drops a zero remainingFraction: unknown here, exhausted after a 429
          { bucketId: '3p-5h', window: '5h', resetTime: '2026-10-10T08:33:37Z' },
        ],
      },
    ],
  });

  assert.deepEqual(groups, {
    gemini: {
      fiveHour: { utilization: 0, reset: Date.parse('2026-10-10T08:33:37Z') },
      weekly: { utilization: 0.25, reset: Date.parse('2026-10-17T03:33:37Z') },
    },
    '3p': {
      fiveHour: { utilization: null, reset: Date.parse('2026-10-10T08:33:37Z') },
      weekly: { utilization: 0.9, reset: Date.parse('2026-10-17T03:33:37Z') },
    },
  });
  assert.deepEqual(parseAgyQuotaSummary(null).gemini.fiveHour, { utilization: null, reset: null });
});

test('429 classification: capacity reason vs exhaustion, RetryInfo delay', () => {
  const body = (reason, delay) => JSON.stringify({
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason },
        ...(delay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] : []),
      ],
    },
  });
  assert.deepEqual(classifyAgy429(Buffer.from(body('MODEL_CAPACITY_EXHAUSTED'))),
    { capacity: true, reason: 'MODEL_CAPACITY_EXHAUSTED', retryDelayMs: null });
  assert.deepEqual(classifyAgy429(body('RATE_LIMIT_EXCEEDED', '12.5s')),
    { capacity: false, reason: 'RATE_LIMIT_EXCEEDED', retryDelayMs: 12500 });
  assert.deepEqual(classifyAgy429(`[${body('QUOTA_EXHAUSTED', '30s')}]`),
    { capacity: false, reason: 'QUOTA_EXHAUSTED', retryDelayMs: 30000 });
  assert.deepEqual(classifyAgy429('not json'), { capacity: false, reason: null, retryDelayMs: null });
});

test('project rewrite: equal and absent are byte-identical no-ops, a different project is rewritten', () => {
  const same = Buffer.from('{"project":"aicode-consumers","model":"gemini-3.6-flash-low"}');
  assert.equal(rewriteAgyProject(same, 'aicode-consumers'), same);
  const absent = Buffer.from('{"trajectoryId":"t-1"}');
  assert.equal(rewriteAgyProject(absent, 'proj-b'), absent);
  assert.equal(rewriteAgyProject(same, null), same);
  const nested = Buffer.from('{"request":{"project":"x"}}');
  assert.equal(rewriteAgyProject(nested, 'proj-b'), nested);

  const rewritten = rewriteAgyProject(same, 'proj-b');
  assert.deepEqual(JSON.parse(rewritten.toString()), { project: 'proj-b', model: 'gemini-3.6-flash-low' });
});

test('affinity key links a trajectory ACL write to its inference, else the session id', () => {
  assert.equal(agyAffinityKey('/v1internal:writeTrajectoryAcls', Buffer.from('{"trajectoryId":"traj-1"}')), 'trajectory:traj-1');
  assert.equal(agyAffinityKey(
    '/v1internal:streamGenerateContent?alt=sse',
    Buffer.from(JSON.stringify({ requestId: 'agent/conv-1/1760000000000/traj-1/3', request: { sessionId: 's-1' } })),
  ), 'trajectory:traj-1');
  assert.equal(agyAffinityKey(
    '/v1internal:streamGenerateContent?alt=sse',
    Buffer.from(JSON.stringify({ requestId: 'checkpoint/abc', request: { sessionId: 's-1' } })),
  ), 'session:s-1');
  assert.equal(agyAffinityKey('/v1internal:loadCodeAssist', Buffer.from('{"trajectoryId":"x"}')), null);
});

test('agy binary resolution: env override → next to node → ~/.local/bin → bare', () => {
  const none = () => false;
  assert.equal(resolveAgyBin({ env: { TEAMAGY_AGY_BIN: '/custom/agy' }, exists: none }), '/custom/agy');
  assert.equal(
    resolveAgyBin({ env: {}, execPath: '/opt/node/bin/node', exists: path => path === '/opt/node/bin/agy' }),
    '/opt/node/bin/agy',
  );
  assert.equal(
    resolveAgyBin({ env: { HOME: '/home/u' }, execPath: '/opt/node/bin/node', exists: path => path === '/home/u/.local/bin/agy' }),
    '/home/u/.local/bin/agy',
  );
  assert.equal(resolveAgyBin({ env: { HOME: '/home/u' }, execPath: '/opt/node/bin/node', exists: none }), 'agy');
});

test('agy run env points Cloud Code at the proxy and drops the pool selectors', () => {
  const env = buildAgyRunEnv({
    PATH: '/bin',
    HOME: '/home/u',
    TEAMCLAUDE_PROVIDER: 'agy',
    TEAMCLAUDE_CONFIG: '/home/u/.config/teamagy.json',
  }, 3458);
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/u', CLOUD_CODE_URL: 'http://127.0.0.1:3458' });
});

test('login URL: PKCE S256, offline access, forced consent, agy scopes, loopback redirect', () => {
  const url = new URL(buildAgyAuthUrl({
    clientId: FAKE_CLIENT_ID,
    redirectUri: 'http://127.0.0.1:5555/callback',
    state: 'state-1',
    codeChallenge: 'challenge-1',
  }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), FAKE_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5555/callback');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-1');
  assert.equal(url.searchParams.get('state'), 'state-1');
  const scopes = url.searchParams.get('scope').split(' ');
  for (const scope of ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/aicode',
    'https://www.googleapis.com/auth/cclog', 'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/experimentsandconfigs']) {
    assert.ok(scopes.includes(scope), scope);
  }
});
