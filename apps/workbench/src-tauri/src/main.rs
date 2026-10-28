#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod installation_check;
use std::sync::Mutex;
use tauri::{Manager, async_runtime::JoinHandle, ipc::Channel};
use vibe_workbench_host::{Event, Host, HostError, Reply, Request, timing, timing_label};
#[tauri::command]
async fn command(
    host: tauri::State<'_, Host>,
    request: serde_json::Value,
) -> Result<Reply, HostError> {
    let label = timing_label(&request);
    timing::scope(&label, host.respond(Request::from_value(request)?)).await
}
/// The page's event stream; a reloaded page asks again and replaces it.
#[derive(Default)]
struct Stream(Mutex<Option<JoinHandle<()>>>);
/// Starts the page's events: a fresh subscription, so it begins with the
/// run's whole state, exactly as the development server's event stream does.
#[tauri::command]
async fn events(
    host: tauri::State<'_, Host>,
    stream: tauri::State<'_, Stream>,
    channel: Channel<Event>,
) -> Result<(), HostError> {
    let mut events = host.events().await;
    let task = tauri::async_runtime::spawn(async move {
        while let Some(event) = events.next().await {
            if channel.send(event).is_err() {
                break;
            }
        }
    });
    let previous = stream
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .replace(task);
    if let Some(previous) = previous {
        previous.abort();
    }
    Ok(())
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
            app.manage(Stream::default());
            Ok(())
        })
        .on_page_load(installation_check::page_loaded)
        .invoke_handler(tauri::generate_handler![
            command,
            events,
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
