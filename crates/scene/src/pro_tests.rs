//! Pro-mode contract: solo/locked/shy, markers, work area, precompose, sample_prop, bezier keys.

use crate::{Layer, Library, Op, Prop, Scene};

fn layer(json: &str) -> Layer {
    serde_json::from_str(json).unwrap()
}

fn ops(json: &str) -> Vec<Op> {
    Op::parse_list(json).unwrap()
}

/// A frame as text with every number rounded, so float noise below 1e-3 compares equal.
fn frame_text(s: &Scene, t: f32) -> String {
    let raw = format!("{:?}", s.frame(t));
    let (mut out, mut num) = (String::new(), String::new());
    let flush = |num: &mut String, out: &mut String| {
        if !num.is_empty() {
            match num.parse::<f64>() {
                Ok(v) => out.push_str(&format!("{:.3}", if v.abs() < 5e-4 { 0.0 } else { v })),
                Err(_) => out.push_str(num),
            }
            num.clear();
        }
    };
    for c in raw.chars() {
        if c.is_ascii_digit() || c == '.' || (c == '-' && num.is_empty()) || ((c == 'e') && !num.is_empty()) {
            num.push(c);
        } else {
            flush(&mut num, &mut out);
            out.push(c);
        }
    }
    flush(&mut num, &mut out);
    out
}

