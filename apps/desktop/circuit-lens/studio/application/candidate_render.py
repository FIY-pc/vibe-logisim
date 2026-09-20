"""Read-only candidate images using the ordinary opaque viewport renderer."""
from http import HTTPStatus
import struct
import tempfile
from pathlib import Path
import xml.etree.ElementTree as ET

from studio.domain.errors import LensError
from studio.infrastructure.files import sha256_bytes
from studio.project.package import ProjectPackage
from studio.runtime.rendering import RenderInput, viewport


def render_candidate_for_agent(w, values):
    candidate_id = values['candidateId']

    def stale():
        raise LensError(HTTPStatus.CONFLICT, 'STALE_RENDER', '候选、当前工程文件或运行环境已变化，请重新读取。')

    with w.lock:
        w._require()
        directory, candidate = w.workbench._metadata(candidate_id)
        if candidate.get('id') != candidate_id:
            stale()
        with w.observation_artifact():
            pass  # Reuse frozen base/dependency validation; never materialize a source file.
        project_id, revision = w.history.record['id'], w.revision_id
        source_path, current_sha = w.source_path, w.artifact_sha256
        if w.source_status().get('stale'):
            stale()
        artifact = directory / 'artifact.circ'
        artifact_sha = candidate['artifactSha256']
        package = ProjectPackage(artifact.read_bytes(), artifact)
        runtime = w.package.runtime(w.repo_root)
        if (not package.supported or package.runtime(w.repo_root).resolve() != runtime.resolve()
                or w.observer.runtime_jar.resolve() != runtime.resolve()):
            stale()
        profile = dict(w.observer.profile())
        if not profile.get('id'):
            raise ValueError(profile.get('error') or '候选的原生运行环境不可用')
        backends = (w.observer, w.renderer, w.observer.worker, w.renderer.worker)
        root = ET.fromstring(artifact.read_bytes())
        name = values.get('circuit') or root.find('main').get('name')
        if not any(c.get('name') == name for c in root.findall('circuit')):
            raise ValueError('候选中没有指定电路：' + str(name))
        region = values.get('viewport')
        if region is not None:
            viewport(region)
        snapshot = RenderInput(artifact, artifact_sha, runtime, profile['runtimeJarSha256'])

    # Native bounds include labels and the established overview margin/scale.
    # The temporary transparent overview is only for bounds; UI candidate PNGs
    # remain untouched. The delivered image always uses the opaque renderer.
    with tempfile.TemporaryDirectory(prefix='candidate-render-', dir=w.state_root) as temporary:
        document = backends[0].run_full(artifact, name, Path(temporary) / 'bounds.png', runtime_jar=runtime)
    if (document.get('revision', {}).get('artifactSha256') != artifact_sha
            or document.get('runtime', {}).get('jarSha256') != profile['runtimeJarSha256']
            or document.get('focus', {}).get('circuit') != name):
        stale()
    if region is None:
        region = {**document['render']['bounds'], 'scale': document['render']['scale']}
    data = backends[1].render(snapshot, name, viewport(region))
    if len(data) > 4 * 1024 * 1024:
        raise ValueError('图面超过模型图像大小限制；请用 viewport 分块查看，范围建议不超过 2048×2048')
    if not data.startswith(b'\x89PNG\r\n\x1a\n') or len(data) < 24:
        raise ValueError('原生图面不是有效 PNG')
    pixel_width, pixel_height = struct.unpack('>II', data[16:24])
    with w.lock:
        if (w.history.record['id'] != project_id or w.revision_id != revision
                or w.source_path != source_path or w.artifact_sha256 != current_sha
                or w.source_status().get('stale')
                or (w.observer, w.renderer, w.observer.worker, w.renderer.worker) != backends
                or w.observer.runtime_jar.resolve() != runtime.resolve()
                or w.observer.profile()['id'] != profile['id']):
            stale()
        _, current_candidate = w.workbench._metadata(candidate_id)
        if current_candidate != candidate:
            stale()
        # Use the actual observed version while retaining the checked profile
        # identity; Workbench must not silently relabel a candidate as current.
        observed_profile = w.observer.profile(document['runtime'].get('reportedVersion'))
        if observed_profile['id'] != profile['id']:
            stale()
    return data, {
        'target': 'candidate', 'candidateId': candidate_id, 'circuit': name,
        'revisionId': revision, 'baseRevisionId': candidate['baseRevisionId'],
        'currentArtifactSha256': current_sha, 'artifactSha256': artifact_sha,
        'runtimeProfileId': profile['id'], 'runtimeProfile': observed_profile,
        'authority': 'Logisim native Circuit.draw',
        'kind': 'viewport' if values.get('viewport') is not None else 'full',
        'region': {key: region[key] for key in ('x', 'y', 'width', 'height')}, 'scale': region['scale'],
        'pixelWidth': pixel_width, 'pixelHeight': pixel_height,
        'background': 'white', 'imageSha256': sha256_bytes(data), 'bytes': len(data),
    }
