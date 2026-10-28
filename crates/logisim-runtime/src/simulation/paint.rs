//! The picture of the shown instance as the runtime drew it (CircuitPaint):
//! wires and junctions by geometry with the color Logisim gave them, each
//! component's vector ops by id. Frames carry what changed; the run keeps the
//! whole picture so that a new subscriber can be given all of it.
use serde::{Deserialize, Serialize, Serializer};
use serde_json::value::RawValue;
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};
use ts_rs::TS;

/// A color as `0xRRGGBBAA`.
type Rgba = u32;

fn rgba(text: &str) -> Result<Rgba, String> {
    let hex = text.strip_prefix('#').ok_or("invalid paint color")?;
    let value = u32::from_str_radix(hex, 16).map_err(|_| "invalid paint color")?;
    match hex.len() {
        6 => Ok(value << 8 | 0xff),
        8 => Ok(value),
        _ => Err("invalid paint color".into()),
    }
}

fn hex(color: Rgba) -> String {
    if color & 0xff == 0xff {
        format!("#{:06x}", color >> 8)
    } else {
        format!("#{color:08x}")
    }
}

/// One component's ops as the runtime wrote them (see `RecordingGraphics2D`).
#[derive(Clone, Debug)]
pub(crate) struct Ops(Arc<RawValue>);

/// One op of a component's list, as the runtime wrote it.
#[derive(Clone, Debug)]
pub struct Op(Box<RawValue>);

impl PartialEq for Op {
    fn eq(&self, other: &Self) -> bool {
        self.0.get() == other.0.get()
    }
}

