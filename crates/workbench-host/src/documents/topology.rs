//! Compare native bit-net partitions using source component identity, never coordinates as nets.
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use vibe_circuit_document::{Circuit, Point};

type Result<T> = std::result::Result<T, String>;
type Contact = (String, u64, u64);
type Partition = BTreeSet<Vec<Contact>>;

fn components<'a>(
    graph: &Circuit,
    observation: &'a Value,
    moved: &[String],
    delta: Point,
) -> Result<Vec<&'a Value>> {
    let all = observation["focus"]["components"]
        .as_array()
        .ok_or("无法读取原生元件连接")?;
    if all.len() != graph.components.len() {
        return Err("原生运行时未完整载入元件，移动未应用".into());
    }
    graph
        .components
        .iter()
        .map(|c| {
            let d = if moved.contains(&c.id) {
                delta
            } else {
                Point { x: 0, y: 0 }
            };
            let x = c.location.x.checked_add(d.x).ok_or("坐标越界")?;
            let y = c.location.y.checked_add(d.y).ok_or("坐标越界")?;
            let found: Vec<_> = all
                .iter()
                .filter(|n| {
                    n["location"]["x"] == x && n["location"]["y"] == y && n["factoryName"] == c.name
                })
                .collect();
            if found.len() != 1 {
                return Err("有元件重叠，无法核对连接；移动未应用".into());
            }
            Ok(found[0])
        })
        .collect()
}

pub fn ports(
    graph: &Circuit,
    observation: &Value,
    moved: &[String],
) -> Result<(Vec<Point>, Vec<Point>)> {
    let all = components(graph, observation, &[], Point { x: 0, y: 0 })?;
    let (mut moving, mut fixed) = (Vec::new(), Vec::new());
    for (source, native) in graph.components.iter().zip(all.iter()) {
        let out = if moved.contains(&source.id) {
            &mut moving
        } else {
            &mut fixed
        };
        for end in native["ends"].as_array().ok_or("原生端口缺失")? {
            out.push(
                serde_json::from_value(end["location"].clone()).map_err(|_| "无效原生端口位置")?,
            );
        }
    }
    Ok((moving, fixed))
}

fn partition(
    graph: &Circuit,
    observation: &Value,
    moved: &[String],
    delta: Point,
) -> Result<Partition> {
    let all = components(graph, observation, moved, delta)?;
    let mut nets: BTreeMap<String, Vec<Contact>> = BTreeMap::new();
    for (source, native) in graph.components.iter().zip(all.iter()) {
        for end in native["ends"].as_array().ok_or("原生端口缺失")? {
            let index = end["index"].as_u64().ok_or("原生端口编号缺失")?;
            // Probe-like ports have no declared width. Resolve them through the runtime's
            // bundle membership; a geometric crossing alone is not a connection.
            let bundle = observation["focus"]["wireBundles"]
                .as_array()
                .and_then(|all| {
                    all.iter().find(|b| {
                        b["valid"] == true
                            && b["points"]
                                .as_array()
                                .is_some_and(|points| points.contains(&end["location"]))
                    })
                });
            let peer = all
                .iter()
                .flat_map(|n| n["ends"].as_array().into_iter().flatten())
                .find(|other| {
                    other["location"] == end["location"] && other["width"].as_u64().is_some()
                });
            let (width, bits) = if let Some(width) = end["width"].as_u64() {
                (width, end["netBits"].as_array())
            } else if let Some(bundle) = bundle.filter(|b| b["width"].as_u64().is_some()) {
                (
                    bundle["width"]
                        .as_u64()
                        .ok_or("端口位宽尚未确定，无法核对移动后的连接")?,
                    bundle["bitNets"].as_array(),
                )
            } else if let Some(peer) = peer {
                (peer["width"].as_u64().unwrap(), peer["netBits"].as_array())
            } else {
                // Undriven probes/tunnels may have neither a declared nor an inferred width.
                // Compare their native bundle (or shared contact point) without inventing bits.
                let key = bundle
                    .and_then(|b| b["bundleId"].as_str())
                    .map(|id| format!("unresolved:{id}"))
                    .unwrap_or_else(|| format!("point:{}", end["location"]));
                nets.entry(key)
                    .or_default()
                    .push((source.id.clone(), index, u64::MAX));
                continue;
            };
            let bits = bits.ok_or("原生位连接缺失")?;
            let indices: BTreeSet<_> = bits.iter().filter_map(|b| b["bit"].as_u64()).collect();
            if indices.len() != width as usize || indices.iter().any(|b| *b >= width) {
                return Err("原生连接信息不完整，移动未应用".into());
            }
            for bit in bits {
                let id = bit["netId"].as_str().ok_or("原生位连接编号缺失")?;
                nets.entry(id.into()).or_default().push((
                    source.id.clone(),
                    index,
                    bit["bit"].as_u64().ok_or("无效位编号")?,
                ));
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
    before: &Value,
    after: &Value,
    moved: &[String],
    delta: Point,
) -> Result<()> {
    let before = partition(graph, before, &[], Point { x: 0, y: 0 })?;
    let after = partition(graph, after, moved, delta)?;
    if before != after {
        return Err("这个位置会改变端口连接，移动未应用。请换一个位置。".into());
    }
    Ok(())
}
