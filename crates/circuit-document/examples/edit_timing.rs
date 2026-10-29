use std::time::Instant;
use vibe_circuit_document::{Document, Edit, Point};
fn main() {
    let path = std::path::Path::new("/tmp/vl-tools/size/course-size.circ");
    let mut t = Instant::now();
    let mut d = Document::open(path).unwrap();
    eprintln!("open {:.2}", t.elapsed().as_secs_f64() * 1000.0);
    let circuit = "core_c";
    for round in 0..3 {
        let rev = d.revision();
        t = Instant::now();
        eprintln!("wire:");
        let y = 4000 + 40 * round;
        let outcome = d
            .edit(
                &rev,
                circuit,
                Edit::Wire {
                    points: vec![Point { x: 3000, y }, Point { x: 3040, y }],
                },
            )
            .unwrap();
        eprintln!("edit.total {:.2}", t.elapsed().as_secs_f64() * 1000.0);
        t = Instant::now();
        let change = d.view_change(&rev, &outcome.changed_circuits).unwrap();
        eprintln!("view_change {:.2}", t.elapsed().as_secs_f64() * 1000.0);
        t = Instant::now();
        let json = serde_json::to_vec(&change).unwrap();
        eprintln!(
            "to_vec {:.2} ({} KB)",
            t.elapsed().as_secs_f64() * 1000.0,
            json.len() / 1024
        );
        t = Instant::now();
        let value = serde_json::to_value(&change).unwrap();
        eprintln!("to_value {:.2}", t.elapsed().as_secs_f64() * 1000.0);
        t = Instant::now();
        let _ = serde_json::to_vec(&value).unwrap();
        eprintln!("value.to_vec {:.2}", t.elapsed().as_secs_f64() * 1000.0);
        t = Instant::now();
        let _ = d.snapshot();
        eprintln!("snapshot {:.2}", t.elapsed().as_secs_f64() * 1000.0);
    }
}
