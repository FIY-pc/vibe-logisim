use crate::{Host, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use vibe_logisim_adapter::xml;
use xmltree::{Element, XMLNode};

#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
pub struct TestVector {
    pub inputs: BTreeMap<String, u32>,
    #[serde(default)]
    pub expected: BTreeMap<String, u32>,
}
#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
pub struct TraceWatch {
    pub component: String,
    pub port: u32,
}
#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
pub struct InputEvent {
    pub tick: u32,
    pub input: String,
    pub value: u32,
}
pub struct TraceProgram {
    pub ticks: u32,
    pub inputs: BTreeMap<String, u32>,
    pub watches: Vec<TraceWatch>,
    pub events: Vec<InputEvent>,
}
fn input_nodes(inputs: &BTreeMap<String, u32>) -> Result<Vec<Element>> {
    if inputs.len() > 256
        || inputs
            .keys()
            .any(|name| name.is_empty() || name.len() > 256)
    {
        return Err("输入必须使用有效引脚标签，最多 256 个".into());
    }
    Ok(inputs
        .iter()
        .map(|(name, value)| {
            xml(
                "input",
                &[("name", name.clone()), ("value", value.to_string())],
                vec![],
            )
        })
        .collect())
}
fn children(node: &Element) -> impl Iterator<Item = &Element> {
    node.children.iter().filter_map(XMLNode::as_element)
}
fn outputs(row: &Element) -> BTreeMap<String, Value> {
    children(row)
        .map(|out| {
            let value = out
                .attributes
                .get("value")
                .and_then(|s| s.parse::<u32>().ok());
            (
                out.attributes.get("name").cloned().unwrap_or_default(),
                json!({"bits":out.attributes.get("bits"), "value":value}),
            )
        })
        .collect()
}
impl Host {
    pub(crate) async fn verify_vectors(
        &self,
        id: &str,
        revision: &str,
        circuit: &str,
        vectors: Vec<TestVector>,
    ) -> Result<Value> {
        if vectors.is_empty() || vectors.len() > 256 {
            return Err("请提供 1–256 组测试向量".into());
        }
        let (artifact, view) = self.snapshot(id, revision).await?;
        let selected = view
            .circuits
            .iter()
            .find(|c| c.name == circuit)
            .ok_or("找不到电路")?;
        for vector in &vectors {
            if vector.expected.keys().any(|name| {
                !selected.components.iter().any(|c| {
                    c.name == "Pin"
                        && c.attributes.get("output").is_some_and(|v| v == "true")
                        && c.attributes.get("label") == Some(name)
                })
            }) {
                return Err("预期输出必须使用输出引脚的标签".into());
            }
        }
        let rows = vectors
            .iter()
            .map(|v| input_nodes(&v.inputs).map(|inputs| xml("vector", &[], inputs)))
            .collect::<Result<Vec<_>>>()?;
        let result = self
            .verifier
            .lock()
            .await
            .evaluate(
                &artifact,
                xml("simulate", &[("circuit", circuit.into())], rows),
            )
            .await?;
        let returned: Vec<_> = children(&result).filter(|n| n.name == "vector").collect();
        if returned.len() != vectors.len() {
            return Err("原生仿真返回了不完整的向量结果".into());
        }
        let mut passed = 0;
        let mut failed = 0;
        let mut unchecked = 0;
        let rows: Vec<_> = returned.into_iter().zip(vectors).enumerate().map(|(index, (row, vector))| {
            let actual = outputs(row);
            let oscillating = row.attributes.get("oscillating").is_some_and(|v| v == "true");
            let matched = vector.expected.iter().all(|(key, value)| actual.get(key).is_some_and(|a| a["value"].as_u64() == Some(u64::from(*value))));
            let status = if oscillating || !matched { failed += 1; "failed" } else if vector.expected.is_empty() { unchecked += 1; "unchecked" } else { passed += 1; "passed" };
            json!({"index":index,"inputs":vector.inputs,"expected":vector.expected,"outputs":actual,"oscillating":oscillating,"status":status})
        }).collect();
        Ok(
            json!({"documentId":id,"revision":revision,"circuit":circuit,"runtime":result.attributes,"isolated":true,"passed":passed,"failed":failed,"unchecked":unchecked,"rows":rows}),
        )
    }
    pub(crate) async fn verify_trace(
        &self,
        id: &str,
        revision: &str,
        circuit: &str,
        program: TraceProgram,
    ) -> Result<Value> {
        let TraceProgram {
            ticks,
            inputs,
            watches,
            events,
        } = program;
        if !(1..=256).contains(&ticks)
            || watches.is_empty()
            || watches.len() > 16
            || events.len() > 1024
        {
            return Err("时序检查支持 1–256 tick、1–16 个观察端口及最多 1024 个输入事件".into());
        }
        let (artifact, view) = self.snapshot(id, revision).await?;
        let selected = view
            .circuits
            .iter()
            .find(|c| c.name == circuit)
            .ok_or("找不到电路")?;
        let mut nodes = input_nodes(&inputs)?;
        let mut seen = BTreeSet::new();
        for watch in watches {
            let key = format!("{}:{}", watch.component, watch.port);
            if !seen.insert(key.clone()) || watch.port > 255 {
                return Err("观察端口重复或无效".into());
            }
            let component = selected
                .components
                .iter()
                .find(|c| c.id == watch.component)
                .ok_or("观察元件已改变")?;
            nodes.push(xml(
                "watch",
                &[
                    ("name", key),
                    ("factory", component.name.clone()),
                    ("x", component.location.x.to_string()),
                    ("y", component.location.y.to_string()),
                    ("port", watch.port.to_string()),
                ],
                vec![],
            ));
        }
        for event in events {
            if event.tick > ticks || !inputs.contains_key(&event.input) {
                return Err("输入事件超出 tick 范围或未在初始输入中声明".into());
            }
            nodes.push(xml(
                "input-event",
                &[
                    ("name", event.input),
                    ("tick", event.tick.to_string()),
                    ("value", event.value.to_string()),
                ],
                vec![],
            ));
        }
        let result = self
            .verifier
            .lock()
            .await
            .evaluate(
                &artifact,
                xml(
                    "trace",
                    &[("circuit", circuit.into()), ("ticks", ticks.to_string())],
                    nodes,
                ),
            )
            .await?;
        let samples: Vec<_> = children(&result).filter(|r| r.name == "sample").map(|row| json!({"tick":row.attributes.get("tick").and_then(|s| s.parse::<u32>().ok()),"oscillating":row.attributes.get("oscillating").is_some_and(|v|v=="true"),"signals":outputs(row)})).collect();
        let completed = samples.len() == ticks as usize + 1
            && !samples.iter().any(|r| r["oscillating"] == true);
        Ok(
            json!({"documentId":id,"revision":revision,"circuit":circuit,"runtime":result.attributes,"isolated":true,"completed":completed,"requestedTicks":ticks,"samples":samples}),
        )
    }
}
