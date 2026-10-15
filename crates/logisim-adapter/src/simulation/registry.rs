//! The current simulation run. A new run replaces the current one only once it
//! shows its first frame; a start that fails leaves the current run alone.
use super::{
    error::{Code, SimError},
    model::{
        ActResult, ButtonValue, Command, ComponentDelta, EndReason, EndedInfo, Frame,
        NavigateResult, SessionInfo, SimulationEvent, Snapshot, StateEvent, Status, TraceMark,
    },
    protocol,
    session::{Deadlines, Ended, Io, OnEnd, Process, Session, View, now_ms},
};
use crate::{
    process::{StderrCapture, java_path},
    runtime::Launcher,
};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, atomic::Ordering},
    time::Duration,
};
use tokio::sync::{
    mpsc::{self, error::TryRecvError},
    watch,
};
use vibe_workspace_core::DocumentView;

/// The deepest subcircuit path a view may have.
const MAX_DEPTH: usize = 64;

/// A document as of one revision: the file the runtime opens and its parsed view.
pub struct RunDocument {
    pub artifact: PathBuf,
    pub view: DocumentView,
}

/// What a command addresses.
pub enum Target {
    /// A view of a run, as of the document revision the caller shows.
    Run {
        session_id: String,
        view_id: String,
        revision: String,
    },
    /// A circuit definition. Commands that start runs start one rooted here.
    Definition {
        document: RunDocument,
        circuit: String,
    },
}

enum Lifecycle {
    Session(Arc<Session>),
    Ended(EndedInfo),
}

#[derive(Default)]
struct Inner {
    current: Option<Arc<Session>>,
    last_ended: Option<EndedInfo>,
    subscribers: Vec<mpsc::UnboundedSender<Lifecycle>>,
}

enum Spawner {
    Java,
    /// Tests: builds the process side from the start file.
    #[cfg(test)]
    Fake(Box<dyn Fn(&Path) -> Io + Send + Sync>),
}

struct Shared {
    launcher: Launcher,
    spawner: Spawner,
    deadlines: Deadlines,
    /// Held by starts only: starts queue in order and nothing else waits on them.
    gate: tokio::sync::Mutex<()>,
    inner: Mutex<Inner>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// Called by a session once it ended.
    fn ended(&self, session: &Session) {
        let Some(ended) = session.ended() else {
            return;
        };
        let removed = {
            let mut inner = self.lock();
            let removed = inner
                .current
                .take_if(|current| current.info.session_id == session.info.session_id);
            // A run that never started (a failed start) leaves no trace.
            if session.announced.load(Ordering::SeqCst) {
                inner.last_ended = Some(ended.info.clone());
                inner.subscribers.retain(|subscriber| {
                    subscriber
                        .send(Lifecycle::Ended(ended.info.clone()))
                        .is_ok()
                });
            }
            removed
        };
        drop(removed);
    }
}

/// The start file the runtime reads before its first frame; removed afterwards.
struct InitFile(PathBuf);

impl InitFile {
    fn write(state: &Path, session_id: &str, xml: &str) -> Result<Self, SimError> {
        let folder = state.join("simulation");
        let path = folder.join(format!("{session_id}.xml"));
        std::fs::create_dir_all(&folder)
            .and_then(|()| std::fs::write(&path, xml))
            .map_err(|error| failed(format!("{}: {error}", path.display())))?;
        Ok(Self(path))
    }
}

impl Drop for InitFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn failed(detail: impl Into<String>) -> SimError {
    SimError::new(Code::StartFailed).with_detail(detail)
}

