//! The Logisim process boundary. No Python or desktop APIs are required.
mod process;
mod runtime;
pub mod simulation;
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use process::{StderrCapture, exit_failure, java_path};
pub use runtime::{LEGACY_RUNTIME, Launcher, RuntimeFacts, RuntimeKind};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin},
};
use vibe_circuit_document::{DocumentView, digest};
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
    runtime: PathBuf,
    dependencies: BTreeMap<PathBuf, String>,
    /// Set while a reply is owed. A caller dropped mid-request leaves it set, and
    /// the unread reply would be taken by the next request.
    awaiting: bool,
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
pub struct Native {
    launcher: Launcher,
    worker: Option<Worker>,
    observed_version: Option<String>,
}
impl Native {
    pub fn new(root: PathBuf, state: PathBuf, runtime: Option<PathBuf>) -> Self {
        Self::with_launcher(Launcher::new(RuntimeFacts::new(root, runtime), state))
    }
    /// An editor process owner that shares runtime facts and bridge builds
    /// with other owners of the same launcher.
    pub fn with_launcher(launcher: Launcher) -> Self {
        Self {
            launcher,
            worker: None,
            observed_version: None,
        }
    }
    pub fn launcher(&self) -> &Launcher {
        &self.launcher
    }
    pub fn facts(&self) -> &RuntimeFacts {
        self.launcher.facts()
    }
    pub fn observed_version(&self) -> Option<&str> {
        self.observed_version.as_deref()
    }
    fn record_version(&mut self, bytes: &[u8]) {
        if let Some(version) = runtime::reported_version(bytes) {
            self.facts().record_version(version.clone());
            self.observed_version = Some(version);
        }
    }
    pub fn runtime(&self) -> Result<PathBuf> {
        self.facts().runtime()
    }
    pub fn status(&self) -> Value {
        self.facts().status()
    }
    async fn worker(&mut self, runtime: &Path) -> Result<&mut Worker> {
        if self.worker.as_mut().is_some_and(|w| {
            w.awaiting || w.child.try_wait().ok().flatten().is_some() || w.runtime != runtime
        }) {
            self.worker = None;
        }
        if self.worker.is_none() {
            let classes = self.launcher.classes(runtime).await?;
            let hash = digest(&std::fs::read(runtime).map_err(|e| e.to_string())?);
            let mut command = self.launcher.command("CircuitWorker", runtime).await?;
            command
                .arg(java_path(runtime))
                .arg(hash)
                .arg(java_path(&classes));
            let mut child = command.spawn().map_err(|e| e.to_string())?;
            let input = child.stdin.take().ok_or("Logisim stdin 不可用")?;
            let stderr = StderrCapture::start(child.stderr.take().ok_or("Logisim stderr 不可用")?);
            let lines = BufReader::new(child.stdout.take().ok_or("Logisim stdout 不可用")?).lines();
            let mut worker = Worker {
                child,
                stderr,
                input,
                lines,
                runtime: runtime.into(),
                dependencies: BTreeMap::new(),
                awaiting: false,
            };
            if worker.receive(true).await? != b"ready" {
                return Err("Logisim 未就绪".into());
            }
            self.worker = Some(worker);
        }
        Ok(self.worker.as_mut().unwrap())
    }
    pub async fn request(&mut self, artifact: &Path, operation: Element) -> Result<Vec<u8>> {
        let source = std::fs::read(artifact).map_err(|e| e.to_string())?;
        let (runtime, _) = self.facts().runtime_for(&source)?;
        let hash = digest(&source);
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
            .worker
            .as_ref()
            .is_some_and(|worker| worker.dependencies != dependencies)
        {
            self.worker = None;
        }
        let worker = self.worker(&runtime).await?;
        worker.dependencies = dependencies.clone();
        worker.awaiting = true;
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
        worker.awaiting = false;
        if result.is_ok() && !dependencies.is_empty() {
            match artifact_dependencies(artifact) {
                Ok(after) if after == dependencies => {}
                Ok(_) => result = Err("操作期间组件库已改变，请重试".into()),
                Err(error) => result = Err(error),
            }
        }
        if let Ok(bytes) = &result {
            self.record_version(bytes);
        }
        if result.is_err() {
            self.worker = None;
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
        location: Option<vibe_circuit_document::Point>,
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
        component: &vibe_circuit_document::Component,
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
        component: &vibe_circuit_document::Component,
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
    pub async fn shutdown(&mut self) {
        if let Some(mut worker) = self.worker.take() {
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
        for desc in library_descriptors(&bytes)? {
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

/// The `desc` of each top-level `<lib>`. This runs twice per worker request on
/// a file that can be megabytes, so UTF-8 text is scanned without building a tree.
fn library_descriptors(bytes: &[u8]) -> Result<Vec<String>> {
    use quick_xml::{XmlVersion, events::Event, reader::Reader};
    let Ok(text) = std::str::from_utf8(bytes) else {
        let tree = Element::parse(bytes).map_err(|e| e.to_string())?;
        return Ok(tree
            .children
            .iter()
            .filter_map(XMLNode::as_element)
            .filter(|e| e.name == "lib")
            .filter_map(|e| e.attributes.get("desc").cloned())
            .collect());
    };
    let mut reader = Reader::from_str(text);
    let (mut depth, mut descriptors) = (0usize, Vec::new());
    loop {
        let (element, opens) = match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(element) => (element, true),
            Event::Empty(element) => (element, false),
            Event::End(_) => {
                depth = depth.saturating_sub(1);
                continue;
            }
            Event::Eof => return Ok(descriptors),
            _ => continue,
        };
        if depth == 1 && element.name().as_ref() == "lib" {
            for attribute in element.attributes() {
                let attribute = attribute.map_err(|e| e.to_string())?;
                if attribute.key.as_ref() == "desc" {
                    let value = attribute
                        .normalized_value(XmlVersion::Implicit1_0)
                        .map_err(|e| e.to_string())?;
                    descriptors.push(value.into_owned());
                }
            }
        }
        depth += usize::from(opens);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CIRCUIT: &str = r##"<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<project source="2.16.1.4" version="1.0">
  <lib desc="#Wiring" name="0"/>
  <main name="main"/>
  <circuit name="main">
    <comp lib="0" loc="(100,100)" name="Pin"/>
  </circuit>
</project>
"##;

    /// A caller that goes away while its reply is owed must not hand that reply
    /// to the next request. Needs a JDK and the runtime in `.workbench-cache`.
    #[tokio::test]
    #[ignore = "starts JVMs"]
    async fn abandoned_request_does_not_shift_replies() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .unwrap();
        let state = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let artifact = files.path().join("main.circ");
        std::fs::write(&artifact, CIRCUIT).unwrap();
        let mut native = Native::new(root, state.path().into(), None);
        native.observe(&artifact, "main").await.unwrap();
        // The catalog request is written on the first poll; its XML reply is
        // still owed when the timeout drops the call.
        let catalog = xml("component-catalog", &[("circuit", "main".into())], vec![]);
        let abandoned =
            tokio::time::timeout(Duration::from_micros(1), native.request(&artifact, catalog))
                .await;
        assert!(
            abandoned.is_err(),
            "the catalog call should still be waiting"
        );
        let observed = native.observe(&artifact, "main").await.unwrap();
        assert!(observed.is_object(), "{observed}");
    }
}
