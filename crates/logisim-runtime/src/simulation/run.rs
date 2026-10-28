//! The run: one CircuitSession process. A writer task feeds its stdin from a
//! queue, a reader task parses its stdout, lays every frame over the newest
//! state and hands it to the subscribers, a supervisor owns the process and a
//! watchdog ends a run that stops responding. State sits behind a std mutex
//! that is held for microseconds, never across an await.
use super::{
    error::{Code, SimError},
    model::{
        ClockState, ComponentState, EndReason, EndedInfo, Frame, FrameEvent, LiveComponent,
        MemoryPage, RunInfo, SimulationEvent, Timing, TraceDelta, TraceSample, TraceSignal,
    },
    paint::Picture,
    protocol::{self, Line, RawFrame},
};
use crate::process::{StderrCapture, exit_failure};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex, MutexGuard, OnceLock, Weak},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Child,
    sync::{Notify, broadcast, mpsc, oneshot, watch},
    time::MissedTickBehavior,
};
use vibe_circuit_document::Circuit;

/// The longest output line accepted; a full frame carries the whole picture
/// as vector ops.
const LINE_LIMIT: u64 = 16_000_000;
/// Kept waveform samples, as many as the runtime keeps.
const SAMPLES: usize = 512;

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

/// The process side of a run.
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
    /// Tests: told when the run kills the process.
    #[cfg(test)]
    Fake(oneshot::Sender<()>),
}

pub(crate) struct Ended {
    pub info: EndedInfo,
    /// The runtime failure that ended the run, when it reported one.
    pub cause: Option<SimError>,
}

/// Called once when a run ends, after its waiting commands were answered.
pub(crate) type OnEnd = Box<dyn Fn(&Run) + Send + Sync>;

pub(crate) type Events = broadcast::Sender<Arc<SimulationEvent>>;

struct Waiter {
    sent_at: Instant,
    reply: oneshot::Sender<Result<u64, SimError>>,
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
    fn update(&mut self, delta: &TraceDelta) {
        if delta.full || delta.id != self.id {
            *self = Self {
                id: delta.id.clone(),
                signals: delta.signals.clone(),
                ..Self::default()
            };
        }
        for sample in &delta.samples {
            if sample.sample < self.total {
                continue;
            }
            if sample.sample > self.total {
                // Samples before this one are gone; keep a contiguous tail.
                self.samples.clear();
            }
            self.total = sample.sample + 1;
            self.samples.push_back(sample.clone());
            if self.samples.len() > SAMPLES {
                self.samples.pop_front();
            }
        }
        if delta.total > self.total {
            self.samples.clear();
            self.total = delta.total;
        }
        self.recording = delta.recording;
    }
    fn whole(&self) -> TraceDelta {
        TraceDelta {
            id: self.id.clone(),
            recording: self.recording,
            total: self.total,
            dropped: self
                .samples
                .front()
                .map_or(self.total, |sample| sample.sample),
            full: true,
            signals: self.signals.clone(),
            samples: self.samples.iter().cloned().collect(),
        }
    }
}

/// The run's newest whole state: every frame laid over the previous ones.
#[derive(Default)]
struct Latest {
    circuit: String,
    instance_path: Vec<String>,
    command_sequence: u64,
    clock: Option<ClockState>,
    timing: Timing,
    at: u64,
    components: BTreeMap<String, LiveComponent>,
    memory: Option<MemoryPage>,
    picture: Picture,
    trace: TraceRing,
}

