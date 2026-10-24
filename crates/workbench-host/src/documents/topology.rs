//! Compare native bit-net partitions using source component identity, never
//! coordinates as nets. Reads the worker's `connectivity` reply.
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use vibe_circuit_document::{Circuit, Point};

type Result<T> = std::result::Result<T, String>;
type Contact = (String, u64, u64);
type Partition = BTreeSet<Vec<Contact>>;

/// The native connectivity of one circuit.
#[derive(Deserialize)]
pub struct Connectivity {
    focus: Focus,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Focus {
    components: Vec<NativeComponent>,
    #[serde(default)]
    wire_bundles: Vec<Bundle>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeComponent {
    location: Point,
    factory_name: String,
    ends: Vec<End>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct End {
    index: u64,
    location: Point,
    /// Null when the runtime has not determined it.
    width: Option<u64>,
    net_bits: Option<Vec<Bit>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bit {
    bit: u64,
    net_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bundle {
    bundle_id: Option<String>,
    #[serde(default)]
    valid: bool,
    /// -1 while the runtime has not determined it.
    width: Option<i64>,
    #[serde(default)]
    points: Vec<Point>,
    bit_nets: Option<Vec<Bit>>,
}

impl Connectivity {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        serde_json::from_slice(bytes).map_err(|e| format!("无法读取原生元件连接：{e}"))
    }
}

/// The observed component of each source component, in source order. Moved
/// ones are looked for at their place plus `delta`.
fn components<'a>(
    graph: &Circuit,
    observed: &'a Connectivity,
    moved: &[String],
    delta: Point,
) -> Result<Vec<&'a NativeComponent>> {
    let all = &observed.focus.components;
    if all.len() != graph.components.len() {
        return Err("原生运行时未完整载入元件，移动未应用".into());
    }
    let mut at: HashMap<(i32, i32, &str), Vec<&NativeComponent>> = HashMap::new();
    for native in all {
        at.entry((native.location.x, native.location.y, &native.factory_name))
            .or_default()
            .push(native);
    }
    let moved: HashSet<&str> = moved.iter().map(String::as_str).collect();
    graph
        .components
        .iter()
        .map(|c| {
            let d = if moved.contains(c.id.as_str()) {
                delta
            } else {
                Point { x: 0, y: 0 }
            };
            let x = c.location.x.checked_add(d.x).ok_or("坐标越界")?;
            let y = c.location.y.checked_add(d.y).ok_or("坐标越界")?;
            match at.get(&(x, y, c.name.as_str())).map(Vec::as_slice) {
                Some([native]) => Ok(*native),
                _ => Err("有元件重叠，无法核对连接；移动未应用".into()),
            }
        })
        .collect()
}

pub fn ports(
    graph: &Circuit,
    observed: &Connectivity,
    moved: &[String],
) -> Result<(Vec<Point>, Vec<Point>)> {
    let all = components(graph, observed, &[], Point { x: 0, y: 0 })?;
    let moved: HashSet<&str> = moved.iter().map(String::as_str).collect();
    let (mut moving, mut fixed) = (Vec::new(), Vec::new());
    for (source, native) in graph.components.iter().zip(all) {
        let out = if moved.contains(source.id.as_str()) {
            &mut moving
        } else {
            &mut fixed
        };
        out.extend(native.ends.iter().map(|end| end.location));
    }
    Ok((moving, fixed))
}

fn partition(
    graph: &Circuit,
    observed: &Connectivity,
    moved: &[String],
    delta: Point,
) -> Result<Partition> {
    let all = components(graph, observed, moved, delta)?;
    // The first valid bundle through each point, and the first end of known
    // width at each point, in observation order.
    let mut bundles: HashMap<Point, &Bundle> = HashMap::new();
    for bundle in observed.focus.wire_bundles.iter().filter(|b| b.valid) {
        for point in &bundle.points {
            bundles.entry(*point).or_insert(bundle);
        }
    }
    let mut peers: HashMap<Point, (u64, Option<&[Bit]>)> = HashMap::new();
    for end in all.iter().flat_map(|native| &native.ends) {
        if let Some(width) = end.width {
            peers
                .entry(end.location)
                .or_insert((width, end.net_bits.as_deref()));
        }
    }
    let mut nets: BTreeMap<String, Vec<Contact>> = BTreeMap::new();
    for (source, native) in graph.components.iter().zip(&all) {
        for end in &native.ends {
            // Probe-like ports have no declared width. Resolve them through the runtime's
            // bundle membership; a geometric crossing alone is not a connection.
            let bundle = bundles.get(&end.location).copied();
            let bundle_width = bundle
                .and_then(|b| b.width)
                .and_then(|width| u64::try_from(width).ok());
            let (width, bits) = if let Some(width) = end.width {
                (width, end.net_bits.as_deref())
            } else if let (Some(bundle), Some(width)) = (bundle, bundle_width) {
                (width, bundle.bit_nets.as_deref())
            } else if let Some(&peer) = peers.get(&end.location) {
                peer
            } else {
                // Undriven probes/tunnels may have neither a declared nor an inferred width.
                // Compare their native bundle (or shared contact point) without inventing bits.
                let key = bundle
                    .and_then(|b| b.bundle_id.as_deref())
                    .map(|id| format!("unresolved:{id}"))
                    .unwrap_or_else(|| format!("point:{},{}", end.location.x, end.location.y));
                nets.entry(key)
                    .or_default()
                    .push((source.id.clone(), end.index, u64::MAX));
                continue;
            };
            let bits = bits.ok_or("原生位连接缺失")?;
            let indices: BTreeSet<_> = bits.iter().map(|b| b.bit).collect();
            if indices.len() != width as usize || indices.iter().any(|b| *b >= width) {
                return Err("原生连接信息不完整，移动未应用".into());
            }
            for bit in bits {
                let id = bit.net_id.as_deref().ok_or("原生位连接编号缺失")?;
                nets.entry(id.into())
                    .or_default()
                    .push((source.id.clone(), end.index, bit.bit));
            }
        }
    }
    Ok(nets
        .into_values()
        .map(|mut contacts| {
            contacts.sort();
            contacts
        })
        .collect())
}

pub fn preserved(
    graph: &Circuit,
    before: &Connectivity,
    after: &Connectivity,
    moved: &[String],
    delta: Point,
) -> crate::Result<()> {
    let before = partition(graph, before, &[], Point { x: 0, y: 0 })?;
    let after = partition(graph, after, moved, delta)?;
    if before == after {
        return Ok(());
    }
    // A part as a person finds it on the canvas: factory, label, place before the move.
    let port = |(id, end, _): &Contact| match graph.components.iter().find(|c| &c.id == id) {
        Some(c) => {
            let label = c
                .attributes
                .get("label")
                .filter(|l| !l.is_empty())
                .map(|l| format!(" “{l}”"))
                .unwrap_or_default();
            format!(
                "{}{label} ({},{}) 的端口 {end}",
                c.name, c.location.x, c.location.y
            )
        }
        None => format!("{id} 的端口 {end}"),
    };
    let error = |message: String| {
        crate::HostError::new(crate::ErrorCode::ConnectionsChanged, message)
            .with_hint("换一个位置；或先删掉这些导线，移动后再重新连接。括号里是元件移动前的位置。")
    };
    Err(match difference(&before, &after) {
        Some((joined, a, b)) => error(if joined {
            format!(
                "这个位置会把 {} 和 {} 接到一起，移动未应用。",
                port(&a),
                port(&b)
            )
        } else {
            format!("这个位置会断开 {} 和 {}，移动未应用。", port(&a), port(&b))
        })
        .with_context(serde_json::json!({
            "joined": joined,
            "ports": [[a.0, a.1], [b.0, b.1]],
        })),
        None => error("这个位置会改变端口连接，移动未应用。".into()),
    })
}

/// The first two ports a changed partition joins (true) or separates (false).
fn difference(before: &Partition, after: &Partition) -> Option<(bool, Contact, Contact)> {
    let index = |partition: &Partition| {
        let mut net = HashMap::new();
        for (i, contacts) in partition.iter().enumerate() {
            for c in contacts {
                net.insert(c.clone(), i);
            }
        }
        net
    };
    let (was, now) = (index(before), index(after));
    for (joined, nets, other) in [(true, after, &was), (false, before, &now)] {
        for contacts in nets {
            let first = &contacts[0];
            if let Some(c) = contacts.iter().find(|c| other.get(*c) != other.get(first)) {
                return Some((joined, first.clone(), c.clone()));
            }
        }
    }
    None
}
