use super::topology::{self, Connectivity};
use crate::{
    ErrorCode, Host, Result,
    api::document::{EditResult, ErrorDetail, MovePreview, edit_result_for_move},
    timing,
};
use std::collections::HashSet;
use vibe_circuit_document::{Circuit, Document, Point, Wire};

struct MovePlan {
    candidate: Document,
    graph: Circuit,
    before: Connectivity,
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
        let (path, graph, mut candidate) = {
            let workspace = self.workspace.lock().await;
            let doc = workspace.get(id).map_err(|e| e.to_string())?;
            doc.check(revision).map_err(|e| e.to_string())?;
            let graph = doc
                .circuit_view(circuit)
                .map_err(|e| e.to_string())?
                .ok_or("找不到电路")?;
            (self.materialize(doc)?, graph, doc.clone())
        };
        let before = {
            let _observe = timing::span("move.connectivity.before");
            let bytes = self
                .native
                .lock()
                .await
                .connectivity_bytes(&path, circuit)
                .await?;
            Connectivity::parse(&bytes)?
        };
        let (ports, fixed_ports) = {
            let _ports = timing::span("move.ports");
            topology::ports(&graph, &before, ids)?
        };
        let _route = timing::span("move.route");
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
                let _diff = timing::span("move.preview.diff");
                let graph = plan
                    .candidate
                    .circuit_view(circuit)
                    .map_err(|e| e.to_string())?
                    .ok_or("找不到电路")?;
                // The preview is geometry only. Release still validates native bit
                // connectivity before committing; no preview writes a checkpoint
                // or an undo entry.
                let after: HashSet<_> = graph.wires.iter().map(segment).collect();
                let before: HashSet<_> = plan.graph.wires.iter().map(segment).collect();
                let removed: Vec<String> = plan
                    .graph
                    .wires
                    .iter()
                    .filter(|w| !after.contains(&segment(w)))
                    .map(|w| w.id.clone())
                    .collect();
                let added = graph
                    .wires
                    .iter()
                    .filter(|w| !before.contains(&segment(w)))
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
        let path = self.materialize(&plan.candidate)?;
        let after = {
            let _observe = timing::span("move.connectivity.after");
            let bytes = self
                .native
                .lock()
                .await
                .connectivity_bytes(&path, circuit)
                .await?;
            Connectivity::parse(&bytes)?
        };
        {
            let _check = timing::span("move.check");
            topology::preserved(&plan.graph, &plan.before, &after, ids, delta)?;
        }
        let mut workspace = self.workspace.lock().await;
        let current = workspace.get_mut(id).map_err(|e| e.to_string())?;
        current.check(revision).map_err(|e| e.to_string())?;
        if current.path != plan.candidate.path {
            return Err("文档位置已改变，请重新移动".into());
        }
        // Edits wait for each other, so the document is still the one the plan
        // cloned: the candidate, with the move as its newest undo step, is its
        // next state.
        *current = plan.candidate;
        let view = {
            let _view = timing::span("move.view");
            current.view().map_err(|e| e.to_string())?
        };
        let _selection = timing::span("move.selection");
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
        let wires = shown
            .map(|c| new_wires(&plan.graph.wires, &c.wires))
            .unwrap_or_default();
        Ok(edit_result_for_move(circuit, components, wires, view))
    }
}

/// The ids of the wires in `after` that `before` does not have: the segments
/// a move made. Wire ids follow file order, which shifts behind any wire a
/// reroute splits, so the wires are compared by geometry.
fn new_wires(before: &[Wire], after: &[Wire]) -> Vec<String> {
    let before: HashSet<_> = before.iter().map(segment).collect();
    after
        .iter()
        .filter(|w| !before.contains(&segment(w)))
        .map(|w| w.id.clone())
        .collect()
}

/// A wire's segment, whichever way the file writes it.
fn segment(wire: &Wire) -> (Point, Point) {
    if (wire.from.x, wire.from.y) <= (wire.to.x, wire.to.y) {
        (wire.from, wire.to)
    } else {
        (wire.to, wire.from)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(k: usize, from: (i32, i32), to: (i32, i32)) -> Wire {
        let point = |(x, y)| Point { x, y };
        Wire {
            id: format!("w{k}"),
            from: point(from),
            to: point(to),
        }
    }

    #[test]
    fn a_split_wire_selects_its_pieces_only() {
        let before = [
            wire(0, (0, 0), (100, 0)),
            wire(1, (0, 50), (100, 50)),
            wire(2, (0, 90), (100, 90)),
        ];
        // The first wire gets a bend, which shifts the ids of the others.
        let after = [
            wire(0, (0, 0), (60, 0)),
            wire(1, (60, 10), (60, 0)),
            wire(2, (0, 50), (100, 50)),
            wire(3, (100, 90), (0, 90)),
        ];
        assert_eq!(new_wires(&before, &after), ["w0", "w1"]);
    }
}
