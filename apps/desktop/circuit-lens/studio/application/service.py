"""Application use cases shared by the HTTP and desktop adapters.

Adapters do validation of their own wire format; this service owns product
action routing and revision binding so a second transport cannot invent a
different meaning for apply, run, or inspect.
"""
from __future__ import annotations

from studio.domain.models import CandidateRef, ProjectRef, RevisionRef
from studio.project.editor import CircuitEditor
from studio.project.layout import preview
from studio.application.interfaces import InterfaceService
from studio.application.moments import Moments
from studio.application.placement import PlacementService


class ApplicationService:
    def __init__(self, workspace, *, inspect_snapshot):
        self.workspace = workspace
        self.editor = CircuitEditor(workspace, workspace.history, inspect_snapshot=inspect_snapshot)
        self.interfaces = InterfaceService(workspace, inspect_snapshot)
        self.moments = Moments(workspace)
        self.placement = PlacementService(workspace, inspect_snapshot)

    def _revision(self, body) -> RevisionRef:
        if not isinstance(body, dict) or not self.workspace.history.record:
            raise ValueError("请先打开工程")
        ref = RevisionRef(ProjectRef(body.get("projectId")), body.get("revisionId"))
        if ref.project.project_id != self.workspace.history.record["id"] or ref.revision_id != self.workspace.revision_id:
            raise ValueError("工程版本已经变化，请读取当前状态后重试")
        return ref

    def open_upload(self, data, filename):
        return self.workspace.open_upload(data, filename)

    def open_path(self, path):
        return self.workspace.open_path(path)

    def project_action(self, action, body):
        if action == 'interface':return self.interfaces.apply(body)
        with self.workspace.lock:
            return self._project_action(action, body)

    def layout_preview(self, body):
        with self.workspace.lock:
            self._revision(body)
            view=self.workspace.circuit_view(body.get('circuit'))
            if not view['capabilities']['exactConnectivity']:
                raise ValueError('原生连接不可用，不能预览保持连接的移动')
            scene=view['circuit']
        result=preview(scene,body)
        with self.workspace.lock:self._revision(body)
        return {**result,'projectId':body['projectId'],'revisionId':body['revisionId']}

    def _project_action(self, action, body):
        self._revision(body)
        history = self.workspace.history
        handlers = {
            "apply": lambda: history.apply(body["projectId"], body["revisionId"], CandidateRef(
                ProjectRef(body["projectId"]), body["revisionId"], body["candidateId"]).candidate_id),
            "restore": lambda: history.restore(body["projectId"], body["revisionId"], body["changeId"]),
            "place": lambda: self.placement.place(body),
            "edit": lambda: self.editor.edit(body["projectId"], body["revisionId"], body),
            "move": lambda: self.editor.move(body["projectId"], body["revisionId"], body),
            "wire": lambda: self.editor.wire(body["projectId"], body["revisionId"], body),
            "delete": lambda: self.editor.delete(body["projectId"], body["revisionId"], body),
            "undo": lambda: history.undo(body["projectId"], body["revisionId"]),
            "save": lambda: history.save(body["projectId"], body["revisionId"]),
        }
        if action not in handlers:
            raise ValueError("未知工程动作")
        return handlers[action]()

    def agent_tool(self, body):
        with self.workspace.lock:
            # The existing CLI binds tools by revision. New callers can also
            # bind a project to distinguish projects sharing identical bytes.
            if body.get("projectId") is not None:
                self._revision(body)
            return self.workspace.workbench.call(
                body.get("revisionId"),
                body.get("tool"),
                body.get("arguments"),
                body.get("observationId"),
                project_id=body.get("projectId"),
                thread_id=body.get("threadId"),
                turn_id=body.get("turnId"),
                call_id=body.get("callId"),
            )

    def simulation_action(self, body):
        with self.workspace.lock:
            self._revision(body)
            return self.workspace.simulation.action(body)
