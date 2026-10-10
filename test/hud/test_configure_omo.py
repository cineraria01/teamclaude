import json
from pathlib import Path
import subprocess
import tempfile
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from configure_omo import configure  # noqa: E402


class ConfigureOmoTest(unittest.TestCase):
    def test_proxy_auth_and_preservation(self):
        with tempfile.TemporaryDirectory(prefix="omo 'quoted' ") as temporary:
            home = Path(temporary)
            (home / ".config").mkdir()
            agent = home / ".omo/agent"
            agent.mkdir(parents=True)
            (agent / "settings.json").write_text('{"theme":"dark","retry":{"maxRetries":2}}')
            (agent / "auth.json").write_text('{"keep":"existing-login"}')
            catalogs = {}
            for name, port in [("teamclaude", 3456), ("teamcodex", 3457)]:
                (home / f".config/{name}.json").write_text(json.dumps({"proxy": {"port": port, "apiKey": "test-secret"}}))
                catalogs[name] = {"model": {"id": "model", "provider": "original", "api": "original", "baseUrl": "https://upstream"}}
            configure(home, catalogs)
            raw = (agent / "models.json").read_text()
            self.assertNotIn("test-secret", raw)
            providers = json.loads(raw)["providers"]
            claude = providers["teamclaude"]
            self.assertIn("sk-ant-oat", claude["apiKey"])
            command = claude["headers"]["Authorization"][1:]
            self.assertEqual(subprocess.check_output(command, shell=True, text=True).strip(), "Bearer test-secret")
            self.assertEqual(providers["teamcodex"]["baseUrl"], "http://127.0.0.1:3457/codex")
            self.assertFalse(providers["teamcodex"]["models"][0]["compat"]["supportsMaxOutputTokens"])
            settings = json.loads((agent / "settings.json").read_text())
            self.assertEqual(settings["theme"], "dark")
            self.assertEqual(settings["retry"], {"maxRetries": 2, "modelFallback": False})
            self.assertEqual(settings["defaultModel"], "claude-opus-5-5")
            self.assertEqual((agent / "auth.json").read_text(), '{"keep":"existing-login"}')
            configure(home, catalogs)
            self.assertEqual((agent / "models.json").read_text(), raw)
            self.assertTrue(list(agent.glob("settings.json.backup-proxy-*")))
            self.assertEqual((agent / "models.json").stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
