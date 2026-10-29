//! Span index over a circuit file and element-level splices.
//!
//! The index is a pure function of the file text. An edit is a set of
//! byte-range replacements on that text, so everything outside the elements it
//! creates, changes or removes keeps its bytes: other circuits, whitespace,
//! attribute order, comments and the declaration (or its absence).

use crate::{Error, Result};
use quick_xml::{
    XmlVersion,
    escape::resolve_predefined_entity,
    events::{BytesStart, Event, attributes::Attribute},
    name::QName,
    reader::Reader,
};
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    ops::Range,
};

/// Deeper nesting than any circuit file uses; bounds recursion over the tree.
const MAX_DEPTH: usize = 256;

#[derive(Clone)]
pub(crate) struct Tree {
    text: String,
    nodes: Vec<Node>,
    root: usize,
    eol: &'static str,
    close: &'static str,
    unit: String,
}

#[derive(Clone)]
struct Node {
    tag: Range<usize>,
    span: Range<usize>,
    /// End of the start tag; `span.end` for an empty element.
    open_end: usize,
    /// Start of the end tag; `span.end` for an empty element.
    close_start: usize,
    attrs: Vec<Attr>,
    children: Vec<usize>,
}

#[derive(Clone)]
struct Attr {
    name: Range<usize>,
    /// Raw value between the quotes.
    value: Range<usize>,
    quote: char,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::InvalidDocument(message.into())
}

fn malformed(text: &str, at: usize, detail: impl std::fmt::Display) -> Error {
    let line = text.as_bytes()[..at.min(text.len())]
        .iter()
        .filter(|&&b| b == b'\n')
        .count()
        + 1;
    invalid(format!("XML 格式错误（第 {line} 行）：{detail}"))
}

fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

fn line_indent(text: &str, at: usize) -> Option<&str> {
    let line = text[..at].rfind('\n').map_or(0, |i| i + 1);
    let indent = &text[line..at];
    indent
        .bytes()
        .all(|b| b == b' ' || b == b'\t')
        .then_some(indent)
}

