"""Candidate ownership is independent of content-addressed revisions."""
from dataclasses import dataclass


@dataclass(frozen=True)
class CandidateAccess:
    project_id: str | None
    revision_id: str | None
    applied_ids: frozenset[str]

    def is_pending(self, metadata: dict) -> bool:
        return bool(
            self.project_id
            and metadata.get('projectId') == self.project_id
            and metadata.get('baseRevisionId') == self.revision_id
        )

    def require(self, metadata: dict, *, allow_applied: bool = False) -> None:
        owner = metadata.get('projectId')
        if not self.project_id or (owner is not None and owner != self.project_id):
            raise ValueError('候选属于另一个工程')
        historical = allow_applied and metadata.get('id') in self.applied_ids
        # A legacy candidate has no owner. Only a persisted application in this
        # project's history proves access; equal circuit bytes prove nothing.
        if owner is None and not historical:
            raise ValueError('旧候选缺少工程归属；文件已保留，请在目标工程重新提交电路')
        if metadata.get('baseRevisionId') != self.revision_id and not historical:
            raise ValueError('候选属于另一个工程版本')
