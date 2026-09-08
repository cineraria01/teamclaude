import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

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

test('LC_TIME=C keeps ps lstart parseable under a non-POSIX ambient locale', t => {
  const locale = availableNonPosixLocale();
  if (!locale) {
    t.skip('no non-POSIX UTF-8 locale installed on this machine');
    return;
  }

  const ambient = psIdentity({ ...process.env, LC_ALL: locale });

  const forced = psIdentity({ ...process.env, LC_ALL: '', LC_TIME: 'C', LC_CTYPE: locale });

  assert.ok(forced, `ps output must parse under LC_TIME=C (ambient locale ${locale} parsed: ${Boolean(ambient)})`);
  assert.equal(Number(forced[1]), process.ppid);
  assert.equal(forced[2].trim().length, 24);
  assert.ok(Number.isFinite(new Date(forced[2].trim()).getTime()), 'startedAt must be Date-parseable');
});
