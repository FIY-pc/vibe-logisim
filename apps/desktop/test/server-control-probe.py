"""Start the Circuit Lens Python server exactly as Electron does (stdio control
channel) and drive one folder-open sequence. Prints the server's stderr and exit
code so a platform-specific crash is diagnosable without Electron."""
import json, os, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"): _stream.reconfigure(encoding="utf-8", errors="backslashreplace")

repo = Path(__file__).resolve().parents[3]
server = repo / "apps/desktop/circuit-lens/server.py"
state = Path(tempfile.mkdtemp(prefix="vibe-probe-state-"))
folder = Path(tempfile.mkdtemp(prefix="vibe-probe-folder-")) / "我的电路 workspace"
folder.mkdir()
env = {**os.environ, "PYTHONUNBUFFERED": "1"}
env.pop("PYTHONUTF8", None); env.pop("PYTHONIOENCODING", None)
proc = subprocess.Popen([sys.executable, "-u", str(server), "--host", "127.0.0.1", "--port", "0", "--no-browser",
                         "--desktop-control", "--state-dir", str(state)],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                        cwd=str(repo), env=env)
ready = json.loads(proc.stdout.readline())
print("ready:", ready)
base = ready["baseUrl"]; token = ready.get("controlToken")
def http(path):
    req = urllib.request.Request(base + path, headers={"Accept": "application/json", **({"X-Vibe-Control": token} if token else {})})
    with urllib.request.urlopen(req, timeout=10) as r: return json.loads(r.read())
def control(method, **params):
    proc.stdin.write(json.dumps({"schema": "vibe-logisim.circuit-lens.desktop-control/v0", "id": method, "method": method, **params}) + "\n"); proc.stdin.flush()
    return json.loads(proc.stdout.readline())
print("health:", http("/api/health"))
print("session folder:", http("/api/session").get("folder"))
snapshot = {"id": "folder-test", "root": str(folder), "name": folder.name, "activeFile": None, "conversationKey": "folder:test"}
print("set-folder:", json.dumps(control("set-folder", folder=snapshot, clear=True))[:200])
circ = folder / "与门验证.circ"
circ.write_bytes((repo / "apps/desktop/electron/templates/blank.circ").read_bytes())
print("open-path:", control("open-path", path=str(circ)))
print("set-folder(active):", json.dumps(control("set-folder", folder={**snapshot, "activeFile": "与门验证.circ"}))[:200])
print("circuit main comps:", len(http("/api/circuit?name=main")["circuit"]["components"]))
time.sleep(0.5)
alive = proc.poll() is None
print("server alive after sequence:", alive)
proc.stdin.close()
try: proc.wait(timeout=10)
except subprocess.TimeoutExpired: proc.kill(); proc.wait()
err = proc.stderr.read()
print("exit code:", proc.returncode)
print("--- stderr (non-request lines) ---")
print("\n".join(l for l in err.splitlines() if '"GET /' not in l and '"POST /' not in l)[-4000:])
sys.exit(0 if alive else 1)
