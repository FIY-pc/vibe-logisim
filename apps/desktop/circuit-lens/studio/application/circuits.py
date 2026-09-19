from __future__ import annotations

from http import HTTPStatus
import struct
from urllib.parse import quote
from studio.domain.errors import LENS_SCHEMA, LensError
from studio.infrastructure.files import atomic_write_json, read_json, sha256_bytes
from studio.runtime.geometry import circuit_summary
from studio.runtime.rendering import RenderInput, viewport

class CircuitQueries:
    def __init__(self, workspace):
        self.workspace = workspace

    def render_viewport(self, values):
        w = self.workspace
        try:
            region = viewport(values)
        except ValueError as error:
            raise LensError(HTTPStatus.BAD_REQUEST, 'INVALID_VIEWPORT', str(error)) from error
        with w.lock:
            w._require()
            revision, profile_id = values.get('revisionId'), values.get('profileId')
            profile = w.observer.profile()
            if revision != w.revision_id or profile_id != profile['id']:
                raise LensError(HTTPStatus.CONFLICT, 'STALE_RENDER', '电路或运行环境已改变')
            name = values.get('name', '')
            self._raw_circuit(name)
            project_id = w.history.record['id']
            with w.observation_artifact() as artifact:
                snapshot = RenderInput(artifact, w.artifact_sha256, w.observer.runtime_jar, profile['runtimeJarSha256'])
        try:
            data = w.renderer.render(snapshot, name, region)
        except Exception as error:
            raise LensError(HTTPStatus.SERVICE_UNAVAILABLE, 'RENDER_UNAVAILABLE', str(error)) from error
        with w.lock:
            if (w.history.record['id'] != project_id or w.revision_id != revision or
                    w.observer.profile()['id'] != profile_id):
                raise LensError(HTTPStatus.CONFLICT, 'STALE_RENDER', '电路或运行环境已改变')
        return data

    def render_for_agent(self, values):
        """Return a bounded native image for a model-facing visual observation.

        The image is read from the same revision/profile cache as the desktop
        canvas. The caller turns the bytes into an app-server inputImage; this
        layer never exposes a host path to the model.
        """
        w = self.workspace
        with w.lock:
            w._require()
            name = values.get('circuit') or w.raw_project['mainCircuit']
            view = self.circuit_view(name)
            render = view.get('circuit', {}).get('render')
            if not render or not view.get('capabilities', {}).get('exactConnectivity'):
                raise ValueError('当前电路没有可用的原生图面，请先确认匹配的 Logisim 运行环境')
            revision = w.revision_id
            profile_id = render['profileId']
            artifact_sha = w.artifact_sha256
            region = values.get('viewport')
            if region is None:
                image = w.revision_dir / 'exact' / profile_id / (sha256_bytes(name.encode('utf-8')) + '.png')
                if not image.is_file():
                    raise ValueError('原生电路图面尚未生成，请稍后重试')
                data = image.read_bytes()
                kind = 'full'
                description = render['bounds']
                scale = render.get('scale')
            else:
                kind = 'viewport'
                description = {key: region[key] for key in ('x', 'y', 'width', 'height', 'scale')}
                scale = region['scale']
        if region is not None:
            data = self.render_viewport({
                'revisionId': revision,
                'profileId': profile_id,
                'name': name,
                **region,
            })
        if len(data) > 4 * 1024 * 1024:
            raise ValueError('图面超过模型图像大小限制；请用 viewport 分块查看，范围建议不超过 2048×2048')
        if not data.startswith(b'\x89PNG\r\n\x1a\n') or len(data) < 24:
            raise ValueError('原生图面不是有效 PNG')
        pixel_width, pixel_height = struct.unpack('>II', data[16:24])
        with w.lock:
            if w.revision_id != revision or w.artifact_sha256 != artifact_sha:
                raise ValueError('电路在图面生成期间已经变化，请重新查看当前版本')
        return data, {
            'circuit': name,
            'revisionId': revision,
            'artifactSha256': artifact_sha,
            'runtimeProfileId': profile_id,
            'authority': 'Logisim native Circuit.draw',
            'kind': kind,
            'region': description,
            'scale': scale,
            'pixelWidth': pixel_width,
            'pixelHeight': pixel_height,
            'bytes': len(data),
        }

    def _raw_circuit(self, name: str) -> dict[str, Any]:
        self.workspace._require()
        for circuit in self.workspace.raw_project['circuits']:
            if circuit['name'] == name:
                return circuit
        raise LensError(HTTPStatus.NOT_FOUND, 'CIRCUIT_NOT_FOUND', f'Unknown circuit: {name}')

    def _raw_view(self, name: str, observer_error: str | None) -> dict[str, Any]:
        circuit = self._raw_circuit(name)
        capabilities = self.workspace._base_capabilities()
        capabilities.update({'exactConnectivity': False, 'taskQueries': False})
        geometry_profile = self.workspace._geometry_profile()
        capabilities['observationProfile'] = geometry_profile
        capabilities['profile'] = geometry_profile
        unknowns: list[dict[str, Any]] = [{'code': 'GEOMETRY_ONLY_NO_CONNECTIVITY', 'claim': 'Components and wire segments come from raw XML. No wire junction, Tunnel, Splitter, bus-bit, or crossing connectivity has been inferred.'}, {'code': 'APPROXIMATE_COMPONENT_BOUNDS', 'claim': 'Fallback component bounds are approximate point markers, not runtime bounds.'}]
        if self.workspace.source_mode == 'upload' and self.workspace.external_relative:
            unknowns.append({'code': 'UPLOAD_RELATIVE_LIBRARIES_UNSUPPORTED', 'claim': 'The upload has relative external libraries but no original directory.', 'descriptors': self.workspace.external_relative})
        if self.workspace.package and (not self.workspace.package.supported):
            unknowns.append({'code': 'EXTERNAL_LIBRARIES_NOT_FROZEN', 'claim': 'The revision freezes the project artifact bytes, but referenced external library bytes are not yet part of the revision identity.', 'descriptors': self.workspace.external_libraries})
        return {'schema': LENS_SCHEMA, 'revision': {'id': self.workspace.revision_id, 'artifactSha256': self.workspace.artifact_sha256}, 'project': circuit_summary(self.workspace.raw_project), 'circuit': {'name': circuit['name'], 'bounds': circuit['bounds'], 'components': circuit['components'], 'wires': circuit['wires'], 'nets': [], 'bundles': [], 'instances': circuit['instances'], 'instancePaths': []}, 'capabilities': capabilities, 'unknowns': unknowns, 'observerError': {'code': 'EXACT_OBSERVER_FAILED', 'message': observer_error} if observer_error else None, 'sourceStatus': self.workspace.source_status()}

    def circuit_view(self, name: str) -> dict[str, Any]:
        with self.workspace.lock:
            self.workspace._require()
            self._raw_circuit(name)
            if self.workspace.runtime_error:
                return self._raw_view(name, self.workspace.runtime_error)
            if self.workspace.package and (not self.workspace.package.supported):
                return self._raw_view(name, ' '.join(self.workspace.package.errors))
            profile = self.workspace.observer.profile()
            if not profile.get('id'):
                return self._raw_view(name, profile.get('error') or 'Exact runtime unavailable')
            cache_name = sha256_bytes(name.encode('utf-8')) + '.json'
            cache_path = self.workspace.revision_dir / 'exact' / profile['id'] / cache_name
            cached = read_json(cache_path)
            document = None
            if isinstance(cached, dict) and cached.get('observationProfile', {}).get('id') == profile['id'] and isinstance(cached.get('document'), dict):
                document = cached['document']
            if document is None:
                try:
                    with self.workspace.observation_artifact() as artifact:
                        document = self.workspace.observer.run_full(artifact, name, cache_path.with_suffix('.png'))
                    if document.get('revision', {}).get('artifactSha256') != self.workspace.artifact_sha256:
                        raise RuntimeError('Observer result is not bound to the frozen revision.')
                    atomic_write_json(cache_path, {'observationProfile': profile, 'document': document})
                except Exception as error:
                    return self._raw_view(name, str(error))
            if document.get('runtime', {}).get('jarSha256') != profile.get('runtimeJarSha256'):
                return self._raw_view(name, 'Cached observation runtime digest does not match its profile.')
            if document.get('revision', {}).get('artifactSha256') != self.workspace.artifact_sha256:
                return self._raw_view(name, 'Cached observation artifact digest does not match this revision.')
            return self._transform_exact(document, profile)

    def _transform_exact(self, document: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
        focus = document['focus']
        components: list[dict[str, Any]] = []
        for component in focus['components']:
            attribute_details = component.get('attributes', [])
            attributes = {item['name']: item.get('standard') for item in attribute_details if item.get('name')}
            components.append({'componentId': component['componentId'], 'factory': component['factoryName'], 'displayName': component.get('displayName'), 'label': component.get('selector', {}).get('label'), 'location': component['location'], 'bounds': component['bounds'], 'boundsAuthority': 'exact Logisim runtime', 'attributes': attributes, 'attributeDetails': attribute_details, 'factoryClass': component.get('factoryClass'), 'factoryProvenance': component.get('factoryProvenance'), 'ends': component.get('ends', []), 'subcircuit': component.get('subcircuit')})
        circuit_summary_exact = next((item for item in document['project']['circuits'] if item['name'] == focus['circuit']), None)
        instances = circuit_summary_exact.get('instances', []) if circuit_summary_exact else []
        capabilities = self.workspace._base_capabilities()
        observed_profile = dict(profile)
        reported_version = document['runtime'].get('reportedVersion')
        display_version = reported_version[:-4] if reported_version and reported_version.lower().endswith('.jar') else reported_version
        observed_profile.update({'status': 'observed', 'reportedVersion': reported_version, 'display': f"Logisim-ITA {display_version or 'unknown'} · {document['runtime'].get('jarSha256', '')[:12]}"})
        capabilities.update({'exactConnectivity': True, 'taskQueries': True, 'connectivityAuthority': document['observer']['connectivityAuthority'], 'observationProfile': observed_profile, 'profile': observed_profile})
        unknowns = list(document['unknowns'])
        if self.workspace.package and (not self.workspace.package.supported):
            unknowns.append({'code': 'EXTERNAL_LIBRARIES_NOT_FROZEN', 'claim': 'Exact connectivity used the currently resolved external libraries, whose bytes are not included in this artifact revision ID.', 'descriptors': self.workspace.external_libraries})
        return {'schema': LENS_SCHEMA, 'revision': {'id': self.workspace.revision_id, 'artifactSha256': self.workspace.artifact_sha256}, 'project': document['project'], 'circuit': {'name': focus['circuit'], 'bounds': focus['bounds'], 'render': {**document['render'], 'viewportUrl': '/api/render/viewport', 'revisionId': self.workspace.revision_id, 'profileId': profile['id'], 'url': '/api/render?revisionId=' + quote(self.workspace.revision_id) + '&name=' + quote(focus['circuit']) + '&profileId=' + quote(profile['id'])} if document.get('render') else None, 'components': components, 'wires': focus['wires'], 'nets': focus['bitNets'], 'bundles': focus['wireBundles'], 'instances': instances, 'instancePaths': focus['instancePaths'], 'stateElements': focus['stateElements'], 'tunnels': focus['tunnels'], 'widthIncompatibilities': focus['widthIncompatibilities']}, 'capabilities': capabilities, 'coverage': document['coverage'], 'unknowns': unknowns, 'observer': document['observer'], 'runtime': document['runtime'], 'observerError': None, 'sourceStatus': self.workspace.source_status()}
