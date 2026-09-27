"""arrange_candidate may change how a circuit is drawn and nothing else.

Each case below is a way the re-layout used to change more, seen on course
circuits and reproduced here on synthetic ones:

  - a Probe wired into the body lost its copper, and the netlist check could
    not tell: a Probe's width is settled at run time, so the observer reports
    no net bits for it (resolve_unknown_widths);
  - a subcircuit with a custom appearance kept its ports pointing at the old
    Pin locations: the file stopped loading, or the ports moved in every
    circuit using it;
  - a subcircuit with the default appearance got two Pins of one facing
    re-ordered, which swaps two ports in every circuit using it without
    changing one connection inside it;
  - a lead drawn onto the end of a panel wire is merged with it when Logisim
    loads the file, the observed wire no longer matched the file's two
    <wire> elements, and both were deleted;
  - every other definition in the file was re-serialised.

The observer-backed tests go through the production Workbench (open ->
arrange_candidate -> candidate artifact) and check the result by native
re-observation; the rest exercise the pure helpers.
"""
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.domain.schematic_layout import _circuit_span, interface_signature, resolve_unknown_widths, splice_circuit  # noqa: E402
from studio.project.arrangement import _circuit_element, _identity_map, _outside, netlist_signature  # noqa: E402

HEADER = ('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<project source="2.7.1" version="1.0">\n'
          '  This file is intended to be loaded by Logisim.\n'
          '  <lib desc="#Wiring" name="0"/>\n  <lib desc="#Gates" name="1"/>\n  <lib desc="#I/O" name="5"/>\n'
          '  <main name="main"/>\n  <options>\n    <a name="gateUndefined" val="ignore"/>\n  </options>\n')


def pin(x, y, label, *, out=False, facing=None, width=1):
    attrs = [f'<a name="facing" val="{facing or ("west" if out else "east")}"/>']
    if out:
        attrs.append('<a name="output" val="true"/>')
    if width != 1:
        attrs.append(f'<a name="width" val="{width}"/>')
    attrs.append(f'<a name="label" val="{label}"/>')
    return f'    <comp lib="0" loc="({x},{y})" name="Pin">{"".join(attrs)}</comp>\n'


def tunnel(x, y, label, facing='east', width=1):
    return (f'    <comp lib="0" loc="({x},{y})" name="Tunnel"><a name="facing" val="{facing}"/>'
            f'<a name="width" val="{width}"/><a name="label" val="{label}"/></comp>\n')


def gate(kind, x, y, *, inputs=None):
    extra = f'<a name="inputs" val="{inputs}"/>' if inputs else ''
    return f'    <comp lib="1" loc="({x},{y})" name="{kind}"><a name="size" val="30"/>{extra}</comp>\n'


def wire(a, b):
    return f'    <wire from="({a[0]},{a[1]})" to="({b[0]},{b[1]})"/>\n'


def circuit(name, body):
    return f'  <circuit name="{name}">\n    <a name="circuit" val="{name}"/>\n{body}  </circuit>\n'


def project(*circuits):
    return HEADER + ''.join(circuits) + '</project>\n'


def key(bits):
    return tuple((b['bit'], b['netId']) for b in sorted(bits or [], key=lambda b: b['bit']))


def label(c):
    return next((a.get('value', a.get('standard')) for a in c['attributes'] if a.get('name') == 'label'), None)


class Session:
    """One isolated workspace on a synthetic file."""

    def __init__(self, tmp, text):
        from studio.application.workspace import Workspace
        self.root = Path(tmp)
        self.src = self.root / 'fidelity.circ'
        self.src.write_text(text, encoding='utf-8')
        self.workspace = Workspace(REPO, self.root / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'fidelity')
        self.revision = self.workspace.open_path(self.src)['revision']['id']

    def arrange(self, circuit_name, **args):
        result = self.workspace.workbench.call(self.revision, 'arrange_candidate', {'circuit': circuit_name, **args})
        return result, self.workspace.state_root / 'candidates' / result['id'] / 'artifact.circ'

    def observe(self, path, circuit_name):
        focus = self.workspace.observer.run_full(path, circuit_name)['focus']
        resolve_unknown_widths(focus)
        return focus

    def instance_ports(self, path, parent, child):
        """(port offset from the instance, tooltip) of every instance of child in parent."""
        focus = self.observe(path, parent)
        return sorted((e['location']['x'] - c['location']['x'], e['location']['y'] - c['location']['y'], e.get('runtimeTooltip'))
                      for c in focus['components'] if c['factoryName'] == child for e in c['ends'])

    def close(self):
        self.workspace.close()