fn scene_with(layers: &[&str]) -> Scene {
    let mut s = Scene::default();
    let lib: Library = serde_json::from_str(r#"{"anchors":{"hero":[0.5,0.25]}}"#).unwrap();
    s.apply(&[Op::SetLibrary { library: lib }]).unwrap();
    for l in layers {
        s.apply(&[Op::AddLayer { layer: layer(l) }]).unwrap();
    }
    s
}

#[test]
fn switches_markers_and_work_area_round_trip() {
    let mut s = scene_with(&[r#"{"id":"a","type":"shape","shape":"rect","w":10,"h":10}"#]);
    s.apply(&ops(r##"[{"op":"patch","id":"a","fields":{"solo":true,"locked":true,"shy":true}},
        {"op":"set_markers","markers":[{"t":2,"label":"drop","color":"#F5A623"},{"t":0.5,"label":"in"}]},
        {"op":"set_work_area","work_area":[0.5,2]}]"##))
    .unwrap();
    let json = s.to_json();
    let back = Scene::from_json(&json).unwrap();
    assert_eq!(back, s);
    assert!(json.contains(r#""solo":true"#) && json.contains(r#""locked":true"#) && json.contains(r#""shy":true"#), "{json}");
    assert!(json.contains(r##""markers":[{"t":0.5,"label":"in"},{"t":2.0,"label":"drop","color":"#f5a623"}]"##), "sorted, color kept: {json}");
    assert!(json.contains(r#""work_area":[0.5,2.0]"#), "{json}");
    assert!(s.summary().contains("work area: 0.50-2.00s") && s.summary().contains("markers: 0.50 \"in\""));
    // Defaults are left out, and null clears.
    s.apply(&ops(r#"[{"op":"patch","id":"a","fields":{"solo":false,"locked":false,"shy":false}},{"op":"set_markers","markers":[]},{"op":"set_work_area","work_area":null}]"#)).unwrap();
    let json = s.to_json();
    assert!(!json.contains("solo") && !json.contains("locked") && !json.contains("shy") && !json.contains("markers") && !json.contains("work_area"), "{json}");
    assert!(s.apply(&ops(r#"[{"op":"set_work_area","work_area":[2,1]}]"#)).is_err());
    assert!(s.apply(&ops(r#"[{"op":"set_markers","markers":[{"t":-1,"label":"x"}]}]"#)).is_err());
}

#[test]
fn solo_draws_only_solo_layers_and_what_they_need() {
    let base = [
        r#"{"id":"bg","type":"shape","shape":"rect","w":1080,"h":1920,"x":540,"y":960}"#,
        r#"{"id":"null","type":"shape","shape":"rect","w":10,"h":10,"x":300,"y":300}"#,
        r#"{"id":"mask","type":"shape","shape":"ellipse","w":200,"h":200,"x":300,"y":300}"#,
        r#"{"id":"hero","type":"shape","shape":"rect","w":100,"h":100,"x":20,"parent":"null","matte":{"layer":"mask"}}"#,
        r#"{"id":"grade","type":"shape","shape":"rect","w":1080,"h":1920,"x":540,"y":960,"adjustment":true,"effects":[{"fx":"blur","radius":4}]}"#,
    ];
    let s = scene_with(&base);
    assert_eq!(s.solo_mask(), None);
    assert_eq!(s.frame(1.0).len(), 5);
    let mut solo = s.clone();
    solo.apply(&ops(r#"[{"op":"patch","id":"hero","fields":{"solo":true}}]"#)).unwrap();
    assert_eq!(solo.solo_mask(), Some(vec![false, false, false, true, true]), "the adjustment layer above stays");
    let items = solo.frame(1.0);
    assert_eq!(items.len(), 2, "hero (matted, in its parent) and the grade: {items:?}");
    // The solo layer draws exactly as it did: parent transform and matte still apply.
    let alone = |s: &Scene| format!("{:?}", s.frame(1.0).into_iter().find(|i| matches!(i, crate::DrawItem::Fx(f) if !f.adjust)));
    assert_eq!(alone(&solo), alone(&s));
    assert_eq!(solo.pick(1.0, 540.0, 1500.0), Some("grade".into()), "hidden layers can't be clicked");
}

#[test]
fn precompose_renders_identically() {
    let layers = [
        r#"{"id":"bg","type":"shape","shape":"rect","w":1080,"h":1920,"x":540,"y":960,"fill":"background"}"#,
        r#"{"id":"card","type":"shape","shape":"rect","start":0.5,"anchor":"hero","w":400,"h":300,"radius":24,"fill":"surface",
            "x":[{"t":0,"v":-200,"bezier":[0.2,0.8,0.2,1]},{"t":1,"v":0}],"effects":[{"fx":"blur","radius":2}]}"#,
        r#"{"id":"title","type":"text","text":"Save $5 now","size":60,"start":1,"parent":"card","y":"40*sin(T*3) - 20"}"#,
        r#"{"id":"dot","type":"shape","shape":"ellipse","start":0.8,"end":3,"w":80,"h":80,"x":"title.y(T - 0.2) + 640","y":"200 + 30*t","matte":{"layer":"title"},
            "time":"t*0.5"}"#,
        r#"{"id":"top","type":"shape","shape":"rect","w":100,"h":100,"x":100,"y":1700}"#,
    ];
    let before = scene_with(&layers);
    let mut after = before.clone();
    after.apply(&ops(r#"[{"op":"precompose","ids":["dot","card","title"],"component":"intro","id":"intro1"}]"#)).unwrap();
    let ids: Vec<&str> = after.layers.iter().map(|l| l.id.as_str()).collect();
    assert_eq!(ids, ["bg", "intro1", "top"], "one instance where the topmost was");
    let inst = after.layer("intro1").unwrap();
    assert_eq!((inst.start, inst.end), (0.5, None), "spans their range (title lasts to the end)");
    let comp = &after.library.components["intro"];
    assert_eq!(comp.layers[0]["start"], 0.0, "re-based to the earliest start");
    assert_eq!(comp.layers[1]["start"], 0.5);
    assert_eq!(comp.layers[0]["x"][0]["bezier"], serde_json::json!([0.2, 0.8, 0.2, 1.0]), "bezier keys move as they are");
    for t in [0.2, 0.5, 0.7, 1.05, 1.6, 2.4, 2.99, 3.5, 5.9] {
        let (a, b) = (frame_text(&after, t), frame_text(&before, t));
        let at = a.bytes().zip(b.bytes()).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
        assert!(a == b, "frame at {t}s differs at {at}:\nafter  …{}\nbefore …{}", &a[at.saturating_sub(150)..(at + 250).min(a.len())], &b[at.saturating_sub(150)..(at + 250).min(b.len())]);
    }
    // Links across the selection are refused, saying why.
    let mut s = before.clone();
    let err = s.apply(&ops(r#"[{"op":"precompose","ids":["card"],"component":"c2","id":"c2a"}]"#)).unwrap_err();
    assert!(err.1.to_string().contains("parented to 'card'"), "{}", err.1);
    let err = s.apply(&ops(r#"[{"op":"precompose","ids":["title","card"],"component":"c3","id":"c3a"}]"#)).unwrap_err();
    assert!(err.1.to_string().contains("matted by 'title'"), "{}", err.1);
}

#[test]
fn sample_prop_reads_what_the_engine_draws() {
    let s = scene_with(&[
        r#"{"id":"a","type":"shape","shape":"rect","start":1,"w":10,"h":10,
            "x":[{"t":0,"v":0,"ease":"linear"},{"t":1,"v":100,"ease":"hold"},{"t":2,"v":200,"bezier":[0.2,0.8,0.2,1]},{"t":3,"v":300}],
            "y":"T*10","opacity":"b.x(T - 1)","time":"t*2"}"#,
        r#"{"id":"b","type":"shape","shape":"rect","w":10,"h":10,"x":[{"t":0,"v":0,"ease":"linear"},{"t":10,"v":10}]}"#,
    ]);
    let x = s.sample_prop("a", Prop::X, &[1.0, 1.25, 1.75, 2.25]).unwrap();
    assert_eq!(x, vec![0.0, 50.0, 100.0, 200.0 + 100.0 * crate::anim::cubic_bezier([0.2, 0.8, 0.2, 1.0], 0.5)], "remapped clock: t*2");
    assert_eq!(s.sample_prop("a", Prop::Y, &[2.0]).unwrap(), vec![20.0], "T is scene time");
    assert_eq!(s.sample_prop("a", Prop::Opacity, &[3.0]).unwrap(), vec![2.0], "reads other layers");
    assert_eq!(s.sample_prop("a", Prop::Time, &[1.5]).unwrap(), vec![1.0]);
    assert_eq!(s.sample_prop("a", Prop::Scale, &[0.0]).unwrap(), vec![1.0]);
    assert!(s.sample_prop("nope", Prop::X, &[0.0]).is_none());
    assert_eq!(s.prop_values("a", 1.25).unwrap()["x"], 50.0, "property rows agree");
}

#[test]
fn bezier_keys_survive_set_prop_and_patch() {
    let mut s = scene_with(&[r#"{"id":"a","type":"shape","shape":"rect","w":10,"h":10}"#]);
    let keys = r#"[{"t":0,"v":0,"ease":"hold"},{"t":0.5,"v":1,"bezier":[0.33,0,0.67,1]},{"t":1,"v":2}]"#;
    s.apply(&ops(&format!(r#"[{{"op":"set_prop","id":"a","prop":"x","value":{keys}}},{{"op":"patch","id":"a","fields":{{"y":{keys}}}}}]"#))).unwrap();
    let back = Scene::from_json(&s.to_json()).unwrap();
    let l = back.layer("a").unwrap();
    assert_eq!(l.x, l.y);
    let crate::Animated::Keys(k) = &l.x else { panic!("keys") };
    assert_eq!((k[0].ease, k[1].bezier), (crate::Easing::Hold, Some([0.33, 0.0, 0.67, 1.0])));
}

/// AE's fx switch: a switched-off effect stays in the stack (and in the JSON) but does not draw.
#[test]
fn effect_switch_round_trips_and_skips_drawing() {
    let l = layer(r#"{"id":"a","type":"shape","shape":"rect","w":100,"h":100,"effects":[{"fx":"blur","radius":8,"enabled":false},{"fx":"glow","radius":12}]}"#);
    assert_eq!(l.effects.len(), 2);
    assert_eq!(l.live_effects().count(), 1);
    let json = serde_json::to_value(&l).unwrap();
    assert_eq!(json["effects"][0]["enabled"], serde_json::json!(false));
    assert!(json["effects"][1].get("enabled").is_none(), "an effect that is on leaves `enabled` out");
    assert_eq!(json["effects"][0]["fx"], serde_json::json!("blur"));
}
