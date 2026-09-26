"""arrange_candidate through the production Workbench on a real course circuit.

usage: python3 apps/desktop/test/arrange-candidate.py <source.circ> <circuit> [out.circ]
Opens the file in an isolated state root exactly like the app does, calls
inspect_circuit for the artifactSha256, then arrange_candidate, then
checkout-equivalent readback of the candidate artifact. Prints the metrics.
"""
import json, shutil, sys, tempfile, time
from pathlib import Path

repo = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(repo / "apps/desktop/circuit-lens"))
if len(sys.argv) < 3:
    print(next((line.strip() for line in __doc__.splitlines() if line.strip().startswith("usage:")), "usage: see the module docstring"))
    sys.exit(2)
from studio.application.workspace import Workspace  # noqa: E402

src = Path(sys.argv[1]).resolve(); circuit = sys.argv[2]; out = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else None
state = Path(tempfile.mkdtemp(prefix="arrange-"))
work = state / "project"; work.mkdir()
for lib in src.parent.glob("*.jar"):
    shutil.copy(lib, work / lib.name)
target = work / src.name
shutil.copy(src, target)
ws = Workspace(repo, state / "state", repo / "apps/desktop/circuit-lens/lensctl.py", "test-owner")
session = ws.open_path(target)
revision = session["revision"]["id"]
wb = ws.workbench
t0 = time.time()
inspected = wb.call(revision, "inspect_circuit", {"circuit": circuit})
sha = inspected["artifactSha256"]
print(f"inspect: {inspected['counts']} sha={sha[:12]} ({time.time()-t0:.1f}s)")
t0 = time.time()
result = wb.call(revision, "arrange_candidate", {"circuit": circuit, "artifactSha256": sha, "title": "整理理想流水线"})
print(f"arrange_candidate: {time.time()-t0:.1f}s")
print(" candidate:", result["id"], "| netlist:", result["netlist"])
print(" arrangement:", json.dumps(result["arrangement"], ensure_ascii=False)[:600])
print(" readability before:", result["readability"]["before"])
print(" readability after :", result["readability"]["after"])
# render the candidate the way the model would
t0 = time.time()
render = wb.call(revision, "render_circuit", {"candidateId": result["id"], "circuit": circuit})
img = render.get("modelContentItems", [{}])[0].get("imageData", "")
print(f"render_circuit(candidate): {len(img)//1024} KiB base64 ({time.time()-t0:.1f}s)")
if out:
    import base64
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(ws.state_root / "candidates" / result["id"] / "artifact.circ", out)
    (out.with_suffix(".png")).write_bytes(base64.b64decode(img))
    print("wrote", out, out.with_suffix(".png"))
ws.close()
