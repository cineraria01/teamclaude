#!/usr/bin/env node
// Remove a Codex pool account and revoke that machine's refresh token at OpenAI.
//
// usage:
//   TEAMCLAUDE_CONFIG=~/.config/teamcodex.json \
//     node codex-remove-account.mjs <teamcodex src dir> <email or account name>
//
// <teamcodex src dir> is the fork install's src/ (…/teamcodex-global/lib/node_modules/
// teamcodex/src). revokeCodexRefreshToken exists only in the fork; an older install
// still removes the account but cannot revoke — update it (INSTALL-ALL.md §1).
// Afterwards send SIGHUP to the Codex pool worker (teamcodex.server.json workerPid).
const [src, target] = process.argv.slice(2);
if (!src || !target) {
  console.error('usage: node codex-remove-account.mjs <teamcodex src dir> <email or account name>');
  process.exit(2);
}
const { atomicConfigUpdate } = await import(`${src}/config.js`);
const codex = await import(`${src}/codex.js`);
const removed = [];
await atomicConfigUpdate(cfg => {
  cfg.accounts = (cfg.accounts || []).filter(a => {
    const hit = a.email === target || a.name === target;
    if (hit) removed.push({ name: a.name, refreshToken: a.refreshToken });
    return !hit;
  });
});
if (!removed.length) console.log(`not found: ${target}`);
for (const r of removed) {
  let res;
  if (typeof codex.revokeCodexRefreshToken !== 'function') {
    res = { ok: false, message: 'this install has no revokeCodexRefreshToken (update the fork)' };
  } else {
    try { res = await codex.revokeCodexRefreshToken(r.refreshToken); } catch (e) { res = { ok: false, message: e.message }; }
  }
  // Never print the token itself.
  console.log(`removed ${r.name} | revoke ok=${res.ok} status=${res.status ?? '-'}${res.ok ? '' : ` ${String(res.message || '').slice(0, 80)}`}`);
}
