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

struct Comp {
    node: usize,
    id: String,
    name: String,
    library: Option<String>,
    location: Point,
}

struct Line {
    node: usize,
    segment: Segment,
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
/// sign, as the native observer does. Components that share a location are
/// ordered as the observer orders them, by factory name and then by their
/// attributes, and the k-th of them (k ≥ 2) gets the suffix `_k`. The file
/// leaves default values out where the observer counts them, so two parts of
/// one factory on one spot that differ only there may be ordered differently.
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
        Edit::Move { ids, delta } => shift(&Sheet::new(tree, node)?, &ids, delta, None, &mut out)?,
        Edit::Delete { ids } => delete(&Sheet::new(tree, node)?, &ids, &mut out)?,
        Edit::Attributes { id, values } => {
            set_attributes(&Sheet::new(tree, node)?, id, &values, &mut out)?
        }
        Edit::Replace { .. } => unreachable!("the document merges replacements"),
    }
    finish(out)
}

/// A move that keeps the wires on the moved components' native `ports`
/// attached; `fixed` are the ports of the components that stay.
pub(crate) fn move_connected(
    tree: &Tree,
    circuit: &str,
    ids: &[String],
    delta: Point,
    ports: Vec<Point>,
    fixed: &[Point],
) -> Result<Option<String>> {
    let sheet = Sheet::new(tree, find(tree, circuit)?)?;
    let mut out = Splices::new(tree);
    shift(&sheet, ids, delta, Some((ports, fixed)), &mut out)?;
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

fn shift(
    sheet: &Sheet,
    ids: &[String],
    delta: Point,
    attached: Option<(Vec<Point>, &[Point])>,
    out: &mut Splices<'_>,
) -> Result<()> {
    let (comps, wires) = sheet.resolve(ids)?;
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
    if let Some((ports, fixed)) = attached {
        ends.extend(reroute(sheet, &wires, delta, ports, fixed, &mut plan)?);
    }
    plan.split(&ends);
    plan.write(sheet, out);
    Ok(())
}

/// The reroute: a wire with one end on a moved port follows it, keeping its
/// other end and its direction where it meets the moved port. It takes the
/// first shape that touches nothing it would join: one bend at the end that
/// stays, one bend at the moved end, else a jog at the first free column (or
/// row) from the moved end; with none free it keeps the first and the caller's
/// connectivity check decides. Neighbouring wires of a moved part so fan out
/// instead of folding onto one column. A moved port that
/// is also a junction of wires that stay keeps those wires and gets a bend
/// from its old place to its new one. Returns the ends the reroute creates;
/// an end a wire keeps also keeps its junction as it was.
fn reroute(
    sheet: &Sheet,
    selected: &BTreeSet<usize>,
    delta: Point,
    mut ports: Vec<Point>,
    fixed: &[Point],
    plan: &mut Plan,
) -> Result<Vec<Point>> {
    // Every port where it will be: what a rerouted wire must not run into.
    let mut blocking: Vec<Point> = fixed.to_vec();
    for &p in &ports {
        blocking.push(p.translated(delta)?);
    }
    let still: Vec<(usize, Segment)> = sheet
        .wires
        .iter()
        .enumerate()
        .filter(|(k, _)| !selected.contains(k))
        .map(|(k, w)| (k, w.segment))
        .collect();
    // Selected wires move with the selection, including contacts along their length.
    for &k in selected {
        let wire = sheet.wires[k].segment;
        ports.extend([wire.from, wire.to]);
        ports.extend(fixed.iter().copied().filter(|&p| wire.touches(p)));
        for (_, other) in &still {
            ports.extend(
                [other.from, other.to]
                    .into_iter()
                    .filter(|&p| wire.touches(p)),
            );
        }
    }
    ports.sort_by_key(|p| (p.x, p.y));
    ports.dedup();
    // Shared ports and junctions on wires that stay keep their position.
    let anchored: Vec<Point> = ports
        .iter()
        .copied()
        .filter(|&p| {
            fixed.contains(&p)
                || still.iter().any(|&(k, w)| {
                    w.touches(p)
                        && (w.inside(p)
                            || still.iter().any(|&(j, other)| {
                                j != k && (w.inside(other.from) || w.inside(other.to))
                            })
                            || fixed.iter().any(|&q| w.inside(q)))
                })
        })
        .collect();
    let moves = |p: Point| ports.contains(&p) && !anchored.contains(&p);
    let mut ends = Vec::new();
    for &(k, wire) in &still {
        let (from_moves, to_moves) = (moves(wire.from), moves(wire.to));
        let from = if from_moves {
            wire.from.translated(delta)?
        } else {
            wire.from
        };
        let to = if to_moves {
            wire.to.translated(delta)?
        } else {
            wire.to
        };
        if (from, to) == (wire.from, wire.to) {
            continue;
        }
        let pieces = if from_moves && to_moves {
            vec![Segment { from, to }]
        } else {
            let (fixed_end, moved_end) = if to_moves { (from, to) } else { (to, from) };
            let others: Vec<Segment> = plan
                .wires
                .iter()
                .enumerate()
                .filter(|&(j, _)| j != k)
                .flat_map(|(_, pieces)| pieces.iter().copied())
                .chain(plan.added.iter().copied())
                .collect();
            let shapes = shapes(fixed_end, moved_end, wire.from.x == wire.to.x);
            let mut chosen = shapes
                .iter()
                .find(|shape| clear(shape, [fixed_end, moved_end], &others, &blocking))
                .unwrap_or(&shapes[0])
                .clone();
            // Written in the wire's own direction.
            if !to_moves {
                chosen.reverse();
                for piece in &mut chosen {
                    *piece = Segment {
                        from: piece.to,
                        to: piece.from,
                    };
                }
            }
            chosen
        };
        let pieces: Vec<Segment> = pieces.into_iter().filter(|s| s.from != s.to).collect();
        ends.extend(
            pieces
                .iter()
                .flat_map(|s| [s.from, s.to])
                .filter(|&p| p != wire.from && p != wire.to),
        );
        plan.wires[k] = pieces;
    }
    for port in anchored {
        let to = port.translated(delta)?;
        let corner = Point { x: to.x, y: port.y };
        for piece in [
            Segment {
                from: port,
                to: corner,
            },
            Segment { from: corner, to },
        ] {
            if piece.from != piece.to {
                ends.extend([piece.from, piece.to]);
                plan.added.push(piece);
            }
        }
    }
    Ok(ends)
}

/// Candidate shapes from `fixed` to `moved` for a wire that ran vertically
/// (or horizontally), keeping that direction at the moved end: one bend at the
/// fixed end, one at the moved end, then jogs from the moved end outwards.
fn shapes(fixed: Point, moved: Point, vertical: bool) -> Vec<Vec<Segment>> {
    let seg = |from, to| Segment { from, to };
    let flip = |p: Point| if vertical { Point { x: p.y, y: p.x } } else { p };
    // Work as if the wire were horizontal: x runs along it.
    let (f, m) = (flip(fixed), flip(moved));
    let mut out = vec![
        vec![
            (f, Point { x: f.x, y: m.y }),
            (Point { x: f.x, y: m.y }, m),
        ],
        vec![
            (f, Point { x: m.x, y: f.y }),
            (Point { x: m.x, y: f.y }, m),
        ],
    ];
    let step = if f.x < m.x { -10 } else { 10 };
    let mut x = m.x + step;
    while (f.x < m.x && x > f.x) || (f.x > m.x && x < f.x) {
        let (a, b) = (Point { x, y: f.y }, Point { x, y: m.y });
        out.push(vec![(f, a), (a, b), (b, m)]);
        x += step;
    }
    out.into_iter()
        .map(|shape| {
            shape
                .into_iter()
                .map(|(a, b)| seg(flip(a), flip(b)))
                .filter(|s| s.from != s.to)
                .collect()
        })
        .collect()
}

/// Whether a rerouted wire touches nothing it would join, away from its own
/// two ends: no port or wire end on it, no corner of it on a wire, no run
/// along a wire.
fn clear(pieces: &[Segment], ends: [Point; 2], wires: &[Segment], ports: &[Point]) -> bool {
    let own = |p: &Point| ends.contains(p);
    let along = |a: &Segment, b: &Segment| {
        let (ah, bh) = (a.from.y == a.to.y, b.from.y == b.to.y);
        if ah != bh || (ah && a.from.y != b.from.y) || (!ah && a.from.x != b.from.x) {
            return false;
        }
        let span = |s: &Segment| {
            if ah {
                (s.from.x.min(s.to.x), s.from.x.max(s.to.x))
            } else {
                (s.from.y.min(s.to.y), s.from.y.max(s.to.y))
            }
        };
        let ((a0, a1), (b0, b1)) = (span(a), span(b));
        a0.max(b0) < a1.min(b1)
    };
    pieces.iter().all(|piece| {
        !ports.iter().any(|p| !own(p) && piece.touches(*p))
            && wires.iter().all(|w| {
                ![w.from, w.to].iter().any(|p| !own(p) && piece.touches(*p))
                    && ![piece.from, piece.to].iter().any(|p| !own(p) && w.touches(*p))
                    && !along(piece, w)
            })
    })
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
