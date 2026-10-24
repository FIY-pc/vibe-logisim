use crate::{
    Error, Result, digest, editing, patch,
    splice::{self, Splices, Tree},
};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    collections::{BTreeMap, HashMap, HashSet},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

pub const EMPTY_CIRCUIT: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<project source="2.7.1" version="1.0">
  <lib desc="#Wiring" name="0"/>
  <lib desc="#Gates" name="1"/>
  <lib desc="#Plexers" name="2"/>
  <lib desc="#Arithmetic" name="3"/>
  <lib desc="#Memory" name="4"/>
  <lib desc="#I/O" name="5"/>
  <main name="main"/>
  <options/>
  <mappings/>
  <toolbar/>
  <circuit name="main">
    <a name="circuit" val="main"/>
  </circuit>
</project>
"##;
const MAX_BYTES: usize = 32 * 1024 * 1024;

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, ts_rs::TS, schemars::JsonSchema,
)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}
impl Point {
    /// Reads a location as Logisim does: `(x,y)`, `x,y` or `x y`.
    pub(crate) fn parse(s: &str) -> Result<Self> {
        let invalid = || Error::InvalidDocument(format!("无效坐标: {s}"));
        fn trim(s: &str) -> &str {
            s.trim_matches(|c: char| c <= ' ')
        }
        let mut value = trim(s);
        if let Some(inner) = value.strip_prefix('(') {
            value = trim(inner.strip_suffix(')').ok_or_else(invalid)?);
        }
        let (x, y) = value
            .split_once(',')
            .or_else(|| value.split_once(' '))
            .ok_or_else(invalid)?;
        let x = trim(x)
            .parse()
            .map_err(|_| Error::InvalidDocument("无效横坐标".into()))?;
        let y = trim(y)
            .parse()
            .map_err(|_| Error::InvalidDocument("无效纵坐标".into()))?;
        Ok(Self { x, y })
    }
    pub(crate) fn xml(self) -> String {
        format!("({},{})", self.x, self.y)
    }
    pub(crate) fn translated(self, delta: Point) -> Result<Self> {
        let x = self
            .x
            .checked_add(delta.x)
            .ok_or_else(|| Error::InvalidCommand("坐标越界".into()))?;
        let y = self
            .y
            .checked_add(delta.y)
            .ok_or_else(|| Error::InvalidCommand("坐标越界".into()))?;
        Ok(Self { x, y })
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(ts_rs::TS)]
pub struct Component {
    pub id: String,
    pub name: String,
    pub library: Option<String>,
    pub location: Point,
    pub attributes: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
pub struct Wire {
    pub id: String,
    pub from: Point,
    pub to: Point,
}
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
pub struct Circuit {
    pub name: String,
    pub components: Vec<Component>,
    pub wires: Vec<Wire>,
}
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
pub struct Library {
    pub id: String,
    pub descriptor: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(ts_rs::TS)]
pub struct DocumentView {
    pub id: String,
    pub name: String,
    pub path: Option<PathBuf>,
    pub revision: String,
    /// The component palette this document produces; see `Document::palette_identity`.
    pub palette_identity: String,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub main: String,
    pub circuits: Vec<Circuit>,
    pub libraries: Vec<Library>,
}
/// Source state is separate from the draft revision: saving/reloading requires both.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SourceStatus {
    Untitled,
    Unchanged { revision: String },
    Modified { revision: String },
    Missing,
    Unreadable { message: String },
}
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[derive(ts_rs::TS)]
pub enum Edit {
    Wire {
        points: Vec<Point>,
    },
    Place {
        name: String,
        library: Option<String>,
        location: Point,
        #[serde(default)]
        attributes: BTreeMap<String, String>,
    },
    Move {
        ids: Vec<String>,
        delta: Point,
    },
    Delete {
        ids: Vec<String>,
    },
    Attributes {
        id: String,
        values: BTreeMap<String, String>,
    },
    AddCircuit {
        name: String,
    },
    RenameCircuit {
        name: String,
    },
    DeleteCircuit,
    SetMain,
    Replace {
        xml: String,
    },
    /// Wire, place, delete and attributes edits applied in order on one
    /// circuit as one change: one undo step, one title.
    Batch {
        edits: Vec<Edit>,
    },
}

/// What an edit, undo or redo changed: the history title, the circuit it
/// applied to, the objects to select, and the circuits whose bytes differ.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    pub title: String,
    pub circuit: String,
    pub components: Vec<String>,
    pub wires: Vec<String>,
    pub changed_circuits: Vec<String>,
}

