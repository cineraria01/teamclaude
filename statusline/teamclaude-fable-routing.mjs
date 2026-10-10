// Load with: node --import /path/teamclaude-fable-routing.mjs /path/teamclaude server
// Kept outside the npm package so reinstalling TeamClaude does not erase it.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function applyFableRouting(AccountManager) {
  const p = AccountManager.prototype;
  if (p.fableResetRouting) return;
  for (const method of ['_weeklyResetTime', '_priority', 'getActiveAccount', '_tryAcquire', 'getStatus']) {
    if (typeof p[method] !== 'function') {
      throw new Error(`Fable routing: incompatible TeamClaude (missing ${method})`);
    }
  }
  const { getActiveAccount, _tryAcquire, getStatus } = p;

  p._weeklyResetTime = function (account) {
    const q = account.quota;
    const reset = q.unified7dFableReset ?? q.modelWeekly?.['7d_oi']?.reset;
    return Number.isFinite(reset) && reset > Date.now() ? reset : Infinity;
  };
  // This service is automatic: a leftover `switch`/priority must never pin it.
  p._priority = () => Infinity;
  p.getActiveAccount = function (exclude = null) {
    this.lastEvalAt = -Infinity;
    this.reevalIntervalMs = 1;
    // Retain upstream warm-up, health checks, exclusion and recovery behavior.
    return getActiveAccount.call(this, exclude);
  };
  p._tryAcquire = function (exclude = null) {
    // Existing sockets, including queued requests, must also follow reset order.
    // Capacity limits, reservation and failover stay in the upstream method.
    return _tryAcquire.call(this, exclude, null);
  };
  p.getStatus = function () {
    return { ...getStatus.call(this), routingPolicy: 'fable-reset' };
  };
  p.fableResetRouting = true;
}

if (process.argv[2] === 'server') {
  const entry = pathToFileURL(realpathSync(process.argv[1]));
  const { AccountManager } = await import(new URL('./account-manager.js', entry));
  applyFableRouting(AccountManager);
  console.log('[TeamClaude] Fable reset routing active (automatic, no account pinning)');
}
