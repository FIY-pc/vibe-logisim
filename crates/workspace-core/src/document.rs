use crate::{Error, Result, digest};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
};
use xmltree::{Element, EmitterConfig, XMLNode};

pub const EMPTY_CIRCUIT: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<project source="2.7.1" version="1.0">
  <lib desc="#Wiring" name="0"/><lib desc="#Gates" name="1"/>
  <lib desc="#Plexers" name="2"/><lib desc="#Arithmetic" name="3"/>
  <lib desc="#Memory" name="4"/><lib desc="#I/O" name="5"/>
  <main name="main"/><options/><mappings/><toolbar/>
  <circuit name="main"><a name="circuit" val="main"/></circuit>
</project>"##;
const MAX_BYTES: usize = 32 * 1024 * 1024;

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS, schemars::JsonSchema,
)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}
impl Point {
    fn parse(s: &str) -> Result<Self> {
        let Some((x, y)) = s.trim_matches(['(', ')']).split_once(',') else {
            return Err(Error::InvalidDocument(format!("无效坐标: {s}")));
        };
        let x = x
            .trim()
            .parse()
            .map_err(|_| Error::InvalidDocument("无效横坐标".into()))?;
        let y = y
            .trim()
            .parse()
            .map_err(|_| Error::InvalidDocument("无效纵坐标".into()))?;
        Ok(Self { x, y })
    }
    fn xml(self) -> String {
        format!("({},{})", self.x, self.y)
    }
    fn translated(self, delta: Point) -> Result<Self> {
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

#[derive(Clone)]
pub struct Document {
    pub id: String,
    pub path: Option<PathBuf>,
    name: String,
    bytes: Vec<u8>,
    root: Element,
    saved_digest: Option<String>,
    undo: Vec<Vec<u8>>,
    redo: Vec<Vec<u8>>,
}
fn children<'a>(node: &'a Element, tag: &'a str) -> impl Iterator<Item = &'a Element> {
    node.children
        .iter()
        .filter_map(XMLNode::as_element)
        .filter(move |n| n.name == tag)
}
fn attr<'a>(node: &'a Element, key: &str) -> &'a str {
    node.attributes.get(key).map(String::as_str).unwrap_or("")
}
fn set_attr(node: &mut Element, name: &str, val: &str) {
    node.attributes.insert(name.into(), val.into());
}
fn element(name: &str, attrs: &[(&str, String)]) -> Element {
    let mut e = Element::new(name);
    for (k, v) in attrs {
        set_attr(&mut e, k, v);
    }
    e
}
fn property(name: String, value: String) -> Element {
    let mut a = element("a", &[("name", name)]);
    if value.contains('\n') || value.contains('\r') {
        a.children.push(XMLNode::Text(value));
    } else {
        set_attr(&mut a, "val", &value);
    }
    a
}
fn parse(bytes: &[u8]) -> Result<Element> {
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
    let root = Element::parse(bytes).map_err(|e| Error::InvalidDocument(e.to_string()))?;
    if root.name != "project" {
        return Err(Error::InvalidDocument("请选择 Logisim .circ 文件".into()));
    }
    let mut names = std::collections::HashSet::new();
    for c in children(&root, "circuit") {
        let name = attr(c, "name");
        if name.is_empty() || !names.insert(name.to_string()) {
            return Err(Error::InvalidDocument("电路名称为空或重复".into()));
        }
        for c in children(c, "comp") {
            Point::parse(attr(c, "loc"))?;
        }
        for w in children(c, "wire") {
            Point::parse(attr(w, "from"))?;
            Point::parse(attr(w, "to"))?;
        }
    }
    if names.is_empty() {
        return Err(Error::InvalidDocument("文件没有电路".into()));
    }
    if let Some(main) = root.get_child("main")
        && !names.contains(attr(main, "name"))
    {
        return Err(Error::InvalidDocument("主电路不存在".into()));
    }
    Ok(root)
}
fn serialize(root: &Element) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    root.write_with_config(&mut out, EmitterConfig::new().perform_indent(true))
        .map_err(|e| Error::InvalidDocument(e.to_string()))?;
    Ok(out)
}