/// Why a run that ended before its first frame did not start.
fn start_error(ended: &Ended) -> SimError {
    let error = match &ended.cause {
        Some(cause) if cause.code == Code::ViewportBudget => SimError::new(Code::StartFailed)
            .with_message("仿真未启动：画面范围超过限制，请调整电路范围后重试"),
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

/// What the run looked like when a command needed no runtime round trip.
fn current_result(session: &Session) -> ActResult {
    let state = session.run_state();
    ActResult {
        session_id: Some(session.info.session_id.clone()),
        view_id: Some(
            state
                .as_ref()
                .map_or_else(|| session.root.id.clone(), |state| state.view_id.clone()),
        ),
        command_sequence: state.as_ref().map(|state| state.command_sequence),
        clock: state.map(|state| state.clock),
        applied: true,
        ..ActResult::default()
    }
}

async fn apply(session: &Session, view_id: &str, command: &Command) -> Result<ActResult, SimError> {
    let (request_id, meta) = session
        .send(|request_id| protocol::command_line(request_id, view_id, command))
        .await?;
    Ok(ActResult {
        session_id: Some(session.info.session_id.clone()),
        view_id: Some(meta.view_id),
        request_id: Some(request_id),
        command_sequence: Some(meta.command_sequence),
        started: false,
        applied: true,
        clock: Some(meta.clock),
        initial_frequency: None,
    })
}

/// Owns the current run. Clones share it.
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
            gate: tokio::sync::Mutex::new(()),
            inner: Mutex::new(Inner::default()),
        }))
    }

    /// The current run, unless it ended.
    fn current(&self) -> Option<Arc<Session>> {
        let current = self.0.lock().current.clone();
        current.filter(|session| session.ended().is_none())
    }

    fn live(&self, session_id: &str) -> Option<Arc<Session>> {
        self.current()
            .filter(|session| session.info.session_id == session_id)
    }

    /// Applies a command. Sent for a definition, a command that starts runs
    /// first starts a run of it, or uses the current run when that one is of
    /// the same circuit and revision and shows its root; other commands for a
    /// definition do nothing. A run that is gone or of another revision
    /// refuses commands that start runs and ignores the others.
    pub async fn act(
        &self,
        target: Target,
        command: Command,
        initial_frequency: Option<f64>,
    ) -> Result<ActResult, SimError> {
        if let Command::Configure {
            frequency: Some(frequency),
            ..
        } = command
        {
            frequency_in_range(frequency)?;
        }
        match target {
            Target::Run {
                session_id,
                view_id,
                revision,
            } => {
                let session = self
                    .live(&session_id)
                    .filter(|session| session.info.revision == revision);
                let Some(session) = session else {
                    return if command.starts_run() {
                        Err(Code::SessionEnded.into())
                    } else {
                        Ok(ActResult::default())
                    };
                };
                if command == Command::Start {
                    return Ok(current_result(&session));
                }
                let release = matches!(
                    command,
                    Command::Button {
                        value: ButtonValue::Released,
                        ..
                    }
                );
                match apply(&session, &view_id, &command).await {
                    // The run ended meanwhile, or (for a release) left the view
                    // whose buttons the runtime already released.
                    Err(error)
                        if (error.code == Code::SessionEnded && !command.starts_run())
                            || (error.code == Code::ViewChanged && release) =>
                    {
                        Ok(ActResult::default())
                    }
                    result => result,
                }
            }
            Target::Definition { document, circuit } => {
                if !command.starts_run() {
                    // A frequency set before a run applies when the next one starts.
                    let initial_frequency = match command {
                        Command::Configure { frequency, .. } => frequency.or(initial_frequency),
                        _ => None,
                    };
                    return Ok(ActResult {
                        initial_frequency,
                        ..ActResult::default()
                    });
                }
                if let Some(frequency) = initial_frequency {
                    frequency_in_range(frequency)?;
                }
                let (session, view_id, started) = self.run_of(document, &circuit).await?;
                let mut result = None;
                if started && let Some(frequency) = initial_frequency {
                    let configure = Command::Configure {
                        frequency: Some(frequency),
                        automatic: None,
                    };
                    result = Some(apply(&session, &view_id, &configure).await?);
                }
                if command != Command::Start {
                    result = Some(apply(&session, &view_id, &command).await?);
                }
                let mut result = result.unwrap_or_else(|| current_result(&session));
                result.started = started;
                Ok(result)
            }
        }
    }

    /// The run a definition command goes to, the root view to address and
    /// whether the run was started for it.
    async fn run_of(
        &self,
        document: RunDocument,
        circuit: &str,
    ) -> Result<(Arc<Session>, String, bool), SimError> {
        let _gate = self.0.gate.lock().await;
        if let Some(session) = self.current().filter(|session| {
            session.info.document_id == document.view.id
                && session.info.revision == document.view.revision
                && session.root.circuit == circuit
        }) {
            let view = session.current_view();
            if view.instance_path.is_empty() {
                return Ok((session, view.id, false));
            }
        }
        let session = self.start(document, circuit).await?;
        let view_id = session.root.id.clone();
        Ok((session, view_id, true))
    }

    async fn start(&self, document: RunDocument, circuit: &str) -> Result<Arc<Session>, SimError> {
        let RunDocument { artifact, view } = document;
        let session_id = uuid::Uuid::new_v4().to_string();
        let root = View {
            id: uuid::Uuid::new_v4().to_string(),
            circuit: circuit.into(),
            instance_path: Vec::new(),
        };
        let definition = view
            .circuits
            .iter()
            .find(|candidate| candidate.name == circuit)
            .ok_or(Code::UnknownCircuit)?;
        let init = protocol::init_document(circuit, &root.id, &definition.components)?;
        let source = tokio::fs::read(&artifact)
            .await
            .map_err(|error| failed(format!("{}: {error}", artifact.display())))?;
        let (runtime, kind) = self
            .0
            .launcher
            .facts()
            .runtime_for(&source)
            .map_err(|message| SimError::new(Code::RuntimeUnavailable).with_message(message))?;
        let init = InitFile::write(self.0.launcher.state(), &session_id, &init)?;
        let io = self.spawn(&runtime, &artifact, &init.0).await?;
        let info = SessionInfo {
            session_id,
            document_id: view.id,
            document_name: view.name,
            document_path: view.path,
            revision: view.revision,
            root_circuit: circuit.into(),
            runtime: kind,
            started_at: now_ms(),
        };
        let registry = Arc::downgrade(&self.0);
        let on_end: OnEnd = Box::new(move |session| {
            if let Some(registry) = registry.upgrade() {
                registry.ended(session);
            }
        });
        let session = Session::spawn(info, root, view.circuits, io, self.0.deadlines, on_end);
        let ready = session.first_frame().await;
        drop(init);
        if !ready && session.ended().is_none() {
            let detail = "no frame before the start deadline".to_owned();
            session.end(EndReason::Failed, None, Some(detail));
            return Err(Code::StartTimeout.into());
        }
        let previous = {
            let mut inner = self.0.lock();
            if let Some(ended) = session.ended() {
                return Err(start_error(ended));
            }
            session.announced.store(true, Ordering::SeqCst);
            inner
                .subscribers
                .retain(|subscriber| subscriber.send(Lifecycle::Session(session.clone())).is_ok());
            inner.current.replace(session.clone())
        };
        if let Some(previous) = previous {
            previous.end(EndReason::Replaced, None, None);
        }
        Ok(session)
    }

    async fn spawn(&self, runtime: &Path, artifact: &Path, init: &Path) -> Result<Io, SimError> {
        match &self.0.spawner {
            Spawner::Java => {
                let mut command = self
                    .0
                    .launcher
                    .command("CircuitSession", runtime)
                    .await
                    .map_err(failed)?;
                let mut child = command
                    .arg(java_path(artifact))
                    .arg(java_path(init))
                    .spawn()
                    .map_err(|error| failed(error.to_string()))?;
                let (Some(input), Some(output), Some(stderr)) =
                    (child.stdin.take(), child.stdout.take(), child.stderr.take())
                else {
                    return Err(failed("the runtime process has no standard streams"));
                };
                Ok(Io {
                    input: Box::new(input),
                    output: Box::new(output),
                    process: Process::Native {
                        child,
                        stderr: StderrCapture::start(stderr),
                    },
                })
            }
            #[cfg(test)]
            Spawner::Fake(spawn) => Ok(spawn(init)),
        }
    }

    /// Shows a subcircuit instance of the run: `instance_path` holds component
    /// ids from the root circuit; an empty path returns to the root.
    pub async fn navigate(
        &self,
        session_id: &str,
        instance_path: Vec<String>,
    ) -> Result<NavigateResult, SimError> {
        let session = self.live(session_id).ok_or(Code::SessionEnded)?;
        if instance_path.len() > MAX_DEPTH {
            return Err(Code::PathTooDeep.into());
        }
        let circuits = session.circuits();
        let definition = |name: &str| circuits.iter().find(|circuit| circuit.name == name);
        let mut circuit = definition(&session.root.circuit).ok_or(Code::UnknownCircuit)?;
        let mut instances = Vec::with_capacity(instance_path.len());
        for id in &instance_path {
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
        let view = View {
            id: uuid::Uuid::new_v4().to_string(),
            circuit: circuit.name.clone(),
            instance_path,
        };
        // Known before the runtime acknowledges it, so its frames resolve.
        session.register(view.clone());
        session
            .send(|request_id| {
                protocol::view_line(
                    request_id,
                    &view.circuit,
                    &view.id,
                    &instances,
                    &circuit.components,
                )
            })
            .await?;
        Ok(NavigateResult {
            view_id: view.id,
            circuit: view.circuit,
            instance_path: view.instance_path,
        })
    }

    /// Ends the run because the user stopped it. False when it already ended.
    pub fn stop(&self, session_id: &str) -> bool {
        self.end(session_id, EndReason::Stopped)
    }

    pub fn end(&self, session_id: &str, reason: EndReason) -> bool {
        self.live(session_id)
            .is_some_and(|session| session.end(reason, None, None))
    }

    /// Ends the run when its document closed (`revision_of` gives None for its
    /// id) or moved to another revision. Call after every revision change and
    /// after a start, since a start can finish after the document changed.
    pub fn reconcile(&self, revision_of: impl FnOnce(&str) -> Option<String>) -> bool {
        let Some(session) = self.current() else {
            return false;
        };
        let reason = match revision_of(&session.info.document_id) {
            None => EndReason::DocumentClosed,
            Some(revision) if revision != session.info.revision => EndReason::RevisionChanged,
            Some(_) => return false,
        };
        session.end(reason, None, None)
    }

    pub fn session(&self) -> Option<SessionInfo> {
        self.current().map(|session| session.info.clone())
    }

    /// Served from memory; never waits for a runtime.
    pub fn status(&self) -> Status {
        let last_ended = self.0.lock().last_ended.clone();
        let current = self.current();
        Status {
            session: current.as_ref().map(|session| session.info.clone()),
            state: current.and_then(|session| session.run_state()),
            last_ended,
        }
    }

    /// A kept frame of the run, the newest by default, with its waveform on request.
    pub fn snapshot(
        &self,
        session_id: &str,
        frame_sequence: Option<u64>,
        trace: bool,
    ) -> Result<Snapshot, SimError> {
        let session = self.live(session_id).ok_or(Code::SessionEnded)?;
        let (frame, trace) = session.snapshot(frame_sequence, trace)?;
        Ok(Snapshot {
            session: session.info.clone(),
            frame: Frame::clone(&frame),
            trace,
        })
    }

    /// The PNG of a kept frame. The newest two are always kept.
    pub fn frame_image(
        &self,
        session_id: &str,
        frame_sequence: u64,
    ) -> Result<Arc<Vec<u8>>, SimError> {
        self.live(session_id)
            .ok_or(Code::SessionEnded)?
            .image(frame_sequence)
    }

    /// Events from now on, starting with the current run if there is one.
    pub fn subscribe(&self) -> Subscription {
        let (sender, lifecycle) = mpsc::unbounded_channel();
        let mut inner = self.0.lock();
        if let Some(current) = &inner.current {
            let _ = sender.send(Lifecycle::Session(current.clone()));
        }
        inner.subscribers.push(sender);
        Subscription {
            lifecycle,
            follow: None,
        }
    }

    /// Stops the run and waits briefly for its process to go.
    pub async fn shutdown(&self) {
        let current = self.0.lock().current.clone();
        if let Some(session) = current {
            session.end(EndReason::Stopped, None, None);
            let _ = tokio::time::timeout(Duration::from_secs(2), session.exit()).await;
        }
    }
}

