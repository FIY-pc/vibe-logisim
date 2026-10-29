//! The Logisim process boundary. No Python or desktop APIs are required.
mod process;
mod runtime;
pub mod simulation;
pub mod timing;
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use process::{StderrCapture, exit_failure, java_path};
pub use runtime::{LEGACY_RUNTIME, Launcher, RuntimeFacts, RuntimeKind};
use serde_json::{Value, json, value::RawValue};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin},
};
use vibe_circuit_document::{Point, Revision, WireEdit, digest};
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

/// Which component a `symbols` item records.
#[derive(Clone, Debug)]
pub enum SymbolSource {
    /// The circuit's component with this id.
    Placed { id: String },
    /// One made at (0, 0) from tool `name` of library `library` (none: the
    /// file's circuits) with these attributes, as `template` makes it.
    Made {
        library: Option<String>,
        name: String,
        attributes: BTreeMap<String, String>,
    },
}

/// What a `connections` read starts from (README, Connections).
#[derive(Clone, Debug, Default)]
pub struct ConnectionSeeds {
    /// Component ids.
    pub components: Vec<String>,
    /// Wire ids.
    pub wires: Vec<String>,
    /// Every component with an end within `radius` of the point.
    pub point: Option<(Point, f64)>,
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

/// The documents a worker keeps loaded (CircuitWorker).
const HELD: usize = 3;

/// A worker's answer to one request.
enum Reply {
    Ok(Vec<u8>),
    /// The operation failed; the message says why.
    Error(String),
    /// The worker does not hold what the request builds on.
    Reload,
}

/// How a request brought its revision to the worker.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Sent {
    /// The worker held it.
    Held,
    /// As the change from the revision the worker held.
    Change,
    /// Whole.
    Load,
}

/// Why a request failed: the operation (the worker carries on) or the
/// exchange with the process (it is dropped).
enum Failure {
    Operation(String),
    Exchange(String),
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
    /// The revisions the worker holds, least recently used first; it drops
    /// the least recently used beyond `HELD`, as this list does.
    held: Vec<Revision>,
}
impl Worker {
    async fn receive(&mut self, starting: bool) -> Result<Reply> {
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
        // A worker started with timing enabled appends its phases as a third field.
        let (payload, phases) = payload.split_once('\t').unwrap_or((payload, ""));
        timing::record_java(phases);
        let _decode = timing::span("native.decode");
        let bytes = B64.decode(payload).map_err(|e| e.to_string())?;
        Ok(match status {
            "ok" => Reply::Ok(bytes),
            "reload" => Reply::Reload,
            _ => Reply::Error(String::from_utf8_lossy(&bytes).into_owned()),
        })
    }

    /// The request line for `operation` on `revision` (README, Worker
    /// protocol): nothing more when the worker holds the revision, the change
    /// from the revision it holds when that is only components and wires of
    /// circuits, the whole document otherwise or when `whole`.
    fn line(
        &self,
        revision: &Revision,
        operation: &Element,
        whole: bool,
    ) -> Result<(String, Sent)> {
        let held = self
            .held
            .iter()
            .find(|held| {
                held.document() == revision.document()
                    && held.name() == revision.name()
                    && held.directory() == revision.directory()
            })
            .filter(|_| !whole);
        let (body, text, sent) = match held {
            Some(held) if held.revision() == revision.revision() => (None, None, Sent::Held),
            held => match held.and_then(|held| {
                let changes = held.changes(revision)?;
                let text = revision.change_text(&changes)?;
                Some((change(held, &changes), text))
            }) {
                Some((body, text)) => (
                    Some(body),
                    Some(std::borrow::Cow::Owned(text.into_bytes())),
                    Sent::Change,
                ),
                None => (
                    Some(load(revision)?),
                    Some(std::borrow::Cow::Borrowed(revision.bytes())),
                    Sent::Load,
                ),
            },
        };
        let mut request = xml(
            "request",
            &[
                ("document", revision.document().into()),
                ("revision", revision.revision().into()),
            ],
            body.into_iter().collect(),
        );
        request.children.push(XMLNode::Element(operation.clone()));
        let mut line = B64.encode(encode_xml(&request)?);
        if let Some(text) = text {
            line.push('\t');
            B64.encode_string(&*text, &mut line);
        }
        line.push('\n');
        Ok((line, sent))
    }

