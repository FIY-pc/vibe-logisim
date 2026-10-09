"""Record logical product bytes and stop accidental distribution growth."""
import argparse
import json
from pathlib import Path

BUDGETS = {'linux-x64': {'unpacked': 520_000_000, 'download': 190_000_000},
           'win32-x64': {'unpacked': 520_000_000, 'download': 180_000_000}}


def report(root, target, archive=None):
    parts = {}
    for file in root.rglob('*'):
        if not file.is_file() or file.is_symlink():
            continue
        name = file.relative_to(root).as_posix()
        category = next((label for prefix, label in [
            ('resources/runtime/java/', 'java'), ('resources/runtime/python/', 'python'),
            ('resources/product/', 'product'), ('resources/app/', 'desktop'),
            ('resources/third-party/', 'notices')] if name.startswith(prefix)), 'electron-and-manifests')
        parts[category] = parts.get(category, 0) + file.stat().st_size
    result = {'target': target, 'unpackedBytes': sum(parts.values()), 'components': parts}
    if (root / 'resources/runtime/codex').exists():
        raise ValueError('Optional Codex must not be included in the base application')
    if (root / 'resources/app/node_modules/@earendil-works').exists():
        raise ValueError('SDK dependencies must be bundled instead of copying node_modules')
    if result['unpackedBytes'] > BUDGETS[target]['unpacked']:
        raise ValueError(f'Unpacked size budget exceeded: {result}')
    if archive:
        result['downloadBytes'] = archive.stat().st_size
        if result['downloadBytes'] > BUDGETS[target]['download']:
            raise ValueError(f'Download size budget exceeded: {result}')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--target', required=True, choices=BUDGETS)
    parser.add_argument('--archive', type=Path)
    args = parser.parse_args()
    print(json.dumps(report(args.directory, args.target, args.archive), indent=2))