struct Follow {
    session: Arc<Session>,
    frames: watch::Receiver<u64>,
    last: Option<Arc<Frame>>,
    trace: Option<TraceMark>,
}

/// Simulation events for one listener, in order. Frames do not queue: a slow
/// listener gets the newest frame, with the components changed since the last
/// one it got.
pub struct Subscription {
    lifecycle: mpsc::UnboundedReceiver<Lifecycle>,
    follow: Option<Follow>,
}

impl Subscription {
    /// The next event; None once the registry is gone.
    pub async fn next(&mut self) -> Option<SimulationEvent> {
        enum Wake {
            Lifecycle(Option<Lifecycle>),
            Frame(bool),
        }
        loop {
            match self.lifecycle.try_recv() {
                Ok(event) => return Some(self.lifecycle_event(event)),
                Err(TryRecvError::Disconnected) => return None,
                Err(TryRecvError::Empty) => {}
            }
            if let Some(event) = self.state() {
                return Some(event);
            }
            let Self { lifecycle, follow } = self;
            let wake = match follow {
                Some(follow) => tokio::select! {
                    biased;
                    event = lifecycle.recv() => Wake::Lifecycle(event),
                    changed = follow.frames.changed() => Wake::Frame(changed.is_ok()),
                },
                None => Wake::Lifecycle(lifecycle.recv().await),
            };
            match wake {
                Wake::Lifecycle(Some(event)) => return Some(self.lifecycle_event(event)),
                Wake::Lifecycle(None) => return None,
                Wake::Frame(true) => {}
                Wake::Frame(false) => self.follow = None,
            }
        }
    }

