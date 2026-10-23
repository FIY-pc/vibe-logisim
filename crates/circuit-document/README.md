# circuit-document

The `.circ` document as data: open, edit, undo, save, restore, with no UI, Java, Node or network dependency. Everything that must be true about a file regardless of who is editing it (person, AI, or a script) lives here.

## Owns

- Parsing and re-serialising `.circ` XML while keeping unknown nodes and attributes intact (`splice.rs`, `patch.rs`: edits are byte-range splices on the original text, never a full re-emit).
- Object identity: component ids `c<x>_<y>` from the anchor point (`m` for a minus sign, `_2`, `_3`… for stacked copies on the same anchor), wire ids `w<n>` by file order. A part that did not move keeps its id across unrelated edits; a moved or deleted part's old id is gone.
- Revisions: `Document::revision()` is the content digest; every mutating call takes the caller's expected revision and fails with `StaleRevision` instead of applying partially.
- Edits (`Edit` enum in `document.rs`): wire, place, move, delete, attributes, addCircuit, renameCircuit, deleteCircuit, setMain, replace. The JSON schema of this enum is exported for the AI runtime (`edit_schema()`).
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
    fn edit(&mut self, expected: &str, circuit: &str, edit: Edit) -> Result<EditOutcome>;
    fn preview(&self, expected: &str, circuit: &str, edit: Edit) -> Result<Document>;  // what `edit` would make of this revision, this one unchanged; no history
    fn undo(&mut self, expected: &str) -> Result<EditOutcome>;
    fn redo(&mut self, expected: &str) -> Result<EditOutcome>;
    fn save(&mut self, expected: &str, target: Option<&Path>) -> Result<()>;
    fn save_checked(..);  fn reload(&mut self, expected, source_revision, discard) -> Result<()>;
    fn revision(&self) -> String;  fn dirty(&self) -> bool;  fn check(&self, expected) -> Result<()>;
    fn source_status(&self) -> SourceStatus;                       // in sync / changed on disk / missing
    fn bytes(&self) -> &[u8];  fn bytes_with_absolute_libraries(&self) -> Result<Cow<[u8]>>;
    fn move_connected(..);                                         // selection move keeping attached wires; one undo step "移动 N 个对象". A wire with one end on a moved port follows it with the first shape that touches no other port or wire: a bend at its fixed end, a bend at its moved end, else a jog at the first free column or row; the host's connectivity check refuses what still joins nets
    fn relocate(&mut self, from: &Path, to: &Path);
}
pub struct Workspace;           // insert, open(path) (reuses an open doc with the same path or identity), get, get_mut, save, save_checked, save_in_place, close, restore(dir), persist(dir), relocate
pub struct Folder { id, path, name }   // Folder::open(path); resolve(relative, existing) ; list ; create(relative, directory) ; read ; rename ; entry_path
pub mod history { DocumentHistory::new(root); append ; entries(id) ; find_revision(id, rev) ; resolve ; is_empty }
pub mod symbol  { read(native) -> Symbol ; write(..) ; assert_accepted(..) ; set_wires(root, circuit, segments) }
pub fn digest(bytes) -> String;  pub fn edit_schema() -> serde_json::Value;  pub fn flush_journals();
pub enum Error { InvalidDocument, InvalidCommand, StaleRevision, ExternalChange, Io, DocumentNotFound }
```

`DocumentView`, `Edit`, `Point`, `Component`, `Wire`, `Circuit`, `Library`, `SourceStatus` derive `ts_rs::TS` and `schemars`; the TypeScript copies are generated by the host's `export-contract` binary. Change the Rust type, then run `npm run contracts`.

## Dependencies

`xmltree`/`quick-xml` for parsing, `similar` for history patches, `sha2`, `crc32fast`, `uuid`, `tempfile`, `serde`, `schemars`, `ts-rs`, `thiserror`. No other workspace crate.

## Invariants and Logisim pitfalls

- A `+`-shaped wire crossing is merged into one wire by Logisim's load-time WireRepair; trunks must be broken at the junction (T shapes are fine). `junction.rs` does this for written files; anything that writes XML without going through `Edit` must do the same.
- Logisim 2.7.1-era files put `trigger=high` on `<comp>`; the runtime silently drops such components. The loader-side recovery lives in the Java `NativeCircuitLoader.openChecked`, not here, but tests here must not "fix" such files on save.
- Component bodies are not grid-aligned: neighbours one grid step apart can graze by 1–8 px. Only an overlap of at least 10 px both ways counts as a collision.
- `(x, y, factory)` is the entire addressing protocol. Two identical components on the same anchor with identical attributes cannot be told apart; the `_k` suffix is a file-order tie-break, nothing more.
- Edits never partially apply. If a test needs a half-applied state, the design is wrong.

## Status

Done and stable. 17 unit tests plus `tests/{document,fidelity,folder}.rs` (`cargo test -p vibe-circuit-document`). The fidelity tests round-trip real course files byte-for-byte outside the edited range.

## Remaining tasks

None required for the rewrite. Candidates when the host needs them:

- `Edit::Replace { xml }` re-parses the whole file; if the AI arranger's replace of a 1 MB file shows up in profiles, add a per-circuit replace (`replaceCircuit { name, xml }`) that splices only that `<circuit>` element.

## Verify

```sh
cargo test -p vibe-circuit-document
npm run check:contracts
```
