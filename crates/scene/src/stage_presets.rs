//! Ready-made 3D stages for the scenario bricks, built from the bundled CC0
//! models (Kenney). Characters are left to the agent; these are the sets.

use crate::{Camera3D, CameraKind, ColorRef, PaletteSlot, PropEnter, ScenarioKind, Stage, StageProp};

fn prop(id: &str, model: &str, x: f32, z: f32, rotation: f32) -> StageProp {
    StageProp {
        id: id.to_owned(),
        model: model.to_owned(),
        prefab: None,
        node: None,
        x: x.into(),
        y: 0.0.into(),
        z: z.into(),
        rotation: rotation.into(),
        scale: 1.0.into(),
        action: None,
        tint: None,
        start: 0.0,
        end: None,
        enter: PropEnter::None,
        enter_delay: 0.0,
    }
}

fn on(mut p: StageProp, y: f32) -> StageProp {
    p.y = y.into();
    p
}

fn rise(mut p: StageProp, delay: f32) -> StageProp {
    p.enter = PropEnter::Rise;
    p.enter_delay = delay;
    p
}

/// A row of wall pieces along x at depth z (each piece is 1 m wide, origin at its left edge).
fn back_wall(props: &mut Vec<StageProp>, prefix: &str, from: i32, to: i32, z: f32, windows: &[i32]) {
    for i in from..to {
        let model = if windows.contains(&i) { "furniture/wallWindow" } else { "furniture/wall" };
        props.push(prop(&format!("{prefix}-{i}"), model, i as f32, z, 0.0));
    }
}

/// Left wall along z at x (pieces rotated 90°).
fn side_wall(props: &mut Vec<StageProp>, prefix: &str, from: i32, to: i32, x: f32) {
    for i in from..to {
        props.push(prop(&format!("{prefix}-{i}"), "furniture/wall", x, i as f32 + 1.0, 90.0));
    }
}

fn camera(yaw: f32, pitch: f32, distance: f32, target: [f32; 3]) -> Camera3D {
    Camera3D {
        kind: CameraKind::Perspective,
        yaw: yaw.into(),
        pitch: pitch.into(),
        distance: distance.into(),
        target_x: target[0].into(),
        target_y: target[1].into(),
        target_z: target[2].into(),
        fov: 32.0,
    }
}

pub fn preset(kind: ScenarioKind) -> Stage {
    let floor = Some(ColorRef::Slot(PaletteSlot::Surface));
    let mut props = Vec::new();
    match kind {
        ScenarioKind::EmptyStudio => Stage { camera: camera(20.0, 12.0, 3.2, [0.0, 0.45, 0.0]), props, floor },
        ScenarioKind::ClinicRoom => {
            // Room spans x -2..2, z -2..1. Kenney furniture has its origin at a back corner
            // (geometry along -z), so rotations below are chosen to keep pieces inside the walls.
            back_wall(&mut props, "wall", -2, 2, -2.0, &[-1]);
            side_wall(&mut props, "side", -2, 1, -2.0);
            props.push(prop("rug", "furniture/rugRectangle", -0.6, 0.6, 0.0));
            // Treatment bed (camilla) along the back wall: top at y≈0.45, spans x -0.6..1.3, z -2..-0.4.
            props.push(prop("camilla", "furniture/bedSingle", -0.6, -1.95, -90.0));
            props.push(prop("desk", "furniture/desk", -1.95, 0.0, -90.0));
            props.push(on(prop("screen", "furniture/computerScreen", -1.85, 0.2, -90.0), 0.38));
            props.push(prop("chair", "furniture/chairDesk", -1.3, 0.55, 90.0));
            props.push(prop("bookcase", "furniture/bookcaseOpen", 1.0, -1.55, 0.0));
            props.push(prop("plant", "furniture/pottedPlant", -1.8, -1.7, 0.0));
            props.push(prop("lamp", "furniture/lampRoundFloor", 1.7, 0.4, 0.0));
            Stage { camera: camera(28.0, 24.0, 6.2, [0.0, 0.35, -0.7]), props, floor }
        }
        ScenarioKind::Office => {
            back_wall(&mut props, "wall", -3, 3, -2.5, &[-2, 0, 2]);
            for (i, x) in [-2.2_f32, -0.6, 1.0].into_iter().enumerate() {
                props.push(prop(&format!("desk-{i}"), "furniture/desk", x, -1.4, 0.0));
                props.push(on(prop(&format!("laptop-{i}"), "furniture/laptop", x + 0.25, -1.7, 0.0), 0.38));
                props.push(prop(&format!("chair-{i}"), "furniture/chairDesk", x + 0.15, -1.05, 180.0));
            }
            props.push(prop("sofa", "furniture/loungeSofa", 1.3, 0.8, -90.0));
            props.push(prop("plant-a", "furniture/pottedPlant", -2.8, -2.3, 0.0));
            props.push(prop("plant-b", "furniture/pottedPlant", 2.6, -2.3, 0.0));
            props.push(prop("coffee", "furniture/kitchenCoffeeMachine", 2.2, -2.4, 0.0));
            Stage { camera: camera(25.0, 24.0, 6.5, [0.0, 0.35, -0.7]), props, floor }
        }
        ScenarioKind::IsoCity => {
            const BLOCKS: [&str; 10] = [
                "city-commercial/building-a",
                "city-suburban/building-type-c",
                "city-commercial/building-skyscraper-a",
                "city-suburban/building-type-f",
                "city-commercial/building-d",
                "city-commercial/building-skyscraper-c",
                "city-suburban/building-type-k",
                "city-commercial/building-g",
                "city-suburban/building-type-p",
                "city-commercial/building-skyscraper-e",
            ];
            let mut n = 0;
            for gz in -2..=2 {
                for gx in -2..=2 {
                    if (gx + gz) % 3 == 0 && gx != 0 {
                        continue; // streets
                    }
                    let model = BLOCKS[n % BLOCKS.len()];
                    props.push(rise(prop(&format!("block-{n}"), model, gx as f32 * 1.4, gz as f32 * 1.4, 0.0), (gx + gz + 4) as f32 * 0.08));
                    n += 1;
                }
            }
            let mut cam = camera(45.0, 35.0, 4.2, [0.0, 0.4, 0.0]);
            cam.kind = CameraKind::Isometric;
            Stage { camera: cam, props, floor }
        }
    }
}

/// Keep the user's/agent's own props (characters…) when switching sets.
pub fn merge_preset(kind: ScenarioKind, current: Option<&Stage>) -> Stage {
    let mut stage = preset(kind);
    let set_ids: Vec<String> = current
        .map(|c| c.props.iter().filter(|p| p.model.starts_with("characters/")).cloned().map(|p| p.id).collect())
        .unwrap_or_default();
    if let Some(c) = current {
        stage.props.extend(c.props.iter().filter(|p| set_ids.contains(&p.id)).cloned());
    }
    stage
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_scenario_has_a_set_and_a_camera() {
        for kind in [ScenarioKind::EmptyStudio, ScenarioKind::ClinicRoom, ScenarioKind::Office, ScenarioKind::IsoCity] {
            let s = preset(kind);
            assert!(s.floor.is_some());
            if kind != ScenarioKind::EmptyStudio {
                assert!(s.props.len() > 5, "{kind:?}");
            }
        }
    }
}
