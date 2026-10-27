//! The live picture of a run's view as the runtime drew it (CircuitPaint):
//! wires and junctions by geometry with the color Logisim gave them, each
//! component's vector ops by id. Frames carry what changed; the session keeps
//! the whole picture and each listener gets what changed since its last one.
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
pub struct Ops(Arc<RawValue>);

impl PartialEq for Ops {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0) || self.0.get() == other.0.get()
    }
}

impl Serialize for Ops {
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

    /// What changed since `before`: everything when it is of another view.
    pub(crate) fn delta(&self, before: Option<&Self>) -> PaintDelta {
        let before = before.filter(|before| before.view_id == self.view_id);
        let wire = |(key, color): (&[i32; 4], &Rgba)| {
            let [x1, y1, x2, y2] = *key;
            WirePaint(x1, y1, x2, y2, hex(*color))
        };
        let dot = |(key, color): (&[i32; 2], &Rgba)| DotPaint(key[0], key[1], hex(*color));
        let Some(before) = before else {
            return PaintDelta {
                full: true,
                wires: self.wires.iter().map(wire).collect(),
                dots: self.dots.iter().map(dot).collect(),
                components: self
                    .components
                    .iter()
                    .map(|(id, ops)| (id.clone(), ops.clone()))
                    .collect(),
            };
        };
        if std::ptr::eq(self, before) {
            return PaintDelta::default();
        }
        PaintDelta {
            full: false,
            wires: self
                .wires
                .iter()
                .filter(|(key, color)| before.wires.get(*key) != Some(color))
                .map(wire)
                .collect(),
            dots: self
                .dots
                .iter()
                .filter(|(key, color)| before.dots.get(*key) != Some(color))
                .map(dot)
                .collect(),
            components: self
                .components
                .iter()
                .filter(|(id, ops)| before.components.get(*id) != Some(ops))
                .map(|(id, ops)| (id.clone(), ops.clone()))
                .collect(),
        }
    }
}

/// A wire as the runtime stroked it: `[x1, y1, x2, y2, color]`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct WirePaint(pub i32, pub i32, pub i32, pub i32, pub String);

/// A junction as the runtime filled it: `[x, y, color]`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct DotPaint(pub i32, pub i32, pub String);

/// The picture of a view as Logisim draws it for the run's state: wires
/// stroked 3 wide with round ends, junctions 8 across, each component's ops
/// relative to its location (the editor's symbol ops). When `full` it is the
/// whole picture; otherwise only what changed since the listener's last one,
/// to be laid over it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
pub struct PaintDelta {
    pub full: bool,
    pub wires: Vec<WirePaint>,
    pub dots: Vec<DotPaint>,
    #[ts(type = "{ [id in string]: Array<Array<string | number | Array<number>>> }")]
    pub components: BTreeMap<String, Ops>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(full: bool, text: &str) -> RawPaint {
        RawPaint::parse(full, text).unwrap()
    }

    #[test]
    fn deltas_lay_over_the_picture_of_their_view() {
        let first = Paint::apply(
            None,
            "v",
            raw(
                true,
                r##"{"wires":[[0,0,10,0,"#00d200"],[10,0,10,10,"#000000"]],"dots":[[10,0,"#00d200"]],"components":{"a":[["C","#000000"],["L",0,0,1,1]],"b":[]}}"##,
            ),
        );
        let full = first.delta(None);
        assert!(full.full);
        assert_eq!(full.wires.len(), 2);
        assert_eq!(full.components.len(), 2);
        let next = Paint::apply(
            Some(&first),
            "v",
            raw(
                false,
                r##"{"wires":[[0,0,10,0,"#006400"]],"dots":[],"components":{"a":[["C","#ff0000"]]}}"##,
            ),
        );
        let delta = next.delta(Some(&first));
        assert!(!delta.full);
        assert_eq!(delta.wires, [WirePaint(0, 0, 10, 0, "#006400".into())]);
        assert!(delta.dots.is_empty());
        assert_eq!(
            serde_json::to_string(&delta.components).unwrap(),
            r##"{"a":[["C","#ff0000"]]}"##
        );
        // A listener that missed a frame gets everything since its last one.
        let unchanged = Paint::apply(Some(&next), "v", raw(false, "{}"));
        assert!(Arc::ptr_eq(&unchanged, &next));
        assert_eq!(unchanged.delta(Some(&first)), delta);
        assert_eq!(unchanged.delta(Some(&next)), PaintDelta::default());
        // Another view starts over.
        let other = Paint::apply(
            Some(&next),
            "w",
            raw(false, r##"{"dots":[[5,5,"#12345678"]]}"##),
        );
        let switched = other.delta(Some(&next));
        assert!(switched.full);
        assert_eq!(switched.dots, [DotPaint(5, 5, "#12345678".into())]);
        assert!(switched.wires.is_empty());
    }
}
