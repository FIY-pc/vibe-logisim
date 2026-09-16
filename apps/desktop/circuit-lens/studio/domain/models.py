"""Small, transport-neutral value objects shared by product use cases."""
from __future__ import annotations

from dataclasses import dataclass
import re


def _required(value: str, pattern: str, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise ValueError(f"无效{label}")
    return value


@dataclass(frozen=True, slots=True)
class ProjectRef:
    project_id: str

    def __post_init__(self):
        _required(self.project_id, r"project-[0-9a-f]{16}", "工程引用")


@dataclass(frozen=True, slots=True)
class RevisionRef:
    project: ProjectRef
    revision_id: str

    def __post_init__(self):
        _required(self.revision_id, r"[0-9a-f]{64}", "版本引用")


@dataclass(frozen=True, slots=True)
class CandidateRef:
    project: ProjectRef
    base_revision_id: str
    candidate_id: str

    def __post_init__(self):
        _required(self.base_revision_id, r"[0-9a-f]{64}", "候选基准版本")
        _required(self.candidate_id, r"candidate-[0-9a-f]{16}", "候选引用")


@dataclass(frozen=True, slots=True)
class RunRef:
    revision: RevisionRef
    run_id: str

    def __post_init__(self):
        _required(self.run_id, r"simulation-[0-9a-f]{16}", "运行会话")
