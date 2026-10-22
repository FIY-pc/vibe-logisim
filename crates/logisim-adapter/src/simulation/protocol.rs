//! The line protocol of the CircuitSession process: one XML document per line.
//! Commands carry a `requestId` that the process echoes on its ack.
use super::{
    error::{Code, SimError},
    model::{
        Bounds, ButtonValue, ClockState, Command, ComponentState, Control, FrameImage, MemoryPage,
        MemoryStorage, PortState, Signal, Timing, TraceSample, TraceSignal,
    },
};
use quick_xml::{
    XmlVersion,
    events::{BytesStart, Event},
    reader::Reader,
};
use std::{borrow::Cow, fmt::Write as _, str::FromStr};
use vibe_workspace_core::Component;

/// Metadata on every ack and frame.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AckMeta {
    pub view_id: String,
    pub circuit: String,
    pub command_sequence: u64,
    pub clock: ClockState,
}

pub(crate) struct RawTrace {
    pub id: String,
    pub recording: bool,
    pub total: u64,
    pub signals: Vec<TraceSignal>,
    /// Only samples not yet known to the reader.
    pub samples: Vec<TraceSample>,
}

pub(crate) struct RawFrame {
    pub meta: AckMeta,
    pub timing: Timing,
    pub components: Vec<ComponentState>,
    pub memory: Option<MemoryPage>,
    pub trace: RawTrace,
    pub image: FrameImage,
    /// Base64 PNG.
    pub png: String,
}

pub(crate) enum Line {
    Ack {
        request_id: Option<u64>,
        result: Result<AckMeta, SimError>,
    },
    Frame(Box<RawFrame>),
    /// The frame thread failed; the process no longer renders.
    FrameError(SimError),
    /// The process could not open the circuit and is exiting.
    StartError(SimError),
}

struct Attrs<'a>(Vec<(&'a str, Cow<'a, str>)>);

impl<'a> Attrs<'a> {
    fn of(element: &'a BytesStart<'_>) -> Result<Self, String> {
        let mut values = Vec::new();
        for attribute in element.attributes() {
            let attribute = attribute.map_err(|e| e.to_string())?;
            let value = attribute
                .normalized_value(XmlVersion::Implicit1_0)
                .map_err(|e| e.to_string())?;
            values.push((attribute.key.0, value));
        }
        Ok(Self(values))
    }
    fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.as_ref())
    }
    fn text(&self, name: &str) -> Result<&str, String> {
        self.get(name).ok_or_else(|| format!("missing {name}"))
    }
    fn number<T: FromStr>(&self, name: &str) -> Result<T, String> {
        self.text(name)?
            .parse()
            .map_err(|_| format!("invalid {name}"))
    }
    fn optional<T: FromStr>(&self, name: &str) -> Result<Option<T>, String> {
        self.get(name)
            .map(|value| value.parse().map_err(|_| format!("invalid {name}")))
            .transpose()
    }
    fn flag(&self, name: &str) -> Result<bool, String> {
        match self.text(name)? {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(format!("invalid {name}")),
        }
    }
    fn meta(&self) -> Result<AckMeta, String> {
        Ok(AckMeta {
            view_id: self.text("viewId")?.into(),
            circuit: self.text("circuit")?.into(),
            command_sequence: self.number("commandSequence")?,
            clock: ClockState {
                ticks: self.number("ticks")?,
                running: self.flag("running")?,
                automatic: self.flag("automatic")?,
                pending: self.flag("pending")?,
                frequency: self.number("frequency")?,
                actual_frequency: self.number("actualFrequency")?,
                oscillating: self.flag("oscillating")?,
                failure: self.failure(),
            },
        })
    }
    fn failure(&self) -> Option<SimError> {
        self.get("failure")
            .map(|failure| SimError::from_java(self.get("failureCode"), None, failure))
    }
    fn signal(&self) -> Result<Signal, String> {
        Ok(Signal {
            width: self.number("width")?,
            bits: self.text("bits")?.into(),
            value: self.optional("value")?,
        })
    }
}

