use super::topology;
use crate::{
    ErrorCode, Host, Result,
    api::document::{EditResult, ErrorDetail, MovePreview, edit_result_for_move},
};
use serde_json::Value;
use vibe_circuit_document::{Circuit, Document, Edit, Point};

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
    /// The wires a move would remove and add, so the canvas draws only the
    /// difference. A failed plan is reported in `error`, not thrown, so the
    /// drag can continue and the status line shows the reason.
    pub(crate) async fn preview_move(
        &self,
        id: &str,
        revision: &str,
        circuit: &str,
        ids: &[String],
        delta: Point,
    ) -> Result<MovePreview> {
        match self.plan_move(id, revision, circuit, ids, delta).await {
            Ok(plan) => {
                let workspace = self.workspace.lock().await;
                let current = workspace.get(id).map_err(|e| e.to_string())?;
                current.check(revision).map_err(|e| e.to_string())?;
                if current.path != plan.candidate.path {
                    return Ok(preview_failure(
                        ErrorCode::StaleRevision,
                        "文档位置已改变，请重新移动",
                    ));
                }
                drop(workspace);
                let view = plan.candidate.view().map_err(|e| e.to_string())?;
                let graph = view
                    .circuits
                    .iter()
                    .find(|c| c.name == circuit)
                    .ok_or("找不到电路")?;
                // The preview is geometry only. Release still validates native bit
                // connectivity before committing; no preview writes a checkpoint
                // or an undo entry.
                let key = |from: Point, to: Point| {
                    if (from.x, from.y) <= (to.x, to.y) {
                        format!("{},{}:{},{}", from.x, from.y, to.x, to.y)
                    } else {
                        format!("{},{}:{},{}", to.x, to.y, from.x, from.y)
                    }
                };
                let after: std::collections::BTreeSet<String> =
                    graph.wires.iter().map(|w| key(w.from, w.to)).collect();
                let before: std::collections::BTreeSet<String> =
                    plan.graph.wires.iter().map(|w| key(w.from, w.to)).collect();
                let removed: Vec<String> = plan
                    .graph
                    .wires
                    .iter()
                    .filter(|w| !after.contains(&key(w.from, w.to)))
                    .map(|w| w.id.clone())
                    .collect();
                let added = graph
                    .wires
                    .iter()
                    .filter(|w| !before.contains(&key(w.from, w.to)))
                    .cloned()
                    .collect();
                Ok(MovePreview {
                    revision: Some(revision.to_string()),
                    delta: Some(delta),
                    removed_wires: removed,
                    added_wires: added,
                    error: None,
                })
            }
            // A rejected position is part of dragging, not a failed request;
            // a stale document is a real error the caller must recover from.
            Err(error)
                if matches!(
                    error.code,
                    ErrorCode::StaleRevision | ErrorCode::DocumentNotFound | ErrorCode::Io
                ) =>
            {
                Err(error)
            }
            Err(error) => Ok(preview_failure(error.code, &error.message)),
        }
    }
    pub(crate) async fn commit_move(
        &self,
        id: &str,
        revision: &str,
        circuit: &str,
        ids: &[String],
        delta: Point,
    ) -> Result<EditResult> {
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
        let view = current.view().map_err(|e| e.to_string())?;
        let shown = view.circuits.iter().find(|c| c.name == circuit);
        // Component ids name their location, so the moved ones are found again
        // at the old place plus the delta.
        let components = shown
            .map(|c| {
                ids.iter()
                    .filter_map(|id| {
                        let old = plan.graph.components.iter().find(|o| &o.id == id)?;
                        let at = Point {
                            x: old.location.x + delta.x,
                            y: old.location.y + delta.y,
                        };
                        c.components
                            .iter()
                            .find(|n| n.location == at && n.name == old.name)
                            .map(|n| n.id.clone())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        // Wires keep their ids by file order, so a move's changed wires are the
        // ones whose geometry differs plus any the move added.
        let wires = shown
            .map(|c| {
                c.wires
                    .iter()
                    .filter(|w| {
                        let index = w.id[1..].parse::<usize>().ok();
                        index
                            .and_then(|k| plan.graph.wires.get(k))
                            .is_none_or(|old| old.from != w.from || old.to != w.to)
                    })
                    .map(|w| w.id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(edit_result_for_move(circuit, components, wires, view))
    }
}

fn preview_failure(code: ErrorCode, message: &str) -> MovePreview {
    MovePreview {
        revision: None,
        delta: None,
        removed_wires: Vec::new(),
        added_wires: Vec::new(),
        error: Some(ErrorDetail {
            code,
            message: message.to_string(),
        }),
    }
}