    fn lifecycle_event(&mut self, event: Lifecycle) -> SimulationEvent {
        match event {
            Lifecycle::Session(session) => {
                let info = session.info.clone();
                self.follow = Some(Follow {
                    frames: session.frames(),
                    session,
                    last: None,
                    trace: None,
                });
                SimulationEvent::Session { session: info }
            }
            Lifecycle::Ended(ended) => {
                if self
                    .follow
                    .as_ref()
                    .is_some_and(|follow| follow.session.info.session_id == ended.session_id)
                {
                    self.follow = None;
                }
                SimulationEvent::Ended { ended }
            }
        }
    }

    /// The newest frame of the followed run, if this listener has not had it.
    fn state(&mut self) -> Option<SimulationEvent> {
        let follow = self.follow.as_mut()?;
        follow.frames.borrow_and_update();
        if follow.session.ended().is_some() {
            return None;
        }
        let (frame, trace) = follow.session.latest(follow.trace.as_ref())?;
        let last = follow.last.as_deref();
        if last.is_some_and(|last| last.frame_sequence == frame.frame_sequence) {
            return None;
        }
        // Components are compared by position within one view.
        let last = last.filter(|last| {
            last.view_id == frame.view_id && last.components.len() == frame.components.len()
        });
        let items = match last {
            None => frame.components.clone(),
            Some(last) => frame
                .components
                .iter()
                .zip(&last.components)
                .filter(|(now, before)| !Arc::ptr_eq(now, before) && now != before)
                .map(|(now, _)| now.clone())
                .collect(),
        };
        let memory = match last {
            Some(last) if last.memory == frame.memory => None,
            _ => frame.memory.clone(),
        };
        let event = StateEvent {
            session_id: follow.session.info.session_id.clone(),
            view_id: frame.view_id.clone(),
            circuit: frame.circuit.clone(),
            instance_path: frame.instance_path.clone(),
            frame_sequence: frame.frame_sequence,
            command_sequence: frame.command_sequence,
            clock: frame.clock.clone(),
            components: ComponentDelta {
                full: last.is_none(),
                items,
            },
            trace,
            memory,
            image: frame.image,
            timing: frame.timing,
        };
        follow.trace = Some(frame.trace.clone());
        follow.last = Some(frame);
        Some(SimulationEvent::State(Box::new(event)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        runtime::RuntimeFacts,
        simulation::session::tests::{Fake, ack, attribute, fake, frame, request_id},
    };
    use tokio::{task::JoinHandle, time::timeout};
    use vibe_workspace_core::Document;

    const WAIT: Duration = Duration::from_secs(60);
    const CIRCUIT: &str = concat!(
        r##"<project source="2.16.1.4" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/>"##,
        r#"<circuit name="main"><comp lib="0" loc="(100,100)" name="Pin"/><comp loc="(300,200)" name="cell"/></circuit>"#,
        r#"<circuit name="cell"><comp lib="0" loc="(100,100)" name="Pin"/></circuit></project>"#,
    );

    /// One started runtime process: its start file, root view and the fake end.
    struct Spawned {
        init: PathBuf,
        view: String,
        fake: Fake,
    }

    struct Harness {
        registry: SimulationRegistry,
        spawned: mpsc::UnboundedReceiver<Spawned>,
        document: Document,
        artifact: PathBuf,
        _dir: tempfile::TempDir,
    }

    impl Harness {
        fn new(deadlines: Deadlines) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let runtime = dir.path().join("runtime.jar");
            std::fs::write(&runtime, b"").unwrap();
            let artifact = dir.path().join("test.circ");
            std::fs::write(&artifact, CIRCUIT).unwrap();
            let facts = RuntimeFacts::new(dir.path().into(), Some(runtime));
            let launcher = Launcher::new(facts, dir.path().join("state"));
            let (sender, spawned) = mpsc::unbounded_channel();
            let spawner = Spawner::Fake(Box::new(move |init: &Path| {
                let (io, fake) = fake();
                let view = attribute(&std::fs::read_to_string(init).unwrap(), "viewId");
                let init = init.to_owned();
                sender.send(Spawned { init, view, fake }).unwrap();
                io
            }));
            let document = Document::from_bytes(
                "test.circ".into(),
                Some(artifact.clone()),
                CIRCUIT.into(),
                true,
            )
            .unwrap();
            Self {
                registry: SimulationRegistry::with(launcher, spawner, deadlines),
                spawned,
                document,
                artifact,
                _dir: dir,
            }
        }
        fn definition(&self, circuit: &str) -> Target {
            Target::Definition {
                document: RunDocument {
                    artifact: self.artifact.clone(),
                    view: self.document.view().unwrap(),
                },
                circuit: circuit.into(),
            }
        }
        fn run(&self, result: &ActResult) -> Target {
            Target::Run {
                session_id: result.session_id.clone().unwrap(),
                view_id: result.view_id.clone().unwrap(),
                revision: self.document.view().unwrap().revision,
            }
        }
        fn act(
            &self,
            target: Target,
            command: Command,
            frequency: Option<f64>,
        ) -> JoinHandle<Result<ActResult, SimError>> {
            let registry = self.registry.clone();
            tokio::spawn(async move { registry.act(target, command, frequency).await })
        }
        async fn spawned(&mut self) -> Spawned {
            timeout(WAIT, self.spawned.recv()).await.unwrap().unwrap()
        }
        /// Starts a run of `circuit` that has shown one frame.
        async fn start(&mut self, circuit: &str) -> (ActResult, Spawned) {
            let act = self.act(self.definition(circuit), Command::Start, None);
            let mut spawned = self.spawned().await;
            assert!(spawned.fake.line(&frame(&spawned.view, 1)).await);
            (timeout(WAIT, act).await.unwrap().unwrap().unwrap(), spawned)
        }
        async fn frame_sequence(&self, sequence: u64) {
            timeout(WAIT, async {
                while self
                    .registry
                    .status()
                    .state
                    .is_none_or(|state| state.frame_sequence < sequence)
                {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
        }
    }

    async fn next(events: &mut Subscription) -> SimulationEvent {
        timeout(WAIT, events.next()).await.unwrap().unwrap()
    }

    fn refusal(request_id: u64, code: &str) -> String {
        format!(
            r#"<ack requestId="{request_id}" error="com.cburch.logisim.file.SessionError: x" code="{code}" message="x"/>"#
        )
    }

    #[tokio::test]
    async fn a_start_replaces_the_current_run_only_after_its_first_frame() {
        let mut h = Harness::new(Deadlines::default());
        let mut events = h.registry.subscribe();
        // A tick on a definition starts a run, sets the frequency chosen before, then ticks.
        let act = h.act(h.definition("main"), Command::Tick, Some(8.0));
        let mut a = h.spawned().await;
        assert!(a.fake.line(&frame(&a.view, 1)).await);
        let configure = a.fake.command().await;
        assert!(
            configure.starts_with("<configure ") && configure.contains(r#" frequency="8""#),
            "{configure}"
        );
        assert!(a.fake.line(&ack(request_id(&configure), &a.view, 1)).await);
        let tick = a.fake.command().await;
        assert!(
            tick.starts_with(&format!(
                r#"<tick requestId="{}" viewId="{}""#,
                request_id(&tick),
                a.view
            )),
            "{tick}"
        );
        assert!(a.fake.line(&ack(request_id(&tick), &a.view, 2)).await);
        let first = timeout(WAIT, act).await.unwrap().unwrap().unwrap();
        assert!(first.started && first.applied);
        assert_eq!(first.command_sequence, Some(2));
        assert!(!a.init.exists());
        let SimulationEvent::Session { session } = next(&mut events).await else {
            panic!("no session event")
        };
        assert_eq!(Some(&session.session_id), first.session_id.as_ref());
        let SimulationEvent::State(state) = next(&mut events).await else {
            panic!("no state event")
        };
        assert!(state.components.full && state.trace.is_some_and(|trace| trace.full));

        // The current run stays until the new one shows its first frame.
        let act = h.act(h.definition("cell"), Command::Start, None);
        let mut b = h.spawned().await;
        assert_ne!(a.init, b.init);
        assert_eq!(h.registry.session().unwrap().session_id, session.session_id);
        assert!(b.fake.line(&frame(&b.view, 1)).await);
        let second = timeout(WAIT, act).await.unwrap().unwrap().unwrap();
        assert!(second.started && second.applied && second.request_id.is_none());
        let SimulationEvent::Session { session: successor } = next(&mut events).await else {
            panic!("no session event")
        };
        assert_eq!(Some(&successor.session_id), second.session_id.as_ref());
        let SimulationEvent::Ended { ended } = next(&mut events).await else {
            panic!("no ended event")
        };
        assert_eq!(ended.session_id, session.session_id);
        assert_eq!(ended.reason_code, EndReason::Replaced);
        timeout(WAIT, &mut a.fake.killed).await.unwrap().unwrap();
        assert_eq!(
            h.registry.status().last_ended.unwrap().reason_code,
            EndReason::Replaced
        );
        // The replaced run refuses what would start a run and ignores the rest.
        let refused = h
            .registry
            .act(h.run(&first), Command::Tick, None)
            .await
            .unwrap_err();
        assert_eq!(refused.code, Code::SessionEnded);
        assert!(
            !h.registry
                .act(h.run(&first), Command::Pause, None)
                .await
                .unwrap()
                .applied
        );
    }

    #[tokio::test]
    async fn a_failed_start_keeps_the_current_run_and_says_why() {
        let mut h = Harness::new(Deadlines {
            first_frame: Duration::from_millis(300),
            ..Deadlines::default()
        });
        let (first, _a) = h.start("main").await;
        let mut events = h.registry.subscribe();
        assert!(matches!(
            next(&mut events).await,
            SimulationEvent::Session { .. }
        ));
        assert!(matches!(next(&mut events).await, SimulationEvent::State(_)));

        // The runtime could not open the circuit and said so.
        let act = h.act(h.definition("cell"), Command::Start, None);
        let mut b = h.spawned().await;
        let line = r#"<start-error error="com.cburch.logisim.file.SessionError: Unknown circuit" code="UNKNOWN_CIRCUIT" message="Unknown circuit"/>"#;
        assert!(b.fake.line(line).await);
        let error = timeout(WAIT, act).await.unwrap().unwrap().unwrap_err();
        assert_eq!(error.code, Code::UnknownCircuit);
        timeout(WAIT, &mut b.fake.killed).await.unwrap().unwrap();

        // The process went away without a frame.
        let act = h.act(h.definition("cell"), Command::Start, None);
        let mut c = h.spawned().await;
        c.fake.close();
        let error = timeout(WAIT, act).await.unwrap().unwrap().unwrap_err();
        assert_eq!(error.code, Code::StartFailed);
        assert!(error.detail().is_some());

        // The first picture was over the budget.
        let act = h.act(h.definition("cell"), Command::Start, None);
        let mut d = h.spawned().await;
        let line = r#"<frame-error failure="java.lang.IllegalArgumentException: x" failureCode="VIEWPORT_BUDGET"/>"#;
        assert!(d.fake.line(line).await);
        let error = timeout(WAIT, act).await.unwrap().unwrap().unwrap_err();
        assert_eq!(error.code, Code::StartFailed);
        assert_eq!(
            error.message,
            "仿真未启动：画面范围超过限制，请调整电路范围后重试"
        );

        // No frame in time.
        let act = h.act(h.definition("cell"), Command::Start, None);
        let mut e = h.spawned().await;
        let error = timeout(WAIT, act).await.unwrap().unwrap().unwrap_err();
        assert_eq!(error.code, Code::StartTimeout);
        timeout(WAIT, &mut e.fake.killed).await.unwrap().unwrap();

        // An unknown circuit fails before any process starts.
        let error = h
            .registry
            .act(h.definition("nowhere"), Command::Start, None)
            .await
            .unwrap_err();
        assert_eq!(error.code, Code::UnknownCircuit);
        assert!(h.spawned.try_recv().is_err());

        // The first run carries on; nobody heard of the others.
        assert_eq!(
            h.registry.session().unwrap().session_id,
            first.session_id.unwrap()
        );
        assert!(h.registry.status().last_ended.is_none());
        assert!(
            timeout(Duration::from_millis(100), events.next())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn definitions_start_one_run_and_ignore_other_commands() {
        let mut h = Harness::new(Deadlines::default());
        let configure = |frequency| Command::Configure {
            frequency: Some(frequency),
            automatic: None,
        };
        let result = h
            .registry
            .act(h.definition("main"), configure(16.0), None)
            .await
            .unwrap();
        assert_eq!(
            (result.applied, result.initial_frequency),
            (false, Some(16.0))
        );
        let result = h
            .registry
            .act(h.definition("main"), Command::Pause, Some(16.0))
            .await
            .unwrap();
        assert!(!result.applied && result.session_id.is_none());
        for frequency in [0.1, 5000.0, f64::NAN] {
            let error = h
                .registry
                .act(h.definition("main"), configure(frequency), None)
                .await
                .unwrap_err();
            assert_eq!(error.code, Code::FrequencyRange);
            let error = h
                .registry
                .act(h.definition("main"), Command::Tick, Some(frequency))
                .await
                .unwrap_err();
            assert_eq!(error.code, Code::FrequencyRange);
        }
        assert!(h.spawned.try_recv().is_err());

        // Two quick inputs on one definition share one run.
        let input = |bits: &str| Command::Input {
            component_id: "c0".into(),
            bits: bits.into(),
        };
        let one = h.act(h.definition("main"), input("1"), None);
        let two = h.act(h.definition("main"), input("0"), None);
        let mut a = h.spawned().await;
        assert!(a.fake.line(&frame(&a.view, 1)).await);
        for _ in 0..2 {
            let command = a.fake.command().await;
            assert!(command.starts_with("<input "), "{command}");
            assert!(
                a.fake
                    .line(&ack(request_id(&command), &a.view, request_id(&command)))
                    .await
            );
        }
        let one = timeout(WAIT, one).await.unwrap().unwrap().unwrap();
        let two = timeout(WAIT, two).await.unwrap().unwrap().unwrap();
        assert_eq!(one.session_id, two.session_id);
        assert_ne!(one.started, two.started);
        assert!(h.spawned.try_recv().is_err());
    }

    #[tokio::test]
    async fn releases_never_fail_and_ended_runs_start_nothing() {
        let mut h = Harness::new(Deadlines::default());
        let (first, mut a) = h.start("main").await;
        let button = |value| Command::Button {
            component_id: "c0".into(),
            value,
        };
        // The runtime already released the buttons of a view it left.
        let act = h.act(h.run(&first), button(ButtonValue::Released), None);
        let command = a.fake.command().await;
        assert!(
            command.starts_with("<button ") && command.contains(r#" value="0""#),
            "{command}"
        );
        assert!(
            a.fake
                .line(&refusal(request_id(&command), "VIEW_CHANGED"))
                .await
        );
        assert!(!timeout(WAIT, act).await.unwrap().unwrap().unwrap().applied);
        // Other refusals reach the caller.
        let act = h.act(h.run(&first), button(ButtonValue::Pressed), None);
        let command = a.fake.command().await;
        assert!(
            a.fake
                .line(&refusal(request_id(&command), "INPUT_NOT_OPERABLE"))
                .await
        );
        let error = timeout(WAIT, act).await.unwrap().unwrap().unwrap_err();
        assert_eq!(error.code, Code::InputNotOperable);
        // A start on the live run is answered without the runtime.
        let again = h
            .registry
            .act(h.run(&first), Command::Start, None)
            .await
            .unwrap();
        assert_eq!(
            (&again.session_id, again.started, again.applied),
            (&first.session_id, false, true)
        );
        // Another revision of the document.
        let stale = Target::Run {
            session_id: first.session_id.clone().unwrap(),
            view_id: first.view_id.clone().unwrap(),
            revision: "another".into(),
        };
        let error = h
            .registry
            .act(stale, Command::Step, None)
            .await
            .unwrap_err();
        assert_eq!(error.code, Code::SessionEnded);

        let session_id = first.session_id.as_deref().unwrap();
        assert!(h.registry.stop(session_id));
        assert!(!h.registry.stop(session_id));
        timeout(WAIT, &mut a.fake.killed).await.unwrap().unwrap();
        let release = h
            .registry
            .act(h.run(&first), button(ButtonValue::Released), None)
            .await;
        assert!(!release.unwrap().applied);
        let press = h
            .registry
            .act(h.run(&first), button(ButtonValue::Pressed), None)
            .await;
        assert_eq!(press.unwrap_err().code, Code::SessionEnded);
        let status = h.registry.status();
        assert!(status.session.is_none() && status.state.is_none());
        assert_eq!(status.last_ended.unwrap().reason_code, EndReason::Stopped);
        assert_eq!(
            h.registry
                .snapshot(session_id, None, false)
                .unwrap_err()
                .code,
            Code::SessionEnded
        );
    }

    #[tokio::test]
    async fn navigation_moves_the_run_into_an_instance() {
        let mut h = Harness::new(Deadlines::default());
        let (first, mut a) = h.start("main").await;
        let session_id = first.session_id.clone().unwrap();
        let view = h.document.view().unwrap();
        let pin = view.circuits[0].components[0].id.clone();
        let cell = view.circuits[0].components[1].id.clone();
        let refused = |path: Vec<String>| {
            let registry = h.registry.clone();
            let session_id = session_id.clone();
            async move { registry.navigate(&session_id, path).await.unwrap_err().code }
        };
        assert_eq!(refused(vec![pin]).await, Code::NotSubcircuit);
        assert_eq!(
            refused(vec!["missing".into()]).await,
            Code::ComponentMissing
        );
        assert_eq!(refused(vec![cell.clone(); 65]).await, Code::PathTooDeep);

        let registry = h.registry.clone();
        let (id, path) = (session_id.clone(), vec![cell.clone()]);
        let navigate = tokio::spawn(async move { registry.navigate(&id, path).await });
        let line = a.fake.command().await;
        assert!(
            line.starts_with(r#"<view circuit="cell" viewId=""#),
            "{line}"
        );
        let inner_pin = &view
            .circuits
            .iter()
            .find(|c| c.name == "cell")
            .unwrap()
            .components[0]
            .id;
        assert!(
            line.contains(&format!(
                r#"<instance factory="cell" x="300" y="200"/><component id="{inner_pin}" factory="Pin" x="100" y="100"/></view>"#
            )),
            "{line}"
        );
        let inner = attribute(&line, "viewId");
        // Frames of the root view may still follow the switch.
        assert!(a.fake.line(&ack(request_id(&line), &inner, 1)).await);
        assert!(
            a.fake
                .line(&frame(&first.view_id.clone().unwrap(), 2))
                .await
        );
        assert!(a.fake.line(&frame(&inner, 3)).await);
        let result = timeout(WAIT, navigate).await.unwrap().unwrap().unwrap();
        assert_eq!(
            (result.view_id.as_str(), result.circuit.as_str()),
            (inner.as_str(), "cell")
        );
        assert_eq!(result.instance_path, std::slice::from_ref(&cell));
        h.frame_sequence(3).await;
        let state = h.registry.status().state.unwrap();
        assert_eq!(
            (state.view_id, state.instance_path),
            (inner.clone(), vec![cell.clone()])
        );
        let snapshot = h.registry.snapshot(&session_id, None, false).unwrap();
        assert_eq!(
            (
                snapshot.frame.circuit.as_str(),
                snapshot.frame.instance_path.as_slice()
            ),
            ("main", [cell].as_slice())
        );
        assert_eq!(
            h.registry
                .snapshot(&session_id, Some(2), false)
                .unwrap()
                .frame
                .instance_path
                .len(),
            0
        );
        let image = h.registry.frame_image(&session_id, 3).unwrap();
        assert!(!image.is_empty());

        h.registry.shutdown().await;
        timeout(WAIT, &mut a.fake.killed).await.unwrap().unwrap();
        assert_eq!(
            h.registry.status().last_ended.unwrap().reason_code,
            EndReason::Stopped
        );
    }

    #[tokio::test]
    async fn listeners_get_the_newest_frame_with_what_changed() {
        let mut h = Harness::new(Deadlines::default());
        let mut events = h.registry.subscribe();
        let (_, mut a) = h.start("main").await;
        assert!(matches!(
            next(&mut events).await,
            SimulationEvent::Session { .. }
        ));
        let SimulationEvent::State(state) = next(&mut events).await else {
            panic!("no state event")
        };
        assert!(state.components.full);
        assert_eq!(state.components.items.len(), 2);
        // A slow listener sees only the newest of fifty frames, with the one component that changed.
        for sequence in 2..=51 {
            let mut line = frame(&a.view, sequence);
            if sequence == 51 {
                line = line.replace(r#"bits="0000 x01x""#, r#"bits="0000 0011" value="3""#);
            }
            assert!(a.fake.line(&line).await);
        }
        h.frame_sequence(51).await;
        let SimulationEvent::State(state) = next(&mut events).await else {
            panic!("no state event")
        };
        assert_eq!(state.frame_sequence, 51);
        assert!(!state.components.full);
        let changed: Vec<_> = state
            .components
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect();
        assert_eq!(changed, ["b"]);
        assert!(state.trace.is_none());
        assert!(
            timeout(Duration::from_millis(100), events.next())
                .await
                .is_err()
        );

        // An edit ends the run once; a closed document ends the next one.
        let revision = h.document.view().unwrap().revision;
        assert!(!h.registry.reconcile(|_| Some(revision.clone())));
        assert!(h.registry.reconcile(|_| Some("edited".into())));
        assert!(!h.registry.reconcile(|_| Some("edited again".into())));
        let SimulationEvent::Ended { ended } = next(&mut events).await else {
            panic!("no ended event")
        };
        assert_eq!(ended.reason_code, EndReason::RevisionChanged);
        assert_eq!(
            ended.message.as_deref(),
            Some("电路已修改，运行状态已结束。重新启动将建立全新状态。")
        );
        timeout(WAIT, &mut a.fake.killed).await.unwrap().unwrap();
        let (_, _b) = h.start("main").await;
        assert!(matches!(
            next(&mut events).await,
            SimulationEvent::Session { .. }
        ));
        assert!(h.registry.reconcile(|_| None));
        let event = match next(&mut events).await {
            SimulationEvent::State(_) => next(&mut events).await,
            event => event,
        };
        let SimulationEvent::Ended { ended } = event else {
            panic!("no ended event")
        };
        assert_eq!(ended.reason_code, EndReason::DocumentClosed);
        assert!(ended.message.is_none());
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

    /// Runs the real runtimes: an input starts the run and the output follows,
    /// then a tick, a step, a refused poke and a stop; a circuit the runtime
    /// cannot open reports why. Needs a JDK and both runtimes in `.workbench-cache`.
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
            let artifact = files.path().join("smoke.circ");
            let xml = SMOKE.replace("SOURCE", source);
            std::fs::write(&artifact, &xml).unwrap();
            let document = Document::from_bytes(
                "smoke.circ".into(),
                Some(artifact.clone()),
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
            let target = Target::Definition {
                document: RunDocument {
                    artifact,
                    view: view.clone(),
                },
                circuit: "main".into(),
            };
            let command = Command::Input {
                component_id: input.clone(),
                bits: "1".into(),
            };
            let result = registry.act(target, command, Some(4.0)).await.unwrap();
            let start_ms = started.elapsed().as_millis();
            assert!(result.started && result.applied);
            let session_id = result.session_id.clone().unwrap();
            let runtime = registry.session().unwrap().runtime;
            let run = |result: &ActResult| Target::Run {
                session_id: session_id.clone(),
                view_id: result.view_id.clone().unwrap(),
                revision: view.revision.clone(),
            };
            // The output follows the input in a later frame.
            let followed = timeout(WAIT, async {
                loop {
                    if let Some(SimulationEvent::State(state)) = events.next().await
                        && let Some(item) =
                            state.components.items.iter().find(|item| item.id == output)
                        && item.ports[0].signal.bits == "1"
                    {
                        break state.frame_sequence;
                    }
                }
            })
            .await
            .unwrap();
            let tick = registry
                .act(run(&result), Command::Tick, None)
                .await
                .unwrap();
            let clock = tick.clock.clone().unwrap();
            assert_eq!((clock.ticks, clock.frequency), (1, 4.0));
            let step = registry.act(run(&tick), Command::Step, None).await.unwrap();
            assert!(step.applied && step.command_sequence > tick.command_sequence);
            let poke = Command::Poke {
                component_id: output.clone(),
                x: 200,
                y: 100,
            };
            let refused = registry.act(run(&step), poke, None).await.unwrap_err();
            assert_eq!(refused.code, Code::InputNotOperable);
            assert_eq!(refused.message, "请选择这次运行中的可操作输入");
            // The frames keep up with the commands.
            let latest = timeout(WAIT, async {
                loop {
                    let snapshot = registry.snapshot(&session_id, None, true).unwrap();
                    if snapshot.frame.command_sequence >= step.command_sequence.unwrap() {
                        break snapshot;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap();
            let png = registry
                .frame_image(&session_id, latest.frame.frame_sequence)
                .unwrap();
            assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
            assert_eq!(port(&latest.frame, &output).as_deref(), Some("1"));
            let clock_value = port(&latest.frame, &clock_output);
            assert!(registry.stop(&session_id));
            let ended = timeout(WAIT, async {
                loop {
                    if let Some(SimulationEvent::Ended { ended }) = events.next().await {
                        break ended;
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(ended.reason_code, EndReason::Stopped);
            println!(
                "source {source}: runtime {runtime:?}, started and applied the input in {start_ms} ms, \
                 output 1 at frame {followed}, ticks {}, clock output {clock_value:?}, \
                 frame {} of {}x{} px ({} PNG bytes), run ended {:?}",
                clock.ticks,
                latest.frame.frame_sequence,
                latest.frame.image.width,
                latest.frame.image.height,
                png.len(),
                ended.reason_code,
            );
        }
        // A circuit the file does not have: the runtime reports it while starting.
        let files = tempfile::tempdir().unwrap();
        let artifact = files.path().join("smoke.circ");
        let xml = SMOKE.replace("SOURCE", "2.16.1.4");
        std::fs::write(&artifact, &xml).unwrap();
        let shown = xml.replace(r#"name="main""#, r#"name="elsewhere""#);
        let document = Document::from_bytes(
            "smoke.circ".into(),
            Some(artifact.clone()),
            shown.into(),
            true,
        )
        .unwrap();
        let target = Target::Definition {
            document: RunDocument {
                artifact,
                view: document.view().unwrap(),
            },
            circuit: "elsewhere".into(),
        };
        let started = std::time::Instant::now();
        let error = registry
            .act(target, Command::Start, None)
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
        assert!(registry.session().is_none());
    }
}
