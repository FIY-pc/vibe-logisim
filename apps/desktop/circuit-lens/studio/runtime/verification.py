"""Run optional, workspace-owned verification recipes.

The circuit domain does not interpret a recipe's subject matter.  It only
binds the recipe to the current immutable artifact and turns its process
result into model-readable evidence.  Native observations and external
oracles therefore remain separate capabilities.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time

from studio.domain.plugin import binding_for, result_envelope


MANIFEST_NAME = "vibe-verification.json"
MANIFEST_SCHEMA = "vibe-logisim.verification/v1"
MAX_OUTPUT = 16 * 1024
OUTPUT_CHUNK = 4096


class _BoundedOutput:
    """Collect one pipe without retaining data beyond the evidence budget."""

    def __init__(self):
        self.parts = []
        self.size = 0
        self.truncated = False

    def append(self, value: str):
        if self.truncated:
            return
        remaining = MAX_OUTPUT - self.size
        if len(value) > remaining:
            if remaining:
                self.parts.append(value[:remaining])
                self.size += remaining
            self.truncated = True
        else:
            self.parts.append(value)
            self.size += len(value)

    def text(self) -> str:
        return "".join(self.parts)


class VerificationService:
    def __init__(self, workspace):
        self.workspace = workspace

    def _manifest_path(self) -> Path | None:
        source = self.workspace.source_path
        if not source:
            return None
        current = source.parent.resolve()
        # A circuit can live in a nested folder.  The nearest manifest wins;
        # this keeps a workspace-local verifier from accidentally becoming a
        # global project setting.
        for directory in (current, *current.parents):
            candidate = directory / MANIFEST_NAME
            if candidate.is_file():
                return candidate
        return None

    def _load(self):
        path = self._manifest_path()
        if path is None:
            return None, []
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"无法读取验证器清单：{error}") from error
        if not isinstance(document, dict) or document.get("schema") != MANIFEST_SCHEMA:
            raise ValueError(f"验证器清单 schema 必须为 {MANIFEST_SCHEMA}")
        recipes = document.get("verifications")
        if not isinstance(recipes, list) or len(recipes) > 32:
            raise ValueError("验证器清单的 verifications 必须是最多 32 项的数组")
        normalized = []
        seen = set()
        for recipe in recipes:
            if not isinstance(recipe, dict):
                raise ValueError("验证器条目必须为对象")
            identifier = recipe.get("id")
            command = recipe.get("command")
            if not isinstance(identifier, str) or not identifier.strip() or identifier in seen:
                raise ValueError("验证器 id 必须非空且唯一")
            if not isinstance(command, list) or not 1 <= len(command) <= 32 or any(
                not isinstance(item, str) or not item for item in command
            ):
                raise ValueError(f"验证器 {identifier} 的 command 必须是非空字符串数组")
            cwd = recipe.get("cwd", ".")
            if not isinstance(cwd, str) or not cwd.strip():
                raise ValueError(f"验证器 {identifier} 的 cwd 无效")
            timeout = recipe.get("timeoutSeconds", 120)
            if type(timeout) is not int or not 1 <= timeout <= 600:
                raise ValueError(f"验证器 {identifier} 的 timeoutSeconds 必须在 1–600 之间")
            result = recipe.get("result", "exit-code")
            if result not in {"exit-code", "json-status"}:
                raise ValueError(f"验证器 {identifier} 的 result 必须为 exit-code 或 json-status")
            oracle_files = recipe.get("oracleFiles", [])
            if not isinstance(oracle_files, list) or len(oracle_files) > 64 or any(
                not isinstance(item, str) or not item.strip() or Path(item).is_absolute()
                or ".." in Path(item).parts
                for item in oracle_files
            ):
                raise ValueError(f"验证器 {identifier} 的 oracleFiles 必须是工作区内的相对路径数组")
            seen.add(identifier)
            normalized.append({
                "id": identifier,
                "label": str(recipe.get("label") or identifier)[:120],
                "description": str(recipe.get("description") or "")[:500],
                "command": command,
                "cwd": cwd,
                "timeoutSeconds": timeout,
                "result": result,
                "oracleFiles": oracle_files,
            })
        return path, normalized

    def list(self, _args=None):
        path, recipes = self._load()
        return {
            "schema": MANIFEST_SCHEMA,
            "manifest": str(path) if path else None,
            "manifestSha256": self._read_sha(path),
            "found": path is not None,
            "verifications": [
                {**recipe, "recipeSha256": self._recipe_sha(recipe)}
                for recipe in recipes
            ],
            "note": "验证器是工作区提供的可选外部 oracle；清单不存在时不代表电路错误。",
        }

    @staticmethod
    def _sha(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    @staticmethod
    def _recipe_sha(recipe: dict) -> str:
        payload = json.dumps(recipe, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def _oracle_identity(self, root: Path, recipe: dict) -> dict:
        files = []
        for declared in recipe.get("oracleFiles", []):
            relative = Path(declared)
            target = (root / relative).resolve()
            if target != root and root not in target.parents:
                raise ValueError(f"验证器 oracleFiles 超出清单目录：{declared}")
            if not target.is_file():
                raise ValueError(f"验证器 oracleFiles 不存在：{declared}")
            files.append({"path": relative.as_posix(), "sha256": self._sha(target)})
        payload = json.dumps(files, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return {
            "complete": bool(files),
            "files": files,
            "sha256": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
        }

    @staticmethod
    def _read_sha(path: Path | None) -> str | None:
        if path is None or not path.is_file():
            return None
        try:
            return VerificationService._sha(path)
        except OSError:
            return None

    @staticmethod
    def _replace(value: str, variables: dict[str, str]) -> str:
        result = value
        for key, replacement in variables.items():
            result = result.replace("${" + key + "}", replacement)
        if "${" in result:
            raise ValueError(f"验证器参数包含未知占位符：{result}")
        return result

    @staticmethod
    def _bounded(value: str, *, truncated: bool = False) -> str:
        if not truncated and len(value) <= MAX_OUTPUT:
            return value
        return value[:MAX_OUTPUT] + "\n…(输出已截断)"

    @staticmethod
    def _text(value) -> str:
        if value is None:
            return ""
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace")
        return str(value)

    @staticmethod
    def _terminate_process_group(process: subprocess.Popen) -> None:
        """Stop the verifier and descendants after a runtime stop."""
        if process.poll() is not None:
            return
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                return
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        else:
            process.terminate()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()

    def _execute(self, command, *, cwd, environment, timeout):
        """Execute a recipe with bounded, concurrent stdout/stderr readers.

        ``Popen.communicate`` drains both pipes, but retains all bytes until
        the verifier exits.  Reader threads keep both pipes flowing while
        storing at most ``MAX_OUTPUT`` characters per stream.  Crossing that
        existing evidence limit stops the process group so a runaway verifier
        cannot turn the post-run truncation into unbounded memory use.

        The second boolean in the return value keeps the existing incomplete
        execution path (the caller exposes it as ``timed-out``/``unknown``),
        while the third boolean records that the stop came from output budget.
        """
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=os.name == "posix",
        )
        stdout_buffer = _BoundedOutput()
        stderr_buffer = _BoundedOutput()
        output_limit = threading.Event()

        def read_stream(stream, buffer):
            try:
                while True:
                    chunk = stream.read(OUTPUT_CHUNK)
                    if not chunk:
                        return
                    buffer.append(chunk)
                    if buffer.truncated:
                        output_limit.set()
                        return
            except (OSError, ValueError):
                # The process cleanup path may close a pipe while its reader
                # is waking up.  The already collected prefix is evidence.
                return

        readers = [
            threading.Thread(
                target=read_stream,
                args=(process.stdout, stdout_buffer),
                name="verification-stdout",
                daemon=True,
            ),
            threading.Thread(
                target=read_stream,
                args=(process.stderr, stderr_buffer),
                name="verification-stderr",
                daemon=True,
            ),
        ]
        for reader in readers:
            reader.start()

        timed_out = False
        output_limited = False
        try:
            deadline = time.monotonic() + timeout
            while process.poll() is None:
                if output_limit.is_set():
                    output_limited = True
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break
                output_limit.wait(min(0.01, remaining))
            if output_limit.is_set():
                output_limited = True
            if timed_out or output_limited:
                self._terminate_process_group(process)
            else:
                process.wait()
        finally:
            for reader in readers:
                reader.join(timeout=2)
            # A descendant that retained a pipe should already have been
            # removed with its process group.  Closing our descriptors also
            # handles the normal path without leaving TextIOWrapper warnings.
            for stream in (process.stdout, process.stderr):
                try:
                    stream.close()
                except (OSError, ValueError):
                    pass
            if any(reader.is_alive() for reader in readers):
                for reader in readers:
                    reader.join(timeout=1)

        stopped = timed_out or output_limited
        stdout = self._bounded(stdout_buffer.text(), truncated=stdout_buffer.truncated)
        stderr = self._bounded(stderr_buffer.text(), truncated=stderr_buffer.truncated)
        return (None if stopped else process.returncode), stopped, output_limited, stdout, stderr

    def _materialize(self, root: Path, artifact: Path) -> Path:
        """Build a disposable input package for this exact revision.

        The frozen circuit lives under Lens' private state directory. Passing
        that file alone breaks ordinary Logisim tools that resolve a JAR beside
        the .circ file, so the verifier receives the circuit plus the frozen
        dependency/resource bytes from the same package. This directory is
        never published as the workspace source of truth.
        """
        package = self.workspace.package
        package.verify_frozen(self.workspace.revision_dir)
        materialized = root / (self.workspace.source_name or "artifact.circ")
        materialized.write_bytes(artifact.read_bytes())
        materialized.chmod(0o444)
        for name, payload in package.contents.items():
            dependency = root / name
            dependency.write_bytes(payload)
            dependency.chmod(0o444)
        resources = root / "resources"
        for resource in package.resources:
            resource_id = resource["id"]
            destination = resources / f"{resource_id}.xlsx"
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(package.resource_contents[resource_id])
            destination.chmod(0o444)
        return materialized

    def run(self, args):
        if not isinstance(args, dict) or not isinstance(args.get("id"), str) or not args["id"].strip():
            raise ValueError("run_verification 需要非空 id")
        manifest, recipes = self._load()
        if manifest is None:
            raise ValueError(f"当前工作区没有 {MANIFEST_NAME}")
        recipe = next((item for item in recipes if item["id"] == args["id"]), None)
        if recipe is None:
            raise ValueError(f"找不到验证器 {args['id']}；先调用 list_verifications")
        self.workspace._require()
        source_path = Path(self.workspace.source_path).resolve() if self.workspace.source_path else None
        root = manifest.parent.resolve()
        cwd = (root / recipe["cwd"]).resolve()
        if cwd != root and root not in cwd.parents:
            raise ValueError("验证器 cwd 必须位于清单目录内")
        artifact = self.workspace.frozen_path.resolve()
        current_sha = self._sha(artifact)
        manifest_sha = self._sha(manifest)
        recipe_sha = self._recipe_sha(recipe)
        oracle_identity_before = self._oracle_identity(root, recipe)
        source_sha_before = self._read_sha(source_path)
        circuit = args.get("circuit") or ""
        started_at = datetime.now(timezone.utc).isoformat()
        started = time.perf_counter()
        with tempfile.TemporaryDirectory(prefix=".vibe-verification-", dir=self.workspace.state_root) as temporary:
            materialized_root = Path(temporary)
            materialized_artifact = self._materialize(materialized_root, artifact)
            variables = {
                "artifact": str(materialized_artifact),
                "artifactDir": str(materialized_root),
                # The verifier receives a disposable package. Passing the live
                # source path would let an oracle silently mutate user work.
                "source": str(materialized_artifact),
                "workspace": str(root),
                "circuit": circuit,
                "revision": str(self.workspace.revision_id),
                "artifactSha256": current_sha,
                "oracleSha256": oracle_identity_before["sha256"],
            }
            command = [self._replace(item, variables) for item in recipe["command"]]
            environment = os.environ.copy()
            environment.update({
                "VIBE_LOGISIM_ARTIFACT": str(materialized_artifact),
                "VIBE_LOGISIM_ARTIFACT_DIR": str(materialized_root),
                "VIBE_LOGISIM_SOURCE": str(materialized_artifact),
                "VIBE_LOGISIM_WORKSPACE": str(root),
                "VIBE_LOGISIM_CIRCUIT": circuit,
                "VIBE_LOGISIM_REVISION": str(self.workspace.revision_id),
                "VIBE_LOGISIM_ARTIFACT_SHA256": current_sha,
                "VIBE_LOGISIM_ORACLE_SHA256": oracle_identity_before["sha256"],
            })
            start_error = None
            try:
                exit_code, timed_out, output_limited, stdout, stderr = self._execute(
                    command,
                    cwd=cwd,
                    environment=environment,
                    timeout=recipe["timeoutSeconds"],
                )
            except OSError as error:
                start_error = f"验证器启动失败：{error}"
                exit_code, timed_out, output_limited, stdout, stderr = None, False, False, "", ""
            materialized_sha = self._read_sha(materialized_artifact)
            manifest_sha_after = self._read_sha(manifest)
            try:
                oracle_identity_after = self._oracle_identity(root, recipe)
                oracle_identity_error = None
            except ValueError as error:
                oracle_identity_after = None
                oracle_identity_error = str(error)
            source_sha_after = self._read_sha(source_path)
        integrity_error = None
        if materialized_sha != current_sha:
            integrity_error = "验证器修改了 materialize 的电路输入"
        elif manifest_sha_after != manifest_sha:
            integrity_error = "验证器清单在运行期间发生变化"
        elif oracle_identity_after != oracle_identity_before:
            integrity_error = oracle_identity_error or "验证器 oracle 文件在运行期间发生变化"
        elif source_sha_after != source_sha_before:
            integrity_error = "验证器修改了工作区源文件"
        finished = time.perf_counter()
        parsed = None
        result_error = start_error or integrity_error
        if start_error or integrity_error:
            status = "unknown"
        elif output_limited:
            status = "unknown"
            result_error = f"验证器输出超过运行时预算（每个输出流最多 {MAX_OUTPUT} 个字符），已停止执行"
        elif recipe["result"] == "json-status" and not timed_out:
            try:
                parsed = json.loads(stdout)
            except json.JSONDecodeError as error:
                return self._envelope(args, recipe, manifest, manifest_sha, recipe_sha, current_sha,
                                      started_at, finished - started,
                                      None, False, stdout, stderr, None, f"验证器输出不是合法 JSON：{error}",
                                      oracle_identity=oracle_identity_before)
            if not isinstance(parsed, dict) or parsed.get("status") not in {"passed", "failed", "unknown"}:
                return self._envelope(args, recipe, manifest, manifest_sha, recipe_sha, current_sha,
                                      started_at, finished - started,
                                      exit_code, False, stdout, stderr, parsed, "JSON 验证器必须返回 status=passed、failed 或 unknown",
                                      oracle_identity=oracle_identity_before)
            if exit_code != 0:
                status = "unknown"
                result_error = f"验证器以非零退出码结束：{exit_code}"
            else:
                status = parsed["status"]
        elif timed_out:
            status = "unknown"
        else:
            status = "passed" if exit_code == 0 else "failed"
        return self._envelope(args, recipe, manifest, manifest_sha, recipe_sha, current_sha,
                              started_at, finished - started,
                              exit_code, timed_out, stdout, stderr, parsed, result_error, status=status,
                              oracle_identity=oracle_identity_before,
                              output_limited=output_limited,
                              execution_status=("failed-to-start" if start_error else
                                                 "identity-changed" if integrity_error else
                                                 "timed-out" if timed_out else "completed"))

    def _envelope(self, args, recipe, manifest, manifest_sha, recipe_sha, artifact_sha, started_at, duration,
                  exit_code, timed_out, stdout, stderr, parsed, error, *, status=None, execution_status=None,
                  oracle_identity=None, output_limited=False):
        if status is None:
            status = "unknown"
        execution_status = execution_status or ("timed-out" if timed_out else "completed")
        feedback = {
            "status": status,
            "execution": execution_status,
            "verdict": status,
            "outputLimited": output_limited,
            "failureCount": 1 if status == "failed" else 0,
            "unknownCount": 1 if status == "unknown" else 0,
            "note": "外部验证器的语义由工作区提供；harness 只绑定版本并转发结果，不解释其领域结论。",
        }
        result = {
            "schema": MANIFEST_SCHEMA,
            "id": recipe["id"],
            "label": recipe["label"],
            "manifest": str(manifest),
            "manifestSha256": manifest_sha,
            "recipeSha256": recipe_sha,
            "oracleFiles": recipe.get("oracleFiles", []),
            "oracleIdentityComplete": bool(oracle_identity and oracle_identity.get("complete")),
            "oracleSha256": oracle_identity.get("sha256") if oracle_identity else None,
            "command": recipe["command"],
            "cwd": recipe["cwd"],
            "resultMode": recipe["result"],
            "execution": execution_status,
            "verdict": status,
            "outputLimited": output_limited,
            "startedAt": started_at,
            "durationMs": round(duration * 1000, 3),
            "exitCode": exit_code,
            "timedOut": timed_out,
            "stdout": stdout,
            "stderr": stderr,
            "parsed": parsed,
            "error": error,
            "artifactSha256": artifact_sha,
            "circuit": args.get("circuit"),
        }
        binding = binding_for(self.workspace, circuit=args.get("circuit"), artifact_sha256=artifact_sha)
        run = {
            "id": "verify-" + hashlib.sha256((recipe["id"] + started_at).encode()).hexdigest()[:16],
            "label": recipe["label"],
            "kind": "verification",
            "status": "completed",
            "authority": "workspace-owned verification recipe",
            "rowCount": 1,
        }
        return result_envelope(binding=binding, run=run, observation=result, feedback=feedback)
