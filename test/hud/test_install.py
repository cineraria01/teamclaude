import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def check() -> None:
    with tempfile.TemporaryDirectory() as directory:
        home = Path(directory)
        prefix = home / 'local with spaces'
        fakebin = home / 'bin'
        fakebin.mkdir()
        (fakebin / 'env').symlink_to('/usr/bin/env')
        (fakebin / 'python3').symlink_to(sys.executable)
        npm = fakebin / 'npm'
        npm.write_text(f'#!{sys.executable}\n' + '''
from pathlib import Path
import sys
assert sys.argv[1:4] == ['install', '--global', '--prefix']
assert sys.argv[5] == '--ignore-scripts'
assert sys.argv[6] == 'git+https://github.com/cineraria01/teamclaude.git#qjc/resilient-routing', sys.argv[6]
entry = Path(sys.argv[4]) / 'lib/node_modules/teamcodex/src/index.js'
entry.parent.mkdir(parents=True)
entry.write_text('unused test entry')
''')
        npm.chmod(0o755)
        for name in ('node', 'git', 'systemctl', 'loginctl'):
            tool = fakebin / name
            tool.write_text(f'#!{sys.executable}\n' + '''
import json, os, sys
print(json.dumps({'argv': sys.argv[1:], 'provider': os.environ.get('TEAMCLAUDE_PROVIDER'), 'config': os.environ.get('TEAMCLAUDE_CONFIG'), 'locale': os.environ.get('LC_ALL')}))
''')
            tool.chmod(0o755)
        env = {**os.environ, 'HOME': str(home), 'PATH': str(fakebin),
               'TEAMCODEX_HUD_PREFIX': str(prefix)}
        installer = str(Path(__file__).resolve().parents[2] / 'scripts/install.py')
        # Older installs kept the footer as a separate copy with `tcodex` and `teamcodex-statusline` links;
        # the footer now ships in the proxy package, so the installer removes them.
        legacy = prefix / 'share/teamcodex-statusline'
        legacy.mkdir(parents=True)
        (prefix / 'bin').mkdir(parents=True)
        (prefix / 'bin/tcodex').symlink_to(legacy / 'tcodex.py')
        (prefix / 'bin/teamcodex-statusline').symlink_to(legacy / 'statusline.py')
        (prefix / 'bin/keep').symlink_to(home / 'elsewhere')
        options = ['--service'] if sys.platform == 'linux' else []
        result = subprocess.run([sys.executable, installer, *options], env=env,
                                check=False, capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, result.stderr
        command = prefix / 'bin/teamcodex'
        result = subprocess.run([str(command), '--help'], env=env, check=False, capture_output=True, text=True)
        data = json.loads(result.stdout)
        assert data['provider'] == 'codex'
        assert data['locale'] == 'C'
        assert data['config'] == str(home / '.config/teamcodex.json')
        assert data['argv'][1:] == ['codex', '--help']
        # -c after `exec` drops TeamCodex's root provider overrides (Codex then fails with a 401), so the
        # wrapper refuses it before starting node; -c before `exec` and non-exec commands pass through.
        for bad in (['run', '--', 'exec', '--ignore-user-config', '-m', 'm', '-c', 'model_reasoning_effort=high', '-'],
                    ['run', '--', 'exec', '-cmodel_reasoning_effort=high', '-'],
                    ['run', '--', 'exec', '--config=model_reasoning_effort=high', '-'],
                    ['run', '--', '-c', 'a=b', 'e', '--config', 'x=y', '-']):
            result = subprocess.run([str(command), *bad], env=env, check=False, capture_output=True, text=True)
            assert result.returncode == 2, (bad, result.returncode, result.stdout)
            assert 'exec 앞에' in result.stderr and result.stdout == '', (bad, result.stderr)
        for good in (['run', '--', '-c', 'model_reasoning_effort=high', 'exec', '--ignore-user-config',
                      '-m', 'm', '-C', '/repo', '-'],
                     ['run', '--', 'exec', '-m', 'm', '--', '-c is prompt text'],
                     ['run', '--', 'resume', '-c', 'x=y'],
                     ['run', '--', '-m', 'm', 'chat about -c']):
            result = subprocess.run([str(command), *good], env=env, check=False, capture_output=True, text=True)
            assert result.returncode == 0, (good, result.stderr)
            assert json.loads(result.stdout)['argv'][2:] == good, (good, result.stdout)
        assert not legacy.exists() and (prefix / 'bin/keep').is_symlink()
        assert not (prefix / 'bin/tcodex').is_symlink() and not (prefix / 'bin/teamcodex-statusline').is_symlink()
        # Bare `teamcodex`, Codex flags and an interactive login open the footer launcher; the rest,
        # and a login without a terminal (the launcher's own child), stay with the proxy.
        launcher = prefix / 'share/teamcodex-global/lib/node_modules/teamcodex/src/hud/launcher.py'
        launcher.parent.mkdir()
        launcher.write_text(f'#!{sys.executable}\nimport json, sys\nprint(json.dumps({{"launcher": sys.argv[1:]}}))\n')
        for args in ([], ['--dangerously-bypass-approvals-and-sandbox'], ['--keep-alive'], ['--', 'resume', 'ID']):
            result = subprocess.run([str(command), *args], env=env, check=False, capture_output=True, text=True)
            assert json.loads(result.stdout) == {'launcher': args}, (args, result.stdout, result.stderr)
        for args in (['login', '--name', 'x'], ['status']):
            result = subprocess.run([str(command), *args], env=env, check=False, capture_output=True, text=True,
                                    stdin=subprocess.DEVNULL)
            assert json.loads(result.stdout)['argv'][1:] == ['codex', *args], (args, result.stdout)
        if sys.platform != 'linux':
            print('PASS: pinned proxy install, separate wrapper, spaces')
            return
        unit = home / '.config/systemd/user/teamcodex.service'
        assert 'Restart=always' in unit.read_text()
        assert f'ExecStart="{command}" server' in unit.read_text()
        unit.write_text('user-owned service')
        env['PATH'] = str(command.parent) + os.pathsep + str(fakebin)
        result = subprocess.run([sys.executable, installer, '--service'], env=env,
                                check=False, capture_output=True, text=True, timeout=10)
        assert result.returncode != 0 and unit.read_text() == 'user-owned service'
    print('PASS: pinned proxy install, separate wrapper, spaces, persistent unit, existing service preservation')


if __name__ == '__main__':
    check()