// Keep relative library references meaningful when Save As changes the source
// directory. History uses the same base so undo cannot resurrect broken paths.
fn rebase_libraries(bytes: &[u8], from: &Path, to: &Path) -> Result<Vec<u8>> {
    if from == to {
        return Ok(bytes.to_vec());
    }
    let mut root = parse(bytes)?;
    let mut changed = false;
    for node in &mut root.children {
        let Some(lib) = node.as_mut_element().filter(|e| e.name == "lib") else {
            continue;
        };
        let Some(desc) = lib.attributes.get_mut("desc") else {
            continue;
        };
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
                *desc = format!("{prefix}{}{suffix}", next.display());
                changed = true;
            }
            break;
        }
    }
    if changed {
        serialize(&root)
    } else {
        Ok(bytes.to_vec())
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
        let root = parse(&bytes)?;
        let saved_digest = saved.then(|| digest(&bytes));
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            path,
            name,
            bytes,
            root,
            saved_digest,
            undo: Vec::new(),
            redo: Vec::new(),
        })
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn legacy_versions(&self) -> Vec<Vec<u8>> {
        self.undo
            .iter()
            .chain(std::iter::once(&self.bytes))
            .chain(self.redo.iter().rev())
            .cloned()
            .collect()
    }
    pub fn saved_revision(&self) -> Option<&str> {
        self.saved_digest.as_deref()
    }
    pub fn bytes_at_path(&self, path: Option<&Path>) -> Result<Vec<u8>> {
        match (
            self.path.as_deref().and_then(Path::parent),
            path.and_then(Path::parent),
        ) {
            (Some(from), Some(to)) => rebase_libraries(&self.bytes, from, to),
            _ => Ok(self.bytes.clone()),
        }
    }
    pub fn revision(&self) -> String {
        digest(&self.bytes)
    }
    pub fn dirty(&self) -> bool {
        self.saved_digest.as_deref() != Some(self.revision().as_str())
    }
    pub fn check(&self, expected: &str) -> Result<()> {
        if self.revision() != expected {
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
        let circuits = children(&self.root, "circuit")
            .map(|c| {
                let mut components = Vec::new();
                let mut wires = Vec::new();
                for (i, node) in c.children.iter().enumerate() {
                    if let Some(e) = node.as_element() {
                        match e.name.as_str() {
                            "comp" => components.push(Component {
                                id: format!("c{i}"),
                                name: attr(e, "name").into(),
                                library: e.attributes.get("lib").cloned(),
                                location: Point::parse(attr(e, "loc"))?,
                                attributes: children(e, "a")
                                    .map(|a| {
                                        (
                                            attr(a, "name").to_string(),
                                            a.attributes.get("val").cloned().unwrap_or_else(|| {
                                                a.get_text().unwrap_or_default().into_owned()
                                            }),
                                        )
                                    })
                                    .collect(),
                            }),
                            "wire" => wires.push(Wire {
                                id: format!("w{i}"),
                                from: Point::parse(attr(e, "from"))?,
                                to: Point::parse(attr(e, "to"))?,
                            }),
                            _ => {}
                        }
                    }
                }
                Ok(Circuit {
                    name: attr(c, "name").into(),
                    components,
                    wires,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let main = self
            .root
            .get_child("main")
            .map(|m| attr(m, "name").to_string())
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
            libraries: children(&self.root, "lib")
                .map(|l| Library {
                    id: attr(l, "name").into(),
                    descriptor: attr(l, "desc").into(),
                })
                .collect(),
        })
    }
    pub fn edit(&mut self, expected: &str, circuit: &str, edit: Edit) -> Result<()> {
        self.check(expected)?;
        if let Edit::Replace { xml } = edit {
            return self.replace(xml.into_bytes());
        }
        let mut root = self.root.clone();
        let index = root
            .children
            .iter()
            .position(|n| {
                n.as_element()
                    .is_some_and(|e| e.name == "circuit" && attr(e, "name") == circuit)
            })
            .ok_or_else(|| Error::InvalidCommand("找不到电路".into()))?;
        match edit {
            Edit::AddCircuit { name } => {
                Self::check_name(&root, &name)?;
                root.children
                    .push(XMLNode::Element(element("circuit", &[("name", name)])));
            }
            Edit::RenameCircuit { name } => {
                Self::check_name(&root, &name)?;
                for child in &mut root.children {
                    if let Some(e) = child.as_mut_element() {
                        if e.name == "main" && attr(e, "name") == circuit {
                            set_attr(e, "name", &name)
                        }
                        if e.name == "circuit" {
                            if attr(e, "name") == circuit {
                                set_attr(e, "name", &name);
                            }
                            for n in &mut e.children {
                                if let Some(c) = n.as_mut_element() {
                                    if c.name == "comp"
                                        && !c.attributes.contains_key("lib")
                                        && attr(c, "name") == circuit
                                    {
                                        set_attr(c, "name", &name)
                                    }
                                    if c.name == "a"
                                        && attr(c, "name") == "circuit"
                                        && attr(c, "val") == circuit
                                    {
                                        set_attr(c, "val", &name)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Edit::DeleteCircuit => {
                if children(&root, "circuit").count() == 1 {
                    return Err(Error::InvalidCommand("至少保留一个电路".into()));
                }
                if children(&root, "circuit").any(|c| {
                    children(c, "comp")
                        .any(|x| !x.attributes.contains_key("lib") && attr(x, "name") == circuit)
                }) {
                    return Err(Error::InvalidCommand("其他电路仍在使用这个子电路".into()));
                }
                root.children.remove(index);
                let next = attr(children(&root, "circuit").next().unwrap(), "name").to_string();
                if let Some(main) = root.get_mut_child("main")
                    && attr(main, "name") == circuit
                {
                    set_attr(main, "name", &next)
                }
            }
            Edit::SetMain => {
                if let Some(main) = root.get_mut_child("main") {
                    set_attr(main, "name", circuit)
                } else {
                    root.children.push(XMLNode::Element(element(
                        "main",
                        &[("name", circuit.into())],
                    )))
                }
            }
            other => {
                let c = root.children[index].as_mut_element().unwrap();
                match other {
                    Edit::Wire { points } => {
                        if points.len() < 2 || points.len() > 4096 {
                            return Err(Error::InvalidCommand("导线需要 2–4096 个点".into()));
                        }
                        for pair in points.windows(2) {
                            let (a, b) = (pair[0], pair[1]);
                            if a == b {
                                continue;
                            }
                            if a.x != b.x && a.y != b.y {
                                return Err(Error::InvalidCommand("导线必须水平或垂直".into()));
                            }
                            c.children.push(XMLNode::Element(element(
                                "wire",
                                &[("from", a.xml()), ("to", b.xml())],
                            )))
                        }
                    }
                    Edit::Place {
                        name,
                        library,
                        location,
                        attributes,
                    } => {
                        let mut item = element("comp", &[("name", name), ("loc", location.xml())]);
                        if let Some(lib) = library {
                            set_attr(&mut item, "lib", &lib)
                        }
                        for (k, v) in attributes {
                            item.children.push(XMLNode::Element(property(k, v)))
                        }
                        c.children.push(XMLNode::Element(item));
                    }
                    Edit::Move { ids, delta } => {
                        let indices = Self::indices(c, &ids)?;
                        for i in indices {
                            let item = c.children[i].as_mut_element().unwrap();
                            for key in if item.name == "comp" {
                                vec!["loc"]
                            } else {
                                vec!["from", "to"]
                            } {
                                let p = Point::parse(attr(item, key))?.translated(delta)?;
                                set_attr(item, key, &p.xml());
                            }
                        }
                    }
                    Edit::Delete { ids } => {
                        let indices = Self::indices(c, &ids)?;
                        for i in indices.into_iter().rev() {
                            c.children.remove(i);
                        }
                    }
                    Edit::Attributes { id, values } => {
                        let indices = Self::indices(c, &[id])?;
                        let item = c.children[indices[0]].as_mut_element().unwrap();
                        if item.name != "comp" {
                            return Err(Error::InvalidCommand("请选择元件".into()));
                        }
                        for (k, v) in values {
                            if let Some(a) = item
                                .children
                                .iter_mut()
                                .filter_map(XMLNode::as_mut_element)
                                .find(|e| e.name == "a" && attr(e, "name") == k)
                            {
                                *a = property(k, v);
                            } else {
                                item.children.push(XMLNode::Element(property(k, v)))
                            }
                        }
                    }
                    _ => unreachable!(),
                }
            }
        }
        self.replace(serialize(&root)?)
    }
    fn check_name(root: &Element, name: &str) -> Result<()> {
        if name.trim().is_empty() || children(root, "circuit").any(|c| attr(c, "name") == name) {
            Err(Error::InvalidCommand("电路名称为空或已存在".into()))
        } else {
            Ok(())
        }
    }
    fn indices(c: &Element, ids: &[String]) -> Result<Vec<usize>> {
        let mut result = Vec::new();
        for id in ids {
            let index = id
                .get(1..)
                .and_then(|s| s.parse::<usize>().ok())
                .ok_or_else(|| Error::InvalidCommand("对象已失效".into()))?;
            let item = c
                .children
                .get(index)
                .and_then(XMLNode::as_element)
                .ok_or_else(|| Error::InvalidCommand("对象已失效".into()))?;
            if !((id.starts_with('c') && item.name == "comp")
                || (id.starts_with('w') && item.name == "wire"))
            {
                return Err(Error::InvalidCommand("对象已失效".into()));
            }
            result.push(index);
        }
        result.sort_unstable();
        result.dedup();
        Ok(result)
    }
    fn replace(&mut self, bytes: Vec<u8>) -> Result<()> {
        let root = parse(&bytes)?;
        if bytes == self.bytes {
            return Ok(());
        }
        self.undo.push(self.bytes.clone());
        while self.undo.len() > 100
            || (self.undo.len() > 1
                && self.undo.iter().map(Vec::len).sum::<usize>() > 64 * 1024 * 1024)
        {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.bytes = bytes;
        self.root = root;
        Ok(())
    }
    pub fn undo(&mut self, expected: &str) -> Result<()> {
        self.check(expected)?;
        if let Some(bytes) = self.undo.pop() {
            self.root = parse(&bytes)?;
            self.redo.push(std::mem::replace(&mut self.bytes, bytes));
        }
        Ok(())
    }
    pub fn redo(&mut self, expected: &str) -> Result<()> {
        self.check(expected)?;
        if let Some(bytes) = self.redo.pop() {
            self.root = parse(&bytes)?;
            self.undo.push(std::mem::replace(&mut self.bytes, bytes));
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
            next.bytes = rebase_libraries(&self.bytes, previous, &parent)?;
            next.root = parse(&next.bytes)?;
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
        temp.write_all(&next.bytes)?;
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
            xml: String::from_utf8_lossy(&self.bytes).into_owned(),
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
        mut ports: Vec<Point>,
        fixed_ports: Vec<Point>,
    ) -> Result<()> {
        self.check(expected)?;
        let graph = self
            .view()?
            .circuits
            .into_iter()
            .find(|c| c.name == circuit)
            .ok_or_else(|| Error::InvalidCommand("找不到电路".into()))?;
        let on_wire = |p: Point, w: &Wire| {
            (w.from.x == w.to.x
                && p.x == w.from.x
                && p.y >= w.from.y.min(w.to.y)
                && p.y <= w.from.y.max(w.to.y))
                || (w.from.y == w.to.y
                    && p.y == w.from.y
                    && p.x >= w.from.x.min(w.to.x)
                    && p.x <= w.from.x.max(w.to.x))
        };
        // Selected wires are part of the moving selection, including contacts along their length.
        for wire in graph.wires.iter().filter(|w| ids.contains(&w.id)) {
            ports.extend([wire.from, wire.to]);
            ports.extend(fixed_ports.iter().copied().filter(|p| on_wire(*p, wire)));
            for other in graph.wires.iter().filter(|w| !ids.contains(&w.id)) {
                ports.extend(
                    [other.from, other.to]
                        .into_iter()
                        .filter(|p| on_wire(*p, wire)),
                );
            }
        }
        ports.sort_by_key(|p| (p.x, p.y));
        ports.dedup();
        let anchored: Vec<Point> = ports
            .iter()
            .copied()
            .filter(|p| {
                fixed_ports.contains(p)
                    || graph.wires.iter().any(|w| {
                        !ids.contains(&w.id)
                            && on_wire(*p, w)
                            && ((*p != w.from && *p != w.to)
                                || graph
                                    .wires
                                    .iter()
                                    .filter(|other| !ids.contains(&other.id) && other.id != w.id)
                                    .any(|other| {
                                        [other.from, other.to]
                                            .into_iter()
                                            .any(|q| q != w.from && q != w.to && on_wire(q, w))
                                    })
                                || fixed_ports
                                    .iter()
                                    .any(|q| *q != w.from && *q != w.to && on_wire(*q, w)))
                    })
            })
            .collect();
        let mut next = self.clone();
        next.edit(
            expected,
            circuit,
            Edit::Move {
                ids: ids.clone(),
                delta,
            },
        )?;
        let c = next
            .root
            .children
            .iter_mut()
            .filter_map(XMLNode::as_mut_element)
            .find(|c| c.name == "circuit" && attr(c, "name") == circuit)
            .unwrap();
        let mut extra = Vec::new();
        for wire in graph.wires.iter().filter(|w| !ids.contains(&w.id)) {
            let from = if ports.contains(&wire.from) && !anchored.contains(&wire.from) {
                wire.from.translated(delta)?
            } else {
                wire.from
            };
            let to = if ports.contains(&wire.to) && !anchored.contains(&wire.to) {
                wire.to.translated(delta)?
            } else {
                wire.to
            };
            if from == wire.from && to == wire.to {
                continue;
            }
            let i = Self::indices(c, std::slice::from_ref(&wire.id))?[0];
            let item = c.children[i].as_mut_element().unwrap();
            // Keep the fixed end and original approach direction. Add one elbow when needed.
            let corner = if wire.from.x == wire.to.x {
                Point { x: from.x, y: to.y }
            } else {
                Point { x: to.x, y: from.y }
            };
            set_attr(item, "from", &from.xml());
            set_attr(item, "to", &corner.xml());
            if corner != to {
                extra.push(XMLNode::Element(element(
                    "wire",
                    &[("from", corner.xml()), ("to", to.xml())],
                )))
            }
        }
        // Keep shared ports and stationary junctions at their original position.
        for port in anchored {
            let to = port.translated(delta)?;
            let corner = Point { x: to.x, y: port.y };
            for (a, b) in [(port, corner), (corner, to)] {
                if a != b {
                    extra.push(XMLNode::Element(element(
                        "wire",
                        &[("from", a.xml()), ("to", b.xml())],
                    )))
                }
            }
        }
        c.children.extend(extra);
        c.children.retain(|n| {
            !n.as_element()
                .is_some_and(|e| e.name == "wire" && attr(e, "from") == attr(e, "to"))
        });
        next.bytes = serialize(&next.root)?;
        *self = next;
        Ok(())
    }
}
