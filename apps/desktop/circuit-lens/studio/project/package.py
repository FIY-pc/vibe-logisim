from __future__ import annotations


"""Freeze the locally supplied course dependencies without rewriting circuit bytes.

JARs execute code. This first package adapter only loads the two reviewed course
libraries, by content digest; other dependencies retain geometry-only support.
"""


import hashlib
import json
from pathlib import Path, PurePosixPath
import xml.etree.ElementTree as ET

COURSE_DIRECTORY = Path("workspaces/hust-riscv/original/course-package")
COURSE_RUNTIME_SHA256 = "b2400702fb9e8e4c71c512d7e09678a788039f402be55164209cde4cee8fc996"
TRUSTED_LIBRARIES = {
    "a2005466bd27583efdde3a823b9e5812fa9d3f152f248ed788fbcbb7b3ed1f28": "edu.cornell.cs3410.Components",
    "c24b1c2102a58b5cf83e99b2fa7866618598b53f685875597e3bf4270fbedb61": "hust2020.Components",
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class ProjectPackage:
    @staticmethod
    def reference_paths(source, version):
        if not source or not version.startswith('2.15.'):
            return {}
        return {
            'control-workbook': source.parent / 'RISC-V单周期硬布线控制器表达式自动生成（2022-8-19）.xlsx',
            'instruction-table': source.parent.parent / 'RISC-V指令集手册/RISC-V指令码表(HUST)-2023-1-12.xlsx',
        }

    def __init__(self, data: bytes, source: Path | None):
        self.artifact_sha256 = digest(data)
        self.dependencies: list[dict] = []
        self.contents: dict[str, bytes] = {}
        self.errors: list[str] = []
        self.resources: list[dict] = []
        self.resource_contents: dict[str, bytes] = {}
        project = ET.fromstring(data)
        self.source_version = project.get("source", "")
        missing_libraries = []
        for library in project.findall("lib"):
            descriptor = library.get("desc", "")
            if not descriptor.startswith(("jar#", "file#")):
                continue
            if not source:
                self.errors.append(f"请从本地路径打开工程，以定位组件库：{descriptor}")
                continue
            parts = descriptor.split("#")
            if len(parts) != 3 or parts[0] != "jar":
                self.errors.append(f"暂不支持此工程依赖：{descriptor}")
                continue
            relative = PurePosixPath(parts[1])
            if relative.is_absolute() or len(relative.parts) != 1 or "\\" in parts[1]:
                self.errors.append(f"目前只支持与电路同目录的课程 JAR：{parts[1]}")
                continue
            original = source.parent / relative.name
            try:
                if original.resolve().parent != source.parent.resolve():
                    raise ValueError("组件库不能通过链接访问工程目录之外")
                if original.stat().st_size > 32 * 1024 * 1024:
                    raise ValueError("组件库超过 32 MB")
                payload = original.read_bytes()
            except FileNotFoundError:
                missing_libraries.append(relative.name)
                continue
            except PermissionError:
                self.errors.append(f"没有权限读取组件库 {relative.name}，请检查文件的读取权限。")
                continue
            except (OSError, ValueError) as error:
                self.errors.append(f"无法读取 {relative.name}：{error}")
                continue
            sha = digest(payload)
            self.dependencies.append({
                "name": relative.name, "descriptor": descriptor,
                "sha256": sha, "sourcePath": str(original),
            })
            if TRUSTED_LIBRARIES.get(sha) != parts[2]:
                self.errors.append(f"尚未支持此组件库版本：{relative.name} ({sha[:12]})")
                continue
            self.contents[relative.name] = payload
        if missing_libraries:
            self.errors.append("缺少组件库：" + "、".join(dict.fromkeys(missing_libraries)) + "。需与电路文件放在同一目录。")
        self.dependencies.sort(key=lambda item: item["descriptor"])
        # First course adapter: only the two named, locally attached reference workbooks.
        if source and self.source_version.startswith("2.15."):
            references = self.reference_paths(source, self.source_version)
            for resource_id, original in references.items():
                if not original.is_file() or original.is_symlink() or original.stat().st_size > 4 * 1024 * 1024:
                    continue
                payload = original.read_bytes()
                self.resources.append({"id": resource_id, "name": original.name, "sha256": digest(payload), "sourcePath": str(original)})
                self.resource_contents[resource_id] = payload
        self._identify()

    def _identify(self):
        identity = {
            "artifactSha256": self.artifact_sha256,
            "dependencies": [{k: d[k] for k in ("name", "descriptor", "sha256")} for d in self.dependencies],
        }
        if self.resources:
            identity["resources"] = [{k: r[k] for k in ("id", "name", "sha256")} for r in self.resources]
        self.revision_id = (digest(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode())
                            if self.dependencies or self.resources else self.artifact_sha256)

    def replace_artifact(self, data, *, source_version=None):
        self.artifact_sha256 = digest(data)
        # Local circuit edits retain the already parsed project header. General
        # file replacement still parses the complete incoming document.
        self.source_version = ET.fromstring(data).get("source", "") if source_version is None else source_version
        self._identify()

    @classmethod
    def from_snapshot(cls, directory, source):
        metadata = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
        result = cls.__new__(cls)
        result.contents, result.resource_contents = {}, {}
        result.errors = metadata.get("dependencyErrors", [])
        result.dependencies = metadata.get("dependencies", [])
        result.resources = metadata.get("resources", [])
        for item in result.dependencies:
            file = directory / item["name"]
            if source:
                item["sourcePath"] = str(source.parent / item["name"])
            if TRUSTED_LIBRARIES.get(item["sha256"]) != item["descriptor"].split("#")[-1]:
                continue
            payload = file.read_bytes()
            if digest(payload) != item["sha256"]:
                raise ValueError("历史组件库已损坏：" + item["name"])
            result.contents[item["name"]] = payload
        for item in result.resources:
            payload = (directory / "resources" / (item["id"] + ".xlsx")).read_bytes()
            if digest(payload) != item["sha256"]:
                raise ValueError("历史资料已损坏：" + item["name"])
            result.resource_contents[item["id"]] = payload
        result.replace_artifact((directory / "artifact.circ").read_bytes())
        if result.revision_id != directory.name or result.artifact_sha256 != metadata["artifactSha256"]:
            raise ValueError("历史电路快照已损坏")
        return result

    @property
    def supported(self) -> bool:
        return not self.errors

    def runtime(self, repo_root: Path) -> Path:
        if self.source_version.startswith("2.15."):
            runtime = repo_root / COURSE_DIRECTORY / "logisim-ita-cn-20200118.exe"
            if not runtime.is_file() or digest(runtime.read_bytes()) != COURSE_RUNTIME_SHA256:
                raise ValueError("课程版 Logisim 缺失或内容已改变，请恢复原始 20200118 运行文件。")
            return runtime
        return repo_root / "apps/desktop/circuit-lens/native/Logisim-ITA.jar"

    def changed_dependencies(self) -> list[str]:
        changed = []
        for dep in self.dependencies:
            try:
                if digest(Path(dep["sourcePath"]).read_bytes()) == dep["sha256"]:
                    continue
            except OSError:
                pass
            changed.append(dep["name"])
        return changed

    def verify_frozen(self, directory: Path) -> None:
        if digest((directory / "artifact.circ").read_bytes()) != self.artifact_sha256:
            raise ValueError("工程快照的电路文件已改变，请重新打开原始工程。")
        for dep in self.dependencies:
            if digest((directory / dep["name"]).read_bytes()) != dep["sha256"]:
                raise ValueError(f"工程快照的组件库已改变：{dep['name']}")