/// Parses one output line. `known` is the waveform id and sample count the
/// reader already has; samples below it are skipped.
pub(crate) fn parse(line: &str, known: Option<(&str, u64)>) -> Result<Line, String> {
    let mut reader = Reader::from_str(line);
    let (root, empty) = loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(element) => break (element, false),
            Event::Empty(element) => break (element, true),
            Event::Text(text) if text.xml10_content().trim().is_empty() => continue,
            Event::Eof => return Err("empty line".into()),
            _ => return Err("unexpected content before the root element".into()),
        }
    };
    let attrs = Attrs::of(&root)?;
    match root.name().0 {
        "ack" => {
            let request_id = attrs.optional("requestId")?;
            let result = match attrs.get("error") {
                Some(error) => Err(SimError::from_java(
                    attrs.get("code"),
                    attrs.get("message"),
                    error,
                )),
                None => Ok(attrs.meta()?),
            };
            Ok(Line::Ack { request_id, result })
        }
        "frame-error" => Ok(Line::FrameError(attrs.failure().unwrap_or_else(|| {
            SimError::new(Code::Internal).with_detail("frame error without failure")
        }))),
        "start-error" => Ok(Line::StartError(SimError::from_java(
            attrs.get("code"),
            attrs.get("message"),
            attrs.text("error")?,
        ))),
        "frame" if !empty => {
            let meta = attrs.meta()?;
            let timing = Timing {
                capture_ms: attrs.number("captureMs")?,
                encode_ms: attrs.number("encodeMs")?,
            };
            frame(&mut reader, meta, timing, known).map(|frame| Line::Frame(Box::new(frame)))
        }
        name => Err(format!("unexpected element {name}")),
    }
}

/// Where the parser is inside a frame.
enum Open {
    Frame,
    Component(ComponentState),
    Memory(MemoryPage),
    Trace,
    Sample {
        sample: TraceSample,
        keep: bool,
        text: String,
    },
    Render(FrameImage, String),
    Other,
}

#[derive(Default)]
struct Parts {
    components: Vec<ComponentState>,
    memory: Option<MemoryPage>,
    trace: Option<RawTrace>,
    render: Option<(FrameImage, String)>,
}

impl Parts {
    fn close(&mut self, open: Open) -> Result<(), String> {
        match open {
            Open::Component(component) => self.components.push(component),
            Open::Memory(page) => self.memory = Some(page),
            Open::Sample {
                mut sample,
                keep: true,
                text,
            } => {
                let trace = self.trace.as_mut().ok_or("sample outside trace")?;
                sample.values = text.split('|').map(str::to_owned).collect();
                if sample.values.len() != trace.signals.len() {
                    return Err("sample does not match signals".into());
                }
                trace.samples.push(sample);
            }
            Open::Render(image, png) => self.render = Some((image, png)),
            Open::Frame | Open::Trace | Open::Sample { .. } | Open::Other => {}
        }
        Ok(())
    }
}

