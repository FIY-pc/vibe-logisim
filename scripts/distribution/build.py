"""Build a relocatable Linux desktop from explicit product inputs.

Run from a developer checkout. The resulting application needs no npm, Python,
Java, Codex or Poppler installation. Course runtime bundles are LOCAL evaluation
artifacts until the course binary's source/redistribution terms are established.
"""
import argparse
import json
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile

from artifacts import acquire, extract, sha256

REPO = Path(__file__).resolve().parents[2]
DESKTOP = REPO / 'apps/desktop'


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


def build(args):
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise ValueError('This target currently builds and validates Linux x86_64 only.')
    lock = json.loads(Path(__file__).with_name('runtime-lock.json').read_text())
    metadata = json.loads((DESKTOP / 'package.json').read_text())
    electron = DESKTOP / 'node_modules/electron/dist'
    if not (electron / 'electron').is_file():
        raise ValueError('Run npm ci in apps/desktop before building.')
    installed = (electron / 'version').read_text().strip().removeprefix('v')
    if installed != metadata['devDependencies']['electron']:
        raise ValueError('Electron does not match the locked desktop version.')
    if sha256(args.course_runtime) != lock['courseRuntime']['sha256']:
        raise ValueError('The supplied course runtime does not match the supported version.')
    artifacts = acquire(args.cache, lock['artifacts'])
    name = f'vibe-logisim-{metadata["version"]}-linux-x64'
    args.output.mkdir(parents=True, exist_ok=True)
    archive = args.output / f'{name}.tar.gz'
    if archive.exists() or (args.output / name).exists():
        raise ValueError(f'Refusing to replace existing artifact: {archive}')
    with tempfile.TemporaryDirectory(prefix='vibe-build-', dir=args.output) as temporary:
        root = Path(temporary) / name
        shutil.copytree(electron, root, symlinks=True)
        (root / 'electron').rename(root / 'vibe-logisim')
        (root / 'resources/default_app.asar').unlink(missing_ok=True)
        resources = root / 'resources'
        app = resources / 'app'
        product = resources / 'product'
        runtime = resources / 'runtime'
        copy_product(app / 'electron', 'apps/desktop/electron')
        copy_product(product / 'apps/desktop/circuit-lens', 'apps/desktop/circuit-lens')
        package = {k: metadata[k] for k in ('name', 'version', 'main', 'description')}
        (app / 'package.json').write_text(json.dumps(package, indent=2))
        (product / 'apps/desktop/package.json').write_text(json.dumps(package))
        # Browser-only PDF.js; its optional Node canvas and dev tools are not
        # needed in Electron's sandboxed preview renderer.
        pdf = app / 'node_modules/pdfjs-dist'
        for item in ('build', 'cmaps', 'standard_fonts', 'wasm', 'LICENSE', 'package.json'):
            source = DESKTOP / 'node_modules/pdfjs-dist' / item
            target = pdf / item
            if source.is_dir(): shutil.copytree(source, target)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
        extract(artifacts['python.tar.gz'], runtime / 'python', strip_root=True)
        extract(artifacts['java.tar.gz'], runtime / 'java', strip_root=True)
        extract(artifacts['codex.tar.gz'], runtime / 'codex')
        shutil.copy2(artifacts['codex-LICENSE'], runtime / 'codex/LICENSE')
        native = product / 'apps/desktop/circuit-lens/native/Logisim-ITA.jar'
        shutil.copy2(artifacts['logisim.jar'], native)
        course = product / 'workspaces/hust-riscv/original/course-package'
        course.mkdir(parents=True)
        shutil.copy2(args.course_runtime, course / lock['courseRuntime']['name'])
        notices = resources / 'third-party'
        notices.mkdir()
        shutil.copy2(artifacts['logisim-source.tar.gz'], notices / 'logisim-2.16.2.2-source.tar.gz')
        shutil.copy2(REPO / 'THIRD_PARTY.md', notices / 'THIRD_PARTY.md')
        (resources / 'runtime-manifest.json').write_text(json.dumps({**lock, 'electron': installed,
            'pdfjs': json.loads((pdf / 'package.json').read_text())['version'],
            'productVersion': metadata['version'], 'distribution': 'local-evaluation'}, indent=2))
        (root / '使用说明.txt').write_text('Vibe Logisim\n\n解压整个文件夹后，打开 vibe-logisim 即可使用。\n无需安装 Python、Java、Codex 或 Poppler。打开你的文件夹，选择或新建 .circ 电路；AI 面板可登录 ChatGPT。\n\n此构建用于本地验收，尚未公开发布。当前支持 Linux x86_64 桌面（glibc、GTK3、systemd 用户服务）。课程运行文件的公开分发许可及对应源码仍待落实。\n')
        # Manifest excludes itself. It records shipped bytes, not a claim of
        # reproducible compilation or of third-party license clearance.
        inventory = {str(p.relative_to(root)): sha256(p) for p in sorted(root.rglob('*')) if p.is_file() and not p.is_symlink()}
        (resources / 'files.sha256.json').write_text(json.dumps(inventory, indent=2))
        if args.unpacked:
            shutil.move(root, args.output / name)
            print(json.dumps({'directory': str(args.output / name), 'distribution': 'local-evaluation'}), flush=True)
            return
        staging = Path(temporary) / 'application.tar.gz'
        with tarfile.open(staging, 'w:gz', compresslevel=6) as output:
            output.add(root, arcname=name)
        staging.replace(archive)
    (archive.with_suffix(archive.suffix + '.sha256')).write_text(f'{sha256(archive)}  {archive.name}\n')
    print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size, 'distribution': 'local-evaluation'}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache', type=Path, default=Path(tempfile.gettempdir()) / 'vibe-distribution-cache')
    parser.add_argument('--course-runtime', type=Path, required=True)
    parser.add_argument('--unpacked', action='store_true', help='Prepare a directory for packaged-app acceptance before compression')
    build(parser.parse_args())
