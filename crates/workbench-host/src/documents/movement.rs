//! Moves as Logisim makes them. On release Logisim's select tool asks
//! `MoveGesture` for the wires that keep the moved parts' ends connected to
//! what they were connected to, and applies the translation and that
//! replacement of wires as one action; the native side runs the same gesture
//! on the revision the move starts from, and the document applies its answer
//! as one undo step "移动 N 个对象". A part dropped onto a wire connects
//! there and one dragged off a wire leaves it, as in Logisim.
use crate::{
    Host, Result,
    api::document::{EditResult, edit_result},
    timing,
};
use vibe_circuit_document::{Edit, EditOutcome, Point, Revision, WireEdit};

impl Host {
    /// The wires the native side's `MoveGesture` removes and adds when `ids`
    /// move by `delta` in `revision`.
    async fn gesture(
        &self,
        revision: &Revision,
        circuit: &str,
        ids: &[String],
        delta: Point,
    ) -> Result<WireEdit> {
        let _gesture = timing::span("move.gesture");
        Ok(self
            .native
            .lock()
            .await
            .moves(revision, circuit, ids, delta, true)
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
        moves: &[(Vec<String>, Point)],
    ) -> Result<EditResult> {
        if let [(ids, delta)] = moves {
            let start = self.revision_at(id, revision).await?;
            let wires = self.gesture(&start, circuit, ids, *delta).await?;
            let mut workspace = self.workspace.lock().await;
            let current = workspace.get_mut(id)?;
            let outcome = {
                let _apply = timing::span("move.apply");
                current.translate(revision, circuit, ids, *delta, wires)?
            };
            let change = {
                let _view = timing::span("move.view");
                current.view_change(revision, &outcome.changed_circuits)?
            };
            return Ok(edit_result(&outcome, change, false));
        }
        let mut doc = {
            let workspace = self.workspace.lock().await;
            let doc = workspace.get(id)?;
            doc.check(revision)?;
            doc.clone()
        };
        let mut components = Vec::new();
        let mut wires = Vec::new();
        for (ids, delta) in moves {
            let edit = self.gesture(&doc.snapshot(), circuit, ids, *delta).await?;
            let step = doc.translate(&doc.revision(), circuit, ids, *delta, edit)?;
            components.extend(step.components);
            // Wire ids follow file order, which a later move may change.
            wires = step.wires;
        }
        let count: usize = moves.iter().map(|(ids, _)| ids.len()).sum();
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
        Ok(edit_result(&outcome, change, false))
    }
}
