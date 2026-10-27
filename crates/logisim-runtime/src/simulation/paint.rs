//! The live picture of a run's view as the runtime drew it (CircuitPaint):
//! wires and junctions by geometry with the color Logisim gave them, each
//! component's vector ops by id. Frames carry what changed; the session keeps
//! the whole picture and each listener gets what changed since its last one.
//! A component flips between a few looks (a tunnel takes its value's color, a
//! register shows the value it holds), so a listener gets each op and each op
//! list once, numbered, and a changed component as the number of its list.
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

impl PartialEq for Ops {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0) || self.0.get() == other.0.get()
    }
}

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
    pub full: bool,
    pub wires: Vec<([i32; 4], Rgba)>,
    pub dots: Vec<([i32; 2], Rgba)>,
    pub components: Vec<(String, Ops)>,
}

impl RawPaint {
    /// Parses the JSON of a `<paint>` element.
    pub(crate) fn parse(full: bool, text: &str) -> Result<Self, String> {
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
            return Ok(Self {
                full,
                ..Self::default()
            });
        }
        let json: Json = serde_json::from_str(text).map_err(|e| format!("invalid paint: {e}"))?;
        Ok(Self {
            full,
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
}

/// The whole picture of a view as of one frame.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Paint {
    pub view_id: String,
    wires: HashMap<[i32; 4], Rgba>,
    dots: HashMap<[i32; 2], Rgba>,
    components: HashMap<String, Ops>,
}

/// The ops and op lists one listener was sent, by number, since its last full
/// picture.
#[derive(Debug, Default)]
pub(crate) struct Sent {
    ops: HashMap<Box<str>, u32>,
    lists: HashMap<Box<[u32]>, u32>,
    bytes: usize,
}

/// How much of ops and op lists a listener keeps before its next picture is
/// full and numbers them afresh: a run whose registers keep showing new
/// values adds lists all the time.
const KEPT_BYTES: usize = 4 << 20;

impl Sent {
    /// The number of `ops` as a list, adding to `delta` what the listener lacks.
    fn list(&mut self, ops: &Ops, delta: &mut PaintDelta) -> u32 {
        let items: Vec<&RawValue> = serde_json::from_str(ops.0.get()).unwrap_or_default();
        let numbers: Box<[u32]> = items
            .into_iter()
            .map(|op| {
                if let Some(&number) = self.ops.get(op.get()) {
                    return number;
                }
                let number = self.ops.len() as u32;
                self.ops.insert(op.get().into(), number);
                self.bytes += op.get().len();
                delta.ops.push(Op(op.to_owned()));
                number
            })
            .collect();
        if let Some(&number) = self.lists.get(&numbers) {
            return number;
        }
        let number = self.lists.len() as u32;
        self.bytes += 4 * numbers.len();
        delta.lists.push(numbers.to_vec());
        self.lists.insert(numbers, number);
        number
    }
}

impl Paint {
    /// The picture after a frame: its paint over the previous picture of the
    /// same view, or on its own when it is full or the view changed.
    pub(crate) fn apply(previous: Option<&Arc<Self>>, view_id: &str, raw: RawPaint) -> Arc<Self> {
        let base = previous.filter(|paint| !raw.full && paint.view_id == view_id);
        if let Some(base) = base
            && raw.wires.is_empty()
            && raw.dots.is_empty()
            && raw.components.is_empty()
        {
            return base.clone();
        }
        let mut paint = base.map_or_else(
            || Self {
                view_id: view_id.into(),
                ..Self::default()
            },
            |base| Self::clone(base),
        );
        paint.wires.extend(raw.wires);
        paint.dots.extend(raw.dots);
        paint.components.extend(raw.components);
        Arc::new(paint)
    }