def parent_of(child, ports):
    """A main circuit with one instance of child at (400,300) and a Pin tied by
    Tunnels to each of its ports (ports: [(x, y, tooltip, direction)])."""
    body = f'    <comp loc="(400,300)" name="{child}"/>\n'
    for i, (x, y, tip, direction) in enumerate(ports):
        body += tunnel(x, y, f'p_{tip}')
        if direction == 'input':
            body += pin(100, 100 + 40 * i, f'P{tip}') + tunnel(100, 100 + 40 * i, f'p_{tip}', facing='west')
        else:
            body += pin(800, 100 + 40 * i, f'P{tip}', out=True) + tunnel(800, 100 + 40 * i, f'p_{tip}')
    return circuit('main', body)


def with_parent(tmp, child_name, child_xml):
    """The file with child and a main that uses it, the instance's ports read
    from the runtime rather than assumed."""
    probe = Session(tmp, project(circuit('main', f'    <comp loc="(400,300)" name="{child_name}"/>\n'), child_xml))
    try:
        focus = probe.observe(probe.src, 'main')
    finally:
        probe.close()
    inst = next(c for c in focus['components'] if c['factoryName'] == child_name)
    ports = [(e['location']['x'], e['location']['y'], e['runtimeTooltip'], e['direction']) for e in inst['ends']]
    return project(parent_of(child_name, ports), child_xml)


class ProbesKeepTheirNet(unittest.TestCase):
    # 8-bit D -> NOT -> Q in the body; a Probe in the panel (y < 100) hangs on
    # the NOT output by a wire that runs down into the body.
    SRC = project(circuit('main',
                          pin(100, 300, 'D', width=8) + wire((100, 300), (270, 300)) +
                          '    <comp lib="1" loc="(300,300)" name="NOT Gate"><a name="size" val="30"/><a name="width" val="8"/></comp>\n' +
                          wire((300, 300), (400, 300)) + wire((400, 300), (500, 300)) +
                          pin(500, 300, 'Q', out=True, width=8) +
                          '    <comp lib="0" loc="(400,50)" name="Probe"/>\n' + wire((400, 50), (400, 300))))

    def test_a_panel_probe_wired_into_the_body_stays_on_its_net(self):
        with tempfile.TemporaryDirectory(prefix='vibe-fidelity-') as tmp:
            session = Session(tmp, self.SRC)
            try:
                before = session.observe(session.src, 'main')
                probe = next(c for c in before['components'] if c['factoryName'] == 'Probe')
                self.assertEqual(len(probe['ends'][0]['netBits']), 8, 'the Probe takes the width of its wire')
                result, artifact = session.arrange('main', panelBelowY=100)
                self.assertTrue(result['netlist']['equivalent'])
                after = session.observe(artifact, 'main')
            finally:
                session.close()
        probe = next(c for c in after['components'] if c['factoryName'] == 'Probe')
        q = next(c for c in after['components'] if c['factoryName'] == 'Pin' and label(c) == 'Q')
        self.assertTrue(probe['ends'][0]['netBits'], 'the Probe lost its connection')
        self.assertEqual(key(probe['ends'][0]['netBits']), key(q['ends'][0]['netBits']))

    def test_the_check_counts_a_probe_as_a_port(self):
        """A Probe that loses its copper changes the signature (it did not while
        its missing net bits hid it)."""
        def focus(probe_on_wire):
            probe_end = {'index': 0, 'location': {'x': 400, 'y': 50}, 'width': None, 'netBits': [], 'direction': 'input'}
            bundle_points = [{'x': 300, 'y': 300}, {'x': 500, 'y': 300}] + ([{'x': 400, 'y': 50}] if probe_on_wire else [])
            return {'components': [
                {'componentId': 'n', 'factoryName': 'NOT Gate', 'location': {'x': 300, 'y': 300}, 'attributes': [],
                 'ends': [{'index': 0, 'location': {'x': 300, 'y': 300}, 'width': 8, 'direction': 'output',
                           'netBits': [{'bit': i, 'netId': f'q{i}'} for i in range(8)]}]},
                {'componentId': 'p', 'factoryName': 'Probe', 'location': {'x': 400, 'y': 50}, 'attributes': [], 'ends': [probe_end]}],
                'wireBundles': [{'bundleId': 'b', 'valid': True, 'points': bundle_points,
                                 'bitNets': [{'bit': i, 'netId': f'q{i}'} for i in range(8)]}]}
        identity = {((300, 300), 'NOT Gate'): 0, ((400, 50), 'Probe'): 1}
        wired, loose = focus(True), focus(False)
        self.assertEqual(resolve_unknown_widths(wired), 1)
        self.assertEqual(resolve_unknown_widths(loose), 0)
        self.assertNotEqual(netlist_signature(wired, identity), netlist_signature(loose, identity))
        self.assertEqual(resolve_unknown_widths(wired), 0, 'resolving twice changes nothing')


