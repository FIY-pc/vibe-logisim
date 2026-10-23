use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{
        IntoResponse, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use serde_json::{Value, json};
use std::path::PathBuf;
use vibe_workbench_host::{ErrorCode, Host, HostError, Request, timing, timing_label};
// The Vite dev server is the only browser page allowed to call the loopback host.
fn dev_origin(origin: &str) -> bool {
    let port = std::env::var("VIBE_WORKBENCH_DEV_PORT").unwrap_or_else(|_| "5173".into());
    origin == format!("http://127.0.0.1:{port}") || origin == format!("http://localhost:{port}")
}
async fn dispatch(
    State(host): State<Host>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> axum::response::Response {
    // Dev-only loopback transport. Production uses Tauri's scoped IPC.
    if let Some(origin) = headers.get("origin").and_then(|s| s.to_str().ok())
        && !dev_origin(origin)
    {
        let error = HostError::new(ErrorCode::NotAllowed, "Origin rejected");
        return (StatusCode::FORBIDDEN, Json(json!({"error":error}))).into_response();
    }
    let label = timing_label(&request);
    timing::scope(&label, async {
        let result = match Request::from_value(request) {
            Ok(request) => host.dispatch(request).await,
            Err(error) => Err(error),
        };
        let _encode = timing::span("encode");
        match result {
            // Moved into the envelope: `json!` would copy a large result value by value.
            Ok(result) => (
                StatusCode::OK,
                Json(Value::Object(
                    [("result".to_string(), result)].into_iter().collect(),
                )),
            )
                .into_response(),
            Err(error) => (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response(),
        }
    })
    .await
}
async fn events(State(host): State<Host>, headers: HeaderMap) -> axum::response::Response {
    if let Some(origin) = headers.get("origin").and_then(|s| s.to_str().ok())
        && !dev_origin(origin)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let events = host.events().await;
    let stream = futures_util::stream::unfold(events, |mut events| async move {
        let event = events.next().await?;
        Some((
            Ok::<_, std::convert::Infallible>(Event::default().json_data(event).unwrap()),
            events,
        ))
    });
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::var_os("VIBE_WORKBENCH_RESOURCES")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
            } else {
                std::env::current_exe()
                    .expect("Executable path")
                    .parent()
                    .unwrap()
                    .join("resources/workbench")
            }
        })
        .canonicalize()?;
    let state = std::env::var_os("VIBE_WORKBENCH_STATE")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(".workbench-state"));
    let host = Host::new(root, state, None)?;
    let app = Router::new()
        // Imports and replacements carry whole circuit sources in the body.
        .route(
            "/api/command",
            post(dispatch).layer(DefaultBodyLimit::max(128 * 1024 * 1024)),
        )
        .route("/api/events", get(events))
        .route(
            "/api/health",
            get(|| async { Json::<Value>(json!({"ok":true,"host":"rust"})) }),
        )
        .with_state(host.clone());
    let port = std::env::var("VIBE_WORKBENCH_PORT")
        .unwrap_or_else(|_| "8793".into())
        .parse::<u16>()?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    eprintln!("Vibe Logisim Rust host: http://{}", listener.local_addr()?);
    let shutdown_host = host.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            {
                let mut term =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("SIGTERM handler");
                tokio::select! {_ = tokio::signal::ctrl_c()=>{},_ = term.recv()=>{}}
            }
            #[cfg(not(unix))]
            let _ = tokio::signal::ctrl_c().await;
            shutdown_host.shutdown().await;
        })
        .await?;
    host.shutdown().await;
    Ok(())
}
