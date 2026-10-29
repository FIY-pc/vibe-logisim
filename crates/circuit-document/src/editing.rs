//! Edits of one circuit, written as splices of the stored file, and the ids
//! the document view gives the circuit's objects.

use crate::{
    Circuit, Component, Edit, Error, Point, Result, Wire,
    junction::Segment,
    splice::{Element, Splices, Tree},
};
use std::{
    borrow::Cow,
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
};

fn stale() -> Error {
    Error::InvalidCommand("对象已失效".into())
}

pub(crate) struct Comp {
    pub(crate) node: usize,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) library: Option<String>,
    pub(crate) location: Point,
}

pub(crate) struct Line {
    pub(crate) node: usize,
    pub(crate) segment: Segment,
}

/// One circuit's components and wires, in file order.
pub(crate) struct Sheet<'t> {
    tree: &'t Tree,
    node: usize,
    comps: Vec<Comp>,
    wires: Vec<Line>,
    /// Names of the libraries that provide Logisim's wiring components.
    wiring: HashSet<String>,
}

impl<'t> Sheet<'t> {
    pub(crate) fn new(tree: &'t Tree, node: usize) -> Result<Self> {
        let (mut comps, mut wires) = (Vec::new(), Vec::new());
        for &child in tree.children(node) {
            match tree.tag(child) {
                "comp" => comps.push(Comp {
                    node: child,
                    id: String::new(),
                    name: tree.get(child, "name").into_owned(),
                    library: tree.attr(child, "lib").map(Cow::into_owned),
                    location: Point::parse(&tree.get(child, "loc"))?,
                }),
                "wire" => wires.push(Line {
                    node: child,
                    segment: Segment {
                        from: Point::parse(&tree.get(child, "from"))?,
                        to: Point::parse(&tree.get(child, "to"))?,
                    },
                }),
                _ => {}
            }
        }
        anchor(tree, &mut comps);
        let wiring = tree
            .named(tree.root(), "lib")
            .filter(|&lib| tree.get(lib, "desc") == "#Wiring")
            .map(|lib| tree.get(lib, "name").into_owned())
            .collect();
        Ok(Self {
            tree,
            node,
            comps,
            wires,
            wiring,
        })
    }

    /// The components' element and id, in file order.
    pub(crate) fn components(&self) -> impl Iterator<Item = (usize, &str)> {
        self.comps.iter().map(|c| (c.node, c.id.as_str()))
    }

    /// The wires' ends, in file order.
    pub(crate) fn segments(&self) -> impl Iterator<Item = (Point, Point)> {
        self.wires.iter().map(|w| (w.segment.from, w.segment.to))
    }

    pub(crate) fn view(self) -> Circuit {
        let tree = self.tree;
        Circuit {
            name: tree.get(self.node, "name").into_owned(),
            components: self
                .comps
                .into_iter()
                .map(|c| Component {
                    // Logisim reads the last `<a>` of a name.
                    attributes: tree
                        .named(c.node, "a")
                        .map(|a| (tree.get(a, "name").into_owned(), tree.property(a)))
                        .collect(),
                    id: c.id,
                    name: c.name,
                    library: c.library,
                    location: c.location,
                })
                .collect(),
            wires: self
                .wires
                .iter()
                .enumerate()
                .map(|(k, w)| Wire {
                    id: format!("w{k}"),
                    from: w.segment.from,
                    to: w.segment.to,
                })
                .collect(),
        }
    }

    /// The components and wires `ids` name.
    fn resolve(&self, ids: &[String]) -> Result<(BTreeSet<usize>, BTreeSet<usize>)> {
        let comps: HashMap<&str, usize> = self
            .comps
            .iter()
            .enumerate()
            .map(|(i, c)| (c.id.as_str(), i))
            .collect();
        let (mut found, mut wires) = (BTreeSet::new(), BTreeSet::new());
        for id in ids {
            match comps.get(id.as_str()) {
                Some(&i) => found.insert(i),
                None => wires.insert(self.wire(id).ok_or_else(stale)?),
            };
        }
        Ok((found, wires))
    }

    /// Wire ids are `w<k>`, `k` counting the circuit's wires in file order.
    fn wire(&self, id: &str) -> Option<usize> {
        let k: usize = id.strip_prefix('w')?.parse().ok()?;
        (k < self.wires.len() && format!("w{k}") == id).then_some(k)
    }

    fn is_pin(&self, c: &Comp) -> bool {
        c.name == "Pin"
            && c.library
                .as_ref()
                .is_some_and(|lib| self.wiring.contains(lib))
    }

