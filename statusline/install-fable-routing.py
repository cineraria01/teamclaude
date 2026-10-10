#!/usr/bin/env python3
"""Install the routing preload in an existing macOS TeamClaude LaunchAgent."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--plist', type=Path, default=Path.home() / 'Library/LaunchAgents/com.hyeongsu.teamclaude.plist')
parser.add_argument('--destination', type=Path, default=Path.home() / '.claude/teamclaude-fable-routing.mjs')
args = parser.parse_args()
source = Path(__file__).with_name('teamclaude-fable-routing.mjs')
with args.plist.open('rb') as f:
    service = plistlib.load(f)
command = service['ProgramArguments']
if len(command) < 3 or command[-1] != 'server':
    parser.error('Expected an existing node /path/teamclaude server LaunchAgent')
entry = Path(command[-2]).resolve()
if not (entry.parent / 'account-manager.js').is_file():
    parser.error('Cannot find TeamClaude account-manager.js beside the server entry')

# Verify against THIS installed package before touching the running service.
subprocess.run([command[0], str(source.with_name('test_fable_routing.mjs')), str(entry)], check=True)
backup = args.plist.with_name(args.plist.name + '.pre-fable-routing')
if not backup.exists():
    shutil.copy2(args.plist, backup)
args.destination.parent.mkdir(parents=True, exist_ok=True)
temporary_module = args.destination.with_name(args.destination.name + '.tmp')
shutil.copyfile(source, temporary_module)
os.replace(temporary_module, args.destination)
preload = str(args.destination.resolve())
if not any(command[i:i + 2] == ['--import', preload] for i in range(len(command) - 1)):
    command[1:1] = ['--import', preload]
temporary_plist = args.plist.with_name(args.plist.name + '.tmp')
with temporary_plist.open('wb') as f:
    plistlib.dump(service, f)
shutil.copymode(args.plist, temporary_plist)
os.replace(temporary_plist, args.plist)
print(f'Installed Fable routing in {args.plist}; reload this LaunchAgent after requests drain.')
