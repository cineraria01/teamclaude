#!/usr/bin/env node
// Replace the Claude pool's accounts with long-lived `claude setup-token` tokens.
//
// usage (tokens never appear in argv or output):
//   TEAMCLAUDE_CONFIG=~/.config/teamclaude.json \
//     node claude-setup-tokens-apply.mjs <teamclaude src/config.js> < tokens.json
//   tokens.json: {"tokens": ["sk-ant-oat01-…", …], "expiresAt": <epoch ms, optional>}
//
// Over SSH, stream tokens.json on stdin and this file through base64 — see
// docs/INSTALL-ALL.md §2-1. Accounts become lt-1..lt-N in input order, with no
// refreshToken: the fork (and karpeleslab 1.4.2) skips refresh for such accounts
// (account-manager.js ensureTokenFresh). Afterwards send SIGHUP to the worker
// (teamclaude.server.json workerPid) or restart the service.
import { readFileSync } from 'node:fs';

const configModule = process.argv[2];
if (!configModule) {
  console.error('usage: node claude-setup-tokens-apply.mjs <path to teamclaude src/config.js> < tokens.json');
  process.exit(2);
}
const input = JSON.parse(readFileSync(0, 'utf8'));
const tokens = (input.tokens || []).map(t => String(t).trim()).filter(Boolean);
const bad = tokens.filter(t => !t.startsWith('sk-ant-oat') || t.length !== 108).length;
if (!tokens.length || bad) {
  // Count only — never print a token or a prefix of one.
  console.error(`refusing: ${tokens.length} tokens, ${bad} not sk-ant-oat/108 chars`);
  process.exit(1);
}
const expiresAt = Number(input.expiresAt) || Date.now() + 360 * 24 * 60 * 60 * 1000;
const accounts = tokens.map((t, i) => ({
  name: `lt-${i + 1}`, type: 'oauth', source: 'setup-token', accessToken: t, expiresAt,
}));
const { atomicConfigUpdate } = await import(configModule);
await atomicConfigUpdate(cfg => { cfg.accounts = accounts; });
console.log('accounts now:', accounts.map(a => a.name).join(' '));