fn frame(
    reader: &mut Reader<&[u8]>,
    meta: AckMeta,
    timing: Timing,
    known: Option<(&str, u64)>,
) -> Result<RawFrame, String> {
    let mut stack = vec![Open::Frame];
    let mut parts = Parts::default();
    loop {
        let (element, empty) = match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(element) => (element, false),
            Event::Empty(element) => (element, true),
            Event::End(_) => match stack.pop() {
                Some(Open::Frame) | None => break,
                Some(open) => {
                    parts.close(open)?;
                    continue;
                }
            },
            Event::Text(text) => {
                if let Some(Open::Sample { text: buffer, .. } | Open::Render(_, buffer)) =
                    stack.last_mut()
                {
                    buffer.push_str(&text.xml10_content());
                }
                continue;
            }
            Event::GeneralRef(reference) => {
                let resolved = if reference.is_char_ref() {
                    reference
                        .resolve_char_ref()
                        .map_err(|e| e.to_string())?
                        .ok_or("invalid character reference")?
                } else {
                    match reference.xml10_content().as_ref() {
                        "lt" => '<',
                        "gt" => '>',
                        "amp" => '&',
                        "apos" => '\'',
                        "quot" => '"',
                        _ => return Err("unknown entity".into()),
                    }
                };
                if let Some(Open::Sample { text: buffer, .. } | Open::Render(_, buffer)) =
                    stack.last_mut()
                {
                    buffer.push(resolved);
                }
                continue;
            }
            Event::Eof => return Err("truncated frame".into()),
            _ => continue,
        };
        let attrs = Attrs::of(&element)?;
        let open = match (stack.last_mut(), element.name().0) {
            (Some(Open::Frame), "component") => Open::Component(ComponentState {
                id: attrs.text("id")?.into(),
                control: attrs
                    .get("control")
                    .map(|control| match control {
                        "input" => Ok(Control::Input),
                        "parent-input" => Ok(Control::ParentInput),
                        "pulse" => Ok(Control::Pulse),
                        "clock" => Ok(Control::Clock),
                        _ => Err("invalid control"),
                    })
                    .transpose()?,
                input: None,
                ports: Vec::new(),
            }),
            (Some(Open::Component(component)), "input") => {
                component.input = Some(attrs.signal()?);
                Open::Other
            }
            (Some(Open::Component(component)), "port") => {
                component.ports.push(PortState {
                    index: attrs.number("index")?,
                    signal: attrs.signal()?,
                });
                Open::Other
            }
            (Some(Open::Frame), "memory") => Open::Memory(MemoryPage {
                component_id: attrs.text("componentId")?.into(),
                offset: attrs.number("offset")?,
                address_bits: attrs.number("addressBits")?,
                data_bits: attrs.number("dataBits")?,
                length: attrs.number("length")?,
                storage: match attrs.text("storage")? {
                    "design" => MemoryStorage::Design,
                    _ => MemoryStorage::Runtime,
                },
                words: Vec::new(),
            }),
            (Some(Open::Memory(page)), "word") => {
                page.words.push(attrs.number("value")?);
                Open::Other
            }
            (Some(Open::Frame), "trace") => {
                parts.trace = Some(RawTrace {
                    id: attrs.text("id")?.into(),
                    recording: attrs.flag("recording")?,
                    total: attrs.number("total")?,
                    signals: Vec::new(),
                    samples: Vec::new(),
                });
                Open::Trace
            }
            (Some(Open::Trace), "signal") => {
                let trace = parts.trace.as_mut().ok_or("signal outside trace")?;
                let id = attrs.text("key")?;
                let (component, port) = id.rsplit_once(':').ok_or("invalid signal key")?;
                trace.signals.push(TraceSignal {
                    id: id.into(),
                    component_id: component.into(),
                    port: port.parse().map_err(|_| "invalid signal port")?,
                    width: attrs.number("width")?,
                });
                Open::Other
            }
            (Some(Open::Trace), "sample") => {
                let trace = parts.trace.as_ref().ok_or("sample outside trace")?;
                let sample: u64 = attrs.number("sequence")?;
                Open::Sample {
                    keep: known.is_none_or(|(id, next)| id != trace.id || sample >= next),
                    sample: TraceSample {
                        sample,
                        tick: attrs.number("tick")?,
                        cause: attrs.text("cause")?.into(),
                        values: Vec::new(),
                    },
                    text: String::new(),
                }
            }
            (Some(Open::Frame), "render") => Open::Render(
                FrameImage {
                    width: attrs.number("pixelWidth")?,
                    height: attrs.number("pixelHeight")?,
                    bounds: Bounds {
                        x: attrs.number("x")?,
                        y: attrs.number("y")?,
                        width: attrs.number("width")?,
                        height: attrs.number("height")?,
                    },
                    scale: attrs.number("scale")?,
                },
                String::new(),
            ),
            _ => Open::Other,
        };
        if empty {
            parts.close(open)?;
        } else {
            stack.push(open);
        }
    }
    let (image, png) = parts.render.ok_or("frame without render")?;
    Ok(RawFrame {
        meta,
        timing,
        components: parts.components,
        memory: parts.memory,
        trace: parts.trace.ok_or("frame without trace")?,
        image,
        png,
    })
}

/// Escapes an attribute value; fails on characters XML 1.0 cannot carry.
fn escape(out: &mut String, value: &str) -> Result<(), ()> {
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\n' => out.push_str("&#10;"),
            '\r' => out.push_str("&#13;"),
            '\t' => out.push_str("&#9;"),
            '\u{0}'..='\u{1f}' | '\u{fffe}' | '\u{ffff}' => return Err(()),
            c => out.push(c),
        }
    }
    Ok(())
}

