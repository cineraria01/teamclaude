from __future__ import annotations

import http.client
import os
import selectors
import shutil
import signal
import subprocess
import sys
import termios
from contextlib import closing
from urllib.parse import parse_qs, urlsplit


def local_url(url: str, path: str) -> int:
    parsed = urlsplit(url)
    if (parsed.scheme != 'http' or parsed.hostname not in ('localhost', '127.0.0.1', '::1')
            or parsed.username is not None or parsed.password is not None
            or parsed.path != path or parsed.fragment
            or parsed.port is None or not 1024 <= parsed.port <= 65535):
        raise ValueError('Expected a local Codex login URL.')
    return parsed.port


def login_context(url: str) -> tuple[str, int]:
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc != 'auth.openai.com' or parsed.path != '/oauth/authorize':
        raise ValueError('Expected the Codex authorization URL.')
    query = parse_qs(parsed.query, keep_blank_values=True)
    if len(query.get('state', [])) != 1 or not query['state'][0] or len(query.get('redirect_uri', [])) != 1:
        raise ValueError('Missing login state or redirect URI.')
    return query['state'][0], local_url(query['redirect_uri'][0], '/auth/callback')


def forward_callback(url: str, expected: tuple[str, int]) -> None:
    if len(url) > 16384 or any(ord(char) < 32 for char in url):
        raise ValueError('Invalid callback URL.')
    state, port = expected
    if local_url(url, '/auth/callback') != port:
        raise ValueError('Callback port does not match this login.')
    parsed = urlsplit(url)
    query = parse_qs(parsed.query, keep_blank_values=True)
    if query.get('state') != [state]:
        raise ValueError('Callback belongs to a different login. Use the current browser link.')
    if len(query.get('code', [])) != 1 or not query['code'][0]:
        raise ValueError('Callback has no authorization code. Complete browser login first.')
    with closing(http.client.HTTPConnection('127.0.0.1', port, timeout=30)) as connection:
        connection.request('GET', parsed.path + '?' + parsed.query)
        with connection.getresponse() as response:
            response.read()
            if response.status != 302:
                raise ValueError(f'Login callback failed (HTTP {response.status}).')
            location = response.getheader('Location', '')
        target = urlsplit(location)
        if target.path != '/success' or target.fragment or target.netloc and local_url(location, '/success') != port:
            raise ValueError('Unexpected login completion redirect.')
        if target.scheme and not target.netloc:
            raise ValueError('Invalid login completion redirect.')
        connection.request('GET', target.path + ('?' + target.query if target.query else ''))
        with connection.getresponse() as response:
            response.read()
            if response.status != 200:
                raise ValueError(f'Login completion failed (HTTP {response.status}).')


def login(arguments: list[str]) -> int:
    proxy = shutil.which('teamcodex')
    if not proxy:
        print('TeamCodex is missing. Run: python3 install.py', file=sys.stderr)
        return 1
    if '--help' in arguments or '-h' in arguments:
        print('Usage: teamcodex login [--name NAME] [--device-auth]\n'
              'Open the browser link with the account you want to add.\n'
              'On a remote machine, paste the final localhost callback URL here and press Enter.\n'
              'The callback is hidden while typing. Ctrl-C cancels login.')
        return 0
    if '--device-auth' in arguments:
        return subprocess.call([proxy, 'login', *arguments])
    terminal = termios.tcgetattr(sys.stdin) if sys.stdin.isatty() else None
    if terminal is not None:
        hidden = termios.tcgetattr(sys.stdin)
        hidden[3] &= ~termios.ECHO
        termios.tcsetattr(sys.stdin, termios.TCSANOW, hidden)
    try:
        with subprocess.Popen([proxy, 'login', *arguments], stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              start_new_session=True) as process:
            try:
                assert process.stdout is not None
                with selectors.SelectSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ, 'output')
                    selector.register(sys.stdin, selectors.EVENT_READ, 'input')
                    context: tuple[str, int] | None = None
                    pending: bytes = b''
                    submitted = False
                    while selector.get_map():
                        for key, _ in selector.select(0.2):
                            if key.fd == process.stdout.fileno():
                                chunk = os.read(process.stdout.fileno(), 4096)
                                if not chunk:
                                    if pending:
                                        print(pending.decode(errors='replace'), flush=True)
                                    return process.wait()
                                pending += chunk
                                while b'\n' in pending:
                                    line, pending = pending.split(b'\n', 1)
                                    text = line.decode(errors='replace').rstrip('\r')
                                    print(text, flush=True)
                                    if text.startswith('https://auth.openai.com/oauth/authorize?'):
                                        context = login_context(text)
                                        print('\n다른 계정은 시크릿 창에서 로그인하세요.\n'
                                              '마지막 localhost 콜백 주소를 붙여넣고 Enter (입력 숨김, Ctrl-C 취소):', flush=True)
                            else:
                                raw = sys.stdin.readline()
                                if not raw:
                                    selector.unregister(sys.stdin)
                                    if not submitted:
                                        print('Login cancelled: input closed.', file=sys.stderr)
                                        return 1
                                    continue
                                if context is None:
                                    print('Wait for the browser login link first.', flush=True)
                                    continue
                                try:
                                    forward_callback(raw.strip(), context)
                                except (ValueError, OSError, http.client.HTTPException):
                                    message = 'Callback rejected or local login server unavailable. Check the address and current login link.'
                                    print(message + '\nPaste the callback again, or Ctrl-C to cancel.', flush=True)
                                else:
                                    submitted = True
                                    print('콜백 전달 완료. 계정 등록을 기다립니다.', flush=True)
                    return process.wait()
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
    except KeyboardInterrupt:
        print('\nLogin cancelled.', file=sys.stderr)
        return 130
    except (OSError, ValueError) as error:
        print(f'Could not start login: {error}', file=sys.stderr)
        return 1
    finally:
        if terminal is not None:
            termios.tcsetattr(sys.stdin, termios.TCSANOW, terminal)
