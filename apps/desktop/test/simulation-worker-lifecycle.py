"""Focused lifecycle proof for the isolated serial simulation worker.

This test deliberately talks to SimulationWorker directly. It does not invoke
the Codex/model path or the HTTP service, so each assertion describes the
worker boundary itself: one JVM may stay warm, while each request must load
the current artifact into a new native LogisimFile.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "apps/desktop/circuit-lens"))
sys.path.insert(0, str(REPO / "apps/desktop/test"))
from support.samples import skip_unless_samples

from studio.infrastructure.files import sha256_file
from studio.runtime.observer import ObserverRuntime
from studio.runtime.simulation_worker import SimulationWorker


RUNTIME = REPO / "apps/desktop/circuit-lens/native/Logisim-ITA.jar"
SECOND_RUNTIME = (
    REPO
    / "workspaces/hust-riscv/original/course-package/logisim-ita-cn-20200118.exe"
)


def connected_fixture(version: str) -> bytes:
    return f'''<project source="{version}" version="1.0"><lib name="0" desc="#Wiring"/>
    <main name="main"/><circuit name="main">
    <comp name="Pin" lib="0" loc="(80,80)"><a name="label" val="In"/><a name="width" val="1"/></comp>
    <comp name="Pin" lib="0" loc="(180,80)"><a name="label" val="Out"/><a name="width" val="1"/>
    <a name="output" val="true"/><a name="facing" val="west"/></comp>
    <wire from="(80,80)" to="(180,80)"/></circuit></project>'''.encode()


def disconnected_fixture(version: str) -> bytes:
    """The same interface with no wire: the output must become unknown."""
    return f'''<project source="{version}" version="1.0"><lib name="0" desc="#Wiring"/>
    <main name="main"/><circuit name="main">
    <comp name="Pin" lib="0" loc="(80,80)"><a name="label" val="In"/><a name="width" val="1"/></comp>
    <comp name="Pin" lib="0" loc="(180,80)"><a name="label" val="Out"/><a name="width" val="1"/>
    <a name="output" val="true"/><a name="facing" val="west"/></comp>
    </circuit></project>'''.encode()


def simulate_request(value: int = 1) -> ET.Element:
    request = ET.Element("simulate", circuit="main")
    vector = ET.SubElement(request, "vector")
    ET.SubElement(vector, "input", name="In", value=str(value))
    return request


def output_value(response: bytes) -> str | None:
    root = ET.fromstring(response)
    output = root.find("vector/output")
    if output is None:
        raise AssertionError("simulation response has no output")
    return output.get("value")


@skip_unless_samples(REPO, "workspaces/hust-riscv/original/course-package/logisim-ita-cn-20200118.exe")
class SimulationWorkerLifecycle(unittest.TestCase):
    def setUp(self) -> None:
        for path in (RUNTIME, SECOND_RUNTIME):
            self.assertTrue(path.is_file(), f"missing runtime fixture: {path}")

    def test_warm_jvm_fresh_artifact_runtime_switch_and_terminal_error(self):
        with tempfile.TemporaryDirectory(prefix="vibe-simulation-worker-") as directory:
            root = Path(directory)
            state = root / "state"
            artifact = root / "active.circ"
            worker = SimulationWorker(REPO, state)
            try:
                connected = connected_fixture("worker-connected")
                disconnected = disconnected_fixture("worker-disconnected")
                artifact.write_bytes(connected)

                first = worker.request(RUNTIME, artifact, simulate_request())
                first_process = worker.process
                self.assertIsNotNone(first_process)
                self.assertEqual(worker.starts, 1)
                self.assertEqual(output_value(first), "1")
                first_root = ET.fromstring(first)
                self.assertEqual(first_root.get("artifactSha256"), hashlib.sha256(connected).hexdigest())
                self.assertEqual(first_root.get("runtimeJarSha256"), sha256_file(RUNTIME))

                # Keep the same path and the same JVM, but replace the bytes with
                # a different circuit. A cached LogisimFile would still report 1.
                artifact.write_bytes(disconnected)
                second = worker.request(RUNTIME, artifact, simulate_request())
                self.assertIs(worker.process, first_process)
                self.assertEqual(first_process.poll(), None)
                self.assertEqual(worker.starts, 1)
                self.assertIsNone(output_value(second))
                second_root = ET.fromstring(second)
                self.assertEqual(second_root.get("artifactSha256"), hashlib.sha256(disconnected).hexdigest())

                # A runtime binding change must stop the old JVM and start one
                # bound to the second actual runtime artifact.
                second_process = worker.process
                switched = worker.request(SECOND_RUNTIME, artifact, simulate_request())
                self.assertIsNotNone(second_process)
                self.assertIsNot(second_process, worker.process)
                self.assertIsNotNone(second_process.poll())
                self.assertEqual(worker.starts, 2)
                self.assertIsNone(output_value(switched))
                switched_root = ET.fromstring(switched)
                self.assertEqual(switched_root.get("runtimeJarSha256"), sha256_file(SECOND_RUNTIME))

                # A native/domain error is terminal: the worker cannot serve a
                # request after the process has crossed an uncertain native state.
                failed_process = worker.process
                invalid = ET.Element("simulate", circuit="missing-circuit")
                with self.assertRaisesRegex(ValueError, "Unknown circuit"):
                    worker.request(SECOND_RUNTIME, artifact, invalid)
                self.assertIsNotNone(failed_process)
                self.assertIsNotNone(failed_process.poll())
                self.assertIsNone(worker.process)

                # The object remains reusable after that explicit terminal
                # failure, but recovery requires a new JVM boundary.
                recovered = worker.request(SECOND_RUNTIME, artifact, simulate_request())
                self.assertEqual(worker.starts, 3)
                self.assertIsNone(output_value(recovered))
            finally:
                worker.close()

    def test_observer_runtime_close_reclaims_simulation_worker(self):
        with tempfile.TemporaryDirectory(prefix="vibe-observer-close-") as directory:
            root = Path(directory)
            artifact = root / "active.circ"
            artifact.write_bytes(connected_fixture("observer-close"))
            observer = ObserverRuntime(REPO, root / "state")
            process = None
            try:
                response = observer.simulation_worker.request(
                    observer.runtime_jar, artifact, simulate_request()
                )
                self.assertEqual(output_value(response), "1")
                process = observer.simulation_worker.process
                self.assertIsNotNone(process)
                self.assertIsNone(process.poll())
            finally:
                observer.close()

            self.assertIsNotNone(process)
            self.assertIsNotNone(process.poll())
            self.assertIsNone(observer.simulation_worker.process)
            # close is deliberately idempotent because Workspace.close can be
            # reached from more than one shutdown path.
            observer.close()


if __name__ == "__main__":
    unittest.main()