    /// Locations of the pins outside `moved`.
    fn pins_except(&self, moved: &BTreeSet<usize>) -> HashSet<Point> {
        self.comps
            .iter()
            .enumerate()
            .filter(|(i, c)| !moved.contains(i) && self.is_pin(c))
            .map(|(_, c)| c.location)
            .collect()
    }

    /// The custom appearance's `circ-port` elements and the pin location each names.
    fn ports(&self) -> Vec<(usize, Point)> {
        let tree = self.tree;
        tree.named(self.node, "appear")
            .flat_map(|appear| tree.named(appear, "circ-port"))
            .filter_map(|port| Some((port, Point::parse(&tree.attr(port, "pin")?).ok()?)))
            .collect()
    }
}

/// Component ids name the anchor location, `c<x>_<y>` with `m` for a minus
/// sign. Components that share a location are ordered by factory name and
/// then by their stored attributes (Java string order), and the k-th of them
/// (k ≥ 2) gets the suffix `_k`. These are the only component ids: the
/// native side is told them with every circuit it loads and never makes its
/// own.
fn anchor(tree: &Tree, comps: &mut [Comp]) {
    let mut stacks: HashMap<Point, Vec<usize>> = HashMap::new();
    for (i, c) in comps.iter().enumerate() {
        stacks.entry(c.location).or_default().push(i);
    }
    for (location, mut members) in stacks {
        if members.len() > 1 {
            let mut keyed: Vec<(usize, String)> = members
                .iter()
                .map(|&i| (i, fingerprint(tree, comps[i].node)))
                .collect();
            keyed.sort_by(|(a, x), (b, y)| {
                utf16(&comps[*a].name, &comps[*b].name).then_with(|| utf16(x, y))
            });
            members = keyed.into_iter().map(|(i, _)| i).collect();
        }
        let base = format!("c{}_{}", coordinate(location.x), coordinate(location.y));
        for (k, i) in members.into_iter().enumerate() {
            comps[i].id = if k == 0 {
                base.clone()
            } else {
                format!("{base}_{}", k + 1)
            };
        }
    }
}

fn coordinate(value: i32) -> String {
    if value < 0 {
        // Java's `-value`, which keeps `Integer.MIN_VALUE` negative.
        format!("m{}", value.wrapping_neg())
    } else {
        value.to_string()
    }
}