/// One revision of a circuit file: its bytes and their span index.
pub(crate) struct Source {
    pub(crate) tree: Tree,
    /// The stored bytes when they are not the index's UTF-8 text.
    encoded: Option<Vec<u8>>,
    pub(crate) revision: String,
}
impl Source {
    pub(crate) fn new(bytes: Vec<u8>) -> Result<Self> {
        precheck(&bytes)?;
        let revision = digest(&bytes);
        let (text, encoded) = splice::decode(bytes)?;
        let tree = Tree::index(text)?;
        validate(&tree)?;
        Ok(Self {
            tree,
            encoded,
            revision,
        })
    }
    pub(crate) fn bytes(&self) -> &[u8] {
        self.encoded
            .as_deref()
            .unwrap_or(self.tree.text().as_bytes())
    }
}

/// One undo or redo step: the bytes of the other revision, and the title of
/// the change between them.
#[derive(Clone)]
pub(crate) struct Step {
    pub(crate) bytes: Arc<[u8]>,
    pub(crate) title: String,
}

const UNDO_STEPS: usize = 100;
const UNDO_BYTES: usize = 64 * 1024 * 1024;

/// Adds an undo step and drops the oldest ones beyond the limits. Restoring
/// the session replays changes through the same rule.
pub(crate) fn push_undo(undo: &mut Vec<Step>, step: Step) {
    undo.push(step);
    let mut total: usize = undo.iter().map(|s| s.bytes.len()).sum();
    let mut oldest = 0;
    while undo.len() - oldest > UNDO_STEPS || (undo.len() - oldest > 1 && total > UNDO_BYTES) {
        total -= undo[oldest].bytes.len();
        oldest += 1;
    }
    undo.drain(..oldest);
}

/// A change the session journal has not recorded yet.
#[derive(Clone)]
pub(crate) enum Op {
    /// New bytes, as a patch from the previous ones, under an undo title.
    Change {
        title: String,
        revision: String,
        patch: Vec<u8>,
    },
    /// An undo or redo, with the revision it leads to.
    Undo(String),
    Redo(String),
    Saved(Option<String>),
    Location {
        path: Option<PathBuf>,
        name: String,
    },
}

#[derive(Clone)]
pub struct Document {
    pub id: String,
    pub path: Option<PathBuf>,
    pub(crate) name: String,
    pub(crate) source: Arc<Source>,
    pub(crate) saved_digest: Option<String>,
    pub(crate) undo: Vec<Step>,
    pub(crate) redo: Vec<Step>,
    /// Changes the session journal has yet to record; `None` when it has to
    /// write the whole document again.
    pub(crate) pending: Option<Vec<Op>>,
}
fn precheck(bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_BYTES {
        return Err(Error::InvalidDocument("电路文件超过 32 MB".into()));
    }
    // External entities / DTD have no role in a circuit document.
    if bytes
        .windows(9)
        .any(|w| w.eq_ignore_ascii_case(b"<!DOCTYPE"))
    {
        return Err(Error::InvalidDocument("不支持含 DTD 的电路文件".into()));
    }
    Ok(())
}
fn validate(tree: &Tree) -> Result<()> {
    let root = tree.root();
    if tree.tag(root) != "project" {
        return Err(Error::InvalidDocument("请选择 Logisim .circ 文件".into()));
    }
    let mut names = HashSet::new();
    for c in tree.named(root, "circuit") {
        let name = tree.get(c, "name");
        if name.is_empty() || !names.insert(name) {
            return Err(Error::InvalidDocument("电路名称为空或重复".into()));
        }
        for c in tree.named(c, "comp") {
            Point::parse(&tree.get(c, "loc"))?;
        }
        for w in tree.named(c, "wire") {
            Point::parse(&tree.get(w, "from"))?;
            Point::parse(&tree.get(w, "to"))?;
        }
    }
    if names.is_empty() {
        return Err(Error::InvalidDocument("文件没有电路".into()));
    }
    if let Some(main) = tree.named(root, "main").next()
        && !names.contains(&tree.get(main, "name"))
    {
        return Err(Error::InvalidDocument("主电路不存在".into()));
    }
    Ok(())
}

