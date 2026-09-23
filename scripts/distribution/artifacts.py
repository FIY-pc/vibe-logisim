"""Acquire pinned build inputs; nothing is downloaded by the shipped app."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
from pathlib import Path
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile


def sha256(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def acquire(cache, entries):
    cache.mkdir(parents=True, exist_ok=True)

    def one(item):
        name, spec = item
        target = cache / name
        if target.is_file() and sha256(target) == spec['sha256']:
            return name, target
        print(f'Downloading {name}', flush=True)
        with tempfile.NamedTemporaryFile(dir=cache, delete=False) as temporary:
            staging = Path(temporary.name)
            try:
                with urllib.request.urlopen(spec['url'], timeout=120) as response:
                    shutil.copyfileobj(response, temporary)
                temporary.flush()
                if sha256(staging) != spec['sha256']:
                    raise ValueError(f'Checksum mismatch: {name}')
                staging.replace(target)
            finally:
                staging.unlink(missing_ok=True)
        return name, target

    with ThreadPoolExecutor(max_workers=4) as pool:
        return dict(pool.map(one, entries.items()))


def _extract_zip(archive, root):
    root = Path(root).resolve()
    with zipfile.ZipFile(archive) as package:
        for info in package.infolist():
            target = (root / info.filename).resolve()
            if target != root and root not in target.parents:
                raise ValueError(f'Zip entry escapes staging directory: {info.filename}')
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with package.open(info) as source, target.open('wb') as sink:
                shutil.copyfileobj(source, sink)
            # Preserve the executable bit recorded by POSIX-built zips (Electron).
            mode = (info.external_attr >> 16) & 0o777
            if mode:
                target.chmod(mode)


def extract(archive, destination, *, strip_root=False):
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        root = Path(temporary)
        if zipfile.is_zipfile(archive):
            _extract_zip(archive, root)
        else:
            with tarfile.open(archive) as package:
                # Retain safe relative symlinks (JDK/Python use them), reject
                # traversal, devices and links escaping this staging directory.
                package.extractall(root, filter='data')
        if strip_root:
            children = list(root.iterdir())
            if len(children) != 1 or not children[0].is_dir():
                raise ValueError(f'Expected one archive root: {archive}')
            root = children[0]
        shutil.copytree(root, destination, dirs_exist_ok=True, symlinks=True)