impl Latest {
    /// Lays a frame over the state; returns the frame as subscribers get it.
    fn apply(&mut self, raw: RawFrame) -> FrameEvent {
        if raw.full {
            self.components.clear();
        }
        let mut components = BTreeMap::new();
        for (id, component) in raw.components {
            self.components.insert(id.clone(), component.clone());
            components.insert(id, component);
        }
        let paint = self.picture.apply(raw.full, raw.paint);
        let memory = (raw.full || raw.memory != self.memory)
            .then(|| raw.memory.clone())
            .flatten();
        self.memory = raw.memory;
        if let Some(trace) = &raw.trace {
            self.trace.update(trace);
        }
        self.circuit.clone_from(&raw.circuit);
        self.instance_path.clone_from(&raw.instance_path);
        self.command_sequence = raw.command_sequence;
        self.clock = Some(raw.clock.clone());
        self.timing = raw.timing;
        self.at = now_ms();
        if !raw.full && self.picture.worn() {
            // Subscribers start over with the picture whole and numbered anew.
            self.picture.renumber();
            return self.whole(&raw.clock);
        }
        FrameEvent {
            full: raw.full,
            circuit: raw.circuit,
            instance_path: raw.instance_path,
            command_sequence: raw.command_sequence,
            clock: raw.clock,
            components,
            memory,
            trace: raw.trace,
            paint,
            timing: raw.timing,
        }
    }
    /// The whole state as one full frame.
    fn whole(&self, clock: &ClockState) -> FrameEvent {
        FrameEvent {
            full: true,
            circuit: self.circuit.clone(),
            instance_path: self.instance_path.clone(),
            command_sequence: self.command_sequence,
            clock: clock.clone(),
            components: self.components.clone(),
            memory: self.memory.clone(),
            trace: Some(self.trace.whole()),
            paint: self.picture.event(),
            timing: self.timing,
        }
    }
}

struct State {
    waiting: VecDeque<Waiter>,
    last_ack_at: Instant,
    last_frame_at: Instant,
    /// Subscribers know of the run: its frames go to them.
    announced: bool,
    latest: Latest,
}

pub(crate) struct Run {
    pub info: RunInfo,
    circuits: Vec<Circuit>,
    deadlines: Deadlines,
    state: Mutex<State>,
    commands: mpsc::UnboundedSender<String>,
    ended: OnceLock<Ended>,
    kill: Mutex<Option<oneshot::Sender<()>>>,
    exited: watch::Receiver<bool>,
    /// Set once the first frame arrived or the run ended.
    ready: watch::Sender<bool>,
    events: Events,
    on_end: OnEnd,
}

