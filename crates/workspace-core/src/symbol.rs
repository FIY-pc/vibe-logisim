//! Editable appearance drafts and source conversion. Native correspondence is supplied by the host.
use crate::{Error, Point, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use xmltree::{Element, XMLNode};

const SHAPES: &[&str] = &[
    "rect", "ellipse", "line", "polyline", "polygon", "path", "text",
];
const GEOMETRY: &[&str] = &[
    "x",
    "y",
    "width",
    "height",
    "rx",
    "ry",
    "cx",
    "cy",
    "r",
    "x1",
    "x2",
    "y1",
    "y2",
    "stroke-width",
    "font-size",
];
const ATTRS: &[&str] = &[
    "x",
    "y",
    "width",
    "height",
    "rx",
    "ry",
    "cx",
    "cy",
    "r",
    "x1",
    "x2",
    "y1",
    "y2",
    "points",
    "d",
    "fill",
    "stroke",
    "stroke-width",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-anchor",
    "dominant-baseline",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct SymbolPort {
    pub id: String,
    pub label: String,
    pub direction: String,
    pub width: u32,
    pub internal_x: i32,
    pub internal_y: i32,
    pub x: i32,
    pub y: i32,
    #[serde(default)]
    pub disconnect: bool,
}
impl SymbolPort {
    pub fn pin(&self) -> String {
        format!("{},{}", self.internal_x, self.internal_y)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct SymbolShape {
    pub id: String,
    pub tag: String,
    pub attrs: BTreeMap<String, String>,
    #[serde(default)]
    pub text: String,
    pub editable: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct SymbolDraft {
    pub ports: Vec<SymbolPort>,
    pub shapes: Vec<SymbolShape>,
}
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
pub struct InstancePort {
    pub index: u32,
    pub x: i32,
    pub y: i32,
}
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
pub struct SymbolUse {
    pub circuit: String,
    pub x: i32,
    pub y: i32,
    pub facing: String,
    pub ports: BTreeMap<String, InstancePort>,
}
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
pub struct Symbol {
    #[serde(flatten)]
    pub draft: SymbolDraft,
    pub anchor: BTreeMap<String, String>,
    pub default: bool,
    pub uses: Vec<SymbolUse>,
    #[serde(skip)]
    #[ts(skip)]
    artwork: BTreeMap<String, Element>,
}
fn invalid(message: &str) -> Error {
    Error::InvalidCommand(message.into())
}
fn children(e: &Element) -> impl Iterator<Item = &Element> {
    e.children.iter().filter_map(XMLNode::as_element)
}
fn attr<'a>(e: &'a Element, key: &str) -> &'a str {
    e.attributes.get(key).map(String::as_str).unwrap_or("")
}
fn integer(e: &Element, key: &str) -> Result<i32> {
    attr(e, key)
        .parse()
        .map_err(|_| invalid("原生封装返回了无效坐标或位宽"))
}
fn child<'a>(e: &'a Element, tag: &str) -> Result<&'a Element> {
    children(e)
        .find(|n| n.name == tag)
        .ok_or_else(|| invalid("原生封装信息不完整"))
}
fn node(tag: &str, attrs: impl IntoIterator<Item = (String, String)>) -> Element {
    let mut e = Element::new(tag);
    e.attributes.extend(attrs);
    e
}

pub fn read(native: &Element) -> Result<Symbol> {
    let symbol = child(native, "symbol")?;
    let appearance = child(symbol, "appear")?;
    let mut ports = Vec::new();
    for pin in children(symbol).filter(|e| e.name == "pin") {
        let visuals: Vec<_> = children(appearance)
            .filter(|e| e.name == "circ-port" && attr(e, "pin") == attr(pin, "id"))
            .collect();
        if visuals.len() != 1 {
            return Err(invalid("封装中存在无法唯一对应的引脚，请先修复封装"));
        }
        let visual = visuals[0];
        ports.push(SymbolPort {
            id: attr(pin, "id").into(),
            label: attr(pin, "label").into(),
            direction: attr(pin, "direction").into(),
            width: integer(pin, "width")?
                .try_into()
                .map_err(|_| invalid("原生端口位宽无效"))?,
            internal_x: integer(pin, "x")?,
            internal_y: integer(pin, "y")?,
            x: integer(visual, "x")? + integer(visual, "width")? / 2,
            y: integer(visual, "y")? + integer(visual, "height")? / 2,
            disconnect: false,
        });
    }
    ports.sort_by_key(|p| (p.y, p.x));
    let mut shapes = Vec::new();
    let mut artwork = BTreeMap::new();
    for (index, e) in children(appearance)
        .enumerate()
        .filter(|(_, e)| !e.name.starts_with("circ-"))
    {
        let id = format!("shape-{index}");
        shapes.push(SymbolShape {
            id: id.clone(),
            tag: e.name.clone(),
            attrs: e.attributes.clone().into_iter().collect(),
            text: e.get_text().unwrap_or_default().into_owned(),
            editable: SHAPES.contains(&e.name.as_str()),
        });
        artwork.insert(id, e.clone());
    }
    let uses = children(symbol)
        .filter(|e| e.name == "use")
        .map(|e| {
            let ports = children(e)
                .filter(|p| p.name == "port")
                .map(|p| {
                    Ok((
                        attr(p, "pin").into(),
                        InstancePort {
                            index: integer(p, "index")?
                                .try_into()
                                .map_err(|_| invalid("无效原生端口编号"))?,
                            x: integer(p, "x")?,
                            y: integer(p, "y")?,
                        },
                    ))
                })
                .collect::<Result<_>>()?;
            Ok(SymbolUse {
                circuit: attr(e, "circuit").into(),
                x: integer(e, "x")?,
                y: integer(e, "y")?,
                facing: attr(e, "facing").into(),
                ports,
            })
        })
        .collect::<Result<_>>()?;
    Ok(Symbol {
        draft: SymbolDraft { ports, shapes },
        anchor: child(appearance, "circ-anchor")?
            .attributes
            .clone()
            .into_iter()
            .collect(),
        default: attr(symbol, "default") == "true",
        uses,
        artwork,
    })
}

fn coordinate(value: i32, grid: bool, low: i32) -> Result<()> {
    if !(low..=6000).contains(&value) || (grid && value % 10 != 0) {
        return Err(invalid("端口位置需对齐 10 格网，且不能超出画布"));
    }
    Ok(())
}
fn pin_attributes(node: &mut Element, pin: &SymbolPort) {
    for (name, val) in [
        ("label", pin.label.clone()),
        ("width", pin.width.to_string()),
        ("output", (pin.direction == "output").to_string()),
    ] {
        set_setting(node, name, val);
    }
}
fn set_setting(e: &mut Element, name: &str, val: String) {
    if let Some(a) = e
        .children
        .iter_mut()
        .filter_map(XMLNode::as_mut_element)
        .find(|a| a.name == "a" && attr(a, "name") == name)
    {
        a.attributes.insert("val".into(), val);
    } else {
        e.children.push(XMLNode::Element(node(
            "a",
            [("name".into(), name.into()), ("val".into(), val)],
        )));
    }
}

/// Modify an unpublished XML tree; no document revision, history or file is changed here.
pub fn write(
    root: &mut Element,
    name: &str,
    baseline: &Symbol,
    draft: &SymbolDraft,
) -> Result<BTreeMap<String, SymbolPort>> {
    if draft.ports.len() > 128 || draft.shapes.len() > 512 {
        return Err(invalid("封装对象过多"));
    }
    let old: BTreeMap<_, _> = baseline
        .draft
        .ports
        .iter()
        .map(|p| (p.id.as_str(), p))
        .collect();
    let mut updated = BTreeMap::new();
    let mut occupied = BTreeSet::new();
    let mut internal = BTreeSet::new();
    for value in &draft.ports {
        let mut p = value.clone();
        let new_id = p.id.strip_prefix("new-").is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 60
                && id
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
        });
        if updated.contains_key(&p.id) || (!old.contains_key(p.id.as_str()) && !new_id) {
            return Err(invalid("端口标识无效或重复"));
        }
        if p.label.chars().count() > 120 {
            return Err(invalid("端口名称过长"));
        }
        if !["input", "output"].contains(&p.direction.as_str()) {
            return Err(invalid("请选择输入或输出"));
        }
        if !(1..=32).contains(&p.width) {
            return Err(invalid("端口位宽必须在 1–32 之间"));
        }
        coordinate(p.x, true, -6000)?;
        coordinate(p.y, true, -6000)?;
        if !occupied.insert((p.x, p.y)) {
            return Err(invalid("两个端口不能放在同一位置"));
        }
        if let Some(previous) = old.get(p.id.as_str()) {
            p.internal_x = previous.internal_x;
            p.internal_y = previous.internal_y;
        } else {
            coordinate(p.internal_x, true, 0)?;
            coordinate(p.internal_y, true, 0)?;
        }
        if !internal.insert((p.internal_x, p.internal_y)) {
            return Err(invalid("内部引脚位置重复"));
        }
        updated.insert(p.id.clone(), p);
    }
    let old_shapes: BTreeMap<_, _> = baseline
        .draft
        .shapes
        .iter()
        .map(|s| (s.id.as_str(), s))
        .collect();
    let mut appearance = Element::new("appear");
    let mut ids = BTreeSet::new();
    for shape in &draft.shapes {
        if shape.id.is_empty() || shape.id.len() > 128 || !ids.insert(&shape.id) {
            return Err(invalid("图形对象标识无效或重复"));
        }
        if !SHAPES.contains(&shape.tag.as_str()) {
            if old_shapes.get(shape.id.as_str()).copied() != Some(shape) {
                return Err(invalid("此图形暂不能编辑"));
            }
            appearance
                .children
                .push(XMLNode::Element(baseline.artwork[&shape.id].clone()));
            continue;
        }
        if shape.attrs.keys().any(|k| !ATTRS.contains(&k.as_str()))
            || shape
                .attrs
                .values()
                .any(|v| v.len() > 10000 || v.to_lowercase().contains("url("))
            || shape.text.chars().count() > 2000
        {
            return Err(invalid("封装图形属性或文字无效"));
        }
        for (key, value) in &shape.attrs {
            if GEOMETRY.contains(&key.as_str()) {
                let n: i32 = value
                    .parse()
                    .map_err(|_| invalid("封装图形位置和尺寸必须为整数"))?;
                let low =
                    if ["width", "height", "rx", "ry", "r", "font-size"].contains(&key.as_str()) {
                        1
                    } else if key == "stroke-width" {
                        0
                    } else {
                        -6000
                    };
                coordinate(n, false, low)?;
            }
        }
        let mut e = node(&shape.tag, shape.attrs.clone());
        if !shape.text.is_empty() {
            e.children.push(XMLNode::Text(shape.text.clone()));
        }
        appearance.children.push(XMLNode::Element(e));
    }
    for p in updated.values() {
        let radius = if p.direction == "input" { 4 } else { 5 };
        appearance.children.push(XMLNode::Element(node(
            "circ-port",
            [
                ("pin".into(), p.pin()),
                ("x".into(), (p.x - radius).to_string()),
                ("y".into(), (p.y - radius).to_string()),
                ("width".into(), (radius * 2).to_string()),
                ("height".into(), (radius * 2).to_string()),
            ],
        )));
    }
    appearance.children.push(XMLNode::Element(node(
        "circ-anchor",
        baseline.anchor.clone(),
    )));
    let wiring = children(root)
        .find(|e| e.name == "lib" && attr(e, "desc") == "#Wiring")
        .map(|e| attr(e, "name").to_owned())
        .ok_or_else(|| invalid("工程未包含原生 Wiring 库"))?;
    let circuit = root
        .children
        .iter_mut()
        .filter_map(XMLNode::as_mut_element)
        .find(|e| e.name == "circuit" && attr(e, "name") == name)
        .ok_or_else(|| invalid("找不到电路"))?;
    circuit
        .children
        .retain(|e| !e.as_element().is_some_and(|e| e.name == "appear"));
    circuit.children.insert(0, XMLNode::Element(appearance));
    set_setting(circuit, "appearance", "custom".into());
    for key in old.keys() {
        let location = format!("({key})");
        let indices: Vec<_> = circuit
            .children
            .iter()
            .enumerate()
            .filter(|(_, e)| {
                e.as_element().is_some_and(|e| {
                    e.name == "comp" && attr(e, "name") == "Pin" && attr(e, "loc") == location
                })
            })
            .map(|(i, _)| i)
            .collect();
        if indices.len() != 1 {
            return Err(invalid("内部引脚无法唯一对应"));
        }
        if let Some(p) = updated.get(*key) {
            pin_attributes(circuit.children[indices[0]].as_mut_element().unwrap(), p);
        } else {
            circuit.children.remove(indices[0]);
        }
    }
    for (key, p) in &updated {
        if old.contains_key(key.as_str()) {
            continue;
        }
        let location = format!("({})", p.pin());
        if children(circuit).any(|e| e.name == "comp" && attr(e, "loc") == location) {
            return Err(invalid("新增引脚的位置已被占用"));
        }
        let mut e = node(
            "comp",
            [
                ("name".into(), "Pin".into()),
                ("lib".into(), wiring.clone()),
                ("loc".into(), location),
            ],
        );
        pin_attributes(&mut e, p);
        set_setting(&mut e, "tristate", "false".into());
        set_setting(
            &mut e,
            "facing",
            if p.direction == "input" {
                "east"
            } else {
                "west"
            }
            .into(),
        );
        circuit.children.push(XMLNode::Element(e));
    }
    Ok(updated)
}

