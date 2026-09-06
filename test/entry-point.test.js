import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

// Two configs that differ only in a port, so the port a command reports says
// which one it resolved — and it says so without any network call.
const ANTHROPIC_PORT = 39456;
const CODEX_PORT = 39457;

function config(port) {
  return JSON.stringify({
    proxy: { port, apiKey: 'k' },
    accounts: [{
      name: `marker-${port}`,
      type: 'oauth',
      accessToken: 'x',
      refreshToken: 'y',
      expiresAt: 33270000000000,
    }],
  });
}

async function isolatedConfigHome() {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-entry-'));
  await writeFile(join(dir, 'teamclaude.json'), config(ANTHROPIC_PORT));
  await writeFile(join(dir, 'teamcodex.json'), config(CODEX_PORT));
  return dir;
}

function runStatus(entry, configHome) {
  // TEAMCLAUDE_CONFIG must be absent, not empty: an empty value is still a
  // configured path and the CLI fails on it. The isolated XDG_CONFIG_HOME is
  // what makes the two configs discoverable.
  const env = { ...process.env, XDG_CONFIG_HOME: configHome };
  delete env.TEAMCLAUDE_CONFIG;
  // The pollution this guard exists for: inherited from a parent shell, a
  // launchd plist, or a `teamcodex run` child.
  env.TEAMCLAUDE_PROVIDER = 'codex';
  return spawnSync(process.execPath, [join(SRC, entry), 'status'], {
    encoding: 'utf8',
    timeout: 30_000,
    env,
  });
}

// The Anthropic-pool launchd service executes src/teamclaude.js directly, and
// the `teamclaude` bin points at it. Its whole job is to clear an inherited
// TEAMCLAUDE_PROVIDER so the Anthropic command cannot be hijacked onto the
// Codex pool's config, port and upstream. Nothing else in the suite spawns it,
// so without this test a refactor could silently undo the guard.
test('the teamclaude entry point ignores an inherited codex provider', async t => {
  const configHome = await isolatedConfigHome();
  t.after(() => rm(configHome, { recursive: true, force: true }));

  const wrapper = runStatus('teamclaude.js', configHome);
  // `status` exits non-zero when no server is listening, which is the case for
  // these throwaway ports. What matters is which config it resolved.
  assert.equal(wrapper.error, undefined, String(wrapper.error));
  assert.match(wrapper.stdout, new RegExp(String(ANTHROPIC_PORT)),
    `the wrapper must resolve the Anthropic config; got: ${wrapper.stdout}`);
  assert.doesNotMatch(wrapper.stdout, new RegExp(String(CODEX_PORT)),
    'the wrapper must not resolve the Codex config');
});

// The other half of the contract: index.js is SUPPOSED to honour the variable.
// If it ever stopped doing so the wrapper would be pointless, and this test
// would be the one to say why.
test('the codex entry point still honours the provider it is given', async t => {
  const configHome = await isolatedConfigHome();
  t.after(() => rm(configHome, { recursive: true, force: true }));

  const direct = runStatus('index.js', configHome);
  assert.equal(direct.error, undefined, String(direct.error));
  assert.match(direct.stdout, new RegExp(String(CODEX_PORT)),
    `index.js must resolve the Codex config when told to; got: ${direct.stdout}`);
});
