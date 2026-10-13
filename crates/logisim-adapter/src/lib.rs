//! The Logisim process boundary. No Python or desktop APIs are required.
mod process;
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use process::{StderrCapture, exit_failure, java_path};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, watch},
};
use vibe_workspace_core::{DocumentView, digest};
use xmltree::{Element, XMLNode};
#[derive(Clone, Copy)]
pub struct Viewport {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}
type Result<T> = std::result::Result<T, String>;

fn frame_failure(frame: &Value) -> String {
    let detail = frame["attributes"]["failure"].as_str().unwrap_or("");
    if detail.contains("Viewport exceeds pixel budget") || detail.contains("画面范围超过限制")
    {
        "画面范围超过限制，请调整电路范围后重试".into()
    } else if frame["exited"] == true {
        "仿真进程已退出，请重新启动".into()
    } else {
        "仿真画面生成失败，请重新启动".into()
    }
}

pub fn xml(tag: &str, attrs: &[(&str, String)], children: Vec<Element>) -> Element {
    let mut node = Element::new(tag);
    for (k, v) in attrs {
        node.attributes.insert(k.to_string(), v.clone());
    }
    node.children = children.into_iter().map(XMLNode::Element).collect();
    node
}
pub fn encode_xml(node: &Element) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    node.write(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}
pub fn xml_json(node: &Element) -> Value {
    json!({"tag":node.name,"attributes":node.attributes,"text":node.get_text().map(|s|s.into_owned()),"children":node.children.iter().filter_map(XMLNode::as_element).map(xml_json).collect::<Vec<_>>()})
}
struct Worker {
    child: Child,
    stderr: StderrCapture,
    input: ChildStdin,
    lines: Lines<BufReader<tokio::process::ChildStdout>>,
    dependencies: BTreeMap<PathBuf, String>,
}
impl Worker {
    async fn receive(&mut self, starting: bool) -> Result<Vec<u8>> {
        let line = tokio::time::timeout(Duration::from_secs(60), self.lines.next_line())
            .await
            .map_err(|_| "Logisim 响应超时，请重试")?
            .map_err(|e| e.to_string())?;
        let Some(line) = line else {
            return Err(exit_failure(
                &mut self.child,
                &mut self.stderr,
                if starting {
                    "Logisim 启动握手前退出"
                } else {
                    "Logisim 处理请求时退出"
                },
            )
            .await);
        };
        if line.len() > 48_000_000 {
            return Err("Logisim 响应超过限制".into());
        }
        let (status, payload) = line.split_once('\t').ok_or("无效的 Logisim 响应")?;
        let bytes = B64.decode(payload).map_err(|e| e.to_string())?;
        if status != "ok" {
            return Err(String::from_utf8_lossy(&bytes).into_owned());
        }
        Ok(bytes)
    }
}
/// Isolated verification owns its process and queue independently of interactive controls.
pub struct Verifier {
    native: Native,
}
impl Verifier {
    pub fn new(root: PathBuf, state: PathBuf, runtime: Option<PathBuf>) -> Self {
        Self {
            native: Native::new(root, state, runtime),
        }
    }
    pub async fn evaluate(&mut self, artifact: &Path, operation: Element) -> Result<Element> {
        self.native.evaluate(artifact, operation).await
    }
    pub async fn shutdown(&mut self) {
        self.native.shutdown().await;
    }
}
pub struct Native {
    root: PathBuf,
    state: PathBuf,
    runtime: Option<PathBuf>,
    classes: Option<PathBuf>,
    worker: Option<Worker>,
    verification_worker: Option<Worker>,
    pub simulation: Option<Simulation>,
    updates: watch::Sender<()>,
}
impl Native {
    pub fn new(root: PathBuf, state: PathBuf, runtime: Option<PathBuf>) -> Self {
        Self {
            root,
            state,
            runtime,
            classes: None,
            worker: None,
            verification_worker: None,
            simulation: None,
            updates: watch::channel(()).0,
        }
    }
    pub fn updates(&self) -> watch::Receiver<()> {
        self.updates.subscribe()
    }
    pub fn runtime(&self) -> Result<PathBuf> {
        let candidates = [
            self.runtime.clone(),
            std::env::var_os("VIBE_LOGISIM_JAR").map(PathBuf::from),
            Some(self.root.join("native/Logisim-ITA.jar")),
            Some(self.root.join(".workbench-cache/Logisim-ITA.jar")),
        ];
        candidates
            .into_iter()
            .flatten()
            .find(|p| p.is_file())
            .ok_or_else(|| {
                "尚未安装 Logisim 兼容运行时；开发环境请运行 npm run setup，或设置 VIBE_LOGISIM_JAR"
                    .into()
            })
    }
    pub fn status(&self) -> Value {
        match self.runtime() {
            Ok(p) => json!({"available":true,"path":p}),
            Err(e) => json!({"available":false,"message":e}),
        }
    }
    async fn classes(&mut self) -> Result<PathBuf> {
        if let Some(p) = &self.classes {
            return Ok(p.clone());
        }
        let runtime = self.runtime()?;
        let packaged = self.root.join("native");
        if let Ok(expected) = std::fs::read_to_string(packaged.join("runtime.sha256"))
            && digest(&std::fs::read(&runtime).map_err(|e| e.to_string())?) == expected.trim()
            && packaged
                .join("classes/com/cburch/logisim/file/CircuitSession.class")
                .is_file()
        {
            let classes = packaged.join("classes");
            self.classes = Some(classes.clone());
            return Ok(classes);
        }
        let base = self.root.join("crates/logisim-adapter/java");
        let mut sources = Vec::new();
        let folders = if packaged.join("src").is_dir() {
            vec![packaged.join("src")]
        } else {
            vec![base.join("native"), base.join("observer/src")]
        };
        for folder in folders {
            collect_java(&folder, &mut sources)?
        }
        sources.sort();
        let mut bytes = std::fs::read(&runtime).map_err(|e| e.to_string())?;
        for p in &sources {
            bytes.extend(std::fs::read(p).map_err(|e| e.to_string())?)
        }
        let classes = self.state.join("java").join(digest(&bytes));
        if !classes
            .join("com/cburch/logisim/file/CircuitSession.class")
            .is_file()
        {
            std::fs::create_dir_all(&classes).map_err(|e| e.to_string())?;
            let mut command = Command::new(self.java_executable("javac"));
            command
                .args(["-encoding", "UTF-8", "-cp"])
                .arg(java_path(&runtime))
                .arg("-d")
                .arg(java_path(&classes))
                .args(sources.iter().map(|source| java_path(source)))
                .kill_on_drop(true);
            let output = tokio::time::timeout(Duration::from_secs(90), command.output())
                .await
                .map_err(|_| "Logisim 兼容模块编译超时")?
                .map_err(|e| format!("需要 JDK 17 或更新版本: {e}"))?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr)
                    .chars()
                    .take(6000)
                    .collect());
            }
        }
        self.classes = Some(classes.clone());
        Ok(classes)
    }
    fn java_executable(&self, name: &str) -> PathBuf {
        let binary = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.into()
        };
        let bundled = self.root.join("runtimes/java/bin").join(&binary);
        if bundled.is_file() {
            java_path(&bundled)
        } else {
            PathBuf::from(binary)
        }
    }
    async fn command(&mut self, class: &str) -> Result<Command> {
        let classes = self.classes().await?;
        let runtime = self.runtime()?;
        let cp = std::env::join_paths([java_path(&classes), java_path(&runtime)])
            .map_err(|e| e.to_string())?;
        let mut cmd = Command::new(self.java_executable("java"));
        cmd.args(["-Xmx768m", "-Djava.awt.headless=true", "-cp"])
            .arg(cp)
            .arg(format!("com.cburch.logisim.file.{class}"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        Ok(cmd)
    }
    fn worker_slot(&mut self, verification: bool) -> &mut Option<Worker> {
        if verification {
            &mut self.verification_worker
        } else {
            &mut self.worker
        }
    }
    async fn worker(&mut self, verification: bool) -> Result<&mut Worker> {
        if self
            .worker_slot(verification)
            .as_mut()
            .is_some_and(|w| w.child.try_wait().ok().flatten().is_some())
        {
            *self.worker_slot(verification) = None;
        }
        if self.worker_slot(verification).is_none() {
            let runtime = self.runtime()?;
            let classes = self.classes().await?;
            let hash = digest(&std::fs::read(&runtime).map_err(|e| e.to_string())?);
            let mut command = self
                .command(if verification {
                    "CircuitSimulationWorker"
                } else {
                    "CircuitWorker"
                })
                .await?;
            command.arg(java_path(&runtime)).arg(hash);
            if !verification {
                command.arg(java_path(&classes));
            }
            let mut child = command.spawn().map_err(|e| e.to_string())?;
            let input = child.stdin.take().ok_or("Logisim stdin 不可用")?;
            let stderr = StderrCapture::start(child.stderr.take().ok_or("Logisim stderr 不可用")?);
            let lines = BufReader::new(child.stdout.take().ok_or("Logisim stdout 不可用")?).lines();
            let mut worker = Worker {
                child,
                stderr,
                input,
                lines,
                dependencies: BTreeMap::new(),
            };
            if worker.receive(true).await? != b"ready" {
                return Err("Logisim 未就绪".into());
            }
            *self.worker_slot(verification) = Some(worker);
        }
        Ok(self.worker_slot(verification).as_mut().unwrap())
    }
    pub async fn request(&mut self, artifact: &Path, operation: Element) -> Result<Vec<u8>> {
        self.request_in(artifact, operation, false).await
    }
    pub async fn evaluate(&mut self, artifact: &Path, operation: Element) -> Result<Element> {
        let bytes = self.request_in(artifact, operation, true).await?;
        Element::parse(bytes.as_slice()).map_err(|e| e.to_string())
    }
    async fn request_in(
        &mut self,
        artifact: &Path,
        operation: Element,
        verification: bool,
    ) -> Result<Vec<u8>> {
        let hash = digest(&std::fs::read(artifact).map_err(|e| e.to_string())?);
        let request = xml(
            "request",
            &[
                ("artifact", java_path(artifact).to_string_lossy().into()),
                ("digest", hash),
            ],
            vec![operation],
        );
        let line = B64.encode(encode_xml(&request)?) + "\n";
        let dependencies = artifact_dependencies(artifact)?;
        // Logisim's LibraryManager also caches external files globally. Drop the
        // process when dependencies change, so geometry and verification cannot
        // disagree with a newly started interactive simulation.
        if self
            .worker_slot(verification)
            .as_ref()
            .is_some_and(|worker| worker.dependencies != dependencies)
        {
            *self.worker_slot(verification) = None;
        }
        let worker = self.worker(verification).await?;
        worker.dependencies = dependencies.clone();
        let mut result = async {
            worker
                .input
                .write_all(line.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            worker.input.flush().await.map_err(|e| e.to_string())?;
            worker.receive(false).await
        }
        .await;
        if result.is_ok() && !dependencies.is_empty() {
            match artifact_dependencies(artifact) {
                Ok(after) if after == dependencies => {}
                Ok(_) => result = Err("操作期间组件库已改变，请重试".into()),
                Err(error) => result = Err(error),
            }
        }
        if result.is_err() {
            *self.worker_slot(verification) = None;
        }
        result
    }
    pub async fn observe(&mut self, artifact: &Path, circuit: &str) -> Result<Value> {
        let bytes = self
            .request(
                artifact,
                xml("observe", &[("circuit", circuit.into())], vec![]),
            )
            .await?;
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }
    pub async fn catalog(
        &mut self,
        artifact: &Path,
        _view: &DocumentView,
        circuit: &str,
    ) -> Result<Value> {
        let libraries = artifact_libraries(artifact)?;
        let bytes = self
            .request(
                artifact,
                xml(
                    "component-catalog",
                    &[("circuit", circuit.into())],
                    libraries,
                ),
            )
            .await?;
        Ok(xml_json(
            &Element::parse(bytes.as_slice()).map_err(|e| e.to_string())?,
        ))
    }
    pub async fn template(
        &mut self,
        artifact: &Path,
        circuit: &str,
        library: Option<String>,
        name: String,
        location: Option<vibe_workspace_core::Point>,
        attributes: BTreeMap<String, String>,
    ) -> Result<Value> {
        let mut children = artifact_libraries(artifact)?;
        children.extend(
            attributes
                .into_iter()
                .map(|(name, value)| xml("set", &[("name", name), ("value", value)], vec![])),
        );
        let mut attrs = vec![
            ("circuit", circuit.into()),
            ("library", library.unwrap_or_default()),
            ("tool", name),
            ("strictAttributes", "true".into()),
        ];
        if let Some(p) = location {
            attrs.extend([("x", p.x.to_string()), ("y", p.y.to_string())]);
        }
        let bytes = self
            .request(
                artifact,
                xml(
                    if location.is_some() {
                        "place-component"
                    } else {
                        "component-template"
                    },
                    &attrs,
                    children,
                ),
            )
            .await?;
        Ok(xml_json(
            &Element::parse(bytes.as_slice()).map_err(|e| e.to_string())?,
        ))
    }
    pub async fn properties(
        &mut self,
        artifact: &Path,
        circuit: &str,
        component: &vibe_workspace_core::Component,
        values: BTreeMap<String, String>,
    ) -> Result<Value> {
        let bytes = self
            .request(
                artifact,
                xml(
                    "component-attributes",
                    &[
                        ("circuit", circuit.into()),
                        ("factory", component.name.clone()),
                        ("x", component.location.x.to_string()),
                        ("y", component.location.y.to_string()),
                        ("strictAttributes", "true".into()),
                    ],
                    values
                        .into_iter()
                        .map(|(name, value)| {
                            xml("set", &[("name", name), ("value", value)], vec![])
                        })
                        .collect(),
                ),
            )
            .await?;
        Ok(xml_json(
            &Element::parse(bytes.as_slice()).map_err(|e| e.to_string())?,
        ))
    }
    pub async fn memory(
        &mut self,
        artifact: &Path,
        circuit: &str,
        component: &vibe_workspace_core::Component,
        attrs: BTreeMap<String, String>,
        write: bool,
    ) -> Result<Value> {
        let mut node = xml(
            if write { "property" } else { "memory" },
            &[
                ("circuit", circuit.into()),
                ("componentId", component.id.clone()),
                ("factory", component.name.clone()),
                ("x", component.location.x.to_string()),
                ("y", component.location.y.to_string()),
            ],
            vec![],
        );
        node.attributes.extend(attrs);
        if write {
            node.attributes
                .insert("attribute".into(), "contents".into());
        }
        let bytes = self.request(artifact, node).await?;
        let result = Element::parse(bytes.as_slice()).map_err(|e| e.to_string())?;
        if write {
            Ok(json!({"contents": result.get_text().unwrap_or_default()}))
        } else {
            Ok(xml_json(&result))
        }
    }
    pub async fn render(
        &mut self,
        artifact: &Path,
        circuit: &str,
        viewport: Viewport,
    ) -> Result<String> {
        let Viewport {
            x,
            y,
            width,
            height,
            scale,
        } = viewport;
        if !scale.is_finite()
            || scale <= 0.
            || scale > 8.
            || width == 0
            || height == 0
            || width as f64 * height as f64 * scale * scale > 8_000_000.
        {
            return Err("画布大小超过限制".into());
        }
        let bytes = self
            .request(
                artifact,
                xml(
                    "render",
                    &[
                        ("circuit", circuit.into()),
                        ("x", x.to_string()),
                        ("y", y.to_string()),
                        ("width", width.to_string()),
                        ("height", height.to_string()),
                        ("scale", scale.to_string()),
                    ],
                    vec![],
                ),
            )
            .await?;
        Ok(format!("data:image/png;base64,{}", B64.encode(bytes)))
    }
    pub async fn start_simulation(
        &mut self,
        artifact: &Path,
        view: &DocumentView,
        circuit: &str,
    ) -> Result<Value> {
        let graph = view
            .circuits
            .iter()
            .find(|c| c.name == circuit)
            .ok_or("电路不存在")?;
        let view_id = uuid::Uuid::new_v4().to_string();
        let nodes = graph
            .components
            .iter()
            .map(|c| {
                xml(
                    "component",
                    &[
                        ("id", c.id.clone()),
                        ("factory", c.name.clone()),
                        ("x", c.location.x.to_string()),
                        ("y", c.location.y.to_string()),
                    ],
                    vec![],
                )
            })
            .collect();
        let init = xml(
            "session",
            &[("circuit", circuit.into()), ("viewId", view_id.clone())],
            nodes,
        );
        let init_path = self.state.join("session.xml");
        std::fs::create_dir_all(&self.state).map_err(|e| e.to_string())?;
        std::fs::write(&init_path, encode_xml(&init)?).map_err(|e| e.to_string())?;
        let mut command = self.command("CircuitSession").await?;
        let mut child = command
            .arg(java_path(artifact))
            .arg(java_path(&init_path))
            .spawn()
            .map_err(|e| e.to_string())?;
        let input = child.stdin.take().ok_or("仿真 stdin 不可用")?;
        let stderr = StderrCapture::start(child.stderr.take().ok_or("仿真 stderr 不可用")?);
        let mut lines = BufReader::new(child.stdout.take().ok_or("仿真 stdout 不可用")?).lines();
        let (tx, latest) = watch::channel(Value::Null);
        let (acks_tx, acks) = mpsc::channel(16);
        let updates = self.updates.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                if line.len() > 48_000_000 {
                    break;
                }
                match Element::parse(line.as_bytes()) {
                    Ok(e) => {
                        let mut value = xml_json(&e);
                        if e.name == "ack" {
                            if acks_tx.send(value).await.is_err() {
                                break;
                            }
                        } else {
                            if e.name == "frame-error" {
                                value["attributes"]["failure"] =
                                    Value::String(frame_failure(&value));
                            }
                            tx.send_replace(value);
                            updates.send_replace(());
                        }
                    }
                    Err(_) => {
                        tx.send_replace(json!({"tag":"frame-error","attributes":{"failure":"仿真返回了无效数据，请重新启动"},"children":[],"text":null}));
                        break;
                    }
                }
            }
            tx.send_modify(|value| {
                if !value.is_object() {
                    *value = json!({"exited": true});
                }
                if let Some(o) = value.as_object_mut() {
                    o.insert("exited".into(), Value::Bool(true));
                }
            });
            updates.send_replace(());
        });
        let mut simulation = Simulation {
            child,
            stderr,
            input,
            latest,
            acks,
            document_id: view.id.clone(),
            revision: view.revision.clone(),
            circuit: circuit.into(),
            view_id,
            root_circuit: circuit.into(),
            instance_path: vec![],
        };
        tokio::time::timeout(Duration::from_secs(30), simulation.latest.changed())
            .await
            .map_err(|_| "仿真启动超时")?
            .map_err(|_| "仿真启动失败")?;
        let state = simulation.state();
        if state["frame"]["exited"] == true {
            return Err(exit_failure(
                &mut simulation.child,
                &mut simulation.stderr,
                "仿真进程已退出",
            )
            .await);
        }
        if state["frame"]["tag"] != "frame" || state["frame"]["exited"] == true {
            return Err(format!("仿真未启动：{}", frame_failure(&state["frame"])));
        }
        self.simulation = Some(simulation);
        self.updates.send_replace(());
        Ok(state)
    }
    pub async fn stop_simulation(&mut self) {
        if let Some(mut sim) = self.simulation.take() {
            let _ = sim.child.kill().await;
        }
        self.updates.send_replace(());
    }
    pub async fn shutdown(&mut self) {
        self.stop_simulation().await;
        for mut worker in [self.worker.take(), self.verification_worker.take()]
            .into_iter()
            .flatten()
        {
            let _ = worker.child.kill().await;
        }
    }
}
pub fn artifact_dependencies(artifact: &Path) -> Result<BTreeMap<PathBuf, String>> {
    fn collect(
        source: &Path,
        dependencies: &mut BTreeMap<PathBuf, String>,
        visited: &mut std::collections::BTreeSet<PathBuf>,
    ) -> Result<()> {
        let source = source.canonicalize().map_err(|e| e.to_string())?;
        if !visited.insert(source.clone()) {
            return Ok(());
        }
        if visited.len() > 256 {
            return Err("外部组件库数量超过限制".into());
        }
        let bytes = std::fs::read(&source).map_err(|e| e.to_string())?;
        let tree = Element::parse(bytes.as_slice()).map_err(|e| e.to_string())?;
        for library in tree.children.iter().filter_map(XMLNode::as_element) {
            if library.name != "lib" {
                continue;
            }
            let Some(desc) = library.attributes.get("desc") else {
                continue;
            };
            let (name, circuit) = if let Some(name) = desc.strip_prefix("file#") {
                (name, true)
            } else if let Some(name) = desc.strip_prefix("jar#") {
                (name.split_once('#').map_or(name, |(file, _)| file), false)
            } else {
                continue;
            };
            let directory = source.parent().ok_or("电路目录不可用")?;
            let path = directory.join(name);
            let path = if path.is_file() {
                path
            } else {
                // Match the native loader's basename fallback for moved files.
                directory.join(name.replace('\\', "/").rsplit('/').next().unwrap_or(name))
            };
            if !path.is_file() {
                // Let the native loader resolve runtime-specific plugin aliases
                // and report missing files with its normal error context.
                dependencies.insert(path, "missing".into());
                continue;
            }
            let path = path.canonicalize().map_err(|e| e.to_string())?;
            dependencies.insert(
                path.clone(),
                digest(&std::fs::read(&path).map_err(|e| e.to_string())?),
            );
            if circuit {
                collect(&path, dependencies, visited)?;
            }
        }
        Ok(())
    }
    let mut dependencies = BTreeMap::new();
    collect(artifact, &mut dependencies, &mut Default::default())?;
    Ok(dependencies)
}
pub struct Simulation {
    child: Child,
    stderr: StderrCapture,
    input: ChildStdin,
    latest: watch::Receiver<Value>,
    acks: mpsc::Receiver<Value>,
    pub document_id: String,
    pub revision: String,
    pub circuit: String,
    view_id: String,
    root_circuit: String,
    instance_path: Vec<String>,
}
impl Simulation {
    pub fn failed(&self) -> bool {
        let frame = self.latest.borrow();
        frame["exited"] == true || frame["tag"] != "frame"
    }
    pub fn state(&self) -> Value {
        json!({"documentId":self.document_id,"revision":self.revision,"circuit":self.circuit,"viewId":self.view_id,"rootCircuit":self.root_circuit,"instancePath":self.instance_path,"frame":self.latest.borrow().clone()})
    }
    pub async fn sample(&mut self) -> Result<Value> {
        let ack = self.command("sample", BTreeMap::new()).await?;
        let sequence = ack["attributes"]["commandSequence"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or("无效仿真响应")?;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let frame = self.latest.borrow().clone();
                if frame["exited"] == true || frame["tag"] == "frame-error" {
                    return Err("仿真已退出或无法采样".to_string());
                }
                if frame["attributes"]["commandSequence"]
                    .as_str()
                    .and_then(|s| s.parse::<u64>().ok())
                    .is_some_and(|s| s >= sequence)
                {
                    return Ok(self.state());
                }
                self.latest
                    .changed()
                    .await
                    .map_err(|_| "仿真已退出".to_string())?;
            }
        })
        .await
        .map_err(|_| "仿真采样超时")?
    }
    pub async fn navigate(&mut self, view: &DocumentView, path: Vec<String>) -> Result<Value> {
        if path.len() > 64 {
            return Err("子电路层级过深".into());
        }
        let mut circuit = self.root_circuit.clone();
        let mut children = Vec::new();
        for id in &path {
            let graph = view
                .circuits
                .iter()
                .find(|c| c.name == circuit)
                .ok_or("找不到电路")?;
            let c = graph
                .components
                .iter()
                .find(|c| c.id == *id && c.library.is_none())
                .ok_or("找不到子电路实例")?;
            children.push(xml(
                "instance",
                &[
                    ("factory", c.name.clone()),
                    ("x", c.location.x.to_string()),
                    ("y", c.location.y.to_string()),
                ],
                vec![],
            ));
            circuit = c.name.clone();
        }
        let graph = view
            .circuits
            .iter()
            .find(|c| c.name == circuit)
            .ok_or("找不到子电路定义")?;
        children.extend(graph.components.iter().map(|c| {
            xml(
                "component",
                &[
                    ("id", c.id.clone()),
                    ("factory", c.name.clone()),
                    ("x", c.location.x.to_string()),
                    ("y", c.location.y.to_string()),
                ],
                vec![],
            )
        }));
        let next = uuid::Uuid::new_v4().to_string();
        let node = xml(
            "view",
            &[("circuit", circuit.clone()), ("viewId", next.clone())],
            children,
        );
        self.send(node).await?;
        tokio::time::timeout(Duration::from_secs(10), async {
            while self.latest.borrow()["attributes"]["viewId"] != next {
                self.latest
                    .changed()
                    .await
                    .map_err(|_| "仿真已退出".to_string())?;
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|_| "切换仿真视图超时")??;
        self.circuit = circuit;
        self.view_id = next;
        self.instance_path = path;
        Ok(self.state())
    }
    async fn send(&mut self, node: Element) -> Result<Value> {
        let mut bytes = encode_xml(&node)?;
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|e| e.to_string())?;
        self.input.flush().await.map_err(|e| e.to_string())?;
        let ack = tokio::time::timeout(Duration::from_secs(10), self.acks.recv())
            .await
            .map_err(|_| "仿真操作超时")?;
        let Some(ack) = ack else {
            return Err(exit_failure(&mut self.child, &mut self.stderr, "仿真进程已退出").await);
        };
        if let Some(e) = ack["attributes"]["error"].as_str() {
            return Err(e.into());
        }
        Ok(ack)
    }
    pub async fn command(&mut self, op: &str, attrs: BTreeMap<String, String>) -> Result<Value> {
        if ![
            "tick",
            "play",
            "pause",
            "reset",
            "step",
            "configure",
            "poke",
            "input",
            "pulse",
            "button",
            "sample",
            "memory",
            "memory-write",
            "viewport",
            "trace",
            "trace-stop",
        ]
        .contains(&op)
        {
            return Err("未知的仿真命令".into());
        }
        let mut command = xml(op, &[("viewId", self.view_id.clone())], vec![]);
        command.attributes.extend(attrs);
        let mut bytes = encode_xml(&command)?;
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|e| e.to_string())?;
        self.input.flush().await.map_err(|e| e.to_string())?;
        let ack = tokio::time::timeout(Duration::from_secs(10), self.acks.recv())
            .await
            .map_err(|_| "仿真操作超时")?;
        let Some(ack) = ack else {
            return Err(exit_failure(&mut self.child, &mut self.stderr, "仿真进程已退出").await);
        };
        if let Some(e) = ack["attributes"]["error"].as_str() {
            return Err(e.into());
        }
        Ok(ack)
    }
}
fn collect_java(path: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let p = entry.map_err(|e| e.to_string())?.path();
        if p.is_dir() {
            collect_java(&p, out)?
        } else if p.extension().is_some_and(|e| e == "java") {
            out.push(p)
        }
    }
    Ok(())
}

fn artifact_libraries(artifact: &Path) -> Result<Vec<Element>> {
    let bytes = std::fs::read(artifact).map_err(|e| e.to_string())?;
    let root = Element::parse(bytes.as_slice()).map_err(|e| e.to_string())?;
    Ok(root
        .children
        .iter()
        .filter_map(XMLNode::as_element)
        .filter(|e| e.name == "lib")
        .map(|l| {
            xml(
                "library",
                &[
                    ("id", l.attributes.get("name").cloned().unwrap_or_default()),
                    (
                        "desc",
                        l.attributes.get("desc").cloned().unwrap_or_default(),
                    ),
                ],
                vec![],
            )
        })
        .collect())
}