impl Tree {
    pub(crate) fn index(text: String) -> Result<Self> {
        let bom = if text.starts_with('\u{feff}') { 3 } else { 0 };
        let mut nodes: Vec<Node> = Vec::new();
        let mut open: Vec<usize> = Vec::new();
        let mut root = None;
        let mut reader = Reader::from_str(&text[bom..]);
        loop {
            let start = bom + reader.buffer_position() as usize;
            let event = reader
                .read_event()
                .map_err(|e| malformed(&text, bom + reader.error_position() as usize, e))?;
            let end = bom + reader.buffer_position() as usize;
            let empty = matches!(event, Event::Empty(_));
            match event {
                Event::Start(e) | Event::Empty(e) => {
                    let parent = open.last().copied();
                    if parent.is_none() && root.is_some() {
                        return Err(malformed(&text, start, "根元素之后还有元素"));
                    }
                    if open.len() >= MAX_DEPTH {
                        return Err(malformed(&text, start, "元素嵌套过深"));
                    }
                    let id = nodes.len();
                    nodes.push(Node {
                        tag: start + 1..start + 1 + e.name().0.len(),
                        span: start..end,
                        open_end: end,
                        close_start: end,
                        attrs: attributes(&text, &e).map_err(|e| malformed(&text, start, e))?,
                        children: Vec::new(),
                    });
                    match parent {
                        Some(p) => nodes[p].children.push(id),
                        None => root = Some(id),
                    }
                    if !empty {
                        open.push(id);
                    }
                }
                Event::End(_) => {
                    let id = open
                        .pop()
                        .ok_or_else(|| malformed(&text, start, "多余的结束标签"))?;
                    nodes[id].close_start = start;
                    nodes[id].span.end = end;
                }
                Event::Text(_) | Event::CData(_) | Event::GeneralRef(_) if open.is_empty() => {
                    if !text.as_bytes()[start..end].iter().all(|&b| is_space(b)) {
                        return Err(malformed(&text, start, "根元素之外有文本"));
                    }
                }
                Event::GeneralRef(r) => {
                    let known = match r.resolve_char_ref() {
                        Ok(Some(_)) => true,
                        Ok(None) => resolve_predefined_entity(&r).is_some(),
                        Err(_) => false,
                    };
                    if !known {
                        return Err(malformed(&text, start, format!("未知实体 &{};", &*r)));
                    }
                }
                Event::Decl(_) if start != bom => {
                    return Err(malformed(&text, start, "XML 声明必须位于文件开头"));
                }
                Event::DocType(_) => return Err(invalid("不支持含 DTD 的电路文件")),
                Event::Eof => break,
                _ => {}
            }
        }
        if let Some(&id) = open.last() {
            let tag = &text[nodes[id].tag.clone()];
            return Err(malformed(
                &text,
                nodes[id].span.start,
                format!("<{tag}> 没有结束标签"),
            ));
        }
        let root = root.ok_or_else(|| invalid("电路文件是空的"))?;
        let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
        let close = nodes
            .iter()
            .find(|n| n.open_end == n.span.end)
            .map_or("/>", |n| {
                if text.as_bytes()[n.span.end - 3] == b' ' {
                    " />"
                } else {
                    "/>"
                }
            });
        let unit = nodes
            .iter()
            .find_map(|n| {
                let parent = line_indent(&text, n.span.start)?;
                let child = line_indent(&text, nodes[*n.children.first()?].span.start)?;
                child
                    .strip_prefix(parent)
                    .filter(|unit| !unit.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "  ".into());
        Ok(Self {
            text,
            nodes,
            root,
            eol,
            close,
            unit,
        })
    }

    pub(crate) fn text(&self) -> &str {
        &self.text
    }

    pub(crate) fn root(&self) -> usize {
        self.root
    }

    /// The text up to the end of the root's start tag: the declaration,
    /// whatever precedes the root, and the start tag. None for an empty root.
    pub(crate) fn prolog(&self) -> Option<&str> {
        let root = &self.nodes[self.root];
        (root.open_end != root.span.end).then(|| &self.text[..root.open_end])
    }

    pub(crate) fn tag(&self, n: usize) -> &str {
        &self.text[self.nodes[n].tag.clone()]
    }

    pub(crate) fn children(&self, n: usize) -> &[usize] {
        &self.nodes[n].children
    }

    pub(crate) fn named<'a>(&'a self, n: usize, tag: &'a str) -> impl Iterator<Item = usize> + 'a {
        self.nodes[n]
            .children
            .iter()
            .copied()
            .filter(move |&c| self.tag(c) == tag)
    }

    fn find(&self, n: usize, name: &str) -> Option<&Attr> {
        self.nodes[n]
            .attrs
            .iter()
            .find(|a| &self.text[a.name.clone()] == name)
    }

    /// Attribute value after XML attribute-value normalization.
    pub(crate) fn attr(&self, n: usize, name: &str) -> Option<Cow<'_, str>> {
        self.find(n, name)
            .map(|a| normalize(&self.text[a.value.clone()]))
    }

    /// Attribute value, empty when absent.
    pub(crate) fn get(&self, n: usize, name: &str) -> Cow<'_, str> {
        self.attr(n, name).unwrap_or_default()
    }

    /// Value of a Logisim `<a>` element: its `val`, else its text (memory contents).
    pub(crate) fn property(&self, n: usize) -> String {
        match self.attr(n, "val") {
            Some(value) => value.into_owned(),
            None => self.content(n),
        }
    }

    /// Character data directly inside the element, unescaped.
    fn content(&self, n: usize) -> String {
        let node = &self.nodes[n];
        let mut out = String::new();
        let mut at = node.open_end;
        for &c in &node.children {
            character_data(&self.text[at..self.nodes[c].span.start], &mut out);
            at = self.nodes[c].span.end;
        }
        character_data(&self.text[at..node.close_start], &mut out);
        out
    }

    fn attributes(&self, n: usize) -> Vec<(&str, Cow<'_, str>)> {
        let mut attrs: Vec<_> = self.nodes[n]
            .attrs
            .iter()
            .map(|a| {
                (
                    &self.text[a.name.clone()],
                    normalize(&self.text[a.value.clone()]),
                )
            })
            .collect();
        attrs.sort();
        attrs
    }

    /// What Replace compares: tag, attributes by name, children in order and
    /// trimmed text. Whitespace, comments and attribute order do not count.
    fn canonical(&self, n: usize, out: &mut String) {
        let tag = self.tag(n);
        out.push('<');
        out.push_str(tag);
        for (name, value) in self.attributes(n) {
            out.push(' ');
            out.push_str(name);
            out.push_str("=\"");
            out.push_str(&escape(&value, '"'));
            out.push('"');
        }
        out.push('>');
        for &c in &self.nodes[n].children {
            self.canonical(c, out);
        }
        out.push_str(&escape_text(self.content(n).trim()));
        out.push_str("</");
        out.push_str(tag);
        out.push('>');
    }