/// Java's `String.compareTo`: UTF-16 code units.
fn utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `name=value;` for each attribute the file stores, in file order (the order
/// Logisim writes them in).
fn fingerprint(tree: &Tree, comp: usize) -> String {
    let mut out = String::new();
    for a in tree.named(comp, "a") {
        out.push_str(&tree.get(a, "name"));
        out.push('=');
        out.push_str(&tree.property(a));
        out.push(';');
    }
    out
}

/// A Logisim `<a>` element; multi-line values (memory contents) are text.
fn property(name: &str, value: &str) -> Element {
    let a = Element::new("a").attr("name", name);
    if value.contains(['\n', '\r']) {
        a.text(value)
    } else {
        a.attr("val", value)
    }
}

fn wire_element(segment: &Segment) -> Element {
    Element::new("wire")
        .attr("from", segment.from.xml())
        .attr("to", segment.to.xml())
}

fn find(tree: &Tree, circuit: &str) -> Result<usize> {
    tree.named(tree.root(), "circuit")
        .find(|&c| tree.get(c, "name") == circuit)
        .ok_or_else(|| Error::InvalidCommand("找不到电路".into()))
}

fn check_name(tree: &Tree, name: &str) -> Result<()> {
    if name.trim().is_empty()
        || tree
            .named(tree.root(), "circuit")
            .any(|c| tree.get(c, "name") == name)
    {
        Err(Error::InvalidCommand("电路名称为空或已存在".into()))
    } else {
        Ok(())
    }
}

fn finish(out: Splices<'_>) -> Result<Option<String>> {
    if out.is_empty() {
        Ok(None)
    } else {
        out.finish().map(Some)
    }
}

/// The file after `edit`, or `None` when the edit changes nothing.
pub(crate) fn apply(tree: &Tree, circuit: &str, edit: Edit) -> Result<Option<String>> {
    let root = tree.root();
    let node = find(tree, circuit)?;
    let mut out = Splices::new(tree);
    match edit {
        Edit::AddCircuit { name } => {
            check_name(tree, &name)?;
            let last = tree.named(root, "circuit").last().unwrap_or(node);
            let element = Element::new("circuit")
                .attr("name", name.as_str())
                .child(property("circuit", &name));
            out.insert_after(last, &[element]);
        }
        Edit::RenameCircuit { name } => {
            check_name(tree, &name)?;
            for main in tree.named(root, "main") {
                if tree.get(main, "name") == circuit {
                    out.set(main, "name", &name);
                }
            }
            out.set(node, "name", &name);
            for c in tree.named(root, "circuit") {
                for &child in tree.children(c) {
                    match tree.tag(child) {
                        "comp"
                            if tree.attr(child, "lib").is_none()
                                && tree.get(child, "name") == circuit =>
                        {
                            out.set(child, "name", &name)
                        }
                        "a" if tree.get(child, "name") == "circuit"
                            && tree.get(child, "val") == circuit =>
                        {
                            out.set(child, "val", &name)
                        }
                        _ => {}
                    }
                }
            }
        }
        Edit::DeleteCircuit => {
            let circuits: Vec<usize> = tree.named(root, "circuit").collect();
            if circuits.len() == 1 {
                return Err(Error::InvalidCommand("至少保留一个电路".into()));
            }
            if circuits.iter().any(|&c| {
                tree.named(c, "comp")
                    .any(|x| tree.attr(x, "lib").is_none() && tree.get(x, "name") == circuit)
            }) {
                return Err(Error::InvalidCommand("其他电路仍在使用这个子电路".into()));
            }
            out.remove(node);
            if let Some(main) = tree.named(root, "main").next()
                && tree.get(main, "name") == circuit
                && let Some(&next) = circuits.iter().find(|&&c| c != node)
            {
                out.set(main, "name", &tree.get(next, "name"));
            }
        }
        Edit::SetMain => match tree.named(root, "main").next() {
            Some(main) => {
                if tree.get(main, "name") != circuit {
                    out.set(main, "name", circuit);
                }
            }
            None => {
                let main = [Element::new("main").attr("name", circuit)];
                match tree.named(root, "lib").last() {
                    Some(lib) => out.insert_after(lib, &main),
                    None => out.insert_before(tree.children(root)[0], &main),
                }
            }
        },
        Edit::Wire { points } => wire(&Sheet::new(tree, node)?, &points, &mut out)?,
        Edit::Place {
            name,
            library,
            location,
            attributes,
        } => {
            // Logisim's attribute order: lib, loc, name.
            let mut comp = Element::new("comp");
            if let Some(library) = library {
                comp = comp.attr("lib", library);
            }
            comp = comp.attr("loc", location.xml()).attr("name", name);
            for (key, value) in &attributes {
                comp = comp.child(property(key, value));
            }
            match tree.named(node, "comp").last() {
                Some(last) => out.insert_after(last, &[comp]),
                None => out.append(node, &[comp]),
            }
        }
        Edit::Move { ids, delta, .. } => shift(
            &Sheet::new(tree, node)?,
            &ids,
            delta,
            &crate::WireEdit::default(),
            &mut out,
        )?,
        Edit::Delete { ids } => delete(&Sheet::new(tree, node)?, &ids, &mut out)?,
        Edit::Attributes { id, values } => {
            set_attributes(&Sheet::new(tree, node)?, id, &values, &mut out)?
        }
        Edit::Replace { .. } | Edit::Batch { .. } => {
            unreachable!("the document merges replacements and applies batches item by item")
        }
    }
    finish(out)
}

fn wire(sheet: &Sheet, points: &[Point], out: &mut Splices<'_>) -> Result<()> {
    if !(2..=4096).contains(&points.len()) {
        return Err(Error::InvalidCommand("导线需要 2–4096 个点".into()));
    }
    let mut added: Vec<Segment> = Vec::new();
    for pair in points.windows(2) {
        let segment = Segment {
            from: pair[0],
            to: pair[1],
        };
        if segment.from == segment.to {
            continue;
        }
        if segment.from.x != segment.to.x && segment.from.y != segment.to.y {
            return Err(Error::InvalidCommand("导线必须水平或垂直".into()));
        }
        if !sheet.wires.iter().any(|w| w.segment.same(&segment))
            && !added.iter().any(|s| s.same(&segment))
        {
            added.push(segment);
        }
    }
    let ends: Vec<Point> = added.iter().flat_map(|s| [s.from, s.to]).collect();
    let mut plan = Plan::new(sheet);
    plan.added = added;
    plan.split(&ends);
    // A piece that duplicates a wire adds nothing.
    let mut kept: Vec<Segment> = Vec::new();
    for piece in std::mem::take(&mut plan.added) {
        if !plan.wires.iter().flatten().any(|w| w.same(&piece))
            && !kept.iter().any(|s| s.same(&piece))
        {
            kept.push(piece);
        }
    }
    if kept.is_empty() {
        return Ok(());
    }
    plan.added = kept;
    plan.write(sheet, out);
    Ok(())
}

/// A move: the selection translated and the wire edits the native side's
/// `MoveGesture` gave for it (none for a plain translation): the named wires
/// out, the segments in after the circuit's last wire. One plan, so the
/// junction rule splits wires once, at the moved and the added ends.
fn shift(
    sheet: &Sheet,
    ids: &[String],
    delta: Point,
    edit: &crate::WireEdit,
    out: &mut Splices<'_>,
) -> Result<()> {
    let (comps, wires) = sheet.resolve(ids)?;
    let mut gone = BTreeSet::new();
    for id in &edit.removed {
        gone.insert(sheet.wire(id).ok_or_else(stale)?);
    }
    if delta == (Point { x: 0, y: 0 }) || (comps.is_empty() && wires.is_empty()) {
        return Ok(());
    }
    for &i in &comps {
        let c = &sheet.comps[i];
        out.set(c.node, "loc", &c.location.translated(delta)?.xml());
    }
    // A custom appearance names each port's pin by location.
    let staying = sheet.pins_except(&comps);
    let ports = sheet.ports();
    let mut retargeted = HashSet::new();
    for &i in &comps {
        let pin = &sheet.comps[i];
        if !sheet.is_pin(pin) || staying.contains(&pin.location) {
            continue;
        }
        let to = pin.location.translated(delta)?;
        for &(port, at) in &ports {
            if at == pin.location && retargeted.insert(port) {
                out.set(port, "pin", &format!("{},{}", to.x, to.y));
            }
        }
    }
    let mut plan = Plan::new(sheet);
    let mut ends = Vec::new();
    for &k in &wires {
        let moved = sheet.wires[k].segment.translated(delta)?;
        ends.extend([moved.from, moved.to]);
        plan.wires[k] = vec![moved];
    }
    for &k in &gone {
        if !wires.contains(&k) {
            plan.wires[k].clear();
        }
    }
    // Only the moved wires' ends split what they land on: a new branch that
    // ends inside a wire is a T, which Logisim joins without a split.
    for &(from, to) in &edit.added {
        if from != to {
            plan.added.push(Segment { from, to });
        }
    }
    plan.split(&ends);
    // An added piece that duplicates a wire adds nothing.
    let mut kept: Vec<Segment> = Vec::new();
    for piece in std::mem::take(&mut plan.added) {
        if !plan.wires.iter().flatten().any(|w| w.same(&piece))
            && !kept.iter().any(|s| s.same(&piece))
        {
            kept.push(piece);
        }
    }
    plan.added = kept;
    plan.write(sheet, out);
    Ok(())
}

/// A move with the wire edits the native side's `MoveGesture` returned.
pub(crate) fn translate(
    tree: &Tree,
    circuit: &str,
    ids: &[String],
    delta: Point,
    wires: &crate::WireEdit,
) -> Result<Option<String>> {
    let sheet = Sheet::new(tree, find(tree, circuit)?)?;
    let mut out = Splices::new(tree);
    shift(&sheet, ids, delta, wires, &mut out)?;
    finish(out)
}

/// The ids the selection has after a move: the components at their new
/// anchors and the wires along for it (every piece of a moved wire). As in
/// Logisim, the wires a move adds to keep its ends connected are not
/// selected, so the next drag stretches them again.
pub(crate) fn moved(
    before: &Tree,
    after: &Tree,
    circuit: &str,
    ids: &[String],
    delta: Point,
) -> Result<(Vec<String>, Vec<String>)> {
    let old = Sheet::new(before, find(before, circuit)?)?;
    let new = Sheet::new(after, find(after, circuit)?)?;
    let (comps, wires) = old.resolve(ids)?;
    let mut picked: HashSet<usize> = HashSet::new();
    let mut components = Vec::new();
    for &i in &comps {
        let c = &old.comps[i];
        let at = c.location.translated(delta)?;
        let mut found = None;
        for (j, other) in new.comps.iter().enumerate() {
            if picked.contains(&j) || other.name != c.name || other.location != at {
                continue;
            }
            if fingerprint(old.tree, c.node) == fingerprint(new.tree, other.node) {
                found = Some(j);
                break;
            }
        }
        let j = found.ok_or_else(stale)?;
        picked.insert(j);
        components.push(new.comps[j].id.clone());
    }
    let mut chosen: BTreeSet<usize> = BTreeSet::new();
    let on =
        |outer: &Segment, inner: &Segment| outer.touches(inner.from) && outer.touches(inner.to);
    for &k in &wires {
        let wanted = old.wires[k].segment.translated(delta)?;
        let before = chosen.len();
        chosen.extend(
            new.wires
                .iter()
                .enumerate()
                .filter(|(_, w)| on(&wanted, &w.segment))
                .map(|(j, _)| j),
        );
        if chosen.len() == before {
            return Err(stale());
        }
    }
    Ok((components, chosen.iter().map(|j| format!("w{j}")).collect()))
}

fn delete(sheet: &Sheet, ids: &[String], out: &mut Splices<'_>) -> Result<()> {
    let (comps, wires) = sheet.resolve(ids)?;
    for &i in &comps {
        out.remove(sheet.comps[i].node);
    }
    for &k in &wires {
        out.remove(sheet.wires[k].node);
    }
    // A custom appearance port whose pin is gone would fail to load.
    let staying = sheet.pins_except(&comps);
    let gone: HashSet<Point> = comps
        .iter()
        .map(|&i| &sheet.comps[i])
        .filter(|c| sheet.is_pin(c) && !staying.contains(&c.location))
        .map(|c| c.location)
        .collect();
    if !gone.is_empty() {
        for (port, pin) in sheet.ports() {
            if gone.contains(&pin) {
                out.remove(port);
            }
        }
    }
    Ok(())
}

fn set_attributes(
    sheet: &Sheet,
    id: String,
    values: &BTreeMap<String, String>,
    out: &mut Splices<'_>,
) -> Result<()> {
    let (comps, _) = sheet.resolve(std::slice::from_ref(&id))?;
    let Some(&i) = comps.first() else {
        return Err(Error::InvalidCommand("请选择元件".into()));
    };
    let tree = sheet.tree;
    let comp = sheet.comps[i].node;
    let current: Vec<usize> = tree.named(comp, "a").collect();
    let mut added = Vec::new();
    for (name, value) in values {
        // Logisim reads the last `<a>` of a name.
        match current
            .iter()
            .rev()
            .find(|&&a| tree.get(a, "name") == *name)
        {
            Some(&a) if tree.property(a) == *value => {}
            Some(&a) if tree.attr(a, "val").is_some() && !value.contains(['\n', '\r']) => {
                out.set(a, "val", value)
            }
            Some(&a) => out.replace(a, &property(name, value)),
            None => added.push(property(name, value)),
        }
    }
    if !added.is_empty() {
        match current.last() {
            Some(&last) => out.insert_after(last, &added),
            None => out.append(comp, &added),
        }
    }
    Ok(())
}

/// The wires of a circuit after an edit.
struct Plan {
    /// What each existing wire becomes, in file order; no pieces removes it.
    wires: Vec<Vec<Segment>>,
    added: Vec<Segment>,
}

impl Plan {
    fn new(sheet: &Sheet) -> Self {
        Self {
            wires: sheet.wires.iter().map(|w| vec![w.segment]).collect(),
            added: Vec::new(),
        }
    }

    /// The junction rule: every wire is split at the given points inside it.
    fn split(&mut self, points: &[Point]) {
        for pieces in self.wires.iter_mut().chain([&mut self.added]) {
            if pieces.iter().any(|s| points.iter().any(|&p| s.inside(p))) {
                *pieces = pieces.iter().flat_map(|s| s.split(points)).collect();
            }
        }
    }

    /// A changed wire keeps its element for its first piece; further pieces
    /// follow it. New wires go after the circuit's last wire.
    fn write(&self, sheet: &Sheet, out: &mut Splices<'_>) {
        for (line, pieces) in sheet.wires.iter().zip(&self.wires) {
            let Some((first, rest)) = pieces.split_first() else {
                out.remove(line.node);
                continue;
            };
            if first.from != line.segment.from {
                out.set(line.node, "from", &first.from.xml());
            }
            if first.to != line.segment.to {
                out.set(line.node, "to", &first.to.xml());
            }
            if !rest.is_empty() {
                let rest: Vec<Element> = rest.iter().map(wire_element).collect();
                out.insert_after(line.node, &rest);
            }
        }
        if !self.added.is_empty() {
            let added: Vec<Element> = self.added.iter().map(wire_element).collect();
            match sheet.wires.last() {
                Some(last) => out.insert_after(last.node, &added),
                None => out.append(sheet.node, &added),
            }
        }
    }
}
