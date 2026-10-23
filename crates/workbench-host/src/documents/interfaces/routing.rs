//! Reattach changed terminals to retained branches, then let native bit nets verify the proposal.
use crate::Result;
use serde::Deserialize;
use serde_json::Value;
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap};
use vibe_circuit_document::Point;
pub type P = (i32, i32);
pub type Terminal = (String, u32);
pub type Changes = BTreeMap<Terminal, Option<P>>;
type Segment = (P, P, String);
type Owner = Vec<String>;
#[derive(Clone, Deserialize)]
pub struct Bit {
    pub bit: u32,
    #[serde(rename = "netId")]
    pub net: Option<String>,
}
#[derive(Clone, Deserialize)]
pub struct End {
    pub index: u32,
    pub location: Point,
    pub width: Option<u32>,
    #[serde(rename = "netBits")]
    pub bits: Vec<Bit>,
    pub direction: Option<String>,
}
#[derive(Clone, Deserialize, PartialEq, Eq)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
#[derive(Clone, Deserialize)]
pub struct Component {
    #[serde(rename = "componentId")]
    pub id: String,
    #[serde(rename = "factoryName")]
    pub factory: String,
    pub location: Point,
    pub bounds: Bounds,
    pub ends: Vec<End>,
}
impl Component {
    pub fn key(&self) -> (String, P) {
        (self.factory.clone(), point(self.location))
    }
}
#[derive(Clone, Deserialize)]
pub struct Wire {
    pub from: Point,
    pub to: Point,
    #[serde(rename = "bundleId")]
    pub bundle: String,
}
#[derive(Clone, Deserialize)]
pub struct Bundle {
    #[serde(rename = "bundleId")]
    pub id: String,
    #[serde(rename = "bitNets")]
    pub bits: Vec<Bit>,
}
#[derive(Clone, Deserialize)]
pub struct Scene {
    pub components: Vec<Component>,
    pub wires: Vec<Wire>,
    #[serde(rename = "wireBundles")]
    pub bundles: Vec<Bundle>,
}
impl Scene {
    pub fn read(value: &Value) -> Result<Self> {
        let scene: Self = serde_json::from_value(value["focus"].clone())
            .map_err(|e| format!("原生连接信息不完整：{e}"))?;
        // Keep arithmetic and grid work bounded even for imported coordinates.
        let bounded = |n: i32| (-1_000_000..=1_000_000).contains(&n);
        if scene.components.iter().any(|c| {
            ![
                c.bounds.x,
                c.bounds.y,
                c.bounds.width,
                c.bounds.height,
                c.location.x,
                c.location.y,
            ]
            .into_iter()
            .all(bounded)
                || c.ends
                    .iter()
                    .any(|e| !bounded(e.location.x) || !bounded(e.location.y))
        }) || scene.wires.iter().any(|w| {
            ![w.from.x, w.from.y, w.to.x, w.to.y]
                .into_iter()
                .all(bounded)
        }) {
            return Err("电路几何范围超过接口编辑限制".into());
        }
        Ok(scene)
    }
}
pub fn point(p: Point) -> P {
    (p.x, p.y)
}
pub fn on(p: P, a: P, b: P) -> bool {
    a.0 == b.0 && p.0 == a.0 && (a.1.min(b.1)..=a.1.max(b.1)).contains(&p.1)
        || a.1 == b.1 && p.1 == a.1 && (a.0.min(b.0)..=a.0.max(b.0)).contains(&p.0)
}
fn owner(bits: &[Bit]) -> Owner {
    let mut bits = bits.to_vec();
    bits.sort_by_key(|b| b.bit);
    bits.into_iter().filter_map(|b| b.net).collect()
}
fn grid(a: P, b: P) -> Result<Vec<P>> {
    if a.0 != b.0 && a.1 != b.1 {
        return Err("仅支持正交导线".into());
    }
    if [a.0, a.1, b.0, b.1].iter().any(|n| n % 10 != 0) {
        return Err("端口或导线不在 10 单位布线网格上".into());
    }
    let distance = i64::from(a.0 - b.0).abs() + i64::from(a.1 - b.1).abs();
    if distance > 1_000_000 {
        return Err("连线范围超过接口编辑限制".into());
    }
    if a.0 == b.0 {
        Ok((a.1.min(b.1)..=a.1.max(b.1))
            .step_by(10)
            .map(|y| (a.0, y))
            .collect())
    } else {
        Ok((a.0.min(b.0)..=a.0.max(b.0))
            .step_by(10)
            .map(|x| (x, a.1))
            .collect())
    }
}
#[derive(Clone)]
struct Copper {
    owner: Owner,
    axis: i8,
    vertex: bool,
}
struct Router {
    blocked: BTreeSet<P>,
    ports: BTreeMap<P, BTreeSet<Owner>>,
    at: BTreeMap<P, Vec<Copper>>,
    clearance: BTreeMap<(P, i8), i64>,
    extent: (i32, i32, i32, i32),
}
impl Router {
    fn new(
        components: &[Component],
        wires: &[Segment],
        bundles: &BTreeMap<String, Owner>,
    ) -> Result<Self> {
        let mut r = Self {
            blocked: BTreeSet::new(),
            ports: BTreeMap::new(),
            at: BTreeMap::new(),
            clearance: BTreeMap::new(),
            extent: (0, 0, 0, 0),
        };
        let mut points = Vec::new();
        let mut cells = 0;
        for c in components {
            let b = &c.bounds;
            let body = !["Text", "Tunnel", "Splitter"].contains(&c.factory.as_str());
            let mut escapes = BTreeSet::new();
            if b.width < 0 || b.height < 0 || i64::from(b.width) * i64::from(b.height) > 100_000_000
            {
                return Err("封装外形范围超过限制".into());
            }
            if body {
                for x in (b.x.div_euclid(10) * 10..=b.x + b.width).step_by(10) {
                    for y in (b.y.div_euclid(10) * 10..=b.y + b.height).step_by(10) {
                        cells += 1;
                        if cells > 1_000_000 {
                            return Err("电路几何范围超过接口编辑限制".into());
                        }
                        if b.x < x && x < b.x + b.width && b.y < y && y < b.y + b.height {
                            r.blocked.insert((x, y));
                        }
                    }
                }
            }
            for e in &c.ends {
                let p = point(e.location);
                r.ports.entry(p).or_default().insert(owner(&e.bits));
                points.push(p);
                // Open only the nearest escape ray for ports inside a custom symbol's bounds.
                let preferred = if e.direction.as_deref() == Some("output") {
                    10
                } else {
                    -10
                };
                let mut directions = [
                    ((p.0 - b.x).abs(), -10, 0),
                    ((p.0 - b.x - b.width).abs(), 10, 0),
                    ((p.1 - b.y).abs(), 0, -10),
                    ((p.1 - b.y - b.height).abs(), 0, 10),
                ];
                directions.sort_by_key(|(d, dx, _)| (*d, if *dx == preferred { 0 } else { 1 }));
                let (_, dx, dy) = directions[0];
                let mut q = p;
                while b.x <= q.0 && q.0 <= b.x + b.width && b.y <= q.1 && q.1 <= b.y + b.height {
                    r.blocked.remove(&q);
                    q = (q.0 + dx, q.1 + dy);
                }
                q = p;
                while b.x - 10 < q.0
                    && q.0 < b.x + b.width + 10
                    && b.y - 10 < q.1
                    && q.1 < b.y + b.height + 10
                {
                    escapes.insert((q, if dx != 0 { 0 } else { 1 }));
                    q = (q.0 + dx, q.1 + dy);
                }
            }
            if body {
                for x in (b.x.div_euclid(10) * 10..b.x + b.width + 10).step_by(10) {
                    for y in (b.y.div_euclid(10) * 10..b.y + b.height + 10).step_by(10) {
                        for axis in [0, 1] {
                            if !escapes.contains(&((x, y), axis)) {
                                r.clearance.insert(((x, y), axis), 40);
                            }
                        }
                    }
                }
            }
        }
        for p in r.ports.keys() {
            r.blocked.remove(p);
        }
        for (a, b, bundle) in wires {
            r.add(*a, *b, bundles.get(bundle).ok_or("原生导线束缺失")?)?;
            points.extend([*a, *b]);
        }
        if points.is_empty() {
            r.extent = (-100, -100, 6000, 6000);
        } else {
            r.extent = (
                points.iter().map(|p| p.0).min().unwrap() - 100,
                points.iter().map(|p| p.1).min().unwrap() - 100,
                points.iter().map(|p| p.0).max().unwrap() + 240,
                points.iter().map(|p| p.1).max().unwrap() + 240,
            );
        }
        Ok(r)
    }
    fn add(&mut self, a: P, b: P, owner: &Owner) -> Result<()> {
        if a == b {
            return Ok(());
        }
        let axis = if a.1 == b.1 { 0 } else { 1 };
        for p in grid(a, b)? {
            self.at.entry(p).or_default().push(Copper {
                owner: owner.clone(),
                axis,
                vertex: p == a || p == b,
            });
        }
        Ok(())
    }
    fn foreign(&self, p: P, owner: &Owner) -> Vec<&Copper> {
        self.at
            .get(&p)
            .into_iter()
            .flatten()
            .filter(|s| s.owner != *owner)
            .collect()
    }
    fn foreign_port(&self, p: P, owner: &Owner) -> bool {
        self.ports
            .get(&p)
            .is_some_and(|all| all.iter().any(|o| o != owner))
    }
    fn boxed_in(&self, target: P, start: P, owner: &Owner) -> bool {
        let mut seen = BTreeSet::from([target]);
        let mut todo = vec![target];
        while let Some(q) = todo.pop() {
            let here = self.foreign(q, owner);
            for (dx, dy, axis) in [(10, 0, 0), (-10, 0, 0), (0, 10, 1), (0, -10, 1)] {
                let p = (q.0 - dx, q.1 - dy);
                if seen.contains(&p)
                    || p.0 < self.extent.0
                    || p.1 < self.extent.1
                    || p.0 > self.extent.2
                    || p.1 > self.extent.3
                    || self.blocked.contains(&p)
                    || self.foreign_port(p, owner)
                {
                    continue;
                }
                if self
                    .foreign(p, owner)
                    .iter()
                    .any(|s| s.axis == axis || s.vertex)
                    || (!here.is_empty()
                        && (q == target || here.iter().any(|s| s.axis == axis || s.vertex)))
                {
                    continue;
                }
                if p == start || seen.len() >= 64 {
                    return false;
                }
                seen.insert(p);
                todo.push(p);
            }
        }
        true
    }
    fn path(&self, a: P, b: P, owner: &Owner) -> Result<Vec<(P, P)>> {
        if [a.0, a.1, b.0, b.1].iter().any(|n| n % 10 != 0) {
            return Err("端口不在 10 单位布线网格上".into());
        }
        if a == b {
            return Ok(vec![]);
        }
        if !self.foreign(b, owner).is_empty() || self.foreign_port(b, owner) {
            return Err("目标端口已被其他信号占用，请调整端口位置".into());
        }
        if self.blocked.contains(&b) || self.boxed_in(b, a, owner) {
            return Err("无法在目标位置保持连线，请留出更多空间".into());
        }
        if self.blocked.contains(&a)
            || !self.foreign(a, owner).is_empty()
            || self.foreign_port(a, owner)
        {
            return Err("原接点被封装或其他信号占用，请调整尺寸和端口位置".into());
        }
        let estimate = |p: P, axis: i8| {
            i64::from(p.0 - b.0).abs()
                + i64::from(p.1 - b.1).abs()
                + if (p.0 == b.0 && axis != 0) || (p.1 == b.1 && axis != 1) {
                    0
                } else {
                    18
                }
        };
        let start = (a, -1i8);
        let mut queue = BinaryHeap::from([Reverse((estimate(a, -1), 0, start))]);
        let mut costs = BTreeMap::from([(start, 0)]);
        let mut previous = BTreeMap::new();
        let mut end = None;
        let mut visits = 0;
        while let Some(Reverse((_, distance, state))) = queue.pop() {
            if costs.get(&state) != Some(&distance) {
                continue;
            }
            let (p, incoming) = state;
            if p == b {
                end = Some(state);
                break;
            }
            visits += 1;
            if visits > 200_000 {
                break;
            }
            let here = self.foreign(p, owner);
            for (dx, dy, axis) in [(10, 0, 0), (-10, 0, 0), (0, 10, 1), (0, -10, 1)] {
                let q = (p.0 + dx, p.1 + dy);
                if q.0 < self.extent.0
                    || q.1 < self.extent.1
                    || q.0 > self.extent.2
                    || q.1 > self.extent.3
                    || self.blocked.contains(&q)
                    || self.foreign_port(q, owner)
                {
                    continue;
                }
                if !here.is_empty()
                    && (incoming != axis || here.iter().any(|s| s.axis == axis || s.vertex))
                {
                    continue;
                }
                let next = self.foreign(q, owner);
                if !next.is_empty() && (q == b || next.iter().any(|s| s.axis == axis || s.vertex)) {
                    continue;
                }
                let retrace = self
                    .at
                    .get(&q)
                    .is_some_and(|all| all.iter().any(|s| s.owner == *owner && s.axis == axis));
                let d = distance
                    + 10
                    + if incoming != -1 && incoming != axis {
                        18
                    } else {
                        0
                    }
                    + if next.is_empty() { 0 } else { 24 }
                    + self
                        .clearance
                        .get(&(p, axis))
                        .unwrap_or(&0)
                        .max(self.clearance.get(&(q, axis)).unwrap_or(&0))
                    + if retrace { 30 } else { 0 };
                let following = (q, axis);
                if costs.get(&following).is_some_and(|old| *old <= d) {
                    continue;
                }
                costs.insert(following, d);
                previous.insert(following, state);
                queue.push(Reverse((d + estimate(q, axis), d, following)));
            }
        }
        let Some(mut end) = end else {
            return Err("无法在目标位置保持连线，请留出更多空间".into());
        };
        let mut points = vec![end.0];
        while let Some(before) = previous.get(&end) {
            end = *before;
            points.push(end.0);
        }
        points.reverse();
        let mut corners = vec![points[0]];
        for triple in points.windows(3) {
            if (triple[0].0 == triple[1].0) != (triple[1].0 == triple[2].0) {
                corners.push(triple[1]);
            }
        }
        corners.push(*points.last().unwrap());
        Ok(corners.windows(2).map(|p| (p[0], p[1])).collect())
    }
}

