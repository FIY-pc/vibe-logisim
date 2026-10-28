//! The picture of the shown instance as the runtime drew it (CircuitPaint):
//! wires and junctions by geometry with the color Logisim gave them, each
//! component's vector ops by id. Frames carry what changed; the run keeps the
//! whole picture so that a new subscriber can be given all of it. The picture
//! numbers each op and op list once, so a frame carries only the ones its
//! subscribers have not had and a component that goes back to a look it had
//! costs one number.
use serde::{Deserialize, Serialize, Serializer};
use serde_json::value::RawValue;
use std::{
    borrow::Borrow,
    collections::{BTreeMap, HashMap},
    hash::{Hash, Hasher},
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
#[derive(Debug)]
pub(crate) struct Ops(Box<RawValue>);

/// One op of a component's list, as the runtime wrote it.
#[derive(Clone, Debug)]
pub struct Op(Arc<RawValue>);

impl PartialEq for Op {
    fn eq(&self, other: &Self) -> bool {
        self.0.get() == other.0.get()
    }
}

impl Eq for Op {}

impl Hash for Op {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.0.get().hash(state);
    }
}

impl Borrow<str> for Op {
    fn borrow(&self) -> &str {
        self.0.get()
    }
}

impl Serialize for Op {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.as_ref().serialize(serializer)
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
                .map(|(id, ops)| (id, Ops(ops.to_owned())))
                .collect(),
        })
    }
}

/// The whole picture of the shown instance as of the newest frame, and every
/// op and op list numbered since it started.
#[derive(Debug, Default)]
pub(crate) struct Picture {
    wires: HashMap<[i32; 4], Rgba>,
    dots: HashMap<[i32; 2], Rgba>,
    /// The number of the list each component paints.
    components: HashMap<String, u32>,
    ops: Vec<Op>,
    lists: Vec<Vec<u32>>,
    op_numbers: HashMap<Op, u32>,
    list_numbers: HashMap<Vec<u32>, u32>,
    /// How many ops and lists there were when the numbering last started.
    start: (usize, usize),
}

impl Picture {
    /// Lays a frame's paint over the picture (a full frame starts it over)
    /// and returns what changed as subscribers get it, with the ops and lists
    /// numbered since the frame before.
    pub(crate) fn apply(&mut self, full: bool, raw: RawPaint) -> PaintEvent {
        if full {
            *self = Self::default();
        }
        let (ops, lists) = (self.ops.len(), self.lists.len());
        let mut event = PaintEvent::default();
        for (key, color) in raw.wires {
            self.wires.insert(key, color);
            event.wires.entry(hex(color)).or_default().extend(key);
        }
        for (key, color) in raw.dots {
            self.dots.insert(key, color);
            event.dots.entry(hex(color)).or_default().extend(key);
        }
        for (id, list) in raw.components {
            let items: Vec<&RawValue> = serde_json::from_str(list.0.get()).unwrap_or_default();
            let numbers = items.into_iter().map(|op| self.op_number(op)).collect();
            let number = self.list_number(numbers);
            self.components.insert(id.clone(), number);
            event.components.insert(id, number);
        }
        event.ops = self.ops[ops..].to_vec();
        event.lists = self.lists[lists..].to_vec();
        if full {
            self.start = (self.ops.len(), self.lists.len());
        }
        event
    }

    /// The whole picture as a new subscriber gets it: every op and list
    /// numbered so far.
    pub(crate) fn event(&self) -> PaintEvent {
        let mut event = PaintEvent {
            ops: self.ops.clone(),
            lists: self.lists.clone(),
            ..PaintEvent::default()
        };
        for (key, &color) in &self.wires {
            event.wires.entry(hex(color)).or_default().extend(key);
        }
        for (key, &color) in &self.dots {
            event.dots.entry(hex(color)).or_default().extend(key);
        }
        for (id, &number) in &self.components {
            event.components.insert(id.clone(), number);
        }
        event
    }

    /// Whether the numbered looks outgrew the picture: its whole state would
    /// be mostly looks nothing shows any more.
    pub(crate) fn worn(&self) -> bool {
        self.ops.len() > 3 * self.start.0 + 1024 || self.lists.len() > 3 * self.start.1 + 256
    }

    /// Numbers the picture over from nothing, keeping only what it shows.
    pub(crate) fn renumber(&mut self) {
        let ops = std::mem::take(&mut self.ops);
        let lists = std::mem::take(&mut self.lists);
        self.op_numbers.clear();
        self.list_numbers.clear();
        let mut components = std::mem::take(&mut self.components);
        let mut renumbered: HashMap<u32, u32> = HashMap::new();
        for number in components.values_mut() {
            let old = *number;
            *number = match renumbered.get(&old) {
                Some(&new) => new,
                None => {
                    let numbers = lists[old as usize]
                        .iter()
                        .map(|&op| self.add_op(ops[op as usize].clone()))
                        .collect();
                    let new = self.list_number(numbers);
                    renumbered.insert(old, new);
                    new
                }
            };
        }
        self.components = components;
        self.start = (self.ops.len(), self.lists.len());
    }

