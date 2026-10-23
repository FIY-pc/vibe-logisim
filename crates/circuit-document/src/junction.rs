//! Junctions drawn by an edit must survive reopening the file.
//!
//! Logisim's load-time wire repair joins two collinear wire ends that meet with
//! no third end, so a wire passing straight through the point where a new end
//! lands would turn a drawn '+' into a crossing. Edits therefore split such a
//! wire at that point. Nothing else is split: a wire crossing another with no
//! end at the crossing stays unconnected, as it does in Logisim.

use crate::Point;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Segment {
    pub(crate) from: Point,
    pub(crate) to: Point,
}

impl Segment {
    pub(crate) fn translated(self, delta: Point) -> crate::Result<Self> {
        Ok(Self {
            from: self.from.translated(delta)?,
            to: self.to.translated(delta)?,
        })
    }

    /// Whether `p` lies on the segment, ends included.
    pub(crate) fn touches(&self, p: Point) -> bool {
        let (a, b) = (self.from, self.to);
        (a.x == b.x && p.x == a.x && p.y >= a.y.min(b.y) && p.y <= a.y.max(b.y))
            || (a.y == b.y && p.y == a.y && p.x >= a.x.min(b.x) && p.x <= a.x.max(b.x))
    }

    /// Whether `p` lies on the segment and is not one of its ends.
    pub(crate) fn inside(&self, p: Point) -> bool {
        p != self.from && p != self.to && self.touches(p)
    }

    /// The same wire, drawn in either direction.
    pub(crate) fn same(&self, other: &Segment) -> bool {
        (self.from, self.to) == (other.from, other.to)
            || (self.from, self.to) == (other.to, other.from)
    }

    /// The pieces of the segment between the given points that lie inside it,
    /// in order from `from`.
    pub(crate) fn split(self, points: &[Point]) -> Vec<Segment> {
        let mut cuts: Vec<Point> = points.iter().copied().filter(|p| self.inside(*p)).collect();
        if cuts.is_empty() {
            return vec![self];
        }
        let distance = |p: &Point| p.x.abs_diff(self.from.x) + p.y.abs_diff(self.from.y);
        cuts.sort_by_key(distance);
        cuts.dedup();
        let mut pieces = Vec::with_capacity(cuts.len() + 1);
        let mut from = self.from;
        for to in cuts.into_iter().chain([self.to]) {
            pieces.push(Segment { from, to });
            from = to;
        }
        pieces
    }
}
