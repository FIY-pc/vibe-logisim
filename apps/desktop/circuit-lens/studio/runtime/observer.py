from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import tempfile
import threading
import time
from studio.infrastructure.files import sha256_bytes, sha256_file
from studio.runtime.worker import NativeWorker
import xml.etree.ElementTree as ET

class ObserverRuntime:
    """Compile and invoke the exact Experiment 001 observer without copying it."""

    def __init__(self, repo_root: Path, state_root: Path):
        self.repo_root = repo_root
        self.state_root = state_root
        self.observer_dir = self.repo_root / "apps/desktop/circuit-lens/observer"
        self.source = (
            self.observer_dir
            / "src"
            / "com"
            / "cburch"
            / "logisim"
            / "circuit"
            / "ExactRuntimeObserver.java"
        )
        self.runtime_jar = self.repo_root / "apps/desktop/circuit-lens/native" / "Logisim-ITA.jar"
        self.full_runner = self.observer_dir / "run-precompiled.sh"
        self.query_runner = self.observer_dir / "query-precompiled.sh"
        self.query_program = self.observer_dir / "query.py"
        self._compile_lock = threading.Lock()
        self._process_lock = threading.Lock()
        self._active_processes: set[subprocess.Popen[Any]] = set()
        self._closed = False
        self.worker = NativeWorker(repo_root, state_root)

    def close(self) -> None:
        self.worker.close()
        with self._process_lock:
            if self._closed:
                return
            self._closed = True
            active = list(self._active_processes)
        for process in active:
            self._terminate_process_tree(process, force=False)
        deadline = time.monotonic() + 0.75
        for process in active:
            remaining = max(0.0, deadline - time.monotonic())
            try:
                process.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                self._terminate_process_tree(process, force=True)

    @staticmethod
    def _terminate_process_tree(process: subprocess.Popen[Any], force: bool) -> None:
        if process.poll() is not None:
            return
        if os.name == "nt":
            command = ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"]
            try:
                subprocess.run(
                    command,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                with contextlib.suppress(OSError):
                    process.kill()
            return
        try:
            os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
        except ProcessLookupError:
            pass

    def _run_captured(
        self,
        command: list[str],
        *,
        timeout: float,
        environment: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        options: dict[str, Any] = {
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "text": True,
            "env": environment,
        }
        if os.name == "nt":
            options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            options["start_new_session"] = True
        with self._process_lock:
            if self._closed:
                raise RuntimeError("Exact observer is shutting down.")
            process = subprocess.Popen(command, **options)
            self._active_processes.add(process)
        try:
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired as error:
                self._terminate_process_tree(process, force=False)
                try:
                    stdout, stderr = process.communicate(timeout=0.75)
                except subprocess.TimeoutExpired:
                    self._terminate_process_tree(process, force=True)
                    stdout, stderr = process.communicate()
                error.stdout = stdout
                error.stderr = stderr
                raise
            return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
        finally:
            with self._process_lock:
                self._active_processes.discard(process)

    def prerequisite_error(self) -> str | None:
        missing = [
            str(path)
            for path in (
                self.source,
                self.runtime_jar,
                self.full_runner,
                self.query_runner,
                self.query_program,
            )
            if not path.is_file()
        ]
        if missing:
            return "Missing exact-observer files: " + ", ".join(missing)
        if shutil.which("java") is None or shutil.which("javac") is None:
            return "The exact observer requires java and javac on PATH."
        return None

    def profile(self, reported_version: str | None = None, *, runtime_jar=None) -> dict[str, Any]:
        issue = self.prerequisite_error()
        if issue:
            return {
                "id": None,
                "kind": "exact-runtime",
                "status": "unavailable",
                "display": "Exact runtime unavailable",
                "error": issue,
            }
        runtime_sha = sha256_file(runtime_jar or self.runtime_jar)
        observer_sha = sha256_file(self.source)
        query_sha = sha256_file(self.query_program)
        full_runner_sha = sha256_file(self.full_runner)
        query_runner_sha = sha256_file(self.query_runner)
        identity = {
            "kind": "logisim-ita-exact-runtime-observer",
            "runtimeJarSha256": runtime_sha,
            "observerSourceSha256": observer_sha,
            "queryProgramSha256": query_sha,
            "fullRunnerSha256": full_runner_sha,
            "queryRunnerSha256": query_runner_sha,
        }
        profile_id = sha256_bytes(
            json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
        )
        display_version = (
            reported_version[:-4]
            if reported_version and reported_version.lower().endswith(".jar")
            else reported_version
        )
        return {
            "id": profile_id,
            **identity,
            "status": "observed" if reported_version else "configured-not-observed",
            "reportedVersion": reported_version,
            "display": (
                f"Logisim-ITA {display_version} · {runtime_sha[:12]}"
                if display_version
                else f"Logisim-ITA exact runtime · {runtime_sha[:12]}"
            ),
        }

    def prepare(self) -> Path:
        issue = self.prerequisite_error()
        if issue:
            raise RuntimeError(issue)
        key = sha256_file(self.source)[:24] + "-" + sha256_file(self.runtime_jar)[:24]
        classes = self.state_root / "observer-cache" / key / "classes"
        class_file = classes / "com" / "cburch" / "logisim" / "circuit" / "ExactRuntimeObserver.class"
        if class_file.is_file():
            return classes
        with self._compile_lock:
            if class_file.is_file():
                return classes
            classes.parent.mkdir(parents=True, exist_ok=True)
            temporary = Path(tempfile.mkdtemp(prefix="compile-", dir=classes.parent))
            try:
                completed = self._run_captured(
                    [
                        "javac",
                        "-encoding",
                        "UTF-8",
                        "-cp",
                        str(self.runtime_jar),
                        "-d",
                        str(temporary),
                        str(self.source),
                    ],
                    timeout=60,
                )
                if completed.returncode != 0:
                    raise RuntimeError(
                        "Exact observer compilation failed: " + completed.stderr.strip()[-4000:]
                    )
                if classes.exists():
                    shutil.rmtree(classes)
                os.replace(temporary, classes)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
        return classes

    def _environment(self, classes: Path) -> dict[str, str]:
        environment = os.environ.copy()
        environment.update(
            {
                "VIBE_OBSERVER_RUNTIME_JAR": str(self.runtime_jar),
                "VIBE_OBSERVER_CLASSES": str(classes),
                "VIBE_OBSERVER_QUERY_PROGRAM": str(self.query_program),
            }
        )
        return environment

    def run_full(self, artifact: Path, circuit: str, render_path: Path | None = None, *, runtime_jar=None) -> dict[str, Any]:
        if render_path:
            render_path.parent.mkdir(parents=True, exist_ok=True)
        return json.loads(self.worker.request(runtime_jar or self.runtime_jar, artifact,
            ET.Element('observe', circuit=circuit), render_path))

    def run_query(
        self,
        artifact: Path,
        circuit: str,
        rectangle: dict[str, int],
        kind: str,
        ids: list[str],
    ) -> dict[str, Any]:
        classes = self.prepare()
        command = [
            str(self.query_runner),
            str(artifact),
            circuit,
            str(rectangle["x"]),
            str(rectangle["y"]),
            str(rectangle["width"]),
            str(rectangle["height"]),
            kind,
            *ids,
        ]
        return self._run_json(command, self._environment(classes))

    def _run_json(self, command: list[str], environment: dict[str, str]) -> dict[str, Any]:
        try:
            completed = self._run_captured(
                command,
                timeout=60,
                environment=environment,
            )
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("Exact observer timed out after 60 seconds.") from error
        try:
            document = json.loads(completed.stdout) if completed.stdout.strip() else None
        except json.JSONDecodeError as error:
            detail = (completed.stderr or completed.stdout)[-4000:]
            raise RuntimeError("Exact observer returned invalid JSON: " + detail) from error
        if completed.returncode != 0:
            if isinstance(document, dict) and document.get("error"):
                raise RuntimeError(str(document["error"]))
            raise RuntimeError(
                "Exact observer failed: " + (completed.stderr.strip()[-4000:] or "no diagnostics")
            )
        if not isinstance(document, dict):
            raise RuntimeError("Exact observer returned no JSON object.")
        if document.get("error"):
            raise RuntimeError(str(document["error"]))
        return document

