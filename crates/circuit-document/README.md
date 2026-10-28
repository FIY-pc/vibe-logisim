# circuit-document

The `.circ` document as data: open, edit, undo, save, restore, with no UI, Java, Node or network dependency. Everything that must be true about a file regardless of who is editing it (person, AI, or a script) lives here.

## Owns

- Parsing and re-serialising `.circ` XML while keeping unknown nodes and attributes intact (`splice.rs`, `patch.rs`: edits are byte-range splices on the original text, never a full re-emit).
- Object identity, and the only ids in the product: component ids `c<x>_<y>` from the anchor point (`m` for a minus sign, `_2`, `_3`… for stacked copies on the same anchor), wire ids `w<n>` by file order. The native side and the window use these, not ids of their own (a circuit's `connections`, `symbols`, observations, edit selections). A part that did not move keeps its id across unrelated edits; a moved part keeps its id too when nothing else takes its anchor, since the id names what the file says.
- Revisions: `Document::revision()` is the content digest; every mutating call takes the caller's expected revision and fails with `StaleRevision` instead of applying partially.
- Edits (`Edit` enum in `document.rs`): wire, place, move, delete, attributes, addCircuit, renameCircuit, deleteCircuit, setMain, replace `{xml, title?}` (the whole file; `title` names the undo step, "整理布局" for an arrangement, else "替换电路内容"), and batch `{edits}`: wire, place, delete and attributes edits applied in order on one circuit as one change and one undo step ("放置 3 个元件"), selecting what each placed or drew. The JSON schema of this enum is exported for the AI runtime (`edit_schema()`).
- `move` is a pure translation of the selected components and wires: `loc` (and a custom appearance's `circ-port` pins) plus `from`/`to` move by the delta, and nothing else changes. Whether the wires Logisim would draw follow a moved part is the native side's answer (`translate` takes the wire edits it returns), not this crate's: Logisim's own `MoveGesture` decides, so the file ends up as it would after that drag in Logisim.
- `Revision` and `changes`: a snapshot of one revision that can be moved to another thread and asked for the per-circuit difference to a later revision (`CircuitChange`: removed component and wire ids, added components with their element text, unchanged-and-renamed pairs, the new wire list). This is what the native side is sent to keep its loaded project current; a difference that touches anything outside a circuit's components and wires (header, library list, circuit list or order, a circuit's attributes or appearance) is reported as none, and the caller sends the whole file.
- Undo and redo (`editing.rs`, `session.rs`), with a crash-safe recovery journal per open document (`journal.rs`: snapshot plus one record per change, synced in the background; a torn record is dropped on restart).
- Saving: atomic, with the on-disk baseline checked so an external change is reported (`ExternalChange`) rather than overwritten; Save As keeps the document identity and relocates relative library references (`relocate`).
- `Workspace`: the set of open documents keyed by stable id, with restore and persist of the session directory.
- `Folder`: the project folder (`id = "folder:" + sha256(path)`), path resolution that refuses escapes and cross-directory symlinks, listing, create, read, rename.
- `history.rs`: immutable content-addressed document history (append-only per document, patch against the predecessor when smaller), separate from undo.
- `symbol.rs`: subcircuit symbol (appearance) read and write, and `set_wires` for replacing a definition's wires.
- `junction.rs`: splitting wires at junctions so written files survive Logisim's load-time `WireRepair`.

## Does not own

Anything that needs the Java runtime (connectivity, port positions, rendering, simulation), the application state directory layout, agent or UI concerns. It also does not decide *when* a document is saved; the host does (auto-save policy).

## Public interface

```rust
pub struct Document;            // Document::new(name) | Document::open(path) | Document::from_bytes(..)
impl Document {
    fn view(&self) -> Result<DocumentView>;                       // id, name, path, revision, circuits (components, wires), libraries, dirty, canUndo/canRedo, main
    fn circuit_view(&self, name: &str) -> Result<Option<Circuit>>; // one circuit of `view`, without building the others (a 1 MB file has 20+)
    fn view_change(&self, base: &str, changed: &[String]) -> Result<DocumentChange>; // what a change from revision `base` made: `view`'s fields, `base`, `order` (every circuit name in file order) and only the `changed` circuits; applied to the view at `base` it gives `view`
    fn summary(&self) -> DocumentSummary;                         // id, name, path, revision, main, circuit names
    fn edit(&mut self, expected: &str, circuit: &str, edit: Edit) -> Result<EditOutcome>;  // EditOutcome.changed_circuits: circuits whose element text changed, or that are gone; undo and redo report theirs too
    fn translate(&mut self, expected: &str, circuit: &str, ids: &[String], delta: Point, wires: WireEdit) -> Result<EditOutcome>;
                                                                                                  // a move with the wire edits the native side's MoveGesture returned: select the moved parts' new ids
    fn snapshot(&self) -> Revision;                               // this revision for the native side: id, name, directory, bytes, library descriptors, circuits and their ids, and `changes` to a later one
    fn preview(&self, expected: &str, circuit: &str, edit: Edit) -> Result<Document>;  // what `edit` would make of this revision, this one unchanged; no history
    fn undo(&mut self, expected: &str) -> Result<EditOutcome>;
    fn redo(&mut self, expected: &str) -> Result<EditOutcome>;
    fn save(&mut self, expected: &str, target: Option<&Path>) -> Result<()>;
    fn save_checked(..);  fn reload(&mut self, expected, source_revision, discard) -> Result<()>;
    fn revision(&self) -> String;  fn dirty(&self) -> bool;  fn check(&self, expected) -> Result<()>;
    fn source_status(&self) -> SourceStatus;                       // in sync / changed on disk / missing
    fn bytes(&self) -> &[u8];  fn bytes_with_absolute_libraries(&self) -> Result<Cow<[u8]>>;
    fn relocate(&mut self, from: &Path, to: &Path);
}
pub struct Revision;            // document() revision name() directory() bytes() library_descriptors() source_version(); circuits() -> Vec<CircuitIds>; circuit(name); changes(&Revision) -> Option<Vec<CircuitChange>>
pub struct WireEdit { removed: Vec<String>, added: Vec<(Point, Point)> }   // wires a move takes out and the segments it adds, in file order
pub struct Workspace;           // insert, open(path) (reuses an open doc with the same path or identity), get, get_mut, save, save_checked, save_in_place, close, restore(dir), persist(dir), relocate
pub struct Folder { id, path, name }   // Folder::open(path); resolve(relative, existing) ; list ; create(relative, directory) ; read ; rename ; entry_path
pub mod history { DocumentHistory::new(root); append ; entries(id) ; find_revision(id, rev) ; resolve ; is_empty }
pub mod symbol  { read(native) -> Symbol ; write(..) ; assert_accepted(..) ; set_wires(root, circuit, segments) }
pub fn digest(bytes) -> String;  pub fn edit_schema() -> serde_json::Value;  pub fn flush_journals();
pub enum Error { InvalidDocument, InvalidCommand, StaleRevision, ExternalChange, Io, DocumentNotFound }
```

`DocumentView`, `DocumentChange`, `DocumentSummary`, `Edit`, `Point`, `Component`, `Wire`, `Circuit`, `Library`, `SourceStatus` derive `ts_rs::TS` and `schemars`; the TypeScript copies are generated by the host's `export-contract` binary. Change the Rust type, then run `npm run contracts`.

## Dependencies

`xmltree`/`quick-xml` for parsing, `similar` for history patches, `sha2`, `crc32fast`, `uuid`, `tempfile`, `serde`, `schemars`, `ts-rs`, `thiserror`. No other workspace crate.

## Invariants and Logisim pitfalls

- A `+`-shaped wire crossing is merged into one wire by Logisim's load-time WireRepair; trunks must be broken at the junction (T shapes are fine). `junction.rs` does this for written files; anything that writes XML without going through `Edit` must do the same.
- Logisim 2.7.1-era files put `trigger=high` on `<comp>`; the runtime silently drops such components. The loader-side recovery lives in the Java `NativeCircuitLoader.openChecked`, not here, but tests here must not "fix" such files on save.
- Component bodies are not grid-aligned: neighbours one grid step apart can graze by 1–8 px. Only an overlap of at least 10 px both ways counts as a collision.
- `(x, y, factory)` is the entire addressing protocol. Two identical components on the same anchor with identical attributes cannot be told apart; the `_k` suffix is a file-order tie-break, nothing more.
- Edits never partially apply. If a test needs a half-applied state, the design is wrong.
- Ids are a function of the file text, so two replicas of the same revision agree on them. `changes` may rely on that: a component that stays keeps its id, and a wire's id is its index in the circuit's wire list, so a wire keeps its id while the wires before it stay put.
- Logisim's loaded circuit has more wires than the file has `<wire>` elements: its load-time `WireRepair` splits wires at junctions. A document wire id therefore names a run of native wires, and the native side reports the whole run under that one id.

## Status

Done and stable. 17 unit tests plus `tests/{document,fidelity,folder}.rs` (`cargo test -p vibe-circuit-document`). The fidelity tests round-trip real course files byte-for-byte outside the edited range.

## Remaining tasks

None required for the rewrite. Candidates when the host needs them:

- `Edit::Replace` re-parses the whole file; if the AI arranger's replace of a 1 MB file shows up in profiles, add a per-circuit replace (`replaceCircuit { name, xml }`) that splices only that `<circuit>` element.

## Verify

```sh
cargo test -p vibe-circuit-document
npm run check:contracts
```
