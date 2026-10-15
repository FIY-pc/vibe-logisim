use crate::{
    Error, Result, digest, editing,
    splice::{self, Splices, Tree},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
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
}

/// One revision of a circuit file: its bytes and their span index.
struct Source {
    tree: Tree,
    /// The stored bytes when they are not the index's UTF-8 text.
    encoded: Option<Vec<u8>>,
    revision: String,
}
impl Source {
    fn new(bytes: Vec<u8>) -> Result<Self> {
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
    fn bytes(&self) -> &[u8] {
        self.encoded
            .as_deref()
            .unwrap_or(self.tree.text().as_bytes())
    }
}

#[derive(Clone)]
pub struct Document {
    pub id: String,
    pub path: Option<PathBuf>,
    name: String,
    source: Arc<Source>,
    saved_digest: Option<String>,
    undo: Vec<Vec<u8>>,
    redo: Vec<Vec<u8>>,
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

// Keep relative library references meaningful when Save As changes the source
// directory. History uses the same base so undo cannot resurrect broken paths.
// Only the affected `desc` values change.
fn rebase_libraries(bytes: &[u8], from: &Path, to: &Path) -> Result<Vec<u8>> {
    if from == to {
        return Ok(bytes.to_vec());
    }
    let source = Source::new(bytes.to_vec())?;
    let tree = &source.tree;
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
                let absolute = from.join(file);
                let base: Vec<_> = to.components().collect();
                let target: Vec<_> = absolute.components().collect();
                let common = base.iter().zip(&target).take_while(|(a, b)| a == b).count();
                let next = if common == 0 {
                    absolute
                } else {
                    let mut relative = PathBuf::new();
                    for _ in common..base.len() {
                        relative.push("..");
                    }
                    for part in &target[common..] {
                        relative.push(part.as_os_str());
                    }
                    relative
                };
                out.set(lib, "desc", &format!("{prefix}{}{suffix}", next.display()));
            }
            break;
        }
    }
    if out.is_empty() {
        Ok(bytes.to_vec())
    } else {
        Ok(out.finish()?.into_bytes())
    }
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
        })
    }
    pub fn bytes(&self) -> &[u8] {
        self.source.bytes()
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
    pub fn edit(&mut self, expected: &str, circuit: &str, edit: Edit) -> Result<()> {
        self.check(expected)?;
        let next = match edit {
            Edit::Replace { xml } => {
                precheck(xml.as_bytes())?;
                let input = Tree::index(xml)?;
                validate(&input)?;
                Some(splice::merge(&self.source.tree, &input)?)
            }
            edit => editing::apply(&self.source.tree, circuit, edit)?,
        };
        match next {
            // A file read in another encoding indexes as its UTF-8 text.
            Some(text) if text != self.source.tree.text() => self.replace(text.into_bytes()),
            _ => Ok(()),
        }
    }
    fn replace(&mut self, bytes: Vec<u8>) -> Result<()> {
        if bytes == self.bytes() {
            return Ok(());
        }
        let source = Arc::new(Source::new(bytes)?);
        let previous = std::mem::replace(&mut self.source, source);
        self.undo.push(previous.bytes().to_vec());
        while self.undo.len() > 100
            || (self.undo.len() > 1
                && self.undo.iter().map(Vec::len).sum::<usize>() > 64 * 1024 * 1024)
        {
            self.undo.remove(0);
        }
        self.redo.clear();
        Ok(())
    }
    pub fn undo(&mut self, expected: &str) -> Result<()> {
        self.check(expected)?;
        if let Some(bytes) = self.undo.last() {
            let source = Arc::new(Source::new(bytes.clone())?);
            self.undo.pop();
            let current = std::mem::replace(&mut self.source, source);
            self.redo.push(current.bytes().to_vec());
        }
        Ok(())
    }
    pub fn redo(&mut self, expected: &str) -> Result<()> {
        self.check(expected)?;
        if let Some(bytes) = self.redo.last() {
            let source = Arc::new(Source::new(bytes.clone())?);
            self.redo.pop();
            let current = std::mem::replace(&mut self.source, source);
            self.undo.push(current.bytes().to_vec());
        }
        Ok(())
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
        let mut next = self.clone();
        if let Some(previous) = self.path.as_ref().and_then(|p| p.parent()) {
            let bytes = rebase_libraries(self.bytes(), previous, &parent)?;
            if bytes != self.bytes() {
                next.source = Arc::new(Source::new(bytes)?);
            }
            next.undo = self
                .undo
                .iter()
                .map(|b| rebase_libraries(b, previous, &parent))
                .collect::<Result<_>>()?;
            next.redo = self
                .redo
                .iter()
                .map(|b| rebase_libraries(b, previous, &parent))
                .collect::<Result<_>>()?;
        }
        let mut temp = tempfile::NamedTempFile::new_in(&parent)?;
        temp.write_all(next.bytes())?;
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
        next.path = Some(target.clone());
        next.name = target.file_name().unwrap().to_string_lossy().into_owned();
        next.saved_digest = Some(next.revision());
        *self = next;
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    id: String,
    path: Option<PathBuf>,
    name: String,
    xml: String,
    saved_digest: Option<String>,
    undo: Vec<String>,
    redo: Vec<String>,
}
impl Document {
    pub fn recovery(&self) -> Recovery {
        Recovery {
            id: self.id.clone(),
            path: self.path.clone(),
            name: self.name.clone(),
            xml: String::from_utf8_lossy(self.bytes()).into_owned(),
            saved_digest: self.saved_digest.clone(),
            undo: self
                .undo
                .iter()
                .map(|b| String::from_utf8_lossy(b).into_owned())
                .collect(),
            redo: self
                .redo
                .iter()
                .map(|b| String::from_utf8_lossy(b).into_owned())
                .collect(),
        }
    }
    pub fn restore(saved: Recovery) -> Result<Self> {
        let mut d = Self::from_bytes(saved.name, saved.path, saved.xml.into_bytes(), false)?;
        d.id = saved.id;
        d.saved_digest = saved.saved_digest;
        d.undo = saved.undo.into_iter().map(String::into_bytes).collect();
        d.redo = saved.redo.into_iter().map(String::into_bytes).collect();
        Ok(d)
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
        match editing::move_connected(&self.source.tree, circuit, &ids, delta, ports, &fixed_ports)?
        {
            Some(text) => self.replace(text.into_bytes()),
            None => Ok(()),
        }
    }
}