    fn same(&self, n: usize, other: &Tree, m: usize) -> bool {
        let (mut a, mut b) = (String::new(), String::new());
        self.canonical(n, &mut a);
        other.canonical(m, &mut b);
        a == b
    }

    pub(crate) fn source(&self, n: usize) -> &str {
        &self.text[self.nodes[n].span.clone()]
    }

    /// The element's start tag, attributes included.
    pub(crate) fn open_tag(&self, n: usize) -> &str {
        &self.text[self.nodes[n].span.start..self.nodes[n].open_end]
    }

    /// Start of the whitespace directly before the element.
    fn lead(&self, n: usize) -> usize {
        let start = self.nodes[n].span.start;
        start
            - self.text.as_bytes()[..start]
                .iter()
                .rev()
                .take_while(|&&b| is_space(b))
                .count()
    }

    /// The whitespace between the element and whatever precedes it.
    fn separator(&self, n: usize) -> &str {
        &self.text[self.lead(n)..self.nodes[n].span.start]
    }
}

fn attributes(text: &str, e: &BytesStart) -> std::result::Result<Vec<Attr>, String> {
    let base = text.as_ptr() as usize;
    let offset = |s: &str| {
        (s.as_ptr() as usize)
            .checked_sub(base)
            .filter(|&at| text.get(at..at + s.len()).is_some())
            .ok_or_else(|| "属性位置无效".to_string())
    };
    e.attributes()
        .map(|a| {
            let a = a.map_err(|e| e.to_string())?;
            a.normalized_value(XmlVersion::Implicit1_0)
                .map_err(|e| e.to_string())?;
            let key = a.key.0;
            let Cow::Borrowed(value) = a.value else {
                return Err("属性位置无效".to_string());
            };
            let name = offset(key)?;
            let at = offset(value)?;
            Ok(Attr {
                name: name..name + key.len(),
                value: at..at + value.len(),
                quote: char::from(text.as_bytes()[at - 1]),
            })
        })
        .collect()
}

fn normalize(raw: &str) -> Cow<'_, str> {
    if !raw.contains(['&', '\t', '\n', '\r']) {
        return Cow::Borrowed(raw);
    }
    let attribute = Attribute {
        key: QName("val"),
        value: Cow::Borrowed(raw),
    };
    attribute
        .normalized_value(XmlVersion::Implicit1_0)
        .unwrap_or(Cow::Borrowed(raw))
}

fn character_data(raw: &str, out: &mut String) {
    if !raw.contains(['&', '<', '\r']) {
        out.push_str(raw);
        return;
    }
    let mut reader = Reader::from_str(raw);
    while let Ok(event) = reader.read_event() {
        match event {
            Event::Text(t) => out.push_str(&t.xml10_content()),
            Event::CData(t) => out.push_str(&t.xml10_content()),
            Event::GeneralRef(r) => match r.resolve_char_ref() {
                Ok(Some(c)) => out.push(c),
                _ => out.push_str(resolve_predefined_entity(&r).unwrap_or_default()),
            },
            Event::Eof => break,
            _ => {}
        }
    }
}

fn escape(value: &str, quote: char) -> Cow<'_, str> {
    if !value.contains(['&', '<', '>', '"', '\'', '\t', '\n', '\r']) {
        return Cow::Borrowed(value);
    }
    let mut out = String::with_capacity(value.len() + 8);
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' if quote == '"' => out.push_str("&quot;"),
            '\'' if quote == '\'' => out.push_str("&apos;"),
            '\t' => out.push_str("&#9;"),
            '\n' => out.push_str("&#10;"),
            '\r' => out.push_str("&#13;"),
            c => out.push(c),
        }
    }
    Cow::Owned(out)
}

fn escape_text(value: &str) -> Cow<'_, str> {
    if !value.contains(['&', '<', '>', '\r']) {
        return Cow::Borrowed(value);
    }
    let mut out = String::with_capacity(value.len() + 8);
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\r' => out.push_str("&#13;"),
            c => out.push(c),
        }
    }
    Cow::Owned(out)
}

