"""Read a bounded JSON vector file without executing or resolving its contents.

Workspace path authorization belongs to the caller. Empty or absent expected
maps remain observations; this loader does not produce evaluation verdicts.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat


MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_VECTORS = 131072
MAX_PIN_VALUE = (1 << 32) - 1


class _ObjectPairs(list):
    """Keep duplicate keys until their vector/field location is known."""


class _LargeInteger(str):
    """Avoid Python's integer digit limit while retaining a useful field error."""


def _parse_integer(text: str):
    return _LargeInteger(text) if len(text.lstrip('-')) > 10 else int(text)


def _object(value, location: str) -> dict:
    if not isinstance(value, _ObjectPairs):
        raise ValueError(f'{location}: must be a JSON object')
    result = {}
    for key, item in value:
        if key in result:
            field = json.dumps(key, ensure_ascii=False)
            raise ValueError(f'{location}[{field}]: duplicate JSON key {field}')
        result[key] = item
    return result


def _pins(value, location: str) -> dict[str, int]:
    pins = _object(value, location)
    for name, number in pins.items():
        field = f'{location}[{json.dumps(name, ensure_ascii=False)}]'
        if not isinstance(name, str) or not name:
            raise ValueError(f'{field}: pin name must be a non-empty string')
        if isinstance(number, _LargeInteger):
            raise ValueError(f'{field}: integer must be in 0..{MAX_PIN_VALUE}')
        if type(number) is not int:
            raise ValueError(
                f'{field}: must be an integer in 0..{MAX_PIN_VALUE}; '
                'booleans, floats, strings, null, arrays and objects are not allowed'
            )
        if not 0 <= number <= MAX_PIN_VALUE:
            raise ValueError(f'{field}: integer {number} must be in 0..{MAX_PIN_VALUE}')
    return pins


def load_vectors_file(path: Path) -> tuple[list[dict[str, dict[str, int]]], dict]:
    """Return validated vectors and metadata for exactly the bytes read.

    Follow regular-file symlinks, preserving str(path) in metadata. Read once
    with a one-byte overflow sentinel. All file/JSON/shape failures are
    ValueError; schema errors use zero-based vector indices and field names.
    """
    source = f'vectorsFile {str(path)!r}'
    try:
        if not stat.S_ISREG(path.stat().st_mode):
            raise ValueError(f'{source}: must be a regular file (not a directory, FIFO or device)')
        # A regular path can be replaced by a FIFO between stat and open.
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise ValueError(f'{source}: opened file must be a regular file (not a directory, FIFO or device)')
            with os.fdopen(descriptor, 'rb', closefd=False) as stream:
                content = stream.read(MAX_FILE_BYTES + 1)
        finally:
            os.close(descriptor)
    except OSError as error:
        raise ValueError(f'{source}: cannot read file: {error.strerror or error}') from error

    if len(content) > MAX_FILE_BYTES:
        raise ValueError(f'{source}: file exceeds the 32 MiB limit ({MAX_FILE_BYTES} bytes)')
    if not content:
        raise ValueError(f'{source}: file is empty; expected a non-empty JSON array')
    try:
        parsed = json.loads(content, object_pairs_hook=_ObjectPairs, parse_int=_parse_integer)
    except json.JSONDecodeError as error:
        raise ValueError(
            f'{source}: invalid JSON at line {error.lineno}, column {error.colno} '
            f'(character {error.pos}): {error.msg}'
        ) from error
    except UnicodeDecodeError as error:
        raise ValueError(f'{source}: invalid JSON encoding at byte {error.start}: {error.reason}') from error
    except RecursionError as error:
        raise ValueError(f'{source}: JSON nesting is too deep; expected an array of input/expected objects') from error

    if type(parsed) is not list or not parsed:
        raise ValueError(f'{source}: $ must be a non-empty JSON array of vectors')
    if len(parsed) > MAX_VECTORS:
        raise ValueError(
            f'{source}: $[{MAX_VECTORS}] exceeds the limit of {MAX_VECTORS} vectors '
            f'(received {len(parsed)})'
        )
    vectors = []
    for index, item in enumerate(parsed):
        location = f'{source}: $[{index}]'
        vector = _object(item, location)
        for key in vector:
            if key not in ('inputs', 'expected'):
                raise ValueError(
                    f'{location}[{json.dumps(key, ensure_ascii=False)}]: '
                    'unknown field; only inputs and expected are allowed'
                )
        if 'inputs' not in vector:
            raise ValueError(f'{location}.inputs: required field is missing')
        vector['inputs'] = _pins(vector['inputs'], f'{location}.inputs')
        if 'expected' in vector:
            vector['expected'] = _pins(vector['expected'], f'{location}.expected')
        vectors.append(vector)
    return vectors, {
        'path': str(path),
        'sha256': hashlib.sha256(content).hexdigest(),
        'byteCount': len(content),
        'vectorCount': len(vectors),
    }
