use std::collections::BTreeMap;
use vibe_workspace_core::{Document, Edit, Error, Point};

#[test]
fn external_reload_checks_both_versions_and_keeps_unsaved_draft_in_undo() {
    use vibe_workspace_core::{EMPTY_CIRCUIT, SourceStatus};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("source.circ");
    std::fs::write(&path, EMPTY_CIRCUIT).unwrap();
    let mut d = Document::open(&path).unwrap();
    d.edit(
        &d.revision(),
        "main",
        Edit::Wire {
            points: vec![Point { x: 10, y: 10 }, Point { x: 90, y: 10 }],
        },
    )
    .unwrap();
    let draft = d.bytes().to_vec();
    let draft_revision = d.revision();
    let external = EMPTY_CIRCUIT.replace(
        "</circuit>",
        "<wire from=\"(20,20)\" to=\"(40,20)\"/></circuit>",
    );
    std::fs::write(&path, &external).unwrap();
    let SourceStatus::Modified { revision } = d.source_status() else {
        panic!("external change not detected")
    };
    assert!(d.reload(&draft_revision, &revision, false).is_err());
    assert!(matches!(
        d.reload("outdated-draft", &revision, true),
        Err(Error::StaleRevision)
    ));
    assert!(matches!(
        d.reload(&draft_revision, "outdated-source", true),
        Err(Error::ExternalChange)
    ));
    assert_eq!(d.bytes(), draft);
    let id = d.id.clone();
    d.reload(&draft_revision, &revision, true).unwrap();
    assert_eq!(d.id, id);
    assert!(!d.dirty());
    assert_eq!(d.bytes(), external.as_bytes());
    d.undo(&d.revision()).unwrap();
    assert_eq!(d.bytes(), draft);
    assert!(d.dirty());
    assert_eq!(std::fs::read(&path).unwrap(), external.as_bytes());
    std::fs::write(&path, "broken XML").unwrap();
    assert!(
        d.reload(
            &d.revision(),
            &vibe_workspace_core::digest(b"broken XML"),
            true
        )
        .is_err()
    );
    assert_eq!(d.bytes(), draft);
    std::fs::remove_file(&path).unwrap();
    assert!(matches!(d.source_status(), SourceStatus::Missing));
    assert!(matches!(
        d.save(&d.revision(), None),
        Err(Error::ExternalChange)
    ));
    assert!(!path.exists());
}

