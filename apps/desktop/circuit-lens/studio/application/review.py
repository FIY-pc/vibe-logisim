from __future__ import annotations

import json
from http import HTTPStatus
from studio.domain.errors import LensError, REVIEW_SCHEMA
from studio.infrastructure.files import atomic_write_json, now_iso, read_json

class ReviewService:
    def __init__(self, workspace):
        self.workspace = workspace

    def _default_review(self, selection: dict[str, Any]) -> dict[str, Any]:
        return {'schema': REVIEW_SCHEMA, 'revisionId': self.workspace.revision_id, 'selectionId': selection['id'], 'selectionReference': selection['reference'], 'observationProfileId': selection['observationProfileId'], 'observationProfile': selection['observationProfile'], 'status': 'empty', 'summary': '', 'claims': [], 'proposal': None, 'updatedAt': now_iso(), 'guidance': {'claimKinds': ['fact', 'inference', 'unknown'], 'targetKinds': ['component', 'net', 'region'], 'proposalStatus': ['none', 'draft', 'ready-for-human-review'], 'note': 'Acceptance means the human accepts intent, not that implementation is correct.'}, 'validation': {'bindingValidated': True, 'targetResolutionValidated': True, 'claimTruthValidated': False, 'proposalCorrectnessValidated': False}}

    def get_review(self) -> dict[str, Any]:
        with self.workspace.lock:
            try:
                selection = self.workspace.get_selection()
            except LensError as error:
                if error.code != 'NO_SELECTION':
                    raise
                return {'schema': REVIEW_SCHEMA, 'status': 'empty', 'empty': True, 'revisionId': self.workspace.revision_id, 'claims': [], 'proposal': None, 'note': '先在当前电路中选择对象，再生成审阅内容。'}
            review = read_json(self.workspace.revision_dir / 'review.json')
            if review is None or (review.get('selectionId') != selection['id'] or review.get('observationProfileId') != selection.get('observationProfileId')):
                review = self._default_review(selection)
                atomic_write_json(self.workspace.revision_dir / 'review.json', review)
            return review

    def put_review(self, body: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_JSON', 'Review body must be an object.')
        with self.workspace.lock:
            selection = self.workspace._bound_selection(body.get('revisionId'), body.get('selectionId'))
            if body.get('observationProfileId') != selection.get('observationProfileId'):
                raise LensError(HTTPStatus.CONFLICT, 'STALE_REVIEW_PROFILE', "review.observationProfileId must equal the selection's frozen observation profile")
            view = self.workspace.circuit_view(selection['circuit'])
            current_profile = view['capabilities'].get('observationProfile') or {}
            if current_profile.get('id') != selection.get('observationProfileId'):
                raise LensError(HTTPStatus.CONFLICT, 'OBSERVATION_PROFILE_CHANGED', 'The runtime/observer profile changed after this selection was created.')
            claims = body.get('claims', [])
            if not isinstance(claims, list):
                raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_REVIEW', 'claims must be an array')
            review_status = body.get('status', 'ready')
            if review_status not in {'empty', 'draft', 'ready'}:
                raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_REVIEW', 'review status must be empty, draft, or ready')
            component_ids = {component['componentId'] for component in view['circuit']['components']}
            net_ids = {net['netId'] for net in view['circuit']['nets']}
            claim_ids: set[str] = set()
            for index, claim in enumerate(claims):
                if not isinstance(claim, dict) or claim.get('kind') not in {'fact', 'inference', 'unknown'}:
                    raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_REVIEW_CLAIM', f'claims[{index}].kind must be fact, inference, or unknown')
                claim_id = claim.get('id')
                if not isinstance(claim_id, str) or not claim_id.strip() or claim_id in claim_ids:
                    raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_REVIEW_CLAIM', f'claims[{index}].id must be a unique non-empty string')
                claim_ids.add(claim_id)
                if not isinstance(claim.get('text'), str) or not claim['text'].strip():
                    raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_REVIEW_CLAIM', f'claims[{index}].text must be non-empty')
                targets = claim.get('targets')
                if not isinstance(targets, list) or not targets:
                    raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_REVIEW_TARGET', f'claims[{index}].targets must be a non-empty array')
                for target_index, target in enumerate(targets):
                    if not isinstance(target, dict):
                        raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_REVIEW_TARGET', f'claims[{index}].targets[{target_index}] must be an object')
                    kind = target.get('kind')
                    target_id = target.get('id')
                    valid = kind == 'component' and target_id in component_ids or (kind == 'net' and target_id in net_ids) or (kind == 'region' and target_id == selection['id'])
                    if not valid:
                        raise LensError(HTTPStatus.BAD_REQUEST, 'UNKNOWN_REVIEW_TARGET', f"claims[{index}].targets[{target_index}] does not resolve in the selection's revision and circuit", json.dumps(target, ensure_ascii=False))
                if claim['kind'] == 'fact' and (not claim.get('evidence')):
                    raise LensError(HTTPStatus.BAD_REQUEST, 'UNGROUNDED_FACT', f'claims[{index}] is a fact but has no evidence')
                if claim['kind'] == 'inference' and (not claim.get('falsifier')):
                    raise LensError(HTTPStatus.BAD_REQUEST, 'UNFALSIFIABLE_INFERENCE', f'claims[{index}] is an inference but has no falsifier')
            proposal = body.get('proposal')
            if proposal is not None:
                if not isinstance(proposal, dict):
                    raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_PROPOSAL', 'proposal must be null or an object')
                if proposal.get('status') not in {'none', 'draft', 'ready-for-human-review'}:
                    raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_PROPOSAL', 'proposal.status must be none, draft, or ready-for-human-review')
                operations = proposal.get('operations', [])
                if not isinstance(operations, list) or any((not isinstance(operation, dict) or not isinstance(operation.get('kind'), str) for operation in operations)):
                    raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_PROPOSAL', 'proposal.operations must be an array of objects with a kind')
            review = dict(body)
            review.update({'schema': REVIEW_SCHEMA, 'revisionId': self.workspace.revision_id, 'selectionId': selection['id'], 'selectionReference': selection['reference'], 'observationProfileId': selection['observationProfileId'], 'observationProfile': selection['observationProfile'], 'updatedAt': now_iso(), 'validation': {'bindingValidated': True, 'targetResolutionValidated': True, 'claimTruthValidated': False, 'proposalCorrectnessValidated': False}})
            review['status'] = review_status
            review.setdefault('summary', '')
            review.setdefault('proposal', None)
            current_selection = read_json(self.workspace.revision_dir / 'selection.json')
            is_current = bool(current_selection and current_selection.get('id') == selection['id'])
            review['isCurrentSelection'] = is_current
            atomic_write_json(self.workspace.revision_dir / 'reviews' / f"{selection['id']}.json", review)
            if is_current:
                atomic_write_json(self.workspace.revision_dir / 'review.json', review)
            self.workspace._write_current_pointer()
            return review