class MergedLeadsStay(unittest.TestCase):
    # A panel Button reaches a panel Probe over a 10 px lead drawn onto the end
    # of a longer wire: two <wire> elements, one observed wire.
    SRC = project(circuit('main',
                          '    <comp lib="5" loc="(50,50)" name="Button"/>\n' +
                          wire((50, 50), (60, 50)) + wire((60, 50), (200, 50)) +
                          '    <comp lib="0" loc="(200,50)" name="Probe"/>\n' +
                          pin(100, 300, 'A') + tunnel(100, 300, 'a', facing='west') +
                          gate('NOT Gate', 400, 300) + tunnel(370, 300, 'a') +
                          pin(600, 300, 'Y', out=True) + wire((400, 300), (600, 300))))

    def test_panel_copper_that_loads_as_one_wire_is_kept(self):
        with tempfile.TemporaryDirectory(prefix='vibe-fidelity-') as tmp:
            session = Session(tmp, self.SRC)
            try:
                before = session.observe(session.src, 'main')
                self.assertEqual(sum(1 for w in before['wires'] if w['from']['y'] == 50), 1, 'Logisim merges the lead on load')
                result, artifact = session.arrange('main', panelBelowY=100)
                self.assertTrue(result['netlist']['equivalent'])
                after = session.observe(artifact, 'main')
            finally:
                session.close()
        button = next(c for c in after['components'] if c['factoryName'] == 'Button')
        probe = next(c for c in after['components'] if c['factoryName'] == 'Probe')
        self.assertEqual(key(button['ends'][0]['netBits']), key(probe['ends'][0]['netBits']))


class InstancesDoNotChange(unittest.TestCase):
    # Inputs A, B, C and outputs X = NOT C, Y = NOT B, Z = NOT A: untangling the
    # crossing wires by re-ordering either column of Pins is what a layout
    # heuristic wants, and what the default appearance cannot allow.
    DEFAULT = circuit('sub', ''.join(pin(100, y, n) + tunnel(100, y, n.lower(), facing='west') for n, y in (('A', 100), ('B', 200), ('C', 300))) +
                      ''.join(gate('NOT Gate', 300, y) + tunnel(270, y, i) + tunnel(300, y, o, facing='west')
                              for y, i, o in ((100, 'c', 'x'), (200, 'b', 'y'), (300, 'a', 'z'))) +
                      ''.join(pin(500, y, n, out=True) + tunnel(500, y, n.lower()) for n, y in (('X', 100), ('Y', 200), ('Z', 300))))
    CUSTOM = circuit('sub', '    <appear>\n'
                     '      <rect fill="#ffffff" height="40" stroke="#000000" stroke-width="2" width="40" x="50" y="50"/>\n'
                     '      <circ-port height="8" pin="100,100" width="8" x="46" y="56"/>\n'
                     '      <circ-port height="8" pin="100,300" width="8" x="46" y="76"/>\n'
                     '      <circ-port height="10" pin="500,200" width="10" x="85" y="65"/>\n'
                     '      <circ-anchor facing="east" height="6" width="6" x="87" y="67"/>\n'
                     '    </appear>\n' +
                     pin(100, 100, 'A') + tunnel(100, 100, 'a', facing='west') +
                     pin(100, 300, 'B') + tunnel(100, 300, 'b', facing='west') +
                     gate('AND Gate', 300, 200, inputs=2) + tunnel(270, 190, 'b') + tunnel(270, 210, 'a') +
                     tunnel(300, 200, 'y', facing='west') + pin(500, 200, 'Y', out=True) + tunnel(500, 200, 'y'))

    def arrange_sub(self, child_xml):
        with tempfile.TemporaryDirectory(prefix='vibe-fidelity-') as tmp:
            Path(tmp, 'probe').mkdir()
            text = with_parent(Path(tmp, 'probe'), 'sub', child_xml)
            session = Session(Path(tmp), text)
            try:
                ports_before = session.instance_ports(session.src, 'main', 'sub')
                main_before = session.observe(session.src, 'main')
                result, artifact = session.arrange('sub')
                ports_after = session.instance_ports(artifact, 'main', 'sub')
                main_after = session.observe(artifact, 'main')
                after_text = artifact.read_text(encoding='utf-8')
            finally:
                session.close()
        identity = _identity_map(text, 'main')
        return (text, after_text, result, ports_before, ports_after,
                netlist_signature(main_before, identity), netlist_signature(main_after, identity))

    def test_default_appearance_pins_keep_their_order(self):
        text, after, result, before_ports, after_ports, before_sig, after_sig = self.arrange_sub(self.DEFAULT)
        self.assertTrue(result['netlist']['equivalent'])
        self.assertEqual(result['changes'][-1]['interfaceChecked'], 'default')
        self.assertEqual(before_ports, after_ports, 'the instance in main changed')
        self.assertEqual(before_sig, after_sig, 'main is wired differently')
        self.assertEqual(_outside(text, 'sub'), _outside(after, 'sub'), 'bytes outside the arranged circuit changed')

    def test_custom_appearance_ports_follow_their_pins(self):
        text, after, result, before_ports, after_ports, before_sig, after_sig = self.arrange_sub(self.CUSTOM)
        self.assertTrue(result['netlist']['equivalent'])
        self.assertEqual(result['changes'][-1]['interfaceChecked'], 'custom')
        self.assertGreater(result['arrangement']['appearancePortsRepointed'], 0, 'no Pin moved: the case tests nothing')
        sub = _circuit_element(after, 'sub')
        pins = {tuple(int(v) for v in e.get('loc').strip('()').split(',')) for e in sub.findall('comp') if e.get('name') == 'Pin'}
        refs = {tuple(int(v) for v in p.get('pin').split(',')) for p in sub.find('appear').iter('circ-port')}
        self.assertLessEqual(refs, pins, 'a port points where there is no Pin')
        self.assertEqual(before_ports, after_ports, 'the instance in main changed')
        self.assertEqual(before_sig, after_sig, 'main is wired differently')
        self.assertEqual(_outside(text, 'sub'), _outside(after, 'sub'), 'bytes outside the arranged circuit changed')

    def test_the_runtime_orders_default_ports_by_pin_position(self):
        """Control for the default-appearance case: moving C above A in the file
        really does swap two ports of the instance."""
        swapped = self.DEFAULT.replace('loc="(100,100)" name="Pin"', 'loc="(100,999)" name="Pin"') \
                              .replace('loc="(100,300)" name="Pin"', 'loc="(100,100)" name="Pin"') \
                              .replace('loc="(100,999)" name="Pin"', 'loc="(100,300)" name="Pin"')
        with tempfile.TemporaryDirectory(prefix='vibe-fidelity-') as tmp:
            session = Session(tmp, project(circuit('main', '    <comp loc="(400,300)" name="sub"/>\n'), self.DEFAULT))
            try:
                original = session.instance_ports(session.src, 'main', 'sub')
                other = Path(tmp) / 'swapped.circ'
                other.write_text(project(circuit('main', '    <comp loc="(400,300)" name="sub"/>\n'), swapped), encoding='utf-8')
                moved = session.instance_ports(other, 'main', 'sub')
            finally:
                session.close()
        self.assertEqual([p[:2] for p in original], [p[:2] for p in moved])
        self.assertNotEqual(original, moved)


