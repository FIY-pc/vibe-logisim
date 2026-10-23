//! One CircuitSession process. A writer task feeds its stdin from a queue, a
//! reader task parses its stdout and never waits for a consumer, a supervisor
//! owns the process and a watchdog ends a run that stops responding. State
//! sits behind a std mutex that is held for microseconds, never across an await.
use super::{
    error::{Code, SimError},
    model::{
        ClockState, ComponentState, EndReason, EndedInfo, Frame, RunState, SessionInfo, TraceDelta,
        TraceMark, TraceSample, TraceSignal,
    },
    protocol::{self, AckMeta, Line, RawFrame, RawTrace},
};
use crate::process::{StderrCapture, exit_failure};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex, MutexGuard, OnceLock, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Child,
    sync::{Notify, mpsc, oneshot, watch},
    time::MissedTickBehavior,
};
use vibe_circuit_document::Circuit;

/// The longest output line accepted; a frame carries its picture.
const LINE_LIMIT: u64 = 48_000_000;
/// Kept frames.
const FRAMES: usize = 256;
/// Kept pictures, by count and by bytes. The newest two are always kept.
const IMAGES: usize = 8;
const IMAGE_BYTES: usize = 24_000_000;
/// Kept waveform samples, as many as the runtime keeps.
const SAMPLES: usize = 512;
/// Views remembered, so that late frames of a previous view still resolve.
const VIEWS: usize = 16;

/// Milliseconds since the Unix epoch.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Deadlines {
    /// How often the watchdog looks.
    pub tick: Duration,
    /// No acknowledgement, or no frame while the clock runs, for this long ends the run.
    pub unresponsive: Duration,
    /// A start fails when its first frame takes longer.
    pub first_frame: Duration,
}

impl Default for Deadlines {
    fn default() -> Self {
        Self {
            tick: Duration::from_secs(1),
            unresponsive: Duration::from_secs(20),
            first_frame: Duration::from_secs(30),
        }
    }
}

/// The process side of a session.
pub(crate) struct Io {
    pub input: Box<dyn AsyncWrite + Send + Unpin>,
    pub output: Box<dyn AsyncRead + Send + Unpin>,
    pub process: Process,
}

pub(crate) enum Process {
    Native {
        child: Child,
        stderr: StderrCapture,
    },
    /// Tests: told when the session kills the process.
    #[cfg(test)]
    Fake(oneshot::Sender<()>),
}

/// The root circuit of a run or one subcircuit instance inside it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct View {
    pub id: String,
    pub circuit: String,
    pub instance_path: Vec<String>,
}

pub(crate) struct Ended {
    pub info: EndedInfo,
    /// The runtime failure that ended the run, when it reported one.
    pub cause: Option<SimError>,
}

/// Called once when a session ends, after its state is released.
pub(crate) type OnEnd = Box<dyn Fn(&Session) + Send + Sync>;

struct Pending {
    sent_at: Instant,
    reply: oneshot::Sender<Result<AckMeta, SimError>>,
}

/// The waveform as far as frames delivered it. Samples are contiguous and end
/// at `total`.
#[derive(Default)]
struct TraceRing {
    id: String,
    recording: bool,
    total: u64,
    signals: Vec<TraceSignal>,
    samples: VecDeque<TraceSample>,
}

impl TraceRing {
    fn update(&mut self, raw: RawTrace) {
        if raw.id != self.id {
            *self = Self {
                id: raw.id,
                signals: raw.signals,
                ..Self::default()
            };
        }
        for sample in raw.samples {
            if sample.sample < self.total {
                continue;
            }
            if sample.sample > self.total {
                // The runtime dropped samples between two frames; keep a contiguous tail.
                self.samples.clear();
            }
            self.total = sample.sample + 1;
            self.samples.push_back(sample);
            if self.samples.len() > SAMPLES {
                self.samples.pop_front();
            }
        }
        if raw.total > self.total {
            self.samples.clear();
            self.total = raw.total;
        }
        self.recording = raw.recording;
    }
    fn first(&self) -> u64 {
        self.samples
            .front()
            .map_or(self.total, |sample| sample.sample)
    }
    fn mark(&self) -> TraceMark {
        TraceMark {
            id: self.id.clone(),
            total: self.total,
            recording: self.recording,
        }
    }
    /// Samples from `from` up to the frame at `to`; everything kept when `from`
    /// is unknown or no longer kept.
    fn delta(&self, from: Option<u64>, to: &TraceMark) -> TraceDelta {
        let first = self.first();
        let from = from.filter(|&from| from >= first);
        TraceDelta {
            id: self.id.clone(),
            recording: to.recording,
            total: to.total,
            dropped: first.min(to.total),
            full: from.is_none(),
            signals: if from.is_none() {
                self.signals.clone()
            } else {
                Vec::new()
            },
            samples: self
                .samples
                .iter()
                .filter(|sample| sample.sample >= from.unwrap_or(0) && sample.sample < to.total)
                .cloned()
                .collect(),
        }
    }
}

