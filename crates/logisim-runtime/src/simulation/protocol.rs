//! The line protocol of the CircuitSession process: one XML document per line.
//! The process answers every command line with one ack, in order.
use super::{
    error::{Code, SimError},
    model::{
        ButtonValue, ClockState, Command, Control, LiveComponent, MemoryPage, MemoryStorage,
        Timing, TraceDelta, TraceSample, TraceSignal,
    },
    paint::RawPaint,
};
use quick_xml::{
    XmlVersion,
    events::{BytesStart, Event},
    reader::Reader,
};
use std::{borrow::Cow, fmt::Write as _, str::FromStr};
use vibe_circuit_document::Component;

/// One frame as the runtime sent it.
pub(crate) struct RawFrame {
    pub full: bool,
    pub circuit: String,
    pub instance_path: Vec<String>,
    pub command_sequence: u64,
    pub clock: ClockState,
    pub timing: Timing,
    /// The components whose values changed, all of them when full.
    pub components: Vec<(String, LiveComponent)>,
    pub memory: Option<MemoryPage>,
    /// Present when the waveform changed, always when full.
    pub trace: Option<TraceDelta>,
    /// What the picture changed, or all of it when full.
    pub paint: RawPaint,
}

pub(crate) enum Line {
    /// The command sequence after the command, or why it was refused.
    Ack(Result<u64, SimError>),
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
    fn flag(&self, name: &str) -> Result<bool, String> {
        match self.text(name)? {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(format!("invalid {name}")),
        }
    }
    fn clock(&self) -> Result<ClockState, String> {
        Ok(ClockState {
            ticks: self.number("ticks")?,
            running: self.flag("running")?,
            automatic: self.flag("automatic")?,
            pending: self.flag("pending")?,
            frequency: self.number("frequency")?,
            actual_frequency: self.number("actualFrequency")?,
            oscillating: self.flag("oscillating")?,
            failure: self.failure(),
        })
    }
    fn failure(&self) -> Option<SimError> {
        self.get("failure")
            .map(|failure| SimError::from_java(self.get("failureCode"), None, failure))
    }
}

/// Parses one output line.
pub(crate) fn parse(line: &str) -> Result<Line, String> {
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
        "ack" => Ok(Line::Ack(match attrs.get("error") {
            Some(error) => Err(SimError::from_java(
                attrs.get("code"),
                attrs.get("message"),
                error,
            )),
            None => Ok(attrs.number("commandSequence")?),
        })),
        "frame-error" => Ok(Line::FrameError(attrs.failure().unwrap_or_else(|| {
            SimError::new(Code::Internal).with_detail("frame error without failure")
        }))),
        "start-error" => Ok(Line::StartError(SimError::from_java(
            attrs.get("code"),
            attrs.get("message"),
            attrs.text("error")?,
        ))),
        "frame" if !empty => {
            let frame = RawFrame {
                full: attrs.flag("full")?,
                circuit: attrs.text("circuit")?.into(),
                instance_path: Vec::new(),
                command_sequence: attrs.number("commandSequence")?,
                clock: attrs.clock()?,
                timing: Timing {
                    capture_ms: attrs.number("captureMs")?,
                    encode_ms: attrs.number("encodeMs")?,
                },
                components: Vec::new(),
                memory: None,
                trace: None,
                paint: RawPaint::default(),
            };
            parts(&mut reader, frame).map(|frame| Line::Frame(Box::new(frame)))
        }
        name => Err(format!("unexpected element {name}")),
    }
}

/// Where the parser is inside a frame.
enum Open {
    Frame,
    Component {
        id: String,
        live: LiveComponent,
        text: String,
    },
    Memory(MemoryPage),
    Trace,
    Sample {
        sample: TraceSample,
        text: String,
    },
    Paint(String),
    Other,
}

impl Open {
    fn text(&mut self) -> Option<&mut String> {
        match self {
            Self::Component { text, .. } | Self::Sample { text, .. } | Self::Paint(text) => {
                Some(text)
            }
            _ => None,
        }
    }
}

