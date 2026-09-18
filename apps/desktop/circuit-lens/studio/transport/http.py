from __future__ import annotations

import json
import mimetypes
from pathlib import Path
import secrets
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit
import xml.etree.ElementTree as ET
from studio.domain.errors import LensError, MAX_UPLOAD_BYTES
from studio.infrastructure.files import sha256_bytes

class LensHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], app: Workspace, web_root: Path):
        super().__init__(address, handler)
        self.app = app
        self.web_root = web_root
        self.control_token = None


class Handler(BaseHTTPRequestHandler):
    server: LensHTTPServer

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("[circuit-lens] " + format % args + "\n")

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        if self.command == "GET" and urlsplit(self.path).path in {"/api/review", "/api/simulation"}:
            try:
                if int(code) < 400:
                    return
            except (TypeError, ValueError):
                pass
        super().log_request(code, size)

    def _json(self, status: int, value: Any) -> None:
        data = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def _validate_local_request(self, mutation: bool = False) -> None:
        host_value = self.headers.get("Host", "")
        try:
            host = urlsplit("//" + host_value)
            host_port = host.port or 80
        except ValueError as error:
            raise LensError(HTTPStatus.FORBIDDEN, "INVALID_HOST", "Invalid Host header") from error
        if host.hostname not in {"127.0.0.1", "localhost"} or host_port != self.server.server_port:
            raise LensError(
                HTTPStatus.FORBIDDEN,
                "NON_LOCAL_HOST",
                "Circuit Lens accepts only its own localhost origin.",
            )
        if not mutation:
            return
        protected = urlsplit(self.path).path in {"/api/open", "/api/reload", "/api/agent/tool", "/api/candidate/working-copy"} or urlsplit(self.path).path.startswith("/api/project/")
        if protected and self.server.control_token and not secrets.compare_digest(
                self.headers.get("X-Vibe-Control", ""), self.server.control_token):
            raise LensError(HTTPStatus.FORBIDDEN, "DESKTOP_OWNER_REQUIRED", "这项操作需要由桌面工作区发起")
        origin_value = self.headers.get("Origin")
        if origin_value:
            try:
                origin = urlsplit(origin_value)
                origin_port = origin.port or (80 if origin.scheme == "http" else 443)
            except ValueError as error:
                raise LensError(HTTPStatus.FORBIDDEN, "INVALID_ORIGIN", "Invalid Origin header") from error
            if (
                origin.scheme != "http"
                or origin.hostname not in {"127.0.0.1", "localhost"}
                or origin_port != self.server.server_port
            ):
                raise LensError(
                    HTTPStatus.FORBIDDEN,
                    "CROSS_ORIGIN_MUTATION",
                    "Cross-origin changes are not allowed.",
                )
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise LensError(
                HTTPStatus.FORBIDDEN,
                "CROSS_SITE_MUTATION",
                "Cross-site changes are not allowed.",
            )

    def _read_body(self, maximum: int = MAX_UPLOAD_BYTES) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise LensError(HTTPStatus.BAD_REQUEST, "INVALID_LENGTH", "Invalid Content-Length") from error
        if length < 0 or length > maximum:
            raise LensError(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                "BODY_TOO_LARGE",
                f"Request body exceeds {maximum} bytes.",
            )
        data = self.rfile.read(length)
        if len(data) != length:
            raise LensError(HTTPStatus.BAD_REQUEST, "INCOMPLETE_BODY", "Request body was truncated.")
        return data

    def _read_json(self) -> dict[str, Any]:
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise LensError(
                HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                "JSON_CONTENT_TYPE_REQUIRED",
                "This endpoint requires Content-Type: application/json.",
            )
        data = self._read_body(16 * 1024 * 1024)
        try:
            value = json.loads(data.decode("utf-8")) if data else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise LensError(HTTPStatus.BAD_REQUEST, "INVALID_JSON", str(error)) from error
        if not isinstance(value, dict):
            raise LensError(HTTPStatus.BAD_REQUEST, "INVALID_JSON", "JSON body must be an object.")
        return value

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Allow", "GET, POST, PUT, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self) -> None:
        try:
            self._validate_local_request()
            parsed = urlsplit(self.path)
            if parsed.path.startswith("/api/"):
                raise LensError(HTTPStatus.METHOD_NOT_ALLOWED, "HEAD_NOT_SUPPORTED", "Use GET for JSON APIs.")
            self._serve_static(parsed.path, head_only=True)
        except LensError as error:
            data = (json.dumps(error.as_json(), ensure_ascii=False) + "\n").encode("utf-8")
            self.send_response(error.status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()

    def do_GET(self) -> None:
        try:
            self._validate_local_request()
            parsed = urlsplit(self.path)
            if parsed.path == "/api/session":
                self._json(HTTPStatus.OK, self.server.app.session())
            elif parsed.path == "/api/interface":
                args={k:v[0] for k,v in parse_qs(parsed.query).items()}
                try:self._json(HTTPStatus.OK,self.server.app.application.interfaces.read(args))
                except ValueError as error:raise LensError(HTTPStatus.CONFLICT,'INTERFACE_UNAVAILABLE',str(error)) from error
            elif parsed.path in {"/api/simulation", "/api/simulation/observation"}:
                with self.server.app.lock:
                    try:
                        query = parse_qs(parsed.query)
                        sim = self.server.app.simulation
                        result = sim.status(since=query.get("since", [None])[0]) if parsed.path == "/api/simulation" else sim.observation(
                            query.get("revisionId", [None])[0], query.get("id", [None])[0], query.get("circuit", [None])[0])
                    except ValueError as error:
                        raise LensError(HTTPStatus.CONFLICT, "SIMULATION_CONFLICT", str(error)) from error
                self._json(HTTPStatus.OK, result)
            elif parsed.path == "/api/moments":
                query = {k:v[0] for k,v in parse_qs(parsed.query).items()}
                with self.server.app.lock:
                    try:
                        moments=self.server.app.application.moments
                        result=moments.read(query.get('projectId'),query['id']) if query.get('id') else moments.list(query.get('projectId'))
                        self._json(HTTPStatus.OK,result)
                    except ValueError as error:raise LensError(HTTPStatus.CONFLICT,'MOMENT_UNAVAILABLE',str(error)) from error
            elif parsed.path == "/api/health":
                self._json(HTTPStatus.OK, self.server.app.health())
            elif parsed.path == "/api/agent/plugin":
                self._json(HTTPStatus.OK, self.server.app.workbench.plugin_manifest())
            elif parsed.path == "/api/render/viewport":
                values = {key: value[0] for key, value in parse_qs(parsed.query).items()}
                data = self.server.app.circuits_service.render_viewport(values)
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "private, no-store")
                self.end_headers()
                self.wfile.write(data)
            elif parsed.path == "/api/render":
                query = parse_qs(parsed.query)
                app = self.server.app
                with app.lock:
                    app._require()
                    if query.get("revisionId", [None])[0] != app.revision_id:
                        raise LensError(HTTPStatus.CONFLICT, "STALE_RENDER", "电路版本已改变")
                    profile = app.observer.profile()
                    if query.get("profileId", [None])[0] != profile["id"]:
                        raise LensError(HTTPStatus.CONFLICT, "STALE_RENDER", "运行环境已改变")
                    name = query.get("name", [""])[0]
                    app._raw_circuit(name)
                    file = app.revision_dir / "exact" / profile["id"] / (sha256_bytes(name.encode()) + ".png")
                    if not file.is_file():
                        raise LensError(HTTPStatus.NOT_FOUND, "NO_RENDER", "电路图尚未生成")
                    data = file.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "private, max-age=31536000, immutable")
                self.end_headers()
                self.wfile.write(data)
            elif parsed.path == "/api/candidates":
                with self.server.app.lock:
                    self._json(HTTPStatus.OK, {"candidates": self.server.app.workbench.list()})
            elif parsed.path == "/api/project/download":
                query = parse_qs(parsed.query)
                with self.server.app.lock:
                    try:
                        data = self.server.app.history.archive(query.get("projectId", [None])[0], query.get("revisionId", [None])[0])
                    except ValueError as error:
                        raise LensError(HTTPStatus.CONFLICT, "PROJECT_EXPORT_UNAVAILABLE", str(error)) from error
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Disposition", 'attachment; filename="vibe-logisim-project.zip"')
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            elif parsed.path in {"/api/project/history", "/api/project/history/render"}:
                query = parse_qs(parsed.query)
                with self.server.app.lock:
                    history = self.server.app.history
                    arguments = [query.get("projectId", [None])[0], query.get("changeId", [None])[0]]
                    try:
                        if parsed.path.endswith("/render"):
                            data = history.render(*arguments, query.get("circuit", [None])[0])
                        else:
                            self._json(HTTPStatus.OK, history.review(*arguments))
                            return
                    except ValueError as error:
                        raise LensError(HTTPStatus.CONFLICT, "HISTORY_UNAVAILABLE", str(error)) from error
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            elif parsed.path in {"/api/comparison", "/api/comparison/render"}:
                args = {key:value[0] for key,value in parse_qs(parsed.query).items()}
                try:
                    if parsed.path.endswith('/render'):
                        data = self.server.app.comparison.render(args)
                        self.send_response(HTTPStatus.OK)
                        self.send_header("Content-Type", "image/png")
                        self.send_header("Content-Length", str(len(data)))
                        self.send_header("Cache-Control", "private, no-store")
                        self.end_headers()
                        self.wfile.write(data)
                    else: self._json(HTTPStatus.OK, self.server.app.comparison.describe(args))
                except ValueError as error:
                    raise LensError(HTTPStatus.CONFLICT, "COMPARISON_UNAVAILABLE", str(error)) from error
            elif parsed.path == "/api/candidate/diff":
                query = parse_qs(parsed.query)
                with self.server.app.lock:
                    result = self.server.app.workbench.diff(query.get("id", [None])[0])
                self._json(HTTPStatus.OK, result)
            elif parsed.path in {"/api/candidate/render", "/api/candidate/download"}:
                query = parse_qs(parsed.query)
                candidate_id = query.get("id", [None])[0]
                with self.server.app.lock:
                    directory, metadata = self.server.app.workbench._metadata(candidate_id, allow_applied=True)
                    if parsed.path.endswith("download"):
                        data = self.server.app.workbench.archive(candidate_id)
                        content_type = "application/zip"
                    else:
                        name = query.get("circuit", [None])[0]
                        if not any(c["circuit"] == name for c in metadata["changes"]):
                            raise ValueError("Unknown changed module")
                        suffix = "-before" if query.get("side", [None])[0] == "before" else ""
                        data = (directory / (sha256_bytes(name.encode()) + suffix + ".png")).read_bytes()
                        content_type = "image/png"
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                if content_type == "application/zip":
                    self.send_header("Content-Disposition", 'attachment; filename="vibe-logisim-candidate.zip"')
                self.end_headers()
                self.wfile.write(data)
            elif parsed.path == "/api/circuits":
                self._json(HTTPStatus.OK, self.server.app.circuits())
            elif parsed.path == "/api/selection":
                query = parse_qs(parsed.query)
                self._json(
                    HTTPStatus.OK,
                    self.server.app.get_selection(
                        query.get("revisionId", [None])[0],
                        query.get("selectionId", [None])[0],
                    ),
                )
            elif parsed.path == "/api/review":
                self._json(HTTPStatus.OK, self.server.app.get_review())
            elif parsed.path == "/api/circuit":
                query = parse_qs(parsed.query)
                name = query.get("name", [None])[0]
                if not name:
                    session = self.server.app.session()
                    name = session["activeCircuit"]
                self._json(HTTPStatus.OK, self.server.app.circuit_view(name))
            elif parsed.path.startswith("/api/"):
                raise LensError(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Unknown API endpoint")
            else:
                self._serve_static(parsed.path)
        except LensError as error:
            self._json(error.status, error.as_json())
        except Exception as error:
            self._json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                LensError(HTTPStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", str(error)).as_json(),
            )

    def do_POST(self) -> None:
        try:
            self._validate_local_request(mutation=True)
            parsed = urlsplit(self.path)
            if parsed.path == "/api/open":
                content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                if content_type not in {"application/octet-stream", "application/xml", "text/xml"}:
                    raise LensError(
                        HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                        "CIRC_CONTENT_TYPE_REQUIRED",
                        "Upload raw bytes as application/octet-stream, application/xml, or text/xml.",
                    )
                filename = self.headers.get("X-Filename") or parse_qs(parsed.query).get(
                    "filename", ["uploaded.circ"]
                )[0]
                self._json(HTTPStatus.CREATED, self.server.app.application.open_upload(self._read_body(), unquote(filename)))
            elif parsed.path == "/api/agent/tool":
                body = self._read_json()
                try:
                    result = self.server.app.application.agent_tool(body)
                except ValueError as error:
                    raise LensError(HTTPStatus.UNPROCESSABLE_ENTITY, "CIRCUIT_TOOL_REJECTED", str(error)) from error
                self._json(HTTPStatus.OK, result)
            elif parsed.path == "/api/memory":
                from studio.runtime.simulation import memory_page
                body = self._read_json()
                with self.server.app.lock:
                    w = self.server.app
                    try:
                        w.history._check(body.get("projectId"), body.get("revisionId"))
                        view = w.circuit_view(body.get("circuit"))["circuit"]
                        c = next((c for c in view["components"] if c["componentId"] == body.get("componentId")), None)
                        if not c or c["factory"] != "ROM":
                            raise ValueError("请选择 ROM；RAM 需在运行实例中查看")
                        request = ET.Element("memory", circuit=body["circuit"], factory=c["factory"], componentId=c["componentId"],
                            offset=str(int(body.get("offset", 0))), count="64", **{k: str(v) for k, v in c["location"].items()})
                        with w.observation_artifact() as artifact:
                            page = memory_page(w.workbench._native(Path(artifact), request).find("memory"))
                        result = {"revisionId": w.revision_id, "circuit": body["circuit"], **page}
                    except ValueError as error:
                        raise LensError(HTTPStatus.CONFLICT, "MEMORY_CONFLICT", str(error)) from error
                self._json(HTTPStatus.OK, result)
            elif parsed.path == "/api/moments":
                try:self._json(HTTPStatus.OK,self.server.app.application.moments.action(self._read_json()))
                except ValueError as error:raise LensError(HTTPStatus.CONFLICT,'MOMENT_UNAVAILABLE',str(error)) from error
            elif parsed.path == "/api/simulation":
                try:
                    result = self.server.app.application.simulation_action(self._read_json())
                except ValueError as error:
                    raise LensError(HTTPStatus.CONFLICT, "SIMULATION_CONFLICT", str(error)) from error
                self._json(HTTPStatus.OK, result)
            elif parsed.path in {"/api/interface/preview", "/api/project/interface"}:
                body=self._read_json()
                try:
                    service=self.server.app.application.interfaces
                    result=service.prepare(body) if parsed.path.endswith('/preview') else self.server.app.application.project_action('interface',body)
                except ValueError as error:raise LensError(HTTPStatus.CONFLICT,'INTERFACE_CONFLICT',str(error)) from error
                self._json(HTTPStatus.OK,result)
            elif parsed.path in {"/api/components/catalog", "/api/components/template"}:
                try:
                    self._json(HTTPStatus.OK, self.server.app.application.placement.query(parsed.path.rsplit("/", 1)[-1], self._read_json()))
                except ValueError as error:
                    raise LensError(HTTPStatus.CONFLICT, "COMPONENT_UNAVAILABLE", str(error)) from error
            elif parsed.path == "/api/layout/preview":
                body=self._read_json()
                try:self._json(HTTPStatus.OK,self.server.app.application.layout_preview(body))
                except ValueError as error:
                    raise LensError(HTTPStatus.CONFLICT,"LAYOUT_PREVIEW_UNAVAILABLE",str(error)) from error
            elif parsed.path in {"/api/project/apply", "/api/project/restore", "/api/project/save", "/api/project/edit", "/api/project/place", "/api/project/move", "/api/project/wire", "/api/project/delete", "/api/project/undo"}:
                body = self._read_json()
                with self.server.app.lock:
                    history = self.server.app.history
                    arguments = [body.get("projectId"), body.get("revisionId")]
                    try:
                        result = self.server.app.application.project_action(parsed.path.rsplit("/", 1)[-1], body)
                    except ValueError as error:
                        raise LensError(HTTPStatus.CONFLICT, "PROJECT_STATE_CONFLICT", str(error)) from error
                self._json(HTTPStatus.OK, result)
            elif parsed.path == "/api/candidate/working-copy":
                body = self._read_json()
                try:
                    result = self.server.app.workbench.working_copy(body.get("revisionId"), body.get("candidateId"))
                except ValueError as error:
                    raise LensError(HTTPStatus.CONFLICT, "CANDIDATE_UNAVAILABLE", str(error)) from error
                self._json(HTTPStatus.CREATED, result)
            elif parsed.path == "/api/reload":
                self._read_body(1024)
                self._json(HTTPStatus.CREATED, self.server.app.reload())
            elif parsed.path == "/api/selection":
                self._json(HTTPStatus.CREATED, self.server.app.save_selection(self._read_json()))
            elif parsed.path == "/api/query":
                self._json(HTTPStatus.OK, self.server.app.query(self._read_json()))
            else:
                raise LensError(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Unknown API endpoint")
        except LensError as error:
            self._json(error.status, error.as_json())
        except Exception as error:
            self._json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                LensError(HTTPStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", str(error)).as_json(),
            )

    def do_PUT(self) -> None:
        try:
            self._validate_local_request(mutation=True)
            parsed = urlsplit(self.path)
            if parsed.path == "/api/review":
                self._json(HTTPStatus.OK, self.server.app.put_review(self._read_json()))
            else:
                raise LensError(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Unknown API endpoint")
        except LensError as error:
            self._json(error.status, error.as_json())
        except Exception as error:
            self._json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                LensError(HTTPStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", str(error)).as_json(),
            )

    def _serve_static(self, request_path: str, head_only: bool = False) -> None:
        relative = "index.html" if request_path in {"", "/"} else unquote(request_path).lstrip("/")
        candidate = (self.server.web_root / relative).resolve()
        try:
            candidate.relative_to(self.server.web_root.resolve())
        except ValueError as error:
            raise LensError(HTTPStatus.FORBIDDEN, "STATIC_PATH_FORBIDDEN", "Invalid static path") from error
        if not candidate.is_file():
            if relative != "index.html" and (self.server.web_root / "index.html").is_file():
                candidate = self.server.web_root / "index.html"
            else:
                raise LensError(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Circuit Lens UI is not present.")
        data = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type + ("; charset=utf-8" if content_type.startswith("text/") else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if not head_only:
            self.wfile.write(data)