struct State {
    pending: HashMap<u64, Pending>,
    last_ack_at: Instant,
    last_frame_at: Instant,
    views: VecDeque<View>,
    /// The view the runtime acknowledged last.
    current_view: View,
    /// The clock of the newest acknowledgement, which may be ahead of the
    /// newest frame: a reply reports the state its command left.
    last_clock: Option<(u64, ClockState)>,
    sequence: u64,
    frames: VecDeque<Arc<Frame>>,
    images: VecDeque<(u64, Arc<Vec<u8>>)>,
    image_bytes: usize,
    trace: TraceRing,
}

impl State {
    fn new(root: View) -> Self {
        let now = Instant::now();
        Self {
            pending: HashMap::new(),
            last_ack_at: now,
            last_frame_at: now,
            views: VecDeque::from([root.clone()]),
            current_view: root,
            last_clock: None,
            sequence: 0,
            frames: VecDeque::new(),
            images: VecDeque::new(),
            image_bytes: 0,
            trace: TraceRing::default(),
        }
    }
    fn push_image(&mut self, sequence: u64, png: Arc<Vec<u8>>) {
        self.image_bytes += png.len();
        self.images.push_back((sequence, png));
        while self.images.len() > 2
            && (self.images.len() > IMAGES || self.image_bytes > IMAGE_BYTES)
            && let Some((_, old)) = self.images.pop_front()
        {
            self.image_bytes -= old.len();
        }
    }
    fn frame(&self, sequence: Option<u64>) -> Result<&Arc<Frame>, SimError> {
        match sequence {
            None => self.frames.back(),
            Some(sequence) => self
                .frames
                .iter()
                .rev()
                .find(|frame| frame.frame_sequence == sequence),
        }
        .ok_or_else(|| Code::FrameEvicted.into())
    }
}

pub(crate) struct Session {
    pub info: SessionInfo,
    pub root: View,
    circuits: Vec<Circuit>,
    deadlines: Deadlines,
    state: Mutex<State>,
    /// The newest frame sequence; 0 before the first frame.
    frames: watch::Sender<u64>,
    commands: mpsc::UnboundedSender<String>,
    next_request: AtomicU64,
    ended: OnceLock<Ended>,
    kill: Mutex<Option<oneshot::Sender<()>>>,
    exited: watch::Receiver<bool>,
    /// Set by the registry when it published the run.
    pub announced: AtomicBool,
    on_end: OnEnd,
}

