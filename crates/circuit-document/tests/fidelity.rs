//! Edits change only the bytes of the elements they touch.
use std::collections::BTreeMap;
use vibe_circuit_document::{Document, Edit, Error, Point};

/// A file in the style Logisim 2.7.1 writes.
const CLASSIC: &str = r##"<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<project source="2.7.1" version="1.0">
This file is intended to be loaded by Logisim (http://www.cburch.com/logisim/).
  <lib desc="#Wiring" name="0">
    <tool name="Splitter">
      <a name="fanout" val="4"/>
    </tool>
  </lib>
  <lib desc="#Gates" name="1"/>
  <main name="main"/>
  <options>
    <a name="gateUndefined" val="ignore"/>
  </options>
  <mappings>
    <tool lib="0" map="Button2" name="Menu Tool"/>
  </mappings>
  <toolbar>
    <tool lib="0" name="Pin"/>
  </toolbar>
  <circuit name="main">
    <a name="circuit" val="main"/>
    <a name="clabel" val=""/>
    <wire from="(100,100)" to="(200,100)"/>
    <wire from="(200,100)" to="(200,150)"/>
    <comp lib="0" loc="(100,100)" name="Pin">
      <a name="tristate" val="false"/>
    </comp>
    <comp lib="1" loc="(260,150)" name="AND Gate">
      <a name="label" val="g1"/>
    </comp>
  </circuit>
  <circuit name="child">
    <a name="circuit" val="child"/>
    <appear>
      <rect height="40" stroke="#000000" width="30" x="50" y="50"/>
      <circ-port height="8" pin="40,60" width="8" x="46" y="56"/>
      <circ-port height="10" pin="140,60" width="10" x="75" y="55"/>
      <circ-anchor facing="east" height="6" width="6" x="77" y="57"/>
    </appear>
    <comp lib="0" loc="(40,60)" name="Pin"/>
    <comp lib="0" loc="(140,60)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
    </comp>
  </circuit>
</project>
"##;

/// A file in the style Logisim 2.15 writes: no declaration, ` />`.
const NEWER: &str = r##"<project source="2.15.0.2.exe" version="1.0">
This file is intended to be loaded by Logisim http://logisim.altervista.org

  <lib desc="#Wiring" name="0" />
  <lib desc="#Gates" name="1" />
  <main name="main" />
  <options>
    <a name="gateUndefined" val="ignore" />
  </options>
  <mappings />
  <toolbar />
  <circuit name="main">
    <a name="circuit" val="main" />
    <wire from="(100,100)" to="(200,100)" />
    <comp lib="1" loc="(260,150)" name="AND Gate" />
  </circuit>
</project>
"##;

fn open(xml: &str) -> Document {
    Document::from_bytes("test.circ".into(), None, xml.as_bytes().to_vec(), true).unwrap()
}

fn text(d: &Document) -> String {
    String::from_utf8(d.bytes().to_vec()).unwrap()
}

fn edit(d: &mut Document, circuit: &str, edit: Edit) {
    d.edit(&d.revision(), circuit, edit).unwrap();
}

fn p(x: i32, y: i32) -> Point {
    Point { x, y }
}

/// Changed lines, as `-old` and `+new`, in file order.
fn diff(a: &str, b: &str) -> Vec<String> {
    let (a, b): (Vec<&str>, Vec<&str>) = (a.split('\n').collect(), b.split('\n').collect());
    let mut common = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            common[i][j] = if a[i] == b[j] {
                common[i + 1][j + 1] + 1
            } else {
                common[i + 1][j].max(common[i][j + 1])
            };
        }
    }
    let (mut i, mut j, mut out) = (0, 0, Vec::new());
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            i += 1;
            j += 1;
        } else if i < a.len() && (j == b.len() || common[i + 1][j] >= common[i][j + 1]) {
            out.push(format!("-{}", a[i]));
            i += 1;
        } else {
            out.push(format!("+{}", b[j]));
            j += 1;
        }
    }
    out
}

