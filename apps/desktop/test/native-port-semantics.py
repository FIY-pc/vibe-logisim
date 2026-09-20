"""Verified port semantics through native templates, construction and simulation.

Two installed runtimes; synthetic circuits only; no models or profile copies.
--report-dir retains javap, native read/write probes and product-path evidence.
"""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'apps/desktop/circuit-lens'))
from studio.application.workspace import Workspace

RUNTIMES = [
    ('2.16.2.2', REPO / 'apps/desktop/circuit-lens/native/Logisim-ITA.jar'),
    ('2.15.0', REPO / 'workspaces/hust-riscv/original/course-package/logisim-ita-cn-20200118.exe'),
]
REPORT_DIR = None
ROLES = ['q', 'd', 'clock', 'clear', 'enable', 'chipSelect', 'preset']
PROBE = r'''
import java.util.*;
import java.lang.reflect.*;
import com.cburch.logisim.comp.*;
import com.cburch.logisim.data.*;
import com.cburch.logisim.instance.*;
import com.cburch.logisim.std.arith.Adder;
import com.cburch.logisim.std.memory.Register;
import com.cburch.logisim.std.wiring.Pin;
import com.cburch.logisim.circuit.NativePortSemantics;
class NativePortProbe {
  static class OtherAdder extends Adder {}
  static class OtherRegister extends Register {}
  @SuppressWarnings({"unchecked", "rawtypes"})
  public static void main(String[] args) throws Exception {
    boolean calibrated = args.length == 0;
    for (InstanceFactory f : new InstanceFactory[]{new Adder(), new Register(),
            new OtherAdder(), new OtherRegister(), Pin.FACTORY}) {
      AttributeSet attrs = f.createAttributeSet();
      for (int variant=0; variant<(f==Pin.FACTORY?2:1); variant++) {
        if (f==Pin.FACTORY) {
          Attribute a=attrs.getAttribute("output"); attrs.setValue(a,a.parse(variant==0?"false":"true"));
        }
        Component c=f.createComponent(Location.create(0,0),attrs);
        System.out.println(f.getClass().getName());
        for(int i=0;i<c.getEnds().size();i++) {
          EndData e=c.getEnd(i);
          Map<String,Object> observed=new LinkedHashMap<>();
          NativePortSemantics.putDirection(observed,c,i);
          System.out.println("  "+i+" at="+e.getLocation()+" width="+e.getWidth()+
              " native="+NativePortSemantics.nativeDirection(e)+" exclusive="+e.isExclusive()+
              " observation="+observed+" role="+NativePortSemantics.registerRole(c,i));
          boolean corrected=calibrated && f.getClass()==Adder.class && i==4;
          if(observed.containsKey("nativeDirection")!=corrected) throw new AssertionError("calibration boundary");
          if(i==4 && f instanceof Adder && (!e.isInput() || e.isOutput() || e.isExclusive()))
              throw new AssertionError("native declaration was changed");
        }
        if(NativePortSemantics.isVerifiedRegister(c)!=(f.getClass()==Register.class && calibrated))
            throw new AssertionError("Register classification boundary");
        if(f.getClass()!=Adder.class && f.getClass()!=Register.class) continue;
        Value[] values=new Value[c.getEnds().size()]; Arrays.fill(values,Value.FALSE);
        Object[] data=new Object[1]; Map<Integer,String> writes=new TreeMap<>(); Set<Integer> reads=new TreeSet<>();
        InstanceState st=(InstanceState)Proxy.newProxyInstance(InstanceState.class.getClassLoader(),
            new Class[]{InstanceState.class},(obj,m,a)->{
          switch(m.getName()) {
            case "getAttributeValue": return attrs.getValue((Attribute)a[0]);
            case "getPort": reads.add((Integer)a[0]); return values[(Integer)a[0]];
            case "setPort": writes.put((Integer)a[0],((Value)a[1]).toHexString()); return null;
            case "getData": return data[0];
            case "setData": data[0]=a[0]; return null;
            default: throw new UnsupportedOperationException(m.toString());
          }
        });
        if(f instanceof Adder) {
          values[0]=Value.createKnown(BitWidth.create(8),255); values[1]=Value.createKnown(BitWidth.create(8),1);
          f.propagate(st); System.out.println("  255+1+0 reads="+reads+" writes="+writes);
          if(!"1".equals(writes.get(4))) throw new AssertionError("native carry");
        } else {
          values[1]=Value.createKnown(BitWidth.create(8),5); values[4]=Value.TRUE;
          f.propagate(st); values[2]=Value.TRUE; f.propagate(st); System.out.println("  rising D=5 writes="+writes);
          values[3]=Value.TRUE; f.propagate(st); System.out.println("  CLR=1 writes="+writes);
          values[3]=Value.FALSE; values[6]=Value.TRUE; f.propagate(st); System.out.println("  PRE=1 writes="+writes);
          values[6]=Value.FALSE; values[5]=Value.TRUE; f.propagate(st); System.out.println("  CS=1 writes="+writes+" reads="+reads);
        }
      }
    }
  }
}
'''


