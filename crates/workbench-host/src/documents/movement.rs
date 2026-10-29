//! Moves as Logisim makes them. On release Logisim's select tool asks
//! `MoveGesture` for the wires that keep the moved parts' ends connected to
//! what they touched, and applies the translation and that replacement of
//! wires as one action; the native side runs the same gesture on the
//! revision the move starts from, and the document applies its answer as one
//! undo step "移动 N 个对象". An end dropped onto a wire or a port connects
//! there; one dragged away keeps its connection through the wires the
//! gesture adds, unless the move detaches (Logisim's shift-drag) or the
//! gesture finds no route back, which leaves it unconnected.
use crate::{
    Host, Result,
    api::document::{EditResult, edit_result},
    timing,
};
use vibe_circuit_document::{Edit, EditOutcome, Point, Revision};
use vibe_logisim_runtime::MoveResult;

/// One move of a change: what moves, by how much, and whether its ends keep
/// what they touch.
pub(crate) struct Move {
    pub ids: Vec<String>,
    pub delta: Point,
    pub connect: bool,
}

impl Host {
    /// What the native side's `MoveGesture` makes of `ids` moving by `delta`
    /// in `revision`; nothing to rewire when the move detaches.
    async fn gesture(&self, revision: &Revision, circuit: &str, step: &Move) -> Result<MoveResult> {
        if !step.connect {
            return Ok(MoveResult::default());
        }
        let _gesture = timing::span("move.gesture");
        Ok(self
            .native
            .lock()
            .await
            .moves(revision, circuit, &step.ids, step.delta, true)
            .await?)
    }
    /// Moves, each by its own offset, as one change. Several are resolved in
    /// order, each on the result of the one before, and the document takes
    /// the last result as one undo step.
    pub(crate) async fn commit_moves(
        &self,
        id: &str,
        revision: &str,
        circuit: &str,
        moves: &[Move],
    ) -> Result<EditResult> {
        if let [step] = moves {
            let start = self.revision_at(id, revision).await?;
            let gesture = self.gesture(&start, circuit, step).await?;
            let mut workspace = self.workspace.lock().await;
            let current = workspace.get_mut(id)?;
            let outcome = {
                let _apply = timing::span("move.apply");
                current.translate(revision, circuit, &step.ids, step.delta, gesture.wires)?
            };
            let change = {
                let _view = timing::span("move.view");
                current.view_change(revision, &outcome.changed_circuits)?
            };
            let mut result = edit_result(&outcome, change, false);
            result.unconnected = gesture.unconnected;
            return Ok(result);
        }
        let mut doc = {
            let workspace = self.workspace.lock().await;
            let doc = workspace.get(id)?;
            doc.check(revision)?;
            doc.clone()
        };
        let mut components = Vec::new();
        let mut wires = Vec::new();
        let mut unconnected = Vec::new();
        for step in moves {
            let gesture = self.gesture(&doc.snapshot(), circuit, step).await?;
            let moved = doc.translate(
                &doc.revision(),
                circuit,
                &step.ids,
                step.delta,
                gesture.wires,
            )?;
            components.extend(moved.components);
            // Wire ids follow file order, which a later move may change.
            wires = moved.wires;
            unconnected.extend(gesture.unconnected);
        }
        let count: usize = moves.iter().map(|step| step.ids.len()).sum();
        let mut workspace = self.workspace.lock().await;
        let current = workspace.get_mut(id)?;
        let mut outcome = {
            let _apply = timing::span("move.apply");
            current.edit(
                revision,
                circuit,
                Edit::Replace {
                    xml: String::from_utf8(doc.bytes().to_vec()).map_err(|e| e.to_string())?,
                    title: Some(format!("移动 {count} 个对象")),
                },
            )?
        };
        if let Some(view) = current.circuit_view(circuit)? {
            components.retain(|id| view.components.iter().any(|c| &c.id == id));
            components.dedup();
            outcome = EditOutcome {
                components,
                wires,
                ..outcome
            };
        }
        let change = {
            let _view = timing::span("move.view");
            current.view_change(revision, &outcome.changed_circuits)?
        };
        let mut result = edit_result(&outcome, change, false);
        result.unconnected = unconnected;
        Ok(result)
    }
}
