#!/usr/bin/env python3
"""Check inspect net grouping fidelity through production Workspace.agent_tool.

Run: python3 -B apps/desktop/test/net-groups.py [--observe-existing]
Evidence, fixtures, native caches and Java preferences stay in persistent runs.
No simulation, behavior oracle, UI, model calls, source edits or saves.
"""
from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import traceback
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[3]
RUNS = Path.home() / '.local/share/vibe-logisim-dev/runs'
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))


def encoded(value):
    """Consistent compact UTF-8 JSON; byte sizes include all response fields."""
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'),
                      sort_keys=True, allow_nan=False).encode('utf-8')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(root, name, value):
    (root / name).write_bytes(encoded(value))


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def records(nets):
    # Ignore only net-record order; preserve multiplicity, nested order, types,
    # every unknown field and every native contact/slice, including duplicates.
    return Counter(encoded(net) for net in nets)


def expand(grouped):
    """Independent consumer of the public lane contract, no product decoder."""
    nets = deepcopy(grouped.get('ungroupedNets', []))
    for group in grouped['groups']:
        ids = group['netIds']
        for key in ('contacts', 'slices'):
            require(all(len(item['bits']) == len(ids) for item in group[key]),
                    f'{key}: lane count does not match netIds')
        for lane, net_id in enumerate(ids):
            net = {k: deepcopy(v) for k, v in group.items()
                   if k not in ('netIds', 'contacts', 'slices')}
            net['netId'] = net_id
            for key in ('contacts', 'slices'):
                net[key] = [{**{k: deepcopy(v) for k, v in item.items() if k != 'bits'},
                             'bit': item['bits'][lane]} for item in group[key]]
            nets.append(net)
    require(len(nets) == grouped['netCount'], 'netCount lost records')
    return nets


def pure_data(root):
    from studio.domain.net_groups import group_bit_nets

    future = {'nullable': None, 'flag': False, 'zero': 0, 'float': 1.0,
              'text': '未知/未来', 'nested': [{'values': [None, True, 7]}]}
    nets = []
    # Two bits of exactly the same component/end are shorted in each net.
    # Both contact slots must survive; the second lane reverses their mapping.
    for net_id, bits in (('z-short', (3, 0)), ('a-short', (1, 2))):
        nets.append({'netId': net_id, 'futureNet': deepcopy(future), 'bit': 'net metadata',
                     'contacts': [{'componentId': 'same', 'endIndex': 0,
                                   'direction': 'inout', 'bit': bit,
                                   'futureContact': deepcopy(future)} for bit in bits],
                     'slices': [{'bundleId': 'bus', 'bit': bit,
                                 'futureSlice': deepcopy(future)} for bit in bits]})
    # Different future metadata must prevent lossy merging of otherwise equal shapes.
    different = deepcopy(nets[0])
    different['netId'] = 'metadata-differs'
    different['futureNet']['nullable'] = 'now-known'
    nets.append(different)
    # Reserved/future fields and incomplete observations must remain verbatim.
    reserved = deepcopy(nets[0])
    reserved.update(netId='reserved-netIds', netIds=['future meaning'])
    contact_bits = deepcopy(nets[0])
    contact_bits['netId'] = 'reserved-contact-bits'
    contact_bits['contacts'][0]['bits'] = {'future': [2, 3]}
    slice_bits = deepcopy(nets[0])
    slice_bits['netId'] = 'reserved-slice-bits'
    slice_bits['slices'][0]['bits'] = ['future']
    unknown = {'netId': 'unknown-bit', 'contacts': [{'bit': None, 'future': future}],
               'slices': [], 'futureNet': future}
    incomplete = {'netId': 'incomplete', 'futureNet': future}
    nets.extend([reserved, contact_bits, slice_bits, unknown, incomplete, None])
    original = deepcopy(nets)
    grouped = group_bit_nets(nets)
    rebuilt = expand(grouped)
    save(root, 'pure-input.json', original)
    save(root, 'pure-groups.json', grouped)
    save(root, 'pure-reconstructed.json', rebuilt)
    require(records(rebuilt) == records(original), 'pure data lost native fields or bits')
    require(encoded(nets) == encoded(original), 'grouping mutated its input')
    short = next(g for g in grouped['groups'] if 'z-short' in g['netIds'])
    require(set(short['netIds']) == {'z-short', 'a-short'}, 'shorted lanes were not grouped')
    require(len(short['contacts']) == len(short['slices']) == 2,
            'same-end short discarded a contact or slice')
    require(short['contacts'][0]['bits'] == [1, 3] and
            short['contacts'][1]['bits'] == [2, 0], 'short/reverse mapping lost')
    require(records(grouped['ungroupedNets']) == records(original[3:]),
            'reserved/future/incomplete records changed')
    # Check the public view owns its nested values, rather than aliasing source metadata.
    short['futureNet']['nested'][0]['values'].append('view edit')
    short['contacts'][0]['futureContact']['nested'][0]['values'].append('view edit')
    short['slices'][0]['futureSlice']['nested'][0]['values'].append('view edit')
    grouped['ungroupedNets'][0]['futureNet']['text'] = 'view edit'
    require(encoded(nets) == encoded(original), 'view metadata aliases input')
    return {'status': 'passed', 'netCount': len(original),
            'groups': len(grouped['groups']), 'verbatimRecords': len(grouped['ungroupedNets']),
            'sameEndShortAndReverseMapping': True, 'unknownFieldsPreserved': True,
            'inputUnchangedAndUnaliased': True}