    fn op_number(&mut self, op: &RawValue) -> u32 {
        match self.op_numbers.get(op.get()) {
            Some(&number) => number,
            None => self.add_op(Op(Arc::from(op.to_owned()))),
        }
    }

    fn add_op(&mut self, op: Op) -> u32 {
        *self.op_numbers.entry(op.clone()).or_insert_with(|| {
            self.ops.push(op);
            self.ops.len() as u32 - 1
        })
    }

    fn list_number(&mut self, numbers: Vec<u32>) -> u32 {
        if let Some(&number) = self.list_numbers.get(&numbers) {
            return number;
        }
        self.lists.push(numbers.clone());
        let number = self.lists.len() as u32 - 1;
        self.list_numbers.insert(numbers, number);
        number
    }
}

/// A picture, or what changed in it, as Logisim draws the run's state: wires
/// stroked 3 wide with round ends, junctions 8 across, each component's ops
/// relative to its location (the editor's symbol ops). Ops and op lists are
/// numbered from 0 when the picture starts (a full frame) and onwards from
/// there: an event carries the ones numbered since the event before, which
/// continue the numbers the subscriber has. Components that look alike share
/// a list.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
pub struct PaintEvent {
    /// Wires by color, each as `x1, y1, x2, y2`.
    pub wires: BTreeMap<String, Vec<i32>>,
    /// Junctions by color, each as `x, y`.
    pub dots: BTreeMap<String, Vec<i32>>,
    /// The ops numbered since the event before.
    #[ts(type = "Array<Array<string | number | Array<number>>>")]
    pub ops: Vec<Op>,
    /// The lists numbered since the event before, each as the numbers of its ops.
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

    fn raw(text: &str) -> RawPaint {
        RawPaint::parse(text).unwrap()
    }

    #[test]
    fn frames_lay_over_the_picture_and_number_each_look_once() {
        let mut picture = Picture::default();
        let first = picture.apply(
            true,
            raw(
                r##"{"wires":[[0,0,10,0,"#00d200"],[10,0,10,10,"#000000"]],"dots":[[10,0,"#00d200"]],"components":{"a":[["C","#000000"],["L",0,0,1,1]],"b":[["C","#000000"],["L",0,0,1,1]],"c":[]}}"##,
            ),
        );
        assert_eq!(
            json(&first.wires),
            r##"{"#000000":[10,0,10,10],"#00d200":[0,0,10,0]}"##
        );
        assert_eq!(json(&first.dots), r##"{"#00d200":[10,0]}"##);
        // Components that look alike share their ops and list.
        assert_eq!(json(&first.ops), r##"[["C","#000000"],["L",0,0,1,1]]"##);
        assert_eq!(first.lists.len(), 2);
        assert_eq!(first.components["a"], first.components["b"]);
        assert_eq!(first, picture.event());

        // A later frame carries what changed and only the looks not numbered yet.
        let red = picture.apply(
            false,
            raw(
                r##"{"wires":[[0,0,10,0,"#006400"]],"components":{"a":[["C","#ff0000"],["L",0,0,1,1]]}}"##,
            ),
        );
        assert_eq!(json(&red.ops), r##"[["C","#ff0000"]]"##);
        assert_eq!(json(&red.lists), "[[2,1]]");
        assert_eq!(json(&red.components), r#"{"a":2}"#);
        // Going back to a look it had costs its number.
        let back = picture.apply(
            false,
            raw(r##"{"components":{"a":[["C","#000000"],["L",0,0,1,1]]}}"##),
        );
        assert!(back.ops.is_empty() && back.lists.is_empty());
        assert_eq!(back.components["a"], first.components["a"]);

        let whole = picture.event();
        assert_eq!(
            json(&whole.wires),
            r##"{"#000000":[10,0,10,10],"#006400":[0,0,10,0]}"##
        );
        assert_eq!((whole.ops.len(), whole.lists.len()), (3, 3));
        // Numbering over keeps only the looks shown.
        picture.renumber();
        let renumbered = picture.event();
        assert_eq!((renumbered.ops.len(), renumbered.lists.len()), (2, 2));
        assert_eq!(renumbered.components["a"], renumbered.components["b"]);
        assert!(renumbered.lists[renumbered.components["c"] as usize].is_empty());

        // A full frame starts the picture over.
        picture.apply(true, raw(r##"{"dots":[[5,5,"#12345678"]]}"##));
        let whole = picture.event();
        assert_eq!(json(&whole.dots), r##"{"#12345678":[5,5]}"##);
        assert!(whole.wires.is_empty() && whole.components.is_empty() && whole.ops.is_empty());
        assert_eq!(
            Picture::default().apply(true, raw("")),
            PaintEvent::default()
        );
    }
}
