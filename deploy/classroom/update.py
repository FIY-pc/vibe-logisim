"""Update an existing systemd deployment; preserve data, credentials and the previous release."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("release")
parser.add_argument("sha256")
args = parser.parse_args()
if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}", args.release):
    raise RuntimeError("Invalid release identifier")
root = Path("/home/ubuntu/apps/vibe-logisim-classroom").resolve(strict=True)
source = root / "incoming/classroom-server.mjs"
if hashlib.sha256(source.read_bytes()).hexdigest() != args.sha256.lower():
    raise RuntimeError("Release checksum mismatch")
current = root / "current"
if not current.is_symlink():
    raise RuntimeError("Expected current to be a release symlink")
previous = current.resolve(strict=True)
if not previous.is_relative_to(root / "releases"):
    raise RuntimeError("Previous release is outside releases")
stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
backup = root / "backups" / (stamp + "-before-" + args.release)
backup.mkdir(mode=0o700, parents=True)
database = root / "data/classroom.sqlite"
with sqlite3.connect(database) as live, sqlite3.connect(backup / "classroom.sqlite") as saved:
    live.backup(saved)
os.chmod(backup / "classroom.sqlite", 0o600)
for name, path in [("classroom.sqlite.ai-key", root / "data/classroom.sqlite.ai-key"), ("classroom.env", root / "classroom.env")]:
    shutil.copy2(path, backup / name)
    os.chmod(backup / name, 0o600)
snippet = Path("/etc/nginx/snippets/vibe-classroom-location.conf")
shutil.copy2(snippet, backup / "nginx-location.conf")
release = root / "releases" / args.release
release.mkdir(mode=0o750, exist_ok=True)
target = release / "classroom-server.mjs"
if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() != args.sha256.lower():
    raise RuntimeError("Refusing to overwrite a different release")
shutil.copy2(source, target)

def run(*command):
    subprocess.run(command, check=True)

def switch(destination):
    temporary = root / ("current.next-" + stamp)
    if temporary.exists() or temporary.is_symlink():
        raise RuntimeError("Temporary release link already exists")
    temporary.symlink_to(destination)
    os.replace(temporary, current)

try:
    run("sudo", "-n", "install", "-m", "644", str(root / "incoming/nginx-location.conf"), str(snippet))
    run("sudo", "-n", "nginx", "-t")
    switch(release)
    run("sudo", "-n", "systemctl", "restart", "vibe-classroom")
    for attempt in range(30):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8810/api/health", timeout=2) as response:
                assert json.load(response)["ok"]
            break
        except Exception:
            if attempt == 29:
                raise
            time.sleep(0.3)
    run("sudo", "-n", "systemctl", "reload", "nginx")
except Exception:
    if current.resolve() != previous:
        switch(previous)
    run("sudo", "-n", "install", "-m", "644", str(backup / "nginx-location.conf"), str(snippet))
    run("sudo", "-n", "nginx", "-t")
    run("sudo", "-n", "systemctl", "restart", "vibe-classroom")
    # Never restore a database automatically: it could erase writes made after the backup.
    raise
(root / "deployment.json").write_text(json.dumps({"commit": args.release, "sha256": args.sha256.lower(), "deployedAt": stamp, "previous": previous.name, "backup": backup.name}, indent=2) + "\n")
print("Deployment healthy; database and credentials preserved. Backup:", backup.name)