/// Builds `<tag a="v" …>` without the closing bracket.
struct Element(String);

impl Element {
    fn new(tag: &str) -> Self {
        Self(format!("<{tag}"))
    }
    fn attr(mut self, name: &str, value: &str) -> Result<Self, SimError> {
        write!(self.0, " {name}=\"").ok();
        escape(&mut self.0, value).map_err(|()| {
            SimError::new(Code::Internal).with_detail(format!("{name} cannot be written as XML"))
        })?;
        self.0.push('"');
        Ok(self)
    }
    fn empty(mut self) -> String {
        self.0.push_str("/>");
        self.0
    }
    fn children(mut self, children: &[String], tag: &str) -> String {
        self.0.push('>');
        for child in children {
            self.0.push_str(child);
        }
        write!(self.0, "</{tag}>").ok();
        self.0
    }
}

fn located(tag: &str, component: &Component, id: bool) -> Result<String, SimError> {
    let mut element = Element::new(tag);
    if id {
        element = element.attr("id", &component.id)?;
    }
    Ok(element
        .attr("factory", &component.name)?
        .attr("x", &component.location.x.to_string())?
        .attr("y", &component.location.y.to_string())?
        .empty())
}

/// The file the process reads at start: the root circuit and how its
/// component ids address components.
pub(crate) fn init_document(
    circuit: &str,
    view_id: &str,
    components: &[Component],
) -> Result<String, SimError> {
    let children = components
        .iter()
        .map(|component| located("component", component, true))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Element::new("session")
        .attr("circuit", circuit)?
        .attr("viewId", view_id)?
        .children(&children, "session"))
}

/// Switches the process to a subcircuit instance; `instances` is the path from the root.
pub(crate) fn view_line(
    request_id: u64,
    circuit: &str,
    view_id: &str,
    instances: &[&Component],
    components: &[Component],
) -> Result<String, SimError> {
    let mut children = instances
        .iter()
        .map(|instance| located("instance", instance, false))
        .collect::<Result<Vec<_>, _>>()?;
    for component in components {
        children.push(located("component", component, true)?);
    }
    Ok(Element::new("view")
        .attr("circuit", circuit)?
        .attr("viewId", view_id)?
        .attr("requestId", &request_id.to_string())?
        .children(&children, "view")
        + "\n")
}

