//! Opt-in latency breakdown. With `VIBE_WORKBENCH_TIMING=1` in the host's
//! environment every timed request prints one stderr line,
//! `timing <op> <total>ms <stage>=<ms> …`, in the order the stages finished.
//! The Java worker inherits the variable and reports its own phases, recorded
//! here as `java.<phase>`. Without the variable nothing is collected.
use std::{
    cell::RefCell,
    future::Future,
    sync::OnceLock,
    time::{Duration, Instant},
};

tokio::task_local! {
    static STAGES: RefCell<Vec<(String, f64)>>;
}

pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("VIBE_WORKBENCH_TIMING").is_ok_and(|v| !v.is_empty() && v != "0")
    })
}

/// Runs one request with its own stage list and prints it when it finishes.
pub async fn scope<F: Future>(label: &str, work: F) -> F::Output {
    if !enabled() {
        return work.await;
    }
    let start = Instant::now();
    let (output, stages) = STAGES
        .scope(RefCell::new(Vec::new()), async {
            let output = work.await;
            (output, STAGES.with(|stages| stages.take()))
        })
        .await;
    let mut line = format!("timing {label} {:.1}ms", millis(start.elapsed()));
    for (name, ms) in stages {
        line.push_str(&format!(" {name}={ms:.1}"));
    }
    eprintln!("{line}");
    output
}

pub fn record(name: &str, duration: Duration) {
    record_millis(name, millis(duration));
}

fn record_millis(name: &str, ms: f64) {
    if enabled() {
        let _ = STAGES.try_with(|stages| stages.borrow_mut().push((name.to_owned(), ms)));
    }
}

/// The worker's `phase=ms,…` field, recorded as `java.<phase>` stages.
pub(crate) fn record_java(phases: &str) {
    for (phase, ms) in phases.split(',').filter_map(|p| p.split_once('=')) {
        if let Ok(ms) = ms.parse() {
            record_millis(&format!("java.{phase}"), ms);
        }
    }
}

/// Records the time until it is dropped.
#[must_use]
pub fn span(name: &'static str) -> Span {
    Span {
        name,
        start: enabled().then(Instant::now),
    }
}

pub struct Span {
    name: &'static str,
    start: Option<Instant>,
}

impl Drop for Span {
    fn drop(&mut self) {
        if let Some(start) = self.start {
            record(self.name, start.elapsed());
        }
    }
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}