#[test]
fn save_as_cannot_reuse_identity_of_another_open_document() {
    use vibe_workspace_core::{EMPTY_CIRCUIT, Workspace};
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("original.circ");
    let copy = dir.path().join("copy.circ");
    let checkpoint = dir.path().join("workspace.json");
    std::fs::write(&original, EMPTY_CIRCUIT).unwrap();
    let mut w = Workspace::default();
    let doc = w.open(&original).unwrap();
    let saved = w.save(&doc.id, &doc.revision, Some(&copy)).unwrap();
    assert_eq!(saved.id, doc.id);
    assert_eq!(saved.path.as_ref(), Some(&copy));
    let reopened = w.open(&original).unwrap();
    assert_ne!(reopened.id, doc.id);
    assert_eq!(w.documents.len(), 2);
    assert_eq!(w.get(&doc.id).unwrap().path.as_ref(), Some(&copy));
    assert!(w.save(&doc.id, &doc.revision, Some(&original)).is_err());
    w.checkpoint(&checkpoint).unwrap();
    let mut recovered = Workspace::restore(&checkpoint).unwrap();
    recovered.close(&doc.id, false).unwrap();
    assert_eq!(recovered.open(&copy).unwrap().id, doc.id);
    assert_eq!(recovered.open(&original).unwrap().id, reopened.id);
}
#[test]
fn free_wires_roundtrip_and_history_preserves_exact_original() {
    let mut d = Document::new("wire.circ".into());
    let original = d.bytes().to_vec();
    let rev = d.revision();
    d.edit(
        &rev,
        "main",
        Edit::Wire {
            points: vec![
                Point { x: 10, y: 10 },
                Point { x: 100, y: 10 },
                Point { x: 100, y: 80 },
            ],
        },
    )
    .unwrap();
    assert_eq!(d.view().unwrap().circuits[0].wires.len(), 2);
    assert!(matches!(d.undo(&rev), Err(Error::StaleRevision)));
    d.undo(&d.revision()).unwrap();
    assert_eq!(d.bytes(), original);
    d.redo(&d.revision()).unwrap();
    assert_eq!(d.view().unwrap().circuits[0].wires.len(), 2);
}
#[test]
fn failed_edit_does_not_partially_apply() {
    let mut d = Document::new("x.circ".into());
    let original = d.bytes().to_vec();
    let result = d.edit(
        &d.revision(),
        "main",
        Edit::Wire {
            points: vec![
                Point { x: 0, y: 0 },
                Point { x: 100, y: 0 },
                Point { x: 120, y: 20 },
            ],
        },
    );
    assert!(result.is_err());
    assert_eq!(d.bytes(), original);
    assert!(!d.view().unwrap().can_undo);
}
#[test]
fn save_rejects_external_changes_and_never_overwrites_other_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.circ");
    let mut d = Document::new("a.circ".into());
    d.save(&d.revision(), Some(&path)).unwrap();
    assert!(!d.dirty());
    d.edit(
        &d.revision(),
        "main",
        Edit::Wire {
            points: vec![Point { x: 0, y: 0 }, Point { x: 100, y: 0 }],
        },
    )
    .unwrap();
    std::fs::write(&path, b"external change").unwrap();
    assert!(matches!(
        d.save(&d.revision(), None),
        Err(Error::ExternalChange)
    ));
    assert_eq!(std::fs::read(&path).unwrap(), b"external change");
    let other = dir.path().join("other.circ");
    std::fs::write(&other, b"keep me").unwrap();
    assert!(d.save(&d.revision(), Some(&other)).is_err());
    assert_eq!(std::fs::read(&other).unwrap(), b"keep me");
}
#[test]
fn rename_updates_subcircuit_references_but_not_builtin_names() {
    let mut d = Document::new("x.circ".into());
    d.edit(
        &d.revision(),
        "main",
        Edit::AddCircuit {
            name: "child".into(),
        },
    )
    .unwrap();
    d.edit(
        &d.revision(),
        "main",
        Edit::Place {
            name: "child".into(),
            library: None,
            location: Point { x: 200, y: 100 },
            attributes: BTreeMap::new(),
        },
    )
    .unwrap();
    d.edit(
        &d.revision(),
        "child",
        Edit::RenameCircuit {
            name: "renamed".into(),
        },
    )
    .unwrap();
    assert_eq!(d.view().unwrap().circuits[0].components[0].name, "renamed");
    assert!(
        d.edit(&d.revision(), "renamed", Edit::DeleteCircuit)
            .is_err()
    );
}
#[test]
fn unknown_xml_and_memory_contents_survive_edits() {
    let source = vibe_workspace_core::EMPTY_CIRCUIT
        .replace(
            "<options/>",
            "<options custom=\"keep\"><a name=\"unrecognized\" val=\"value\"/></options>",
        )
        .replace(
            "</circuit>",
            "<appear><circ-port x=\"5\" y=\"7\"/></appear><!-- keep comment --></circuit>",
        );
    let mut d = Document::from_bytes("x.circ".into(), None, source.into_bytes(), false).unwrap();
    d.edit(
        &d.revision(),
        "main",
        Edit::Wire {
            points: vec![Point { x: 0, y: 0 }, Point { x: 10, y: 0 }],
        },
    )
    .unwrap();
    let source = String::from_utf8_lossy(d.bytes());
    assert!(source.contains("unrecognized"));
    assert!(source.contains("circ-port"));
    assert!(source.contains("keep comment"));
}

#[test]
fn recovery_and_reopening_keep_identity_without_saving_drafts() {
    use vibe_workspace_core::Workspace;
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("example.circ");
    let checkpoint = directory.path().join("workspace.json");
    let mut w = Workspace::default();
    let id = w.insert(Document::new("example.circ".into())).unwrap().id;
    let d = w.get_mut(&id).unwrap();
    d.save(&d.revision(), Some(&file)).unwrap();
    let original = std::fs::read(&file).unwrap();
    d.edit(
        &d.revision(),
        "main",
        Edit::Wire {
            points: vec![Point { x: 0, y: 0 }, Point { x: 50, y: 0 }],
        },
    )
    .unwrap();
    let revision = d.revision();
    w.checkpoint(&checkpoint).unwrap();
    let mut recovered = Workspace::restore(&checkpoint).unwrap();
    assert_eq!(recovered.get(&id).unwrap().revision(), revision);
    assert!(recovered.get(&id).unwrap().view().unwrap().can_undo);
    assert_eq!(std::fs::read(&file).unwrap(), original);
    assert!(recovered.close(&id, false).is_err());
    recovered.close(&id, true).unwrap();
    recovered.checkpoint(&checkpoint).unwrap();
    let mut recovered = Workspace::restore(&checkpoint).unwrap();
    assert_eq!(recovered.open(&file).unwrap().id, id);
    assert_eq!(recovered.get(&id).unwrap().bytes(), original);
}