/// Replaces the relative file of every `file#` and `jar#` library with
/// `rewrite(file)`; `None` when there is none. Only those `desc` values change.
fn rewrite_libraries(tree: &Tree, rewrite: impl Fn(&Path) -> PathBuf) -> Result<Option<String>> {
    let mut out = Splices::new(tree);
    for lib in tree.named(tree.root(), "lib") {
        let desc = tree.get(lib, "desc");
        for prefix in ["file#", "jar#"] {
            let Some(rest) = desc.strip_prefix(prefix) else {
                continue;
            };
            let (file, suffix) = rest
                .split_once('#')
                .map(|(file, suffix)| (file, format!("#{suffix}")))
                .unwrap_or((rest, String::new()));
            let file = Path::new(file);
            if file.is_relative() {
                let next = rewrite(file);
                out.set(lib, "desc", &format!("{prefix}{}{suffix}", next.display()));
            }
            break;
        }
    }
    if out.is_empty() {
        Ok(None)
    } else {
        Ok(Some(out.finish()?))
    }
}

// Keep relative library references meaningful when Save As changes the source
// directory. History uses the same base so undo cannot resurrect broken paths.
fn rebase_libraries(bytes: &[u8], from: &Path, to: &Path) -> Result<Vec<u8>> {
    if from == to {
        return Ok(bytes.to_vec());
    }
    let source = Source::new(bytes.to_vec())?;
    let rebased = rewrite_libraries(&source.tree, |file| {
        let absolute = from.join(file);
        let base: Vec<_> = to.components().collect();
        let target: Vec<_> = absolute.components().collect();
        let common = base.iter().zip(&target).take_while(|(a, b)| a == b).count();
        if common == 0 {
            return absolute;
        }
        let mut relative = PathBuf::new();
        for _ in common..base.len() {
            relative.push("..");
        }
        for part in &target[common..] {
            relative.push(part.as_os_str());
        }
        relative
    })?;
    Ok(rebased.map_or_else(|| bytes.to_vec(), String::into_bytes))
}

