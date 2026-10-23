#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod installation_check;
use tauri::{Emitter, Manager};
use vibe_workbench_host::{Host, HostError, Reply, Request, timing, timing_label};
#[tauri::command]
async fn command(
    host: tauri::State<'_, Host>,
    request: serde_json::Value,
) -> Result<Reply, HostError> {
    let label = timing_label(&request);
    timing::scope(&label, host.respond(Request::from_value(request)?)).await
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let root = std::env::var_os("VIBE_WORKBENCH_RESOURCES")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    if cfg!(debug_assertions) {
                        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
                    } else {
                        app.path()
                            .resource_dir()
                            .expect("Application resources")
                            .join("workbench")
                    }
                })
                .canonicalize()?;
            let state = std::env::var_os("VIBE_WORKBENCH_STATE")
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            let check = installation_check::Check::from_env(&state)?;
            let host =
                Host::new(root.clone(), state.clone(), None).map_err(std::io::Error::other)?;
            app.manage(host.clone());
            app.manage(check.clone());
            let window =
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?;
            let window = if check.is_some() {
                window.data_directory(state.join("webview"))
            } else {
                window
            };
            window.build()?;
            if let Some(check) = check {
                installation_check::start(app.handle().clone(), host.clone(), root, check);
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut events = host.events().await;
                while let Some(event) = events.next().await {
                    let _ = handle.emit("workbench-event", event);
                }
            });
            Ok(())
        })
        .on_page_load(installation_check::page_loaded)
        .invoke_handler(tauri::generate_handler![
            command,
            installation_check::installation_ready
        ])
        .build(tauri::generate_context!())
        .expect("Failed to start Vibe Logisim")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let host = app.state::<Host>().inner().clone();
                tauri::async_runtime::block_on(host.shutdown());
            }
        });
}
