use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use ts_rs::TS;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn files(root: &Path, current: &Path) -> Result<BTreeMap<PathBuf, Vec<u8>>> {
    let mut result = BTreeMap::new();
    if !current.exists() {
        return Ok(result);
    }
    for entry in std::fs::read_dir(current)? {
        let path = entry?.path();
        if path.is_dir() {
            result.extend(files(root, &path)?);
        } else {
            result.insert(path.strip_prefix(root)?.into(), std::fs::read(&path)?);
        }
    }
    Ok(result)
}
fn generate(root: &Path) -> Result<()> {
    let directory = root.join("apps/workbench/src/generated");
    std::fs::create_dir_all(&directory)?;
    vibe_workbench_host::Request::export_all(&ts_rs::Config::default().with_out_dir(&directory))?;
    vibe_workspace_core::DocumentView::export_all(
        &ts_rs::Config::default().with_out_dir(&directory),
    )?;
    vibe_workspace_core::SourceStatus::export_all(
        &ts_rs::Config::default().with_out_dir(&directory),
    )?;
    vibe_workbench_host::ObservationRecord::export_all(
        &ts_rs::Config::default().with_out_dir(&directory),
    )?;
    vibe_workbench_host::ProposalReview::export_all(
        &ts_rs::Config::default().with_out_dir(&directory),
    )?;
    vibe_workbench_host::HistoryList::export_all(
        &ts_rs::Config::default().with_out_dir(&directory),
    )?;
    vibe_workbench_host::HistoryReview::export_all(
        &ts_rs::Config::default().with_out_dir(&directory),
    )?;
    vibe_workbench_host::ComparisonDetail::export_all(
        &ts_rs::Config::default().with_out_dir(&directory),
    )?;
    vibe_workbench_host::InterfaceRead::export_all(
        &ts_rs::Config::default().with_out_dir(&directory),
    )?;
    vibe_workbench_host::InterfacePreview::export_all(
        &ts_rs::Config::default().with_out_dir(&directory),
    )?;
    let schema = root.join("packages/agent-runtime/src/generated");
    std::fs::create_dir_all(&schema)?;
    std::fs::write(
        schema.join("edit-schema.json"),
        serde_json::to_string_pretty(&vibe_workspace_core::edit_schema())? + "\n",
    )?;
    Ok(())
}
fn main() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    if std::env::args().any(|arg| arg == "--check") {
        let temp = std::env::temp_dir().join(format!("vibe-contract-{}", uuid::Uuid::new_v4()));
        let check = (|| -> Result<()> {
            generate(&temp)?;
            for relative in [
                "apps/workbench/src/generated",
                "packages/agent-runtime/src/generated",
            ] {
                let actual = root.join(relative);
                let expected = temp.join(relative);
                if files(&actual, &actual)? != files(&expected, &expected)? {
                    return Err(format!(
                        "Generated contract differs: {relative}. Run npm run contracts."
                    )
                    .into());
                }
            }
            Ok(())
        })();
        let _ = std::fs::remove_dir_all(temp);
        check?;
        println!("Rust, TypeScript and model tool contracts match.");
    } else {
        generate(&root)?;
        println!("Exported TypeScript and model tool contracts.");
    }
    Ok(())
}
