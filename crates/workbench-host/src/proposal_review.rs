use crate::{Host, Result, value};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use vibe_workspace_core::{Document, DocumentView, digest};
use xmltree::{Element, XMLNode};

#[derive(Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ProposalReview {
    before: DocumentView,
    after: DocumentView,
    current_revision: String,
    rows: Vec<ProposalChange>,
}
#[derive(Serialize, ts_rs::TS)]
pub struct ProposalChange {
    circuit: Option<String>,
    kind: String,
    title: String,
    fields: Vec<ProposalField>,
}
#[derive(Serialize, ts_rs::TS)]
pub struct ProposalField {
    name: String,
    before: Option<String>,
    after: Option<String>,
}

impl Host {
    async fn proposal_documents(
        &self,
        id: &str,
        revision: &str,
        original: &str,
        xml: &str,
    ) -> Result<(Document, Document, String)> {
        if digest(original.as_bytes()) != revision {
            return Err("候选的原版本与生成时版本不匹配".into());
        }
        let workspace = self.workspace.lock().await;
        let current = workspace.get(id).map_err(|e| e.to_string())?;
        let name = current.view().map_err(|e| e.to_string())?.name;
        let parse = |bytes: &str| {
            let mut document = Document::from_bytes(
                name.clone(),
                current.path.clone(),
                bytes.as_bytes().to_vec(),
                false,
            )
            .map_err(|e| e.to_string())?;
            // Reuse content-addressed snapshots; never register a preview as an open document.
            document.id = format!("{id}-review");
            Ok::<_, String>(document)
        };
        Ok((parse(original)?, parse(xml)?, current.revision()))
    }
    pub(crate) async fn review_proposal(
        &self,
        id: &str,
        revision: &str,
        original: &str,
        xml: &str,
    ) -> Result<Value> {
        let (before, after, current_revision) =
            self.proposal_documents(id, revision, original, xml).await?;
        value(ProposalReview {
            before: before.view().map_err(|e| e.to_string())?,
            after: after.view().map_err(|e| e.to_string())?,
            current_revision,
            rows: changes(original, xml)?,
        })
    }
    pub(crate) async fn preview_proposal(
        &self,
        id: &str,
        revision: &str,
        original: &str,
        xml: &str,
        circuit: &str,
        candidate: bool,
    ) -> Result<Value> {
        let (before, after, _) = self.proposal_documents(id, revision, original, xml).await?;
        let doc = if candidate { after } else { before };
        let (path, view) = self.materialize(&doc)?;
        if !view.circuits.iter().any(|c| c.name == circuit) {
            return Ok(json!({"image":null,"missing":true,"warnings":[]}));
        }
        // Static observation/rendering uses CircuitWorker, independently of the live simulation.
        let mut native = self.native.lock().await;
        let observed = native.observe(&path, circuit).await?;
        let bounds = &observed["focus"]["bounds"];
        let x = bounds["x"].as_i64().ok_or("未获得原生电路边界")? - 24;
        let y = bounds["y"].as_i64().ok_or("未获得原生电路边界")? - 24;
        let width = (bounds["width"].as_u64().ok_or("未获得原生电路边界")? + 48).max(160);
        let height = (bounds["height"].as_u64().ok_or("未获得原生电路边界")? + 48).max(100);
        let viewport = vibe_logisim_adapter::Viewport {
            x: x.try_into().map_err(|_| "电路边界超出限制")?,
            y: y.try_into().map_err(|_| "电路边界超出限制")?,
            width: width.try_into().map_err(|_| "电路边界超出限制")?,
            height: height.try_into().map_err(|_| "电路边界超出限制")?,
            scale: (1400. / width as f64).min(900. / height as f64).min(2.),
        };
        let image = native.render(&path, circuit, viewport).await?;
        Ok(json!({"image":image,"missing":false,"warnings":observed["project"]["loaderMessages"]}))
    }
}
fn elements(node: &Element) -> impl Iterator<Item = &Element> {
    node.children.iter().filter_map(XMLNode::as_element)
}
fn attr<'a>(node: &'a Element, name: &str) -> &'a str {
    node.attributes.get(name).map(String::as_str).unwrap_or("")
}
// Attribute order and indentation are not structural changes. Unknown elements remain represented.
fn canonical(node: &Element) -> String {
    fn escaped(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    }
    let attributes = node
        .attributes
        .iter()
        .collect::<BTreeMap<_, _>>()
        .into_iter()
        .map(|(k, v)| format!(" {k}=\"{}\"", escaped(v)))
        .collect::<String>();
    let children = node
        .children
        .iter()
        .filter_map(|n| match n {
            XMLNode::Element(e) => Some(canonical(e)),
            XMLNode::Text(t) | XMLNode::CData(t) if !t.trim().is_empty() => Some(escaped(t)),
            _ => None,
        })
        .collect::<String>();
    if children.is_empty() {
        format!("<{}{attributes}/>", node.name)
    } else {
        format!("<{}{attributes}>{children}</{}>", node.name, node.name)
    }
}