#[test]
fn multiline_memory_values_remain_text_nodes() {
    let mut d = Document::new("memory.circ".into());
    let contents = "addr/data: 8 8\n0: 01 02 03\n";
    d.edit(
        &d.revision(),
        "main",
        Edit::Place {
            name: "ROM".into(),
            library: Some("4".into()),
            location: Point { x: 100, y: 100 },
            attributes: BTreeMap::from([("contents".into(), contents.into())]),
        },
    )
    .unwrap();
    let original = d.view().unwrap().circuits[0].components[0].attributes["contents"].clone();
    let recovered =
        Document::from_bytes("memory.circ".into(), None, d.bytes().to_vec(), false).unwrap();
    assert_eq!(
        recovered.view().unwrap().circuits[0].components[0].attributes["contents"],
        original
    );
    assert!(String::from_utf8_lossy(d.bytes()).contains(">addr/data: 8 8\n"));
}

#[test]
fn save_as_overwrite_checks_target_and_open_document_identity() {
    use vibe_workspace_core::{Workspace, digest};
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.circ");
    let target = directory.path().join("target.circ");
    let mut workspace = Workspace::default();
    let doc = workspace
        .insert(Document::new("source.circ".into()))
        .unwrap();
    workspace
        .save(&doc.id, &doc.revision, Some(&source))
        .unwrap();
    let original = std::fs::read(&source).unwrap();
    std::fs::write(&target, &original).unwrap();
    let expected = digest(&original);
    assert!(
        workspace
            .save(&doc.id, &doc.revision, Some(&target))
            .is_err()
    );
    std::fs::write(&target, b"changed externally").unwrap();
    assert!(
        workspace
            .save_checked(&doc.id, &doc.revision, Some(&target), Some(&expected))
            .is_err()
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"changed externally");
    std::fs::write(&target, &original).unwrap();
    let open = workspace.open(&target).unwrap();
    assert!(
        workspace
            .save_checked(&doc.id, &doc.revision, Some(&target), Some(&expected))
            .is_err()
    );
    workspace.close(&open.id, false).unwrap();
    let saved = workspace
        .save_checked(&doc.id, &doc.revision, Some(&target), Some(&expected))
        .unwrap();
    assert_eq!(saved.id, doc.id);
    assert_eq!(saved.path.as_deref(), Some(target.as_path()));
    assert_ne!(workspace.open(&source).unwrap().id, doc.id);
    assert_eq!(std::fs::read(&source).unwrap(), original);
}

#[test]
fn save_as_rebases_external_libraries_and_history_without_changing_original() {
    let root = tempfile::tempdir().unwrap();
    let original = root.path().join("original");
    let copied = root.path().join("copied");
    std::fs::create_dir(&original).unwrap();
    std::fs::create_dir(&copied).unwrap();
    let path = original.join("main.circ");
    let xml = vibe_workspace_core::EMPTY_CIRCUIT.replace(
        "<main name=\"main\"/>",
        "<lib name=\"6\" desc=\"file#parts/logic.circ\"/><lib name=\"7\" desc=\"jar#parts/devices.jar#example.Devices\"/><main name=\"main\"/>",
    );
    std::fs::write(&path, &xml).unwrap();
    let mut d = Document::open(&path).unwrap();
    d.edit(
        &d.revision(),
        "main",
        Edit::Wire {
            points: vec![Point { x: 10, y: 10 }, Point { x: 50, y: 10 }],
        },
    )
    .unwrap();
    d.save(&d.revision(), Some(&copied.join("copy.circ")))
        .unwrap();
    let library = |d: &Document, id: &str| {
        d.view()
            .unwrap()
            .libraries
            .into_iter()
            .find(|l| l.id == id)
            .unwrap()
            .descriptor
    };
    assert_eq!(
        library(&d, "6"),
        format!(
            "file#{}",
            std::path::Path::new("..")
                .join("original/parts/logic.circ")
                .display()
        )
    );
    assert!(library(&d, "7").ends_with("#example.Devices"));
    let reference = library(&d, "6");
    d.undo(&d.revision()).unwrap();
    assert_eq!(library(&d, "6"), reference);
    assert!(d.view().unwrap().circuits[0].wires.is_empty());
    d.redo(&d.revision()).unwrap();
    assert_eq!(library(&d, "6"), reference);
    assert_eq!(d.view().unwrap().circuits[0].wires.len(), 1);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), xml);
}
