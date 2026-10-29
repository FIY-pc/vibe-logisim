//! The run, if there is one. A start ends the current run, starts the new one
//! and announces it once it shows its first frame. Every subscriber gets the
//! run's whole state first and then each of its frames in order.
use super::{
    error::{Code, SimError},
    model::{Command, EndReason, EndedInfo, Frame, RunInfo, SimulationEvent, TraceDelta},
    protocol,
    run::{Deadlines, Ended, Events, Io, OnEnd, Process, Run, now_ms},
};
use crate::{
    process::{StderrCapture, java_path},
    runtime::Launcher,
    xml,
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout},
    sync::broadcast,
};
use vibe_circuit_document::{DocumentView, Revision, digest};
use xmltree::Element;

/// The deepest subcircuit path an instance may have.
const MAX_DEPTH: usize = 64;
/// Events a subscriber may fall behind by before it starts over with the
/// whole state.
const BACKLOG: usize = 256;

/// A document as of one revision: what the runtime loads, and its parsed view.
pub struct RunDocument {
    pub revision: Revision,
    pub view: DocumentView,
}

/// The process that runs circuit checks: the same class and protocol as a run,
/// started with `--verify` so it serves requests instead of holding a run.
/// Checks never become the run and never touch its clock.
struct Check {
    child: Child,
    input: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    runtime: PathBuf,
    /// Held so the pipe keeps draining; the tail goes to diagnostics.
    _stderr: StderrCapture,
}

enum Spawner {
    Java,
    /// Tests: builds the process side from the start element.
    #[cfg(test)]
    Fake(Box<dyn Fn(&str) -> Io + Send + Sync>),
}

#[derive(Default)]
struct Current {
    run: Option<Arc<Run>>,
    last_ended: Option<EndedInfo>,
}

struct Shared {
    launcher: Launcher,
    spawner: Spawner,
    deadlines: Deadlines,
    /// Held by starts only: one process starts at a time.
    starts: tokio::sync::Mutex<()>,
    /// Checks run one at a time on their own process.
    checks: tokio::sync::Mutex<Option<Check>>,
    /// Locked before a run's own state, never after.
    current: Mutex<Current>,
    events: Events,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Current> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// Called by a run once it ended: the run's last event.
    fn ended(&self, run: &Run) {
        let Some(ended) = run.ended() else {
            return;
        };
        let removed = {
            let mut current = self.lock();
            // A run that never started (a failed start) leaves no trace.
            let removed = current
                .run
                .take_if(|current| std::ptr::eq(Arc::as_ptr(current), run));
            if removed.is_some() {
                current.last_ended = Some(ended.info.clone());
                let _ = self.events.send(Arc::new(SimulationEvent::Ended {
                    ended: ended.info.clone(),
                }));
            }
            removed
        };
        drop(removed);
    }
    /// The events a new subscriber starts with: the run's start and whole
    /// state, or how the last run ended. Taken under the run's lock, so that
    /// the subscription gets every later frame and none twice.
    fn subscribe(self: &Arc<Self>) -> Subscription {
        let current = self.lock();
        let (initial, events) = match &current.run {
            Some(run) => {
                let (whole, events) = run.whole(|| self.events.subscribe());
                (whole.into_iter().flatten().collect(), events)
            }
            None => (
                current
                    .last_ended
                    .iter()
                    .map(|ended| {
                        Arc::new(SimulationEvent::Ended {
                            ended: ended.clone(),
                        })
                    })
                    .collect(),
                self.events.subscribe(),
            ),
        };
        Subscription {
            registry: Arc::downgrade(self),
            initial,
            events,
        }
    }
}