def fixture(version):
    """Reverse the two 2-bit groups of a 4-bit Splitter; one branch is undriven.

    Based on connectivity-feedback.py's PartialBus geometry, without importing
    or executing its tests. Sink bits 2,3 connect to Constant bits 0,1; Sink
    bits 0,1 belong to the unconnected other branch.
    """
    root = ET.Element('project', source=version, version='1.0')
    ET.SubElement(root, 'lib', name='0', desc='#Wiring')
    ET.SubElement(root, 'main', name='ReverseGroups')
    circuit = ET.SubElement(root, 'circuit', name='ReverseGroups')
    for name, location, attrs in (
        ('Pin', '(100,100)', {'label': 'Sink', 'width': 4, 'output': 'true'}),
        ('Splitter', '(200,100)', {'incoming': 4, 'fanout': 2, 'facing': 'east',
                                 'bit0': 1, 'bit1': 1, 'bit2': 0, 'bit3': 0}),
        ('Constant', '(280,80)', {'width': 2, 'value': '0x3'}),
    ):
        node = ET.SubElement(circuit, 'comp', name=name, lib='0', loc=location)
        for key, value in attrs.items():
            ET.SubElement(node, 'a', name=key, val=str(value))
    for start, end in (('(100,100)', '(200,100)'), ('(220,80)', '(280,80)')):
        ET.SubElement(circuit, 'wire', {'from': start, 'to': end})
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def structural_files(workspace):
    paths = [workspace.state_root / 'current.json',
             *workspace.history.directory.glob('*.json')]
    for revision in (workspace.state_root / 'revisions').iterdir():
        paths.extend([revision / 'artifact.circ', revision / 'metadata.json'])
    return {str(p.relative_to(workspace.state_root)): p.read_bytes() for p in paths}


def check_mapping(scene, issues):
    sink = next(c for c in scene['components'] if c.get('label') == 'Sink')
    constant = next(c for c in scene['components'] if c['factory'] == 'Constant')
    observed = {}
    for net in scene['nets']:
        source_bits = [c['bit'] for c in net['contacts'] if c['componentId'] == constant['componentId']]
        for contact in net['contacts']:
            if contact['componentId'] == sink['componentId']:
                observed[contact['bit']] = source_bits
    require(observed == {0: [], 1: [], 2: [0], 3: [1]},
            f'native Splitter reverse grouping is wrong: {observed}')
    missing = [p['bits'] for p in issues['inputsWithoutOutputPeer']
               if p['componentId'] == sink['componentId']]
    require(missing == [[0, 1]], f'static diagnostic lost the undriven lane mapping: {missing}')
    return observed


