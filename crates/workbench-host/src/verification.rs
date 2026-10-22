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
    /// Sample label; defaults to `component:port`.
    #[serde(default)]
    pub name: Option<String>,
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
#[derive(Clone, Debug, Deserialize, Serialize, ts_rs::TS)]
pub struct ButtonEvent {
    pub component: String,
    pub tick: u32,
    pub pressed: bool,
}
/// One trace run: initial inputs, stimulus per tick and the ports sampled.
pub struct TracePlan {
    pub ticks: u32,
    pub inputs: BTreeMap<String, u32>,
    pub watches: Vec<TraceWatch>,
    pub events: Vec<InputEvent>,
    pub buttons: Vec<ButtonEvent>,
    pub reset: Option<String>,
    /// ROM component id and the words loaded into it before the run.
    pub program: Option<(String, Vec<u32>)>,
}
#[derive(Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VerificationInput {
    Vectors {
        vectors: Vec<TestVector>,
    },
    Trace {
        ticks: u32,
        inputs: BTreeMap<String, u32>,
        watches: Vec<TraceWatch>,
        #[serde(default)]
        events: Vec<InputEvent>,
    },
}
#[derive(Clone, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct VerificationRecord {
    pub id: String,
    pub document_id: String,
    pub revision: String,
    pub base_revision: String,
    pub circuit: String,
    pub created_at: f64,
    pub kind: String,
    #[ts(type = "Record<string,string>")]
    pub runtime: Value,
    pub dependencies_verified: bool,
    #[ts(type = "any")]
    pub result: Value,
}
#[derive(Deserialize, Serialize)]
struct StoredVerification {
    record: VerificationRecord,
    dependencies: BTreeMap<std::path::PathBuf, String>,
    checksum: String,
}
fn verification_checksum(
    record: &VerificationRecord,
    dependencies: &BTreeMap<std::path::PathBuf, String>,
) -> Result<String> {
    Ok(vibe_workspace_core::digest(
        &serde_json::to_vec(&(record, dependencies)).map_err(|e| e.to_string())?,
    ))
}