    /// Records that the worker holds `revision` now, as its latest document.
    fn hold(&mut self, revision: &Revision) {
        self.forget(revision.document());
        self.held.push(revision.clone());
        if self.held.len() > HELD {
            self.held.remove(0);
        }
    }
    fn forget(&mut self, document: &str) {
        self.held.retain(|held| held.document() != document);
    }

    /// Answers `operation` on `revision`, loading the revision whole when the
    /// worker cannot build it from what it holds.
    async fn answer(
        &mut self,
        revision: &Revision,
        operation: &Element,
    ) -> std::result::Result<Vec<u8>, Failure> {
        let mut whole = false;
        loop {
            let encode = timing::span("native.encode");
            let (line, sent) = self
                .line(revision, operation, whole)
                .map_err(Failure::Operation)?;
            drop(encode);
            self.awaiting = true;
            let roundtrip = timing::span("native.roundtrip");
            let reply = async {
                self.input
                    .write_all(line.as_bytes())
                    .await
                    .map_err(|e| e.to_string())?;
                self.input.flush().await.map_err(|e| e.to_string())?;
                self.receive(false).await
            }
            .await
            .map_err(Failure::Exchange)?;
            drop(roundtrip);
            self.awaiting = false;
            match reply {
                Reply::Ok(bytes) => {
                    self.hold(revision);
                    return Ok(bytes);
                }
                Reply::Error(message) => {
                    // A load that failed leaves the worker without the
                    // document; a change it took or a held revision stays.
                    if sent == Sent::Load {
                        self.forget(revision.document());
                    } else {
                        self.hold(revision);
                    }
                    return Err(Failure::Operation(message));
                }
                Reply::Reload if sent != Sent::Load => {
                    self.forget(revision.document());
                    whole = true;
                }
                Reply::Reload => {
                    return Err(Failure::Exchange("Logisim 没有载入这个修订".into()));
                }
            }
        }
    }
}

/// `<load name directory>`: the file's name and folder (relative libraries
/// resolve there), its `<lib>` names in order, and each circuit's component
/// ids in element order and wires in file order.
fn load(revision: &Revision) -> Result<Element> {
    let mut children: Vec<Element> = revision
        .libraries()
        .into_iter()
        .map(|(name, _)| xml("lib", &[("name", name)], vec![]))
        .collect();
    for circuit in revision.circuits().map_err(|e| e.to_string())? {
        children.push(xml(
            "circuit",
            &[
                ("name", circuit.name),
                ("components", circuit.components.join(" ")),
                ("wires", wires(circuit.wires.iter().map(|w| (w.from, w.to)))),
            ],
            vec![],
        ));
    }
    Ok(xml(
        "load",
        &[
            ("name", revision.name().into()),
            (
                "directory",
                revision
                    .directory()
                    .map(|d| java_path(d).to_string_lossy().into_owned())
                    .unwrap_or_default(),
            ),
        ],
        children,
    ))
}

/// `<change base>`: per changed circuit, the component ids that go, the ids
/// that come (their elements are the request's text) and the wires after it.
fn change(base: &Revision, changes: &[vibe_circuit_document::CircuitChange]) -> Element {
    xml(
        "change",
        &[("base", base.revision().into())],
        changes
            .iter()
            .map(|change| {
                xml(
                    "circuit",
                    &[
                        ("name", change.name.clone()),
                        ("remove", change.removed.join(" ")),
                        (
                            "add",
                            change
                                .added
                                .iter()
                                .map(|(id, _)| id.as_str())
                                .collect::<Vec<_>>()
                                .join(" "),
                        ),
                        ("wires", wires(change.wires.iter().map(|w| (w.from, w.to)))),
                    ],
                    vec![],
                )
            })
            .collect(),
    )
}

