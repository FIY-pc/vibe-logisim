use crate::{Host, ReviewRequest, WorkspaceRequest};
use std::path::{Path, PathBuf};
use vibe_workspace_core::{Document, Edit, Point};

// Start with the ordinary path supplied by a launcher, even if TEMP itself was
// canonicalized. The host, not its caller or executable manifest, must normalize it.
fn launcher_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_str().unwrap();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.into()
}

fn deep_directory(base: &Path, name: &str) -> PathBuf {
    launcher_path(base)
        .join(format!("{name} 电路 with spaces"))
        .join("a".repeat(110))
        .join("b".repeat(110))
}

#[tokio::test]
async fn state_paths_preserve_long_snapshot_history_and_restart() {
    let temporary = tempfile::tempdir().unwrap();
    let state = deep_directory(temporary.path(), "state");
    let host = Host::new(temporary.path().into(), state.clone(), None).unwrap();
    let created = host
        .dispatch(WorkspaceRequest::New {
            name: "long-path.circ".into(),
        })
        .await
        .unwrap();
    assert!(created["historyWarning"].is_null(), "{created}");
    let id = created["id"].as_str().unwrap();
    let revision = created["revision"].as_str().unwrap();
    let (snapshot, _) = host.snapshot(id, revision).await.unwrap();
    assert!(snapshot.to_string_lossy().encode_utf16().count() > 260);
    #[cfg(windows)]
    assert!(snapshot.to_string_lossy().starts_with(r"\\?\"));
    let bytes = std::fs::read(&snapshot).unwrap();
    Document::from_bytes("snapshot.circ".into(), None, bytes.clone(), false).unwrap();
    assert_eq!(host.snapshot(id, revision).await.unwrap().0, snapshot);
    assert_eq!(std::fs::read(&snapshot).unwrap(), bytes);
    let history = host
        .dispatch(ReviewRequest::HistoryList { id: id.into() })
        .await
        .unwrap();
    assert_eq!(history["entries"].as_array().unwrap().len(), 1);
    drop(host);

    let restored = Host::new(temporary.path().into(), state, None).unwrap();
    assert_eq!(restored.snapshot(id, revision).await.unwrap().0, snapshot);
    let reloaded = restored
        .dispatch(ReviewRequest::HistoryList { id: id.into() })
        .await
        .unwrap();
    assert_eq!(reloaded["entries"], history["entries"]);
}

#[test]
fn state_paths_source_save_keeps_long_path_overwrite_guards() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = deep_directory(temporary.path(), "source");
    std::fs::create_dir_all(&directory).unwrap();
    let target = directory.join("source.circ");
    assert!(target.to_string_lossy().encode_utf16().count() > 260);
    let mut document = Document::new("source.circ".into());
    document.save(&document.revision(), Some(&target)).unwrap();
    document
        .edit(
            &document.revision(),
            "main",
            Edit::Wire {
                points: vec![Point { x: 10, y: 10 }, Point { x: 40, y: 10 }],
            },
        )
        .unwrap();
    document.save(&document.revision(), None).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), document.bytes());
    std::fs::write(&target, b"external writer").unwrap();
    assert!(document.save(&document.revision(), None).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"external writer");
}
