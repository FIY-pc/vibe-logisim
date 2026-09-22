"""Structured construction feedback for placement/contact conflicts.

This stays at the model-facing wiring boundary and does not start Java or a
model session. It checks that a rejected placement carries enough native
context to correct a new call without guessing.
"""
import sys
import unittest

sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parents[1] / 'circuit-lens'))

from studio.domain.tool_errors import CircuitToolError
from studio.runtime.wiring import contact_partition, touching_ports


def component(component_id, factory, x, y, ports=1):
    ends = []
    for index in range(ports):
        ends.append({
            'index': index,
            'location': {'x': x, 'y': y},
            'width': 1,
            'direction': 'input',
            'runtimeTooltip': f'p{index}',
            'netBits': [{'bit': 0, 'netId': f'{component_id}-{index}'}],
        })
    return {
        'componentId': component_id,
        'factoryName': factory,
        'location': {'x': x, 'y': y},
        'selector': {'label': component_id},
        'ends': ends,
    }


class WiringErrors(unittest.TestCase):
    def test_existing_wire_contact_exposes_port_and_wire(self):
        prepared = {'focus': {'components': [
            component('old', 'Pin', 0, 0),
            component('added', 'Constant', 100, 100),
        ], 'wires': []}}
        baseline = {'focus': {'components': [component('old', 'Pin', 0, 0)], 'wires': [
            {'wireId': 'wire-1', 'from': {'x': 0, 'y': 100},
             'to': {'x': 100, 'y': 100}, 'bundleId': 'bundle-1'},
        ]}}
        with self.assertRaises(CircuitToolError) as caught:
            touching_ports(prepared, baseline, {('Constant', (100, 100))},
                           {('Constant', (100, 100)): 'added'})
        error = caught.exception
        self.assertEqual(error.code, 'PLACEMENT_PORT_ON_EXISTING_WIRE')
        self.assertEqual(error.as_dict()['context']['location'], {'x': 100, 'y': 100})
        self.assertEqual(error.as_dict()['context']['ports'][0]['requestedId'], 'added')
        self.assertEqual(error.as_dict()['context']['existingWires'][0]['wireId'], 'wire-1')

    def test_undeclared_contact_exposes_both_ports(self):
        first = component('old', 'Pin', 0, 0)
        second = component('added', 'Constant', 100, 100)
        reference = {'focus': {'components': [first, second]}}
        pair = ((('Pin', (0, 0)), 0), (('Constant', (100, 100)), 0))
        with self.assertRaises(CircuitToolError) as caught:
            contact_partition(reference, [pair], [],
                              {('Constant', (100, 100)): 'added'})
        error = caught.exception
        self.assertEqual(error.code, 'UNDECLARED_PORT_CONTACT')
        self.assertEqual([item['component'] for item in error.as_dict()['context']['ports']],
                         ['old', 'added'])


if __name__ == '__main__':
    unittest.main()