/// Circuit files are UTF-8; Logisim writes nothing else. A file in another
/// encoding that Logisim reads (UTF-16 with a byte-order mark, or declared
/// Latin-1 or ASCII) is indexed as its text with the declaration changed to
/// UTF-8: the file keeps its bytes until the first edit, which writes UTF-8
/// and keeps every character. Returns the text and, when they differ from
/// it, the original bytes.
pub(crate) fn decode(bytes: Vec<u8>) -> Result<(String, Option<Vec<u8>>)> {
    let unit: Option<fn([u8; 2]) -> u16> = match bytes.get(..2) {
        Some([0xFF, 0xFE]) => Some(u16::from_le_bytes),
        Some([0xFE, 0xFF]) => Some(u16::from_be_bytes),
        _ => None,
    };
    if let Some(unit) = unit {
        let bad = || invalid("电路文件不是有效的 UTF-16 文本");
        let (pairs, rest) = bytes[2..].as_chunks::<2>();
        if !rest.is_empty() {
            return Err(bad());
        }
        let units: Vec<u16> = pairs.iter().map(|&pair| unit(pair)).collect();
        let text = String::from_utf16(&units).map_err(|_| bad())?;
        let text = match declared_encoding(text.as_bytes()) {
            Some(at) => format!("{}UTF-8{}", &text[..at.start], &text[at.end..]),
            None => text,
        };
        return Ok((text, Some(bytes)));
    }
    let utf8 = |bytes: Vec<u8>| {
        String::from_utf8(bytes)
            .map(|text| (text, None))
            .map_err(|_| invalid("电路文件不是 UTF-8 文本"))
    };
    let Some(at) = declared_encoding(&bytes) else {
        return utf8(bytes);
    };
    let latin1 = |bytes: &[u8]| bytes.iter().map(|&b| char::from(b)).collect::<String>();
    match String::from_utf8_lossy(&bytes[at.clone()])
        .to_ascii_lowercase()
        .as_str()
    {
        "utf-8" | "utf8" => utf8(bytes),
        "iso-8859-1" | "latin1" | "us-ascii" | "ascii" => {
            let text = latin1(&bytes[..at.start]) + "UTF-8" + &latin1(&bytes[at.end..]);
            Ok((text, Some(bytes)))
        }
        other => Err(invalid(format!("不支持的文件编码：{other}"))),
    }
}

/// Byte range of the `encoding` value in a leading XML declaration.
fn declared_encoding(bytes: &[u8]) -> Option<Range<usize>> {
    let start = if bytes.starts_with(b"\xEF\xBB\xBF") {
        3
    } else {
        0
    };
    let rest = bytes.get(start..)?;
    if !rest.starts_with(b"<?xml") {
        return None;
    }
    let decl = &rest[..rest.windows(2).position(|w| w == b"?>")?];
    let mut at = decl.windows(8).position(|w| w == b"encoding")? + 8;
    let skip = |at: &mut usize| {
        while decl.get(*at).is_some_and(|&b| is_space(b)) {
            *at += 1;
        }
    };
    skip(&mut at);
    if decl.get(at) != Some(&b'=') {
        return None;
    }
    at += 1;
    skip(&mut at);
    let quote = *decl.get(at).filter(|q| matches!(q, b'"' | b'\''))?;
    let value = at + 1;
    let len = decl[value..].iter().position(|&b| b == quote)?;
    Some(start + value..start + value + len)
}

/// A new element, written in the file's own style.
pub(crate) struct Element {
    tag: &'static str,
    attrs: Vec<(&'static str, String)>,
    text: Option<String>,
    children: Vec<Element>,
}

impl Element {
    pub(crate) fn new(tag: &'static str) -> Self {
        Self {
            tag,
            attrs: Vec::new(),
            text: None,
            children: Vec::new(),
        }
    }

    pub(crate) fn attr(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.attrs.push((name, value.into()));
        self
    }

    pub(crate) fn text(mut self, text: impl Into<String>) -> Self {
        self.text = Some(text.into());
        self
    }

    pub(crate) fn child(mut self, child: Element) -> Self {
        self.children.push(child);
        self
    }

