//! A revision of a document that the native side is sent: what the worker
//! needs to keep its loaded project current without a file, and the
//! per-circuit difference between two revisions.

use crate::{Point, Result, Source, Wire, editing::Sheet, splice::Tree};
use std::{path::Path, sync::Arc};

/// One circuit's ids: component ids in file order, wire ends in file order
/// (wire `k` is `w<k>`).
#[derive(Clone, Debug)]
pub struct CircuitIds {
    pub name: String,
    pub components: Vec<String>,
    pub wires: Vec<Wire>,
}

/// One circuit's part of the change between two revisions.
///
/// A component keeps its id while its anchor is free, so a part that moved
/// appears as removed and added. Wires are matched by their ends: `wires` is
/// the whole wire list after the change, in file order, and the worker makes
/// its wires these — which also keeps Logisim's load-time splitting of a wire
/// at a junction in step with the file.
#[derive(Clone, Debug)]
pub struct CircuitChange {
    pub name: String,
    /// Components the circuit has and the other revision does not.
    pub removed: Vec<String>,
    /// Components the other revision has and the circuit does not: id and the
    /// `<comp>` element's text.
    pub added: Vec<(String, String)>,
    pub wires: Vec<Wire>,
}

/// The wires a move takes out and the segments it adds, in file order (the
/// added ones go after the circuit's last wire).
#[derive(Clone, Debug, Default)]
pub struct WireEdit {
    pub removed: Vec<String>,
    pub added: Vec<(Point, Point)>,
}

/// One revision of a document: its id, name, directory and bytes, shareable
/// with the native side so it can hold and compare revisions.
#[derive(Clone)]
pub struct Revision {
    id: String,
    name: String,
    directory: Option<std::path::PathBuf>,
    source: Arc<Source>,
}

impl Revision {
    pub(crate) fn new(id: &str, name: &str, path: Option<&Path>, source: &Arc<Source>) -> Self {
        Self {
            id: id.to_owned(),
            name: name.to_owned(),
            directory: path.and_then(Path::parent).map(Path::to_path_buf),
            source: source.clone(),
        }
    }
    pub fn document(&self) -> &str {
        &self.id
    }
    pub fn revision(&self) -> &str {
        &self.source.revision
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    /// Where the document's file lives; relative library references resolve
    /// against it. None for a document that has no file yet.
    pub fn directory(&self) -> Option<&Path> {
        self.directory.as_deref()
    }
    pub fn bytes(&self) -> &[u8] {
        self.source.bytes()
    }
    /// The `desc` of every `<lib>`, in file order.
    pub fn library_descriptors(&self) -> Vec<String> {
        let tree = &self.source.tree;
        tree.named(tree.root(), "lib")
            .map(|lib| tree.get(lib, "desc").into_owned())
            .collect()
    }
    /// The `source` attribute of the project element (the file's Logisim version).
    pub fn source_version(&self) -> Option<String> {
        let tree = &self.source.tree;
        tree.attr(tree.root(), "source")
            .map(|v| v.into_owned())
            .filter(|v| !v.is_empty())
    }
    /// Every circuit's ids, in file order.
    pub fn circuits(&self) -> Result<Vec<CircuitIds>> {
        let tree = &self.source.tree;
        tree.named(tree.root(), "circuit")
            .map(|c| ids(tree, c))
            .collect()
    }
    pub fn circuit(&self, name: &str) -> Result<Option<CircuitIds>> {
        let tree = &self.source.tree;
        tree.named(tree.root(), "circuit")
            .find(|&c| tree.get(c, "name") == name)
            .map(|c| ids(tree, c))
            .transpose()
    }
    /// What changed between this revision and `next`, per circuit; None when
    /// the two cannot be applied to one loaded project in place.
    ///
    /// In place means everything outside a circuit's components and wires is
    /// equal (the project element, the library list, every other top-level
    /// element, the circuit list, order and names, and each changed circuit's
    /// attributes and appearance). A new or gone circuit, or a changed
    /// attribute set or appearance, loads whole instead: Logisim reads those
    /// once, when a circuit is created.
    pub fn changes(&self, next: &Revision) -> Option<Vec<CircuitChange>> {
        let (before, after) = (&self.source.tree, &next.source.tree);
        let (a, b) = (before.root(), after.root());
        if before.tag(a) != after.tag(b) || before.open_tag(a) != after.open_tag(b) {
            return None;
        }
        let (old, new) = (before.children(a), after.children(b));
        if old.len() != new.len() {
            return None;
        }
        let mut changes = Vec::new();
        for (&x, &y) in old.iter().zip(new) {
            if before.tag(x) != after.tag(y) {
                return None;
            }
            if before.source(x) == after.source(y) {
                continue;
            }
            if before.tag(x) != "circuit" {
                return None;
            }
            changes.push(circuit_change(before, after, x, y)?);
        }
        Some(changes)
    }
}

fn circuit_change(before: &Tree, after: &Tree, x: usize, y: usize) -> Option<CircuitChange> {
    let name = after.get(y, "name").into_owned();
    if before.get(x, "name") != name || before.open_tag(x) != after.open_tag(y) {
        return None;
    }
    // Everything that is not a component or a wire is read when the circuit
    // is created and has to be equal.
    let other = |tree: &Tree, node: usize| -> Vec<usize> {
        tree.children(node)
            .iter()
            .copied()
            .filter(|&child| !matches!(tree.tag(child), "comp" | "wire"))
            .collect()
    };
    let (old_other, new_other) = (other(before, x), other(after, y));
    if old_other.len() != new_other.len() {
        return None;
    }
    for (&o, &n) in old_other.iter().zip(&new_other) {
        if before.tag(o) != after.tag(n) || before.source(o) != after.source(n) {
            return None;
        }
    }
    let old_sheet = Sheet::new(before, x).ok()?;
    let new_sheet = Sheet::new(after, y).ok()?;
    let old: Vec<(usize, &str)> = old_sheet.components().collect();
    let new: Vec<(usize, &str)> = new_sheet.components().collect();
    // A component stays when the same id is still in the circuit with the
    // same element text; anything else is removed and put back by id, which
    // is also how a changed attribute set reaches the loaded circuit.
    let mut removed = Vec::new();
    for &(node, id) in &old {
        let stays = new
            .iter()
            .any(|&(other, other_id)| other_id == id && before.source(node) == after.source(other));
        if !stays {
            removed.push(id.to_owned());
        }
    }
    let added: Vec<(String, String)> = new
        .iter()
        .filter(|&&(node, id)| {
            !old.iter().any(|&(other, other_id)| {
                other_id == id && before.source(other) == after.source(node)
            })
        })
        .map(|&(node, id)| (id.to_owned(), after.source(node).to_owned()))
        .collect();
    Some(CircuitChange {
        name,
        removed,
        added,
        wires: new_sheet
            .segments()
            .enumerate()
            .map(|(k, (from, to))| Wire {
                id: format!("w{k}"),
                from,
                to,
            })
            .collect(),
    })
}

fn ids(tree: &Tree, node: usize) -> Result<CircuitIds> {
    let sheet = Sheet::new(tree, node)?;
    Ok(CircuitIds {
        name: tree.get(node, "name").into_owned(),
        components: sheet.components().map(|(_, id)| id.to_owned()).collect(),
        wires: sheet
            .segments()
            .enumerate()
            .map(|(k, (from, to))| Wire {
                id: format!("w{k}"),
                from,
                to,
            })
            .collect(),
    })
}