/// The folder relative libraries of a revision resolve in, as the runtime
/// reads it; empty for a document without a file.
fn directory(revision: &Revision) -> String {
    revision
        .directory()
        .map(|d| java_path(d).to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn failed(detail: impl Into<String>) -> SimError {
    SimError::new(Code::StartFailed).with_detail(detail)
}

/// Why a run that ended before its first frame did not start.
fn start_error(ended: &Ended) -> SimError {
    let error = match &ended.cause {
        Some(cause) if cause.code != Code::Internal => cause.clone(),
        _ => SimError::new(Code::StartFailed),
    };
    match &ended.info.detail {
        Some(detail) => error.with_detail(detail.clone()),
        None => error,
    }
}

fn frequency_in_range(frequency: f64) -> Result<(), SimError> {
    if (0.25..=4096.0).contains(&frequency) {
        Ok(())
    } else {
        Err(Code::FrequencyRange.into())
    }
}

/// The line that shows the instance at `instance_path`, component ids from
/// the run's root circuit; an empty path is the root.
fn view_line(run: &Run, instance_path: &[String]) -> Result<String, SimError> {
    if instance_path.len() > MAX_DEPTH {
        return Err(Code::PathTooDeep.into());
    }
    let circuits = run.circuits();
    let definition = |name: &str| circuits.iter().find(|circuit| circuit.name == name);
    let mut circuit = definition(&run.info.root_circuit).ok_or(Code::UnknownCircuit)?;
    let mut instances = Vec::with_capacity(instance_path.len());
    for id in instance_path {
        let instance = circuit
            .components
            .iter()
            .find(|component| component.id == *id)
            .ok_or_else(|| {
                SimError::new(Code::ComponentMissing).with_message("找不到子电路实例")
            })?;
        circuit = definition(&instance.name)
            .filter(|_| instance.library.is_none())
            .ok_or(Code::NotSubcircuit)?;
        instances.push(instance);
    }
    protocol::view_line(&circuit.name, &instances, &circuit.components)
}

/// Owns the run. Clones share it.
#[derive(Clone)]
pub struct SimulationRegistry(Arc<Shared>);

impl SimulationRegistry {
    pub fn new(launcher: Launcher) -> Self {
        Self::with(launcher, Spawner::Java, Deadlines::default())
    }

    fn with(launcher: Launcher, spawner: Spawner, deadlines: Deadlines) -> Self {
        Self(Arc::new(Shared {
            launcher,
            spawner,
            deadlines,
            starts: tokio::sync::Mutex::new(()),
            checks: tokio::sync::Mutex::new(None),
            current: Mutex::new(Current::default()),
            events: broadcast::channel(BACKLOG).0,
        }))
    }

    /// The run, unless it ended.
    fn current(&self) -> Option<Arc<Run>> {
        let current = self.0.lock().run.clone();
        current.filter(|run| run.ended().is_none())
    }

    pub fn run(&self) -> Option<RunInfo> {
        self.current().map(|run| run.info.clone())
    }

    /// Starts a run of `circuit` of the document, its clock at `frequency`
    /// (2 Hz otherwise), and ends the current run first. Returns once the run
    /// showed its first frame; subscribers have its whole state by then.
    pub async fn start(
        &self,
        document: RunDocument,
        circuit: &str,
        frequency: Option<f64>,
    ) -> Result<RunInfo, SimError> {
        if let Some(frequency) = frequency {
            frequency_in_range(frequency)?;
        }
        let RunDocument { revision, view } = document;
        let definition = view
            .circuits
            .iter()
            .find(|candidate| candidate.name == circuit)
            .ok_or(Code::UnknownCircuit)?;
        let init = protocol::init_document(
            revision.name(),
            &directory(&revision),
            circuit,
            frequency,
            &definition.components,
        )?;
        let (runtime, kind) = self
            .0
            .launcher
            .facts()
            .runtime_for_version(revision.source_version().as_deref())
            .map_err(|message| SimError::new(Code::RuntimeUnavailable).with_message(message))?;
        let _start = self.0.starts.lock().await;
        let current = self.0.lock().run.clone();
        if let Some(current) = current {
            current.end(EndReason::Replaced, None, None);
        }
        let io = self.spawn(&runtime, &init, revision.bytes()).await?;
        let info = RunInfo {
            document_id: view.id,
            document_name: view.name,
            document_path: view.path,
            revision: view.revision,
            root_circuit: circuit.into(),
            runtime: kind,
            started_at: now_ms(),
        };
        let registry = Arc::downgrade(&self.0);
        let on_end: OnEnd = Box::new(move |run| {
            if let Some(registry) = registry.upgrade() {
                registry.ended(run);
            }
        });
        let run = Run::spawn(
            info,
            view.circuits,
            io,
            self.0.deadlines,
            self.0.events.clone(),
            on_end,
        );
        let ready = run.first_frame().await;
        if !ready && run.ended().is_none() {
            let detail = "no frame before the start deadline".to_owned();
            run.end(EndReason::Failed, None, Some(detail));
            return Err(Code::StartTimeout.into());
        }
        {
            let mut current = self.0.lock();
            if run.announce() {
                current.run = Some(run.clone());
                return Ok(run.info.clone());
            }
        }
        Err(run
            .ended()
            .map_or_else(|| Code::StartFailed.into(), start_error))
    }

    /// Starts the run's process; its first line is the start element and the
    /// document's bytes.
    async fn spawn(&self, runtime: &Path, init: &str, text: &[u8]) -> Result<Io, SimError> {
        match &self.0.spawner {
            Spawner::Java => {
                let mut command = self
                    .0
                    .launcher
                    .command("CircuitSession", runtime)
                    .await
                    .map_err(failed)?;
                let mut child = command.spawn().map_err(|error| failed(error.to_string()))?;
                let (Some(mut input), Some(output), Some(stderr)) =
                    (child.stdin.take(), child.stdout.take(), child.stderr.take())
                else {
                    return Err(failed("the runtime process has no standard streams"));
                };
                let stderr = StderrCapture::start(stderr);
                let mut line = B64.encode(init);
                line.push('\t');
                B64.encode_string(text, &mut line);
                line.push('\n');
                input
                    .write_all(line.as_bytes())
                    .await
                    .map_err(|error| failed(error.to_string()))?;
                input
                    .flush()
                    .await
                    .map_err(|error| failed(error.to_string()))?;
                Ok(Io {
                    input: Box::new(input),
                    output: Box::new(output),
                    process: Process::Native { child, stderr },
                })
            }
            #[cfg(test)]
            Spawner::Fake(spawn) => Ok(spawn(init)),
        }
    }

    /// Sends a command to the run; returns the run's command sequence after
    /// it. A frame with at least that sequence shows its effect.
    pub async fn command(&self, command: Command) -> Result<u64, SimError> {
        if let Command::Configure {
            frequency: Some(frequency),
            ..
        } = command
        {
            frequency_in_range(frequency)?;
        }
        let line = protocol::command_line(&command)?;
        let run = self.current().ok_or(Code::SessionEnded)?;
        run.send(line).await
    }

    /// Shows a subcircuit instance of the run: `instance_path` holds component
    /// ids from the root circuit; an empty path returns to the root. The
    /// runtime releases held buttons, clears the waveform and the shown memory
    /// page, and its next frame is full. Returns the command sequence after it.
    pub async fn navigate(&self, instance_path: Vec<String>) -> Result<u64, SimError> {
        let run = self.current().ok_or(Code::SessionEnded)?;
        let line = view_line(&run, &instance_path)?;
        run.send(line).await
    }

    /// Ends the run because the user stopped it. False when there is none.
    pub fn stop(&self) -> bool {
        self.end(EndReason::Stopped)
    }

    pub fn end(&self, reason: EndReason) -> bool {
        self.current()
            .is_some_and(|run| run.end(reason, None, None))
    }

    /// Ends the run when its document closed (`revision_of` gives None for its
    /// id) or moved to another revision. Call after every revision change and
    /// after a start, since a start can finish after the document changed.
    pub fn reconcile(&self, revision_of: impl FnOnce(&str) -> Option<String>) -> bool {
        let Some(run) = self.current() else {
            return false;
        };
        let reason = match revision_of(&run.info.document_id) {
            None => EndReason::DocumentClosed,
            Some(revision) if revision != run.info.revision => EndReason::RevisionChanged,
            Some(_) => return false,
        };
        run.end(reason, None, None)
    }

    /// The run's newest state in Logisim's long form, with its waveform.
    pub fn frame(&self) -> Option<(RunInfo, Frame, TraceDelta)> {
        let run = self.current()?;
        let (frame, trace) = run.record()?;
        Some((run.info.clone(), frame, trace))
    }

    /// The run's events: its whole state first, then every frame and its end.
    pub fn subscribe(&self) -> Subscription {
        self.0.subscribe()
    }

    /// Runs one bounded check on a revision and returns its result document.
    /// `operation` is a `simulate` or `trace` element exactly as the batch
    /// checker reads it.
    ///
    /// The check process is separate from the current run: the check cannot
    /// stall the run's clock or frames, and an interactive run is never
    /// replaced or interrupted. Every check loads the revision afresh inside
    /// that process, because trace program stimuli mutate ROM contents.
    pub async fn verify(
        &self,
        revision: &Revision,
        operation: Element,
    ) -> Result<Element, SimError> {
        let runtime = self
            .0
            .launcher
            .facts()
            .runtime_for_version(revision.source_version().as_deref())
            .map_err(|message| SimError::new(Code::RuntimeUnavailable).with_message(message))?
            .0;
        let runtime_hash = digest(&std::fs::read(&runtime).map_err(|error| {
            SimError::new(Code::RuntimeUnavailable).with_detail(error.to_string())
        })?);
        let request = xml(
            "request",
            &[
                ("name", revision.name().into()),
                ("directory", directory(revision)),
            ],
            vec![operation],
        );
        let mut bytes = Vec::new();
        request
            .write(&mut bytes)
            .map_err(|error| SimError::new(Code::Internal).with_detail(error.to_string()))?;
        let mut line = B64.encode(bytes);
        line.push('\t');
        B64.encode_string(revision.bytes(), &mut line);
        line.push('\n');

        let mut checks = self.0.checks.lock().await;
        let stale = checks.as_mut().is_some_and(|check| {
            check.runtime != runtime || check.child.try_wait().ok().flatten().is_some()
        });
        if stale {
            *checks = None;
        }
        if checks.is_none() {
            *checks = Some(self.start_check(&runtime, &runtime_hash).await?);
        }
        let check = checks.as_mut().expect("the check process was just started");
        let reply = async {
            check
                .input
                .write_all(line.as_bytes())
                .await
                .map_err(|error| failed(error.to_string()))?;
            check
                .input
                .flush()
                .await
                .map_err(|error| failed(error.to_string()))?;
            let line = tokio::time::timeout(Duration::from_secs(120), check.lines.next_line())
                .await
                .map_err(|_| SimError::new(Code::Unresponsive))?
                .map_err(|error| failed(error.to_string()))?
                .ok_or_else(|| failed("校验进程在处理请求时退出"))?;
            let (status, payload) = line
                .split_once('\t')
                .ok_or_else(|| failed("无效的校验响应"))?;
            let payload = B64
                .decode(payload)
                .map_err(|error| failed(error.to_string()))?;
            if status != "ok" {
                return Err(SimError::new(Code::Internal)
                    .with_detail(String::from_utf8_lossy(&payload).into_owned()));
            }
            Element::parse(payload.as_slice()).map_err(|error| failed(error.to_string()))
        }
        .await;
        if reply.is_err() {
            // A rejected circuit leaves the process in an uncertain state; the
            // next check starts a new one.
            *checks = None;
        }
        reply
    }

    async fn start_check(&self, runtime: &Path, runtime_hash: &str) -> Result<Check, SimError> {
        let mut command = self
            .0
            .launcher
            .command("CircuitSession", runtime)
            .await
            .map_err(failed)?;
        let mut child = command
            .arg("--verify")
            .arg(java_path(runtime))
            .arg(runtime_hash)
            .spawn()
            .map_err(|error| {
                SimError::new(Code::RuntimeUnavailable).with_detail(error.to_string())
            })?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(failed("the check process has no standard streams"));
        };
        Ok(Check {
            child,
            input: stdin,
            lines: BufReader::new(stdout).lines(),
            runtime: runtime.to_owned(),
            _stderr: StderrCapture::start(stderr),
        })
    }

    /// Stops the run and waits briefly for its process to go.
    pub async fn shutdown(&self) {
        // The check process is killed with its handle, not kept alive by it.
        self.0.checks.lock().await.take();
        let current = self.0.lock().run.clone();
        if let Some(run) = current {
            run.end(EndReason::Stopped, None, None);
            let _ = tokio::time::timeout(Duration::from_secs(2), run.exit()).await;
        }
    }
}

/// Simulation events for one listener, in order. A listener that falls
/// behind by more than the backlog starts over with the whole state.
pub struct Subscription {
    registry: Weak<Shared>,
    initial: VecDeque<Arc<SimulationEvent>>,
    events: broadcast::Receiver<Arc<SimulationEvent>>,
}

impl Subscription {
    /// The next event; None once the registry is gone.
    pub async fn next(&mut self) -> Option<Arc<SimulationEvent>> {
        loop {
            if let Some(event) = self.initial.pop_front() {
                return Some(event);
            }
            match self.events.recv().await {
                Ok(event) => return Some(event),
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    *self = self.registry.upgrade()?.subscribe();
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        runtime::RuntimeFacts,
        simulation::{
            model::FrameEvent,
            protocol::tests::frame_line,
            run::tests::{Fake, WAIT, ack, attribute, fake},
        },
    };
    use tokio::{sync::mpsc, task::JoinHandle, time::timeout};
    use vibe_circuit_document::Document;

    const CIRCUIT: &str = concat!(
        r##"<project source="2.16.1.4" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/>"##,
        r#"<circuit name="main"><comp lib="0" loc="(100,100)" name="Pin"/><comp loc="(300,200)" name="cell"/></circuit>"#,
        r#"<circuit name="cell"><comp lib="0" loc="(100,100)" name="Pin"/></circuit></project>"#,
    );

    /// One started runtime process: its start file and its fake end.
    struct Spawned {
        init: String,
        fake: Fake,
    }

    struct Harness {
        registry: SimulationRegistry,
        spawned: mpsc::UnboundedReceiver<Spawned>,
        document: Document,
        _dir: tempfile::TempDir,
    }

    impl Harness {
        fn new(deadlines: Deadlines) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let runtime = dir.path().join("runtime.jar");
            std::fs::write(&runtime, b"").unwrap();
            let facts = RuntimeFacts::new(dir.path().into(), Some(runtime));
            let launcher = Launcher::new(facts, dir.path().join("state"));
            let (sender, spawned) = mpsc::unbounded_channel();
            let spawner = Spawner::Fake(Box::new(move |init: &str| {
                let (io, fake) = fake();
                let init = init.to_owned();
                sender.send(Spawned { init, fake }).unwrap();
                io
            }));
            let document = Document::from_bytes(
                "test.circ".into(),
                Some(dir.path().join("test.circ")),
                CIRCUIT.into(),
                true,
            )
            .unwrap();
            Self {
                registry: SimulationRegistry::with(launcher, spawner, deadlines),
                spawned,
                document,
                _dir: dir,
            }
        }
        fn start(
            &self,
            circuit: &str,
            frequency: Option<f64>,
        ) -> JoinHandle<Result<RunInfo, SimError>> {
            let registry = self.registry.clone();
            let document = RunDocument {
                revision: self.document.snapshot(),
                view: self.document.view().unwrap(),
            };
            let circuit = circuit.to_owned();
            tokio::spawn(async move { registry.start(document, &circuit, frequency).await })
        }
        async fn spawned(&mut self) -> Spawned {
            timeout(WAIT, self.spawned.recv()).await.unwrap().unwrap()
        }
        /// Starts a run of `circuit` that has shown its first frame.
        async fn started(&mut self, circuit: &str) -> Fake {
            let start = self.start(circuit, None);
            let mut spawned = self.spawned().await;
            assert!(spawned.fake.line(&frame_line(true, 1)).await);
            timeout(WAIT, start).await.unwrap().unwrap().unwrap();
            spawned.fake
        }
        /// The id of the component of `circuit` named `name`.
        fn id(&self, circuit: &str, name: &str) -> String {
            let view = self.document.view().unwrap();
            let circuit = view.circuits.iter().find(|c| c.name == circuit).unwrap();
            let component = circuit.components.iter().find(|c| c.name == name);
            component.unwrap().id.clone()
        }
    }

    async fn next(events: &mut Subscription) -> Arc<SimulationEvent> {
        timeout(WAIT, events.next()).await.unwrap().unwrap()
    }

    fn frame(event: &Arc<SimulationEvent>) -> &FrameEvent {
        match &**event {
            SimulationEvent::Frame(frame) => frame,
            _ => panic!("not a frame"),
        }
    }

    fn started(event: &Arc<SimulationEvent>) -> &RunInfo {
        match &**event {
            SimulationEvent::Run { run } => run,
            _ => panic!("not a run"),
        }
    }

    fn ended(event: &Arc<SimulationEvent>) -> EndReason {
        match &**event {
            SimulationEvent::Ended { ended } => ended.reason_code,
            _ => panic!("not an end"),
        }
    }

    async fn refused(start: JoinHandle<Result<RunInfo, SimError>>) -> SimError {
        timeout(WAIT, start).await.unwrap().unwrap().unwrap_err()
    }

    #[tokio::test]
    async fn subscribers_get_the_whole_state_then_each_frame() {
        let mut h = Harness::new(Deadlines::default());
        let mut early = h.registry.subscribe();
        // The frequency chosen before the run is in its start file.
        let start = h.start("main", Some(8.0));
        let mut a = h.spawned().await;
        assert_eq!(attribute(&a.init, "frequency"), "8");
        assert!(a.fake.line(&frame_line(true, 1)).await);
        let run = timeout(WAIT, start).await.unwrap().unwrap().unwrap();
        assert_eq!(h.registry.run().unwrap().started_at, run.started_at);
        assert_eq!(started(&next(&mut early).await).root_circuit, "main");
        let first = next(&mut early).await;
        let first = frame(&first);
        assert!(first.full && first.command_sequence == 1);
        assert_eq!(first.components.len(), 2);
        assert_eq!(first.paint.wires.len(), 1);
        // Later frames carry what changed.
        assert!(a.fake.line(&frame_line(false, 2)).await);
        let second = next(&mut early).await;
        let second = frame(&second);
        assert!(!second.full && second.command_sequence == 2);
        assert_eq!(second.components.keys().collect::<Vec<_>>(), ["b"]);
        // A new subscriber, such as a reloaded page, starts with the whole state.
        let mut late = h.registry.subscribe();
        started(&next(&mut late).await);
        let whole = next(&mut late).await;
        let whole = frame(&whole);
        assert!(whole.full && whole.command_sequence == 2);
        assert_eq!(whole.components["a"].input.as_deref(), Some("1"));
        assert_eq!(whole.components["b"].ports, ["00000011", "-"]);
        assert_eq!(whole.paint.wires.keys().collect::<Vec<_>>(), ["#006400"]);
        assert!(whole.trace.as_ref().is_some_and(|trace| trace.full));
        // A start ends the current run first; subscribers see its end, then the new run.
        let start = h.start("cell", None);
        let mut b = h.spawned().await;
        timeout(WAIT, &mut a.fake.killed).await.unwrap().unwrap();
        assert!(b.fake.line(&frame_line(true, 1)).await);
        timeout(WAIT, start).await.unwrap().unwrap().unwrap();
        for events in [&mut early, &mut late] {
            assert_eq!(ended(&next(events).await), EndReason::Replaced);
            assert_eq!(started(&next(events).await).root_circuit, "cell");
            assert!(frame(&next(events).await).full);
        }
        // After the run ends, a new subscriber learns how.
        assert!(h.registry.stop());
        assert!(!h.registry.stop());
        let mut after = h.registry.subscribe();
        assert_eq!(ended(&next(&mut after).await), EndReason::Stopped);
        assert_eq!(ended(&next(&mut early).await), EndReason::Stopped);
    }

    #[tokio::test]
    async fn failed_starts_say_why() {
        let mut h = Harness::new(Deadlines {
            first_frame: Duration::from_millis(300),
            ..Deadlines::default()
        });
        let _a = h.started("main").await;
        // Refused before anything starts: the current run goes on.
        assert_eq!(
            refused(h.start("nowhere", None)).await.code,
            Code::UnknownCircuit
        );
        assert_eq!(
            refused(h.start("main", Some(0.1))).await.code,
            Code::FrequencyRange
        );
        assert!(h.registry.run().is_some());
        let mut events = h.registry.subscribe();
        started(&next(&mut events).await);
        frame(&next(&mut events).await);

        // The runtime cannot open the circuit.
        let start = h.start("main", None);
        let mut spawned = h.spawned().await;
        let line = r#"<start-error error="com.cburch.logisim.file.SessionError: x" code="UNKNOWN_CIRCUIT" message="x"/>"#;
        assert!(spawned.fake.line(line).await);
        assert_eq!(refused(start).await.code, Code::UnknownCircuit);
        // The process exits first.
        let start = h.start("main", None);
        h.spawned().await.fake.close();
        let error = refused(start).await;
        assert_eq!(error.code, Code::StartFailed);
        assert!(error.detail().is_some());
        // Its first frame fails.
        let start = h.start("main", None);
        let mut spawned = h.spawned().await;
        let line = r#"<frame-error failure="java.lang.Error: x" failureCode="CLOCK_FAILURE"/>"#;
        assert!(spawned.fake.line(line).await);
        assert_eq!(refused(start).await.code, Code::ClockFailure);
        // No frame in time.
        let start = h.start("main", None);
        let mut spawned = h.spawned().await;
        assert_eq!(refused(start).await.code, Code::StartTimeout);
        timeout(WAIT, &mut spawned.fake.killed)
            .await
            .unwrap()
            .unwrap();

        // Only the run that had started ended for subscribers.
        assert_eq!(ended(&next(&mut events).await), EndReason::Replaced);
        assert!(h.registry.run().is_none());
        let quiet = timeout(Duration::from_millis(50), events.next()).await;
        assert!(quiet.is_err());
    }

    #[tokio::test]
    async fn commands_and_navigation_go_to_the_run() {
        let mut h = Harness::new(Deadlines::default());
        let none = h.registry.command(Command::Tick).await.unwrap_err();
        assert_eq!(none.code, Code::SessionEnded);
        let none = h.registry.navigate(Vec::new()).await.unwrap_err();
        assert_eq!(none.code, Code::SessionEnded);
        let mut fake = h.started("main").await;
        let registry = h.registry.clone();
        let tick = tokio::spawn(async move { registry.command(Command::Tick).await });
        assert_eq!(fake.command().await, "<tick/>");
        assert!(fake.line(&ack(2)).await);
        assert_eq!(timeout(WAIT, tick).await.unwrap().unwrap().unwrap(), 2);
        let configure = Command::Configure {
            frequency: Some(0.1),
            automatic: None,
        };
        let error = h.registry.command(configure).await.unwrap_err();
        assert_eq!(error.code, Code::FrequencyRange);
        // Instances are named by component ids from the root circuit.
        let cell = h.id("main", "cell");
        let registry = h.registry.clone();
        let path = vec![cell.clone()];
        let navigate = tokio::spawn(async move { registry.navigate(path).await });
        let line = fake.command().await;
        assert!(
            line.starts_with(r#"<view circuit="cell"><instance id=""#),
            "{line}"
        );
        assert_eq!(attribute(&line, "id"), cell);
        assert!(fake.line(&ack(3)).await);
        assert_eq!(timeout(WAIT, navigate).await.unwrap().unwrap().unwrap(), 3);
        let refused = |path: Vec<String>| {
            let registry = h.registry.clone();
            async move { registry.navigate(path).await.unwrap_err().code }
        };
        assert_eq!(
            refused(vec![h.id("main", "Pin")]).await,
            Code::NotSubcircuit
        );
        assert_eq!(refused(vec!["c0".into()]).await, Code::ComponentMissing);
        assert_eq!(refused(vec![cell.clone(); 65]).await, Code::PathTooDeep);
        assert!(h.registry.stop());
        let ended = h.registry.command(Command::Tick).await.unwrap_err();
        assert_eq!(ended.code, Code::SessionEnded);
    }

    #[tokio::test]
    async fn reconcile_ends_runs_of_closed_or_changed_documents() {
        let mut h = Harness::new(Deadlines::default());
        let mut events = h.registry.subscribe();
        assert!(!h.registry.reconcile(|_| None));
        let _a = h.started("main").await;
        let view = h.document.view().unwrap();
        assert!(!h.registry.reconcile(|_| Some(view.revision.clone())));
        assert!(h.registry.reconcile(|_| Some("another".into())));
        let _b = h.started("main").await;
        assert!(h.registry.reconcile(|id| (id != view.id).then(String::new)));
        let mut reasons = Vec::new();
        for _ in 0..6 {
            if let SimulationEvent::Ended { ended } = &*next(&mut events).await {
                reasons.push(ended.reason_code);
            }
        }
        assert_eq!(
            reasons,
            [EndReason::RevisionChanged, EndReason::DocumentClosed]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_subscriber_that_falls_behind_starts_over_with_the_whole_state() {
        let mut h = Harness::new(Deadlines::default());
        let mut fake = h.started("main").await;
        let mut events = h.registry.subscribe();
        let total = BACKLOG as u64 + 50;
        for sequence in 2..=total {
            assert!(fake.line(&frame_line(false, sequence)).await);
        }
        timeout(WAIT, async {
            while h
                .registry
                .frame()
                .is_none_or(|(_, frame, _)| frame.command_sequence < total)
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        started(&next(&mut events).await);
        assert_eq!(frame(&next(&mut events).await).command_sequence, 1);
        started(&next(&mut events).await);
        let whole = next(&mut events).await;
        assert!(frame(&whole).full);
        assert_eq!(frame(&whole).command_sequence, total);
    }

    const SMOKE: &str = r##"<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<project source="SOURCE" version="1.0">
  <lib desc="#Wiring" name="0"/>
  <main name="main"/>
  <circuit name="main">
    <a name="circuit" val="main"/>
    <wire from="(100,100)" to="(200,100)"/>
    <wire from="(100,200)" to="(200,200)"/>
    <comp lib="0" loc="(100,100)" name="Pin"/>
    <comp lib="0" loc="(200,100)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
    </comp>
    <comp lib="0" loc="(100,200)" name="Clock"/>
    <comp lib="0" loc="(200,200)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
    </comp>
  </circuit>
</project>
"##;

    /// The value of a component's first port in a frame, as Logisim shows it.
    fn port(frame: &Frame, id: &str) -> Option<String> {
        let component = frame
            .components
            .iter()
            .find(|component| component.id == id)?;
        Some(component.ports.first()?.signal.bits.clone())
    }

    /// The newest frame once it shows the command with `sequence`.
    async fn frame_after(registry: &SimulationRegistry, sequence: u64) -> Frame {
        timeout(WAIT, async {
            loop {
                if let Some((_, frame, _)) = registry.frame()
                    && frame.command_sequence >= sequence
                {
                    break frame;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap()
    }

    /// Runs the real runtimes: a run starts at 4 Hz, an input drives the
    /// output, then a tick, a step, a refused poke and a stop; a circuit the
    /// runtime cannot open reports why. Needs a JDK and both runtimes in
    /// `.workbench-cache`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "starts JVMs"]
    async fn runtime_smoke() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .unwrap();
        let state = tempfile::tempdir().unwrap();
        let registry = SimulationRegistry::new(Launcher::new(
            RuntimeFacts::new(root, None),
            state.path().into(),
        ));
        for source in ["2.16.1.4", "2.15.0"] {
            let files = tempfile::tempdir().unwrap();
            let xml = SMOKE.replace("SOURCE", source);
            let document = Document::from_bytes(
                "smoke.circ".into(),
                Some(files.path().join("smoke.circ")),
                xml.into(),
                true,
            )
            .unwrap();
            let view = document.view().unwrap();
            let id = |name: &str, x: i32, y: i32| {
                view.circuits[0]
                    .components
                    .iter()
                    .find(|c| c.name == name && c.location.x == x && c.location.y == y)
                    .unwrap()
                    .id
                    .clone()
            };
            let (input, output, clock_output) = (
                id("Pin", 100, 100),
                id("Pin", 200, 100),
                id("Pin", 200, 200),
            );
            let mut events = registry.subscribe();
            let started = std::time::Instant::now();
            let document = RunDocument {
                revision: document.snapshot(),
                view: view.clone(),
            };
            let run = registry.start(document, "main", Some(4.0)).await.unwrap();
            let start_ms = started.elapsed().as_millis();
            let command = Command::Input {
                component_id: input.clone(),
                bits: "1".into(),
            };
            registry.command(command).await.unwrap();
            // The first frame has the whole picture; the output follows the
            // input in a later one and the wire to it takes its color.
            let mut first = None;
            let mut wire = None;
            let mut value = None;
            let followed = timeout(WAIT, async {
                loop {
                    let event = events.next().await.unwrap();
                    let SimulationEvent::Frame(frame) = &*event else {
                        continue;
                    };
                    if first.is_none() {
                        assert!(frame.full);
                        first = Some(frame.paint.clone());
                    }
                    if let Some((color, _)) = frame
                        .paint
                        .wires
                        .iter()
                        .find(|(_, wires)| wires.chunks(4).any(|w| w == [100, 100, 200, 100]))
                    {
                        wire = Some(color.clone());
                    }
                    if let Some(component) = frame.components.get(&output) {
                        value = component.ports.first().cloned();
                    }
                    if value.as_deref() == Some("1") {
                        break frame.command_sequence;
                    }
                }
            })
            .await
            .unwrap();
            let first = first.unwrap();
            let wires: usize = first.wires.values().map(|w| w.len() / 4).sum();
            assert_eq!((wires, first.components.len()), (2, 4));
            assert_eq!(wire.as_deref(), Some("#00d200"));
            let tick = registry.command(Command::Tick).await.unwrap();
            let clock = frame_after(&registry, tick).await.clock;
            assert_eq!((clock.ticks, clock.frequency), (1, 4.0));
            let step = registry.command(Command::Step).await.unwrap();
            assert!(step > tick);
            let poke = Command::Poke {
                component_id: output.clone(),
                x: 200,
                y: 100,
            };
            let refused = registry.command(poke).await.unwrap_err();
            assert_eq!(refused.code, Code::InputNotOperable);
            assert_eq!(refused.message, "请选择这次运行中的可操作输入");
            let latest = frame_after(&registry, step).await;
            assert_eq!(port(&latest, &output).as_deref(), Some("1"));
            let clock_value = port(&latest, &clock_output);
            assert!(registry.stop());
            let ended = timeout(WAIT, async {
                loop {
                    if let SimulationEvent::Ended { ended } = &*events.next().await.unwrap() {
                        break ended.clone();
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(ended.reason_code, EndReason::Stopped);
            println!(
                "source {source}: runtime {:?}, started in {start_ms} ms, output 1 at command \
                 {followed}, ticks {}, clock output {clock_value:?}, first picture {} bytes, \
                 run ended {:?}",
                run.runtime,
                clock.ticks,
                serde_json::to_string(&first).unwrap().len(),
                ended.reason_code,
            );
        }
        // A circuit the file does not have: the runtime reports it while starting.
        let xml = SMOKE.replace("SOURCE", "2.16.1.4");
        let shown = xml.replace(r#"name="main""#, r#"name="elsewhere""#);
        let loaded = Document::from_bytes("smoke.circ".into(), None, xml.into(), true).unwrap();
        let shown = Document::from_bytes("smoke.circ".into(), None, shown.into(), true).unwrap();
        let document = RunDocument {
            revision: loaded.snapshot(),
            view: shown.view().unwrap(),
        };
        let started = std::time::Instant::now();
        let error = registry
            .start(document, "elsewhere", None)
            .await
            .unwrap_err();
        assert_eq!(error.code, Code::UnknownCircuit);
        println!(
            "unknown circuit: {:?} {} in {} ms (detail: {:?})",
            error.code,
            error.message,
            started.elapsed().as_millis(),
            error.detail()
        );
        assert!(registry.run().is_none());
    }
}