impl Session {
    pub(crate) fn spawn(
        info: SessionInfo,
        root: View,
        circuits: Vec<Circuit>,
        io: Io,
        deadlines: Deadlines,
        on_end: OnEnd,
    ) -> Arc<Self> {
        let (commands, queue) = mpsc::unbounded_channel();
        let (kill, killed) = oneshot::channel();
        let (exit, exited) = watch::channel(false);
        let session = Arc::new(Self {
            info,
            state: Mutex::new(State::new(root.clone())),
            root,
            circuits,
            deadlines,
            frames: watch::channel(0).0,
            commands,
            next_request: AtomicU64::new(0),
            ended: OnceLock::new(),
            kill: Mutex::new(Some(kill)),
            exited,
            announced: AtomicBool::new(false),
            on_end,
        });
        let eof = Arc::new(Notify::new());
        let weak = Arc::downgrade(&session);
        tokio::spawn(write(io.input, queue));
        tokio::spawn(read(weak.clone(), io.output, eof.clone()));
        tokio::spawn(supervise(weak.clone(), io.process, killed, eof, exit));
        tokio::spawn(watchdog(weak, deadlines.tick));
        session
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn ended(&self) -> Option<&Ended> {
        self.ended.get()
    }

    pub(crate) fn circuits(&self) -> &[Circuit] {
        &self.circuits
    }

    /// Ends the run once: answers waiting commands, drops the kept frames,
    /// kills the process and runs the end hook. Later calls change nothing.
    pub(crate) fn end(
        &self,
        reason: EndReason,
        cause: Option<SimError>,
        detail: Option<String>,
    ) -> bool {
        let detail = detail.or_else(|| cause.as_ref().and_then(|c| c.detail().map(str::to_owned)));
        let ended = Ended {
            info: EndedInfo {
                session_id: self.info.session_id.clone(),
                document_id: self.info.document_id.clone(),
                root_circuit: self.info.root_circuit.clone(),
                reason_code: reason,
                message: reason.message().map(str::to_owned),
                at: now_ms(),
                detail,
            },
            cause,
        };
        if self.ended.set(ended).is_err() {
            return false;
        }
        let pending = {
            let mut state = self.lock();
            state.frames.clear();
            state.images.clear();
            state.image_bytes = 0;
            state.trace = TraceRing::default();
            std::mem::take(&mut state.pending)
        };
        let error = SimError::new(match reason {
            EndReason::Unresponsive => Code::Unresponsive,
            _ => Code::SessionEnded,
        });
        for pending in pending.into_values() {
            let _ = pending.reply.send(Err(error.clone()));
        }
        self.kill();
        self.frames.send_modify(|_| {});
        (self.on_end)(self);
        true
    }

    fn kill(&self) {
        let kill = self.kill.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(kill) = kill {
            let _ = kill.send(());
        }
    }

    /// Sends one command line, built with its request id, and waits for the
    /// acknowledgement carrying that id. Commands are written in call order.
    pub(crate) async fn send(
        &self,
        build: impl FnOnce(u64) -> Result<String, SimError>,
    ) -> Result<(u64, AckMeta), SimError> {
        let request_id = self.next_request.fetch_add(1, Ordering::Relaxed) + 1;
        let line = build(request_id)?;
        let (reply, answer) = oneshot::channel();
        {
            let mut state = self.lock();
            if self.ended.get().is_some() {
                return Err(Code::SessionEnded.into());
            }
            state.pending.insert(
                request_id,
                Pending {
                    sent_at: Instant::now(),
                    reply,
                },
            );
        }
        if self.commands.send(line).is_err() {
            self.lock().pending.remove(&request_id);
            return Err(Code::SessionEnded.into());
        }
        match answer.await {
            Ok(result) => result.map(|meta| (request_id, meta)),
            Err(_) => Err(Code::SessionEnded.into()),
        }
    }

    /// Makes a view known before the command that switches to it is sent.
    pub(crate) fn register(&self, view: View) {
        let mut guard = self.lock();
        let State {
            views,
            current_view,
            ..
        } = &mut *guard;
        views.push_back(view);
        while views.len() > VIEWS {
            match views.iter().position(|view| view.id != current_view.id) {
                Some(index) => {
                    views.remove(index);
                }
                None => break,
            }
        }
    }

    pub(crate) fn current_view(&self) -> View {
        self.lock().current_view.clone()
    }

    fn route_ack(&self, request_id: Option<u64>, result: Result<AckMeta, SimError>) {
        let pending = {
            let mut guard = self.lock();
            let state = &mut *guard;
            state.last_ack_at = Instant::now();
            // Acks leave the runtime in its command order, so the view of the
            // latest one is current; frames may still trail from the previous view.
            if let Ok(meta) = &result {
                if state.current_view.id != meta.view_id
                    && let Some(view) = state.views.iter().find(|view| view.id == meta.view_id)
                {
                    state.current_view = view.clone();
                }
                state.last_clock = Some((meta.command_sequence, meta.clock.clone()));
            }
            request_id.and_then(|id| state.pending.remove(&id))
        };
        // An unknown or late id has nobody waiting; it is dropped.
        if let Some(pending) = pending {
            let _ = pending.reply.send(result);
        }
    }

    fn push_frame(
        &self,
        raw: RawFrame,
        components: Vec<Arc<ComponentState>>,
        png: Vec<u8>,
    ) -> Option<Arc<Frame>> {
        let png = Arc::new(png);
        let frame = {
            let mut guard = self.lock();
            let state = &mut *guard;
            if self.ended.get().is_some() {
                return None;
            }
            // A frame of a view this host never registered is not shown.
            let instance_path = state
                .views
                .iter()
                .find(|view| view.id == raw.meta.view_id)?
                .instance_path
                .clone();
            state.sequence += 1;
            state.trace.update(raw.trace);
            let frame = Arc::new(Frame {
                frame_sequence: state.sequence,
                command_sequence: raw.meta.command_sequence,
                view_id: raw.meta.view_id,
                circuit: raw.meta.circuit,
                instance_path,
                clock: raw.meta.clock,
                components,
                memory: raw.memory,
                image: raw.image,
                timing: raw.timing,
                at: now_ms(),
                trace: state.trace.mark(),
            });
            state.frames.push_back(frame.clone());
            if state.frames.len() > FRAMES {
                state.frames.pop_front();
            }
            state.push_image(frame.frame_sequence, png);
            state.last_frame_at = Instant::now();
            frame
        };
        self.frames.send_replace(frame.frame_sequence);
        Some(frame)
    }

    /// Wakes on every new frame and when the run ends.
    pub(crate) fn frames(&self) -> watch::Receiver<u64> {
        self.frames.subscribe()
    }

    /// Waits for the first frame. False when the run ended first or the deadline passed.
    pub(crate) async fn first_frame(&self) -> bool {
        let mut frames = self.frames.subscribe();
        let arrived = frames.wait_for(|&sequence| sequence > 0 || self.ended.get().is_some());
        matches!(
            tokio::time::timeout(self.deadlines.first_frame, arrived).await,
            Ok(Ok(_))
        ) && self.ended.get().is_none()
    }

    /// Waits until the process is gone.
    pub(crate) async fn exit(&self) {
        let mut exited = self.exited.clone();
        let _ = exited.wait_for(|&exited| exited).await;
    }

    /// The newest frame, with the waveform since `mark` when it changed.
    pub(crate) fn latest(
        &self,
        mark: Option<&TraceMark>,
    ) -> Option<(Arc<Frame>, Option<TraceDelta>)> {
        let state = self.lock();
        let frame = state.frames.back()?.clone();
        let trace = (state.trace.id == frame.trace.id && mark != Some(&frame.trace)).then(|| {
            let from = mark.filter(|mark| mark.id == frame.trace.id);
            state.trace.delta(from.map(|mark| mark.total), &frame.trace)
        });
        Some((frame, trace))
    }

    pub(crate) fn run_state(&self) -> Option<RunState> {
        let state = self.lock();
        let frame = state.frames.back()?;
        // An acknowledgement may be newer than the last frame; its clock is
        // the state the latest command left.
        let (command_sequence, clock) = match &state.last_clock {
            Some((sequence, clock)) if *sequence > frame.command_sequence => {
                (*sequence, clock.clone())
            }
            _ => (frame.command_sequence, frame.clock.clone()),
        };
        Some(RunState {
            view_id: state.current_view.id.clone(),
            circuit: state.current_view.circuit.clone(),
            instance_path: state.current_view.instance_path.clone(),
            frame_sequence: frame.frame_sequence,
            command_sequence,
            clock,
        })
    }

    /// A kept frame (the newest by default) and, on request, its waveform up to that frame.
    pub(crate) fn snapshot(
        &self,
        sequence: Option<u64>,
        trace: bool,
    ) -> Result<(Arc<Frame>, Option<TraceDelta>), SimError> {
        let state = self.lock();
        let frame = state.frame(sequence)?.clone();
        let trace = (trace && state.trace.id == frame.trace.id)
            .then(|| state.trace.delta(None, &frame.trace));
        Ok((frame, trace))
    }

    /// The PNG of a kept frame.
    pub(crate) fn image(&self, sequence: u64) -> Result<Arc<Vec<u8>>, SimError> {
        self.lock()
            .images
            .iter()
            .find(|(kept, _)| *kept == sequence)
            .map(|(_, png)| png.clone())
            .ok_or_else(|| Code::FrameEvicted.into())
    }

    /// Why the run counts as unresponsive, if it does.
    fn stalled(&self) -> Option<String> {
        let state = self.lock();
        let now = Instant::now();
        let limit = self.deadlines.unresponsive;
        if let Some(oldest) = state.pending.values().map(|pending| pending.sent_at).min() {
            // Commands are pipelined: any acknowledgement counts as progress.
            let waited = now.duration_since(oldest.max(state.last_ack_at));
            return (waited >= limit)
                .then(|| format!("no acknowledgement for {} ms", waited.as_millis()));
        }
        let running = state.frames.back().is_some_and(|frame| frame.clock.running);
        let quiet = now.duration_since(state.last_frame_at);
        (running && quiet >= limit)
            .then(|| format!("no frame for {} ms while the clock runs", quiet.as_millis()))
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.kill();
    }
}

async fn write(
    mut input: Box<dyn AsyncWrite + Send + Unpin>,
    mut queue: mpsc::UnboundedReceiver<String>,
) {
    // A failed write means the process is gone; the supervisor reports that.
    while let Some(line) = queue.recv().await {
        if input.write_all(line.as_bytes()).await.is_err() || input.flush().await.is_err() {
            return;
        }
    }
}

/// Frames reuse the components of the previous frame of the same view that
/// did not change, so kept frames share them and deltas compare pointers.
fn share(
    components: Vec<ComponentState>,
    previous: Option<&Frame>,
    view_id: &str,
) -> Vec<Arc<ComponentState>> {
    let previous = previous
        .filter(|frame| frame.view_id == view_id)
        .map_or(&[][..], |frame| &frame.components[..]);
    components
        .into_iter()
        .enumerate()
        .map(|(index, component)| match previous.get(index) {
            Some(kept) if **kept == component => kept.clone(),
            _ => Arc::new(component),
        })
        .collect()
}

async fn read(session: Weak<Session>, output: Box<dyn AsyncRead + Send + Unpin>, eof: Arc<Notify>) {
    let mut output = BufReader::with_capacity(1 << 16, output);
    let mut line = Vec::new();
    // The runtime repeats its kept samples in every frame; only newer ones are parsed.
    let mut known: Option<TraceMark> = None;
    let mut previous: Option<Arc<Frame>> = None;
    loop {
        line.clear();
        let read = (&mut output)
            .take(LINE_LIMIT + 1)
            .read_until(b'\n', &mut line)
            .await;
        let Some(session) = session.upgrade() else {
            break;
        };
        if session.ended().is_some() {
            break;
        }
        match read {
            Ok(0) | Err(_) => break,
            Ok(_) if line.last() != Some(&b'\n') => {
                if line.len() as u64 > LINE_LIMIT {
                    let detail = format!("an output line exceeded {LINE_LIMIT} bytes");
                    session.end(EndReason::Failed, None, Some(detail));
                }
                // Otherwise the process stopped mid-line while exiting.
                break;
            }
            Ok(_) => {}
        }
        let parsed = std::str::from_utf8(&line)
            .map_err(|error| error.to_string())
            .and_then(|text| {
                let known = known.as_ref().map(|mark| (mark.id.as_str(), mark.total));
                protocol::parse(text.trim_end_matches(['\n', '\r']), known)
            });
        match parsed {
            Err(reason) => {
                // The line itself may carry circuit content; diagnostics keep its shape only.
                let detail = format!("invalid output ({reason}; {} bytes)", line.len());
                session.end(EndReason::Failed, None, Some(detail));
                break;
            }
            Ok(Line::Ack { request_id, result }) => session.route_ack(request_id, result),
            Ok(Line::Frame(mut raw)) => {
                let png = match B64.decode(std::mem::take(&mut raw.png)) {
                    Ok(png) => png,
                    Err(error) => {
                        let detail = format!("invalid frame image: {error}");
                        session.end(EndReason::Failed, None, Some(detail));
                        break;
                    }
                };
                let components = share(
                    std::mem::take(&mut raw.components),
                    previous.as_deref(),
                    &raw.meta.view_id,
                );
                if let Some(frame) = session.push_frame(*raw, components, png) {
                    known = Some(frame.trace.clone());
                    previous = Some(frame);
                }
            }
            Ok(Line::FrameError(cause)) => {
                session.end(EndReason::FrameError, Some(cause), None);
                break;
            }
            Ok(Line::StartError(cause)) => {
                session.end(EndReason::Failed, Some(cause), None);
                break;
            }
        }
    }
    eof.notify_one();
}

async fn supervise(
    session: Weak<Session>,
    process: Process,
    mut kill: oneshot::Receiver<()>,
    eof: Arc<Notify>,
    exit: watch::Sender<bool>,
) {
    match process {
        Process::Native {
            mut child,
            mut stderr,
        } => {
            enum Wake {
                Kill,
                Eof,
                Exit,
            }
            let wake = tokio::select! {
                biased;
                _ = &mut kill => Wake::Kill,
                _ = eof.notified() => Wake::Eof,
                _ = child.wait() => Wake::Exit,
            };
            if !matches!(wake, Wake::Kill) {
                if matches!(wake, Wake::Exit) {
                    // The reader takes the last lines first: a start failure reports its cause there.
                    let _ = tokio::time::timeout(Duration::from_secs(1), eof.notified()).await;
                }
                let detail = exit_failure(&mut child, &mut stderr, "原生运行进程已退出").await;
                if let Some(session) = session.upgrade() {
                    session.end(EndReason::Exited, None, Some(detail));
                }
            }
            let _ = child.kill().await;
        }
        #[cfg(test)]
        Process::Fake(killed) => {
            let requested = tokio::select! {
                biased;
                _ = &mut kill => true,
                _ = eof.notified() => false,
            };
            if requested {
                let _ = killed.send(());
            } else if let Some(session) = session.upgrade() {
                let detail = "the process closed its output".to_owned();
                session.end(EndReason::Exited, None, Some(detail));
            }
        }
    }
    exit.send_replace(true);
}

async fn watchdog(session: Weak<Session>, period: Duration) {
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let Some(session) = session.upgrade() else {
            return;
        };
        if session.ended().is_some() {
            return;
        }
        if let Some(detail) = session.stalled() {
            session.end(EndReason::Unresponsive, None, Some(detail));
            return;
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        runtime::RuntimeKind,
        simulation::{model::Command, protocol::tests::frame_line},
    };
    use std::sync::atomic::AtomicUsize;
    use tokio::{
        io::{DuplexStream, Lines},
        time::timeout,
    };

    pub(crate) const VIEW: &str = "v1";
    const NO_TRACE: &str = r#"<trace id="t0" recording="false" total="0" dropped="0"/>"#;
    const WAIT: Duration = Duration::from_secs(60);

    /// The runtime end of a session: what the host wrote, and its output.
    pub(crate) struct Fake {
        commands: Lines<BufReader<DuplexStream>>,
        output: Option<DuplexStream>,
        pub killed: oneshot::Receiver<()>,
    }

    impl Fake {
        /// Writes one output line; false once the host stopped reading.
        pub(crate) async fn line(&mut self, line: &str) -> bool {
            let Some(output) = self.output.as_mut() else {
                return false;
            };
            output.write_all(line.as_bytes()).await.is_ok() && output.write_all(b"\n").await.is_ok()
        }
        pub(crate) async fn command(&mut self) -> String {
            timeout(WAIT, self.commands.next_line())
                .await
                .expect("a command")
                .unwrap()
                .expect("a command line")
        }
        pub(crate) fn close(&mut self) {
            self.output = None;
        }
    }

    pub(crate) fn fake() -> (Io, Fake) {
        let (input, commands) = tokio::io::duplex(1 << 16);
        let (output, reader) = tokio::io::duplex(1 << 20);
        let (kill, killed) = oneshot::channel();
        let io = Io {
            input: Box::new(input),
            output: Box::new(reader),
            process: Process::Fake(kill),
        };
        let fake = Fake {
            commands: BufReader::new(commands).lines(),
            output: Some(output),
            killed,
        };
        (io, fake)
    }

    pub(crate) fn frame(view: &str, sequence: u64) -> String {
        frame_line(view, sequence, NO_TRACE)
    }

    pub(crate) fn ack(request_id: u64, view: &str, sequence: u64) -> String {
        format!(
            r#"<ack requestId="{request_id}" viewId="{view}" circuit="main" commandSequence="{sequence}" ticks="0" running="false" automatic="true" pending="false" frequency="2.0" actualFrequency="0.0" oscillating="false"/>"#
        )
    }

    pub(crate) fn attribute(line: &str, name: &str) -> String {
        line.split(&format!(" {name}=\""))
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap_or_else(|| panic!("{name} in {line}"))
            .to_owned()
    }

    pub(crate) fn request_id(line: &str) -> u64 {
        attribute(line, "requestId").parse().unwrap()
    }

    /// A waveform of one 1-bit signal holding samples `from..total`.
    fn trace(id: &str, from: u64, total: u64) -> String {
        let samples: String = (from..total)
            .map(|n| {
                format!(
                    r#"<sample sequence="{n}" tick="{n}" cause="tick">{}</sample>"#,
                    n % 2
                )
            })
            .collect();
        format!(
            r#"<trace id="{id}" recording="true" total="{total}" dropped="{from}"><signal key="a:0" width="1"/>{samples}</trace>"#
        )
    }

    fn start(deadlines: Deadlines) -> (Arc<Session>, Fake, Arc<AtomicUsize>) {
        let (io, fake) = fake();
        let ends = Arc::new(AtomicUsize::new(0));
        let counted = ends.clone();
        let info = SessionInfo {
            session_id: "s1".into(),
            document_id: "d1".into(),
            document_name: "test.circ".into(),
            document_path: None,
            revision: "r1".into(),
            root_circuit: "main".into(),
            runtime: RuntimeKind::Current,
            started_at: now_ms(),
        };
        let root = View {
            id: VIEW.into(),
            circuit: "main".into(),
            instance_path: Vec::new(),
        };
        let on_end: OnEnd = Box::new(move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
        });
        let session = Session::spawn(info, root, Vec::new(), io, deadlines, on_end);
        (session, fake, ends)
    }