fn wires(d: &Document, circuit: &str) -> Vec<(Point, Point)> {
    d.view()
        .unwrap()
        .circuits
        .into_iter()
        .find(|c| c.name == circuit)
        .unwrap()
        .wires
        .into_iter()
        .map(|w| (w.from, w.to))
        .collect()
}

#[test]
fn s1_saving_without_edits_keeps_every_byte() {
    for xml in [CLASSIC, NEWER] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.circ");
        std::fs::write(&path, xml).unwrap();
        let mut d = Document::open(&path).unwrap();
        assert_eq!(d.bytes(), xml.as_bytes());
        d.save(&d.revision(), None).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), xml.as_bytes());
        let copy = dir.path().join("copy.circ");
        d.save(&d.revision(), Some(&copy)).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), xml.as_bytes());
    }
}

#[test]
fn s2_attribute_edit_changes_one_line() {
    let mut d = open(CLASSIC);
    let attributes = |values: &[(&str, &str)]| Edit::Attributes {
        id: "c260_150".into(),
        values: values
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    };
    edit(&mut d, "main", attributes(&[("label", "g2")]));
    assert_eq!(
        diff(CLASSIC, &text(&d)),
        [
            r#"-      <a name="label" val="g1"/>"#,
            r#"+      <a name="label" val="g2"/>"#
        ]
    );
    let before = text(&d);
    edit(&mut d, "main", attributes(&[("facing", "north")]));
    assert_eq!(
        diff(&before, &text(&d)),
        [r#"+      <a name="facing" val="north"/>"#]
    );
    let revision = d.revision();
    edit(
        &mut d,
        "main",
        attributes(&[("facing", "north"), ("label", "g2")]),
    );
    assert_eq!(d.revision(), revision);
    let before = text(&d);
    edit(&mut d, "main", attributes(&[("label", "a < b & \"c\"")]));
    assert_eq!(
        diff(&before, &text(&d)),
        [
            r#"-      <a name="label" val="g2"/>"#,
            r#"+      <a name="label" val="a &lt; b &amp; &quot;c&quot;"/>"#
        ]
    );
    let view = d.view().unwrap();
    let gate = &view.circuits[0].components[1];
    assert_eq!(gate.attributes["label"], "a < b & \"c\"");
}

#[test]
fn s3_new_wire_is_one_line_after_the_last_wire() {
    let mut d = open(CLASSIC);
    edit(
        &mut d,
        "main",
        Edit::Wire {
            points: vec![p(260, 200), p(300, 200)],
        },
    );
    assert_eq!(
        diff(CLASSIC, &text(&d)),
        [r#"+    <wire from="(260,200)" to="(300,200)"/>"#]
    );
    let after = text(&d);
    let line = after.find(r#"<wire from="(260,200)""#).expect("new wire");
    assert!(after[..line].ends_with("<wire from=\"(200,100)\" to=\"(200,150)\"/>\n    "));
    let child = |s: &str| s[s.find("<circuit name=\"child\"").unwrap()..].to_owned();
    assert_eq!(child(&after), child(CLASSIC));
}

#[test]
fn s4_move_changes_only_moved_and_rerouted_lines() {
    let mut d = open(CLASSIC);
    edit(
        &mut d,
        "main",
        Edit::Move {
            ids: vec!["c260_150".into()],
            delta: p(0, 20),
        },
    );
    assert_eq!(
        diff(CLASSIC, &text(&d)),
        [
            r#"-    <comp lib="1" loc="(260,150)" name="AND Gate">"#,
            r#"+    <comp lib="1" loc="(260,170)" name="AND Gate">"#
        ]
    );
    // The pin's wire follows it with one bend; the other wire keeps its bytes.
    let mut d = open(CLASSIC);
    d.move_connected(
        &d.revision(),
        "main",
        vec!["c100_100".into()],
        p(0, -20),
        vec![p(100, 100)],
        vec![p(260, 150)],
    )
    .unwrap();
    assert_eq!(
        diff(CLASSIC, &text(&d)),
        [
            r#"-    <wire from="(100,100)" to="(200,100)"/>"#,
            r#"+    <wire from="(100,80)" to="(200,80)"/>"#,
            r#"+    <wire from="(200,80)" to="(200,100)"/>"#,
            r#"-    <comp lib="0" loc="(100,100)" name="Pin">"#,
            r#"+    <comp lib="0" loc="(100,80)" name="Pin">"#
        ]
    );
}

#[test]
fn s5_newer_style_survives_edits() {
    let mut d = open(NEWER);
    edit(
        &mut d,
        "main",
        Edit::Place {
            name: "Pin".into(),
            library: Some("0".into()),
            location: p(300, 300),
            attributes: BTreeMap::from([("facing".into(), "west".into())]),
        },
    );
    edit(
        &mut d,
        "main",
        Edit::Wire {
            points: vec![p(300, 300), p(350, 300)],
        },
    );
    let after = text(&d);
    assert_eq!(after.as_bytes()[..64], NEWER.as_bytes()[..64]);
    assert_eq!(
        diff(NEWER, &after),
        [
            r#"+    <wire from="(300,300)" to="(350,300)" />"#,
            r#"+    <comp lib="0" loc="(300,300)" name="Pin">"#,
            r#"+      <a name="facing" val="west" />"#,
            r#"+    </comp>"#
        ]
    );
    let reopened = open(&after);
    assert_eq!(reopened.view().unwrap().circuits[0].components.len(), 2);
    // Windows line ends stay Windows line ends.
    let crlf = NEWER.replace('\n', "\r\n");
    let mut d = open(&crlf);
    edit(
        &mut d,
        "main",
        Edit::Wire {
            points: vec![p(300, 300), p(350, 300)],
        },
    );
    assert_eq!(
        diff(&crlf, &text(&d)),
        ["+    <wire from=\"(300,300)\" to=\"(350,300)\" />\r"]
    );
}

#[test]
fn s6_undoing_every_edit_restores_the_original_bytes() {
    let mut d = open(CLASSIC);
    let edits = [
        (
            "main",
            Edit::Attributes {
                id: "c260_150".into(),
                values: BTreeMap::from([("label".into(), "sum".into())]),
            },
        ),
        (
            "main",
            Edit::Wire {
                points: vec![p(150, 50), p(150, 100)],
            },
        ),
        (
            "main",
            Edit::Move {
                ids: vec!["c260_150".into(), "w1".into()],
                delta: p(10, 10),
            },
        ),
        (
            "child",
            Edit::Delete {
                ids: vec!["c40_60".into()],
            },
        ),
        (
            "main",
            Edit::AddCircuit {
                name: "extra".into(),
            },
        ),
        (
            "extra",
            Edit::RenameCircuit {
                name: "spare".into(),
            },
        ),
        ("spare", Edit::SetMain),
    ];
    let mut revisions = vec![d.revision()];
    for (circuit, e) in edits {
        edit(&mut d, circuit, e);
        assert_ne!(Some(&d.revision()), revisions.last());
        revisions.push(d.revision());
    }
    let edited = d.bytes().to_vec();
    while d.view().unwrap().can_undo {
        d.undo(&d.revision()).unwrap();
    }
    assert_eq!(d.bytes(), CLASSIC.as_bytes());
    while d.view().unwrap().can_redo {
        d.redo(&d.revision()).unwrap();
    }
    assert_eq!(d.bytes(), edited);
}

fn trunk() -> Document {
    let mut d = Document::new("junction.circ".into());
    edit(
        &mut d,
        "main",
        Edit::Wire {
            points: vec![p(0, 100), p(200, 100)],
        },
    );
    d
}

#[test]
fn j1_two_branches_meeting_on_a_trunk_split_it() {
    let mut d = trunk();
    for from in [p(100, 50), p(100, 150)] {
        edit(
            &mut d,
            "main",
            Edit::Wire {
                points: vec![from, p(100, 100)],
            },
        );
    }
    assert_eq!(
        wires(&d, "main"),
        [
            (p(0, 100), p(100, 100)),
            (p(100, 100), p(200, 100)),
            (p(100, 50), p(100, 100)),
            (p(100, 150), p(100, 100)),
        ]
    );
}

#[test]
fn j2_one_branch_splits_the_trunk() {
    let mut d = trunk();
    edit(
        &mut d,
        "main",
        Edit::Wire {
            points: vec![p(100, 50), p(100, 100)],
        },
    );
    assert_eq!(
        wires(&d, "main"),
        [
            (p(0, 100), p(100, 100)),
            (p(100, 100), p(200, 100)),
            (p(100, 50), p(100, 100)),
        ]
    );
}

#[test]
fn j3_a_crossing_splits_nothing() {
    let mut d = trunk();
    edit(
        &mut d,
        "main",
        Edit::Wire {
            points: vec![p(100, 50), p(100, 150)],
        },
    );
    assert_eq!(
        wires(&d, "main"),
        [(p(0, 100), p(200, 100)), (p(100, 50), p(100, 150))]
    );
}

#[test]
fn j4_redrawing_a_wire_changes_nothing() {
    let mut d = trunk();
    let revision = d.revision();
    edit(
        &mut d,
        "main",
        Edit::Wire {
            points: vec![p(200, 100), p(0, 100)],
        },
    );
    assert_eq!(d.revision(), revision);
}

#[test]
fn moved_wire_ending_on_a_trunk_splits_it() {
    let mut d = trunk();
    edit(
        &mut d,
        "main",
        Edit::Wire {
            points: vec![p(100, 0), p(100, 50)],
        },
    );
    edit(
        &mut d,
        "main",
        Edit::Move {
            ids: vec!["w1".into()],
            delta: p(0, 50),
        },
    );
    assert_eq!(
        wires(&d, "main"),
        [
            (p(0, 100), p(100, 100)),
            (p(100, 100), p(200, 100)),
            (p(100, 50), p(100, 100)),
        ]
    );
}

#[test]
fn rerouted_wire_keeps_the_junction_at_its_other_end() {
    // The branch ends inside an unsplit trunk, which Logisim connects on load.
    let tee = r##"<project source="2.7.1" version="1.0">
  <lib desc="#Wiring" name="0"/>
  <main name="main"/>
  <circuit name="main">
    <wire from="(0,100)" to="(200,100)"/>
    <wire from="(100,100)" to="(100,150)"/>
    <comp lib="0" loc="(100,150)" name="Pin"/>
  </circuit>
</project>
"##;
    let mut d = open(tee);
    d.move_connected(
        &d.revision(),
        "main",
        vec!["c100_150".into()],
        p(0, 20),
        vec![p(100, 150)],
        vec![],
    )
    .unwrap();
    assert_eq!(
        diff(tee, &text(&d)),
        [
            r#"-    <wire from="(100,100)" to="(100,150)"/>"#,
            r#"-    <comp lib="0" loc="(100,150)" name="Pin"/>"#,
            r#"+    <wire from="(100,100)" to="(100,170)"/>"#,
            r#"+    <comp lib="0" loc="(100,170)" name="Pin"/>"#
        ]
    );
}

#[test]
fn d1_deleting_a_pin_removes_its_appearance_port() {
    let mut d = open(CLASSIC);
    edit(
        &mut d,
        "child",
        Edit::Delete {
            ids: vec!["c40_60".into()],
        },
    );
    assert_eq!(
        diff(CLASSIC, &text(&d)),
        [
            r#"-      <circ-port height="8" pin="40,60" width="8" x="46" y="56"/>"#,
            r#"-    <comp lib="0" loc="(40,60)" name="Pin"/>"#
        ]
    );
    let mut d = open(CLASSIC);
    edit(
        &mut d,
        "child",
        Edit::Move {
            ids: vec!["c140_60".into()],
            delta: p(20, 0),
        },
    );
    assert_eq!(
        diff(CLASSIC, &text(&d)),
        [
            r#"-      <circ-port height="10" pin="140,60" width="10" x="75" y="55"/>"#,
            r#"+      <circ-port height="10" pin="160,60" width="10" x="75" y="55"/>"#,
            r#"-    <comp lib="0" loc="(140,60)" name="Pin">"#,
            r#"+    <comp lib="0" loc="(160,60)" name="Pin">"#
        ]
    );
}

#[test]
fn circuit_operations_splice_their_elements() {
    let mut d = open(CLASSIC);
    edit(
        &mut d,
        "main",
        Edit::AddCircuit {
            name: "extra".into(),
        },
    );
    assert_eq!(
        diff(CLASSIC, &text(&d)),
        [
            r#"+  <circuit name="extra">"#,
            r#"+    <a name="circuit" val="extra"/>"#,
            r#"+  </circuit>"#
        ]
    );
    edit(
        &mut d,
        "main",
        Edit::Place {
            name: "child".into(),
            library: None,
            location: p(400, 400),
            attributes: BTreeMap::new(),
        },
    );
    let before = text(&d);
    edit(
        &mut d,
        "child",
        Edit::RenameCircuit {
            name: "inner".into(),
        },
    );
    assert_eq!(
        diff(&before, &text(&d)),
        [
            r#"-    <comp loc="(400,400)" name="child"/>"#,
            r#"+    <comp loc="(400,400)" name="inner"/>"#,
            r#"-  <circuit name="child">"#,
            r#"-    <a name="circuit" val="child"/>"#,
            r#"+  <circuit name="inner">"#,
            r#"+    <a name="circuit" val="inner"/>"#
        ]
    );
    let before = text(&d);
    edit(&mut d, "extra", Edit::SetMain);
    assert_eq!(
        diff(&before, &text(&d)),
        [r#"-  <main name="main"/>"#, r#"+  <main name="extra"/>"#]
    );
    let before = text(&d);
    edit(&mut d, "extra", Edit::DeleteCircuit);
    assert_eq!(
        diff(&before, &text(&d)),
        [
            r#"-  <main name="extra"/>"#,
            r#"+  <main name="main"/>"#,
            r#"-  <circuit name="extra">"#,
            r#"-    <a name="circuit" val="extra"/>"#,
            r#"-  </circuit>"#
        ]
    );
}

const STACKED: &str = r##"<project source="2.7.1" version="1.0">
  <lib desc="#Wiring" name="0"/>
  <lib desc="#Gates" name="1"/>
  <circuit name="main">
    <comp lib="0" loc="(50,50)" name="Pin"/>
    <comp lib="1" loc="(50,50)" name="AND Gate">
      <a name="label" val="b"/>
    </comp>
    <comp lib="1" loc="(50,50)" name="AND Gate">
      <a name="label" val="a"/>
    </comp>
    <comp lib="1" loc="( -10 , 20 )" name="NOT Gate"/>
    <wire from="0 0" to="(10,0)"/>
  </circuit>
</project>
"##;

#[test]
fn ids_name_locations_and_order_stacks_like_the_observer() {
    let mut d = open(STACKED);
    let view = d.view().unwrap();
    let circuit = &view.circuits[0];
    let ids: Vec<&str> = circuit.components.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["c50_50_3", "c50_50_2", "c50_50", "cm10_20"]);
    assert_eq!(circuit.components[3].location, p(-10, 20));
    assert_eq!(circuit.wires[0].id, "w0");
    assert_eq!(
        (circuit.wires[0].from, circuit.wires[0].to),
        (p(0, 0), p(10, 0))
    );
    edit(
        &mut d,
        "main",
        Edit::Attributes {
            id: "c50_50_3".into(),
            values: BTreeMap::from([("tristate".into(), "false".into())]),
        },
    );
    assert_eq!(
        diff(STACKED, &text(&d)),
        [
            r#"-    <comp lib="0" loc="(50,50)" name="Pin"/>"#,
            r#"+    <comp lib="0" loc="(50,50)" name="Pin">"#,
            r#"+      <a name="tristate" val="false"/>"#,
            r#"+    </comp>"#
        ]
    );
    let stale = |d: &mut Document, ids: &[&str]| {
        matches!(
            d.edit(
                &d.revision(),
                "main",
                Edit::Delete {
                    ids: ids.iter().map(|s| s.to_string()).collect(),
                },
            ),
            Err(Error::InvalidCommand(message)) if message == "对象已失效"
        )
    };
    assert!(stale(&mut d, &["c1_1"]));
    assert!(stale(&mut d, &["w00"]));
    assert!(stale(&mut d, &["w1"]));
    assert!(stale(&mut d, &["c50_50_4"]));
    assert!(matches!(
        d.edit(
            &d.revision(),
            "main",
            Edit::Attributes {
                id: "w0".into(),
                values: BTreeMap::new(),
            },
        ),
        Err(Error::InvalidCommand(message)) if message == "请选择元件"
    ));
}

#[test]
fn replace_keeps_the_bytes_of_unchanged_elements() {
    // Same content, written differently: nothing changes.
    let mut d = open(CLASSIC);
    let rewritten = CLASSIC
        .replace(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="no"?>"#,
            "",
        )
        .replace("\n    ", "\n\t\t")
        .replace(
            r#"lib="1" loc="(260,150)" name="AND Gate""#,
            r#"name="AND Gate" loc="(260,150)" lib="1""#,
        );
    edit(
        &mut d,
        "main",
        Edit::Replace {
            xml: rewritten.clone(),
        },
    );
    assert_eq!(d.bytes(), CLASSIC.as_bytes());
    assert!(!d.view().unwrap().can_undo);
    // One changed circuit takes the input's bytes for that circuit only.
    let changed = rewritten.replace(
        "<comp lib=\"0\" loc=\"(40,60)\" name=\"Pin\"/>",
        "<comp lib=\"0\" loc=\"(40,80)\" name=\"Pin\"/>",
    );
    edit(
        &mut d,
        "main",
        Edit::Replace {
            xml: changed.clone(),
        },
    );
    let span = |s: &str| {
        let start = s.find("<circuit name=\"child\"").unwrap();
        let end = start + s[start..].find("</circuit>").unwrap() + "</circuit>".len();
        (start, end)
    };
    let ((a, b), (x, y)) = (span(CLASSIC), span(&changed));
    assert_eq!(
        text(&d),
        format!("{}{}{}", &CLASSIC[..a], &changed[x..y], &CLASSIC[b..])
    );
    // A connected move written back through Replace keeps its exact bytes.
    let mut d = open(CLASSIC);
    let mut candidate = d.clone();
    candidate
        .move_connected(
            &candidate.revision(),
            "main",
            vec!["c100_100".into()],
            p(0, -20),
            vec![p(100, 100)],
            vec![],
        )
        .unwrap();
    edit(
        &mut d,
        "main",
        Edit::Replace {
            xml: text(&candidate),
        },
    );
    assert_eq!(d.bytes(), candidate.bytes());
}

#[test]
fn files_in_other_encodings_keep_their_bytes_until_edited() {
    let latin1 = b"<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?>\n<project source=\"2.7.1\" version=\"1.0\">\n  <circuit name=\"main\">\n    <comp lib=\"1\" loc=\"(50,50)\" name=\"AND Gate\">\n      <a name=\"label\" val=\"caf\xe9\"/>\n    </comp>\n  </circuit>\n</project>\n";
    let utf16: Vec<u8> = [0xFF, 0xFE]
        .into_iter()
        .chain(
            String::from_utf8_lossy(latin1)
                .replace("ISO-8859-1", "UTF-16")
                .replace('\u{fffd}', "\u{e9}")
                .encode_utf16()
                .flat_map(u16::to_le_bytes),
        )
        .collect();
    for original in [latin1.to_vec(), utf16] {
        let mut d = Document::from_bytes("x.circ".into(), None, original.clone(), true).unwrap();
        assert_eq!(d.bytes(), original);
        let label =
            |d: &Document| d.view().unwrap().circuits[0].components[0].attributes["label"].clone();
        assert_eq!(label(&d), "caf\u{e9}");
        edit(
            &mut d,
            "main",
            Edit::Attributes {
                id: "c50_50".into(),
                values: BTreeMap::from([("label".into(), "th\u{e9}".into())]),
            },
        );
        assert!(text(&d).starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"));
        assert_eq!(label(&d), "th\u{e9}");
        d.undo(&d.revision()).unwrap();
        assert_eq!(d.bytes(), original);
    }
}
