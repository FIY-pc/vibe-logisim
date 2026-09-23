"""Build a relocatable desktop bundle from explicit product inputs.

Run from a developer checkout. The resulting application needs no npm, Python,
Java or Codex installation. Bundles for every target are assembled from pinned
archives, so a Linux machine can produce the Windows bundle as well; nothing is
compiled at build time. Course runtime bundles remain LOCAL evaluation
artifacts until the course binary's source/redistribution terms are settled.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import zipfile

from artifacts import acquire, extract, sha256

REPO = Path(__file__).resolve().parents[2]
DESKTOP = REPO / 'apps/desktop'
TARGETS = ('linux-x64', 'win32-x64')


def copy_product(destination, prefix):
    files = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', prefix], cwd=REPO).decode().split('\0')
    for name in sorted(set(filter(None, files))):
        source = REPO / name
        relative = source.relative_to(REPO / prefix)
        if source.is_symlink():
            raise ValueError(f'Product sources must not escape the checkout: {name}')
        if source.suffix not in {'.py', '.java', '.cjs', '.js', '.mjs', '.html', '.css', '.svg', '.txt', '.md', '.sh', '.json', '.circ'}:
            continue
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def load_lock(target):
    lock = json.loads(Path(__file__).with_name('runtime-lock.json').read_text())
    if target not in lock['targets']:
        raise ValueError(f'Unknown target {target}; known: {", ".join(sorted(lock["targets"]))}')
    return lock


def write_zip(root, archive, name):
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for item in sorted(root.rglob('*')):
            output.write(item, Path(name) / item.relative_to(root))


def usage_text(target, version):
    common = ('Vibe Logisim ' + version + '\n\n解压整个文件夹后，双击 {launcher} 即可使用。\n'
              '无需另外安装 Python、Java 或 Codex。打开你的文件夹，选择或新建 .circ 电路。\n'
              'AI 面板可以登录 ChatGPT，也可以在「AI 设置」里填写 OpenAI 兼容接口的地址和密钥。\n\n')
    if target == 'win32-x64':
        return common.format(launcher='vibe-logisim.exe') + (
            '首次运行时 Windows 可能提示“未知发布者”，选择“更多信息 → 仍要运行”。\n'
            '内置 AI 只能修改你打开的文件夹，其他位置只读。\n'
            '课程运行文件 logisim-ita-cn-20200118.exe 是课程发布的 Logisim 运行包，由内置 Java 加载，不会单独运行。\n')
    return common.format(launcher='vibe-logisim') + (
        '当前支持 Linux x86_64 桌面（glibc、GTK3、systemd 用户服务）。\n'
        '课程运行文件的公开分发许可及对应源码仍待落实。\n')


def build(args):
    target = args.target
    lock = load_lock(target)
    spec = lock['targets'][target]
    metadata = json.loads((DESKTOP / 'package.json').read_text())
    if sha256(args.course_runtime) != lock['courseRuntime']['sha256']:
        raise ValueError('The supplied course runtime does not match the supported version.')
    if spec['electron']['version'] != metadata['devDependencies']['electron']:
        raise ValueError('runtime-lock.json Electron does not match the locked desktop version.')
    shared = acquire(args.cache, lock['artifacts'])
    platform_artifacts = acquire(args.cache / target, {**spec['artifacts'], 'electron.zip': spec['electron']})
    name = f'vibe-logisim-{metadata["version"]}-{target}'
    args.output.mkdir(parents=True, exist_ok=True)
    suffix = '.zip' if target.startswith('win32') else '.tar.gz'
    archive = args.output / f'{name}{suffix}'
    if archive.exists() or (args.output / name).exists():
        raise ValueError(f'Refusing to replace existing artifact: {archive}')
    windows = target.startswith('win32')
    with tempfile.TemporaryDirectory(prefix='vibe-build-', dir=args.output) as temporary:
        root = Path(temporary) / name
        extract(platform_artifacts['electron.zip'], root)
        (root / ('electron.exe' if windows else 'electron')).rename(root / ('vibe-logisim.exe' if windows else 'vibe-logisim'))
        (root / 'resources/default_app.asar').unlink(missing_ok=True)
        resources = root / 'resources'
        app = resources / 'app'
        product = resources / 'product'
        runtime = resources / 'runtime'
        copy_product(app / 'electron', 'apps/desktop/electron')
        copy_product(app / 'circuit-knowledge', 'apps/desktop/circuit-knowledge')
        copy_product(product / 'apps/desktop/circuit-lens', 'apps/desktop/circuit-lens')
        package = {k: metadata[k] for k in ('name', 'version', 'main', 'description')}
        (app / 'package.json').write_text(json.dumps(package, indent=2))
        (product / 'apps/desktop/package.json').write_text(json.dumps(package))
        # Browser-only PDF.js; its optional Node canvas and dev tools are not
        # needed in Electron's sandboxed preview renderer.
        pdf = app / 'node_modules/pdfjs-dist'
        for item in ('build', 'cmaps', 'standard_fonts', 'wasm', 'LICENSE', 'package.json'):
            source = DESKTOP / 'node_modules/pdfjs-dist' / item
            if not source.exists():
                raise ValueError('Run npm ci in apps/desktop before building (pdfjs-dist missing).')
            target_path = pdf / item
            if source.is_dir(): shutil.copytree(source, target_path)
            else:
                target_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target_path)
        extract(platform_artifacts['python'], runtime / 'python', strip_root=True)
        extract(platform_artifacts['java'], runtime / 'java', strip_root=True)
        # javac/java only need lib/modules; the jmods link-time inputs and the
        # JDK source archive add ~130 MB that no code path reads.
        shutil.rmtree(runtime / 'java/jmods', ignore_errors=True)
        (runtime / 'java/lib/src.zip').unlink(missing_ok=True)
        extract(platform_artifacts['codex'], runtime / 'codex')
        shutil.copy2(shared['codex-LICENSE'], runtime / 'codex/LICENSE')
        expected = ['python/python.exe', 'java/bin/java.exe', 'java/bin/javac.exe', 'codex/bin/codex.exe', 'codex/bin/codex-code-mode-host.exe'] if windows \
            else ['python/bin/python3', 'java/bin/java', 'java/bin/javac', 'codex/bin/codex', 'codex/bin/codex-code-mode-host']
        missing = [p for p in expected if not (runtime / p).exists()]
        if missing:
            raise ValueError('Runtime layout mismatch, electron/runtime-paths.cjs expects: ' + ', '.join(missing))
        native = product / 'apps/desktop/circuit-lens/native/Logisim-ITA.jar'
        shutil.copy2(shared['logisim.jar'], native)
        course = product / 'workspaces/hust-riscv/original/course-package'
        course.mkdir(parents=True)
        shutil.copy2(args.course_runtime, course / lock['courseRuntime']['name'])
        notices = resources / 'third-party'
        notices.mkdir()
        shutil.copy2(shared['logisim-source.tar.gz'], notices / 'logisim-2.16.2.2-source.tar.gz')
        shutil.copy2(REPO / 'THIRD_PARTY.md', notices / 'THIRD_PARTY.md')
        if (REPO / 'LICENSE').is_file():
            shutil.copy2(REPO / 'LICENSE', root / 'LICENSE.txt')
        (resources / 'runtime-manifest.json').write_text(json.dumps({
            'schema': lock['schema'], 'target': target, 'artifacts': {**lock['artifacts'], **spec['artifacts']},
            'electron': spec['electron']['version'], 'courseRuntime': lock['courseRuntime'],
            'pdfjs': json.loads((pdf / 'package.json').read_text())['version'],
            'productVersion': metadata['version'], 'distribution': args.distribution}, indent=2, ensure_ascii=False))
        (root / '使用说明.txt').write_text(usage_text(target, metadata['version']), encoding='utf-8')
        # Manifest excludes itself. It records shipped bytes, not a claim of
        # reproducible compilation or of third-party license clearance.
        inventory = {str(p.relative_to(root)).replace('\\', '/'): sha256(p) for p in sorted(root.rglob('*')) if p.is_file() and not p.is_symlink()}
        (resources / 'files.sha256.json').write_text(json.dumps(inventory, indent=2))
        if args.unpacked:
            shutil.move(root, args.output / name)
            print(json.dumps({'directory': str(args.output / name), 'target': target, 'distribution': args.distribution}), flush=True)
            return
        staging = Path(temporary) / ('application' + suffix)
        if windows:
            write_zip(root, staging, name)
        else:
            with tarfile.open(staging, 'w:gz', compresslevel=6) as output:
                output.add(root, arcname=name)
        staging.replace(archive)
    (archive.with_suffix(archive.suffix + '.sha256')).write_text(f'{sha256(archive)}  {archive.name}\n')
    print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size, 'target': target, 'distribution': args.distribution}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--target', choices=TARGETS, default='linux-x64')
    parser.add_argument('--cache', type=Path, default=Path(tempfile.gettempdir()) / 'vibe-distribution-cache')
    parser.add_argument('--course-runtime', type=Path, required=True)
    parser.add_argument('--distribution', default='release', help='Label recorded in runtime-manifest.json')
    parser.add_argument('--unpacked', action='store_true', help='Prepare a directory for packaged-app acceptance before compression')
    build(parser.parse_args())
