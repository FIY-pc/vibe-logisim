"""Reproduce the Windows folder-open failure without Electron.

Start the Circuit Lens service exactly as Electron does, then do what
openFolder() does first: start a second stdio child (stand-in for codex.exe),
close its stdin, and `taskkill /t /f` it. Check whether the Python service
survives and its listener still accepts connections. Prints the service's
stderr so the reason is visible when it does not survive.
"""
import json, os, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"): _stream.reconfigure(encoding="utf-8", errors="backslashreplace")

repo = Path(__file__).resolve().parents[3]
server = Path(os.environ.get("VIBE_PROBE_SERVER") or (repo / "apps/desktop/circuit-lens/server.py")).resolve()
python = os.environ.get("VIBE_PROBE_PYTHON") or sys.executable
state = Path(tempfile.mkdtemp(prefix="vibe-probe-state-"))
env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONUTF8": "1"}
windows = os.name == "nt"

def spawn_service():
    return subprocess.Popen([python, "-u", str(server), "--host", "127.0.0.1", "--port", "0", "--no-browser",
                             "--desktop-control", "--state-dir", str(state)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                            cwd=str(server.parent), env=env)

def alive(base):
    try:
        with urllib.request.urlopen(base + "/api/health", timeout=5) as r: return json.loads(r.read()).get("ok") is True
    except Exception as error:
        return f"unreachable: {error}"

service = spawn_service()
ready = json.loads(service.stdout.readline()); base = ready["baseUrl"]
print("service ready:", base, "pid", service.pid)
print("health before:", alive(base))

# Stand-in for the Codex app-server child: a long-lived stdio process spawned
# the same way Electron spawns codex.exe (own console/process group).
sibling_kwargs = {}
if windows:
    sibling_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
sibling = subprocess.Popen([python, "-c", "import sys,time\nfor line in sys.stdin: pass\ntime.sleep(60)"],
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **sibling_kwargs)
time.sleep(0.5)
print("sibling pid", sibling.pid)
# 1) graceful: close stdin (what CodexBackend.stop() does first)
sibling.stdin.close()
time.sleep(1.0)
print("health after sibling stdin close:", alive(base), "| sibling exited:", sibling.poll())
# 2) forced: taskkill /t /f (what #terminateTree does on Windows)
if windows and sibling.poll() is None:
    subprocess.run(["taskkill.exe", "/pid", str(sibling.pid), "/t", "/f"], capture_output=True)
elif sibling.poll() is None:
    sibling.kill()
time.sleep(1.5)
health = alive(base)
print("health after sibling kill:", health)
service_alive = service.poll() is None
print("service process alive:", service_alive, "| exit code:", service.returncode)
service.stdin.close()
try: service.wait(timeout=10)
except subprocess.TimeoutExpired: service.kill(); service.wait()
err = service.stderr.read()
print("--- service stderr (non-request) ---")
print("\n".join(l for l in err.splitlines() if '"GET /' not in l)[-3000:])
sys.exit(0 if (service_alive and health is True) else 1)