impl Document {
    pub fn new(name: String) -> Self {
        Self::from_bytes(name, None, EMPTY_CIRCUIT.as_bytes().to_vec(), false)
            .expect("valid built-in circuit")
    }
    pub fn open(path: &Path) -> Result<Self> {
        let path = path.canonicalize()?;
        let bytes = std::fs::read(&path)?;
        Self::from_bytes(
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            Some(path),
            bytes,
            true,
        )
    }
    pub fn from_bytes(
        name: String,
        path: Option<PathBuf>,
        bytes: Vec<u8>,
        saved: bool,
    ) -> Result<Self> {
        let source = Source::new(bytes)?;
        let saved_digest = saved.then(|| source.revision.clone());
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            path,
            name,
            source: Arc::new(source),
            saved_digest,
            undo: Vec::new(),
            redo: Vec::new(),
            pending: None,
        })
    }
    pub fn bytes(&self) -> &[u8] {
        self.source.bytes()
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    /// The `desc` of every `<lib>`, in file order.
    pub fn library_descriptors(&self) -> Vec<String> {
        let tree = &self.source.tree;
        tree.named(tree.root(), "lib")
            .map(|lib| tree.get(lib, "desc").into_owned())
            .collect()
    }
    fn record(&mut self, op: Op) {
        if let Some(pending) = &mut self.pending {
            pending.push(op);
        }
    }
    /// The bytes to load from a copy stored in another folder: relative
    /// library paths made absolute against the source's folder.
    pub fn bytes_with_absolute_libraries(&self) -> Result<Cow<'_, [u8]>> {
        let Some(directory) = self.path.as_deref().and_then(Path::parent) else {
            return Ok(Cow::Borrowed(self.bytes()));
        };
        let rewritten = rewrite_libraries(&self.source.tree, |file| directory.join(file))?;
        Ok(rewritten.map_or(Cow::Borrowed(self.bytes()), |text| {
            Cow::Owned(text.into_bytes())
        }))
    }
    pub fn saved_revision(&self) -> Option<&str> {
        self.saved_digest.as_deref()
    }
    pub fn bytes_at_path(&self, path: Option<&Path>) -> Result<Vec<u8>> {
        match (
            self.path.as_deref().and_then(Path::parent),
            path.and_then(Path::parent),
        ) {
            (Some(from), Some(to)) => rebase_libraries(self.bytes(), from, to),
            _ => Ok(self.bytes().to_vec()),
        }
    }
    pub fn revision(&self) -> String {
        self.source.revision.clone()
    }
    /// What the component palette is built from: the project version and its
    /// libraries. Editing a circuit leaves it unchanged, so the UI keeps its
    /// icons instead of asking the native side to redraw them.
    pub fn palette_identity(&self) -> String {
        let tree = &self.source.tree;
        let root = tree.root();
        let mut definition = format!("{} {}", tree.get(root, "source"), tree.get(root, "version"));
        for lib in tree.named(root, "lib") {
            definition.push('\n');
            definition.push_str(tree.source(lib));
        }
        digest(definition.as_bytes())
    }
    pub fn dirty(&self) -> bool {
        self.saved_digest.as_deref() != Some(self.source.revision.as_str())
    }
    pub fn check(&self, expected: &str) -> Result<()> {
        if self.source.revision != expected {
            Err(Error::StaleRevision)
        } else {
            Ok(())
        }
    }
    pub fn source_status(&self) -> SourceStatus {
        let Some(path) = &self.path else {
            return SourceStatus::Untitled;
        };
        match std::fs::read(path) {
            Ok(bytes) => {
                let revision = digest(&bytes);
                if self.saved_digest.as_deref() == Some(revision.as_str()) {
                    SourceStatus::Unchanged { revision }
                } else {
                    SourceStatus::Modified { revision }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => SourceStatus::Missing,
            Err(e) => SourceStatus::Unreadable {
                message: e.to_string(),
            },
        }
    }
    pub fn reload(&mut self, expected: &str, source_revision: &str, discard: bool) -> Result<()> {
        self.check(expected)?;
        if self.dirty() && !discard {
            return Err(Error::InvalidCommand("还有未保存的修改".into()));
        }
        let path = self
            .path
            .as_ref()
            .ok_or_else(|| Error::InvalidCommand("文档还没有源文件".into()))?;
        let bytes = std::fs::read(path)?;
        let revision = digest(&bytes);
        if revision != source_revision {
            return Err(Error::ExternalChange);
        }
        // Validate before changing anything; keep the draft in undo history.
        self.replace(bytes)?;
        self.saved_digest = Some(revision);
        self.record(Op::Saved(self.saved_digest.clone()));
        Ok(())
    }
    pub fn view(&self) -> Result<DocumentView> {
        let tree = &self.source.tree;
        let root = tree.root();
        let circuits = tree
            .named(root, "circuit")
            .map(|c| Ok(editing::Sheet::new(tree, c)?.view()))
            .collect::<Result<Vec<_>>>()?;
        let main = tree
            .named(root, "main")
            .next()
            .map(|m| tree.get(m, "name").into_owned())
            .unwrap_or_else(|| circuits[0].name.clone());
        Ok(DocumentView {
            id: self.id.clone(),
            name: self.name.clone(),
            path: self.path.clone(),
            revision: self.revision(),
            palette_identity: self.palette_identity(),
            dirty: self.dirty(),
            can_undo: !self.undo.is_empty(),
            can_redo: !self.redo.is_empty(),
            main,
            circuits,
            libraries: tree
                .named(root, "lib")
                .map(|l| Library {
                    id: tree.get(l, "name").into_owned(),
                    descriptor: tree.get(l, "desc").into_owned(),
                })
                .collect(),
        })
    }
    /// Applies an edit as splices of the stored file, so bytes the edit does
    /// not touch stay as they are. `Replace` keeps the current bytes of every
    /// top-level element (circuit, library, …) whose content it leaves equal.
    /// Returns what changed, for the host's edit result and history title.
    /// The document `edit` would make of this revision, leaving this one as it
    /// is: same id and path, so it loads with the same libraries, and no
    /// history. For checking what an edit does before applying it; applying
    /// the same edit afterwards gives the same revision.
    pub fn preview(&self, expected: &str, circuit: &str, edit: Edit) -> Result<Document> {
        let mut preview = Document {
            id: self.id.clone(),
            path: self.path.clone(),
            name: self.name.clone(),
            source: self.source.clone(),
            saved_digest: self.saved_digest.clone(),
            undo: Vec::new(),
            redo: Vec::new(),
            pending: None,
        };
        preview.edit(expected, circuit, edit)?;
        Ok(preview)
    }
    pub fn edit(&mut self, expected: &str, circuit: &str, edit: Edit) -> Result<EditOutcome> {
        self.check(expected)?;
        let outcome = EditOutcome {
            title: edit_title(&edit, circuit, self),
            circuit: circuit.to_string(),
            ..EditOutcome::default()
        };
        let selecting = matches!(
            edit,
            Edit::Wire { .. }
                | Edit::Place { .. }
                | Edit::Move { .. }
                | Edit::Delete { .. }
                | Edit::Attributes { .. }
                | Edit::Batch { .. }
        );
        let wiring = match &edit {
            Edit::Wire { .. } => true,
            Edit::Batch { edits } => edits.iter().any(|e| matches!(e, Edit::Wire { .. })),
            _ => false,
        };
        let old_wires = if wiring {
            self.circuit_wire_count(circuit)?
        } else {
            0
        };
        let next = match &edit {
            Edit::Replace { xml } => {
                precheck(xml.as_bytes())?;
                let input = Tree::index(xml.clone())?;
                validate(&input)?;
                Some(splice::merge(&self.source.tree, &input)?)
            }
            Edit::Batch { edits } => batch(&self.source.tree, circuit, edits)?,
            edit => editing::apply(&self.source.tree, circuit, edit.clone())?,
        };
        // A file read in another encoding indexes as its UTF-8 text.
        let Some(text) = next.filter(|text| *text != self.source.tree.text()) else {
            return Ok(outcome);
        };
        let previous = self.source.clone();
        let mut outcome = self.change(text.into_bytes(), outcome)?;
        outcome.changed_circuits = changed_circuits(&previous.tree, &self.source.tree);
        if selecting {
            let after = self.circuit_view(circuit)?;
            if wiring {
                let count = after.as_ref().map(|c| c.wires.len()).unwrap_or(0);
                outcome.wires = (old_wires..count).map(|k| format!("w{k}")).collect();
            }
            let items = match edit {
                Edit::Batch { edits } => edits,
                edit => vec![edit],
            };
            for item in items {
                match item {
                    Edit::Place { location, name, .. } => {
                        if let Some(component) = after.as_ref().and_then(|c| {
                            c.components.iter().find(|c| {
                                c.location.x == location.x
                                    && c.location.y == location.y
                                    && c.name == name
                            })
                        }) {
                            outcome.components.push(component.id.clone());
                        }
                    }
                    Edit::Attributes { id, .. } => outcome.components.push(id),
                    Edit::Move { ids, .. } => outcome.components.extend(ids),
                    _ => {}
                }
            }
        }
        Ok(outcome)
    }
    fn circuit_wire_count(&self, circuit: &str) -> Result<usize> {
        let circuit = self
            .circuit_view(circuit)?
            .ok_or_else(|| Error::InvalidCommand("找不到电路".into()))?;
        Ok(circuit.wires.len())
    }
    /// One circuit's view, without building the others.
    pub fn circuit_view(&self, name: &str) -> Result<Option<Circuit>> {
        let tree = &self.source.tree;
        tree.named(tree.root(), "circuit")
            .find(|&c| tree.get(c, "name") == name)
            .map(|c| editing::Sheet::new(tree, c).map(editing::Sheet::view))
            .transpose()
    }
    /// Commits new bytes with `title`, keeping the undo/redo stacks.
    fn change(&mut self, bytes: Vec<u8>, outcome: EditOutcome) -> Result<EditOutcome> {
        if bytes == self.bytes() {
            return Ok(outcome);
        }
        let source = Arc::new(Source::new(bytes)?);
        let previous = std::mem::replace(&mut self.source, source);
        let title = if outcome.title.is_empty() {
            "编辑电路".to_string()
        } else {
            outcome.title.clone()
        };
        if self.pending.is_some() {
            let patch = patch::diff(previous.bytes(), self.bytes());
            self.record(Op::Change {
                title: title.clone(),
                revision: self.source.revision.clone(),
                patch,
            });
        }
        push_undo(
            &mut self.undo,
            Step {
                bytes: previous.bytes().into(),
                title,
            },
        );
        self.redo.clear();
        Ok(outcome)
    }
    fn replace(&mut self, bytes: Vec<u8>) -> Result<()> {
        self.change(bytes, EditOutcome::default()).map(|_| ())
    }
    pub fn undo(&mut self, expected: &str) -> Result<EditOutcome> {
        self.check(expected)?;
        let Some(step) = self.undo.last() else {
            return Ok(EditOutcome::default());
        };
        let source = Arc::new(Source::new(step.bytes.to_vec())?);
        let step = self.undo.pop().expect("checked above");
        let current = std::mem::replace(&mut self.source, source);
        self.redo.push(Step {
            bytes: current.bytes().into(),
            title: step.title.clone(),
        });
        self.record(Op::Undo(self.source.revision.clone()));
        Ok(EditOutcome {
            title: step.title,
            ..EditOutcome::default()
        })
    }
    pub fn redo(&mut self, expected: &str) -> Result<EditOutcome> {
        self.check(expected)?;
        let Some(step) = self.redo.last() else {
            return Ok(EditOutcome::default());
        };
        let source = Arc::new(Source::new(step.bytes.to_vec())?);
        let step = self.redo.pop().expect("checked above");
        let current = std::mem::replace(&mut self.source, source);
        self.undo.push(Step {
            bytes: current.bytes().into(),
            title: step.title.clone(),
        });
        self.record(Op::Redo(self.source.revision.clone()));
        Ok(EditOutcome {
            title: step.title,
            ..EditOutcome::default()
        })
    }
    pub fn save(&mut self, expected: &str, target: Option<&Path>) -> Result<()> {
        self.save_checked(expected, target, None)
    }
    pub fn save_checked(
        &mut self,
        expected: &str,
        target: Option<&Path>,
        target_revision: Option<&str>,
    ) -> Result<()> {
        self.check(expected)?;
        let target = target
            .or(self.path.as_deref())
            .ok_or_else(|| Error::InvalidCommand("请先选择保存位置".into()))?;
        let parent = target.parent().unwrap_or(Path::new("."));
        let parent = parent.canonicalize()?;
        let target = parent.join(
            target
                .file_name()
                .ok_or_else(|| Error::InvalidCommand("无效文件名".into()))?,
        );
        if self.path.as_deref() == Some(target.as_path()) {
            let current = std::fs::read(&target).map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    Error::ExternalChange
                } else {
                    e.into()
                }
            })?;
            if self.saved_digest.as_deref() != Some(digest(&current).as_str()) {
                return Err(Error::ExternalChange);
            }
        } else if target.exists() {
            let current = std::fs::read(&target)?;
            if target_revision != Some(digest(&current).as_str()) {
                return Err(Error::InvalidCommand(
                    "目标文件已存在或已经改变，请重新选择保存位置".into(),
                ));
            }
        }
        if target_revision.is_some() && !target.exists() {
            return Err(Error::ExternalChange);
        }
        // Saving into another directory rewrites relative library paths in
        // the draft and in every undo and redo step.
        let rebased = match self.path.as_ref().and_then(|p| p.parent()) {
            Some(previous) if previous != parent => {
                let bytes = rebase_libraries(self.bytes(), previous, &parent)?;
                let source = if bytes != self.bytes() {
                    Arc::new(Source::new(bytes)?)
                } else {
                    self.source.clone()
                };
                let rebase = |steps: &[Step]| {
                    steps
                        .iter()
                        .map(|step| {
                            Ok(Step {
                                bytes: rebase_libraries(&step.bytes, previous, &parent)?.into(),
                                title: step.title.clone(),
                            })
                        })
                        .collect::<Result<Vec<_>>>()
                };
                Some((source, rebase(&self.undo)?, rebase(&self.redo)?))
            }
            _ => None,
        };
        let bytes = rebased
            .as_ref()
            .map_or(self.bytes(), |(source, _, _)| source.bytes());
        let mut temp = tempfile::NamedTempFile::new_in(&parent)?;
        temp.write_all(bytes)?;
        temp.as_file().sync_all()?;
        if let Ok(meta) = std::fs::metadata(&target) {
            temp.as_file().set_permissions(meta.permissions())?;
        }
        if self.path.as_deref() == Some(target.as_path()) || target_revision.is_some() {
            temp.persist(&target)
                .map_err(|e| Error::Io(e.to_string()))?;
        } else {
            // A competing writer may create the target after the existence check.
            temp.persist_noclobber(&target)
                .map_err(|e| Error::Io(e.to_string()))?;
        }
        if let Some((source, undo, redo)) = rebased {
            self.source = source;
            self.undo = undo;
            self.redo = redo;
            self.pending = None;
        }
        let name = target.file_name().unwrap().to_string_lossy().into_owned();
        if self.path.as_deref() != Some(target.as_path()) || self.name != name {
            self.path = Some(target);
            self.name = name;
            self.record(Op::Location {
                path: self.path.clone(),
                name: self.name.clone(),
            });
        }
        self.saved_digest = Some(self.revision());
        self.record(Op::Saved(self.saved_digest.clone()));
        Ok(())
    }
}

