"""Focused vector-file integrity tests; no models or native runtime required."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

LENS = Path(__file__).resolve().parents[1] / 'circuit-lens'
sys.path.insert(0, str(LENS))

from studio.runtime import vector_file
from studio.runtime.vector_file import load_vectors_file


class VectorFileTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='vibe-vector-file-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.path = self.root / 'vectors.json'

    def write(self, value):
        content = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.path.write_bytes(content)
        return content

    def reject(self, content, *fragments):
        self.path.write_bytes(content.encode('utf-8') if isinstance(content, str) else content)
        with self.assertRaises(ValueError) as raised:
            load_vectors_file(self.path)
        message = str(raised.exception)
        self.assertIn(str(self.path), message)
        for fragment in fragments:
            self.assertIn(fragment, message)

    def test_unicode_uint32_and_observation_only_vectors_are_preserved(self):
        expected = [
            {'inputs': {'输入': 0, '总线': 4294967295}, 'expected': {'结果': 2147483648}},
            {'inputs': {}},
            {'inputs': {'空 格': 1}, 'expected': {}},
        ]
        content = self.write(expected)
        vectors, metadata = load_vectors_file(self.path)
        self.assertEqual(vectors, expected)
        self.assertIs(type(vectors[0]), dict)
        self.assertIs(type(vectors[0]['inputs']), dict)
        self.assertTrue(all(type(value) is int for value in vectors[0]['inputs'].values()))
        self.assertNotIn('expected', vectors[1])
        self.assertEqual(vectors[2]['expected'], {})
        self.assertEqual(metadata, {
            'path': str(self.path), 'sha256': hashlib.sha256(content).hexdigest(),
            'byteCount': len(content), 'vectorCount': len(expected),
        })
        self.assertEqual(self.path.read_bytes(), content)

    def test_relative_symlink_path_is_preserved_without_workspace_restrictions(self):
        self.write([{'inputs': {}}])
        link = self.root / 'alias.json'
        link.symlink_to(self.path)
        relative = Path(os.path.relpath(link, Path.cwd()))
        _vectors, metadata = load_vectors_file(relative)
        self.assertEqual(metadata['path'], str(relative))

    def test_metadata_and_vectors_use_the_same_single_bounded_read(self):
        expected = [{'inputs': {'原始输入': 42}}]
        content = self.write(expected)
        decode = json.loads
        fdopen = os.fdopen
        reads = []

        class ObservedFile:
            def __init__(self, *args, **kwargs):
                self.stream = fdopen(*args, **kwargs)

            def __enter__(self):
                return self

            def read(self, size):
                reads.append(size)
                return self.stream.read(size)

            def __exit__(self, *args):
                self.stream.close()

        def replace_after_read(*args, **kwargs):
            self.write([{'inputs': {'替换后': 99}}])
            return decode(*args, **kwargs)

        with patch.object(vector_file.os, 'fdopen', ObservedFile), \
                patch.object(vector_file.json, 'loads', side_effect=replace_after_read):
            vectors, metadata = load_vectors_file(self.path)
        self.assertEqual(reads, [32 * 1024 * 1024 + 1])
        self.assertEqual(vectors, expected)
        self.assertEqual(metadata['sha256'], hashlib.sha256(content).hexdigest())
        self.assertEqual(metadata['byteCount'], len(content))
        self.assertNotEqual(self.path.read_bytes(), content)

    def test_empty_invalid_json_and_encoding(self):
        for content, fragment in (
            (b'', 'empty'), (b' \n\t', 'invalid JSON'),
            (b'[{"inputs": {}}', 'column'),
            (b'[{"inputs": {}}] trailing', 'invalid JSON'),
            (b'[{"inputs": {1: 0}}]', 'invalid JSON'),
            (b'[{"inputs": {"A": 0xff}}]', 'invalid JSON'),
            (b'\xff', 'encoding'),
        ):
            with self.subTest(content=content):
                self.reject(content, fragment)

    def test_nonempty_array_and_vector_objects_are_required(self):
        for value in ([], {}, None, True, 1, 'text'):
            with self.subTest(value=value):
                self.reject(json.dumps(value), '$', 'non-empty JSON array')
        for value in ([], None, True, 1, 'text'):
            with self.subTest(vector=value):
                self.reject(json.dumps([{'inputs': {}}, value]), '$[1]', 'JSON object')

    def test_required_and_unknown_fields(self):
        self.reject('[{"inputs": {}}, {"expected": {}}]', '$[1].inputs', 'required')
        self.reject('[{"inputs": {}, "typo": {}}]', '$[0]["typo"]', 'unknown field')

    def test_pin_maps_require_objects_and_nonempty_names(self):
        for field in ('inputs', 'expected'):
            for value in (None, [], True, 1, 'text'):
                with self.subTest(field=field, value=value):
                    vector = {'inputs': {}, field: value}
                    self.reject(json.dumps([vector]), f'$[0].{field}', 'JSON object')
            vector = {'inputs': {}, field: {'': 0}}
            self.reject(json.dumps([vector]), f'$[0].{field}[""]', 'non-empty string')

    def test_pin_values_are_uint32_integers_without_coercion(self):
        for field in ('inputs', 'expected'):
            for value in (True, False, None, 1.0, 1.5, '1', [], {}, -1, 4294967296):
                with self.subTest(field=field, value=value):
                    vector = {'inputs': {}, field: {'引脚': value}}
                    self.reject(json.dumps([{'inputs': {}}, vector], ensure_ascii=False),
                                f'$[1].{field}["引脚"]', 'integer', '4294967295')
            for token in ('NaN', 'Infinity', '-Infinity', '1e999', '9' * 5000):
                with self.subTest(field=field, token=token[:20]):
                    content = '[{"inputs":{}} , {"inputs":{}'
                    if field == 'inputs':
                        content = '[{"inputs":{}} , {'
                    else:
                        content += ','
                    content += f'"{field}":{{"A":{token}}}}}]'
                    self.reject(content, f'$[1].{field}["A"]', 'integer')

    def test_duplicate_fields_and_pin_names_are_rejected_before_overwrite(self):
        for content, location in (
            ('[{"inputs":{},"inputs":{}}]', '$[0]["inputs"]'),
            ('[{"inputs":{}},{"inputs":{},"expected":{},"expected":{}}]', '$[1]["expected"]'),
            ('[{"inputs":{"A":0,"A":1}}]', '$[0].inputs["A"]'),
            ('[{"inputs":{},"expected":{"输出":1,"输出":1}}]', '$[0].expected["输出"]'),
            ('[{"inputs":{"A":0,"\\u0041":1}}]', '$[0].inputs["A"]'),
        ):
            with self.subTest(content=content):
                self.reject(content, location, 'duplicate JSON key')

    def test_vector_count_limit_accepts_131072_and_rejects_the_next_index(self):
        item = b'{"inputs":{}}'
        self.path.write_bytes(b'[' + b','.join([item] * 131072) + b']')
        vectors, metadata = load_vectors_file(self.path)
        self.assertEqual(len(vectors), 131072)
        self.assertEqual(metadata['vectorCount'], 131072)
        self.assertEqual(vectors[-1], {'inputs': {}})
        self.reject(b'[' + b','.join([item] * 131073) + b']', '$[131072]', '131072', '131073')

    def test_byte_limit_accepts_exactly_32_mib_and_rejects_one_more_byte(self):
        limit = 32 * 1024 * 1024
        prefix = b'[{"inputs":{}}]'
        with self.path.open('wb') as stream:
            stream.write(prefix)
            stream.write(b' ' * (limit - len(prefix)))
        vectors, metadata = load_vectors_file(self.path)
        self.assertEqual(vectors, [{'inputs': {}}])
        self.assertEqual(metadata['byteCount'], limit)
        with self.path.open('ab') as stream:
            stream.write(b' ')
        with self.assertRaisesRegex(ValueError, '32 MiB'):
            load_vectors_file(self.path)

    def test_missing_path_and_directory_fail_as_value_errors(self):
        with self.assertRaisesRegex(ValueError, 'cannot read file'):
            load_vectors_file(self.path)
        with patch.object(vector_file.os, 'open', side_effect=AssertionError('must stat before open')):
            with self.assertRaisesRegex(ValueError, 'regular file'):
                load_vectors_file(self.root)

    @unittest.skipUnless(hasattr(os, 'mkfifo'), 'FIFO requires POSIX')
    def test_fifo_and_replacement_between_stat_and_open_do_not_block(self):
        probe = '''
import os
from pathlib import Path
import sys
from contextlib import nullcontext
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
from studio.runtime import vector_file
path = Path(sys.argv[2])
original_open = os.open
def replace_before_open(name, flags):
    path.unlink()
    os.mkfifo(path)
    return original_open(name, flags)
replacement = patch.object(vector_file.os, 'open', replace_before_open)
with replacement if sys.argv[3] == 'replace' else nullcontext():
    try:
        vector_file.load_vectors_file(path)
    except ValueError as error:
        assert 'regular file' in str(error), str(error)
        print(error)
    else:
        raise AssertionError('FIFO was accepted')
'''
        for mode in ('fifo', 'replace'):
            with self.subTest(mode=mode):
                path = self.root / mode
                if mode == 'fifo':
                    os.mkfifo(path)
                else:
                    path.write_text('[{"inputs":{}}]', encoding='utf-8')
                completed = subprocess.run(
                    [sys.executable, '-B', '-c', probe, str(LENS), str(path), mode],
                    capture_output=True, text=True, timeout=5,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertIn('regular file', completed.stdout)
                if mode == 'replace':
                    self.assertIn('opened file', completed.stdout)

    def test_python_file_content_is_not_executed(self):
        marker = self.root / 'executed'
        self.reject(f'from pathlib import Path\nPath({str(marker)!r}).touch()', 'invalid JSON')
        self.assertFalse(marker.exists())


if __name__ == '__main__':
    unittest.main()