def observe(root, label, source, circuit, expected_runtime_sha, expected_source_sha=None,
            check_splitter=False):
    from studio.application.workspace import Workspace
    from studio.domain.connectivity_feedback import connectivity_feedback

    out = root / label
    out.mkdir()
    original = source.read_bytes()
    if expected_source_sha:
        require(sha(original) == expected_source_sha, f'{label}: wrong existing artifact')
    (out / 'source-before.circ').write_bytes(original)
    workspace = Workspace(REPO, out / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'net-groups')
    try:
        workspace.open_path(source)
        identity = deepcopy((workspace.revision_id, workspace.artifact_sha256, workspace.history.record))
        structural = structural_files(workspace)
        frozen = workspace.frozen_path.read_bytes()
        require(frozen == original, f'{label}: open changed the frozen source')
        view = workspace.circuit_view(circuit)
        save(out, 'native-view.json', view)
        require(view['capabilities']['exactConnectivity'],
                f'{label}: no exact connectivity: {view.get("observerError")}')
        require(view['runtime']['jarSha256'] == expected_runtime_sha, f'{label}: wrong runtime')
        scene = deepcopy(view['circuit'])
        save(out, 'native-scene.json', scene)
        save(out, 'identity-before.json', identity)
        save(out, 'structural-files-before.json', {k: sha(v) for k, v in structural.items()})

        def call(**extra):
            request = {'projectId': identity[2]['id'], 'revisionId': identity[0],
                       'tool': 'inspect_circuit',
                       'arguments': {'circuit': circuit, 'includeNets': True, **extra}}
            name = extra.get('netFormat', 'default-groups')
            save(out, name + '-request.json', request)
            result = workspace.application.agent_tool(request)
            save(out, name + '-response.json', result)
            require(result['authority'] == 'exact-runtime' and not result['error'],
                    f'{label}: inspection did not use native connectivity')
            return result

        groups = call()  # Intentionally omit netFormat: exercise the production default.
        bits = call(netFormat='bits')
        require('nets' not in groups and groups['netFormat'] == 'groups',
                f'{label}: default does not exclusively return netGroups')
        require('netGroups' not in bits and bits['netFormat'] == 'bits',
                f'{label}: bits mode did not retain its original nets field')
        rebuilt = expand(groups['netGroups'])
        save(out, 'reconstructed-nets.json', rebuilt)
        require(records(rebuilt) == records(bits['nets']) == records(scene['nets']),
                f'{label}: grouped, bits and native records disagree')
        other = lambda r: {k: v for k, v in r.items() if k not in ('nets', 'netGroups', 'netFormat')}
        require(encoded(other(groups)) == encoded(other(bits)),
                f'{label}: non-net response fields changed')
        require(groups['connectivityIssues'] == connectivity_feedback(scene, exact=True),
                f'{label}: static diagnostics differ from native scene')
        mapping = check_mapping(scene, groups['connectivityIssues']) if check_splitter else None
        if check_splitter:
            require(any(len(g['netIds']) > 1 for g in groups['netGroups']['groups']),
                    'fixture did not exercise multi-lane grouping')
        require(encoded(workspace.circuit_view(circuit)['circuit']) == encoded(scene),
                f'{label}: inspection mutated cached native components or nets')
        require(identity == (workspace.revision_id, workspace.artifact_sha256, workspace.history.record),
                f'{label}: project identity, revision or history changed')
        require(structural_files(workspace) == structural, f'{label}: persisted revision/history changed')
        require(workspace.frozen_path.read_bytes() == frozen, f'{label}: frozen bytes changed')
        after = source.read_bytes()
        (out / 'source-after.circ').write_bytes(after)
        require(after == original, f'{label}: original source bytes changed')
        save(out, 'identity-after.json', identity)
        save(out, 'structural-files-after.json', {k: sha(v) for k, v in structural_files(workspace).items()})
        before_bytes, after_bytes = len(encoded(bits)), len(encoded(groups))
        return {'status': 'passed', 'case': label, 'source': str(source),
                'runtimeJarSha256': expected_runtime_sha, 'sourceBytes': len(original),
                'sourceSha256Before': sha(original), 'sourceSha256After': sha(after),
                'netCount': len(bits['nets']), 'groups': len(groups['netGroups']['groups']),
                'ungroupedNets': len(groups['netGroups'].get('ungroupedNets', [])),
                'components': len(bits['components']), 'bitsResponseBytes': before_bytes,
                'groupsResponseBytes': after_bytes, 'savedResponseBytes': before_bytes - after_bytes,
                'savedResponsePercent': round((before_bytes - after_bytes) * 100 / before_bytes, 4),
                'bitsNetsValueBytes': len(encoded(bits['nets'])),
                'netGroupsValueBytes': len(encoded(groups['netGroups'])),
                'reconstructionMatchesNative': True, 'allNonNetResponseFieldsEqual': True,
                'sourceFrozenRevisionHistoryUnchanged': True,
                'splitterSinkBitToConstantBits': mapping,
                'staticIssueCounts': {k: len(v) for k, v in bits['connectivityIssues'].items()
                                      if isinstance(v, list)}}
    finally:
        workspace.close()