pub fn reconnect(
    scene: &Scene,
    components: &[Component],
    changes: &Changes,
) -> Result<Vec<(Point, Point)>> {
    let mut terminals: BTreeMap<P, Vec<Option<P>>> = BTreeMap::new();
    for c in &scene.components {
        for e in &c.ends {
            let p = point(e.location);
            terminals.entry(p).or_default().push(
                changes
                    .get(&(c.id.clone(), e.index))
                    .copied()
                    .unwrap_or(Some(p)),
            );
        }
    }
    let mut vertices: BTreeSet<P> = terminals.keys().copied().collect();
    for w in &scene.wires {
        vertices.extend([point(w.from), point(w.to)]);
    }
    let mut edges: Vec<Segment> = Vec::new();
    let mut adjacent: BTreeMap<P, Vec<usize>> = BTreeMap::new();
    for w in &scene.wires {
        let a = point(w.from);
        let b = point(w.to);
        let cuts: Vec<_> = vertices.iter().copied().filter(|p| on(*p, a, b)).collect();
        for pair in cuts.windows(2) {
            let i = edges.len();
            edges.push((pair[0], pair[1], w.bundle.clone()));
            adjacent.entry(pair[0]).or_default().push(i);
            adjacent.entry(pair[1]).or_default().push(i);
        }
    }
    let mut moved = BTreeMap::new();
    let mut routes = Vec::new();
    for (p, targets) in &terminals {
        let unique: BTreeSet<_> = targets.iter().copied().collect();
        let adjoining = adjacent.get(p).cloned().unwrap_or_default();
        if unique.len() == 1 && adjoining.len() <= 1 {
            moved.insert(*p, *unique.first().unwrap());
        } else {
            moved.insert(*p, Some(*p));
            for q in unique.into_iter().flatten().filter(|q| q != p) {
                if let Some(index) = adjoining.first() {
                    routes.push((*p, q, edges[*index].2.clone()));
                }
            }
        }
    }
    let mut anchors: BTreeSet<_> = terminals.keys().copied().collect();
    anchors.extend(
        adjacent
            .iter()
            .filter(|(_, e)| e.len() != 2)
            .map(|(p, _)| *p),
    );
    let mut used = BTreeSet::new();
    let mut paths = Vec::new();
    for start in &anchors {
        for initial in adjacent.get(start).into_iter().flatten() {
            if used.contains(initial) {
                continue;
            }
            let mut path = vec![*start];
            let mut p = *start;
            let mut i = *initial;
            let bundle = edges[i].2.clone();
            loop {
                used.insert(i);
                let (a, b, _) = &edges[i];
                p = if *a == p { *b } else { *a };
                path.push(p);
                if anchors.contains(&p) {
                    break;
                }
                i = *adjacent[&p]
                    .iter()
                    .find(|j| **j != i)
                    .ok_or("导线路径不完整")?;
            }
            paths.push((path, bundle));
        }
    }
    for (i, (a, b, bundle)) in edges.iter().enumerate() {
        if !used.contains(&i) {
            paths.push((vec![*a, *b], bundle.clone()));
        }
    }
    let mut kept = Vec::new();
    for (path, bundle) in paths {
        let a = path[0];
        let b = *path.last().unwrap();
        let p = moved.get(&a).copied().unwrap_or(Some(a));
        let q = moved.get(&b).copied().unwrap_or(Some(b));
        if let (Some(p), Some(q)) = (p, q) {
            if (p, q) == (a, b) {
                kept.extend(path.windows(2).map(|v| (v[0], v[1], bundle.clone())));
            } else if p != q {
                routes.push((p, q, bundle));
            }
        }
    }
    let bundles: BTreeMap<_, _> = scene
        .bundles
        .iter()
        .map(|b| {
            let bits = owner(&b.bits);
            (
                b.id.clone(),
                if bits.is_empty() {
                    vec![format!("floating:{}", b.id)]
                } else {
                    bits
                },
            )
        })
        .collect();
    let mut router = Router::new(components, &kept, &bundles)?;
    let previous: Vec<_> = scene
        .wires
        .iter()
        .map(|w| (point(w.from), point(w.to), w.bundle.clone()))
        .collect();
    let old_router = Router::new(&scene.components, &previous, &bundles)?;
    let newly_blocked: BTreeSet<_> = router
        .blocked
        .difference(&old_router.blocked)
        .copied()
        .collect();
    for (a, b, _) in &kept {
        if grid(*a, *b)?.iter().any(|p| newly_blocked.contains(p)) {
            return Err("封装会遮住父图中的其他连线，请缩小外形或先整理父图".into());
        }
    }
    for (a, b, bundle) in routes {
        let own = bundles.get(&bundle).ok_or("原生导线束缺失")?;
        for (p, q) in router.path(a, b, own)? {
            // Subtract collinear copper already retained on this same native bus.
            let mut cuts = BTreeSet::from([p, q]);
            for (x, y, bid) in &kept {
                if bid == &bundle {
                    for r in [*x, *y] {
                        if on(r, p, q) {
                            cuts.insert(r);
                        }
                    }
                }
            }
            let cuts: Vec<_> = cuts.into_iter().collect();
            for pair in cuts.windows(2) {
                let x = pair[0];
                let y = pair[1];
                if !kept
                    .iter()
                    .any(|(a, b, bid)| bid == &bundle && on(x, *a, *b) && on(y, *a, *b))
                {
                    kept.push((x, y, bundle.clone()));
                    router.add(x, y, own)?;
                }
            }
        }
    }
    Ok(kept
        .into_iter()
        .filter(|(a, b, _)| a != b)
        .map(|(a, b, _)| if a < b { (a, b) } else { (b, a) })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|(a, b)| (Point { x: a.0, y: a.1 }, Point { x: b.0, y: b.1 }))
        .collect())
}