    /// What changed since `before`, the picture the listener has, with what
    /// it was `sent`: everything, numbered afresh, when `before` is of another
    /// view or the listener keeps too much.
    pub(crate) fn delta(&self, before: Option<&Self>, sent: &mut Sent) -> PaintDelta {
        let before =
            before.filter(|before| before.view_id == self.view_id && sent.bytes <= KEPT_BYTES);
        match before {
            Some(before) if std::ptr::eq(self, before) => return PaintDelta::default(),
            Some(_) => {}
            None => *sent = Sent::default(),
        }
        let mut delta = PaintDelta {
            full: before.is_none(),
            ..PaintDelta::default()
        };
        for (key, color) in &self.wires {
            if before.is_none_or(|before| before.wires.get(key) != Some(color)) {
                delta.wires.entry(hex(*color)).or_default().extend(key);
            }
        }
        for (key, color) in &self.dots {
            if before.is_none_or(|before| before.dots.get(key) != Some(color)) {
                delta.dots.entry(hex(*color)).or_default().extend(key);
            }
        }
        for (id, ops) in &self.components {
            if before.is_none_or(|before| before.components.get(id) != Some(ops)) {
                let list = sent.list(ops, &mut delta);
                delta.components.insert(id.clone(), list);
            }
        }
        delta
    }
}

/// The picture of a view as Logisim draws it for the run's state: wires
/// stroked 3 wide with round ends, junctions 8 across, each component's ops
/// relative to its location (the editor's symbol ops). When `full` it is the
/// whole picture and numbers ops and op lists from 0; otherwise only what
/// changed since the listener's last one, to be laid over it, and the ops
/// and lists it has not had, numbered on from those it has.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
pub struct PaintDelta {
    pub full: bool,
    /// Wires by color, each as `x1, y1, x2, y2`.
    pub wires: BTreeMap<String, Vec<i32>>,
    /// Junctions by color, each as `x, y`.
    pub dots: BTreeMap<String, Vec<i32>>,
    #[ts(type = "Array<Array<string | number | Array<number>>>")]
    pub ops: Vec<Op>,
    /// Each new list as the numbers of its ops.
    pub lists: Vec<Vec<u32>>,
    /// The number of the list each changed component paints, by id.
    pub components: BTreeMap<String, u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(full: bool, text: &str) -> RawPaint {
        RawPaint::parse(full, text).unwrap()
    }

    fn json<T: Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap()
    }

    #[test]
    fn deltas_lay_over_the_picture_of_their_view() {
        let mut sent = Sent::default();
        let first = Paint::apply(
            None,
            "v",
            raw(
                true,
                r##"{"wires":[[0,0,10,0,"#00d200"],[10,0,10,10,"#000000"]],"dots":[[10,0,"#00d200"]],"components":{"a":[["C","#000000"],["L",0,0,1,1]],"b":[["C","#000000"],["L",0,0,1,1]],"c":[]}}"##,
            ),
        );
        let full = first.delta(None, &mut sent);
        assert!(full.full);
        assert_eq!(json(&full.wires), r##"{"#000000":[10,0,10,10],"#00d200":[0,0,10,0]}"##);
        assert_eq!(json(&full.dots), r##"{"#00d200":[10,0]}"##);
        // Components that look alike share their ops and list.
        assert_eq!(json(&full.ops), r##"[["C","#000000"],["L",0,0,1,1]]"##);
        assert_eq!(full.lists.len(), 2);
        assert_eq!(full.components["a"], full.components["b"]);
        let shown = full.components["a"];
        let next = Paint::apply(
            Some(&first),
            "v",
            raw(
                false,
                r##"{"wires":[[0,0,10,0,"#006400"]],"dots":[],"components":{"a":[["C","#ff0000"],["L",0,0,1,1]]}}"##,
            ),
        );
        let delta = next.delta(Some(&first), &mut sent);
        assert!(!delta.full);
        assert_eq!(json(&delta.wires), r##"{"#006400":[0,0,10,0]}"##);
        assert!(delta.dots.is_empty());
        // Only the op it has not had, and the new list as numbers.
        assert_eq!(json(&delta.ops), r##"[["C","#ff0000"]]"##);
        assert_eq!(delta.lists, [vec![2, 1]]);
        assert_eq!(json(&delta.components), r#"{"a":2}"#);
        // Back to a look it was sent: only the number.
        let back = Paint::apply(
            Some(&next),
            "v",
            raw(
                false,
                r##"{"components":{"a":[["C","#000000"],["L",0,0,1,1]]}}"##,
            ),
        );
        let returned = back.delta(Some(&next), &mut sent);
        assert!(returned.ops.is_empty() && returned.lists.is_empty());
        assert_eq!(returned.components["a"], shown);
        // A frame with nothing new is the same picture.
        let unchanged = Paint::apply(Some(&back), "v", raw(false, "{}"));
        assert!(Arc::ptr_eq(&unchanged, &back));
        assert_eq!(unchanged.delta(Some(&back), &mut sent), PaintDelta::default());
        // A listener that missed frames gets what changed since its last one.
        let missed = back.delta(Some(&first), &mut Sent::default());
        assert!(missed.components.is_empty() && json(&missed.wires).contains("#006400"));
        // Another view starts over, numbering from 0.
        let other = Paint::apply(
            Some(&back),
            "w",
            raw(false, r##"{"dots":[[5,5,"#12345678"]],"components":{"d":[["C","#ff0000"]]}}"##),
        );
        let switched = other.delta(Some(&back), &mut sent);
        assert!(switched.full);
        assert_eq!(json(&switched.dots), r##"{"#12345678":[5,5]}"##);
        assert!(switched.wires.is_empty());
        assert_eq!(json(&switched.ops), r##"[["C","#ff0000"]]"##);
        assert_eq!(json(&switched.components), r#"{"d":0}"#);
    }
}