impl Run {
    pub(crate) fn spawn(
        info: RunInfo,
        circuits: Vec<Circuit>,
        io: Io,
        deadlines: Deadlines,
        events: Events,
        on_end: OnEnd,
    ) -> Arc<Self> {
        let (commands, queue) = mpsc::unbounded_channel();
        let (kill, killed) = oneshot::channel();
        let (exit, exited) = watch::channel(false);
        let now = Instant::now();
        let run = Arc::new(Self {
            info,
            circuits,
            deadlines,
            state: Mutex::new(State {
                waiting: VecDeque::new(),
                last_ack_at: now,
                last_frame_at: now,
                announced: false,
                latest: Latest::default(),
            }),
            commands,
            ended: OnceLock::new(),
            kill: Mutex::new(Some(kill)),
            exited,
            ready: watch::channel(false).0,
            events,
            on_end,
        });
        let eof = Arc::new(Notify::new());
        let weak = Arc::downgrade(&run);
        tokio::spawn(write(io.input, queue));
        tokio::spawn(read(weak.clone(), io.output, eof.clone()));
        tokio::spawn(supervise(weak.clone(), io.process, killed, eof, exit));
        tokio::spawn(watchdog(weak, deadlines.tick));
        run
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

    /// Ends the run once: answers waiting commands, kills the process and runs
    /// the end hook. Later calls change nothing.
    pub(crate) fn end(
        &self,
        reason: EndReason,
        cause: Option<SimError>,
        detail: Option<String>,
    ) -> bool {
        let detail = detail.or_else(|| cause.as_ref().and_then(|c| c.detail().map(str::to_owned)));
        let ended = Ended {
            info: EndedInfo {
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
        // From here on the reader hands no frame on: it looks at `ended` under this lock.
        let waiting = std::mem::take(&mut self.lock().waiting);
        let error = SimError::new(match reason {
            EndReason::Unresponsive => Code::Unresponsive,
            _ => Code::SessionEnded,
        });
        for waiter in waiting {
            let _ = waiter.reply.send(Err(error.clone()));
        }
        self.kill();
        self.ready.send_replace(true);
        (self.on_end)(self);
        true
    }

    fn kill(&self) {
        let kill = self.kill.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(kill) = kill {
            let _ = kill.send(());
        }
    }

    /// Sends one line and waits for its acknowledgement: the command sequence
    /// after it, or why the runtime refused it. The process answers lines in
    /// the order they were written, so the waiters queue in that order too.
    pub(crate) async fn send(&self, line: String) -> Result<u64, SimError> {
        let (reply, answer) = oneshot::channel();
        {
            let mut state = self.lock();
            if self.ended.get().is_some() || self.commands.send(line).is_err() {
                return Err(Code::SessionEnded.into());
            }
            state.waiting.push_back(Waiter {
                sent_at: Instant::now(),
                reply,
            });
        }
        answer
            .await
            .unwrap_or_else(|_| Err(Code::SessionEnded.into()))
    }

    /// Answers the oldest waiting command. False when nobody waits: the
    /// process acknowledged a line it was never sent.
    fn acknowledge(&self, result: Result<u64, SimError>) -> bool {
        let waiter = {
            let mut state = self.lock();
            state.last_ack_at = Instant::now();
            state.waiting.pop_front()
        };
        waiter.is_some_and(|waiter| {
            let _ = waiter.reply.send(result);
            true
        })
    }

    /// Lays a frame over the newest state and, once the run is announced,
    /// hands it to the subscribers in the same critical section, so that a
    /// subscription taken meanwhile has it either in its whole state or as
    /// its next event.
    fn frame(&self, raw: RawFrame) {
        {
            let mut state = self.lock();
            if self.ended.get().is_some() {
                return;
            }
            state.last_frame_at = Instant::now();
            let event = state.latest.apply(raw);
            if state.announced {
                let _ = self
                    .events
                    .send(Arc::new(SimulationEvent::Frame(Box::new(event))));
            }
        }
        self.ready
            .send_if_modified(|ready| !std::mem::replace(ready, true));
    }

    /// Waits for the first frame. False when the run ended first or the deadline passed.
    pub(crate) async fn first_frame(&self) -> bool {
        let mut ready = self.ready.subscribe();
        let arrived = ready.wait_for(|&ready| ready);
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

    /// The run's start and whole state, unless it has not shown a frame or ended.
    fn whole_events(&self, state: &State) -> Option<[Arc<SimulationEvent>; 2]> {
        if self.ended.get().is_some() {
            return None;
        }
        let clock = state.latest.clock.as_ref()?;
        Some([
            Arc::new(SimulationEvent::Run {
                run: self.info.clone(),
            }),
            Arc::new(SimulationEvent::Frame(Box::new(state.latest.whole(clock)))),
        ])
    }

    /// Tells the subscribers of the run, with its whole state; its frames go
    /// to them from then on. False when it ended first.
    pub(crate) fn announce(&self) -> bool {
        let mut state = self.lock();
        let Some(events) = self.whole_events(&state) else {
            return false;
        };
        for event in events {
            let _ = self.events.send(event);
        }
        state.announced = true;
        true
    }

    /// The run's start and whole state for a new subscriber, and what `then`
    /// gives, under the lock frames are handed on under, so that no frame
    /// falls between the two.
    pub(crate) fn whole<T>(
        &self,
        then: impl FnOnce() -> T,
    ) -> (Option<[Arc<SimulationEvent>; 2]>, T) {
        let state = self.lock();
        let events = state.announced.then(|| self.whole_events(&state)).flatten();
        (events, then())
    }

    /// The newest state in Logisim's long form and the waveform, for keeping.
    pub(crate) fn record(&self) -> Option<(Frame, TraceDelta)> {
        let state = self.lock();
        let latest = &state.latest;
        let frame = Frame {
            command_sequence: latest.command_sequence,
            circuit: latest.circuit.clone(),
            instance_path: latest.instance_path.clone(),
            clock: latest.clock.clone()?,
            components: latest
                .components
                .iter()
                .map(|(id, live)| ComponentState::of(id, live))
                .collect(),
            memory: latest.memory.clone(),
            timing: latest.timing,
            at: latest.at,
        };
        Some((frame, latest.trace.whole()))
    }

    /// Why the run counts as unresponsive, if it does.
    fn stalled(&self) -> Option<String> {
        let state = self.lock();
        let now = Instant::now();
        let limit = self.deadlines.unresponsive;
        if let Some(oldest) = state.waiting.front() {
            // Commands are pipelined: any acknowledgement counts as progress.
            let waited = now.duration_since(oldest.sent_at.max(state.last_ack_at));
            return (waited >= limit)
                .then(|| format!("no acknowledgement for {} ms", waited.as_millis()));
        }
        let running = state
            .latest
            .clock
            .as_ref()
            .is_some_and(|clock| clock.running);
        let quiet = now.duration_since(state.last_frame_at);
        (running && quiet >= limit)
            .then(|| format!("no frame for {} ms while the clock runs", quiet.as_millis()))
    }
}

impl Drop for Run {
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

async fn read(run: Weak<Run>, output: Box<dyn AsyncRead + Send + Unpin>, eof: Arc<Notify>) {
    let mut output = BufReader::with_capacity(1 << 16, output);
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = (&mut output)
            .take(LINE_LIMIT + 1)
            .read_until(b'\n', &mut line)
            .await;
        let Some(run) = run.upgrade() else {
            break;
        };
        if run.ended().is_some() {
            break;
        }
        match read {
            Ok(0) | Err(_) => break,
            Ok(_) if line.last() != Some(&b'\n') => {
                if line.len() as u64 > LINE_LIMIT {
                    let detail = format!("an output line exceeded {LINE_LIMIT} bytes");
                    run.end(EndReason::Failed, None, Some(detail));
                }
                // Otherwise the process stopped mid-line while exiting.
                break;
            }
            Ok(_) => {}
        }
        let parsed = std::str::from_utf8(&line)
            .map_err(|error| error.to_string())
            .and_then(|text| protocol::parse(text.trim_end_matches(['\n', '\r'])));
        match parsed {
            Err(reason) => {
                // The line itself may carry circuit content; diagnostics keep its shape only.
                let detail = format!("invalid output ({reason}; {} bytes)", line.len());
                run.end(EndReason::Failed, None, Some(detail));
                break;
            }
            Ok(Line::Ack(result)) => {
                if !run.acknowledge(result) {
                    let detail = "an acknowledgement without a command".to_owned();
                    run.end(EndReason::Failed, None, Some(detail));
                    break;
                }
            }
            Ok(Line::Frame(raw)) => run.frame(*raw),
            Ok(Line::FrameError(cause)) => {
                run.end(EndReason::FrameError, Some(cause), None);
                break;
            }
            Ok(Line::StartError(cause)) => {
                run.end(EndReason::Failed, Some(cause), None);
                break;
            }
        }
    }
    eof.notify_one();
}

async fn supervise(
    run: Weak<Run>,
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
                if let Some(run) = run.upgrade() {
                    run.end(EndReason::Exited, None, Some(detail));
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
            } else if let Some(run) = run.upgrade() {
                let detail = "the process closed its output".to_owned();
                run.end(EndReason::Exited, None, Some(detail));
            }
        }
    }
    exit.send_replace(true);
}

async fn watchdog(run: Weak<Run>, period: Duration) {
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let Some(run) = run.upgrade() else {
            return;
        };
        if run.ended().is_some() {
            return;
        }
        if let Some(detail) = run.stalled() {
            run.end(EndReason::Unresponsive, None, Some(detail));
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::{
        io::{DuplexStream, Lines},
        time::timeout,
    };

    pub(crate) const WAIT: Duration = Duration::from_secs(60);

    /// The runtime end of a run: what the host wrote, and its output.
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

    pub(crate) fn ack(sequence: u64) -> String {
        format!(
            r#"<ack circuit="main" commandSequence="{sequence}" ticks="0" running="false" automatic="true" pending="false" frequency="2.0" actualFrequency="0.0" oscillating="false"/>"#
        )
    }

    pub(crate) fn attribute(line: &str, name: &str) -> String {
        line.split(&format!(" {name}=\""))
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap_or_else(|| panic!("{name} in {line}"))
            .to_owned()
    }

    fn spawn(deadlines: Deadlines) -> (Arc<Run>, Fake, Arc<AtomicUsize>) {
        let (io, fake) = fake();
        let ends = Arc::new(AtomicUsize::new(0));
        let counted = ends.clone();
        let info = RunInfo {
            document_id: "d1".into(),
            document_name: "test.circ".into(),
            document_path: None,
            revision: "r1".into(),
            root_circuit: "main".into(),
            runtime: RuntimeKind::Current,
            started_at: now_ms(),
        };
        let on_end: OnEnd = Box::new(move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
        });
        let events = broadcast::channel(16).0;
        let run = Run::spawn(info, Vec::new(), io, deadlines, events, on_end);
        (run, fake, ends)
    }

    fn input(run: &Arc<Run>, bits: &str) -> tokio::task::JoinHandle<Result<u64, SimError>> {
        let run = run.clone();
        let line = protocol::command_line(&Command::Input {
            component_id: "a".into(),
            bits: bits.into(),
        })
        .unwrap();
        tokio::spawn(async move { run.send(line).await })
    }

    async fn ended(run: &Run) -> EndReason {
        let mut ready = run.ready.subscribe();
        timeout(WAIT, ready.wait_for(|_| run.ended().is_some()))
            .await
            .expect("the run ends")
            .unwrap();
        run.ended().unwrap().info.reason_code
    }

    async fn sequence(run: &Run, sequence: u64) {
        timeout(WAIT, async {
            while run.lock().latest.command_sequence < sequence {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn acks_answer_commands_in_order_while_frames_flow() {
        let (run, mut fake, _) = spawn(Deadlines::default());
        let commands: Vec<_> = ["1", "10", "11"]
            .into_iter()
            .map(|bits| (bits, input(&run, bits)))
            .collect();
        let mut lines = Vec::new();
        for _ in 0..3 {
            lines.push(fake.command().await);
        }
        assert!(fake.line(&frame_line(true, 1)).await);
        for sequence in 2..=10_000 {
            assert!(fake.line(&frame_line(false, sequence)).await);
        }
        sequence(&run, 10_000).await;
        assert!(commands.iter().all(|(_, command)| !command.is_finished()));
        // Each ack answers the line in its place: here its bits as the sequence.
        for line in &lines {
            let bits = attribute(line, "bits");
            assert!(
                fake.line(&ack(u64::from_str_radix(&bits, 2).unwrap()))
                    .await
            );
        }
        for (bits, command) in commands {
            let sequence = timeout(WAIT, command).await.unwrap().unwrap().unwrap();
            assert_eq!(sequence, u64::from_str_radix(bits, 2).unwrap());
        }
        // The newest state is the frames laid over each other.
        let (frame, trace) = run.record().unwrap();
        assert_eq!(frame.command_sequence, 10_000);
        assert_eq!(frame.components.len(), 2);
        assert_eq!(frame.components[1].ports[0].signal.bits, "0000 0011");
        assert!(trace.full && trace.samples.is_empty());
        // A refusal answers its own command and leaves the run going.
        let refused = input(&run, "1");
        fake.command().await;
        let line = r#"<ack error="com.cburch.logisim.file.SessionError: x" code="INPUT_NOT_OPERABLE" message="x"/>"#;
        assert!(fake.line(line).await);
        let error = timeout(WAIT, refused).await.unwrap().unwrap().unwrap_err();
        assert_eq!(error.code, Code::InputNotOperable);
        assert!(run.ended().is_none());
    }

    #[tokio::test]
    async fn a_stalled_or_broken_runtime_ends_the_run_once() {
        let deadlines = Deadlines {
            tick: Duration::from_millis(10),
            unresponsive: Duration::from_millis(150),
            first_frame: Duration::from_secs(1),
        };
        // No acknowledgement: the waiting command learns why.
        let (run, mut fake, ends) = spawn(deadlines);
        let command = input(&run, "1");
        fake.command().await;
        let error = timeout(WAIT, command).await.unwrap().unwrap().unwrap_err();
        assert_eq!(error.code, Code::Unresponsive);
        assert_eq!(ended(&run).await, EndReason::Unresponsive);
        timeout(WAIT, &mut fake.killed).await.unwrap().unwrap();
        let next = timeout(WAIT, input(&run, "1")).await.unwrap().unwrap();
        assert_eq!(next.unwrap_err().code, Code::SessionEnded);
        assert!(!run.end(EndReason::Stopped, None, None));
        assert_eq!(ends.load(Ordering::SeqCst), 1);

        // A paused run may be quiet; a running clock without frames is not.
        let (run, mut fake, _) = spawn(deadlines);
        let paused = frame_line(true, 1).replace(r#"running="true""#, r#"running="false""#);
        assert!(fake.line(&paused).await);
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(run.ended().is_none());
        assert!(fake.line(&frame_line(false, 2)).await);
        assert_eq!(ended(&run).await, EndReason::Unresponsive);

        let (run, mut fake, _) = spawn(Deadlines::default());
        fake.close();
        assert_eq!(ended(&run).await, EndReason::Exited);

        let (run, mut fake, _) = spawn(Deadlines::default());
        assert!(fake.line("<frame garbage").await);
        assert_eq!(ended(&run).await, EndReason::Failed);
        let detail = run.ended().unwrap().info.detail.clone().unwrap();
        assert!(detail.starts_with("invalid output ("), "{detail}");

        let (run, mut fake, _) = spawn(Deadlines::default());
        assert!(fake.line(&ack(1)).await);
        assert_eq!(ended(&run).await, EndReason::Failed);

        let (run, mut fake, ends) = spawn(Deadlines::default());
        assert!(fake.line(&frame_line(true, 1)).await);
        let failure = r#"<frame-error failure="com.cburch.logisim.file.SessionError: x" failureCode="INSTANCE_NOT_READY"/>"#;
        assert!(fake.line(failure).await);
        assert_eq!(ended(&run).await, EndReason::FrameError);
        timeout(WAIT, &mut fake.killed).await.unwrap().unwrap();
        let ended = run.ended().unwrap();
        assert_eq!(ended.cause.as_ref().unwrap().code, Code::InstanceNotReady);
        assert_eq!(
            ended.info.message.as_deref(),
            Some("运行画面生成失败，已停止本次仿真")
        );
        assert_eq!(ends.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn waveform_samples_accumulate_across_frames() {
        let (run, mut fake, _) = spawn(Deadlines::default());
        let trace = |from: u64, total: u64, full: bool| {
            let signals = if full {
                r#"<signal key="a:0" width="1"/>"#
            } else {
                ""
            };
            let samples: String = (from..total)
                .map(|n| {
                    format!(
                        r#"<sample sequence="{n}" tick="{n}" cause="tick">{}</sample>"#,
                        n % 2
                    )
                })
                .collect();
            format!(
                r#"<trace id="t1" recording="true" total="{total}" dropped="0" full="{full}">{signals}{samples}</trace>"#
            )
        };
        let with = |line: String, trace: String| {
            line.replace(
                r#"<trace id="t0" recording="false" total="0" dropped="0" full="true"/>"#,
                "",
            )
            .replace("<paint>", &format!("{trace}<paint>"))
        };
        assert!(
            fake.line(&with(frame_line(true, 1), trace(0, 3, true)))
                .await
        );
        assert!(
            fake.line(&with(frame_line(false, 2), trace(3, 5, false)))
                .await
        );
        sequence(&run, 2).await;
        let (_, whole) = run.record().unwrap();
        assert!(whole.full && whole.signals.len() == 1);
        assert_eq!(
            whole.samples.iter().map(|s| s.sample).collect::<Vec<_>>(),
            [0, 1, 2, 3, 4]
        );
        // Samples before 600 are gone: a contiguous tail is kept.
        assert!(
            fake.line(&with(frame_line(false, 3), trace(600, 700, false)))
                .await
        );
        sequence(&run, 3).await;
        let (_, whole) = run.record().unwrap();
        assert_eq!(
            (whole.dropped, whole.total, whole.samples.len()),
            (600, 700, 100)
        );
    }
}
