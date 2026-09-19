"""Boundary validation only; no Java, credentials, model, or course fixtures."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

DESKTOP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DESKTOP / 'circuit-lens'))
from studio.application.circuit_plugin import CircuitPlugin, CircuitToolSpec
from studio.domain.tool_errors import CircuitToolError


class ToolConstraints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        catalog = json.loads((DESKTOP / 'circuit-lens/studio/domain/circuit-plugin.json').read_text())
        cls.raw = {t['name']: t for t in catalog['tools']}
        projected = subprocess.check_output(['node', '-e', '''
const catalog = require('./circuit-lens/studio/domain/circuit-plugin.json');
const {CircuitToolRegistry} = require('./electron/circuit-tools.cjs');
console.log(JSON.stringify(new CircuitToolRegistry(catalog, Object.fromEntries(catalog.hostTools.map(n=>[n,()=>{}]))).tools));
'''], cwd=DESKTOP, text=True)
        cls.projected = {t['name']: t for t in json.loads(projected)}

    def validate(self, name, args, error_context=None):
        for interface in (self.raw[name], self.projected[name]):
            self.assertEqual(interface['inputSchema'], self.raw[name]['inputSchema'])
            spec = CircuitToolSpec(name, interface['description'], 'observe', interface['inputSchema'], 'studio')
            if error_context is None:
                CircuitPlugin._validate_arguments(spec, args)
            else:
                with self.assertRaises(CircuitToolError) as caught:
                    CircuitPlugin._validate_arguments(spec, args)
                self.assertEqual(caught.exception.code, 'INVALID_ARGUMENT')
                self.assertFalse(caught.exception.retryable)
                self.assertEqual(caught.exception.context, error_context)

    def test_wire_page_inclusive_boundary_and_integer_type(self):
        for value in (1, 512):
            self.validate('inspect_circuit', {'wireLimit':value})
        for value in (513, 1000):
            self.validate('inspect_circuit', {'wireLimit':value}, {'path':'arguments.wireLimit', 'maximum':512})
        self.validate('inspect_circuit', {'wireLimit':0}, {'path':'arguments.wireLimit', 'minimum':1})
        with self.assertRaises(CircuitToolError):
            CircuitPlugin._validate_schema_constraints(1.5, self.raw['inspect_circuit']['inputSchema']['properties']['wireLimit'], 'wireLimit')

    def test_event_count_nested_value_and_optional_absence(self):
        args = {'mode':'trace', 'circuit':'fixture'}
        self.validate('evaluate_circuit', args)
        events = [{'tick':0, 'name':'D', 'value':4294967295}] * 1000
        self.validate('evaluate_circuit', {**args, 'inputEvents':events})
        self.validate('evaluate_circuit', {**args, 'inputEvents':events + events[:1]},
                      {'path':'arguments.inputEvents', 'maxItems':1000})
        self.validate('evaluate_circuit', {**args, 'inputEvents':[{'tick':0, 'name':'D', 'value':4294967296}]},
                      {'path':'arguments.inputEvents[0].value', 'maximum':4294967295})
        self.validate('evaluate_circuit', {**args, 'expectedRows':[{'tick':0, 'values':{}}]},
                      {'path':'arguments.expectedRows[0].values', 'minProperties':1})


if __name__ == '__main__':
    unittest.main()
