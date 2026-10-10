"""Offline login flow check: python3 test/hud/test_login.py. No OAuth or model calls."""

import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HUD = Path(__file__).resolve().parents[2] / "src/hud"
sys.path.insert(0, str(HUD))
from codex_login import forward_callback, login_context


def check() -> None:
    expected = ('current-state', 1455)
    for url in (
        'https://localhost:1455/auth/callback?code=secret&state=current-state',
        'http://example.com:1455/auth/callback?code=secret&state=current-state',
        'http://localhost:1456/auth/callback?code=secret&state=current-state',
        'http://localhost:1455/other?code=secret&state=current-state',
        'http://user@localhost:1455/auth/callback?code=secret&state=current-state',
        'http://localhost:1455/auth/callback?code=secret&state=stale',
        'http://localhost:1455/auth/callback?code=secret&state=current-state&state=',
        'http://localhost:1455/auth/callback?code=&state=current-state',
        'http://localhost:1455/auth/callback?code=secret&state=current-state#fragment',
        'http://local\nhost:1455/auth/callback?code=secret&state=current-state',
    ):
        try:
            forward_callback(url, expected)
        except ValueError:
            continue
        raise AssertionError('Unsafe callback accepted')
    assert login_context('https://auth.openai.com/oauth/authorize?state=s&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback') == ('s', 1455)
    class RedirectHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(302)
            self.send_header('Location', 'http://example.com:1455/success?code=do-not-send')
            self.end_headers()

        def log_message(self, format: str, *args: str) -> None:
            return

    with HTTPServer(('127.0.0.1', 0), RedirectHandler) as server:
        worker = threading.Thread(target=server.handle_request)
        worker.start()
        try:
            forward_callback(f'http://localhost:{server.server_port}/auth/callback?code=c&state=s', ('s', server.server_port))
        except ValueError:
            worker.join(timeout=2)
            assert not worker.is_alive()
        else:
            raise AssertionError('External completion redirect accepted')
    # Given a proxy CLI with a real loopback callback server, but no real account.
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        proxy = root / "teamcodex"
        proxy.write_text(f"#!{sys.executable}\n" + '''
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlencode
import sys

assert sys.argv[1:] == ['login', '--name', 'test-account'], sys.argv
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/auth/callback?code=test-code&state=test-state':
            self.send_response(302)
            self.send_header('Location', '/success')
        elif self.path == '/success':
            self.send_response(200)
        else:
            self.send_response(400)
        self.end_headers()
    def log_message(self, *args):
        return
with HTTPServer(('127.0.0.1', 0), Handler) as server:
    query = urlencode({'state': 'test-state', 'redirect_uri':
                       f'http://localhost:{server.server_port}/auth/callback'})
    print('https://auth.openai.com/oauth/authorize?' + query, flush=True)
    for _ in range(2):
        server.handle_request()
print('REGISTERED_TEST_ACCOUNT', flush=True)
''')
        proxy.chmod(0o755)
        env = {**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
               "HTTP_PROXY": "http://127.0.0.1:1", "ALL_PROXY": "http://127.0.0.1:1"}
        command = [sys.executable, str(HUD / "launcher.py"),
                   "login", "--name", "test-account"]
        # When login is launched and its own callback is pasted into stdin.
        with subprocess.Popen[str](command, env=env, stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True) as process:
            assert process.stdout is not None
            authorization = process.stdout.readline().strip()
            assert authorization.startswith('https://auth.openai.com/oauth/authorize?'), authorization
            query = parse_qs(urlsplit(authorization).query)
            callback = query['redirect_uri'][0] + '?code=test-code&state=test-state'
            output, _ = process.communicate(callback + '\n', timeout=10)
            # Then the server completed login, with no callback secret printed.
            assert process.returncode == 0, output
            assert 'REGISTERED_TEST_ACCOUNT' in output, output
            assert 'test-code' not in output, output
    print('PASS: login CLI, callback HTTP, account completion, no callback echo')


if __name__ == '__main__':
    check()
