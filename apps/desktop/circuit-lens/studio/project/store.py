"""Project snapshot storage and the active revision boundary.

The store owns bytes and snapshot identity. History decides why a snapshot
became current; runtime services only consume the active snapshot exposed by
the workspace facade.
"""
from __future__ import annotations

import json
import copy
from dataclasses import dataclass, field
from http import HTTPStatus
from pathlib import Path
from typing import Any, Callable

from studio.domain.errors import LENS_SCHEMA, LensError
from studio.infrastructure.files import (
    atomic_write_bytes,
    atomic_write_json,
    now_iso,
    sha256_bytes,
    sha256_file,
)
from studio.project.package import ProjectPackage
from studio.project.document import CircuitDocument
from studio.runtime.geometry import (
    external_library_descriptors,
    relative_external_libraries,
)


@dataclass
class ProjectState:
    revision_id: str | None = None
    revision_dir: Path | None = None
    frozen_path: Path | None = None
    source_mode: str | None = None
    source_path: Path | None = None
    source_name: str | None = None
    opened_at: str | None = None
    raw_project: dict[str, Any] | None = None
    document: CircuitDocument | None = None
    external_relative: list[str] = field(default_factory=list)
    external_libraries: list[str] = field(default_factory=list)
    package: ProjectPackage | None = None
    artifact_sha256: str | None = None
    runtime_error: str | None = None

