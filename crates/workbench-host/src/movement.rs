use crate::{Host, Result, topology, value};
use serde_json::{Value, json};
use vibe_workspace_core::{Circuit, Document, Edit, Point};

struct MovePlan {
    candidate: Document,
    graph: Circuit,
    before: Value,
}
impl Host {
    async fn plan_move(
        &self,
        id: &str,
        revision: &str,
        circuit: &str,
        ids: &[String],
        delta: Point,
    ) -> Result<MovePlan> {
        let mut candidate = {
            let workspace = self.workspace.lock().await;
            let doc = workspace.get(id).map_err(|e| e.to_string())?;
            doc.check(revision).map_err(|e| e.to_string())?;
            doc.clone()
        };
        let (path, view) = self.materialize(&candidate)?;
        let graph = view
            .circuits
            .into_iter()
            .find(|c| c.name == circuit)
            .ok_or("找不到电路")?;
        let before = self.native.lock().await.observe(&path, circuit).await?;
        let (ports, fixed_ports) = topology::ports(&graph, &before, ids)?;
        candidate
            .move_connected(revision, circuit, ids.to_vec(), delta, ports, fixed_ports)
            .map_err(|e| e.to_string())?;
        Ok(MovePlan {
            candidate,
            graph,
            before,
        })
    }
    pub(crate) async fn preview_move(
        &self,
        id: &str,
        revision: &str,
        circuit: &str,
        ids: &[String],
        delta: Point,
    ) -> Result<Value> {
        let plan = self.plan_move(id, revision, circuit, ids, delta).await?;
        let workspace = self.workspace.lock().await;
        let current = workspace.get(id).map_err(|e| e.to_string())?;
        current.check(revision).map_err(|e| e.to_string())?;
        if current.path != plan.candidate.path {
            return Err("文档位置已改变，请重新移动".into());
        }
        let view = plan.candidate.view().map_err(|e| e.to_string())?;
        let graph = view
            .circuits
            .iter()
            .find(|c| c.name == circuit)
            .ok_or("找不到电路")?;
        // The preview is geometry only. Release still validates native bit connectivity
        // before committing; no preview writes a workspace checkpoint or undo entry.
        Ok(
            json!({"segments": graph.wires.iter().map(|w| json!({"from":w.from,"to":w.to})).collect::<Vec<_>>()}),
        )
    }
    pub(crate) async fn commit_move(
        &self,
        id: &str,
        revision: &str,
        circuit: &str,
        ids: &[String],
        delta: Point,
    ) -> Result<Value> {
        let plan = self.plan_move(id, revision, circuit, ids, delta).await?;
        let (path, _) = self.materialize(&plan.candidate)?;
        let after = self.native.lock().await.observe(&path, circuit).await?;
        topology::preserved(&plan.graph, &plan.before, &after, ids, delta)?;
        let mut workspace = self.workspace.lock().await;
        let current = workspace.get_mut(id).map_err(|e| e.to_string())?;
        current.check(revision).map_err(|e| e.to_string())?;
        if current.path != plan.candidate.path {
            return Err("文档位置已改变，请重新移动".into());
        }
        current
            .edit(
                revision,
                circuit,
                Edit::Replace {
                    xml: String::from_utf8(plan.candidate.bytes().to_vec())
                        .map_err(|e| e.to_string())?,
                },
            )
            .map_err(|e| e.to_string())?;
        value(current.view().map_err(|e| e.to_string())?)
    }
}