pub fn assert_connections(pairs: &[(End, End)]) -> Result<()> {
    let mut forward = BTreeMap::new();
    let mut backward = BTreeMap::new();
    for (before, after) in pairs {
        for bit in 0..before.width.unwrap_or(0).min(after.width.unwrap_or(0)) {
            let a = before
                .bits
                .iter()
                .find(|b| b.bit == bit)
                .and_then(|b| b.net.as_ref())
                .ok_or("端口连接尚不明确，无法保持现有接线")?;
            let b = after
                .bits
                .iter()
                .find(|b| b.bit == bit)
                .and_then(|b| b.net.as_ref())
                .ok_or("端口连接尚不明确，无法保持现有接线")?;
            if forward.insert(a, b).is_some_and(|old| old != b) {
                return Err("接口调整会断开其他信号，请调整端口位置".into());
            }
            if backward.insert(b, a).is_some_and(|old| old != a) {
                return Err("接口调整会接错其他信号，请调整端口位置".into());
            }
        }
    }
    Ok(())
}
pub fn assert_isolated(scene: &Scene, terminals: &BTreeSet<Terminal>) -> Result<()> {
    let mut owners: BTreeMap<String, BTreeSet<Terminal>> = BTreeMap::new();
    for c in &scene.components {
        for e in &c.ends {
            for b in &e.bits {
                if let Some(net) = &b.net {
                    owners
                        .entry(net.clone())
                        .or_default()
                        .insert((c.id.clone(), e.index));
                }
            }
        }
    }
    for c in &scene.components {
        for e in &c.ends {
            let key = (c.id.clone(), e.index);
            if !terminals.contains(&key) {
                continue;
            }
            let connected = e
                .bits
                .iter()
                .filter_map(|b| b.net.as_ref())
                .any(|net| owners[net].iter().any(|t| t != &key));
            if connected
                || scene
                    .wires
                    .iter()
                    .any(|w| on(point(e.location), point(w.from), point(w.to)))
            {
                return Err("新增或断开的端口仍处在共享接点上；请先移动端口或整理该处连线".into());
            }
        }
    }
    Ok(())
}
pub fn assert_collision(before: &Scene, after: &[Component]) -> Result<()> {
    let old: BTreeMap<_, _> = before.components.iter().map(|c| (c.key(), c)).collect();
    let area = |a: &Bounds, b: &Bounds| {
        i64::from((a.x + a.width).min(b.x + b.width) - a.x.max(b.x)).max(0)
            * i64::from((a.y + a.height).min(b.y + b.height) - a.y.max(b.y)).max(0)
    };
    for (i, a) in after.iter().enumerate() {
        let original = old.get(&a.key());
        if original.is_some_and(|c| c.bounds == a.bounds) || a.factory == "Text" {
            continue;
        }
        for (j, b) in after.iter().enumerate() {
            if i == j || ["Text", "Tunnel"].contains(&b.factory.as_str()) {
                continue;
            }
            let previous = original
                .zip(old.get(&b.key()))
                .map(|(a, b)| area(&a.bounds, &b.bounds))
                .unwrap_or(0);
            if area(&a.bounds, &b.bounds) > previous {
                return Err("封装或新增引脚与其他元件重叠，请调整位置或尺寸".into());
            }
        }
    }
    Ok(())
}
