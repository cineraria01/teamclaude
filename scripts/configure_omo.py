#!/usr/bin/env python3
"""Connect OmO Native to existing local TeamClaude and TeamCodex pools."""

import argparse
import datetime
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile


def save(path, data):
    if path.exists():
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        backup = path.with_name(path.name + ".backup-proxy-" + stamp)
        shutil.copy2(path, backup)
        backup.chmod(0o600)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def configure(home, catalogs):
    directory = home / ".omo/agent"
    models_path, settings_path = directory / "models.json", directory / "settings.json"
    models = json.loads(models_path.read_text()) if models_path.exists() else {}
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    providers = models.setdefault("providers", {})
    for name, api, suffix in [("teamclaude", "anthropic-messages", ""),
                              ("teamcodex", "openai-responses", "/codex")]:
        config = home / ".config" / (name + ".json")
        proxy = json.loads(config.read_text())["proxy"]
        if not isinstance(proxy.get("apiKey"), str) or not proxy["apiKey"]:
            raise ValueError(f"{name}: proxy.apiKey is required")
        port = int(proxy["port"])
        if not 1 <= port <= 65535:
            raise ValueError(f"{name}: invalid proxy port")
        expression = ('import json,pathlib; print(' +
                      ('"Bearer "+' if name == "teamclaude" else '') +
                      f'json.loads(pathlib.Path({str(config)!r}).read_text())["proxy"]["apiKey"])')
        key = "!python3 -c " + shlex.quote(expression)
        entries = []
        for source in catalogs[name].values():
            if source["id"].endswith("-fast"):
                continue  # Fast aliases require separate service-tier handling.
            model = {k: v for k, v in source.items() if k not in ("provider", "baseUrl", "api")}
            if name == "teamcodex":
                model["compat"] = {**model.get("compat", {}),
                                   "supportsMaxOutputTokens": False, "supportsLongCacheRetention": False}
                model["samplingParams"] = {"instructions": "You are an AI coding assistant. Follow the developer instructions and user request."}
            entries.append(model)
        if not entries:
            raise ValueError(f"{name}: installed OmO model catalog is empty")
        provider = {"baseUrl": f"http://127.0.0.1:{port}{suffix}", "api": api,
                    "apiKey": key, "models": entries}
        if name == "teamclaude":
            # Senpi selects OAuth payload/tool formatting by this marker. It is
            # NOT a credential: Authorization below supplies the real proxy key.
            provider["apiKey"] = "sk-ant-oat-teamclaude-proxy"
            provider["headers"] = {"Authorization": key}
        providers[name] = provider
    settings.update(defaultProvider="teamclaude", defaultModel="claude-opus-5-5",
                    enabledModels=["teamclaude/*", "teamcodex/*"])
    # Account failover belongs to the pools; do not fall back to direct logins.
    settings.setdefault("retry", {})["modelFallback"] = False
    directory.mkdir(parents=True, exist_ok=True)
    save(models_path, models)
    save(settings_path, settings)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--senpi-dir", type=Path, help="Installed @code-yeongyu/senpi directory")
    args = parser.parse_args()
    senpi = args.senpi_dir or Path.home() / ".bun/install/global/node_modules/@code-yeongyu/senpi"
    base = senpi.resolve() / "node_modules/@earendil-works/pi-ai/dist/providers"
    imports = [("teamclaude", "anthropic", "ANTHROPIC_MODELS"),
               ("teamcodex", "chatgpt-subscription", "CHATGPT_SUBSCRIPTION_MODELS")]
    code = "\n".join(f'import {{ {symbol} as {name} }} from {json.dumps((base / (file + ".models.js")).as_uri())};'
                     for name, file, symbol in imports)
    result = subprocess.check_output(["node", "--input-type=module", "-e",
                                      code + "\nconsole.log(JSON.stringify({teamclaude,teamcodex}));"], text=True)
    configure(Path.home(), json.loads(result))
    print("Configured OmO: teamclaude/claude-opus-5-5 (default), teamcodex models available.")
    print("Restart OmO. Existing settings have timestamped backups; pool logins are unchanged.")


if __name__ == "__main__":
    main()