/// Wires as the worker reads them: `x0,y0,x1,y1` separated by spaces.
fn wires(wires: impl Iterator<Item = (Point, Point)>) -> String {
    let mut text = String::new();
    for (from, to) in wires {
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(&format!("{},{},{},{}", from.x, from.y, to.x, to.y));
    }
    text
}

pub struct Native {
    launcher: Launcher,
    worker: Option<Worker>,
    observed_version: Option<String>,
    files: KnownFiles,
}

/// A library file as a request last read it. Libraries rarely change, so a
/// request reads one again only when its size, modification time or (on
/// Unix) inode or change time differ.
struct Known {
    stamp: Stamp,
    digest: String,
    /// The `desc` of each top-level `<lib>` of a circuit file.
    libraries: Vec<String>,
}
#[derive(PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
    inode: u64,
    changed: (i64, i64),
}
impl Stamp {
    fn of(path: &Path) -> Result<Self> {
        let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        let (inode, changed) = {
            use std::os::unix::fs::MetadataExt;
            (metadata.ino(), (metadata.ctime(), metadata.ctime_nsec()))
        };
        #[cfg(not(unix))]
        let (inode, changed) = (0, (0, 0));
        Ok(Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            inode,
            changed,
        })
    }
}
#[derive(Default)]
struct KnownFiles(HashMap<PathBuf, Known>);
impl KnownFiles {
    fn get(&mut self, path: &Path, circuit: bool) -> Result<&Known> {
        let stamp = Stamp::of(path)?;
        if !self.0.get(path).is_some_and(|known| known.stamp == stamp) {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            let known = Known {
                stamp,
                digest: digest(&bytes),
                libraries: if circuit {
                    library_descriptors(&bytes)?
                } else {
                    Vec::new()
                },
            };
            if self.0.len() >= 256 {
                self.0.clear();
            }
            self.0.insert(path.to_path_buf(), known);
        }
        Ok(&self.0[path])
    }
    /// The library files that the descriptors `descs`, read in `directory`,
    /// load, with the digest of each, and the libraries of the circuit files
    /// among them, resolved the way the native loader does. A file that
    /// cannot be found is recorded as `missing`.
    fn dependencies(
        &mut self,
        directory: Option<&Path>,
        descs: Vec<String>,
    ) -> Result<BTreeMap<PathBuf, String>> {
        let mut dependencies = BTreeMap::new();
        let mut visited = BTreeSet::new();
        let mut pending = vec![(directory.map(Path::to_path_buf), descs)];
        while let Some((directory, descs)) = pending.pop() {
            for desc in descs {
                let Some((path, circuit)) = library_file(directory.as_deref(), &desc) else {
                    continue;
                };
                if !path.is_absolute() || !path.is_file() {
                    // Let the native loader resolve runtime-specific plugin
                    // aliases and report missing files with its own context.
                    dependencies.insert(path, "missing".into());
                    continue;
                }
                let path = path.canonicalize().map_err(|e| e.to_string())?;
                let known = self.get(&path, circuit)?;
                dependencies.insert(path.clone(), known.digest.clone());
                if circuit && visited.insert(path.clone()) {
                    if visited.len() > 256 {
                        return Err("外部组件库数量超过限制".into());
                    }
                    let nested = known.libraries.clone();
                    pending.push((path.parent().map(Path::to_path_buf), nested));
                }
            }
        }
        Ok(dependencies)
    }
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
            files: KnownFiles::default(),
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
                held: Vec::new(),
            };
            // The handshake names the runtime version: `ready <version>`.
            let hello = match worker.receive(true).await? {
                Reply::Ok(hello) => hello,
                Reply::Error(message) => return Err(message),
                Reply::Reload => return Err("Logisim 未就绪".into()),
            };
            let version = hello.strip_prefix(b"ready").ok_or("Logisim 未就绪")?;
            if let Some(version) = runtime::plain_version(&String::from_utf8_lossy(version)) {
                self.facts().record_version(version.clone());
                self.observed_version = Some(version);
            }
            self.worker = Some(worker);
        }
        Ok(self.worker.as_mut().unwrap())
    }
    /// Answers `operation` on `revision`. The worker is brought to the
    /// revision on the way, from what it holds or whole, in the same round
    /// trip; nothing is written to disk.
    pub async fn request(&mut self, revision: &Revision, operation: Element) -> Result<Vec<u8>> {
        let (runtime, _) = self
            .facts()
            .runtime_for_version(revision.source_version().as_deref())?;
        let scan = timing::span("native.dependencies");
        let descs = revision
            .libraries()
            .into_iter()
            .map(|(_, desc)| desc)
            .collect();
        let dependencies = self.files.dependencies(revision.directory(), descs)?;
        drop(scan);
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
        worker.dependencies = dependencies;
        match worker.answer(revision, &operation).await {
            Ok(bytes) => Ok(bytes),
            Err(Failure::Operation(message)) => Err(message),
            Err(Failure::Exchange(message)) => {
                self.worker = None;
                Err(message)
            }
        }
    }
    /// The observation of one circuit as the JSON the worker wrote.
    async fn observe_bytes(&mut self, revision: &Revision, circuit: &str) -> Result<Vec<u8>> {
        self.request(
            revision,
            xml("observe", &[("circuit", circuit.into())], vec![]),
        )
        .await
    }
    pub async fn observe(&mut self, revision: &Revision, circuit: &str) -> Result<Value> {
        let bytes = self.observe_bytes(revision, circuit).await?;
        let _parse = timing::span("native.json");
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }
    /// The observation as JSON text, checked but not parsed, for callers that
    /// pass it on whole.
    pub async fn observe_raw(
        &mut self,
        revision: &Revision,
        circuit: &str,
    ) -> Result<Box<RawValue>> {
        let bytes = self.observe_bytes(revision, circuit).await?;
        let _check = timing::span("native.json");
        let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
        RawValue::from_string(text).map_err(|e| e.to_string())
    }
    /// The vector picture of each item's component, in order, and the points
    /// of the circuit's wire bundles whose widths disagree, as the JSON the
    /// worker wrote: `{symbols: [{bounds, ink, ports, ops} | {error}],
    /// widthErrors: [[x, y]]}` (README, Symbols).
    pub async fn symbols(
        &mut self,
        revision: &Revision,
        circuit: &str,
        items: &[SymbolSource],
    ) -> Result<Box<RawValue>> {
        let made = items
            .iter()
            .any(|item| matches!(item, SymbolSource::Made { .. }));
        let mut children = if made { libraries(revision) } else { vec![] };
        children.extend(items.iter().map(|item| {
            match item {
                SymbolSource::Placed { id } => xml("symbol", &[("id", id.clone())], vec![]),
                SymbolSource::Made {
                    library,
                    name,
                    attributes,
                } => xml(
                    "symbol",
                    &[
                        ("library", library.clone().unwrap_or_default()),
                        ("tool", name.clone()),
                    ],
                    attributes
                        .iter()
                        .map(|(name, value)| {
                            xml(
                                "set",
                                &[("name", name.clone()), ("value", value.clone())],
                                vec![],
                            )
                        })
                        .collect(),
                ),
            }
        }));
        let bytes = self
            .request(
                revision,
                xml("symbols", &[("circuit", circuit.into())], children),
            )
            .await?;
        let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
        RawValue::from_string(text).map_err(|e| e.to_string())
    }
    /// The connections of chosen objects of one circuit, as the JSON the
    /// worker wrote: `{focus: {components, wires, wireBundles, bitNets}}`,
    /// the bit nets the seeds are on with every component end on them and
    /// the wire bundles and wires they pass through (README, Connections).
    pub async fn connections(
        &mut self,
        revision: &Revision,
        circuit: &str,
        seeds: &ConnectionSeeds,
    ) -> Result<Box<RawValue>> {
        let mut children = Vec::new();
        for id in &seeds.components {
            children.push(xml("component", &[("id", id.clone())], vec![]));
        }
        for id in &seeds.wires {
            children.push(xml("wire", &[("id", id.clone())], vec![]));
        }
        if let Some((at, radius)) = seeds.point {
            children.push(xml(
                "point",
                &[
                    ("x", at.x.to_string()),
                    ("y", at.y.to_string()),
                    ("radius", radius.to_string()),
                ],
                vec![],
            ));
        }
        let bytes = self
            .request(
                revision,
                xml("connections", &[("circuit", circuit.into())], children),
            )
            .await?;
        let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
        RawValue::from_string(text).map_err(|e| e.to_string())
    }
    /// The wires that keep a move's ends connected, as Logisim's select tool
    /// finds them when the mouse is released (README, Moves): the document
    /// wires the move takes out and the segments it adds, at their place
    /// after the move. `ids` are component and wire ids (`w<k>`); with
    /// `connect` false the move keeps no connection (Logisim's shift-drag)
    /// and the answer is empty.
    pub async fn moves(
        &mut self,
        revision: &Revision,
        circuit: &str,
        ids: &[String],
        delta: Point,
        connect: bool,
    ) -> Result<WireEdit> {
        let is_wire = |id: &&String| {
            id.strip_prefix('w')
                .is_some_and(|k| !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()))
        };
        let wires: Vec<&str> = ids.iter().filter(is_wire).map(String::as_str).collect();
        let components: Vec<&str> = ids
            .iter()
            .filter(|id| !is_wire(id))
            .map(String::as_str)
            .collect();
        let bytes = self
            .request(
                revision,
                xml(
                    "move",
                    &[
                        ("circuit", circuit.into()),
                        ("dx", delta.x.to_string()),
                        ("dy", delta.y.to_string()),
                        ("connect", connect.to_string()),
                        ("components", components.join(" ")),
                        ("wires", wires.join(" ")),
                    ],
                    vec![],
                ),
            )
            .await?;
        #[derive(serde::Deserialize)]
        struct Moved {
            remove: Vec<String>,
            add: Vec<[i32; 4]>,
        }
        let moved: Moved = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        Ok(WireEdit {
            removed: moved.remove,
            added: moved
                .add
                .into_iter()
                .map(|[x0, y0, x1, y1]| (Point { x: x0, y: y0 }, Point { x: x1, y: y1 }))
                .collect(),
        })
    }
    /// The points of each circuit's wire bundles whose widths disagree, in
    /// the order asked; None for a circuit the file does not have.
    pub async fn width_errors(
        &mut self,
        revision: &Revision,
        circuits: &[String],
    ) -> Result<Vec<Option<Vec<[i32; 2]>>>> {
        let children = circuits
            .iter()
            .map(|name| xml("circuit", &[("name", name.clone())], vec![]))
            .collect();
        let bytes = self
            .request(revision, xml("width-errors", &[], children))
            .await?;
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }
    /// A circuit's interface as the runtime draws it: the `<interface>`
    /// element the worker wrote (README, Interfaces).
    pub async fn interface(&mut self, revision: &Revision, circuit: &str) -> Result<Element> {
        let bytes = self
            .request(
                revision,
                xml("interface", &[("circuit", circuit.into())], vec![]),
            )
            .await?;
        Element::parse(bytes.as_slice()).map_err(|e| e.to_string())
    }
    pub async fn catalog(&mut self, revision: &Revision, circuit: &str) -> Result<Value> {
        let bytes = self
            .request(
                revision,
                xml(
                    "component-catalog",
                    &[("circuit", circuit.into())],
                    libraries(revision),
                ),
            )
            .await?;
        Ok(xml_json(
            &Element::parse(bytes.as_slice()).map_err(|e| e.to_string())?,
        ))
    }
    pub async fn template(
        &mut self,
        revision: &Revision,
        circuit: &str,
        library: Option<String>,
        name: String,
        location: Option<Point>,
        attributes: BTreeMap<String, String>,
    ) -> Result<Value> {
        let mut children = libraries(revision);
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
                revision,
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
    /// The attributes of component `component` with `values` applied, as
    /// the runtime would store them; the circuit is not changed.
    pub async fn properties(
        &mut self,
        revision: &Revision,
        circuit: &str,
        component: &str,
        values: BTreeMap<String, String>,
    ) -> Result<Value> {
        let bytes = self
            .request(
                revision,
                xml(
                    "component-attributes",
                    &[
                        ("circuit", circuit.into()),
                        ("component", component.into()),
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
    /// A page of component `component`'s stored memory, or with `write` the
    /// `contents` attribute that writing `attrs` into it gives.
    pub async fn memory(
        &mut self,
        revision: &Revision,
        circuit: &str,
        component: &str,
        attrs: BTreeMap<String, String>,
        write: bool,
    ) -> Result<Value> {
        let mut node = xml(
            if write { "property" } else { "memory" },
            &[
                ("circuit", circuit.into()),
                ("component", component.into()),
                ("componentId", component.into()),
            ],
            vec![],
        );
        node.attributes.extend(attrs);
        if write {
            node.attributes
                .insert("attribute".into(), "contents".into());
        }
        let bytes = self.request(revision, node).await?;
        let result = Element::parse(bytes.as_slice()).map_err(|e| e.to_string())?;
        if write {
            Ok(json!({"contents": result.get_text().unwrap_or_default()}))
        } else {
            Ok(xml_json(&result))
        }
    }
    pub async fn render(
        &mut self,
        revision: &Revision,
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
                revision,
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

/// The `<library id desc>` elements the palette requests name: every
/// `<lib>` of the revision.
fn libraries(revision: &Revision) -> Vec<Element> {
    revision
        .libraries()
        .into_iter()
        .map(|(id, desc)| xml("library", &[("id", id), ("desc", desc)], vec![]))
        .collect()
}

/// The library files a circuit file on disk loads, with the digest of each,
/// and theirs in turn; a file that cannot be found is recorded as `missing`.
pub fn library_dependencies(file: &Path) -> Result<BTreeMap<PathBuf, String>> {
    let mut files = KnownFiles::default();
    let file = file.canonicalize().map_err(|e| e.to_string())?;
    let descs = files.get(&file, true)?.libraries.clone();
    files.dependencies(file.parent(), descs)
}

/// The file a library descriptor read in `directory` names and whether it
/// is a circuit file; None for built-in libraries. A missing file is
/// returned as is: the native loader resolves runtime-specific plugin
/// aliases and reports missing files with its own error context.
fn library_file(directory: Option<&Path>, desc: &str) -> Option<(PathBuf, bool)> {
    let (name, circuit) = if let Some(name) = desc.strip_prefix("file#") {
        (name, true)
    } else if let Some(name) = desc.strip_prefix("jar#") {
        (name.split_once('#').map_or(name, |(file, _)| file), false)
    } else {
        return None;
    };
    let Some(directory) = directory else {
        return Some((PathBuf::from(name), circuit));
    };
    let path = directory.join(name);
    if path.is_file() {
        return Some((path, circuit));
    }
    // Match the native loader's basename fallback for moved files.
    let base = name.replace('\\', "/");
    Some((
        directory.join(base.rsplit('/').next().unwrap_or(name)),
        circuit,
    ))
}

/// The `desc` of each top-level `<lib>` of a library file, scanned without
/// building a tree.
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
    let (mut depth, mut libraries) = (0usize, Vec::new());
    loop {
        let (element, opens) = match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(element) => (element, true),
            Event::Empty(element) => (element, false),
            Event::End(_) => {
                depth = depth.saturating_sub(1);
                continue;
            }
            Event::Eof => return Ok(libraries),
            _ => continue,
        };
        if depth == 1 && element.name().as_ref() == "lib" {
            for attribute in element.attributes() {
                let attribute = attribute.map_err(|e| e.to_string())?;
                if attribute.key.as_ref() == "desc" {
                    let value = attribute
                        .normalized_value(XmlVersion::Implicit1_0)
                        .map_err(|e| e.to_string())?;
                    libraries.push(value.into_owned());
                }
            }
        }
        depth += usize::from(opens);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibe_circuit_document::{Document, Edit};

    const CIRCUIT: &str = r##"<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<project source="2.16.1.4" version="1.0">
  <lib desc="#Wiring" name="0"/>
  <main name="main"/>
  <circuit name="main">
    <comp lib="0" loc="(100,100)" name="Pin"/>
  </circuit>
</project>
"##;

    fn native() -> (Native, tempfile::TempDir) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .unwrap();
        let state = tempfile::tempdir().unwrap();
        (Native::new(root, state.path().into(), None), state)
    }

    /// A caller that goes away while its reply is owed must not hand that reply
    /// to the next request. Needs a JDK and the runtime in `.workbench-cache`.
    #[tokio::test]
    #[ignore = "starts JVMs"]
    async fn abandoned_request_does_not_shift_replies() {
        let (mut native, _state) = native();
        let doc = Document::from_bytes("main.circ".into(), None, CIRCUIT.into(), false).unwrap();
        let revision = doc.snapshot();
        native.observe(&revision, "main").await.unwrap();
        // The catalog request is written on the first poll; its XML reply is
        // still owed when the timeout drops the call.
        let catalog = xml("component-catalog", &[("circuit", "main".into())], vec![]);
        let abandoned =
            tokio::time::timeout(Duration::from_micros(1), native.request(&revision, catalog))
                .await;
        assert!(
            abandoned.is_err(),
            "the catalog call should still be waiting"
        );
        let observed = native.observe(&revision, "main").await.unwrap();
        assert!(observed.is_object(), "{observed}");
    }

    async fn errors(native: &mut Native, doc: &Document) -> Vec<Option<Vec<[i32; 2]>>> {
        let revision = doc.snapshot();
        native
            .width_errors(&revision, &["main".into()])
            .await
            .unwrap()
    }

    /// The worker follows a document through edits and an undo as changes
    /// from the revision it holds, and reads each revision as a whole load
    /// of it would. Needs a JDK and the runtime in `.workbench-cache`.
    #[tokio::test]
    #[ignore = "starts JVMs"]
    async fn held_revision_follows_edits_and_undo() {
        let (mut native, _state) = native();
        let mut doc =
            Document::from_bytes("main.circ".into(), None, CIRCUIT.into(), false).unwrap();
        assert_eq!(errors(&mut native, &doc).await, [Some(vec![])]);
        let place = |name: &str, x, y, width: &str| Edit::Place {
            name: name.into(),
            library: Some("0".into()),
            location: Point { x, y },
            attributes: [("width".to_string(), width.to_string())].into(),
        };
        let r = doc.revision();
        doc.edit(&r, "main", place("Pin", 200, 100, "8")).unwrap();
        let r = doc.revision();
        doc.edit(
            &r,
            "main",
            Edit::Wire {
                points: vec![Point { x: 100, y: 100 }, Point { x: 200, y: 100 }],
            },
        )
        .unwrap();
        // A 1-bit and an 8-bit pin on one wire disagree about its width.
        let wired = errors(&mut native, &doc).await;
        assert_eq!(wired.len(), 1);
        assert!(!wired[0].as_ref().unwrap().is_empty(), "{wired:?}");
        let r = doc.revision();
        doc.undo(&r).unwrap();
        assert_eq!(errors(&mut native, &doc).await, [Some(vec![])]);
        let r = doc.revision();
        doc.redo(&r).unwrap();
        let again = errors(&mut native, &doc).await;
        assert_eq!(again, wired);
        // An attribute edit replaces the component under its id.
        let r = doc.revision();
        doc.edit(
            &r,
            "main",
            Edit::Attributes {
                id: "c200_100".into(),
                values: [("width".to_string(), "1".to_string())].into(),
            },
        )
        .unwrap();
        assert_eq!(errors(&mut native, &doc).await, [Some(vec![])]);
        // The ids the worker answers with are the document's.
        let revision = doc.snapshot();
        let seeds = ConnectionSeeds {
            wires: vec!["w0".into()],
            ..ConnectionSeeds::default()
        };
        let connections = native.connections(&revision, "main", &seeds).await.unwrap();
        let connections: Value = serde_json::from_str(connections.get()).unwrap();
        let mut ids: Vec<&str> = connections["focus"]["components"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["componentId"].as_str().unwrap())
            .collect();
        ids.sort();
        assert_eq!(ids, ["c100_100", "c200_100"]);
    }
}
