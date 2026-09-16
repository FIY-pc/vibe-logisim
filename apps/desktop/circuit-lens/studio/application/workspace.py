from __future__ import annotations

import contextlib
from functools import partial
import json
import os
from pathlib import Path
import threading
from http import HTTPStatus
from studio.application.tools import Workbench
from studio.project.history import ProjectHistory
from studio.runtime.simulation import Simulation
from studio.runtime.rendering import ViewportRenderer
from studio.application.circuits import CircuitQueries
from studio.application.comparison import ComparisonService
from studio.application.focus import FocusService
from studio.application.review import ReviewService
from studio.application.service import ApplicationService
from studio.domain.errors import LENS_SCHEMA, LensError
from studio.infrastructure.files import read_json, sha256_bytes, sha256_file
from studio.project.store import ProjectStore
from studio.runtime.geometry import circuit_summary
from studio.runtime.observer import ObserverRuntime
from studio.runtime.snapshot_inspection import inspect_snapshot

class Workspace:
    def __init__(self, repo_root: Path, state_root: Path, lensctl_path: Path, owner_id: str):
        self.repo_root = repo_root
        self.state_root = state_root.expanduser().resolve()
        self.state_root.mkdir(parents=True, exist_ok=True)
        self.lensctl_path = lensctl_path.resolve()
        self.owner_id = owner_id
        self.folder = None
        self.observer = ObserverRuntime(repo_root, self.state_root)
        self.lock = threading.RLock()
        self.base_url: str | None = None
        self.project_store = ProjectStore(
            repo_root,
            self.state_root,
            self.observer,
            lambda: {
                "ownerId": self.owner_id,
                "baseUrl": self.base_url,
                "pid": os.getpid(),
                "projectId": self.history.record["id"] if getattr(self, "history", None) and self.history.record else None,
            },
        )
        self.workbench = Workbench(self)
        self.history = ProjectHistory(self)
        self.simulation = Simulation(self)
        self.renderer = ViewportRenderer(repo_root, self.state_root, worker=self.observer.worker)
        self.circuits_service = CircuitQueries(self)
        self.comparison = ComparisonService(self)
        self.focus = FocusService(self)
        self.review_service = ReviewService(self)
        self.application = ApplicationService(self, inspect_snapshot=partial(
            inspect_snapshot, repo_root=repo_root, state_root=self.state_root, observer=self.observer,
        ))

    def __getattr__(self, name: str):
        store = self.__dict__.get("project_store")
        if store is not None:
            try:
                return getattr(store, name)
            except AttributeError:
                pass
        raise AttributeError(name)

    def set_folder(self, folder, clear=False):
        with self.lock:
            self.folder = folder
            if clear:
                from studio.project.store import ProjectState
                self.simulation.close()
                self.history.record = None
                self.project_store.state = ProjectState()
                self.project_store.refresh_pointer()
            return self.session()

    def close(self) -> None:
        with self.lock:
            self.simulation.close()
            self.renderer.close()
            self.observer.close()

    def set_base_url(self, url: str) -> None:
        with self.lock:
            self.base_url = url
            self._write_current_pointer()

    def open_path(self, path: Path) -> dict[str, Any]:
        source = path.expanduser().resolve()
        with self.lock:
            if self.history.known_path(source):
                # A deleted/missing source does not delete persisted working state.
                # It blocks saving, but the user can still recover/export the project.
                return self.history.open(source, None, source.name)
        if not source.is_file():
            raise LensError(HTTPStatus.NOT_FOUND, "SOURCE_NOT_FOUND", f"No file: {source}")
        try:
            data = source.read_bytes()
        except OSError as error:
            raise LensError(HTTPStatus.BAD_REQUEST, "SOURCE_UNREADABLE", str(error)) from error
        with self.lock:
            return self.history.open(source, data, source.name)

    def open_upload(self, data: bytes, filename: str) -> dict[str, Any]:
        if not data:
            raise LensError(HTTPStatus.BAD_REQUEST, "EMPTY_UPLOAD", "The uploaded file is empty.")
        clean_name = Path(filename or "uploaded.circ").name
        if not clean_name.endswith(".circ"):
            clean_name += ".circ"
        with self.lock:
            return self.history.open(None, data, clean_name)

    def _open_bytes(
        self, data: bytes, mode: str, filename: str, source_path: Path | None, *, package=None
    ) -> dict[str, Any]:
        with self.lock:
            self.project_store.open_bytes(data, mode, filename, source_path, package=package)
        return self.session()

    def _require(self) -> None:
        self.project_store.require()

    def _write_current_pointer(self) -> None:
        self.project_store.refresh_pointer()

    def source_status(self) -> dict[str, Any]:
        self._require()
        if self.history.record:
            return self.history.disk_status()
        if self.source_mode != "path" or self.source_path is None:
            return {
                "canReload": False,
                "exists": None,
                "changed": False,
                "stale": False,
                "currentSha256": None,
                "reason": "Uploads have no source path to monitor.",
            }
        if not self.source_path.is_file():
            return {
                "canReload": False,
                "exists": False,
                "changed": True,
                "stale": True,
                "currentSha256": None,
                "reason": "The source file no longer exists; the frozen revision is still available.",
            }
        try:
            current = sha256_file(self.source_path)
        except OSError as error:
            return {
                "canReload": False,
                "exists": True,
                "changed": True,
                "stale": True,
                "currentSha256": None,
                "reason": f"The source cannot be read: {error}",
            }
        changed_dependencies = self.package.changed_dependencies() if self.package else []
        changed = current != self.artifact_sha256 or bool(changed_dependencies)
        return {
            "canReload": changed,
            "exists": True,
            "changed": changed,
            "stale": changed,
            "currentSha256": current,
            "changedDependencies": changed_dependencies,
            "reason": (
                "Source bytes differ. Reload creates a new revision and does not migrate selection or review."
                if changed
                else "The source bytes still match this frozen revision."
            ),
        }

    def _base_capabilities(self) -> dict[str, Any]:
        issue = self.runtime_error or self.observer.prerequisite_error()
        external_block = bool(self.package and not self.package.supported)
        profile = self._geometry_profile() if issue or external_block else self.observer.profile()
        return {
            "geometry": True,
            "selection": True,
            "reviewBundles": True,
            "sourceWrite": bool(self.source_path),
            "exactConnectivity": None if not issue and not external_block else False,
            "taskQueries": None if not issue and not external_block else False,
            "dynamicValues": False,
            "crossRevisionIdentity": False,
            "connectivityAuthority": (
                "Experiment 001 exact Logisim-ITA runtime observer"
                if not issue and not external_block
                else None
            ),
            "observationProfile": profile,
            "profile": profile,
            "relativeExternalLibraries": {
                "descriptors": self.external_relative,
                "supported": not external_block,
                "mode": (
                    "external libraries require dependency freezing; geometry only"
                    if external_block
                    else "frozen course libraries" if self.external_libraries else "no external libraries"
                ),
            },
            "revisionScope": {
                "artifactBytesFrozen": True,
                "externalLibrariesFrozen": not external_block,
                "externalLibraryDescriptors": self.external_libraries,
                "dependencies": [{"name": d["name"], "sha256": d["sha256"]} for d in self.package.dependencies],
            },
        }

    def _geometry_profile(self) -> dict[str, Any]:
        identity = {
            "kind": "raw-xml-geometry",
            "version": "v0",
            "sourceDeclaration": self.raw_project.get("sourceVersion") if self.raw_project else None,
        }
        return {
            **identity,
            "id": sha256_bytes(
                json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ),
            "status": "geometry-only",
            "display": (
                f"Raw XML geometry · declared source {self.raw_project.get('sourceVersion')}"
                if self.raw_project and self.raw_project.get("sourceVersion")
                else "Raw XML geometry · runtime unverified"
            ),
        }

    def session(self) -> dict[str, Any]:
        with self.lock:
            if self.project_store.pointer_error:
                self.project_store.refresh_pointer()
            if not self.revision_id or not self.revision_dir or not self.raw_project:
                return {
                    "schema": LENS_SCHEMA,
                    "folder": self.folder,
                    "revision": None,
                    "source": None,
                    "sourceStatus": {
                        "canReload": False,
                        "exists": None,
                        "changed": False,
                        "stale": False,
                        "currentSha256": None,
                        "reason": "No circuit is open.",
                    },
                    "project": None,
                    "activeCircuit": None,
                    "selection": None,
                    "review": None,
                    "lastQuery": None,
                    "capabilities": {
                        "geometry": False,
                        "selection": False,
                        "reviewBundles": False,
                        "sourceWrite": False,
                        "exactConnectivity": None,
                        "taskQueries": None,
                        "dynamicValues": False,
                        "crossRevisionIdentity": False,
                        "connectivityAuthority": None,
                    },
                    "statePaths": {
                        "root": str(self.state_root),
                        "current": str(self.state_root / "current.json"),
                        "workspace": None,
                        "selection": None,
                        "review": None,
                        "lastQuery": None,
                    },
                }
            selection = read_json(self.revision_dir / "selection.json")
            review = read_json(self.revision_dir / "review.json")
            if selection and review and (
                review.get("selectionId") != selection.get("id")
                or review.get("observationProfileId") != selection.get("observationProfileId")
            ):
                review = None
            last_query = read_json(self.revision_dir / "last-query.json")
            if selection and last_query and last_query.get("selectionId") != selection.get("id"):
                last_query = None
            return {
                "schema": LENS_SCHEMA,
                "folder": self.folder,
                "revision": {
                    "id": self.revision_id,
                    "artifactSha256": self.artifact_sha256,
                    "frozenPath": str(self.frozen_path),
                    "openedAt": self.opened_at,
                },
                "source": {
                    "mode": self.source_mode,
                    "name": self.source_name,
                    "path": str(self.source_path) if self.source_path else None,
                    "directory": str(self.source_path.parent) if self.source_path else None,
                },
                "sourceStatus": self.source_status(),
                "workspace": self.history.summary(),
                "connectionIndex": {"available": self.project_store.pointer_error is None,
                                    "error": self.project_store.pointer_error},
                "project": circuit_summary(self.raw_project),
                "componentCatalogId": self.application.placement.catalog_identity(),
                "activeCircuit": selection["circuit"] if selection else self.raw_project["mainCircuit"],
                "selection": selection,
                "review": review,
                "lastQuery": last_query,
                "capabilities": self._base_capabilities(),
                "statePaths": {
                    "root": str(self.state_root),
                    "current": str(self.state_root / "current.json"),
                    "workspace": str(self.revision_dir / "metadata.json"),
                    "selection": str(self.revision_dir / "selection.json"),
                    "review": str(self.revision_dir / "review.json"),
                    "lastQuery": str(self.revision_dir / "last-query.json"),
                },
            }

    def circuits(self) -> dict[str, Any]:
        session = self.session()
        project = session.get("project")
        return {
            "schema": LENS_SCHEMA,
            "revision": session.get("revision"),
            "mainCircuit": project.get("mainCircuit") if project else None,
            "activeCircuit": session.get("activeCircuit"),
            "circuits": project.get("circuits", []) if project else [],
        }

    def health(self) -> dict[str, Any]:
        issue = self.observer.prerequisite_error()
        return {
            "schema": LENS_SCHEMA,
            "ok": True,
            "service": "circuit-lens",
            "workspaceOpen": bool(self.revision_id),
            "revisionId": self.revision_id,
            "observerPrerequisites": {
                "available": issue is None,
                "error": issue,
            },
        }

    def reload(self) -> dict[str, Any]:
        with self.lock:
            self._require()
            return self.history.reload()

    @contextlib.contextmanager
    def observation_artifact(self) -> Iterator[Path]:
        """Yield only the frozen artifact; never materialize inside the source tree."""
        self._require()
        if self.package and not self.package.supported:
            raise RuntimeError(
                " ".join(self.package.errors)
            )
        if self.runtime_error:
            raise RuntimeError(self.runtime_error)
        self.package.verify_frozen(self.revision_dir)
        yield self.frozen_path

    def _raw_circuit(self, *args, **kwargs):
        return self.circuits_service._raw_circuit(*args, **kwargs)

    def _raw_view(self, *args, **kwargs):
        return self.circuits_service._raw_view(*args, **kwargs)

    def circuit_view(self, *args, **kwargs):
        return self.circuits_service.circuit_view(*args, **kwargs)

    def _transform_exact(self, *args, **kwargs):
        return self.circuits_service._transform_exact(*args, **kwargs)

    def _validate_rectangle(self, *args, **kwargs):
        return self.focus._validate_rectangle(*args, **kwargs)

    def _string_list(self, *args, **kwargs):
        return self.focus._string_list(*args, **kwargs)

    def save_selection(self, *args, **kwargs):
        return self.focus.save_selection(*args, **kwargs)

    def _agent_message(self, *args, **kwargs):
        return self.focus._agent_message(*args, **kwargs)

    def _bound_selection(self, *args, **kwargs):
        return self.focus._bound_selection(*args, **kwargs)

    def get_selection(self, *args, **kwargs):
        return self.focus.get_selection(*args, **kwargs)

    def query(self, *args, **kwargs):
        return self.focus.query(*args, **kwargs)

    def _default_review(self, *args, **kwargs):
        return self.review_service._default_review(*args, **kwargs)

    def get_review(self, *args, **kwargs):
        return self.review_service.get_review(*args, **kwargs)

    def put_review(self, *args, **kwargs):
        return self.review_service.put_review(*args, **kwargs)

