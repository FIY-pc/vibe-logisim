//! The files native requests load documents from: one per revision and
//! source location, under `snapshots/<document>/<revision>/`.
use std::{cmp::Reverse, path::Path};

/// Revisions kept per document, the current one included. Native holds at
/// most two files open, and a request that needs an older revision writes it
/// again, so keeping more only costs disk.
const KEPT: usize = 3;

/// Deletes the files of a document's older revisions, by the time each was
/// last written. A revision a request is loading right now is not deleted:
/// requests run one at a time.
pub(crate) fn prune(documents: &Path, current: &str) {
    let Ok(entries) = std::fs::read_dir(documents) else {
        return;
    };
    let written = |revision: &Path| {
        let copies = std::fs::read_dir(revision)
            .into_iter()
            .flatten()
            .flatten()
            .flat_map(|copy| {
                let copy = copy.path();
                [copy.metadata(), copy.join("circuit.circ").metadata()]
            });
        std::iter::once(revision.metadata())
            .chain(copies)
            .filter_map(|metadata| metadata.ok()?.modified().ok())
            .max()
    };
    let mut revisions: Vec<_> = entries
        .flatten()
        .filter(|entry| entry.file_name() != current)
        .map(|entry| {
            let path = entry.path();
            (written(&path), path)
        })
        .collect();
    if revisions.len() < KEPT {
        return;
    }
    revisions.sort_by_key(|(written, _)| Reverse(*written));
    for (_, path) in revisions.into_iter().skip(KEPT - 1) {
        let _ = std::fs::remove_dir_all(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeSet, time::SystemTime};

    #[test]
    fn pruning_keeps_the_current_and_the_newest_other_revisions() {
        let documents = tempfile::tempdir().unwrap();
        let start = SystemTime::now();
        for k in 0..12u64 {
            let copy = documents.path().join(format!("r{k:02}")).join("source");
            std::fs::create_dir_all(&copy).unwrap();
            let file = copy.join("circuit.circ");
            std::fs::write(&file, b"<project/>").unwrap();
            // Later revisions were written later.
            std::fs::File::options()
                .write(true)
                .open(&file)
                .unwrap()
                .set_modified(start + std::time::Duration::from_secs(k))
                .unwrap();
        }
        let left = || -> BTreeSet<String> {
            std::fs::read_dir(documents.path())
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        };
        prune(documents.path(), "r00");
        let kept = ["r00", "r10", "r11"];
        assert_eq!(left(), kept.into_iter().map(String::from).collect());
    }
}