impl Document {
    pub fn relocate(&mut self, from: &Path, to: &Path) {
        if let Some(path) = &self.path
            && let Ok(relative) = path.strip_prefix(from)
        {
            let next = to.join(relative);
            self.name = next
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            self.path = Some(next);
            self.record(Op::Location {
                path: self.path.clone(),
                name: self.name.clone(),
            });
        }
    }
}

impl Document {
    /// Move the selected objects and preserve wires attached to native ports in one undo step.
    pub fn move_connected(
        &mut self,
        expected: &str,
        circuit: &str,
        ids: Vec<String>,
        delta: Point,
        ports: Vec<Point>,
        fixed_ports: Vec<Point>,
    ) -> Result<()> {
        self.check(expected)?;
        let title = format!("移动 {} 个对象", ids.len());
        match editing::move_connected(&self.source.tree, circuit, &ids, delta, ports, &fixed_ports)?
        {
            Some(text) => self
                .change(
                    text.into_bytes(),
                    EditOutcome {
                        title,
                        circuit: circuit.to_string(),
                        ..EditOutcome::default()
                    },
                )
                .map(|_| ()),
            None => Ok(()),
        }
    }
}

/// The circuits whose element differs between two revisions: added and
/// changed ones in file order, then removed ones. A circuit's view depends on
/// its element alone, so equal bytes mean an equal circuit.
fn changed_circuits(before: &Tree, after: &Tree) -> Vec<String> {
    let circuits = |tree: &Tree| -> Vec<(String, usize)> {
        tree.named(tree.root(), "circuit")
            .map(|c| (tree.get(c, "name").into_owned(), c))
            .collect()
    };
    let (old, new) = (circuits(before), circuits(after));
    let sources: HashMap<&str, &str> = old
        .iter()
        .map(|(name, c)| (name.as_str(), before.source(*c)))
        .collect();
    let mut changed: Vec<String> = new
        .iter()
        .filter(|(name, c)| sources.get(name.as_str()) != Some(&after.source(*c)))
        .map(|(name, _)| name.clone())
        .collect();
    for (name, _) in &old {
        if !new.iter().any(|(other, _)| other == name) {
            changed.push(name.clone());
        }
    }
    changed
}

