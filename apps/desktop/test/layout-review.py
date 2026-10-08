"""Geometry semantics and candidate/source identity; no model calls."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from copy import deepcopy

spec = importlib.util.spec_from_file_location('fidelity', Path(__file__).with_name('arrange-fidelity.py'))
fidelity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fidelity)
from studio.domain.layout_review import layout_review, review_options
from studio.domain.tool_errors import CircuitToolError
from studio.domain.reading_paths import reading_paths, _physical_roots


def part(cid, x, y, *, kind='Pin', width=20, height=20, visual=None):
    b = {'x': x, 'y': y, 'width': width, 'height': height}
    return {'componentId': cid, 'factoryName': kind, 'location': {'x': x, 'y': y},
            'bounds': b, 'visualBounds': visual or b, 'attributes': []}


class LayoutReview(unittest.TestCase):
    def test_native_named_hop_becomes_visible_without_changing_connectivity(self):
        body = (fidelity.pin(100, 100, 'A') + fidelity.wire((100, 100), (130, 100))
                + fidelity.gate('NOT Gate', 160, 100) + fidelity.tunnel(160, 100, 'S')
                + fidelity.tunnel(210, 100, 'S') + fidelity.gate('NOT Gate', 240, 100)
                + fidelity.wire((240, 100), (300, 100)) + fidelity.pin(300, 100, 'Y', out=True))
        with tempfile.TemporaryDirectory(prefix='vibe-reading-path-') as tmp:
            session = fidelity.Session(tmp, fidelity.project(fidelity.circuit('main', body)))
            try:
                before = session.observe(session.src, 'main')
                report = reading_paths(before)
                self.assertEqual(report['operationLinks'], {'physicalCopperOrContact': 0, 'namedOnly': 1})
                example = report['nearbyNamedLinks'][0]
                self.assertEqual((example['source']['componentId'], example['consumer']['componentId']), ('c160_100', 'c240_100'))
                self.assertEqual(example['signals'], ['S'])
                wired_path = Path(tmp) / 'wired.circ'
                wired_path.write_text(fidelity.project(fidelity.circuit('main', body + fidelity.wire((160, 100), (210, 100)))))
                after = session.observe(wired_path, 'main')
                self.assertEqual(reading_paths(after)['operationLinks'], {'physicalCopperOrContact': 1, 'namedOnly': 0})
                identities = fidelity._identity_map(session.src.read_text(), 'main')
                self.assertEqual(fidelity.netlist_signature(before, identities), fidelity.netlist_signature(after, identities))
                # Electrical associations alone cannot prove a direct named hop.
                alias = deepcopy(before)
                for c in alias['components']:
                    if c['factoryName'] == 'Tunnel' and c['location']['x'] == 210:
                        for a in c['attributes']:
                            if a['name'] == 'label':
                                a['standard'] = a['value'] = 'OTHER'
                self.assertEqual(reading_paths(alias)['operationLinks']['namedOnly'], 0)
                # A second output makes source direction ambiguous; do not invent one.
                multi = deepcopy(before)
                driver = deepcopy(next(c for c in multi['components'] if c['componentId'] == 'c160_100'))
                driver['componentId'] = 'other-driver'
                multi['components'].append(driver)
                self.assertEqual(reading_paths(multi)['operationLinks']['namedOnly'], 0)
                self.assertEqual(report, reading_paths({**before, 'components': list(reversed(before['components']))}))
            finally:
                session.close()

    def test_copper_crossing_requires_a_native_endpoint(self):
        def p(x, y):
            return {'x': x, 'y': y}
        focus = {'wires': [{'from': p(0, 50), 'to': p(100, 50)},
                           {'from': p(50, 0), 'to': p(50, 100)}]}
        roots = _physical_roots(focus)
        self.assertNotEqual(roots[(0, 50)], roots[(50, 0)])
        focus['components'] = [{'ends': [{'location': p(50, 50)}]}]
        roots = _physical_roots(focus)
        self.assertEqual(roots[(0, 50)], roots[(50, 0)])

    def test_contacts_are_not_overlaps_but_text_and_bus_displays_are(self):
        touching = [part('pin', 0, 0), part('flag', 20, 0, kind='Tunnel')]
        self.assertEqual(layout_review({'components': touching})['overlapPairs'], 0)
        crowd = [part('a', 0, 0, height=60), part('b', 0, 20, height=60)]
        self.assertEqual(layout_review({'components': crowd})['byKind'], {'component-body': 1})
        text = [part('a', 0, 0, visual={'x': 0, 'y': 0, 'width': 20, 'height': 50}), part('b', 0, 30)]
        self.assertEqual(layout_review({'components': text})['byKind'], {'visual-bounds': 1})

    def test_missing_measurements_are_explicit_and_output_is_bounded(self):
        unknown = part('missing', 0, 0); unknown.pop('visualBounds'); unknown['bounds'] = {}
        report = layout_review({'components': [unknown]})
        self.assertEqual(report['coverage']['missingBounds'], 1)
        self.assertEqual(report['coverage']['withoutNativeVisualBounds'], 1)
        many = [part(str(i), i, 0, kind='Tunnel', width=100) for i in range(50)]
        report = layout_review({'components': many})
        self.assertEqual(report['overlapPairs'], 50*49//2)
        self.assertEqual(len(report['examples']), 24)
        self.assertEqual(report['nextIssueOffset'], 24)
        self.assertEqual(report, layout_review({'components': list(reversed(many))}))

    def test_view_filters_and_pages_require_valid_identity(self):
        for args in ({'layoutReview': {}}, {'circuit': 'main', 'layoutReview': True},
                     {'circuit': 'main', 'layoutReview': {}, 'componentIds': []},
                     {'circuit': 'main', 'layoutReview': {'issueOffset': -1}},
                     {'circuit': 'main', 'layoutReview': {'issueOffset': 24}},
                     {'circuit': 'main', 'layoutReview': {'artifactSha256': 'wrong'}}):
            with self.assertRaises(CircuitToolError):
                review_options(args)

    def test_review_candidate_uses_candidate_artifact_without_checkout(self):
        text = fidelity.project(fidelity.circuit('main', fidelity.pin(100, 100, 'A')
            + fidelity.pin(300, 100, 'Y', out=True) + fidelity.wire((100, 100), (300, 100))))
        with tempfile.TemporaryDirectory(prefix='vibe-layout-review-') as tmp:
            session = fidelity.Session(tmp, text)
            try:
                candidate, artifact = session.arrange('main')
                args = {'circuit': 'main', 'candidateId': candidate['id'], 'layoutReview': {}}
                result = session.workspace.workbench.call(session.revision, 'inspect_circuit', args)
                import hashlib
                self.assertEqual(result['artifactSha256'], hashlib.sha256(artifact.read_bytes()).hexdigest())
                self.assertEqual(result['candidateId'], candidate['id'])
                self.assertEqual(result['layoutReview']['status'], 'observed')
                self.assertEqual(session.src.read_text(), text)
                self.assertEqual(session.workspace.revision_id, session.revision)
            finally:
                session.close()


if __name__ == '__main__':
    unittest.main()