/// Closes an element of a frame.
fn close(frame: &mut RawFrame, open: Open) -> Result<(), String> {
    match open {
        Open::Component { id, mut live, text } => {
            if !text.is_empty() {
                live.ports = text.split('|').map(str::to_owned).collect();
            }
            frame.components.push((id, live));
        }
        Open::Memory(page) => frame.memory = Some(page),
        Open::Sample { mut sample, text } => {
            let trace = frame.trace.as_mut().ok_or("sample outside trace")?;
            sample.values = text.split('|').map(str::to_owned).collect();
            if trace.full && sample.values.len() != trace.signals.len() {
                return Err("sample does not match signals".into());
            }
            trace.samples.push(sample);
        }
        Open::Paint(text) => frame.paint = RawPaint::parse(&text)?,
        Open::Frame | Open::Trace | Open::Other => {}
    }
    Ok(())
}

fn parts(reader: &mut Reader<&[u8]>, mut frame: RawFrame) -> Result<RawFrame, String> {
    let mut stack = vec![Open::Frame];
    let mut painted = false;
    loop {
        let (element, empty) = match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(element) => (element, false),
            Event::Empty(element) => (element, true),
            Event::End(_) => match stack.pop() {
                Some(Open::Frame) | None => break,
                Some(open) => {
                    close(&mut frame, open)?;
                    continue;
                }
            },
            Event::Text(text) => {
                if let Some(buffer) = stack.last_mut().and_then(Open::text) {
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
                if let Some(buffer) = stack.last_mut().and_then(Open::text) {
                    buffer.push(resolved);
                }
                continue;
            }
            Event::Eof => return Err("truncated frame".into()),
            _ => continue,
        };
        let attrs = Attrs::of(&element)?;
        let open = match (stack.last_mut(), element.name().0) {
            (Some(Open::Frame), "instance") => {
                frame.instance_path.push(attrs.text("id")?.into());
                Open::Other
            }
            (Some(Open::Frame), "component") => Open::Component {
                id: attrs.text("id")?.into(),
                live: LiveComponent {
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
                    input: attrs.get("input").map(str::to_owned),
                    ports: Vec::new(),
                },
                text: String::new(),
            },
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
                frame.trace = Some(TraceDelta {
                    id: attrs.text("id")?.into(),
                    recording: attrs.flag("recording")?,
                    total: attrs.number("total")?,
                    dropped: attrs.number("dropped")?,
                    full: attrs.flag("full")?,
                    signals: Vec::new(),
                    samples: Vec::new(),
                });
                Open::Trace
            }
            (Some(Open::Trace), "signal") => {
                let trace = frame.trace.as_mut().ok_or("signal outside trace")?;
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
            (Some(Open::Trace), "sample") => Open::Sample {
                sample: TraceSample {
                    sample: attrs.number("sequence")?,
                    tick: attrs.number("tick")?,
                    cause: attrs.text("cause")?.into(),
                    values: Vec::new(),
                },
                text: String::new(),
            },
            (Some(Open::Frame), "paint") => {
                painted = true;
                Open::Paint(String::new())
            }
            _ => Open::Other,
        };
        if empty {
            close(&mut frame, open)?;
        } else {
            stack.push(open);
        }
    }
    if !painted {
        return Err("frame without paint".into());
    }
    Ok(frame)
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

/// `<tag id factory x y/>`: how the runtime finds a component of a circuit.
fn located(tag: &str, component: &Component) -> Result<String, SimError> {
    Ok(Element::new(tag)
        .attr("id", &component.id)?
        .attr("factory", &component.name)?
        .attr("x", &component.location.x.to_string())?
        .attr("y", &component.location.y.to_string())?
        .empty())
}

/// What the process reads at start, before the document's bytes: the file's
/// name and folder (relative libraries resolve there), the root circuit, the
/// clock frequency and how its component ids address components.
pub(crate) fn init_document(
    name: &str,
    directory: &str,
    circuit: &str,
    frequency: Option<f64>,
    components: &[Component],
) -> Result<String, SimError> {
    let children = components
        .iter()
        .map(|component| located("component", component))
        .collect::<Result<Vec<_>, _>>()?;
    let mut session = Element::new("session")
        .attr("name", name)?
        .attr("directory", directory)?
        .attr("circuit", circuit)?;
    if let Some(frequency) = frequency {
        session = session.attr("frequency", &frequency.to_string())?;
    }
    Ok(session.children(&children, "session"))
}

/// Shows a subcircuit instance: `instances` is the path from the root, and
/// `components` the components of the instance's circuit.
pub(crate) fn view_line(
    circuit: &str,
    instances: &[&Component],
    components: &[Component],
) -> Result<String, SimError> {
    let mut children = instances
        .iter()
        .map(|instance| located("instance", instance))
        .collect::<Result<Vec<_>, _>>()?;
    for component in components {
        children.push(located("component", component)?);
    }
    Ok(Element::new("view")
        .attr("circuit", circuit)?
        .children(&children, "view")
        + "\n")
}

/// One command line.
pub(crate) fn command_line(command: &Command) -> Result<String, SimError> {
    let op = match command {
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
    };
    let mut line = Element::new(op);
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
        _ => {}
    }
    Ok(line.empty() + "\n")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const CLOCK: &str = r#"ticks="7" running="true" automatic="true" pending="false" frequency="2.0" actualFrequency="1.98" oscillating="false""#;

    /// A frame of the root instance: full ones carry both components and the
    /// whole waveform, later ones only `b` with a new value.
    pub(crate) fn frame_line(full: bool, sequence: u64) -> String {
        let (components, trace, wires) = if full {
            (
                r#"<component id="a" control="input" input="1">1</component><component id="b">0000x01x|-</component>"#,
                r#"<trace id="t0" recording="false" total="0" dropped="0" full="true"/>"#,
                r##"[[0,0,10,0,"#00d200"]]"##,
            )
        } else {
            (
                r#"<component id="b">00000011|-</component>"#,
                "",
                r##"[[0,0,10,0,"#006400"]]"##,
            )
        };
        format!(
            r##"<frame captureMs="1.5" encodeMs="2.5" circuit="main" commandSequence="{sequence}" {CLOCK} full="{full}">{components}{trace}<paint>{{"wires":{wires},"dots":[],"components":{{"a":[["C","#006400"],["T","1 &lt; 2",0,0]]}}}}</paint></frame>"##
        )
    }

    #[test]
    fn frames_acks_and_errors_parse() {
        let line = r##"<frame captureMs="1.5" encodeMs="2.5" circuit="cell" commandSequence="4" ticks="7" running="true" automatic="true" pending="false" frequency="2.0" actualFrequency="0.0" oscillating="false" full="false"><instance id="c1"/><instance id="c2"/><component id="a" control="input" input="1">1</component><component id="b">0000x01x|-</component><component id="c"/><trace id="t1" recording="true" total="3" dropped="0" full="false"><sample sequence="2" tick="2" cause="input">1|0000 x01x</sample></trace><paint>{"wires":[[0,0,10,0,"#00d200"]],"dots":[],"components":{"a":[["C","#006400"],["T","1 &lt; 2",0,0]]}}</paint></frame>"##;
        let Line::Frame(frame) = parse(line).unwrap() else {
            panic!("not a frame")
        };
        assert!(!frame.full);
        assert_eq!(
            (frame.circuit.as_str(), frame.command_sequence),
            ("cell", 4)
        );
        assert_eq!(frame.instance_path, ["c1", "c2"]);
        assert!(frame.clock.running);
        assert_eq!(frame.components.len(), 3);
        let (id, a) = &frame.components[0];
        assert_eq!(
            (id.as_str(), a.control, a.input.as_deref()),
            ("a", Some(Control::Input), Some("1"))
        );
        assert_eq!(frame.components[1].1.ports, ["0000x01x", "-"]);
        assert!(frame.components[2].1.ports.is_empty());
        let trace = frame.trace.unwrap();
        assert!(!trace.full && trace.signals.is_empty());
        assert_eq!(trace.samples[0].values, ["1", "0000 x01x"]);
        assert_eq!(frame.paint.wires, [([0, 0, 10, 0], 0x00d2_00ff)]);
        assert_eq!(frame.paint.components[0].0, "a");
        assert_eq!(frame.timing.encode_ms, 2.5);
        let Line::Frame(frame) = parse(&frame_line(true, 1)).unwrap() else {
            panic!("not a frame")
        };
        assert!(frame.full && frame.trace.unwrap().full);

        let Line::Ack(result) = parse(&format!(
            r#"<ack circuit="main" commandSequence="9" {CLOCK}/>"#
        ))
        .unwrap() else {
            panic!("not an ack")
        };
        assert_eq!(result.unwrap(), 9);
        let line = r#"<ack error="com.cburch.logisim.file.SessionError: Click outside component" code="INPUT_OUTSIDE" message="Click outside component"/>"#;
        let Line::Ack(result) = parse(line).unwrap() else {
            panic!("not an ack")
        };
        let error = result.unwrap_err();
        assert_eq!(error.code, Code::InputOutside);
        assert_eq!(error.message, "请点在输入元件上");

        let line = format!(
            r#"<frame-error circuit="main" commandSequence="1" {CLOCK} failure="java.lang.IllegalStateException: x&#10;y" failureCode="CLOCK_FAILURE"/>"#
        );
        let Line::FrameError(failure) = parse(&line).unwrap() else {
            panic!("not a frame error")
        };
        assert_eq!(failure.code, Code::ClockFailure);
        assert_eq!(
            failure.detail(),
            Some("java.lang.IllegalStateException: x\ny")
        );

        let line = r#"<start-error error="com.cburch.logisim.file.SessionError: Unknown circuit" code="UNKNOWN_CIRCUIT" message="Unknown circuit"/>"#;
        let Line::StartError(error) = parse(line).unwrap() else {
            panic!("not a start error")
        };
        assert_eq!(error.code, Code::UnknownCircuit);

        for invalid in [
            "",
            "garbage",
            "<ack commandSequence=\"x\"/>",
            &format!(r#"<ack {CLOCK}"#),
            &frame_line(false, 1).replace(r#" ticks="7""#, ""),
            &frame_line(false, 1).replace(r#" full="false""#, ""),
            &frame_line(false, 1)
                .replace("<paint>", "<x>")
                .replace("</paint>", "</x>"),
        ] {
            assert!(parse(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn commands_escape_values_and_reject_what_xml_cannot_carry() {
        let line = command_line(&Command::Input {
            component_id: "id\"<'\n".into(),
            bits: "01x".into(),
        })
        .unwrap();
        assert_eq!(
            line,
            "<input componentId=\"id&quot;&lt;&apos;&#10;\" bits=\"01x\"/>\n"
        );
        let mut reader = Reader::from_str(line.trim_end());
        let Event::Empty(element) = reader.read_event().unwrap() else {
            panic!()
        };
        assert_eq!(
            Attrs::of(&element).unwrap().get("componentId"),
            Some("id\"<'\n")
        );
        let error = command_line(&Command::Input {
            component_id: "a".into(),
            bits: "012".into(),
        })
        .unwrap_err();
        assert_eq!(error.code, Code::InputFormat);
        let error = command_line(&Command::Pulse {
            component_id: "a\u{1}".into(),
        })
        .unwrap_err();
        assert_eq!(error.code, Code::Internal);
        let error = command_line(&Command::Trace {
            signals: vec![crate::simulation::model::TraceKey {
                component_id: "a:b".into(),
                port: 0,
            }],
        })
        .unwrap_err();
        assert_eq!(error.code, Code::TracePort);
        assert_eq!(
            command_line(&Command::MemoryWrite {
                component_id: "ram".into(),
                offset: 0,
                count: 16,
                address: 3,
                expected: 0,
                value: 255
            })
            .unwrap(),
            "<memory-write componentId=\"ram\" offset=\"0\" count=\"16\" address=\"3\" expected=\"0\" value=\"ff\"/>\n"
        );
        assert_eq!(command_line(&Command::Tick).unwrap(), "<tick/>\n");
    }
}
