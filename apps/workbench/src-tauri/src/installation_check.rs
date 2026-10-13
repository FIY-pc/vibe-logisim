//! Opt-in packaging smoke, using the installed resource resolver and real webview.
//! It only runs when both a report path and an isolated state directory are supplied.
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::{
    Manager,
    webview::{PageLoadEvent, PageLoadPayload},
};
use tokio::sync::Notify;
use vibe_workbench_host::{Host, Request};

#[derive(Clone)]
pub struct Check {
    report: PathBuf,
    ready: Arc<Notify>,
}
impl Check {
    pub fn from_env(state: &Path) -> std::io::Result<Option<Self>> {
        let Some(report) = std::env::var_os("VIBE_WORKBENCH_INSTALL_CHECK") else {
            return Ok(None);
        };
        let report = PathBuf::from(report);
        if !report.is_absolute()
            || !state.is_absolute()
            || std::env::var_os("VIBE_WORKBENCH_STATE").is_none()
        {
            return Err(std::io::Error::other(
                "Installation checks require absolute report and isolated state paths",
            ));
        }
        Ok(Some(Self {
            report,
            ready: Arc::new(Notify::new()),
        }))
    }
}

#[tauri::command]
pub fn installation_ready(check: tauri::State<'_, Option<Check>>) -> Result<(), String> {
    let check = check.as_ref().ok_or("No installation check is running")?;
    check.ready.notify_one();
    Ok(())
}

pub fn page_loaded(webview: &tauri::Webview, payload: &PageLoadPayload<'_>) {
    if payload.event() == PageLoadEvent::Finished
        && webview
            .try_state::<Option<Check>>()
            .is_some_and(|check| check.is_some())
    {
        // Loading an empty/error page is insufficient. The bundled React app must mount,
        // and its JS must be able to cross the production IPC boundary.
        let _ = webview.eval(
            r#"(() => {
          const timer = setInterval(() => {
            if (document.querySelector('#root')?.childElementCount && window.__TAURI_INTERNALS__) {
              clearInterval(timer);
              window.__TAURI_INTERNALS__.invoke('installation_ready');
            }
          }, 50);
          setTimeout(() => clearInterval(timer), 45000);
        })()"#,
        );
    }
}

async fn request(host: &Host, value: Value) -> Result<Value, String> {
    let request: Request = serde_json::from_value(value).map_err(|error| error.to_string())?;
    host.dispatch(request).await
}

async fn run(host: &Host, ready: &Notify) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(45), ready.notified())
        .await
        .map_err(|_| "The installed frontend did not mount or complete IPC".to_owned())?;
    let status = host.dispatch(Request::Status).await?;
    if !status["recoveryError"].is_null() {
        return Err(format!("Recovery failed: {}", status["recoveryError"]));
    }
    let existing = status["documents"].as_array().and_then(|documents| {
        documents
            .iter()
            .find(|document| document["name"] == "installation-check.circ")
    });
    let doc = if let Some(document) = existing {
        document.clone()
    } else {
        request(host, json!({"op":"import","name":"installation-check.circ","xml":r##"<?xml version="1.0" encoding="UTF-8"?>
<project source="2.7.1" version="1.0">
  <lib desc="#Wiring" name="0"/><lib desc="#Gates" name="1"/>
  <main name="main"/><options/><mappings/><toolbar/>
  <circuit name="main"><a name="circuit" val="main"/>
    <comp lib="0" loc="(100,100)" name="Pin"><a name="label" val="input"/></comp>
    <comp lib="1" loc="(200,100)" name="NOT Gate"/>
    <comp lib="0" loc="(280,100)" name="Pin"><a name="label" val="output"/><a name="output" val="true"/><a name="facing" val="west"/></comp>
    <wire from="(100,100)" to="(170,100)"/><wire from="(200,100)" to="(280,100)"/>
  </circuit>
</project>"##})).await?
    };
    let simulation = request(host, json!({"op":"simulate","id":doc["id"],"revision":doc["revision"],"circuit":"main","vectors":[
        {"inputs":{"input":0},"expected":{"output":1}},
        {"inputs":{"input":1},"expected":{"output":0}}
    ]})).await?;
    if simulation["passed"] != 2 || simulation["failed"] != 0 {
        return Err(format!("Installed Java simulation failed: {simulation}"));
    }
    let agent = request(host, json!({"op":"agent","method":"status"})).await?;
    if agent["runtime"] != "builtin" {
        return Err("The bundled Node runtime did not start".to_owned());
    }
    Ok(
        json!({"frontend":true,"nativeSimulation":true,"builtinRuntime":true,
        "recovered":existing.is_some(),"documentId":doc["id"],"revision":doc["revision"]}),
    )
}

pub fn start(app: tauri::AppHandle, host: Host, root: PathBuf, check: Check) {
    tauri::async_runtime::spawn(async move {
        let result = tokio::time::timeout(Duration::from_secs(90), run(&host, &check.ready)).await;
        let (code, mut report) = match result {
            Ok(Ok(report)) => (0, report),
            Ok(Err(error)) => (1, json!({"error":error})),
            Err(_) => (1, json!({"error":"Installed runtime check timed out"})),
        };
        report["schema"] = json!(1);
        report["resources"] = json!(root);
        report["version"] = json!(app.package_info().version.to_string());
        let written = std::fs::write(&check.report, serde_json::to_vec_pretty(&report).unwrap());
        host.shutdown().await;
        app.exit(if written.is_ok() { code } else { 1 });
    });
}
