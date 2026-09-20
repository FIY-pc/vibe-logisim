from __future__ import annotations


"""One live native instance per workspace; immutable observations for conversation.

Clock/input operations never advance project history. A project transition ends
the old instance. Persisting an observation does not serialize resumable JVM state.
"""

from collections import OrderedDict
import copy
import hashlib
import json
import math
from pathlib import Path
import queue
import re
import subprocess
import threading
import time
import uuid
import xml.etree.ElementTree as ET

from studio.project.history import write_json
from studio.runtime.instance_view import InstanceViews
from studio.runtime.rendering import viewport


def memory_page(node):
    return {**{k: int(node.get(k)) for k in ("offset", "addressBits", "dataBits", "length")},
            "componentId": node.get("componentId"), "storage": node.get("storage"),
            "words": [{"address": int(w.get("address")), "value": int(w.get("value"))} for w in node.findall("word")]}


class Simulation:
    def __init__(self, workspace):
        self.w = workspace
        self.process = None
        self.record = None
        self.latest = None
        self.samples = OrderedDict()
        self.frame_images = OrderedDict()
        self.running = False
        self.reason = None
        self.log = None
        self.frames = threading.Condition(threading.RLock())
        self.controls = {}
        self.views = None

    def close(self, reason=None):
        self.running = False
        with self.frames:
            process, self.process = self.process, None
        if process:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
            process.stdin.close()
            process.stdout.close()
        if self.log:
            self.log.close()
            self.log = None
        self.record = None
        self.latest = None
        self.frame_images.clear()
        self.controls = {}
        self.reason = reason
        self.views = None

    def status(self, since=None, include_observation=True):
        if self.process and self.process.poll() is not None:
            self.close("原生运行进程已退出，请重新启动仿真")
        if self.record and (self.record["revisionId"] != self.w.revision_id or
                            self.record["projectId"] != self.w.history.record["id"]):
            self.close("电路已修改，运行状态已结束。重新启动将建立全新状态。")
        with self.frames:
            view = self.views.current if self.views else None
            result = {"session": self.record, "view": view, "running": self.running, **self.controls, "reason": self.reason}
            if include_observation and (not self.latest or self.latest["id"] != since):
                result["observation"] = self.latest if self.latest and view and self.latest['viewId']==view['id'] else None
            return result

    def start(self, circuit):
        with self.w.observation_artifact() as artifact:
            artifact = Path(artifact)
        view = self.w.circuit_view(circuit)
        if view.get("observerError"):
            raise ValueError(view['observerError']['message'])
        if not view["circuit"].get("components"):
            raise ValueError("当前电路没有可用的原生运行对象")
        observer = self.w.observer
        source = self.w.repo_root / "apps/desktop/circuit-lens/native/com/cburch/logisim/file/CircuitSession.java"
        memory = source.parents[1] / "std/memory/StudioMemory.java"
        propagation = source.parents[1] / "circuit/StudioPropagation.java"
        view_source = source.with_name('CircuitSessionView.java')
        frame_source = source.with_name('CircuitFrame.java')
        sources = [source, memory, propagation, view_source, frame_source, source.with_name('NativeCircuitLoader.java')]
        key = hashlib.sha256(b''.join(p.read_bytes() for p in sources) + observer.runtime_jar.read_bytes()).hexdigest()
        classes = self.w.state_root / "native-cache" / key
        with observer._compile_lock:
            if not (classes / "com/cburch/logisim/file/CircuitSession.class").is_file():
                classes.mkdir(parents=True, exist_ok=True)
                result = observer._run_captured(["javac", "-encoding", "UTF-8", "-cp", str(observer.runtime_jar), "-d", str(classes), *map(str, sources)], timeout=60)
                if result.returncode:
                    raise ValueError(result.stderr[-4000:])
        self.close()
        self.record = {"id": "simulation-" + uuid.uuid4().hex[:16], "projectId": self.w.history.record["id"],
                       "revisionId": self.w.revision_id, "artifactSha256": self.w.artifact_sha256,
                       "runtimeProfileId": observer.profile()["id"], "circuit": circuit,
                       "instancePath": [], "scope": "standalone-root-instance"}
        directory = self.w.state_root / "simulation" / self.record["id"]
        directory.mkdir(parents=True)
        self.views = InstanceViews(self.w, circuit)
        request = self.views.request('session', self.views.current)
        init = directory / "init.xml"
        init.write_bytes(ET.tostring(request, encoding="utf-8"))
        self.log = (directory / "runtime.log").open("w")
        self.process = subprocess.Popen(["java", "-Djava.awt.headless=true", "-cp", str(classes) + ":" + str(observer.runtime_jar),
            "com.cburch.logisim.file.CircuitSession", str(artifact), str(init)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, text=True, encoding="utf-8")
        process = self.process
        self.sequence = 0
        self.controls = {}
        self.replies = queue.Queue(maxsize=2)
        replies = self.replies
        def reader():
            try:
                while line := process.stdout.readline(8 * 1024 * 1024):
                    if not line.endswith("\n"):
                        raise ValueError("原生画面响应过大")
                    root = ET.fromstring(line)
                    if root.tag == "ack":
                        replies.put(root)
                    else:
                        with self.frames:
                            if self.process is not process:
                                return
                            self._metadata(root)
                            if root.tag == "frame":
                                self._publish(root)
                            self.frames.notify_all()
            except (OSError, ValueError, ET.ParseError) as error:
                if self.process is process:
                    self.reason = str(error)
                    self.running = False
            finally:
                try:
                    replies.put_nowait(None)
                except queue.Full:
                    pass
        threading.Thread(target=reader, daemon=True).start()
        try:
            command = self._command("sample")
            self.wait_frame(command["commandSequence"])
        except Exception as error:
            self.close(str(error))
            raise
        return self.status()

    def _command(self, op, **attrs):
        request = ET.Element(op, {k: str(v) for k, v in attrs.items()})
        return self._request(request)

    def _request(self, request):
        self.process.stdin.write(ET.tostring(request, encoding="unicode") + "\n")
        self.process.stdin.flush()
        try:
            root = self.replies.get(timeout=20)
        except queue.Empty as error:
            self.close("运行时未在 20 秒内响应")
            raise ValueError("运行时未在 20 秒内响应，已停止本次仿真") from error
        if root is None:
            self.close("原生运行进程已退出")
            raise ValueError("原生运行进程已退出或响应过大")
        if root.get("error"):
            raise ValueError(root.get("error"))
        with self.frames:
            self._metadata(root)
            return dict(self.controls)

    def _metadata(self, root):
        sequence = int(root.get("commandSequence", 0))
        if sequence < self.controls.get("commandSequence", 0):
            return
        self.controls = {"commandSequence": sequence, "ticks": int(root.get("ticks", 0)),
                         "frequency": float(root.get("frequency", 2)), "actualFrequency": float(root.get("actualFrequency", 0)),
                         **{k: root.get(k) == "true" for k in ("automatic", "pending", "oscillating")}}
        self.running = root.get("running") == "true"
        self.reason = root.get("failure") or ("检测到振荡，已暂停。未知和错误值保留原样。" if self.controls["oscillating"] else None)

    def _publish(self, root):
        """Called only by the frame reader: bitmap and ports are one native instant."""
        view = self.views.registry.get(root.get('viewId'))
        if view is None: return
        components = self.views.components(view)
        self.sequence += 1
        observation = {**self.record, **view, "viewId":view['id'], "id": "live-" + uuid.uuid4().hex[:16], "sessionId": self.record["id"],
                       "sequence": self.sequence, "ticks": int(root.get("ticks")),
                       "commandSequence": int(root.get("commandSequence")),
                       "pending": root.get("pending") == "true", "automatic": root.get("automatic") == "true",
                       "timing": {k: float(root.get(k, 0)) for k in ("captureMs", "encodeMs")},
                       "oscillating": root.get("oscillating") == "true", "components": []}
        for node in root.findall("component"):
            c = components[node.get("id")]
            observation["components"].append({"componentId": node.get("id"), "factory": c["factory"], "label": c["label"],
                "control": node.get("control"), "ports": [{"index": int(p.get("index")), "bits": p.get("bits"),
                "width": int(p.get("width")), "value": int(p.get("value")) if p.get("value") is not None else None,
                "name": c["ends"][int(p.get("index"))].get("runtimeTooltip")} for p in node.findall("port")]})
            if (driven := node.find("input")) is not None:
                observation["components"][-1]["input"] = {"bits": driven.get("bits"), "width": int(driven.get("width")),
                    "value": int(driven.get("value")) if driven.get("value") is not None else None}
        if root.find("memory") is not None:
            observation["memory"] = memory_page(root.find("memory"))
        self.samples[observation["id"]] = observation
        while len(self.samples) > 256:
            self.samples.popitem(last=False)
        render = root.find("render")
        self.latest = {**observation, "render": {"url": "data:image/png;base64," + render.text,
            "bounds": {k: float(render.get(k)) for k in ("x", "y", "width", "height")},
            "scale": float(render.get("scale")), "pixelWidth": int(render.get("pixelWidth")), "pixelHeight": int(render.get("pixelHeight"))}}

        # Keep the native frame identity with the lightweight sample. The UI
        # already holds these image bytes and can return them on an explicit
        # capture even after the bounded bitmap cache has moved on.
        observation['renderSha256'] = self._render_digest(self.latest['render'])

        self.frame_images[observation['id']] = self.latest['render']
        while len(self.frame_images)>8 or (len(self.frame_images)>1 and sum(len(r['url']) for r in self.frame_images.values())>24*1024*1024):
            self.frame_images.popitem(last=False)

    @staticmethod
    def _render_digest(render):
        # JSON in the browser writes 24.0 as 24. Normalize geometry so returning
        # an unchanged native viewport cannot invalidate its image identity.
        canonical = {**render, 'bounds': {k: float(v) for k, v in render['bounds'].items()}}
        if 'scale' in canonical: canonical['scale'] = float(canonical['scale'])
        return hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

    def frame_image(self, id, displayed=None):
        if displayed is not None:
            sample = self.observation(self.w.revision_id, id)
            if not isinstance(displayed, dict) or self._render_digest(displayed) != sample.get('renderSha256'):
                raise ValueError('留存画面与原生观察不一致，请重试')
            return copy.deepcopy(displayed)
        with self.frames:
            render = self.frame_images.get(id)
            if render is None: raise ValueError('这一帧已离开缓存，请暂停后重新留存')
            return copy.deepcopy(render)

    def wait_frame(self, command_sequence, timeout=20):
        """Explicit observation barrier for startup/dogfood, never for an input ACK."""
        deadline = time.monotonic() + timeout
        with self.frames:
            while self.latest is None or self.latest["commandSequence"] < command_sequence or self.latest['viewId'] != self.views.current['id']:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not self.process or self.process.poll() is not None:
                    raise ValueError("运行画面未就绪")
                self.frames.wait(min(remaining, .5))
            return self.latest

    def action(self, body):
        with self.w.lock:
            self.w.history._check(body.get("projectId"), body.get("revisionId"))
            self.status()
            op = body.get("action")
            if op == "start":
                return self.start(body.get("circuit"))
            if not self.record or body.get("sessionId") != self.record["id"]:
                raise ValueError("这次运行已经结束，请重新启动仿真")
            if op in {'viewport','view','input','pulse','button','poke','memory','memory-write'} and body.get('viewId') is not None and body['viewId'] != self.views.current['id']:
                raise ValueError('运行视图已切换，请重新选择对象')
            if op == 'view':
                view = self.views.prepare(body.get('instancePath'))
                command = self._request(self.views.request('view', view))
                with self.frames: self.views.current = view
                self.wait_frame(command['commandSequence'])
                return self.status()
            components = self.views.components(self.views.current)
            if op in {'input','pulse','button','poke','memory','memory-write'} and self.views.current['instancePath'] and body.get('viewId') is None:
                raise ValueError('操作需要绑定当前运行实例')
            if op == 'viewport':
                if body.get('viewId') != self.views.current['id']:
                    raise ValueError('绘图需要绑定当前运行实例')
                region = viewport(body.get('viewport') or {})
                self._command('viewport', viewId=self.views.current['id'], **dict(zip(('x','y','width','height','scale'), region)))
            elif op == "stop":
                self.close()
            elif op in {"memory", "memory-write"}:
                target = components.get(body.get("componentId"))
                if not target or target["factory"] != "RAM":
                    raise ValueError("请选择运行实例中的 RAM")
                offset, count = int(body.get("offset", 0)), int(body.get("count", 64))
                length = 1 << int(target["attributes"]["addrWidth"])
                if not 0 <= offset < length or not 1 <= count <= 128:
                    raise ValueError("地址超出存储器范围")
                attrs = {"componentId": target["componentId"], "offset": offset, "count": count, 'viewId':self.views.current['id']}
                if op == "memory-write":
                    try:
                        address = int(body.get("address"))
                        value, expected = int(body.get("value"), 16), int(body.get("expected"), 16)
                    except (ValueError, TypeError) as error:
                        raise ValueError("请输入十六进制数据") from error
                    if not 0 <= address < length or not 0 <= value < (1 << int(target["attributes"]["dataWidth"])) or expected < 0:
                        raise ValueError("地址或数据超出位宽")
                    attrs.update(address=address, value=hex(value)[2:], expected=hex(expected)[2:])
                self._command(op, **attrs)
            elif op in {"tick", "reset", "input", "pulse", "button", "poke", "play", "pause", "configure", "step", "sample"}:
                attrs = {'viewId':self.views.current['id']} if op in {'input','pulse','button','poke'} else {}
                if op == "configure":
                    if "frequency" in body:
                        frequency = float(body["frequency"])
                        if not math.isfinite(frequency) or not .25 <= frequency <= 4096:
                            raise ValueError("时钟频率范围为 0.25–4096 tick/s")
                        attrs["frequency"] = frequency
                    if "automatic" in body:
                        if not isinstance(body["automatic"], bool):
                            raise ValueError("自动传播必须是布尔值")
                        attrs["automatic"] = str(body["automatic"]).lower()
                if op in {"input", "pulse", "button", "poke"}:
                    controls = {"input", "clock"} if op == "poke" else {"pulse" if op == "button" else op}
                    target = next((c for c in self.latest["components"] if c["componentId"] == body.get("componentId") and c["control"] in controls), None)
                    if not target:
                        raise ValueError("请选择这次运行中的可操作输入")
                    attrs["componentId"] = target["componentId"]
                    if op == "poke":
                        attrs.update(x=round(float(body["x"])), y=round(float(body["y"])))
                    if op == "button":
                        if str(body.get("value")) not in {"0", "1"}:
                            raise ValueError("按钮只能按下或松开")
                        attrs["value"] = str(body["value"])
                    if op == "input":
                        try:
                            raw = str(body.get("value")).strip().lower().replace("_", "")
                            width = target["ports"][0]["width"]
                            if "x" in raw and not raw.startswith("0x"):
                                bits = raw.removeprefix("0b")
                                if bits == "x":
                                    bits *= width
                                if len(bits) != width or not re.fullmatch("[01x]+", bits):
                                    raise ValueError("Binary width mismatch")
                                component = components[target["componentId"]]
                                if component["attributes"].get("tristate") != "true":
                                    raise ValueError("Enable three-state first")
                            else:
                                value = int(raw, 16) if raw.startswith("0x") else int(raw, 2) if raw.startswith("0b") else int(raw, 10)
                                if not 0 <= value < (1 << width):
                                    raise ValueError("Width mismatch")
                                bits = format(value, f"0{width}b")
                        except ValueError as error:
                            raise ValueError("请输入位宽内的整数（支持 0x / 0b）；三态输入也支持 x 或等位宽的 0b10x…") from error
                        attrs["bits"] = bits
                self._command(op, **attrs)
            else:
                raise ValueError("Unknown simulation action")
            return self.status(include_observation=False)

    def observation(self, revision, id, circuit=None, ids=None):
        if revision != self.w.revision_id or not isinstance(id, str) or not re.fullmatch(r"live-[a-f0-9]{16}", id):
            raise ValueError("运行观察不属于当前工程版本")
        path = self.w.revision_dir / "observations" / (id + ".json")
        with self.frames:
            sample = self.samples.get(id)
        if sample is None and path.is_file():
            sample = json.loads(path.read_text())
        if not sample or sample["revisionId"] != revision or sample["projectId"] != self.w.history.record["id"]:
            raise ValueError("所见运行时刻已过期，请重新查看后再问")
        if circuit is not None and sample["circuit"] != circuit:
            raise ValueError("当前查看的是另一个电路定义，不是这个正在运行的实例")
        if not path.is_file():
            write_json(path, sample)
        result = copy.deepcopy(sample)
        if ids:
            result["components"] = [c for c in result["components"] if c["componentId"] in ids]
        return result
