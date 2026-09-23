from __future__ import annotations

import json
from pathlib import Path
import sys
import threading
from http import HTTPStatus
from studio.domain.errors import DESKTOP_CONTROL_SCHEMA, LensError
from studio.domain.tool_errors import CircuitToolError, ERROR_SCHEMA

class DesktopControl:
    """Narrow, parent-process-only control channel carried over stdin/stdout."""

    def __init__(self, server: LensHTTPServer):
        self.server = server
        self.write_lock = threading.Lock()

    def send(self, value: dict[str, Any]) -> None:
        value = {"schema": DESKTOP_CONTROL_SCHEMA, **value}
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        with self.write_lock:
            sys.stdout.write(encoded + "\n")
            sys.stdout.flush()

    def serve(self) -> None:
        try:
            for line in sys.stdin:
                if len(line) > 128 * 1024:
                    self.send(
                        {
                            "ok": False,
                            "error": {
                                "code": "CONTROL_MESSAGE_TOO_LARGE",
                                "message": "Desktop control message is too large.",
                            },
                        }
                    )
                    continue
                self._handle(line)
        except BaseException:
            # Say why the service is going away; a bare daemon-thread death
            # leaves the parent with nothing but ECONNREFUSED.
            import traceback
            sys.stderr.write("[circuit-lens] desktop control channel failed:\n" + traceback.format_exc())
            sys.stderr.flush()
            raise
        finally:
            # The Electron parent owns this process. EOF means that owner is
            # gone, so do not leave an orphaned localhost service behind.
            sys.stderr.write("[circuit-lens] desktop control channel closed (stdin EOF); shutting down\n")
            sys.stderr.flush()
            self.server.shutdown()

    def _handle(self, line: str) -> None:
        request_id: str | None = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise LensError(
                    HTTPStatus.BAD_REQUEST,
                    "INVALID_DESKTOP_CONTROL",
                    "Desktop control request must be a JSON object.",
                )
            raw_id = request.get("id")
            if not isinstance(raw_id, (str, int)) or not str(raw_id) or len(str(raw_id)) > 64:
                raise LensError(
                    HTTPStatus.BAD_REQUEST,
                    "INVALID_DESKTOP_CONTROL_ID",
                    "Desktop control request requires a short id.",
                )
            request_id = str(raw_id)
            if request.get("schema") != DESKTOP_CONTROL_SCHEMA:
                raise LensError(
                    HTTPStatus.BAD_REQUEST,
                    "INVALID_DESKTOP_CONTROL_SCHEMA",
                    "Desktop control schema does not match this service.",
                )
            method = request.get("method")
            if method not in {"open-path", "reload", "agent-bundle", "set-folder", "move-path"}:
                raise LensError(
                    HTTPStatus.NOT_FOUND,
                    "UNKNOWN_DESKTOP_CONTROL_METHOD",
                    "The desktop channel only supports open-path and reload.",
                )
            if method == "move-path":
                from studio.project.relocation import move_workspace_path
                result = move_workspace_path(self.server.app, request.get("folderId"), request.get("from"), request.get("to"))
                self.send({"id": request_id, "ok": True, "result": result})
                return
            if method == "set-folder":
                result = self.server.app.set_folder(request.get("folder"), request.get("clear", False))
                self.send({"id": request_id, "ok": True, "result": result})
                return
            if method == "agent-bundle":
                from studio.collaboration.bundle import export_bundle
                self.send({"id": request_id, "ok": True, "result": export_bundle(
                    self.server.app, request.get("revisionId"), request.get("candidateId"))})
                return
            if method == "reload":
                session = self.server.app.reload()
                self.send(
                    {
                        "id": request_id,
                        "ok": True,
                        "result": {
                            "revisionId": session["revision"]["id"],
                            "sourceName": session["source"]["name"],
                        },
                    }
                )
                return
            raw_path = request.get("path")
            if not isinstance(raw_path, str) or not raw_path.strip():
                raise LensError(
                    HTTPStatus.BAD_REQUEST,
                    "INVALID_DESKTOP_PATH",
                    "open-path requires a non-empty path.",
                )
            source = Path(raw_path).expanduser()
            if source.suffix.lower() != ".circ":
                raise LensError(
                    HTTPStatus.BAD_REQUEST,
                    "INVALID_DESKTOP_PATH",
                    "The desktop channel only opens .circ files.",
                )
            session = self.server.app.open_path(source)
            self.send(
                {
                    "id": request_id,
                    "ok": True,
                    "result": {
                        "revisionId": session["revision"]["id"],
                        "sourceName": session["source"]["name"],
                    },
                }
            )
        except CircuitToolError as error:
            self.send({"id": request_id, "ok": False,
                       "errorSchema": ERROR_SCHEMA, "error": error.as_dict()})
        except LensError as error:
            self.send(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {"code": error.code, "message": error.message},
                }
            )
        except (json.JSONDecodeError, UnicodeError) as error:
            self.send(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {
                        "code": "INVALID_DESKTOP_CONTROL_JSON",
                        "message": str(error),
                    },
                }
            )
        except Exception as error:
            self.send(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {
                        "code": "DESKTOP_CONTROL_FAILED",
                        "message": str(error),
                    },
                }
            )
