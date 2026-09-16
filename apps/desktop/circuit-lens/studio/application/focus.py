from __future__ import annotations

import json
import re
import shlex
import time
from http import HTTPStatus
from urllib.parse import quote
import uuid
from studio.domain.errors import LensError, QUERY_SCHEMA, SELECTION_SCHEMA
from studio.infrastructure.files import atomic_write_json, now_iso, read_json
from studio.runtime.geometry import bounds_for_points, rect_intersects

class FocusService:
    def __init__(self, workspace):
        self.workspace = workspace

    @staticmethod
    def _validate_rectangle(value: Any) -> dict[str, int] | None:
        if value is None:
            return None
        if not isinstance(value, dict):
            raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_RECTANGLE', 'rectangle must be an object')
        try:
            result = {key: int(value[key]) for key in ('x', 'y', 'width', 'height')}
        except (KeyError, TypeError, ValueError) as error:
            raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_RECTANGLE', 'rectangle requires integer x, y, width, and height') from error
        if result['width'] <= 0 or result['height'] <= 0:
            raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_RECTANGLE', 'rectangle width and height must be positive')
        return result

    @staticmethod
    def _string_list(value: Any, field: str) -> list[str]:
        if value is None:
            return []
        if not isinstance(value, list) or any((not isinstance(item, str) for item in value)):
            raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_FIELD', f'{field} must be a string array')
        return sorted(set(value))

    def save_selection(self, body: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_JSON', 'Selection body must be an object.')
        with self.workspace.lock:
            self.workspace._require()
            if body.get('projectId') is not None and body['projectId'] != self.workspace.history.record['id']:
                raise LensError(HTTPStatus.CONFLICT, 'STALE_SELECTION_PROJECT', '选区所属工程已切换，请重新选择')
            if body.get('revisionId') != self.workspace.revision_id:
                raise LensError(HTTPStatus.CONFLICT, 'STALE_SELECTION_REVISION', "revisionId must explicitly equal the circuit view's frozen revision")
            circuit_name = body.get('circuit') or self.workspace.raw_project['mainCircuit']
            if not isinstance(circuit_name, str):
                raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_CIRCUIT', 'circuit must be a string')
            view = self.workspace.circuit_view(circuit_name)
            rectangle = self._validate_rectangle(body.get('rectangle'))
            requested_components = self._string_list(body.get('componentIds'), 'componentIds')
            requested_nets = self._string_list(body.get('netIds'), 'netIds')
            requested_wires = self._string_list(body.get('wireIds'), 'wireIds')
            selection_intent = {'componentIds': list(requested_components), 'netIds': list(requested_nets), 'wireIds': list(requested_wires), 'rectangle': dict(rectangle) if rectangle is not None else None}
            components_by_id = {item['componentId']: item for item in view['circuit']['components']}
            nets_by_id = {item['netId']: item for item in view['circuit']['nets']}
            wires_by_id = {w['wireId']:w for w in view['circuit']['wires']}
            missing_wires = [i for i in requested_wires if i not in wires_by_id]
            missing_components = [item for item in requested_components if item not in components_by_id]
            missing_nets = [item for item in requested_nets if item not in nets_by_id]
            if missing_components or missing_nets or missing_wires:
                raise LensError(HTTPStatus.BAD_REQUEST, 'UNKNOWN_SELECTION_OBJECT', 'Selection contains revision-local IDs that are not in this circuit.', json.dumps({'componentIds': missing_components, 'netIds': missing_nets, 'wireIds': missing_wires}, ensure_ascii=False))
            if rectangle is None:
                selected_points: list[dict[str, int]] = []
                for component_id in requested_components:
                    bounds = components_by_id[component_id]['bounds']
                    selected_points.extend([{'x': bounds['x'], 'y': bounds['y']}, {'x': bounds['x'] + bounds['width'], 'y': bounds['y'] + bounds['height']}])
                for wire_id in requested_wires:
                    selected_points.extend(wires_by_id[wire_id][k] for k in ('from','to'))
                for net_id in requested_nets:
                    selected_points.extend((contact['location'] for contact in nets_by_id[net_id].get('contacts', [])))
                if selected_points:
                    rectangle = bounds_for_points(selected_points, 20)
                else:
                    rectangle = dict(view['circuit']['bounds'])
            if not requested_components and not requested_wires:
                requested_components = sorted((component_id for component_id, component in components_by_id.items() if rect_intersects(component['bounds'], rectangle)))
            if not requested_nets and view['capabilities']['exactConnectivity']:
                selected_set = set(requested_components)
                requested_nets = sorted((net_id for net_id, net in nets_by_id.items() if any((contact['componentId'] in selected_set for contact in net.get('contacts', [])))))
            bundles={b['bundleId']:b for b in view['circuit']['bundles']}
            if view['capabilities']['exactConnectivity']:
                wire_nets={bit['netId'] for wid in requested_wires for bit in bundles.get(wires_by_id[wid].get('bundleId'),{}).get('bitNets',[])}
                requested_nets=sorted(set(requested_nets)|wire_nets)
            selected_wires=[{k:wires_by_id[wid].get(k) for k in ('wireId','from','to','bundleId')} for wid in requested_wires]
            selection_id = 'sel-' + uuid.uuid4().hex[:16]
            reference = f"circuit-lens://revision/{self.workspace.revision_id}/circuit/{quote(circuit_name, safe='')}/selection/{selection_id}"
            current_selection_path = self.workspace.revision_dir / 'selection.json'
            selection_path = self.workspace.revision_dir / 'selections' / f'{selection_id}.json'
            current_review_path = self.workspace.revision_dir / 'review.json'
            review_path = self.workspace.revision_dir / 'reviews' / f'{selection_id}.json'
            observation_profile = view['capabilities']['observationProfile']
            selection = {'projectId': self.workspace.history.record['id'], 'schema': SELECTION_SCHEMA, 'id': selection_id, 'revisionId': self.workspace.revision_id, 'artifactSha256': self.workspace.artifact_sha256, 'circuit': circuit_name, 'rectangle': rectangle, 'componentIds': requested_components, 'netIds': requested_nets, 'wireIds':requested_wires, 'wires':selected_wires, 'intent': selection_intent, 'createdAt': now_iso(), 'reference': reference, 'statePath': str(selection_path), 'reviewPath': str(review_path), 'currentStatePath': str(current_selection_path), 'currentReviewPath': str(current_review_path), 'observationProfileId': observation_profile['id'], 'observationProfile': observation_profile, 'capabilities': view['capabilities']}
            selection['agentMessage'] = self._agent_message(selection)
            atomic_write_json(current_selection_path, selection)
            atomic_write_json(selection_path, selection)
            default_review = self.workspace._default_review(selection)
            atomic_write_json(current_review_path, default_review)
            atomic_write_json(review_path, default_review)
            self.workspace._write_current_pointer()
            return selection

    def _agent_message(self, selection: dict[str, Any]) -> str:
        command = f'python3 {shlex.quote(str(self.workspace.lensctl_path))} --state-dir {shlex.quote(str(self.workspace.state_root))}'
        return f"Circuit Lens selection is frozen and ready for analysis.\nReference: {selection['reference']}\nSelection state: {selection['statePath']}\nRead current context: {command} context\nQuery this selection: {command} query --revision-id {selection['revisionId']} --selection-id {selection['id']} overview\nPublish a clickable review: {command} publish --revision-id {selection['revisionId']} --selection-id {selection['id']} REVIEW.json\nDo not edit the source .circ; facts must remain bound to this revision."

    def _bound_selection(self, revision_id: Any, selection_id: Any) -> dict[str, Any]:
        self.workspace._require()
        if not isinstance(revision_id, str) or revision_id != self.workspace.revision_id:
            raise LensError(HTTPStatus.CONFLICT, 'STALE_SELECTION_REVISION', 'revisionId must explicitly equal the current frozen revision')
        if not isinstance(selection_id, str) or not re.fullmatch('sel-[0-9a-f]{16}', selection_id):
            raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_SELECTION_ID', 'selectionId must be an explicit Circuit Lens selection ID')
        selection = read_json(self.workspace.revision_dir / 'selections' / f'{selection_id}.json')
        if selection is None:
            raise LensError(HTTPStatus.NOT_FOUND, 'SELECTION_NOT_FOUND', f'No immutable selection {selection_id} exists in revision {revision_id}.')
        if selection.get('projectId') != self.workspace.history.record['id']:
            raise LensError(HTTPStatus.CONFLICT, 'STALE_SELECTION_PROJECT', '选区不属于当前工程，请重新选择')
        if selection.get('revisionId') != revision_id or selection.get('id') != selection_id:
            raise LensError(HTTPStatus.INTERNAL_SERVER_ERROR, 'SELECTION_BINDING_CORRUPT', 'Persisted selection binding does not match its path.')
        return selection

    def get_selection(self, revision_id: str | None=None, selection_id: str | None=None) -> dict[str, Any]:
        with self.workspace.lock:
            self.workspace._require()
            if revision_id is not None or selection_id is not None:
                if revision_id is None or selection_id is None:
                    raise LensError(HTTPStatus.BAD_REQUEST, 'INCOMPLETE_SELECTION_BINDING', 'revisionId and selectionId must be supplied together')
                return self._bound_selection(revision_id, selection_id)
            selection = read_json(self.workspace.revision_dir / 'selection.json')
            if selection is None or selection.get('projectId') != self.workspace.history.record['id']:
                raise LensError(HTTPStatus.NOT_FOUND, 'NO_SELECTION', 'No selection exists for this revision.')
            return selection

    def query(self, body: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_JSON', 'Query body must be an object.')
        with self.workspace.lock:
            selection = self._bound_selection(body.get('revisionId'), body.get('selectionId'))
            kind = body.get('kind', 'overview')
            if kind not in {'overview', 'component', 'net'}:
                raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_QUERY_KIND', 'kind must be overview, component, or net')
            ids = self._string_list(body.get('ids'), 'ids')
            question = body.get('question')
            if question is not None and (not isinstance(question, str)):
                raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_QUESTION', 'question must be a string when present')
            if kind == 'component' and (not ids):
                ids = selection['componentIds']
            elif kind == 'net' and (not ids):
                ids = selection['netIds']
            if kind == 'overview' and ids:
                raise LensError(HTTPStatus.BAD_REQUEST, 'QUERY_IDS_NOT_ALLOWED', 'overview queries must not carry component or net IDs')
            if kind != 'overview' and (not ids):
                raise LensError(HTTPStatus.BAD_REQUEST, 'QUERY_HAS_NO_IDS', f'The current selection has no {kind} IDs.')
            if kind != 'overview':
                allowed_ids = set(selection['componentIds'] if kind == 'component' else selection['netIds'])
                outside_selection = [item for item in ids if item not in allowed_ids]
                if outside_selection:
                    raise LensError(HTTPStatus.BAD_REQUEST, 'QUERY_OUTSIDE_SELECTION', f'{kind} query IDs must belong to the immutable selection.', json.dumps({'ids': outside_selection}, ensure_ascii=False))
            view = self.workspace.circuit_view(selection['circuit'])
            current_profile = view['capabilities'].get('observationProfile') or {}
            if current_profile.get('id') != selection.get('observationProfileId'):
                raise LensError(HTTPStatus.CONFLICT, 'OBSERVATION_PROFILE_CHANGED', 'The exact runtime/observer/query profile changed after this selection was created.')
            if not view['capabilities']['taskQueries']:
                raise LensError(HTTPStatus.UNPROCESSABLE_ENTITY, 'EXACT_QUERY_UNAVAILABLE', 'Task queries require exact runtime connectivity; only geometry is available.', (view.get('observerError') or {}).get('message'))
            try:
                with self.workspace.observation_artifact() as artifact:
                    result = self.workspace.observer.run_query(artifact, selection['circuit'], selection['rectangle'], kind, ids)
            except Exception as error:
                raise LensError(HTTPStatus.UNPROCESSABLE_ENTITY, 'EXACT_QUERY_FAILED', str(error)) from error
            if result.get('revision', {}).get('artifactSha256') != self.workspace.artifact_sha256:
                raise LensError(HTTPStatus.INTERNAL_SERVER_ERROR, 'QUERY_REVISION_MISMATCH', 'Observer query is not bound to the current frozen revision.')
            if result.get('runtime', {}).get('jarSha256') != selection['observationProfile'].get('runtimeJarSha256') or result.get('querySurface', {}).get('programSha256') != selection['observationProfile'].get('queryProgramSha256'):
                raise LensError(HTTPStatus.INTERNAL_SERVER_ERROR, 'QUERY_PROFILE_MISMATCH', "Observer query output does not match the selection's runtime/query profile.")
            response = {'schema': QUERY_SCHEMA, 'revisionId': self.workspace.revision_id, 'selectionId': selection['id'], 'selectionReference': selection['reference'], 'observationProfileId': selection['observationProfileId'], 'observationProfile': selection['observationProfile'], 'kind': kind, 'ids': ids, 'question': question.strip() if isinstance(question, str) else None, 'result': result, 'capabilities': view['capabilities']}
            current_selection = read_json(self.workspace.revision_dir / 'selection.json')
            if current_selection and current_selection.get('id') == selection['id']:
                atomic_write_json(self.workspace.revision_dir / 'last-query.json', response)
            atomic_write_json(self.workspace.revision_dir / 'queries' / selection['id'] / f'{int(time.time() * 1000)}-{kind}.json', response)
            return response

