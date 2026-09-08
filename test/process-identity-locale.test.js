import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// `readProcessIdentity` (src/index.js) and the cmux guard both parse `ps -o lstart=`,
// and both assume the POSIX form — a fixed 24 characters, "Tue Sep  8 17:05:19 2026".
// Under any other locale `ps` prints its own format and the parse fails, which on the
// author's ko_KR machine meant `status` reported "lifecycle identity unverified" and
// `remove`/`disable`/`priority` refused to live-reload the worker ("The running server
// does not support account-only live reload"). Both call sites now pin LC_ALL=C.
//
// This test only runs where a non-POSIX locale is actually installed, which is the case
// on a developer Mac but usually not on a minimal CI image, so it skips rather than
// failing there. What it pins is the contract the fix relies on: forcing LC_ALL=C makes
// `ps` emit the 24-character form no matter what the ambient locale is.

const IDENTITY_RE = /^(\d+)\s+(.{24})\s+([\s\S]+)$/;

function psIdentity(env) {
  const result = spawnSync(
    'ps',
    ['-o', 'ppid=', '-o', 'lstart=', '-o', 'command=', '-p', String(process.pid)],
    { encoding: 'utf8', env },
  );
  if (result.status !== 0 || !result.stdout?.trim()) return null;
  return result.stdout.trim().match(IDENTITY_RE);
}

function availableNonPosixLocale() {
  if (process.platform === 'win32') return null;
  const listed = spawnSync('locale', ['-a'], { encoding: 'utf8' });
  if (listed.status !== 0) return null;
  return listed.stdout
    .split('\n')
    .map(line => line.trim())
    .find(line => /^(ko_KR|ja_JP|zh_CN|de_DE|fr_FR)\.UTF-?8$/i.test(line)) || null;
}

test('LC_ALL=C keeps ps lstart parseable under a non-POSIX ambient locale', t => {
  const locale = availableNonPosixLocale();
  if (!locale) {
    t.skip('no non-POSIX UTF-8 locale installed on this machine');
    return;
  }

  // Ambient locale only: this is what the bug looked like. We deliberately do not assert
  // that it fails — a locale whose ps output happens to be 24 characters would be fine,
  // and the point of the fix is that we no longer depend on which locale is set.
  const ambient = psIdentity({ ...process.env, LC_ALL: locale });

  // Forced C locale: this is what both call sites now do, and it must always parse.
  const forced = psIdentity({ ...process.env, LC_ALL: 'C' });

  assert.ok(forced, `ps output must parse under LC_ALL=C (ambient locale ${locale} parsed: ${Boolean(ambient)})`);
  assert.equal(Number(forced[1]), process.ppid);
  assert.equal(forced[2].trim().length, 24);
  // The startedAt field must be something `new Date` accepts — cmux-process-guard.js
  // feeds it straight to `new Date(...).getTime()`, and an unparseable value silently
  // became NaN there.
  assert.ok(Number.isFinite(new Date(forced[2].trim()).getTime()), 'startedAt must be Date-parseable');
});