class ProjectStore:
    """Own immutable revision artifacts and the active project snapshot."""

    def __init__(
        self,
        repo_root: Path,
        state_root: Path,
        observer,
        pointer_context: Callable[[], dict[str, Any]],
    ) -> None:
        self.repo_root = repo_root
        self.state_root = state_root
        self.observer = observer
        self._pointer_context = pointer_context
        self.state = ProjectState()
        self.project_directory = state_root / "projects"
        self.pointer_error = None

    def known_path(self, source: Path) -> dict[str, Any] | None:
        for file in self.project_directory.glob("project-*.json"):
            record = json.loads(file.read_text(encoding="utf-8"))
            if record.get("sourcePath") == str(source):
                return record
        return None

    def prepare_revision(self, record, revision) -> ProjectState:
        directory = self.state_root / "revisions" / revision
        source = Path(record["sourcePath"]) if record["sourcePath"] else None
        package = ProjectPackage.from_snapshot(directory, source)
        return self.freeze((directory / "artifact.circ").read_bytes(),
                           "path" if source else "upload", record["sourceName"], source, package=package)

    def commit(self, record, snapshot) -> None:
        """Commit the authoritative record before publishing the prepared state.

        The caller publishes its in-memory history before refreshing the derived
        connection pointer. No fallible snapshot preparation follows the commit.
        """
        runtime = None
        try:
            runtime = snapshot.package.runtime(self.repo_root)
        except ValueError as error:
            snapshot.runtime_error = str(error)
        atomic_write_json(self.project_directory / (record["id"] + ".json"), record)
        self.state = snapshot
        if runtime is not None:
            self.observer.runtime_jar = runtime

    def refresh_pointer(self) -> None:
        try:
            self.write_current_pointer()
            self.pointer_error = None
        except OSError as error:
            # The project record is already committed. A failed derived index
            # must never cause a rollback to a different in-memory revision.
            self.pointer_error = str(error)

    def __getattr__(self, name: str):
        # Keep the adapter facade small while old application services migrate
        # to explicit snapshot ports.
        state = object.__getattribute__(self, "state")
        if hasattr(state, name):
            return getattr(state, name)
        raise AttributeError(name)

    def freeze(
        self,
        data: bytes,
        mode: str,
        filename: str,
        source_path: Path | None,
        *,
        package: ProjectPackage | None = None,
        _document: CircuitDocument | None = None,
    ) -> ProjectState:
        """Persist a prepared snapshot without publishing it as the active project."""
        document = _document or CircuitDocument.parse(data, filename)
        if document.data != data:
            raise ValueError('Prepared document does not match the snapshot bytes')
        project = document.projection
        package = package or ProjectPackage(data, source_path)
        revision_id = package.revision_id
        revision_dir = self.state_root / "revisions" / revision_id
        frozen_path = revision_dir / "artifact.circ"
        self._freeze_file(frozen_path, data, package.artifact_sha256, "FROZEN_REVISION_CORRUPT")
        for name, payload in package.contents.items():
            self._freeze_file(
                revision_dir / name,
                payload,
                sha256_bytes(payload),
                "FROZEN_DEPENDENCY_CORRUPT",
                detail=name,
            )
        opened = now_iso()
        for resource_id, payload in package.resource_contents.items():
            resource_path = revision_dir / "resources" / (resource_id + ".xlsx")
            if resource_path.is_file() and resource_path.read_bytes() != payload:
                raise LensError(HTTPStatus.CONFLICT, "RESOURCE_SNAPSHOT_CORRUPT", resource_id)
            if not resource_path.is_file():
                atomic_write_bytes(resource_path, payload)
        metadata = {
            "schema": LENS_SCHEMA,
            "revisionId": revision_id,
            "artifactSha256": package.artifact_sha256,
            "sourceVersion": package.source_version,
            "dependencies": package.dependencies,
            "dependencyErrors": package.errors,
            "resources": package.resources,
            "openedAt": opened,
            "source": {
                "mode": mode,
                "name": filename,
                "path": str(source_path) if source_path else None,
                "directory": str(source_path.parent) if source_path else None,
            },
            "frozenPath": str(frozen_path),
        }
        if not (revision_dir / "metadata.json").is_file():
            atomic_write_json(revision_dir / "metadata.json", metadata)
        return ProjectState(
            revision_id=revision_id,
            revision_dir=revision_dir,
            frozen_path=frozen_path,
            source_mode=mode,
            source_path=source_path,
            source_name=filename,
            opened_at=opened,
            raw_project=project,
            document=document,
            external_relative=relative_external_libraries(project),
            external_libraries=external_library_descriptors(project),
            package=package,
            artifact_sha256=package.artifact_sha256,
        )

    def freeze_circuit(self, circuit) -> ProjectState:
        """Prepare a local edit; publication still belongs to ProjectHistory."""
        self.require()
        self.package.verify_frozen(self.revision_dir)
        document = self.state.document.replace_circuit(circuit)
        package = copy.deepcopy(self.package)
        package.replace_artifact(document.data, source_version=document.projection.get('sourceVersion') or '')
        return self.freeze(document.data, self.source_mode, self.source_name, self.source_path,
                           package=package, _document=document)

    def open_bytes(self, data, mode, filename, source_path, *, package=None) -> ProjectState:
        snapshot = self.freeze(data, mode, filename, source_path, package=package)
        try:
            self.observer.runtime_jar = snapshot.package.runtime(self.repo_root)
        except ValueError as error:
            snapshot.runtime_error = str(error)
        self.state = snapshot
        self.write_current_pointer()
        return snapshot

    @staticmethod
    def _freeze_file(
        destination: Path,
        payload: bytes,
        expected_digest: str,
        error_code: str,
        *,
        detail: str | None = None,
    ) -> None:
        if destination.is_file():
            if sha256_file(destination) != expected_digest:
                raise LensError(
                    HTTPStatus.CONFLICT if error_code != "FROZEN_REVISION_CORRUPT" else HTTPStatus.INTERNAL_SERVER_ERROR,
                    error_code,
                    detail or f"Frozen artifact digest mismatch: {destination}",
                )
            return
        atomic_write_bytes(destination, payload)

    def require(self) -> None:
        if not self.state.revision_id or not self.state.revision_dir or not self.state.frozen_path or not self.state.raw_project:
            raise LensError(
                HTTPStatus.CONFLICT,
                "NO_WORKSPACE",
                "No circuit is open. Start with a .circ path or upload one.",
            )

    def write_current_pointer(self) -> None:
        context = self._pointer_context()
        value = {
            "schema": LENS_SCHEMA,
            **context,
            "revisionId": self.revision_id,
            "revisionDirectory": str(self.revision_dir) if self.revision_dir else None,
            "workspacePath": str(self.revision_dir / "metadata.json") if self.revision_dir else None,
            "selectionPath": str(self.revision_dir / "selection.json") if self.revision_dir else None,
            "reviewPath": str(self.revision_dir / "review.json") if self.revision_dir else None,
            "lastQueryPath": str(self.revision_dir / "last-query.json") if self.revision_dir else None,
            "updatedAt": now_iso(),
        }
        atomic_write_json(self.state_root / "current.json", value)

    def snapshot_context(self) -> dict[str, Any]:
        self.require()
        return {
            "revisionId": self.revision_id,
            "revisionDir": self.revision_dir,
            "frozenPath": self.frozen_path,
            "sourceMode": self.source_mode,
            "sourcePath": self.source_path,
            "sourceName": self.source_name,
            "openedAt": self.opened_at,
            "rawProject": self.raw_project,
            "package": self.package,
            "artifactSha256": self.artifact_sha256,
        }