    fn tick(session: &Arc<Session>) -> tokio::task::JoinHandle<Result<(u64, AckMeta), SimError>> {
        let session = session.clone();
        tokio::spawn(async move {
            session
                .send(|id| protocol::command_line(id, VIEW, &Command::Tick))
                .await
        })
    }

    async fn ended(session: &Session) -> EndReason {
        let mut frames = session.frames();
        timeout(WAIT, frames.wait_for(|_| session.ended().is_some()))
            .await
            .expect("the run ends")
            .unwrap();
        session.ended().unwrap().info.reason_code
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn frames_keep_flowing_while_a_command_waits_for_its_ack() {
        let (session, mut fake, _) = start(Deadlines::default());
        let command = tick(&session);
        let id = request_id(&fake.command().await);
        let mut frames = session.frames();
        for sequence in 1..=10_000 {
            assert!(fake.line(&frame(VIEW, sequence)).await);
        }
        timeout(WAIT, frames.wait_for(|&sequence| sequence == 10_000))
            .await
            .expect("every frame is read while the ack is outstanding")
            .unwrap();
        assert!(!command.is_finished());
        assert!(fake.line(&ack(id, VIEW, 10_001)).await);
        let (request, meta) = timeout(WAIT, command).await.unwrap().unwrap().unwrap();
        assert_eq!((request, meta.command_sequence), (id, 10_001));
        // The newest frames are kept; older ones and their pictures are gone.
        let (latest, _) = session.snapshot(None, false).unwrap();
        assert_eq!(latest.frame_sequence, 10_000);
        assert_eq!(latest.components.len(), 2);
        assert!(session.snapshot(Some(10_000 - 255), false).is_ok());
        let evicted = session.snapshot(Some(10_000 - 256), false).unwrap_err();
        assert_eq!(evicted.code, Code::FrameEvicted);
        assert_eq!(
            *session.image(10_000).unwrap(),
            B64.decode("iVBORw0KGgo=").unwrap()
        );
        assert_eq!(
            session.image(10_000 - 8).unwrap_err().code,
            Code::FrameEvicted
        );
        // Unchanged components are shared between frames.
        let (previous, _) = session.snapshot(Some(9_999), false).unwrap();
        assert!(Arc::ptr_eq(&previous.components[1], &latest.components[1]));
    }

    #[tokio::test]
    async fn acks_are_routed_by_request_id() {
        let (session, mut fake, _) = start(Deadlines::default());
        let commands: Vec<_> = (0..3).map(|_| tick(&session)).collect();
        let mut ids = Vec::new();
        for _ in 0..3 {
            ids.push(request_id(&fake.command().await));
        }
        // An id nobody waits for is dropped.
        assert!(fake.line(&ack(999, VIEW, 1)).await);
        let error = format!(
            r#"<ack requestId="{}" error="com.cburch.logisim.file.SessionError: x" code="VIEW_CHANGED" message="x"/>"#,
            ids[0]
        );
        for &id in ids[1..].iter().rev() {
            assert!(fake.line(&ack(id, VIEW, 100 + id)).await);
        }
        assert!(fake.line(&error).await);
        let mut acknowledged = Vec::new();
        let mut refused = Vec::new();
        for command in commands {
            match timeout(WAIT, command).await.unwrap().unwrap() {
                Ok((request, meta)) => {
                    assert_eq!(meta.command_sequence, 100 + request);
                    acknowledged.push(request);
                }
                Err(error) => refused.push(error.code),
            }
        }
        let mut expected = ids[1..].to_vec();
        expected.sort();
        acknowledged.sort();
        assert_eq!(acknowledged, expected);
        assert_eq!(refused, [Code::ViewChanged]);
        assert!(session.ended().is_none());
    }

    #[tokio::test]
    async fn three_hundred_queued_acks_do_not_stall_frames() {
        let (session, mut fake, _) = start(Deadlines::default());
        let commands: Vec<_> = (0..300).map(|_| tick(&session)).collect();
        let mut ids = Vec::new();
        for _ in 0..300 {
            ids.push(request_id(&fake.command().await));
        }
        for (sequence, id) in (1..).zip(&ids) {
            assert!(fake.line(&frame(VIEW, sequence)).await);
            assert!(fake.line(&ack(*id, VIEW, sequence)).await);
        }
        for command in commands {
            timeout(WAIT, command).await.unwrap().unwrap().unwrap();
        }
        assert_eq!(session.snapshot(None, false).unwrap().0.frame_sequence, 300);
    }

    #[tokio::test]
    async fn a_late_ack_after_the_watchdog_ended_the_run_is_dropped() {
        let deadlines = Deadlines {
            tick: Duration::from_millis(10),
            unresponsive: Duration::from_millis(150),
            first_frame: Duration::from_secs(1),
        };
        let (session, mut fake, ends) = start(deadlines);
        let command = tick(&session);
        let id = request_id(&fake.command().await);
        let error = timeout(WAIT, command).await.unwrap().unwrap().unwrap_err();
        assert_eq!(error.code, Code::Unresponsive);
        assert_eq!(ended(&session).await, EndReason::Unresponsive);
        timeout(WAIT, &mut fake.killed).await.unwrap().unwrap();
        // The late ack reaches nobody, and later commands fail without waiting.
        fake.line(&ack(id, VIEW, 1)).await;
        let next = timeout(WAIT, tick(&session)).await.unwrap().unwrap();
        assert_eq!(next.unwrap_err().code, Code::SessionEnded);
        assert_eq!(ends.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_running_clock_without_frames_ends_the_run() {
        let deadlines = Deadlines {
            tick: Duration::from_millis(10),
            unresponsive: Duration::from_millis(150),
            first_frame: Duration::from_secs(1),
        };
        let (session, mut fake, _) = start(deadlines);
        // Paused: a quiet run is fine.
        let paused = frame(VIEW, 1).replace(r#"running="true""#, r#"running="false""#);
        assert!(fake.line(&paused).await);
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(session.ended().is_none());
        assert!(fake.line(&frame(VIEW, 2)).await);
        assert_eq!(ended(&session).await, EndReason::Unresponsive);
    }

    #[tokio::test]
    async fn exit_invalid_output_and_frame_errors_end_the_run_once() {
        let (session, mut fake, ends) = start(Deadlines::default());
        fake.close();
        assert_eq!(ended(&session).await, EndReason::Exited);
        assert_eq!(ends.load(Ordering::SeqCst), 1);

        let (session, mut fake, ends) = start(Deadlines::default());
        assert!(fake.line("<frame garbage").await);
        assert_eq!(ended(&session).await, EndReason::Failed);
        let detail = session.ended().unwrap().info.detail.clone().unwrap();
        assert!(detail.starts_with("invalid output ("), "{detail}");
        timeout(WAIT, &mut fake.killed).await.unwrap().unwrap();
        assert_eq!(ends.load(Ordering::SeqCst), 1);

        let (session, mut fake, ends) = start(Deadlines::default());
        assert!(fake.line(&frame(VIEW, 1)).await);
        let failure = r#"<frame-error failure="java.lang.IllegalStateException: render" failureCode="VIEWPORT_BUDGET"/>"#;
        assert!(fake.line(failure).await);
        assert_eq!(ended(&session).await, EndReason::FrameError);
        timeout(WAIT, &mut fake.killed).await.unwrap().unwrap();
        let ended = session.ended().unwrap();
        assert_eq!(ended.cause.as_ref().unwrap().code, Code::ViewportBudget);
        assert_eq!(
            ended.info.message.as_deref(),
            Some("运行画面生成失败，已停止本次仿真")
        );
        assert!(!session.end(EndReason::Stopped, None, None));
        assert_eq!(ends.load(Ordering::SeqCst), 1);
        // The kept frames went with the run.
        assert_eq!(
            session.snapshot(None, false).unwrap_err().code,
            Code::FrameEvicted
        );
    }

    #[tokio::test]
    async fn waveform_samples_accumulate_across_frames() {
        let (session, mut fake, _) = start(Deadlines::default());
        assert!(fake.line(&frame_line(VIEW, 1, &trace("t1", 0, 3))).await);
        assert!(fake.line(&frame_line(VIEW, 2, &trace("t1", 0, 5))).await);
        let mut frames = session.frames();
        timeout(WAIT, frames.wait_for(|&sequence| sequence == 2))
            .await
            .unwrap()
            .unwrap();
        let (frame, delta) = session.latest(None).unwrap();
        let delta = delta.unwrap();
        assert!(delta.full);
        assert_eq!(delta.signals.len(), 1);
        assert_eq!(
            delta.samples.iter().map(|s| s.sample).collect::<Vec<_>>(),
            [0, 1, 2, 3, 4]
        );
        // A subscriber that has seen three samples gets the other two.
        let seen = TraceMark {
            total: 3,
            ..frame.trace.clone()
        };
        let delta = session.latest(Some(&seen)).unwrap().1.unwrap();
        assert!(!delta.full && delta.signals.is_empty());
        assert_eq!(
            delta.samples.iter().map(|s| s.sample).collect::<Vec<_>>(),
            [3, 4]
        );
        assert!(session.latest(Some(&frame.trace)).unwrap().1.is_none());
        // An older frame's waveform ends at that frame.
        let (_, older) = session.snapshot(Some(1), true).unwrap();
        assert_eq!(older.unwrap().samples.len(), 3);
        // The runtime dropped samples 5..600 between frames: a contiguous tail is kept.
        assert!(
            fake.line(&frame_line(VIEW, 3, &trace("t1", 600, 700)))
                .await
        );
        timeout(WAIT, frames.wait_for(|&sequence| sequence == 3))
            .await
            .unwrap()
            .unwrap();
        let delta = session.latest(Some(&frame.trace)).unwrap().1.unwrap();
        assert!(delta.full);
        assert_eq!(
            (delta.dropped, delta.total, delta.samples.len()),
            (600, 700, 100)
        );
        // A new waveform replaces the old one.
        assert!(fake.line(&frame_line(VIEW, 4, &trace("t2", 0, 1))).await);
        timeout(WAIT, frames.wait_for(|&sequence| sequence == 4))
            .await
            .unwrap()
            .unwrap();
        let (frame, delta) = session.latest(Some(&frame.trace)).unwrap();
        assert_eq!(
            (frame.trace.id.as_str(), delta.unwrap().samples.len()),
            ("t2", 1)
        );
        assert!(session.snapshot(Some(1), true).unwrap().1.is_none());
    }

    #[tokio::test]
    async fn frames_of_unknown_views_are_dropped_and_acks_move_the_view() {
        let (session, mut fake, _) = start(Deadlines::default());
        assert!(fake.line(&frame("elsewhere", 1)).await);
        assert!(fake.line(&frame(VIEW, 2)).await);
        let mut frames = session.frames();
        timeout(WAIT, frames.wait_for(|&sequence| sequence > 0))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(session.snapshot(None, false).unwrap().0.frame_sequence, 1);
        let inner = View {
            id: "v2".into(),
            circuit: "cell".into(),
            instance_path: vec!["c1".into()],
        };
        session.register(inner.clone());
        let command = tick(&session);
        let id = request_id(&fake.command().await);
        assert!(fake.line(&ack(id, "v2", 3)).await);
        timeout(WAIT, command).await.unwrap().unwrap().unwrap();
        assert_eq!(session.current_view(), inner);
        // A frame of the previous view still resolves.
        assert!(fake.line(&frame(VIEW, 4)).await);
        assert!(fake.line(&frame("v2", 5)).await);
        timeout(WAIT, frames.wait_for(|&sequence| sequence == 3))
            .await
            .unwrap()
            .unwrap();
        let (frame, _) = session.snapshot(None, false).unwrap();
        assert_eq!(frame.instance_path, ["c1"]);
        assert_eq!(session.snapshot(Some(2), false).unwrap().0.view_id, VIEW);
    }

    #[test]
    fn pictures_are_kept_by_count_and_bytes_and_the_newest_two_always() {
        let root = View {
            id: VIEW.into(),
            circuit: "main".into(),
            instance_path: Vec::new(),
        };
        let mut state = State::new(root);
        let kept = |state: &State| state.images.iter().map(|(n, _)| *n).collect::<Vec<_>>();
        for sequence in 1..=10 {
            state.push_image(sequence, Arc::new(vec![0; 1000]));
        }
        assert_eq!(kept(&state), (3..=10).collect::<Vec<_>>());
        for sequence in 11..=13 {
            state.push_image(sequence, Arc::new(vec![0; 13_000_000]));
        }
        assert_eq!(kept(&state), [12, 13]);
        state.push_image(14, Arc::new(vec![0; 1000]));
        assert_eq!(kept(&state), [13, 14]);
        assert_eq!(state.image_bytes, 13_001_000);
    }
}