def product_hashes():
    base = REPO / 'apps/desktop/circuit-lens'
    paths = [*base.glob('studio/**/*.py'), *base.glob('studio/**/*.json'),
             *base.glob('native/**/*.java'), *base.glob('observer/src/**/*.java')]
    return {str(p.relative_to(base)): sha(p.read_bytes()) for p in sorted(paths)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--observe-existing', action='store_true',
                        help='also read the existing 029 repair and 027 failed counter once per format')
    args = parser.parse_args()
    RUNS.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='net-groups-', dir=RUNS))
    for name in ('tmp', 'java-prefs', 'java-system-prefs'):
        (root / name).mkdir()
    # Cover Python/Java temporary files, persistent preferences and JVM perf data.
    os.environ['TMPDIR'] = str(root / 'tmp')
    tempfile.tempdir = str(root / 'tmp')
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    os.environ['JAVA_TOOL_OPTIONS'] = (
        f'-Djava.util.prefs.userRoot={root / "java-prefs"} '
        f'-Djava.util.prefs.systemRoot={root / "java-system-prefs"} '
        f'-Djava.io.tmpdir={root / "tmp"} -XX:-UsePerfData '
        f'-XX:ErrorFile={root}/hs_err_pid%p.log')
    report = {'status': 'running', 'runDir': str(root), 'modelCalls': 0,
              'behaviorOracleRuns': 0, 'uiRuns': 0,
              'scope': 'Information fidelity only; no model latency or task-success claim.',
              'byteMeasurement': 'Compact sorted-key UTF-8 JSON, ensure_ascii=False; no newline. '
                                 'Full production Workspace.agent_tool response, before Electron projection.',
              'head': subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', 'HEAD'], text=True).strip(),
              'productHashesBefore': product_hashes(), 'testSha256': sha(Path(__file__).read_bytes()),
              'observations': []}
    print(f'Evidence: {root}', flush=True)
    try:
        report['pureData'] = pure_data(root)
        runtimes = [('2.16.2.2', '9eb1aae5e87cf0c6e4af845dde00624338c6dce25d945b6482cad017aa6cbb34'),
                    ('2.15.0', 'b2400702fb9e8e4c71c512d7e09678a788039f402be55164209cde4cee8fc996')]
        for version, runtime_sha in runtimes:
            source = root / f'splitter-{version}.circ'
            source.write_bytes(fixture(version))
            result = observe(root, f'splitter-{version}', source, 'ReverseGroups', runtime_sha,
                             check_splitter=True)
            report['observations'].append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
        if args.observe_existing:
            for label, relative, digest in (
                ('029-repaired', 'experiments/029-topology-repair/evidence/repaired.circ',
                 '6bce6f1db03e7a20b62853be66161cb0ebc611a1bd509b2dee841a0be8ca4bef'),
                ('027-bad-counter', 'experiments/027-counter-from-blank/model-1.16/after.circ',
                 '32178318c1f838b20cacc547c7a56039ba0d8e68a7a303740ceb0e3147418093'),
            ):
                result = observe(root, label, REPO / relative, 'main', runtimes[1][1], digest)
                report['observations'].append(result)
                print(json.dumps(result, ensure_ascii=False), flush=True)
        report['status'] = 'passed'
    except Exception:
        report['status'] = 'failed'
        report['error'] = traceback.format_exc()
        raise
    finally:
        report['productHashesAfter'] = product_hashes()
        report['productFilesStableDuringRun'] = report['productHashesBefore'] == report['productHashesAfter']
        save(root, 'report.json', report)
        print(f'{report["status"]}: {root / "report.json"}', flush=True)


if __name__ == '__main__':
    main()
