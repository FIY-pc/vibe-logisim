"""Inspect a proposed snapshot without changing the active runtime/project."""
from studio.runtime.observer import ObserverRuntime
from studio.infrastructure.files import atomic_write_json, sha256_bytes


def inspect_snapshot(snapshot, circuit, repo_root, state_root, observer=None):
    snapshot.package.verify_frozen(snapshot.revision_dir)
    runtime = snapshot.package.runtime(repo_root)
    owned = observer is None or observer.runtime_jar != runtime
    if owned:
        observer = ObserverRuntime(repo_root, state_root)
        observer.runtime_jar = runtime
    try:
        profile = observer.profile(runtime_jar=runtime)
        cache = snapshot.revision_dir / 'exact' / profile['id'] / (sha256_bytes(circuit.encode()) + '.json')
        # Validate and draw once. The displayed revision consumes this exact same
        # observation instead of launching another complete inspection on refresh.
        document = observer.run_full(snapshot.frozen_path, circuit, cache.with_suffix('.png'), runtime_jar=runtime)
        if document.get('revision', {}).get('artifactSha256') != snapshot.artifact_sha256:
            raise ValueError('原生观察与待修改快照不匹配')
        atomic_write_json(cache, {'observationProfile': profile, 'document': document})
        circuit_names = {item['name'] for item in snapshot.raw_project['circuits']}
        return {
            'authority': 'exact-runtime',
            'coverage': document.get('coverage', {}),
            'wires': document['focus']['wires'],
            'bundles': document['focus']['wireBundles'],
            'components': [{
                'componentId': component['componentId'],
                'factory': component['factoryName'],
                'subcircuit': component['factoryName'] if component['factoryName'] in circuit_names else None,
                'location': component['location'],
                'bounds': component['bounds'],
                'ends': component.get('ends', []),
                'attributes': {a['name']: a.get('standard') for a in component.get('attributes', []) if a.get('name')},
            } for component in document['focus']['components']],
        }
    finally:
        if owned: observer.close()