class Helpers(unittest.TestCase):
    TEXT = project(circuit('main', pin(100, 100, 'A') + '    <comp loc="(300,300)" name="sub"/>\n'),
                   circuit('sub', pin(100, 100, 'X') + wire((100, 100), (200, 100))),
                   circuit('other', pin(50, 50, 'Z')))

    def test_splice_rewrites_only_the_named_circuit(self):
        element = _circuit_element(self.TEXT, 'sub')
        element.find('wire').set('to', '(250,100)')
        out = splice_circuit(self.TEXT, 'sub', element)
        self.assertIn('to="(250,100)"/>', out)
        self.assertEqual(_outside(self.TEXT, 'sub'), _outside(out, 'sub'))
        self.assertTrue(out.startswith('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'))
        raw = out.encode('utf-8')
        start, end = _circuit_span(raw, 'sub')
        self.assertTrue(raw[start:end].startswith(b'<circuit name="sub">') and raw[start:end].endswith(b'</circuit>'))

    def test_splice_keeps_windows_line_ends(self):
        crlf = self.TEXT.replace('\n', '\r\n')
        out = splice_circuit(crlf, 'sub', _circuit_element(crlf, 'sub'))
        self.assertNotIn('\n', out.replace('\r\n', ''))

    def test_interface_signature_sees_a_reorder_but_not_a_shift(self):
        base = _circuit_element(project(circuit('c', pin(100, 100, 'A') + pin(100, 200, 'B'))), 'c')
        shifted = _circuit_element(project(circuit('c', pin(300, 500, 'A') + pin(300, 600, 'B'))), 'c')
        swapped = _circuit_element(project(circuit('c', pin(100, 200, 'A') + pin(100, 100, 'B'))), 'c')
        back = {(300, 500): (100, 100), (300, 600): (100, 200)}
        self.assertEqual(interface_signature(base), interface_signature(shifted, lambda p: back[p]))
        self.assertNotEqual(interface_signature(base), interface_signature(swapped, lambda p: {(100, 200): (100, 100), (100, 100): (100, 200)}[p]))


if __name__ == '__main__':
    unittest.main()
