//! The difference between two versions of a file. The session journal and the
//! document history store what an edit changed instead of the whole file.
//!
//! A patch lists hunks over the old bytes in order: replace
//! `old[start..start + removed]` with the inserted bytes. It is encoded as the
//! hunk count, then per hunk `start`, `removed` and the inserted length (each a
//! little-endian `u32`) followed by the inserted bytes.
use crate::{Error, Result};
use std::{
    ops::Range,
    time::{Duration, Instant},
};

/// A changed region up to this size is one hunk, without a line diff.
const SMALL: usize = 4096;
/// A line diff running longer settles for a coarser patch, still exact.
const DEADLINE: Duration = Duration::from_millis(20);

/// Compared a block at a time, so a large file costs a few memory compares.
const BLOCK: usize = 256;

/// How many leading bytes `a` and `b` share.
pub(crate) fn common_prefix(a: &[u8], b: &[u8]) -> usize {
    let n = a.len().min(b.len());
    let mut at = 0;
    while at + BLOCK <= n && a[at..at + BLOCK] == b[at..at + BLOCK] {
        at += BLOCK;
    }
    at + a[at..n]
        .iter()
        .zip(&b[at..n])
        .take_while(|(x, y)| x == y)
        .count()
}

/// How many trailing bytes `a` and `b` share.
pub(crate) fn common_suffix(a: &[u8], b: &[u8]) -> usize {
    let n = a.len().min(b.len());
    let (a, b) = (&a[a.len() - n..], &b[b.len() - n..]);
    let mut at = n;
    while at >= BLOCK && a[at - BLOCK..at] == b[at - BLOCK..at] {
        at -= BLOCK;
    }
    n - at
        + a[..at]
            .iter()
            .rev()
            .zip(b[..at].iter().rev())
            .take_while(|(x, y)| x == y)
            .count()
}

pub(crate) fn diff(old: &[u8], new: &[u8]) -> Vec<u8> {
    let prefix = common_prefix(old, new);
    let suffix = common_suffix(&old[prefix..], &new[prefix..]);
    let (old_end, new_end) = (old.len() - suffix, new.len() - suffix);
    // Hunks as (range in old, range in new).
    let mut hunks: Vec<(Range<usize>, Range<usize>)> = Vec::new();
    if (old_end - prefix) + (new_end - prefix) <= SMALL {
        if old_end > prefix || new_end > prefix {
            hunks.push((prefix..old_end, prefix..new_end));
        }
    } else {
        // Diff whole lines, so scattered changes in a large region stay
        // small. The prefix and suffix are shared, so both sides widen alike.
        let start = old[..prefix]
            .iter()
            .rposition(|&b| b == b'\n')
            .map_or(0, |i| i + 1);
        let tail = old[old_end..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(suffix, |i| i + 1);
        let old_lines = lines(&old[start..old_end + tail], start);
        let new_lines = lines(&new[start..new_end + tail], start);
        let ops = similar::capture_diff_slices_deadline(
            similar::Algorithm::Myers,
            &old_lines.0,
            &new_lines.0,
            Some(Instant::now() + DEADLINE),
        );
        for op in ops {
            if matches!(op, similar::DiffOp::Equal { .. }) {
                continue;
            }
            let (o, n) = (op.old_range(), op.new_range());
            let hunk = (
                old_lines.1[o.start]..old_lines.1[o.end],
                new_lines.1[n.start]..new_lines.1[n.end],
            );
            match hunks.last_mut() {
                Some(last) if last.0.end == hunk.0.start && last.1.end == hunk.1.start => {
                    last.0.end = hunk.0.end;
                    last.1.end = hunk.1.end;
                }
                _ => hunks.push(hunk),
            }
        }
    }
    let mut out = Vec::with_capacity(4 + hunks.iter().map(|(_, n)| 12 + n.len()).sum::<usize>());
    out.extend((hunks.len() as u32).to_le_bytes());
    for (o, n) in hunks {
        out.extend((o.start as u32).to_le_bytes());
        out.extend((o.len() as u32).to_le_bytes());
        out.extend((n.len() as u32).to_le_bytes());
        out.extend_from_slice(&new[n]);
    }
    out
}

/// The lines of `bytes` and the offset of each line start (plus the end),
/// counted from `base`.
fn lines(bytes: &[u8], base: usize) -> (Vec<&[u8]>, Vec<usize>) {
    let lines: Vec<&[u8]> = bytes.split_inclusive(|&b| b == b'\n').collect();
    let mut offsets = Vec::with_capacity(lines.len() + 1);
    let mut at = base;
    offsets.push(at);
    for line in &lines {
        at += line.len();
        offsets.push(at);
    }
    (lines, offsets)
}

pub(crate) fn apply(old: &[u8], patch: &[u8]) -> Result<Vec<u8>> {
    let corrupt = || Error::InvalidDocument("修改记录已损坏".into());
    let word = |at: usize| -> Result<usize> {
        let bytes = patch.get(at..at + 4).ok_or_else(corrupt)?;
        Ok(u32::from_le_bytes(bytes.try_into().expect("four bytes")) as usize)
    };
    let count = word(0)?;
    let (mut at, mut cursor) = (4, 0);
    let mut out = Vec::with_capacity(old.len());
    for _ in 0..count {
        let (start, removed, length) = (word(at)?, word(at + 4)?, word(at + 8)?);
        at += 12;
        let inserted = patch.get(at..at + length).ok_or_else(corrupt)?;
        at += length;
        if start < cursor || start + removed > old.len() {
            return Err(corrupt());
        }
        out.extend_from_slice(&old[cursor..start]);
        out.extend_from_slice(inserted);
        cursor = start + removed;
    }
    if at != patch.len() {
        return Err(corrupt());
    }
    out.extend_from_slice(&old[cursor..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn roundtrip(old: &str, new: &str) -> usize {
        let patch = diff(old.as_bytes(), new.as_bytes());
        assert_eq!(apply(old.as_bytes(), &patch).unwrap(), new.as_bytes());
        patch.len()
    }
    #[test]
    fn patches_rebuild_the_new_bytes_and_stay_small() {
        roundtrip("", "");
        roundtrip("", "abc");
        roundtrip("abc", "");
        roundtrip("abcdef", "abXdef");
        let lines: Vec<String> = (0..5000)
            .map(|i| format!("<wire from=\"({i},0)\" to=\"({i},10)\"/>\n"))
            .collect();
        let old = lines.concat();
        let mut changed = lines.clone();
        changed[10] = "<wire from=\"(1,1)\" to=\"(2,2)\"/>\n".into();
        changed.remove(2500);
        changed.insert(4990, "<comp name=\"x\"/>\n".into());
        let new = changed.concat();
        assert!(roundtrip(&old, &new) < 300);
        assert!(roundtrip(&new, &old) < 300);
        roundtrip(&old, "");
        roundtrip("", &old);
        roundtrip(&old, &old.replace("wire", "WIRE"));
        let unterminated = old.trim_end().to_string();
        roundtrip(&unterminated, &format!("{unterminated} tail"));
        roundtrip(&format!("head {unterminated}"), &unterminated);
    }
    #[test]
    fn a_damaged_patch_is_refused() {
        let patch = diff(b"abcdef", b"abXdef");
        assert!(apply(b"abcdef", &patch[..patch.len() - 1]).is_err());
        assert!(apply(b"ab", &patch).is_err());
    }
}
