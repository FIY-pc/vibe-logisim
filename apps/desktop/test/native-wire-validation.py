"""Bounded two-JAR wire preflight calibration; no model or production callers.

Reuse runtime-execution.py's native Pin fixture. Keep commands, stderr, source
hashes and native port/wire snapshots under the requested persistent output root.
"""
import argparse
import base64
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import time
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('runtime_fixture', Path(__file__).with_name('runtime-execution.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-root', type=Path, default=REPO)
    parser.add_argument('--output-root', type=Path, required=True)
    parser.add_argument('--model-artifact', type=Path)
    args = parser.parse_args()
    output = args.output_root.resolve() / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    output.mkdir(parents=True)
    evidence = {'output': str(output), 'runtimes': [], 'sources': {}, 'passed': False}

    def remember(path):
        digest = sha(path)
        assert evidence['sources'].setdefault(str(path), digest) == digest, path
        return path

    def run(directory, name, command, timeout=12):
        start = time.monotonic()
        try:
            result = subprocess.run(command, capture_output=True, timeout=timeout)
            code, stdout, stderr = result.returncode, result.stdout, result.stderr
        except subprocess.TimeoutExpired as error:
            code, stdout, stderr = 'timeout', error.stdout or b'', error.stderr or b''
        record = {'command': command, 'returncode': code, 'elapsedSeconds': time.monotonic() - start}
        (directory / (name + '.stdout')).write_bytes(stdout)
        (directory / (name + '.stderr')).write_bytes(stderr)
        (directory / (name + '.json')).write_text(json.dumps(record, indent=2) + '\n')
        return record, stdout.decode('utf-8', 'replace'), stderr.decode('utf-8', 'replace')

    try:
        for version, relative_jar in fixture.RUNTIMES:
            jar = args.runtime_root.resolve() / relative_jar.relative_to(REPO)
            directory = output / version
            directory.mkdir()
            classes = directory / 'classes'
            classes.mkdir()
            home = directory / 'java-home'
            home.mkdir()
            report = {'version': version, 'jar': str(jar), 'sha256': sha(jar)}
            evidence['runtimes'].append(report)
            helper = REPO / 'apps/desktop/circuit-lens/native/com/cburch/logisim/file/NativeCircuitLoader.java'
            probe = Path(__file__).with_name('support') / 'NativeWireValidation.java'
            record, _, stderr = run(directory, 'compile', ['javac', '-encoding', 'UTF-8', '-cp', str(jar),
                '-d', str(classes), str(helper), str(probe)], timeout=30)
            assert record['returncode'] == 0, stderr
            for name in ['WireIterator', 'WireRepair']:
                run(directory, 'javap-' + name, ['javap', '-classpath', str(jar), '-c', '-p',
                    'com.cburch.logisim.circuit.' + name])
            run(directory, 'javap-Location', ['javap', '-classpath', str(jar), '-c', 'com.cburch.logisim.data.Location'])

            def write(name, root):
                path = directory / (name + '.circ')
                path.write_bytes(ET.tostring(root, encoding='utf-8', xml_declaration=True))
                return remember(path)

            def execute(name, mode, paths):
                command = ['java', '-Xmx64m', '-Djava.awt.headless=true', '-Duser.home=' + str(home),
                    '-cp', str(classes) + ':' + str(jar), 'NativeWireValidation', mode, *map(str, paths)]
                record, stdout, stderr = run(directory, name, command)
                rows = []
                for line in stdout.splitlines():
                    status, millis, calls, encoded = line.split('\t')
                    rows.append({'status': status, 'loadMs': float(millis), 'nativeCalls': int(calls),
                        'detail': base64.b64decode(encoded).decode()})
                record.update(rows=rows, stderr=stderr)
                return record

            base = ET.fromstring(fixture.fixture(version))
            valid = [write('pins', base)]
            edges = [
                ('vertical', '(240,140)', '(240,180)'),
                ('reverse-horizontal', '(280,140)', '(240,140)'),
                ('reverse-vertical', '(240,180)', '(240,140)'),
                ('negative', '(-80,-70)', '(-20,-70)'),
                ('off-grid', '(83,87)', '(107,87)'),
                ('off-grid-reverse', '(107,87)', '(83,87)'),
                ('off-grid-vertical', '(87,83)', '(87,107)'),
                ('off-grid-short', '(83,87)', '(84,87)'),
                ('zero', '(100,100)', '(100,100)'),
                ('off-grid-negative-zero', '(-83,-87)', '(-83,-87)'),
                ('native-coordinate-syntax', ' ( +83 , 87 ) ', '107 87'),
            ]
            for name, start, end in edges:
                root = deepcopy(base)
                child = ET.SubElement(root, 'circuit', name='UnusedChild')
                ET.SubElement(child, 'wire', {'from': start, 'to': end})
                valid.append(write(name, root))
            hierarchy = deepcopy(base)
            child = deepcopy(base.find('circuit'))
            child.set('name', 'Child')
            hierarchy.append(child)
            ET.SubElement(hierarchy.find('circuit'), 'comp', name='Child', loc='(350,200)')
            valid.append(write('hierarchy', hierarchy))

            # Probe the original native boundary before asserting helper parity.
            old = execute('valid-old', 'old', valid)
            report['validOld'] = old
            assert old['returncode'] == 0 and len(old['rows']) == len(valid), old
            assert all(row['status'] == 'OK' for row in old['rows']), old
            new = execute('valid-new', 'new', valid)
            report['validNew'] = new
            assert new['returncode'] == 0 and len(new['rows']) == len(valid), new
            for path, left, right in zip(valid, old['rows'], new['rows']):
                assert right['status'] == 'OK' and right['nativeCalls'] == 1, (path, right)
                assert left['detail'] == right['detail'], (path, left, right)
            assert ':port=' in new['rows'][0]['detail'] and ':wire:' in new['rows'][0]['detail']
            report['validCases'] = [path.stem for path in valid]

            minimal = deepcopy(base)
            minimal.find('circuit').clear()
            minimal.find('circuit').set('name', 'main')
            ET.SubElement(minimal.find('circuit'), 'wire', {'from': '(240,140)', 'to': '(280,160)'})
            bad = write('diagonal-minimal', minimal)
            broken = execute('diagonal-old', 'old', [bad])
            report['oldFailure'] = broken
            assert broken['returncode'] not in (0, 'timeout'), broken
            assert 'OutOfMemoryError' in broken['stderr'] and 'WireRepair.doOverlaps' in broken['stderr'], broken

            invalid = [bad]
            # Same-file definitions are checked even if main never instantiates them.
            child_bad = deepcopy(base)
            child = deepcopy(base.find('circuit'))
            child.set('name', '未实例化子电路')
            ET.SubElement(child, 'wire', {'from': '(240,140)', 'to': '(280,160)'})
            child_bad.append(child)
            invalid.append(write('diagonal-child', child_bad))
            diagonal45 = deepcopy(minimal)
            diagonal45.find('circuit/wire').set('to', '(260,160)')
            invalid.append(write('diagonal-45', diagonal45))
            malformed_paths = []
            for name, value in [('bad-coordinate', '(oops,80)'), ('missing-coordinate', None),
                                ('blank-coordinate', '  '), ('unclosed-coordinate', '(')]:
                malformed = deepcopy(base)
                if value is None:
                    del malformed.find('circuit/wire').attrib['from']
                else:
                    malformed.find('circuit/wire').set('from', value)
                malformed_paths.extend([write(name, malformed), valid[0]])
            malformed_old = execute('bad-coordinate-old', 'old', malformed_paths)
            malformed_new = execute('bad-coordinate-new', 'new', malformed_paths)
            report['malformedOld'], report['malformedNew'] = malformed_old, malformed_new
            assert malformed_old['returncode'] == malformed_new['returncode'] == 0
            assert len(malformed_old['rows']) == len(malformed_new['rows']) == len(malformed_paths)
            for left, right in zip(malformed_old['rows'], malformed_new['rows']):
                assert left['status'] == right['status'] and left['detail'] == right['detail']
                assert right['nativeCalls'] == 1, right
            assert malformed_new['rows'][1]['detail'] == new['rows'][0]['detail']

            sentinel = directory / 'external.txt'
            sentinel.write_text('NATIVE_WIRE_EXTERNAL_ENTITY_MUST_NOT_BE_READ')
            for name, doctype in [
                ('external-general', '<!DOCTYPE project [<!ENTITY external SYSTEM "' + sentinel.as_uri() + '">]>'),
                ('external-parameter', '<!DOCTYPE project [<!ENTITY % external SYSTEM "' + sentinel.as_uri() + '">%external;]>'),
                ('external-dtd', '<!DOCTYPE project SYSTEM "' + sentinel.as_uri() + '">'),
            ]:
                path = directory / (name + '.circ')
                path.write_text(doctype + fixture.fixture(version).replace('<main', '&external;<main', 1)
                    if name == 'external-general' else doctype + fixture.fixture(version))
                invalid.append(remember(path))
            if args.model_artifact:
                invalid.append(remember(args.model_artifact.resolve()))
            sequence = [path for bad_path in invalid for path in (bad_path, valid[0])]
            recovery = execute('reject-and-recover', 'new', sequence)
            report['recovery'] = recovery
            assert recovery['returncode'] == 0 and len(recovery['rows']) == len(sequence), recovery
            for index, path in enumerate(invalid):
                rejected, recovered = recovery['rows'][index * 2:index * 2 + 2]
                assert rejected['status'] == 'REJECT' and rejected['nativeCalls'] == 0, (path, rejected)
                assert rejected['loadMs'] < 2000, (path, rejected)
                assert recovered['status'] == 'OK' and recovered['nativeCalls'] == 1, (path, recovered)
                assert recovered['detail'] == new['rows'][0]['detail'], (path, recovered)
                assert 'NATIVE_WIRE_EXTERNAL_ENTITY_MUST_NOT_BE_READ' not in rejected['detail']
            first = recovery['rows'][0]['detail']
            assert all(text in first for text in ['main', 'wire #1', '(240,140)', '(280,160)', '水平', '垂直'])
            assert '未实例化子电路' in recovery['rows'][2]['detail'] and 'wire #2' in recovery['rows'][2]['detail']
            for row in recovery['rows'][6:12:2]:
                assert 'DOCTYPE' in row['detail'], row
            report['rejectedCases'] = [path.stem for path in invalid]
        evidence['passed'] = True
    finally:
        changed = [name for name, digest in evidence['sources'].items() if sha(Path(name)) != digest]
        evidence['sourceBytesUnchanged'] = not changed
        evidence['passed'] = evidence['passed'] and not changed
        evidence['changedSources'] = changed
        (output / 'results.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
        print(output / 'results.json')
        assert not changed, changed


if __name__ == '__main__':
    main()