pub fn assert_accepted(
    draft: &SymbolDraft,
    updated: &BTreeMap<String, SymbolPort>,
    accepted: &Symbol,
) -> Result<()> {
    if draft.shapes.len() != accepted.draft.shapes.len() {
        return Err(invalid("原生运行时未接受全部封装图形"));
    }
    for (requested, actual) in draft.shapes.iter().zip(&accepted.draft.shapes) {
        if requested.tag != actual.tag || requested.text != actual.text {
            return Err(invalid("原生运行时未接受封装图形或文字"));
        }
        for (key, value) in &requested.attrs {
            if GEOMETRY.contains(&key.as_str())
                && actual.attrs.get(key).and_then(|v| v.parse::<f64>().ok())
                    != value.parse::<f64>().ok()
            {
                return Err(invalid("原生运行时未接受封装图形尺寸或位置"));
            }
        }
    }
    if accepted.draft.ports.len() != updated.len() {
        return Err(invalid("原生运行时未接受全部端口"));
    }
    for p in updated.values() {
        let actual = accepted
            .draft
            .ports
            .iter()
            .find(|a| a.id == p.pin())
            .ok_or_else(|| invalid("原生运行时未接受端口定义"))?;
        if (p.label.as_str(), p.direction.as_str(), p.width, p.x, p.y)
            != (
                actual.label.as_str(),
                actual.direction.as_str(),
                actual.width,
                actual.x,
                actual.y,
            )
        {
            return Err(invalid("原生运行时未接受端口定义或位置"));
        }
    }
    Ok(())
}

pub fn set_wires(root: &mut Element, circuit: &str, segments: &[(Point, Point)]) -> Result<()> {
    let c = root
        .children
        .iter_mut()
        .filter_map(XMLNode::as_mut_element)
        .find(|e| e.name == "circuit" && attr(e, "name") == circuit)
        .ok_or_else(|| invalid("找不到电路"))?;
    c.children
        .retain(|e| !e.as_element().is_some_and(|e| e.name == "wire"));
    for (a, b) in segments {
        c.children.push(XMLNode::Element(node(
            "wire",
            [
                ("from".into(), format!("({},{})", a.x, a.y)),
                ("to".into(), format!("({},{})", b.x, b.y)),
            ],
        )));
    }
    Ok(())
}