    /// `indent` is the indentation of the element's own line; `None` writes
    /// the element and its children inline.
    fn render(&self, tree: &Tree, indent: Option<&str>, out: &mut String) {
        out.push('<');
        out.push_str(self.tag);
        for (name, value) in &self.attrs {
            out.push(' ');
            out.push_str(name);
            out.push_str("=\"");
            out.push_str(&escape(value, '"'));
            out.push('"');
        }
        if self.children.is_empty() && self.text.is_none() {
            out.push_str(tree.close);
            return;
        }
        out.push('>');
        if let Some(text) = &self.text {
            out.push_str(&escape_text(text));
        }
        let inner = indent.map(|indent| format!("{indent}{}", tree.unit));
        for child in &self.children {
            if let Some(inner) = &inner {
                out.push_str(tree.eol);
                out.push_str(inner);
            }
            child.render(tree, inner.as_deref(), out);
        }
        if let Some(indent) = indent
            && !self.children.is_empty()
        {
            out.push_str(tree.eol);
            out.push_str(indent);
        }
        out.push_str("</");
        out.push_str(self.tag);
        out.push('>');
    }
}

/// Byte-range replacements on one tree's text, applied together.
pub(crate) struct Splices<'t> {
    tree: &'t Tree,
    edits: Vec<(Range<usize>, String)>,
}