def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


class NativePortSemantics(unittest.TestCase):
    def test_both_installed_implementations_and_product_paths(self):
        with tempfile.TemporaryDirectory(prefix='vibe-port-semantics-') as temporary:
            root = REPORT_DIR or Path(temporary)
            root.mkdir(parents=True, exist_ok=True)
            records = []
            for version, jar in RUNTIMES:
                with self.subTest(runtime=version):
                    case = root / version
                    case.mkdir()
                    with zipfile.ZipFile(jar) as archive:
                        classes = {name: archive.read('com/cburch/logisim/std/' + package + '/' + name + '.class')
                                   for name, package in [('Adder', 'arith'), ('Register', 'memory')]}
                    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in classes.items()}
                    manifest = {'jar': str(jar), 'jarSha256': hashlib.sha256(jar.read_bytes()).hexdigest(),
                                'classSha256': hashes}
                    save_json(case / 'runtime.json', manifest)
                    for name in ('std.arith.Adder', 'std.memory.Register', 'instance.Port',
                                 'comp.EndData', 'instance.InstanceStateImpl', 'std.wiring.Pin'):
                        result = subprocess.run(['javap', '-classpath', str(jar), '-p', '-c', '-constants',
                                                 'com.cburch.logisim.' + name], capture_output=True, text=True, check=True)
                        (case / (name + '.javap.txt')).write_text(result.stdout)
                    source = case / 'blank.circ'
                    original = (f'<project source="{version}" version="1.0"><lib name="0" desc="#Wiring"/>'
                                '<lib name="3" desc="#Arithmetic"/><lib name="4" desc="#Memory"/>'
                                '<main name="main"/><circuit name="main"/></project>').encode()
                    source.write_bytes(original)
                    w = Workspace(REPO, case / 'state', REPO / 'apps/desktop/circuit-lens/lensctl.py', 'port-semantics')
                    try:
                        w.open_path(source)
                        before = deepcopy((w.revision_id, w.artifact_sha256, w.history.record))
                        def call(tool_name, **args):
                            return w.application.agent_tool({'projectId': w.history.record['id'],
                                'revisionId': w.revision_id, 'tool': tool_name, 'arguments': {'circuit': 'main', **args}})
                        template = call('describe_component', library='3', tool='Adder', attributes={'width': '8'})
                        provenance = {'direction': 'output', 'nativeDirection': 'input',
                                      'directionSource': 'verified-class-sha256:' + hashes['Adder']}
                        def check_carry(end):
                            self.assertEqual({k: end[k] for k in provenance}, provenance)
                        check_carry(template['ports'][4])
                        self.assertFalse(template['ports'][4]['exclusive'])
                        for port in template['ports'][:4]:
                            self.assertNotIn('nativeDirection', port)
                            self.assertNotIn('directionSource', port)
                        reg = call('describe_component', library='4', tool='Register')
                        self.assertEqual([p['semanticRole'] for p in reg['ports']], ROLES)
                        save_json(case / 'templates.json', {'Adder': template, 'Register': reg})

                        def part(alias, factory, library, x, y, **attrs):
                            return {'id': alias, 'factory': factory, 'library': library,
                                    'location': {'x': x, 'y': y}, 'attributes': attrs}
                        additions = [part('adder', 'Adder', '3', 300, 200, width='8'),
                                     part('register', 'Register', '4', 600, 200, width='8')]
                        for label, x, y, width, output in [('A',100,190,8,False), ('B',100,210,8,False),
                                ('Ci',280,100,1,False), ('Sum',450,200,8,True), ('Co',280,300,1,True)]:
                            additions.append(part(label, 'Pin', '0', x, y, label=label, width=str(width),
                                                  output=str(output).lower(), facing='west' if output else 'east'))
                        placed = call('wire_candidate', title='Native carry-out fixture', additions=additions, connections=[])
                        inspected = call('inspect_circuit', candidateId=placed['id'])
                        ids = {c['label'] or c['factory']: c['componentId'] for c in inspected['components']}
                        dangling = next(e for e in inspected['connectivityIssues']['unconnectedOutputs']
                                        if e['componentId'] == ids['Adder'] and e['endIndex'] == 4)
                        check_carry(dangling)
                        save_json(case / 'unconnected-carry.json', dangling)
                        connections = []
                        for label, port, output in [('A',0,False), ('B',1,False), ('Ci',3,False), ('Sum',2,True), ('Co',4,True)]:
                            a, b = {'component': ids['Adder'], 'port': port}, {'component': ids[label], 'port': 0}
                            connections.append({'name': label, 'from': a if output else b, 'to': b if output else a})
                        wired = call('wire_candidate', title='Wire native carry-out', candidateId=placed['id'], connections=connections)
                        directory, _ = w.workbench._metadata(wired['id'])
                        artifact = directory / 'artifact.circ'
                        frozen = artifact.read_bytes()
                        (case / 'wired.circ').write_bytes(frozen)
                        observation = w.observer.run_full(artifact, 'main')
                        save_json(case / 'observation.json', observation)
                        adder = next(c for c in observation['focus']['components'] if c['factoryName'] == 'Adder')
                        check_carry(adder['ends'][4])
                        contacts = [p for n in observation['focus']['bitNets'] for p in n['contacts']
                                    if p['componentId'] == adder['componentId'] and p['endIndex'] == 4]
                        self.assertEqual(len(contacts), 1)
                        check_carry(contacts[0])
                        register = next(c for c in observation['focus']['components'] if c['factoryName'] == 'Register')
                        self.assertEqual([p['semanticRole'] for p in register['ends']], ROLES)
                        state = next(s for s in observation['focus']['stateElements'] if s['componentId'] == register['componentId'])
                        self.assertEqual([p['role'] for p in state['ports']], ROLES)
                        self.assertEqual(state['roleMappingProfile'], 'verified-class-sha256:' + hashes['Register'])
                        view = w._transform_exact(observation, w.observer.profile())['circuit']
                        check_carry(next(c for c in view['components'] if c['factory'] == 'Adder')['ends'][4])

                        # Standalone compilation + compact Java/Python projection must keep provenance too.
                        overview = w.observer.run_query(artifact, 'main', {'x':0,'y':0,'width':800,'height':500}, 'overview', [])
                        check_carry(overview['overview']['directionCorrections'][0])
                        save_json(case / 'compact-overview.json', overview)
                        vectors = [{'inputs': {'A':a,'B':b,'Ci':ci}, 'expected': {'Sum':(a+b+ci)&255,'Co':(a+b+ci)>>8}}
                                   for a,b,ci in [(0,0,0),(255,1,0),(255,0,1),(127,128,0),(255,255,1),(7,8,1)]]
                        report = call('simulate_circuit', candidateId=wired['id'], vectors=vectors)
                        self.assertEqual(report['passed'], len(vectors))
                        self.assertEqual(report['execution']['runtimeJarSha256'], manifest['jarSha256'])
                        save_json(case / 'simulation.json', report)
                        self.assertEqual(artifact.read_bytes(), frozen)
                        self.assertEqual(source.read_bytes(), original)
                        self.assertEqual((w.revision_id, w.artifact_sha256, w.history.record), before)

                        probe = case / 'NativePortProbe.java'
                        probe.write_text(PROBE)
                        compiled = w.observer.prepare()
                        for modified in (False, True):
                            classpath = [str(compiled), str(jar)]
                            if modified:
                                # Same fully qualified classes, same behavior, different uncalibrated bytes.
                                override = case / 'uncalibrated-classes.jar'
                                with zipfile.ZipFile(override, 'w') as archive:
                                    for name, package in [('Adder','arith'), ('Register','memory')]:
                                        data = classes[name].replace((name+'.java').encode(), (name+'.javx').encode())
                                        self.assertNotEqual(data, classes[name])
                                        archive.writestr('com/cburch/logisim/std/'+package+'/'+name+'.class', data)
                                classpath.insert(0, str(override))
                            command = ['java','-XX:-UsePerfData','-Djava.awt.headless=true','--class-path',
                                       ':'.join(classpath), '--source','17',str(probe)] + (['uncalibrated'] if modified else [])
                            result = subprocess.run(command, capture_output=True, text=True, timeout=30)
                            (case / ('uncalibrated-probe.txt' if modified else 'native-probe.txt')).write_text(result.stdout+result.stderr)
                            self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
                        records.append({**manifest, 'constructionCandidate': wired['id'], 'carry': provenance,
                                        'vectors': vectors, 'passed': report['passed'], 'registerRoles': ROLES,
                                        'sourceAndRevisionUnchanged': True, 'uncalibratedClassesRejected': True})
                    finally:
                        w.close()
            save_json(root / 'summary.json', {'recordedAt': datetime.now(timezone.utc).isoformat(), 'modelCalls': 0, 'records': records})


if __name__ == '__main__':
    if '--report-dir' in sys.argv:
        index = sys.argv.index('--report-dir')
        REPORT_DIR = Path(sys.argv[index+1]).expanduser().resolve()
        del sys.argv[index:index+2]
    unittest.main()