fn settings(node: &Element, excluded: &[&str]) -> BTreeMap<String, String> {
    let mut result = node
        .attributes
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect::<BTreeMap<_, _>>();
    for e in elements(node).filter(|e| !excluded.contains(&e.name.as_str())) {
        let key = if e.name == "a" {
            attr(e, "name").to_owned()
        } else {
            format!("{} {}", e.name, attr(e, "name")).trim().to_owned()
        };
        let text = if e.name == "a"
            && e.attributes.keys().all(|k| k == "name" || k == "val")
            && elements(e).next().is_none()
        {
            e.attributes
                .get("val")
                .cloned()
                .unwrap_or_else(|| e.get_text().unwrap_or_default().into_owned())
        } else {
            canonical(e)
        };
        result
            .entry(key)
            .and_modify(|v| {
                v.push('\n');
                v.push_str(&text);
            })
            .or_insert(text);
    }
    result
}
fn fields(before: BTreeMap<String, String>, after: BTreeMap<String, String>) -> Vec<ProposalField> {
    before
        .keys()
        .chain(after.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|name| before.get(*name) != after.get(*name))
        .map(|name| ProposalField {
            name: match name.as_str() {
                "loc" => "位置",
                "lib" => "库",
                "label" => "标签",
                "facing" => "朝向",
                "width" => "位宽",
                other => other,
            }
            .into(),
            before: before.get(name).cloned(),
            after: after.get(name).cloned(),
        })
        .collect()
}
fn title(node: &Element) -> String {
    if node.name == "wire" {
        return format!("导线 {} → {}", attr(node, "from"), attr(node, "to"));
    }
    let label = elements(node)
        .find(|a| a.name == "a" && attr(a, "name") == "label")
        .map(|a| attr(a, "val"))
        .unwrap_or("");
    format!(
        "{}{} {}",
        attr(node, "name"),
        if label.is_empty() {
            String::new()
        } else {
            format!(" · {label}")
        },
        attr(node, "loc")
    )
}
fn wire_key(node: &Element) -> String {
    let mut points = [attr(node, "from"), attr(node, "to")];
    points.sort();
    let extra = settings(node, &[])
        .into_iter()
        .filter(|(k, _)| k != "from" && k != "to")
        .collect::<BTreeMap<_, _>>();
    format!("{points:?}{extra:?}")
}
fn object_changes(
    before: &Element,
    after: &Element,
    circuit: &str,
    tag: &str,
    rows: &mut Vec<ProposalChange>,
) {
    let mut old = elements(before)
        .filter(|e| e.name == tag)
        .collect::<Vec<_>>();
    let mut new = elements(after)
        .filter(|e| e.name == tag)
        .collect::<Vec<_>>();
    let key = |e: &Element| {
        if tag == "wire" {
            wire_key(e)
        } else {
            canonical(e)
        }
    };
    old.retain(|a| {
        if let Some(index) = new.iter().position(|b| key(a) == key(b)) {
            new.remove(index);
            false
        } else {
            true
        }
    });
    if tag == "comp" {
        for a in &mut old {
            let same_kind = |b: &&Element| {
                attr(a, "name") == attr(b, "name") && attr(a, "lib") == attr(b, "lib")
            };
            let exact_location = new
                .iter()
                .position(|b| same_kind(b) && attr(a, "loc") == attr(b, "loc"));
            if let Some(index) = exact_location {
                let b = new.remove(index);
                let changed = fields(settings(a, &[]), settings(b, &[]));
                if !changed.is_empty() {
                    rows.push(ProposalChange {
                        circuit: Some(circuit.into()),
                        kind: "modified".into(),
                        title: title(b),
                        fields: changed,
                    });
                }
                // Mark paired entries without relying on revision-local component ids.
                *a = before;
            }
        }
        old.retain(|e| e.name == tag);
    }
    for (kind, entries) in [("removed", old), ("added", new)] {
        for entry in entries {
            let content = settings(entry, &[]);
            let (before, after) = if kind == "removed" {
                (content, BTreeMap::new())
            } else {
                (BTreeMap::new(), content)
            };
            rows.push(ProposalChange {
                circuit: Some(circuit.into()),
                kind: kind.into(),
                title: title(entry),
                fields: fields(before, after),
            });
        }
    }
}
fn changes(original: &str, xml: &str) -> Result<Vec<ProposalChange>> {
    let before = Element::parse(original.as_bytes()).map_err(|e| e.to_string())?;
    let after = Element::parse(xml.as_bytes()).map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    let project = fields(
        settings(&before, &["circuit"]),
        settings(&after, &["circuit"]),
    );
    if !project.is_empty() {
        rows.push(ProposalChange {
            circuit: None,
            kind: "modified".into(),
            title: "工程设置与组件库".into(),
            fields: project,
        });
    }
    let old = elements(&before)
        .filter(|c| c.name == "circuit")
        .map(|c| (attr(c, "name"), c))
        .collect::<BTreeMap<_, _>>();
    let new = elements(&after)
        .filter(|c| c.name == "circuit")
        .map(|c| (attr(c, "name"), c))
        .collect::<BTreeMap<_, _>>();
    for name in old.keys().chain(new.keys()).collect::<BTreeSet<_>>() {
        match (old.get(name), new.get(name)) {
            (Some(a), Some(b)) => {
                let definition = fields(
                    settings(a, &["comp", "wire"]),
                    settings(b, &["comp", "wire"]),
                );
                if !definition.is_empty() {
                    rows.push(ProposalChange {
                        circuit: Some((*name).into()),
                        kind: "modified".into(),
                        title: "电路定义与外观".into(),
                        fields: definition,
                    });
                }
                object_changes(a, b, name, "comp", &mut rows);
                object_changes(a, b, name, "wire", &mut rows);
            }
            (a, b) => rows.push(ProposalChange {
                circuit: Some((*name).into()),
                kind: if a.is_some() { "removed" } else { "added" }.into(),
                title: format!("电路 {name}"),
                fields: vec![ProposalField {
                    name: "定义".into(),
                    before: a.map(|e| canonical(e)),
                    after: b.map(|e| canonical(e)),
                }],
            }),
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    const XML: &str = r#"<project source="2.7.1"><main name="main"/><circuit name="main"><a name="appearance" val="classic"/><comp name="Pin" lib="0" loc="(100,100)"><a name="label" val="A"/></comp><wire from="(100,100)" to="(150,100)"/></circuit></project>"#;
    #[test]
    fn identifies_component_settings_and_keeps_undirected_wires_equal() {
        let after = XML.replace("val=\"A\"", "val=\"B\"").replace(
            "from=\"(100,100)\" to=\"(150,100)\"",
            "to=\"(100,100)\" from=\"(150,100)\"",
        );
        let rows = changes(XML, &after).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, "modified");
        assert_eq!(rows[0].fields[0].name, "标签");
        assert_eq!(rows[0].fields[0].before.as_deref(), Some("A"));
        assert_eq!(rows[0].fields[0].after.as_deref(), Some("B"));
    }
    #[test]
    fn includes_unknown_definition_and_library_changes() {
        let after = XML
            .replace("<main", "<lib name=\"2\" desc=\"file#parts.circ\"/><main")
            .replace("</circuit>", "<appear><rect x=\"3\"/></appear></circuit>");
        let rows = changes(XML, &after).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].circuit.is_none());
        assert_eq!(rows[1].title, "电路定义与外观");
    }
}
