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


# Modules Logisim-ITA 2.16, the HUST course runtime and the Java bridge need
# (jdeps on all three; gson's stray module-info in the ITA jar hides the real
# list unless removed). jdk.compiler is required because the bridge is compiled
# at first use; jdk.charsets covers GBK/GB18030 course files; jdk.localedata
# keeps zh-CN number/date formatting inside Logisim's own UI strings.
JAVA_MODULES = ('java.base', 'java.desktop', 'java.datatransfer', 'java.logging', 'java.prefs', 'java.sql', 'java.xml',
                'jdk.compiler', 'jdk.zipfs', 'jdk.charsets', 'jdk.unsupported', 'jdk.localedata')

# CPython pieces no code path imports (see the AST audit in the release notes):
# Tk/IDLE/turtle, ensurepip + bundled pip wheels, tests, and C headers.
PYTHON_PRUNE = ('tcl', 'include', 'Lib/tkinter', 'Lib/idlelib', 'Lib/turtledemo', 'Lib/turtle.py', 'Lib/ensurepip',
                'Lib/test', 'Lib/unittest/test', 'Lib/lib2to3', 'Lib/pydoc_data', 'Lib/site-packages/pip', 'Lib/site-packages/pip-*',
                'DLLs/_tkinter.pyd', 'DLLs/tcl86t.dll', 'DLLs/tk86t.dll', 'DLLs/_test*.pyd', 'Scripts',
                'lib/python3.12/tkinter', 'lib/python3.12/idlelib', 'lib/python3.12/turtledemo', 'lib/python3.12/turtle.py',
                'lib/python3.12/ensurepip', 'lib/python3.12/test', 'lib/python3.12/lib2to3', 'lib/python3.12/pydoc_data',
                'lib/python3.12/site-packages/pip', 'lib/python3.12/site-packages/pip-*', 'lib/python3.12/lib-dynload/_tkinter*',
                'lib/python3.12/lib-dynload/_test*', 'lib/tcl8*', 'lib/tk8*', 'lib/itcl*', 'lib/thread*', 'lib/libtcl*', 'lib/libtk*', 'share')

# Chromium UI strings for menus/dialogs. The app's own UI is Chinese; keep
# the Chinese variants and English as Chromium's fallback.
ELECTRON_LOCALES = ('zh-CN', 'zh-TW', 'en-US', 'en-GB')


def prune(root, patterns):
    removed = 0
    for pattern in patterns:
        for item in root.glob(pattern):
            removed += sum(f.stat().st_size for f in item.rglob('*') if f.is_file()) if item.is_dir() else item.stat().st_size
            shutil.rmtree(item, ignore_errors=True) if item.is_dir() else item.unlink(missing_ok=True)
    return removed


def jlink_runtime(host_jdk_archive, target_jdk_archive, destination, cache):
    """Produce a minimal runtime image for `target` using the host's jlink.

    jlink can link an image for another OS as long as the target jmods come
    from the same JDK version; the image keeps java+javac. Falls back to the
    full JDK (minus jmods/src.zip) if the host JDK cannot be used.
    """
    with tempfile.TemporaryDirectory(prefix='vibe-jlink-', dir=cache) as temporary:
        host = Path(temporary) / 'host'
        target = Path(temporary) / 'target'
        extract(host_jdk_archive, host, strip_root=True)
        extract(target_jdk_archive, target, strip_root=True)
        jlink = host / 'bin' / 'jlink'
        if not jlink.exists():
            raise ValueError('host JDK has no jlink')
        def release_info(jdk):
            info = {}
            for line in (jdk / 'release').read_text().splitlines():
                if '=' in line:
                    k, v = line.split('=', 1); info[k] = v.strip().strip('"')
            return info
        host_version, target_version = release_info(host).get('JAVA_VERSION'), release_info(target).get('JAVA_VERSION')
        if host_version != target_version:
            raise ValueError(f'jlink host/target version mismatch: {host_version} vs {target_version}')
        subprocess.run([str(jlink), '--module-path', str(target / 'jmods'), '--add-modules', ','.join(JAVA_MODULES),
                        '--strip-debug', '--no-header-files', '--no-man-pages', '--compress', 'zip-6',
                        '--output', str(destination)], check=True)
        # Keep the vendor's legal notices with the runtime we redistribute.
        legal = target / 'legal'
        if legal.is_dir() and not (destination / 'legal').exists():
            shutil.copytree(legal, destination / 'legal')


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
              'AI 面板可以登录 ChatGPT，也可以在「AI 设置」里填写支持流式 Responses API 的接口地址和密钥。\n'
              '使用 AI 需要你自己的账号或接口额度；不连接 AI 也能编辑和仿真。\n'
              'Ctrl+点击端口、隧道或导线可追踪信号，Alt+左方向键返回。\n'
              '使用说明：https://github.com/FIY-pc/vibe-logisim\n\n')
    if target == 'win32-x64':
        return common.format(launcher='vibe-logisim.exe') + (
            '首次运行时 Windows 可能提示“未知发布者”，选择“更多信息 → 仍要运行”。\n'
            '把电路、组件库和任务书放进工作文件夹，说明目标及需要保留的结构，即可让 AI 开始任务。\n'
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
        for pak in (root / 'locales').glob('*.pak'):
            if pak.stem not in ELECTRON_LOCALES:
                pak.unlink()
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
        # The Python layout service starts Electron in Node mode; no system
        # Node installation or network package resolution is needed.
        elk = product / 'apps/desktop/node_modules/elkjs'
        for item in ('lib/elk.bundled.js', 'LICENSE.md', 'package.json'):
            source = DESKTOP / 'node_modules/elkjs' / item
            target_path = elk / item
            target_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target_path)
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
        host_jdk = acquire(args.cache / 'linux-x64', {'java': lock['targets']['linux-x64']['artifacts']['java']})['java']
        jlink_runtime(host_jdk, platform_artifacts['java'], runtime / 'java', args.cache)
        pruned = prune(runtime / 'python', PYTHON_PRUNE)
        print(f'pruned {pruned / 1e6:.1f} MB of unused CPython pieces', flush=True)
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
        # GPL-3.0 §6(d): the corresponding source is offered from the same place
        # the binaries are distributed (the GitHub release), so the 15 MB source
        # archive does not have to ride inside every bundle.
        (notices / 'LOGISIM-SOURCE-OFFER.txt').write_text(
            'Logisim-ITA 2.16.2.2 is GPL-3.0. Its complete corresponding source is published alongside this bundle\n'
            'as a release asset (logisim-2.16.2.2-source.tar.gz) at https://github.com/FIY-pc/vibe-logisim/releases\n'
            f'SHA-256 {lock["artifacts"]["logisim-source.tar.gz"]["sha256"]}\n'
            'Upstream: https://github.com/Logisim-Ita/Logisim/releases/tag/v2.16.2.2\n', encoding='utf-8')
        shutil.copy2(shared['logisim-source.tar.gz'], args.output / 'logisim-2.16.2.2-source.tar.gz') if not (args.output / 'logisim-2.16.2.2-source.tar.gz').exists() else None
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
