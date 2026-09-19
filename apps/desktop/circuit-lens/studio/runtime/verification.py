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
import subprocess
import tempfile
import time

from studio.domain.plugin import binding_for, result_envelope


MANIFEST_NAME = "vibe-verification.json"
MANIFEST_SCHEMA = "vibe-logisim.verification/v1"
MAX_OUTPUT = 16 * 1024


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
            seen.add(identifier)
            normalized.append({
                "id": identifier,
                "label": str(recipe.get("label") or identifier)[:120],
                "description": str(recipe.get("description") or "")[:500],
                "command": command,
                "cwd": cwd,
                "timeoutSeconds": timeout,
                "result": result,
            })
        return path, normalized

    def list(self, _args=None):
        path, recipes = self._load()
        return {
            "schema": MANIFEST_SCHEMA,
            "manifest": str(path) if path else None,
            "found": path is not None,
            "verifications": recipes,
            "note": "验证器是工作区提供的可选外部 oracle；清单不存在时不代表电路错误。",
        }

    @staticmethod
    def _sha(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    @staticmethod
    def _replace(value: str, variables: dict[str, str]) -> str:
        result = value
        for key, replacement in variables.items():
            result = result.replace("${" + key + "}", replacement)
        if "${" in result:
            raise ValueError(f"验证器参数包含未知占位符：{result}")
        return result

    @staticmethod
    def _bounded(value: str) -> str:
        if len(value) <= MAX_OUTPUT:
            return value
        return value[:MAX_OUTPUT] + "\n…(输出已截断)"

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
        circuit = args.get("circuit") or ""
        started_at = datetime.now(timezone.utc).isoformat()
        started = time.perf_counter()
        with tempfile.TemporaryDirectory(prefix=".vibe-verification-", dir=self.workspace.state_root) as temporary:
            materialized_root = Path(temporary)
            materialized_artifact = self._materialize(materialized_root, artifact)
            variables = {
                "artifact": str(materialized_artifact),
                "artifactDir": str(materialized_root),
                "source": str(source_path) if source_path else str(materialized_artifact),
                "workspace": str(root),
                "circuit": circuit,
                "revision": str(self.workspace.revision_id),
                "artifactSha256": current_sha,
            }
            command = [self._replace(item, variables) for item in recipe["command"]]
            environment = os.environ.copy()
            environment.update({
                "VIBE_LOGISIM_ARTIFACT": str(materialized_artifact),
                "VIBE_LOGISIM_ARTIFACT_DIR": str(materialized_root),
                "VIBE_LOGISIM_SOURCE": str(source_path) if source_path else str(materialized_artifact),
                "VIBE_LOGISIM_WORKSPACE": str(root),
                "VIBE_LOGISIM_CIRCUIT": circuit,
                "VIBE_LOGISIM_REVISION": str(self.workspace.revision_id),
                "VIBE_LOGISIM_ARTIFACT_SHA256": current_sha,
            })
            timed_out = False
            try:
                completed = subprocess.run(
                    command,
                    cwd=cwd,
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=recipe["timeoutSeconds"],
                    check=False,
                )
                exit_code = completed.returncode
                stdout = self._bounded(completed.stdout or "")
                stderr = self._bounded(completed.stderr or "")
            except subprocess.TimeoutExpired as error:
                timed_out = True
                exit_code = None
                stdout = self._bounded((error.stdout or "") if isinstance(error.stdout, str) else "")
                stderr = self._bounded((error.stderr or "") if isinstance(error.stderr, str) else "")
        finished = time.perf_counter()
        parsed = None
        if recipe["result"] == "json-status" and not timed_out:
            try:
                parsed = json.loads(stdout)
            except json.JSONDecodeError as error:
                return self._envelope(args, recipe, manifest, current_sha, started_at, finished - started,
                                      None, False, stdout, stderr, None, f"验证器输出不是合法 JSON：{error}")
            if not isinstance(parsed, dict) or parsed.get("status") not in {"passed", "failed", "unknown"}:
                return self._envelope(args, recipe, manifest, current_sha, started_at, finished - started,
                                      exit_code, False, stdout, stderr, parsed, "JSON 验证器必须返回 status=passed、failed 或 unknown")
            status = parsed["status"]
        elif timed_out:
            status = "unknown"
        else:
            status = "passed" if exit_code == 0 else "failed"
        return self._envelope(args, recipe, manifest, current_sha, started_at, finished - started,
                              exit_code, timed_out, stdout, stderr, parsed, None, status=status)

    def _envelope(self, args, recipe, manifest, artifact_sha, started_at, duration,
                  exit_code, timed_out, stdout, stderr, parsed, error, *, status=None):
        if status is None:
            status = "unknown"
        feedback = {
            "status": status,
            "failureCount": 1 if status == "failed" else 0,
            "unknownCount": 1 if status == "unknown" else 0,
            "note": "外部验证器的语义由工作区提供；harness 只绑定版本并转发结果，不解释其领域结论。",
        }
        result = {
            "schema": MANIFEST_SCHEMA,
            "id": recipe["id"],
            "label": recipe["label"],
            "manifest": str(manifest),
            "command": recipe["command"],
            "cwd": recipe["cwd"],
            "resultMode": recipe["result"],
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
