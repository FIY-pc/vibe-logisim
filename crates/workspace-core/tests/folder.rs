use vibe_workspace_core::Folder;

#[test]
fn project_moves_never_replace_or_escape_and_can_move_directories() {
    let root = tempfile::tempdir().unwrap();
    let folder = Folder::open(root.path()).unwrap();
    std::fs::create_dir(root.path().join("source")).unwrap();
    std::fs::create_dir(root.path().join("source/child")).unwrap();
    std::fs::write(root.path().join("source/a.txt"), "source").unwrap();
    std::fs::write(root.path().join("target.txt"), "target").unwrap();
    assert!(folder.rename("source/a.txt", "target.txt").is_err());
    assert_eq!(
        std::fs::read_to_string(root.path().join("target.txt")).unwrap(),
        "target"
    );
    assert!(folder.rename("source", "source/child/nested").is_err());
    assert!(folder.rename("source", "../outside").is_err());
    assert!(folder.rename("", "root-moved").is_err());
    folder.rename("source", "moved").unwrap();
    assert_eq!(
        std::fs::read_to_string(root.path().join("moved/a.txt")).unwrap(),
        "source"
    );
}

#[cfg(unix)]
#[test]
fn moving_a_link_moves_the_entry_and_not_its_target() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let folder = Folder::open(root.path()).unwrap();
    std::fs::write(outside.path().join("safe.txt"), "retain").unwrap();
    symlink(outside.path().join("safe.txt"), root.path().join("link")).unwrap();
    folder.rename("link", "moved-link").unwrap();
    assert!(
        root.path()
            .join("moved-link")
            .symlink_metadata()
            .unwrap()
            .is_symlink()
    );
    assert_eq!(
        std::fs::read_to_string(outside.path().join("safe.txt")).unwrap(),
        "retain"
    );
    symlink(outside.path(), root.path().join("escape")).unwrap();
    assert!(folder.rename("moved-link", "escape/changed").is_err());
    assert!(!outside.path().join("changed").exists());
    symlink(outside.path().join("missing"), root.path().join("broken")).unwrap();
    assert!(folder.rename("moved-link", "broken").is_err());
}