impl<'t> Splices<'t> {
    pub(crate) fn new(tree: &'t Tree) -> Self {
        Self {
            tree,
            edits: Vec::new(),
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.edits.is_empty()
    }

    /// Sets an attribute value in place; an absent attribute is added at the
    /// end of the start tag.
    pub(crate) fn set(&mut self, n: usize, name: &str, value: &str) {
        let tree = self.tree;
        if let Some(a) = tree.find(n, name) {
            self.edits
                .push((a.value.clone(), escape(value, a.quote).into_owned()));
            return;
        }
        let node = &tree.nodes[n];
        let end = node.open_end - if node.open_end == node.span.end { 2 } else { 1 };
        let at = end
            - tree.text.as_bytes()[..end]
                .iter()
                .rev()
                .take_while(|&&b| is_space(b))
                .count();
        self.edits
            .push((at..at, format!(" {name}=\"{}\"", escape(value, '"'))));
    }

    /// Removes an element together with the whitespace before it.
    pub(crate) fn remove(&mut self, n: usize) {
        let range = self.tree.lead(n)..self.tree.nodes[n].span.end;
        self.edits.push((range, String::new()));
    }

    /// Replaces an element with a new one written at its indentation.
    pub(crate) fn replace(&mut self, n: usize, element: &Element) {
        let span = self.tree.nodes[n].span.clone();
        let mut out = String::new();
        element.render(
            self.tree,
            line_indent(&self.tree.text, span.start),
            &mut out,
        );
        self.edits.push((span, out));
    }

    /// Inserts elements after `n`, separated as `n` is from what precedes it.
    pub(crate) fn insert_after(&mut self, n: usize, elements: &[Element]) {
        let at = self.tree.nodes[n].span.end;
        let text = self.siblings(n, elements);
        self.edits.push((at..at, text));
    }

    /// Inserts elements before `n`, separated as `n` is from what precedes it.
    pub(crate) fn insert_before(&mut self, n: usize, elements: &[Element]) {
        let at = self.tree.lead(n);
        let text = self.siblings(n, elements);
        self.edits.push((at..at, text));
    }

    fn siblings(&self, n: usize, elements: &[Element]) -> String {
        let separator = self.tree.separator(n);
        let indent = separator.rfind('\n').map(|i| &separator[i + 1..]);
        let mut out = String::new();
        for element in elements {
            out.push_str(separator);
            element.render(self.tree, indent, &mut out);
        }
        out
    }

    /// Adds elements as the last children of `parent`.
    pub(crate) fn append(&mut self, parent: usize, elements: &[Element]) {
        let tree = self.tree;
        if let Some(&last) = tree.nodes[parent].children.last() {
            return self.insert_after(last, elements);
        }
        let node = &tree.nodes[parent];
        let indent = line_indent(&tree.text, node.span.start);
        let inner = indent.map(|indent| format!("{indent}{}", tree.unit));
        let mut body = String::new();
        for element in elements {
            if let Some(inner) = &inner {
                body.push_str(tree.eol);
                body.push_str(inner);
            }
            element.render(tree, inner.as_deref(), &mut body);
        }
        let closing = indent
            .map(|indent| format!("{}{indent}", tree.eol))
            .unwrap_or_default();
        if node.open_end == node.span.end {
            let open = tree.text[node.span.start..node.span.end - 2].trim_end();
            let tag = tree.tag(parent);
            self.edits
                .push((node.span.clone(), format!("{open}>{body}{closing}</{tag}>")));
        } else {
            let content = &tree.text[node.open_end..node.close_start];
            let tail = &content[content.trim_end_matches([' ', '\t', '\n', '\r']).len()..];
            let tail = if indent.is_some() && !tail.contains('\n') {
                closing.as_str()
            } else {
                tail
            };
            let at = node.close_start
                - (content.len() - content.trim_end_matches([' ', '\t', '\n', '\r']).len());
            self.edits
                .push((at..node.close_start, format!("{body}{tail}")));
        }
    }

    pub(crate) fn finish(mut self) -> Result<String> {
        self.edits
            .sort_by_key(|(range, _)| (range.start, range.end));
        let text = &self.tree.text;
        let mut out = String::with_capacity(
            text.len() + self.edits.iter().map(|(_, s)| s.len()).sum::<usize>(),
        );
        let mut at = 0;
        for (range, replacement) in &self.edits {
            if range.start < at {
                return Err(Error::InvalidCommand("修改范围重叠，文件未改变".into()));
            }
            out.push_str(&text[at..range.start]);
            out.push_str(replacement);
            at = range.end;
        }
        out.push_str(&text[at..]);
        Ok(out)
    }
}

type Key = (String, String, usize);

/// Project children are matched by tag and occurrence; circuits and libraries
/// by tag and name.
fn keys(tree: &Tree) -> Vec<Key> {
    let mut seen: HashMap<(String, String), usize> = HashMap::new();
    tree.children(tree.root)
        .iter()
        .map(|&n| {
            let tag = tree.tag(n).to_owned();
            let name = if matches!(tag.as_str(), "circuit" | "lib") {
                tree.get(n, "name").into_owned()
            } else {
                String::new()
            };
            let count = seen.entry((tag.clone(), name.clone())).or_insert(0);
            *count += 1;
            (tag, name, *count)
        })
        .collect()
}

/// Applies `input` (a whole document) to `current` element by element.
///
/// Project children (circuits, libraries, `<main>`, `<options>`, …) equal to
/// their current counterpart keep the current bytes; changed ones take the
/// input's own bytes; added or removed ones are inserted or removed whole.
/// Everything outside the project's children keeps the current bytes.
pub(crate) fn merge(current: &Tree, input: &Tree) -> Result<String> {
    let mut splices = Splices::new(current);
    let (root, input_root) = (current.root, input.root);
    if current.attributes(root) != input.attributes(input_root) {
        let theirs = &input.nodes[input_root];
        splices.edits.push((
            current.nodes[root].span.start..current.nodes[root].open_end,
            input.text[theirs.span.start..theirs.open_end].to_owned(),
        ));
    }
    let ours = keys(current);
    let position: HashMap<&Key, usize> = ours.iter().enumerate().map(|(i, k)| (k, i)).collect();
    let matched: Vec<Option<usize>> = keys(input)
        .iter()
        .map(|k| position.get(k).copied())
        .collect();
    let children = current.children(root);
    let inputs = input.children(input_root);
    let bytes = |i: Option<usize>, j: usize| match i {
        Some(i) if current.same(children[i], input, inputs[j]) => current.source(children[i]),
        _ => input.source(inputs[j]),
    };
    let order: Vec<usize> = matched.iter().flatten().copied().collect();
    if order.windows(2).any(|w| w[0] > w[1]) {
        // Reordered: write the children in the input's order.
        let (first, last) = (children[0], children[children.len() - 1]);
        let separator = current.separator(first);
        let mut body = String::new();
        for (j, &i) in matched.iter().enumerate() {
            body.push_str(separator);
            body.push_str(bytes(i, j));
        }
        splices
            .edits
            .push((current.lead(first)..current.nodes[last].span.end, body));
        return splices.finish();
    }
    let kept: HashSet<usize> = order.into_iter().collect();
    for (i, &c) in children.iter().enumerate() {
        if !kept.contains(&i) {
            splices.remove(c);
        }
    }
    let mut anchor = None;
    for (j, &i) in matched.iter().enumerate() {
        match (i, anchor) {
            (Some(i), _) => {
                if !current.same(children[i], input, inputs[j]) {
                    splices.edits.push((
                        current.nodes[children[i]].span.clone(),
                        input.source(inputs[j]).to_owned(),
                    ));
                }
                anchor = Some(children[i]);
            }
            (None, Some(a)) => {
                let at = current.nodes[a].span.end;
                splices.edits.push((
                    at..at,
                    format!("{}{}", current.separator(a), input.source(inputs[j])),
                ));
            }
            (None, None) => {
                let at = current.lead(children[0]);
                splices.edits.push((
                    at..at,
                    format!(
                        "{}{}",
                        current.separator(children[0]),
                        input.source(inputs[j])
                    ),
                ));
            }
        }
    }
    splices.finish()
}