impl Host {
    fn verification_directory(&self, id: &str) -> Result<std::path::PathBuf> {
        uuid::Uuid::parse_str(id).map_err(|_| "无效文档标识")?;
        Ok(self.state.join("verification-records").join(id))
    }
    pub(crate) fn verification_records(
        &self,
        id: &str,
        revision: &str,
    ) -> Result<Vec<VerificationRecord>> {
        let directory = self.verification_directory(id)?;
        if !directory.exists() {
            return Ok(vec![]);
        }
        let mut result = vec![];
        for file in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
            let path = file.map_err(|e| e.to_string())?.path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            let mut stored: StoredVerification =
                serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                    .map_err(|_| "原生验证记录无法读取，原记录已保留")?;
            if verification_checksum(&stored.record, &stored.dependencies)? != stored.checksum {
                return Err("原生验证记录内容已改变，不能作为运行证据".into());
            }
            if stored.record.document_id == id && stored.record.revision == revision {
                stored.record.dependencies_verified =
                    stored.dependencies.iter().all(|(path, expected)| {
                        std::fs::read(path)
                            .is_ok_and(|bytes| vibe_workspace_core::digest(&bytes) == *expected)
                    });
                result.push(stored.record);
            }
        }
        result.sort_by(|a, b| b.created_at.total_cmp(&a.created_at));
        Ok(result)
    }
    pub(crate) async fn verify_proposal(
        &self,
        id: &str,
        revision: &str,
        original: &str,
        xml: &str,
        circuit: &str,
        input: VerificationInput,
    ) -> Result<Value> {
        let (_, candidate, current) = self.proposal_documents(id, revision, original, xml).await?;
        if current != revision {
            return Err("原版本已改变，请先重新生成候选".into());
        }
        let (artifact, _) = self.materialize(&candidate)?;
        let dependencies = vibe_logisim_adapter::artifact_dependencies(&artifact)?;
        let kind = match &input {
            VerificationInput::Vectors { .. } => "vectors",
            VerificationInput::Trace { .. } => "trace",
        };
        let result = match input {
            VerificationInput::Vectors { vectors } => {
                self.verify_vectors_document(&candidate, circuit, vectors)
                    .await?
            }
            VerificationInput::Trace {
                ticks,
                inputs,
                watches,
                events,
            } => {
                self.verify_trace_document(
                    &candidate,
                    circuit,
                    TraceProgram {
                        ticks,
                        inputs,
                        watches,
                        events,
                    },
                )
                .await?
            }
        };
        if vibe_logisim_adapter::artifact_dependencies(&artifact)? != dependencies {
            return Err("验证期间组件库已改变，结果未留存".into());
        }
        let record = VerificationRecord {
            id: uuid::Uuid::new_v4().to_string(),
            document_id: id.into(),
            revision: candidate.revision(),
            base_revision: revision.into(),
            circuit: circuit.into(),
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as f64,
            kind: kind.into(),
            runtime: result["runtime"].clone(),
            dependencies_verified: true,
            result,
        };
        let directory = self.verification_directory(id)?;
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        use std::io::Write;
        let mut temp = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
        serde_json::to_writer(
            temp.as_file_mut(),
            &StoredVerification {
                checksum: verification_checksum(&record, &dependencies)?,
                record: record.clone(),
                dependencies,
            },
        )
        .map_err(|e| e.to_string())?;
        temp.flush().map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist_noclobber(directory.join(format!("{}.json", record.id)))
            .map_err(|e| e.to_string())?;
        crate::value(record)
    }
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
        let doc = self
            .workspace
            .lock()
            .await
            .get(id)
            .map_err(|e| e.to_string())?
            .clone();
        doc.check(revision).map_err(|e| e.to_string())?;
        self.verify_vectors_document(&doc, circuit, vectors).await
    }
    pub(crate) async fn verify_vectors_document(
        &self,
        doc: &vibe_workspace_core::Document,
        circuit: &str,
        vectors: Vec<TestVector>,
    ) -> Result<Value> {
        if vectors.is_empty() || vectors.len() > 256 {
            return Err("请提供 1–256 组测试向量".into());
        }
        let id = &doc.id;
        let revision = doc.revision();
        let (artifact, view) = self.materialize(doc)?;
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
            .simulation
            .verify(
                &artifact,
                xml("simulate", &[("circuit", circuit.into())], rows),
            )
            .await
            // The runtime's own text names what the check rejected; the generic
            // code text would lose it.
            .map_err(|error| error.detail().unwrap_or(&error.message).to_owned())?;
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
        let doc = self
            .workspace
            .lock()
            .await
            .get(id)
            .map_err(|e| e.to_string())?
            .clone();
        doc.check(revision).map_err(|e| e.to_string())?;
        self.verify_trace_document(&doc, circuit, program).await
    }
    pub(crate) async fn verify_trace_document(
        &self,
        doc: &vibe_workspace_core::Document,
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
        self.trace_document(
            doc,
            circuit,
            TracePlan {
                ticks,
                inputs,
                watches,
                events,
                buttons: Vec::new(),
                reset: None,
                program: None,
            },
        )
        .await
    }
    pub(crate) async fn trace_document(
        &self,
        doc: &vibe_workspace_core::Document,
        circuit: &str,
        plan: TracePlan,
    ) -> Result<Value> {
        let id = &doc.id;
        let revision = doc.revision();
        let TracePlan {
            ticks,
            inputs,
            watches,
            events,
            buttons,
            reset,
            program,
        } = plan;
        let stimulus = events.len() + buttons.len() + program.as_ref().map_or(0, |p| p.1.len());
        if !(1..=10000).contains(&ticks)
            || watches.is_empty()
            || watches.len() > 24
            || stimulus > 6000
        {
            return Err("时序检查支持 1–10000 tick、1–24 个观察端口及最多 6000 个刺激事件".into());
        }
        let (artifact, view) = self.materialize(doc)?;
        let selected = view
            .circuits
            .iter()
            .find(|c| c.name == circuit)
            .ok_or("找不到电路")?;
        let mut nodes = input_nodes(&inputs)?;
        let mut seen = BTreeSet::new();
        for watch in &watches {
            let key = watch
                .name
                .clone()
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| format!("{}:{}", watch.component, watch.port));
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
        if let Some(id) = &reset {
            let button = selected
                .components
                .iter()
                .find(|c| &c.id == id)
                .ok_or("找不到复位按钮")?;
            nodes.push(xml(
                "reset",
                &[
                    ("factory", button.name.clone()),
                    ("x", button.location.x.to_string()),
                    ("y", button.location.y.to_string()),
                ],
                vec![],
            ));
        }
        for event in &events {
            if event.tick > ticks || !inputs.contains_key(&event.input) {
                return Err("输入事件超出 tick 范围或未在初始输入中声明".into());
            }
            nodes.push(xml(
                "input-event",
                &[
                    ("name", event.input.clone()),
                    ("tick", event.tick.to_string()),
                    ("value", event.value.to_string()),
                ],
                vec![],
            ));
        }
        for button in &buttons {
            if button.tick > ticks {
                return Err("按钮事件超出 tick 范围".into());
            }
            let component = selected
                .components
                .iter()
                .find(|c| c.id == button.component)
                .ok_or("找不到按钮元件")?;
            nodes.push(xml(
                "button-event",
                &[
                    ("factory", component.name.clone()),
                    ("x", component.location.x.to_string()),
                    ("y", component.location.y.to_string()),
                    ("tick", button.tick.to_string()),
                    ("pressed", if button.pressed { "true" } else { "false" }.into()),
                ],
                vec![],
            ));
        }
        if let Some((rom_id, words)) = &program {
            if words.len() > 4096 {
                return Err("程序刺激最多 4096 个字".into());
            }
            let rom = selected
                .components
                .iter()
                .find(|c| &c.id == rom_id)
                .ok_or("找不到程序 ROM")?;
            let mut rom_node = xml(
                "program",
                &[
                    ("factory", rom.name.clone()),
                    ("x", rom.location.x.to_string()),
                    ("y", rom.location.y.to_string()),
                ],
                vec![],
            );
            rom_node.children = words
                .iter()
                .map(|word| {
                    XMLNode::Element(xml("word", &[("value", word.to_string())], vec![]))
                })
                .collect();
            nodes.push(rom_node);
        }
        let result = self
            .simulation
            .verify(
                &artifact,
                xml(
                    "trace",
                    &[("circuit", circuit.into()), ("ticks", ticks.to_string())],
                    nodes,
                ),
            )
            .await
            // The runtime's own text names what the check rejected; the generic
            // code text would lose it.
            .map_err(|error| error.detail().unwrap_or(&error.message).to_owned())?;
        let samples: Vec<_> = children(&result).filter(|r| r.name == "sample").map(|row| json!({"tick":row.attributes.get("tick").and_then(|s| s.parse::<u32>().ok()),"oscillating":row.attributes.get("oscillating").is_some_and(|v|v=="true"),"signals":outputs(row)})).collect();
        let completed = samples.len() == ticks as usize + 1
            && !samples.iter().any(|r| r["oscillating"] == true);
        Ok(
            json!({"documentId":id,"revision":revision,"circuit":circuit,"runtime":result.attributes,"isolated":true,"completed":completed,"requestedTicks":ticks,"samples":samples}),
        )
    }
}
