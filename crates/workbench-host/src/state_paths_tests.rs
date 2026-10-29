use crate::{DocumentRequest, Host};
use std::path::{Path, PathBuf};
use vibe_circuit_document::{Document, Edit, Point};

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
async fn state_paths_preserve_long_history_and_restart() {
    let temporary = tempfile::tempdir().unwrap();
    let state = deep_directory(temporary.path(), "state");
    let host = Host::new(temporary.path().into(), state.clone(), None).unwrap();
    let created = host
        .dispatch(DocumentRequest::New {
            name: "long-path.circ".into(),
        })
        .await
        .unwrap();
    assert!(created["historyWarning"].is_null(), "{created}");
    let id = created["id"].as_str().unwrap();
    let history = host
        .dispatch(DocumentRequest::HistoryList { id: id.into() })
        .await
        .unwrap();
    assert_eq!(history["entries"].as_array().unwrap().len(), 1);
    drop(host);

    let restored = Host::new(temporary.path().into(), state, None).unwrap();
    let reloaded = restored
        .dispatch(DocumentRequest::HistoryList { id: id.into() })
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
