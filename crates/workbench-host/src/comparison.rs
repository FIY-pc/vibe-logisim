//! Comparison-local component correspondence and native port-bit partitions.
use crate::{
    Host, Result,
    proposal_review::{ProposalChange, changes},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use vibe_workspace_core::{Component, Document, DocumentView, Point};

#[derive(Clone, Serialize, ts_rs::TS)]
pub struct ComparisonBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
#[derive(Clone, Serialize, ts_rs::TS)]
pub struct ComparisonObject {
    pub id: String,
    pub factory: String,
    pub label: String,
    pub location: Point,
    pub bounds: ComparisonBounds,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<Point>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub to: Option<Point>,
}
#[derive(Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionEndpoint {
    component_id: String,
    label: String,
    port: u32,
    port_name: String,
    bits: Vec<u32>,
    location: Point,
}
#[derive(Serialize, ts_rs::TS)]
pub struct ConnectionChange {
    id: String,
    before: Vec<Vec<ConnectionEndpoint>>,
    after: Vec<Vec<ConnectionEndpoint>>,
}
#[derive(Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct Connectivity {
    status: String,
    unknown_ports: usize,
    matched_components: usize,
    rows: Vec<ConnectionChange>,
}
#[derive(Serialize, ts_rs::TS)]
pub struct ParentUse {
    circuit: String,
    count: usize,
}
#[derive(Serialize, ts_rs::TS)]
pub struct ComparisonSides<T> {
    pub before: T,
    pub after: T,
}
#[derive(Serialize, ts_rs::TS)]
pub struct ComparisonDetail {
    circuit: String,
    connectivity: Connectivity,
    parents: ComparisonSides<Vec<ParentUse>>,
    objects: ComparisonSides<Vec<ComparisonObject>>,
    rows: Vec<ProposalChange>,
    errors: Vec<String>,
}
impl ComparisonDetail {
    pub fn unavailable(circuit: &str, error: String) -> Self {
        Self {
            circuit: circuit.into(),
            connectivity: Connectivity {
                status: "unavailable".into(),
                unknown_ports: 0,
                matched_components: 0,
                rows: vec![],
            },
            parents: ComparisonSides {
                before: vec![],
                after: vec![],
            },
            objects: ComparisonSides {
                before: vec![],
                after: vec![],
            },
            rows: vec![],
            errors: vec![error],
        }
    }
}
fn parents(view: &DocumentView, name: &str) -> Vec<ParentUse> {
    view.circuits
        .iter()
        .filter_map(|c| {
            let count = c
                .components
                .iter()
                .filter(|p| p.library.is_none() && p.name == name)
                .count();
            (count > 0).then(|| ParentUse {
                circuit: c.name.clone(),
                count,
            })
        })
        .collect()
}
fn same_kind(a: &Component, b: &Component) -> bool {
    a.name == b.name && a.library == b.library
}
fn label(c: &Component) -> &str {
    c.attributes.get("label").map(String::as_str).unwrap_or("")
}
fn pairs(before: &[Component], after: &[Component]) -> Vec<(usize, usize)> {
    let mut result = vec![];
    let mut used = BTreeSet::new();
    for pass in 0..3 {
        for (i, a) in before.iter().enumerate() {
            if result.iter().any(|(old, _)| *old == i) {
                continue;
            }
            let agrees = |b: &Component| {
                same_kind(a, b)
                    && match pass {
                        0 => a.location == b.location,
                        1 => !label(a).is_empty() && label(a) == label(b),
                        _ => a.attributes == b.attributes,
                    }
            };
            let options = after
                .iter()
                .enumerate()
                .filter(|(j, b)| !used.contains(j) && agrees(b))
                .collect::<Vec<_>>();
            if options.len() != 1 {
                continue;
            }
            let (j, b) = options[0];
            // Unique in both directions: duplicate labels do not establish identity.
            let reverse = before
                .iter()
                .enumerate()
                .filter(|(k, c)| {
                    !result.iter().any(|(old, _)| old == k)
                        && same_kind(c, b)
                        && match pass {
                            0 => c.location == b.location,
                            1 => !label(c).is_empty() && label(c) == label(b),
                            _ => c.attributes == b.attributes,
                        }
                })
                .count();
            if reverse == 1 {
                result.push((i, j));
                used.insert(j);
            }
        }
    }
    result
}
type Partition = BTreeMap<Vec<String>, Vec<ConnectionEndpoint>>;
fn side(
    graph: &[Component],
    observed: &Value,
    labels: &BTreeMap<usize, String>,
    side: usize,
) -> Result<(Vec<ComparisonObject>, Partition, usize)> {
    let natives = observed["focus"]["components"]
        .as_array()
        .ok_or("原生元件信息缺失")?;
    let mut objects = vec![];
    let mut nets: BTreeMap<String, Vec<(String, ConnectionEndpoint)>> = BTreeMap::new();
    let mut unknown = 0;
    for (i, c) in graph.iter().enumerate() {
        let native = natives
            .iter()
            .filter(|n| n["factoryName"] == c.name && n["location"] == json!(c.location))
            .collect::<Vec<_>>();
        if native.len() != 1 {
            unknown += 1;
            continue;
        }
        let n = native[0];
        let bounds = &n["bounds"];
        let integer = |key: &str| {
            bounds[key]
                .as_i64()
                .and_then(|v| i32::try_from(v).ok())
                .ok_or("无效原生元件边界")
        };
        objects.push(ComparisonObject {
            id: c.id.clone(),
            factory: c.name.clone(),
            label: label(c).into(),
            location: c.location,
            bounds: ComparisonBounds {
                x: integer("x")?,
                y: integer("y")?,
                width: integer("width")?,
                height: integer("height")?,
            },
            from: None,
            to: None,
        });
        let key = labels
            .get(&i)
            .cloned()
            .unwrap_or_else(|| format!("{side}:{}", c.id));
        for end in n["ends"].as_array().ok_or("原生端口信息缺失")? {
            let index = end["index"].as_u64().ok_or("无效端口索引")? as u32;
            let Some(width) = end["width"].as_u64().filter(|n| *n > 0 && *n <= 256) else {
                unknown += 1;
                continue;
            };
            let Some(bits) = end["netBits"].as_array() else {
                unknown += 1;
                continue;
            };
            if bits.len() != width as usize
                || (0..width).any(|bit| {
                    bits.iter()
                        .filter(|b| b["bit"] == bit && b["netId"].as_str().is_some())
                        .count()
                        != 1
                })
            {
                unknown += 1;
                continue;
            }
            let contract =
                json!([end["direction"], end["semanticRole"], end["runtimeTooltip"]]).to_string();
            for bit in bits {
                let b = bit["bit"].as_u64().unwrap() as u32;
                let endpoint = ConnectionEndpoint {
                    component_id: c.id.clone(),
                    label: if label(c).is_empty() {
                        c.name.clone()
                    } else {
                        label(c).into()
                    },
                    port: index,
                    port_name: end["runtimeTooltip"]
                        .as_str()
                        .or(end["semanticRole"].as_str())
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("端口 {index}")),
                    bits: vec![b],
                    location: serde_json::from_value(end["location"].clone())
                        .map_err(|_| "无效端口位置")?,
                };
                nets.entry(bit["netId"].as_str().unwrap().into())
                    .or_default()
                    .push((format!("{key}:{index}:{contract}:{b}"), endpoint));
            }
        }
    }
    for field in [
        "unknownWidthEnds",
        "invalidBundleEnds",
        "widthIncompatibilities",
    ] {
        unknown += observed["coverage"][field].as_u64().unwrap_or(0) as usize;
    }
    let partitions = nets
        .into_values()
        .map(|mut entries| {
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            (
                entries.iter().map(|(token, _)| token.clone()).collect(),
                entries.into_iter().map(|(_, e)| e).collect(),
            )
        })
        .collect();
    Ok((objects, partitions, unknown))
}
fn connection_changes(before: &Partition, after: &Partition) -> Vec<ConnectionChange> {
    let mut delta = before
        .keys()
        .filter(|key| !after.contains_key(*key))
        .map(|key| (false, key.clone()))
        .chain(
            after
                .keys()
                .filter(|key| !before.contains_key(*key))
                .map(|key| (true, key.clone())),
        )
        .collect::<Vec<_>>();
    let mut rows = vec![];
    while let Some(first) = delta.pop() {
        let mut group = vec![first];
        let mut tokens = group[0].1.iter().cloned().collect::<BTreeSet<_>>();
        loop {
            let mut found = false;
            delta.retain(|entry| {
                if entry.1.iter().any(|token| tokens.contains(token)) {
                    tokens.extend(entry.1.iter().cloned());
                    group.push(entry.clone());
                    found = true;
                    false
                } else {
                    true
                }
            });
            if !found {
                break;
            }
        }
        if group.iter().all(|(_, key)| key.len() < 2) {
            continue;
        }
        rows.push(ConnectionChange {
            id: format!("connection-{}", rows.len()),
            before: group
                .iter()
                .filter(|(side, _)| !*side)
                .filter_map(|(_, key)| before.get(key).cloned())
                .collect(),
            after: group
                .iter()
                .filter(|(side, _)| *side)
                .filter_map(|(_, key)| after.get(key).cloned())
                .collect(),
        });
    }
    rows
}
fn locate(row: &ProposalChange, objects: &[ComparisonObject], after: bool) -> Vec<String> {
    if (after && row.kind == "removed") || (!after && row.kind == "added") {
        return vec![];
    }
    let position = row.fields.iter().find(|f| f.name == "位置").and_then(|f| {
        if after {
            f.after.as_deref()
        } else {
            f.before.as_deref()
        }
    });
    objects
        .iter()
        .filter(|c| {
            if let (Some(from), Some(to)) = (c.from, c.to) {
                return row.title == format!("导线 ({},{}) → ({},{})", from.x, from.y, to.x, to.y);
            }
            let point = format!("({},{})", c.location.x, c.location.y);
            position.map_or_else(|| row.title.ends_with(&point), |p| p == point)
                && row.title.starts_with(&c.factory)
        })
        .map(|c| c.id.clone())
        .collect()
}
impl Host {
    pub(crate) async fn compare_documents(
        &self,
        before: &Document,
        after: &Document,
        circuit: &str,
    ) -> Result<ComparisonDetail> {
        let a = before.view().map_err(|e| e.to_string())?;
        let b = after.view().map_err(|e| e.to_string())?;
        let old = a
            .circuits
            .iter()
            .find(|c| c.name == circuit)
            .map(|c| c.components.as_slice())
            .unwrap_or(&[]);
        let new = b
            .circuits
            .iter()
            .find(|c| c.name == circuit)
            .map(|c| c.components.as_slice())
            .unwrap_or(&[]);
        let mut rows = changes(
            &String::from_utf8_lossy(before.bytes()),
            &String::from_utf8_lossy(after.bytes()),
        )?
        .into_iter()
        .filter(|r| r.circuit.as_deref() == Some(circuit))
        .collect::<Vec<_>>();
        let (old_path, _) = self.materialize(before)?;
        let (new_path, _) = self.materialize(after)?;
        let mut native = self.native.lock().await;
        let empty = json!({"focus":{"components":[]}});
        let observed = if a.circuits.iter().any(|c| c.name == circuit) {
            native.observe(&old_path, circuit).await
        } else {
            Ok(empty.clone())
        };
        let following = if b.circuits.iter().any(|c| c.name == circuit) {
            native.observe(&new_path, circuit).await
        } else {
            Ok(empty)
        };
        drop(native);
        let (observed, following) = match (observed, following) {
            (Ok(a), Ok(b)) => (a, b),
            (a, b) => {
                let mut detail = ComparisonDetail::unavailable(
                    circuit,
                    [a.err(), b.err()]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .join("；"),
                );
                detail.rows = rows;
                detail.parents = ComparisonSides {
                    before: parents(&a_view(before)?, circuit),
                    after: parents(&a_view(after)?, circuit),
                };
                return Ok(detail);
            }
        };
        let matched = pairs(old, new);
        let mut old_labels = BTreeMap::new();
        let mut new_labels = BTreeMap::new();
        for (i, (a, b)) in matched.iter().enumerate() {
            old_labels.insert(*a, format!("m{i}"));
            new_labels.insert(*b, format!("m{i}"));
        }
        let (mut old_objects, old_parts, old_unknown) = side(old, &observed, &old_labels, 0)?;
        let (mut new_objects, new_parts, new_unknown) = side(new, &following, &new_labels, 1)?;
        for (view, objects) in [(&a, &mut old_objects), (&b, &mut new_objects)] {
            if let Some(graph) = view.circuits.iter().find(|c| c.name == circuit) {
                for w in &graph.wires {
                    objects.push(ComparisonObject {
                        id: w.id.clone(),
                        factory: "wire".into(),
                        label: String::new(),
                        location: w.from,
                        bounds: ComparisonBounds {
                            x: w.from.x.min(w.to.x),
                            y: w.from.y.min(w.to.y),
                            width: w.from.x.abs_diff(w.to.x).min(i32::MAX as u32) as i32,
                            height: w.from.y.abs_diff(w.to.y).min(i32::MAX as u32) as i32,
                        },
                        from: Some(w.from),
                        to: Some(w.to),
                    });
                }
            }
        }
        for row in &mut rows {
            row.before_objects = locate(row, &old_objects, false);
            row.after_objects = locate(row, &new_objects, true);
        }
        let connections = connection_changes(&old_parts, &new_parts);
        let unknown = old_unknown + new_unknown;
        Ok(ComparisonDetail {
            circuit: circuit.into(),
            connectivity: Connectivity {
                status: if unknown > 0 {
                    "partial"
                } else if connections.is_empty() {
                    "unchanged"
                } else {
                    "changed"
                }
                .into(),
                unknown_ports: unknown,
                matched_components: matched.len(),
                rows: connections,
            },
            parents: ComparisonSides {
                before: parents(&a, circuit),
                after: parents(&b, circuit),
            },
            objects: ComparisonSides {
                before: old_objects,
                after: new_objects,
            },
            rows,
            errors: vec![],
        })
    }
}
fn a_view(d: &Document) -> Result<DocumentView> {
    Ok(d.view()?)
}
