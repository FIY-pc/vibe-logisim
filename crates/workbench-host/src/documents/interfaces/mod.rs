//! Frozen symbol drafts. Only a matching, natively checked preview may publish a revision.
mod routing;
use crate::{Host, Result, value};
use routing::{Bit, Changes, Component, End, Scene, point};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::{Path, PathBuf},
};
use vibe_circuit_document::{
    Document, Edit, SourceStatus, SymbolDraft, digest,
    symbol::{self, Symbol},
};
use vibe_logisim_runtime::{Native, Viewport, artifact_dependencies, encode_xml, xml};
use xmltree::Element;

#[derive(Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceRead {
    #[serde(flatten)]
    pub symbol: Symbol,
    pub id: String,
    pub revision: String,
    pub circuit: String,
    pub new_pin_location: vibe_circuit_document::Point,
}
#[derive(Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceImpact {
    pub circuit: String,
    pub instances: usize,
    pub moved_ports: usize,
    pub detached_ports: usize,
}
#[derive(Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct InterfacePreview {
    pub preview_id: String,
    pub id: String,
    pub revision: String,
    pub circuit: String,
    pub impacts: Vec<InterfaceImpact>,
    pub ports: usize,
    pub added_ports: usize,
    pub removed_ports: usize,
    pub changed: bool,
}
#[derive(Clone)]
struct Prepared {
    result: InterfacePreview,
    draft_digest: String,
    candidate: Document,
    path: Option<PathBuf>,
    dependencies: BTreeMap<PathBuf, String>,
}
#[derive(Default)]
pub(crate) struct Previews {
    items: VecDeque<Prepared>,
}
fn source_ready(doc: &Document) -> Result<()> {
    if !matches!(
        doc.source_status(),
        SourceStatus::Untitled | SourceStatus::Unchanged { .. }
    ) {
        return Err("磁盘工程已改变，请先处理外部改动".into());
    }
    Ok(())
}
fn draft_digest(draft: &SymbolDraft) -> Result<String> {
    let bytes = serde_json::to_vec(draft).map_err(|e| e.to_string())?;
    if bytes.len() > 1_000_000 {
        return Err("封装草稿超过大小限制".into());
    }
    Ok(digest(&bytes))
}
async fn native_symbol(native: &mut Native, path: &Path, circuit: &str) -> Result<Symbol> {
    let bytes = native
        .request(
            path,
            xml("interface", &[("circuit", circuit.into())], vec![]),
        )
        .await?;
    Ok(
        symbol::read(&Element::parse(bytes.as_slice()).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?,
    )
}
fn candidate(doc: &Document, root: &Element) -> Result<Document> {
    let mut result = Document::from_bytes(
        doc.view().map_err(|e| e.to_string())?.name,
        doc.path.clone(),
        encode_xml(root)?,
        false,
    )
    .map_err(|e| e.to_string())?;
    result.id = format!("{}-interface", doc.id);
    Ok(result)
}
type Correspondence = (Vec<Component>, Changes, Vec<(End, End)>);
fn correspondences(
    before: &Scene,
    after: &Scene,
    old_symbol: &Symbol,
    new_symbol: &Symbol,
    name: &str,
    circuit: &str,
    detached: &BTreeSet<String>,
) -> Result<Correspondence> {
    let mut components = after.components.clone();
    let mut lookup = BTreeMap::new();
    for (index, c) in components.iter_mut().enumerate() {
        if lookup.insert(c.key(), index).is_some() {
            return Err("有元件重叠，无法唯一核对端口".into());
        }
        for e in &mut c.ends {
            e.bits = (0..e.width.unwrap_or(0))
                .map(|bit| Bit {
                    bit,
                    net: Some(format!("new:{}:{}:{bit}", c.id, e.index)),
                })
                .collect();
        }
    }
    let mut pairs = Vec::new();
    let mut changes = BTreeMap::new();
    for old in &before.components {
        let key = old.key();
        let new_index = lookup.get(&key).copied();
        let usage = old_symbol
            .uses
            .iter()
            .find(|u| old.factory == name && u.circuit == circuit && (u.x, u.y) == key.1);
        let following = usage.and_then(|u| {
            new_symbol
                .uses
                .iter()
                .find(|n| n.circuit == u.circuit && n.x == u.x && n.y == u.y)
        });
        for end in &old.ends {
            let pin = if circuit == name && old.factory == "Pin" {
                Some(format!("{},{}", key.1.0, key.1.1))
            } else {
                usage.and_then(|u| {
                    u.ports
                        .iter()
                        .find(|(_, p)| p.index == end.index)
                        .map(|(pin, _)| pin.clone())
                })
            };
            if usage.is_some() && pin.is_none() {
                return Err("父图实例端口缺少原生 Pin 映射".into());
            }
            let target_index = if usage.is_some() {
                pin.as_ref()
                    .and_then(|pin| following.and_then(|u| u.ports.get(pin)))
                    .map(|p| p.index)
            } else {
                Some(end.index)
            };
            let next = new_index.and_then(|i| {
                target_index.and_then(|index| {
                    components[i]
                        .ends
                        .iter()
                        .position(|e| e.index == index)
                        .map(|e| (i, e))
                })
            });
            if next.is_none() || pin.as_ref().is_some_and(|pin| detached.contains(pin)) {
                changes.insert((old.id.clone(), end.index), None);
                continue;
            }
            let (ci, ei) = next.unwrap();
            let target = &mut components[ci].ends[ei];
            let actual = after.components[ci].ends[ei].clone();
            pairs.push((end.clone(), actual));
            for bit in &mut target.bits {
                if let Some(previous) = end.bits.iter().find(|old| old.bit == bit.bit) {
                    *bit = previous.clone();
                }
            }
            if target.location != end.location {
                changes.insert((old.id.clone(), end.index), Some(point(target.location)));
            }
        }
    }
    Ok((components, changes, pairs))
}
fn disconnected(
    scene: &Scene,
    before: &Symbol,
    after: &Symbol,
    name: &str,
    circuit: &str,
    detached: &BTreeSet<String>,
) -> BTreeSet<routing::Terminal> {
    let old_ids: BTreeSet<_> = before.draft.ports.iter().map(|p| p.id.as_str()).collect();
    let mut disconnected = detached.clone();
    disconnected.extend(
        after
            .draft
            .ports
            .iter()
            .filter(|p| !old_ids.contains(p.id.as_str()))
            .map(|p| p.id.clone()),
    );
    let mut terminals = BTreeSet::new();
    for c in &scene.components {
        if circuit == name
            && c.factory == "Pin"
            && disconnected.contains(&format!("{},{}", c.location.x, c.location.y))
        {
            terminals.extend(c.ends.iter().map(|e| (c.id.clone(), e.index)));
        }
        if c.factory == name
            && let Some(u) = after
                .uses
                .iter()
                .find(|u| u.circuit == circuit && u.x == c.location.x && u.y == c.location.y)
        {
            terminals.extend(
                u.ports
                    .iter()
                    .filter(|(pin, _)| disconnected.contains(*pin))
                    .map(|(_, p)| (c.id.clone(), p.index)),
            );
        }
    }
    terminals
}
impl Host {
    async fn interface_document(&self, id: &str, revision: &str) -> Result<Document> {
        let workspace = self.workspace.lock().await;
        let doc = workspace.get(id).map_err(|e| e.to_string())?;
        doc.check(revision).map_err(|e| e.to_string())?;
        source_ready(doc)?;
        Ok(doc.clone())
    }
    pub(crate) async fn read_interface(
        &self,
        id: &str,
        revision: &str,
        circuit: &str,
    ) -> Result<Value> {
        let doc = self.interface_document(id, revision).await?;
        let path = self.materialize(&doc)?;
        let mut native = self.native.lock().await;
        let symbol = native_symbol(&mut native, &path, circuit).await?;
        let observation = native.observe(&path, circuit).await?;
        let bounds = &observation["focus"]["bounds"];
        let y = bounds["y"].as_i64().unwrap_or(0) + bounds["height"].as_i64().unwrap_or(0);
        drop(native);
        self.interface_document(id, revision).await?;
        value(InterfaceRead {
            symbol,
            id: id.into(),
            revision: revision.into(),
            circuit: circuit.into(),
            new_pin_location: vibe_circuit_document::Point {
                x: 100,
                y: ((y.div_euclid(10) + 6) * 10).clamp(0, 6000) as i32,
            },
        })
    }
    pub(crate) async fn preview_interface(
        &self,
        id: &str,
        revision: &str,
        circuit: &str,
        draft: &SymbolDraft,
    ) -> Result<Value> {
        let fingerprint = draft_digest(draft)?;
        let doc = self.interface_document(id, revision).await?;
        let path = self.materialize(&doc)?;
        let dependencies = artifact_dependencies(&path)?;
        let mut native = self.native.lock().await;
        let before = native_symbol(&mut native, &path, circuit).await?;
        let mut root = Element::parse(doc.bytes()).map_err(|e| e.to_string())?;
        let updated =
            symbol::write(&mut root, circuit, &before, draft).map_err(|e| e.to_string())?;
        let detached: BTreeSet<_> = before
            .draft
            .ports
            .iter()
            .filter(|p| updated.get(&p.id).is_none_or(|p| p.disconnect))
            .map(|p| p.id.clone())
            .collect();
        let mut names = vec![circuit.to_owned()];
        for u in &before.uses {
            if !names.contains(&u.circuit) {
                names.push(u.circuit.clone());
            }
        }
        let initial = candidate(&doc, &root)?;
        let initial_path = self.materialize(&initial)?;
        let proposed = native_symbol(&mut native, &initial_path, circuit).await?;
        let mut scenes = BTreeMap::new();
        let mut impacts = Vec::new();
        for name in &names {
            let old_value = native.observe(&path, name).await?;
            let old = Scene::read(&old_value)?;
            let after = Scene::read(&native.observe(&initial_path, name).await?)?;
            let (components, changes, _) =
                correspondences(&old, &after, &before, &proposed, circuit, name, &detached)?;
            let bounds_changed = components.iter().any(|component| {
                old.components
                    .iter()
                    .find(|before| before.key() == component.key())
                    .is_none_or(|before| before.bounds != component.bounds)
            });
            if !changes.is_empty() || bounds_changed {
                let segments = routing::reconnect(&old, &components, &changes)
                    .map_err(|e| format!("{name}：{e}"))?;
                if !changes.is_empty() {
                    symbol::set_wires(&mut root, name, &segments).map_err(|e| e.to_string())?;
                }
            }
            routing::assert_collision(&old, &components).map_err(|e| format!("{name}：{e}"))?;
            impacts.push(InterfaceImpact {
                circuit: name.clone(),
                instances: before.uses.iter().filter(|u| u.circuit == *name).count(),
                moved_ports: changes.values().filter(|p| p.is_some()).count(),
                detached_ports: changes.values().filter(|p| p.is_none()).count(),
            });
            scenes.insert(name.clone(), (old, old_value));
        }
        let mut final_doc = candidate(&doc, &root)?;
        // Reading an unchanged default symbol must not publish serialization or appearance changes.
        if *draft == before.draft {
            final_doc = doc.clone();
        }
        let final_path = self.materialize(&final_doc)?;
        for name in &names {
            let after_value = native.observe(&final_path, name).await?;
            let after = Scene::read(&after_value)?;
            let (old, old_value) = &scenes[name];
            for key in ["invalidBundleEnds", "widthIncompatibilities"] {
                if after_value["coverage"][key].as_u64().unwrap_or(0)
                    > old_value["coverage"][key].as_u64().unwrap_or(0)
                {
                    return Err(format!(
                        "{name}：接线位宽不再匹配；请同步调整电路，或为更改的端口选择「断开接线」"
                    )
                    .into());
                }
            }
            let (_, _, pairs) =
                correspondences(old, &after, &before, &proposed, circuit, name, &detached)?;
            routing::assert_connections(&pairs).map_err(|e| format!("{name}：{e}"))?;
            routing::assert_isolated(
                &after,
                &disconnected(&after, &before, &proposed, circuit, name, &detached),
            )
            .map_err(|e| format!("{name}：{e}"))?;
        }
        let accepted = native_symbol(&mut native, &final_path, circuit).await?;
        symbol::assert_accepted(draft, &updated, &accepted).map_err(|e| e.to_string())?;
        drop(native);
        let current = self.interface_document(id, revision).await?;
        if current.path != doc.path || dependencies != artifact_dependencies(&path)? {
            return Err("文档位置或组件库已改变，请重新预览".into());
        }
        let old_ids: BTreeSet<_> = before.draft.ports.iter().map(|p| p.id.as_str()).collect();
        let new_ids: BTreeSet<_> = updated.keys().map(String::as_str).collect();
        let result = InterfacePreview {
            preview_id: uuid::Uuid::new_v4().to_string(),
            id: id.into(),
            revision: revision.into(),
            circuit: circuit.into(),
            impacts,
            ports: updated.len(),
            added_ports: new_ids.difference(&old_ids).count(),
            removed_ports: old_ids.difference(&new_ids).count(),
            changed: final_doc.revision() != revision,
        };
        let mut previews = self.interface_previews.lock().await;
        previews.items.push_back(Prepared {
            result: result.clone(),
            draft_digest: fingerprint,
            candidate: final_doc,
            path: doc.path,
            dependencies,
        });
        while previews.items.len() > 6 {
            previews.items.pop_front();
        }
        value(result)
    }
    pub(crate) async fn apply_interface(
        &self,
        id: &str,
        revision: &str,
        circuit: &str,
        preview_id: &str,
        draft: &SymbolDraft,
    ) -> Result<Value> {
        let fingerprint = draft_digest(draft)?;
        let mut workspace = self.workspace.lock().await;
        let current = workspace.get_mut(id).map_err(|e| e.to_string())?;
        current.check(revision).map_err(|e| e.to_string())?;
        source_ready(current)?;
        let mut previews = self.interface_previews.lock().await;
        let index = previews
            .items
            .iter()
            .position(|p| p.result.preview_id == preview_id)
            .ok_or("封装预览已失效，请重新预览")?;
        let prepared = &previews.items[index];
        if prepared.result.id != id
            || prepared.result.revision != revision
            || prepared.result.circuit != circuit
            || prepared.draft_digest != fingerprint
            || prepared.path != current.path
        {
            return Err("封装草稿或工程已经改变，请重新预览".into());
        }
        let path = self.materialize(current)?;
        if prepared.dependencies != artifact_dependencies(&path)? {
            return Err("组件库已改变，请重新预览".into());
        }
        if prepared.result.changed {
            current
                .edit(
                    revision,
                    circuit,
                    Edit::Replace {
                        xml: String::from_utf8(prepared.candidate.bytes().to_vec())
                            .map_err(|e| e.to_string())?,
                        title: Some("修改封装与接口".into()),
                    },
                )
                .map_err(|e| e.to_string())?;
        }
        previews.items.remove(index);
        value(current.view().map_err(|e| e.to_string())?)
    }
    pub(crate) async fn render_interface(
        &self,
        id: &str,
        revision: &str,
        preview_id: &str,
        circuit: &str,
    ) -> Result<Value> {
        let current = self.interface_document(id, revision).await?;
        let prepared = self
            .interface_previews
            .lock()
            .await
            .items
            .iter()
            .find(|p| {
                p.result.preview_id == preview_id
                    && p.result.id == id
                    && p.result.revision == revision
            })
            .cloned()
            .ok_or("封装预览已失效，请重新预览")?;
        if prepared.path != current.path {
            return Err("文档位置已改变，请重新预览".into());
        }
        let current_path = self.materialize(&current)?;
        if prepared.dependencies != artifact_dependencies(&current_path)? {
            return Err("组件库已改变，请重新预览".into());
        }
        if !prepared.result.impacts.iter().any(|i| i.circuit == circuit) {
            return Err("预览不包含这个电路".into());
        }
        let path = self.materialize(&prepared.candidate)?;
        let mut native = self.native.lock().await;
        let observed = native.observe(&path, circuit).await?;
        let b = &observed["focus"]["bounds"];
        let width = (b["width"].as_u64().unwrap_or(0) + 48).max(160);
        let height = (b["height"].as_u64().unwrap_or(0) + 48).max(100);
        let viewport = Viewport {
            x: (b["x"].as_i64().unwrap_or(0) - 24)
                .try_into()
                .map_err(|_| "预览范围过大")?,
            y: (b["y"].as_i64().unwrap_or(0) - 24)
                .try_into()
                .map_err(|_| "预览范围过大")?,
            width: width.try_into().map_err(|_| "预览范围过大")?,
            height: height.try_into().map_err(|_| "预览范围过大")?,
            scale: (1400. / width as f64).min(900. / height as f64).min(2.),
        };
        Ok(json!({"image":native.render(&path,circuit,viewport).await?,"circuit":circuit}))
    }
}