/// The history title for an edit, in the old application's formats.
/// A batch's edits applied in order, each on the text the previous one made;
/// the final text, or None when nothing changed.
fn batch(tree: &Tree, circuit: &str, edits: &[Edit]) -> Result<Option<String>> {
    if edits.is_empty() {
        return Err(Error::InvalidCommand("批量修改是空的".into()));
    }
    let mut current: Option<Tree> = None;
    for edit in edits {
        if !matches!(
            edit,
            Edit::Wire { .. } | Edit::Place { .. } | Edit::Delete { .. } | Edit::Attributes { .. }
        ) {
            return Err(Error::InvalidCommand(
                "批量修改只能包含导线、放置、删除和属性修改".into(),
            ));
        }
        let base = current.as_ref().unwrap_or(tree);
        if let Some(text) = editing::apply(base, circuit, edit.clone())? {
            current = Some(Tree::index(text)?);
        }
    }
    Ok(current.map(|tree| tree.text().to_owned()))
}

fn edit_title(edit: &Edit, circuit: &str, doc: &Document) -> String {
    let short = |value: &str| {
        let mut text: String = value.chars().take(24).collect();
        if value.chars().count() > 24 {
            text.push('\u{2026}');
        }
        text.replace(['\n', '\r'], " ")
    };
    match edit {
        Edit::Wire { points } => match (points.first(), points.last()) {
            (Some(a), Some(b)) => format!("连接导线 ({},{}) \u{2192} ({},{})", a.x, a.y, b.x, b.y),
            _ => "绘制导线".into(),
        },
        Edit::Place { name, .. } => format!("放置 {name}"),
        Edit::Move { ids, .. } => format!("移动 {} 个对象", ids.len()),
        Edit::Delete { ids } => format!("删除 {} 个对象", ids.len()),
        Edit::Attributes { id, values } => {
            let label = doc
                .circuit_component(circuit, id)
                .map(|c| {
                    c.attributes
                        .get("label")
                        .filter(|l| !l.is_empty())
                        .cloned()
                        .unwrap_or_else(|| c.name.clone())
                })
                .unwrap_or_else(|| id.clone());
            let parts: Vec<String> = values
                .iter()
                .map(|(name, value)| format!("{} \u{2192} {}", name, short(value)))
                .collect();
            format!("{} \u{b7} {}", label, parts.join("\u{3001}"))
        }
        Edit::Replace { .. } => "替换电路内容".into(),
        Edit::Batch { edits } => match edits.as_slice() {
            [one] => edit_title(one, circuit, doc),
            all if all.iter().all(|e| matches!(e, Edit::Place { .. })) => {
                format!("放置 {} 个元件", all.len())
            }
            all if all.iter().all(|e| matches!(e, Edit::Wire { .. })) => {
                format!("绘制 {} 条导线", all.len())
            }
            all if all.iter().all(|e| matches!(e, Edit::Attributes { .. })) => {
                format!("修改 {} 个元件的属性", all.len())
            }
            all => format!("{} 处修改", all.len()),
        },
        Edit::AddCircuit { .. } => "添加电路".into(),
        Edit::RenameCircuit { .. } => "重命名电路".into(),
        Edit::DeleteCircuit => "删除电路".into(),
        Edit::SetMain => "设置主电路".into(),
    }
}

impl Document {
    fn circuit_component(&self, circuit: &str, id: &str) -> Option<Component> {
        self.circuit_view(circuit)
            .ok()??
            .components
            .into_iter()
            .find(|c| c.id == id)
    }
}
