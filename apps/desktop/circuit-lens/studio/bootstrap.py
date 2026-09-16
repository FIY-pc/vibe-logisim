from __future__ import annotations

import argparse
from pathlib import Path
import secrets
import sys
import threading
import webbrowser
from studio.application.workspace import Workspace
from studio.domain.errors import LensError
from studio.infrastructure.files import default_state_root
from studio.infrastructure.lease import StateRootLease
from studio.transport.desktop import DesktopControl
from studio.transport.http import Handler, LensHTTPServer

def find_repo_root(start: Path) -> Path:
    current = start.resolve()
    for candidate in (current, *current.parents):
        if (candidate / "apps" / "desktop" / "package.json").is_file():
            return candidate
    raise RuntimeError("Cannot find repository root from Circuit Lens server path.")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the local Vibe Logisim workspace")
    parser.add_argument("circuit", nargs="?", type=Path, help="optional .circ file to open")
    parser.add_argument("--host", default="127.0.0.1", help="listen host; local access only")
    parser.add_argument("--port", type=int, default=8765, help="listen port; use 0 for an ephemeral port")
    parser.add_argument("--state-dir", type=Path, default=default_state_root())
    parser.add_argument("--no-browser", action="store_true", help="do not open the UI automatically")
    parser.add_argument(
        "--desktop-control",
        action="store_true",
        help="accept the Electron parent's narrow JSON-lines control channel on stdin",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.host not in {"127.0.0.1", "localhost"}:
        print("Circuit Lens v0 only binds to localhost.", file=sys.stderr)
        return 64
    script_dir = Path(__file__).resolve().parents[1]
    repo_root = find_repo_root(script_dir)
    lease = StateRootLease(args.state_dir)
    try:
        lease.acquire()
    except LensError as error:
        print(f"{error.code}: {error.message}", file=sys.stderr)
        return 73
    server: LensHTTPServer | None = None
    try:
        app = Workspace(repo_root, args.state_dir, script_dir / "lensctl.py", lease.owner_id)
        if args.circuit:
            app.open_path(args.circuit)
        server = LensHTTPServer((args.host, args.port), Handler, app, script_dir / "web")
        host, port = server.server_address[:2]
        url = f"http://{host}:{port}/"
        app.set_base_url(url.rstrip("/"))
        if args.desktop_control:
            server.control_token = secrets.token_urlsafe(32)
            control = DesktopControl(server)
            control.send(
                {
                    "event": "ready",
                    "baseUrl": url.rstrip("/"),
                    "statePath": str(app.state_root / "current.json"),
                    "controlToken": server.control_token,
                }
            )
            threading.Thread(
                target=control.serve,
                name="circuit-lens-desktop-control",
                daemon=True,
            ).start()
        else:
            print(f"Circuit Lens: {url}", flush=True)
            print(f"State: {app.state_root / 'current.json'}", flush=True)
        if not args.no_browser and not args.desktop_control:
            threading.Timer(0.35, lambda: webbrowser.open(url)).start()
        try:
            server.serve_forever(poll_interval=0.25)
        except KeyboardInterrupt:
            pass
    except LensError as error:
        print(f"{error.code}: {error.message}", file=sys.stderr)
        return 65
    finally:
        if server is not None:
            app.close()
            server.server_close()
        lease.release()
    return 0

