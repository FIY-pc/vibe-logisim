"""Extract an already checksum-verified runtime without links or path traversal."""
import shutil
import sys
import tarfile
import zipfile
from pathlib import Path, PurePosixPath


def extract(archive, destination):
    root = Path(destination).resolve()
    count = total = 0

    def target(name, size):
        nonlocal count, total
        parts = PurePosixPath(name.replace('\\', '/'))
        if parts.is_absolute() or '..' in parts.parts or ':' in name:
            raise ValueError('Unsafe runtime archive path')
        count += 1
        total += size
        if count > 10000 or total > 1024 * 1024 * 1024:
            raise ValueError('Runtime archive exceeds its extraction limit')
        path = root.joinpath(*parts.parts)
        if not path.resolve().is_relative_to(root):
            raise ValueError('Runtime archive escapes installation directory')
        return path

    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as package:
            for member in package.infolist():
                if (member.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('Runtime archive links are not supported')
                path = target(member.filename, member.file_size)
                if member.is_dir():
                    path.mkdir(parents=True, exist_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with package.open(member) as source, path.open('xb') as sink:
                        shutil.copyfileobj(source, sink)
                    path.chmod((member.external_attr >> 16) & 0o777 or 0o644)
    else:
        with tarfile.open(archive) as package:
            for member in package:
                path = target(member.name, member.size)
                if member.isdir():
                    path.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with package.extractfile(member) as source, path.open('xb') as sink:
                        shutil.copyfileobj(source, sink)
                    path.chmod(member.mode & 0o777)
                else:
                    raise ValueError('Runtime archive links and special files are not supported')


if __name__ == '__main__':
    extract(sys.argv[1], sys.argv[2])