impl Serialize for Op {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

/// A frame's paint as the runtime sent it.
#[derive(Debug, Default)]
pub(crate) struct RawPaint {
    pub wires: Vec<([i32; 4], Rgba)>,
    pub dots: Vec<([i32; 2], Rgba)>,
    pub components: Vec<(String, Ops)>,
}

impl RawPaint {
    /// Parses the JSON of a `<paint>` element.
    pub(crate) fn parse(text: &str) -> Result<Self, String> {
        #[derive(Deserialize)]
        struct Json<'a> {
            #[serde(default, borrow)]
            wires: Vec<(i32, i32, i32, i32, &'a str)>,
            #[serde(default, borrow)]
            dots: Vec<(i32, i32, &'a str)>,
            #[serde(default, borrow)]
            components: HashMap<String, &'a RawValue>,
        }
        if text.trim().is_empty() {
            return Ok(Self::default());
        }
        let json: Json = serde_json::from_str(text).map_err(|e| format!("invalid paint: {e}"))?;
        Ok(Self {
            wires: json
                .wires
                .into_iter()
                .map(|(x1, y1, x2, y2, color)| Ok(([x1, y1, x2, y2], rgba(color)?)))
                .collect::<Result<_, String>>()?,
            dots: json
                .dots
                .into_iter()
                .map(|(x, y, color)| Ok(([x, y], rgba(color)?)))
                .collect::<Result<_, String>>()?,
            components: json
                .components
                .into_iter()
                .map(|(id, ops)| (id, Ops(Arc::from(ops.to_owned()))))
                .collect(),
        })
    }
    /// The frame's paint as subscribers get it.
    pub(crate) fn event(&self) -> PaintEvent {
        encode(
            self.wires.iter().map(|(key, color)| (key, *color)),
            self.dots.iter().map(|(key, color)| (key, *color)),
            self.components.iter().map(|(id, ops)| (id.as_str(), ops)),
        )
    }
}

/// The whole picture of the shown instance as of the newest frame.
#[derive(Debug, Default)]
pub(crate) struct Picture {
    wires: HashMap<[i32; 4], Rgba>,
    dots: HashMap<[i32; 2], Rgba>,
    components: HashMap<String, Ops>,
}

impl Picture {
    /// Lays a frame's paint over the picture; a full frame replaces it.
    pub(crate) fn apply(&mut self, full: bool, raw: RawPaint) {
        if full {
            *self = Self::default();
        }
        self.wires.extend(raw.wires);
        self.dots.extend(raw.dots);
        self.components.extend(raw.components);
    }
    pub(crate) fn event(&self) -> PaintEvent {
        encode(
            self.wires.iter().map(|(key, color)| (key, *color)),
            self.dots.iter().map(|(key, color)| (key, *color)),
            self.components.iter().map(|(id, ops)| (id.as_str(), ops)),
        )
    }
}

/// Numbers the ops and op lists of one event from 0, each once.
fn encode<'a>(
    wires: impl Iterator<Item = (&'a [i32; 4], Rgba)>,
    dots: impl Iterator<Item = (&'a [i32; 2], Rgba)>,
    components: impl Iterator<Item = (&'a str, &'a Ops)>,
) -> PaintEvent {
    let mut event = PaintEvent::default();
    for (key, color) in wires {
        event.wires.entry(hex(color)).or_default().extend(key);
    }
    for (key, color) in dots {
        event.dots.entry(hex(color)).or_default().extend(key);
    }
    let mut ops: HashMap<&str, u32> = HashMap::new();
    let mut lists: HashMap<Vec<u32>, u32> = HashMap::new();
    for (id, list) in components {
        let items: Vec<&RawValue> = serde_json::from_str(list.0.get()).unwrap_or_default();
        let numbers: Vec<u32> = items
            .into_iter()
            .map(|op| {
                *ops.entry(op.get()).or_insert_with(|| {
                    event.ops.push(Op(op.to_owned()));
                    event.ops.len() as u32 - 1
                })
            })
            .collect();
        let number = *lists.entry(numbers).or_insert_with_key(|numbers| {
            event.lists.push(numbers.clone());
            event.lists.len() as u32 - 1
        });
        event.components.insert(id.into(), number);
    }
    event
}

/// A picture, or what changed in it, as Logisim draws the run's state: wires
/// stroked 3 wide with round ends, junctions 8 across, each component's ops
/// relative to its location (the editor's symbol ops). The ops and op lists
/// are numbered from 0 within the event; components that look alike share a
/// list.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
pub struct PaintEvent {
    /// Wires by color, each as `x1, y1, x2, y2`.
    pub wires: BTreeMap<String, Vec<i32>>,
    /// Junctions by color, each as `x, y`.
    pub dots: BTreeMap<String, Vec<i32>>,
    #[ts(type = "Array<Array<string | number | Array<number>>>")]
    pub ops: Vec<Op>,
    /// Each list as the numbers of its ops.
    pub lists: Vec<Vec<u32>>,
    /// The number of the list each component paints, by id.
    pub components: BTreeMap<String, u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json<T: Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap()
    }

    #[test]
    fn frames_lay_over_the_picture_and_events_share_ops() {
        let first = RawPaint::parse(
            r##"{"wires":[[0,0,10,0,"#00d200"],[10,0,10,10,"#000000"]],"dots":[[10,0,"#00d200"]],"components":{"a":[["C","#000000"],["L",0,0,1,1]],"b":[["C","#000000"],["L",0,0,1,1]],"c":[]}}"##,
        )
        .unwrap();
        let event = first.event();
        assert_eq!(
            json(&event.wires),
            r##"{"#000000":[10,0,10,10],"#00d200":[0,0,10,0]}"##
        );
        assert_eq!(json(&event.dots), r##"{"#00d200":[10,0]}"##);
        // Components that look alike share their ops and list.
        assert_eq!(json(&event.ops), r##"[["C","#000000"],["L",0,0,1,1]]"##);
        assert_eq!(event.lists.len(), 2);
        assert_eq!(event.components["a"], event.components["b"]);
        let mut picture = Picture::default();
        picture.apply(true, first);
        picture.apply(
            false,
            RawPaint::parse(
                r##"{"wires":[[0,0,10,0,"#006400"]],"components":{"a":[["C","#ff0000"],["L",0,0,1,1]]}}"##,
            )
            .unwrap(),
        );
        let whole = picture.event();
        assert_eq!(
            json(&whole.wires),
            r##"{"#000000":[10,0,10,10],"#006400":[0,0,10,0]}"##
        );
        assert_eq!(whole.components.len(), 3);
        assert_eq!(whole.ops.len(), 3);
        assert_ne!(whole.components["a"], whole.components["b"]);
        // A full frame starts the picture over.
        picture.apply(
            true,
            RawPaint::parse(r##"{"dots":[[5,5,"#12345678"]]}"##).unwrap(),
        );
        let whole = picture.event();
        assert_eq!(json(&whole.dots), r##"{"#12345678":[5,5]}"##);
        assert!(whole.wires.is_empty() && whole.components.is_empty());
        assert!(RawPaint::parse("").unwrap().event() == PaintEvent::default());
    }
}