/// One command line. `start` has none: a run starts by launching the process.
pub(crate) fn command_line(
    request_id: u64,
    view_id: &str,
    command: &Command,
) -> Result<String, SimError> {
    let op = match command {
        Command::Start => {
            return Err(SimError::new(Code::Internal).with_detail("start is not a runtime command"));
        }
        Command::ToggleClock => "toggle-clock",
        Command::Play => "play",
        Command::Pause => "pause",
        Command::Tick => "tick",
        Command::Reset => "reset",
        Command::TogglePropagation => "toggle-propagation",
        Command::Step => "step",
        Command::Configure { .. } => "configure",
        Command::Poke { .. } => "poke",
        Command::Input { .. } => "input",
        Command::Button { .. } => "button",
        Command::Pulse { .. } => "pulse",
        Command::Trace { .. } => "trace",
        Command::TraceStop => "trace-stop",
        Command::Memory { .. } => "memory",
        Command::MemoryWrite { .. } => "memory-write",
        Command::Viewport { .. } => "viewport",
    };
    let mut line = Element::new(op)
        .attr("requestId", &request_id.to_string())?
        .attr("viewId", view_id)?;
    match command {
        Command::Configure {
            frequency,
            automatic,
        } => {
            if let Some(frequency) = frequency {
                line = line.attr("frequency", &frequency.to_string())?;
            }
            if let Some(automatic) = automatic {
                line = line.attr("automatic", &automatic.to_string())?;
            }
        }
        Command::Poke { component_id, x, y } => {
            line = line
                .attr("componentId", component_id)?
                .attr("x", &x.to_string())?
                .attr("y", &y.to_string())?;
        }
        Command::Input { component_id, bits } => {
            if bits.is_empty() || !bits.chars().all(|c| matches!(c, '0' | '1' | 'x')) {
                return Err(SimError::new(Code::InputFormat));
            }
            line = line.attr("componentId", component_id)?.attr("bits", bits)?;
        }
        Command::Button {
            component_id,
            value,
        } => {
            let value = match value {
                ButtonValue::Pressed => "1",
                ButtonValue::Released => "0",
            };
            line = line
                .attr("componentId", component_id)?
                .attr("value", value)?;
        }
        Command::Pulse { component_id } => line = line.attr("componentId", component_id)?,
        Command::Trace { signals } => {
            let mut keys = Vec::with_capacity(signals.len());
            for signal in signals {
                if signal.component_id.is_empty() || signal.component_id.contains([',', ':']) {
                    return Err(SimError::new(Code::TracePort));
                }
                keys.push(format!("{}:{}", signal.component_id, signal.port));
            }
            line = line.attr("signals", &keys.join(","))?;
        }
        Command::Memory {
            component_id,
            offset,
            count,
        } => {
            line = line
                .attr("componentId", component_id)?
                .attr("offset", &offset.to_string())?
                .attr("count", &count.to_string())?;
        }
        Command::MemoryWrite {
            component_id,
            offset,
            count,
            address,
            expected,
            value,
        } => {
            line = line
                .attr("componentId", component_id)?
                .attr("offset", &offset.to_string())?
                .attr("count", &count.to_string())?
                .attr("address", &address.to_string())?
                .attr("expected", &format!("{expected:x}"))?
                .attr("value", &format!("{value:x}"))?;
        }
        Command::Viewport {
            x,
            y,
            width,
            height,
            scale,
        } => {
            if !scale.is_finite() {
                return Err(SimError::new(Code::ViewportBudget));
            }
            line = line
                .attr("x", &x.to_string())?
                .attr("y", &y.to_string())?
                .attr("width", &width.to_string())?
                .attr("height", &height.to_string())?
                .attr("scale", &scale.to_string())?;
        }
        _ => {}
    }
    Ok(line.empty() + "\n")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const META: &str = r#"viewId="v1" circuit="main" commandSequence="3" ticks="7" running="true" automatic="true" pending="false" frequency="2.0" actualFrequency="1.98" oscillating="false""#;

    pub(crate) fn frame_line(view: &str, sequence: u64, trace: &str) -> String {
        format!(
            r#"<frame viewId="{view}" circuit="main" commandSequence="{sequence}" ticks="{sequence}" running="true" automatic="true" pending="false" frequency="2.0" actualFrequency="0.0" oscillating="false" captureMs="1.5" encodeMs="2.5"><component id="a" control="input"><input width="1" bits="1" value="1"/><port index="0" width="1" bits="1" value="1"/></component><component id="b"><port index="0" width="8" bits="0000 x01x"/></component>{trace}<render x="-24" y="-24" width="160.0" height="100.0" scale="1.5" pixelWidth="240" pixelHeight="150">iVBORw0KGgo=</render></frame>"#
        )
    }

    #[test]
    fn frames_acks_and_errors_parse() {
        let trace = r#"<trace id="t1" recording="true" total="3" dropped="0"><signal key="a:0" width="1"/><signal key="b:0" width="8"/><sample sequence="0" tick="0" cause="start">0|0000 0000</sample><sample sequence="1" tick="1" cause="tick">1|0000 0001</sample><sample sequence="2" tick="2" cause="input">1|0000 x01x</sample></trace>"#;
        let Line::Frame(frame) = parse(&frame_line("v1", 4, trace), Some(("t1", 2))).unwrap()
        else {
            panic!("not a frame")
        };
        assert_eq!(frame.meta.command_sequence, 4);
        assert!(frame.meta.clock.running);
        assert_eq!(frame.components.len(), 2);
        assert_eq!(frame.components[0].control, Some(Control::Input));
        assert_eq!(frame.components[0].input.as_ref().unwrap().value, Some(1));
        assert_eq!(frame.components[1].ports[0].signal.bits, "0000 x01x");
        assert_eq!(frame.components[1].ports[0].signal.value, None);
        assert_eq!(frame.trace.signals[1].component_id, "b");
        // Samples the reader already has are skipped.
        assert_eq!(frame.trace.samples.len(), 1);
        assert_eq!(frame.trace.samples[0].values, ["1", "0000 x01x"]);
        assert_eq!(frame.image.width, 240);
        assert_eq!(frame.image.bounds.width, 160.0);
        assert_eq!(frame.png, "iVBORw0KGgo=");
        assert_eq!(frame.timing.encode_ms, 2.5);

        let Line::Ack { request_id, result } =
            parse(&format!(r#"<ack requestId="9" {META}/>"#), None).unwrap()
        else {
            panic!("not an ack")
        };
        assert_eq!(request_id, Some(9));
        assert_eq!(result.unwrap().clock.ticks, 7);

        let line = r#"<ack requestId="10" error="com.cburch.logisim.file.SessionError: Click outside component" code="INPUT_OUTSIDE" message="Click outside component"/>"#;
        let Line::Ack { result, .. } = parse(line, None).unwrap() else {
            panic!("not an ack")
        };
        let error = result.unwrap_err();
        assert_eq!(error.code, Code::InputOutside);
        assert_eq!(error.message, "请点在输入元件上");

        let line = format!(
            r#"<ack {META} failure="java.lang.IllegalStateException: x&#10;y" failureCode="CLOCK_FAILURE"/>"#
        );
        let Line::Ack { result, .. } = parse(&line, None).unwrap() else {
            panic!("not an ack")
        };
        let failure = result.unwrap().clock.failure.unwrap();
        assert_eq!(failure.code, Code::ClockFailure);
        assert_eq!(
            failure.detail(),
            Some("java.lang.IllegalStateException: x\ny")
        );

        let line = r#"<start-error error="com.cburch.logisim.file.SessionError: Unknown circuit" code="UNKNOWN_CIRCUIT" message="Unknown circuit"/>"#;
        let Line::StartError(error) = parse(line, None).unwrap() else {
            panic!("not a start error")
        };
        assert_eq!(error.code, Code::UnknownCircuit);

        for invalid in [
            "",
            "garbage",
            "<ack requestId=\"x\"/>",
            &format!(r#"<ack {META}"#),
            &frame_line("v1", 1, "").replace(r#" ticks="1""#, ""),
            &frame_line("v1", 1, ""),
        ] {
            assert!(parse(invalid, None).is_err(), "{invalid}");
        }
    }

    #[test]
    fn commands_escape_values_and_reject_what_xml_cannot_carry() {
        let line = command_line(
            5,
            "v&1",
            &Command::Input {
                component_id: "id\"<'\n".into(),
                bits: "01x".into(),
            },
        )
        .unwrap();
        assert_eq!(
            line,
            "<input requestId=\"5\" viewId=\"v&amp;1\" componentId=\"id&quot;&lt;&apos;&#10;\" bits=\"01x\"/>\n"
        );
        let mut reader = Reader::from_str(line.trim_end());
        let Event::Empty(element) = reader.read_event().unwrap() else {
            panic!()
        };
        assert_eq!(
            Attrs::of(&element).unwrap().get("componentId"),
            Some("id\"<'\n")
        );
        let error = command_line(
            1,
            "v",
            &Command::Input {
                component_id: "a".into(),
                bits: "012".into(),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, Code::InputFormat);
        let error = command_line(
            1,
            "v",
            &Command::Pulse {
                component_id: "a\u{1}".into(),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, Code::Internal);
        let error = command_line(
            1,
            "v",
            &Command::Trace {
                signals: vec![crate::simulation::model::TraceKey {
                    component_id: "a:b".into(),
                    port: 0,
                }],
            },
        )
        .unwrap_err();
        assert_eq!(error.code, Code::TracePort);
        assert_eq!(
            command_line(
                2,
                "v",
                &Command::MemoryWrite {
                    component_id: "ram".into(),
                    offset: 0,
                    count: 16,
                    address: 3,
                    expected: 0,
                    value: 255
                }
            )
            .unwrap(),
            "<memory-write requestId=\"2\" viewId=\"v\" componentId=\"ram\" offset=\"0\" count=\"16\" address=\"3\" expected=\"0\" value=\"ff\"/>\n"
        );
        assert_eq!(
            command_line(3, "v", &Command::Start).unwrap_err().code,
            Code::Internal
        );
    }
}
