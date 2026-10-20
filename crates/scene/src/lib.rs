//! Scene model shared by the engine, the editor and the agent.
//!
//! The scene is the single source of truth. Nobody edits it directly: the
//! agent (through MCP) and the user (through the editor) both send [`Op`]s,
//! which are validated and applied here. That keeps one code path for every
//! change and makes undo, sync and feedback trivial.

mod anim;
pub mod expr;
pub mod paint;
pub mod path;
mod character;
pub mod component;
mod scenario;
mod stage;
mod stage_presets;
mod layer;
mod library;
mod node3d;
mod ops;
mod style;
mod text;
mod transition;

pub use anim::{Animated, Easing, Keyframe};
pub use layer::{Xform, PathData, AnimRef, Bounds, DrawImage, DrawItem, DrawObject, DrawShape, EvalCtx, ImageFit, Layer, LayerContent, Shape};
pub use library::{AnimProp, AnimTemplate, Library, TemplateKey, TransitionKind, TransitionTemplate};
pub use text::{AudioTrack, Captions, DrawText, TextAlign, TextRole, TextSpan, Typography, Word};
pub use transition::TransitionRef;
pub use character::{draw_character, pose, Action, CharacterKind, CharacterSpec, Hair, Outfit, Pose};
pub use node3d::{DrawModelNode, DrawSolid, Garment, Geometry, HairStyle, Node3D, NodeKind, Repeat, Rig};
pub use stage_presets::{merge_preset, preset as stage_preset};
pub use stage::{Finish, Shot, ShotKind, ShotTarget, Camera3D, CameraKind, DrawCamera, DrawProp, DrawStage, PropEnter, Stage, StageProp};
pub use scenario::{draw_scenario, iso, DrawPoly, Scenario, ScenarioKind};
pub use ops::{Op, OpError, Prop};
pub use style::{RenderKind, RenderStyle, CaptionStyle, ColorRef, CustomPalette, HexColor, Palette, PaletteSlot, Rgba, StylePreset};

use serde::{Deserialize, Serialize};
use std::fmt::Write;

/// Parent chains deeper than this are cut (and cycles end there).
const MAX_PARENT_DEPTH: u8 = 8;

pub const SCENE_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Scene {
    #[serde(default = "scene_version")]
    pub version: u32,
    pub width: u32,
    pub height: u32,
    pub fps: f32,
    /// Seconds.
    pub duration: f32,
    #[serde(default)]
    pub style: StylePreset,
    #[serde(default)]
    pub caption_style: CaptionStyle,
    /// Colors from a palette brick. When set, it wins over `style`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub palette: Option<CustomPalette>,
    #[serde(default)]
    pub layers: Vec<Layer>,
    /// Brick data the engine needs (animations, anchors, transitions). Filled by the editor.
    #[serde(default, skip_serializing_if = "Library::is_empty")]
    pub library: Library,
    /// Font from the typography brick. Missing: the engine's default font.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typography: Option<Typography>,
    /// 3D stage (camera + glTF props) drawn behind every layer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<Stage>,
    /// Backdrop drawn behind every layer (scenario brick).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario: Option<Scenario>,
    /// Finish of the whole frame (render style brick).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub render_style: Option<RenderStyle>,
    /// Placement and trim of the project's audio file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioTrack>,
    /// Timed words, drawn in `caption_style`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub captions: Option<Captions>,
    /// Cuts between scenes, each drawn with a transition brick.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transitions: Vec<TransitionRef>,
    /// Sound effects placed on the timeline (from the user's sound library).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sfx: Vec<SfxCue>,
}

fn scene_version() -> u32 {
    SCENE_VERSION
}

/// One sound effect at a moment of the video. The editor plays and exports it; the engine only keeps it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SfxCue {
    pub id: String,
    /// Library sound name (for people and agents).
    pub sound: String,
    /// Media path of its WAV.
    pub src: String,
    /// Seconds from the start of the video.
    pub at: f32,
    #[serde(default = "unit_gain")]
    pub gain: f32,
}

fn unit_gain() -> f32 {
    1.0
}

impl Default for Scene {
    /// Vertical 9:16, the format most short-form videos ship in.
    fn default() -> Self {
        Scene {
            version: SCENE_VERSION,
            width: 1080,
            height: 1920,
            fps: 30.0,
            duration: 6.0,
            style: StylePreset::default(),
            caption_style: CaptionStyle::default(),
            palette: None,
            layers: Vec::new(),
            library: Library::default(),
            typography: None,
            stage: None,
            scenario: None,
            render_style: None,
            audio: None,
            captions: None,
            transitions: Vec::new(),
            sfx: Vec::new(),
        }
    }
}

impl Scene {
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        let mut value: serde_json::Value = serde_json::from_str(json)?;
        layer::migrate(&mut value);
        serde_json::from_value(value)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("scene always serializes")
    }

    pub fn palette(&self) -> Palette {
        self.palette.map(Palette::from).unwrap_or_else(|| self.style.palette())
    }

    pub fn layer(&self, id: &str) -> Option<&Layer> {
        self.layers.iter().find(|l| l.id == id)
    }

    pub fn layer_mut(&mut self, id: &str) -> Option<&mut Layer> {
        self.layers.iter_mut().find(|l| l.id == id)
    }

    /// Run `f` with expressions able to read other layers (`card.x`, `card.y(T - 0.2)`).
    fn with_refs<R>(&self, f: impl FnOnce() -> R) -> R {
        let resolve = |id: &str, prop: expr::Prop, gt: f32| {
            let Some(l) = self.layer(id) else { return 0.0 };
            let lt = l.local_time(gt);
            let value = match prop {
                expr::Prop::X => &l.x,
                expr::Prop::Y => &l.y,
                expr::Prop::W => &l.w,
                expr::Prop::H => &l.h,
                expr::Prop::Scale => &l.scale,
                expr::Prop::Rotation => &l.rotation,
                expr::Prop::Opacity => &l.opacity,
            };
            expr::with_vars(gt, 0.0, 1.0, || value.sample(lt))
        };
        expr::with_resolver(&resolve, f)
    }

    /// Resolve every visible layer at time `t` (seconds), back to front.
    pub fn frame(&self, t: f32) -> Vec<DrawItem> {
        self.with_refs(|| self.frame_items(t))
    }

    fn frame_items(&self, t: f32) -> Vec<DrawItem> {
        let palette = self.palette();
        let ctx = EvalCtx {
            palette: &palette,
            typography: self.typography.as_ref(),
            library: &self.library,
            scene_size: [self.width as f32, self.height as f32],
        };
        let mut items: Vec<DrawItem> = self.stage.iter().map(|s| DrawItem::Stage(s.draw(t, &palette, &self.library.prefabs))).collect();
        items.extend(self
            .scenario
            .filter(|_| self.stage.is_none())
            .map(|s| draw_scenario(&s, ctx.scene_size, t, &palette))
            .unwrap_or_default());
        expr::set_scene_time(t);
        let owners = self.owners_3d();
        let center = [self.width as f32 / 2.0, self.height as f32 / 2.0];
        let camera = self.camera_view(t, &ctx);
        let view = camera.map_or(paint::View { look: center, dolly: 0.0, focal: paint::DEFAULT_PERSPECTIVE, screen: center }, |c| c.0);
        // Each top-level layer's items with its depth (sorted far to near when there is a camera).
        let mut layered: Vec<(f32, Vec<DrawItem>)> = Vec::new();
        for (idx, l) in self.layers.iter().enumerate() {
            // Layers inside a 3D layer are drawn (flat) into it, then projected with it.
            if owners[idx].is_some() || !self.active(l, t) || l.camera.is_some() {
                continue;
            }
            let is_3d = l.is_3d();
            if !l.visible && !is_3d {
                continue;
            }
            let lt = l.local_time(t);
            let z = self.depth(l, t);
            if is_3d {
                let out = self.tilted_items(l, idx, &owners, t, z, &ctx, camera);
                if !out.is_empty() {
                    layered.push((z, out));
                }
                continue;
            }
            let mut drawn = if l.visible { self.layer_items(l, t, &ctx) } else { Vec::new() };
            if drawn.is_empty() {
                continue;
            }
            // Flat layers in a world (or pushed in depth) are scaled toward the camera axis.
            let flat_scale = if (camera.is_some() && !l.fixed) || z != 0.0 {
                match view.scale_at(z) {
                    Some(k) => Some(k),
                    None => continue,
                }
            } else {
                None
            };
            let defocus = camera
                .filter(|_| !l.fixed)
                .and_then(|c| c.1)
                .map(|(focus, aperture)| aperture * (z - focus).abs() / 1000.0 * flat_scale.unwrap_or(1.0))
                .filter(|b| *b > 0.5);
            let needs_fx = !l.effects.is_empty() || l.blend != paint::BlendMode::Normal || l.matte.is_some() || l.adjustment || defocus.is_some();
            let mut out = Vec::new();
            if let Some(glass) = self.backdrop_pass(l, t, &drawn, None) {
                out.push(glass);
            }
            if needs_fx {
                let matte = l.matte.as_ref().and_then(|m| {
                    let src = self.layers.iter().find(|x| x.id == m.layer)?;
                    Some((if self.active(src, t) { self.layer_items(src, t, &ctx) } else { Vec::new() }, m.mode))
                });
                let samples = self.motion_samples(l, t, &ctx);
                let mut effects: Vec<paint::DrawEffect> = l.effects.iter().filter_map(|e| e.resolve(lt, &palette)).collect();
                if let Some(radius) = defocus {
                    // Depth of field: blur in flat space, so undo the zoom the affine applies after.
                    effects.insert(0, paint::DrawEffect::Blur { radius: radius / flat_scale.unwrap_or(1.0) });
                }
                let fx = if l.adjustment {
                    // The layer's own shape bounds the adjustment.
                    paint::DrawFx { items: Vec::new(), effects, blend: l.blend, matte: Some((std::mem::take(&mut drawn), paint::MatteMode::Alpha)), samples: Vec::new(), adjust: true, perspective: None }
                } else {
                    paint::DrawFx { items: std::mem::take(&mut drawn), effects, blend: l.blend, matte, samples, adjust: false, perspective: None }
                };
                out.push(DrawItem::Fx(Box::new(fx)));
            } else {
                out.append(&mut drawn);
            }
            if let Some(k) = flat_scale {
                let shift = [view.screen[0] - view.look[0], view.screen[1] - view.look[1]];
                out.iter_mut().for_each(|item| item.affine(view.look, k, shift));
            }
            layered.push((z, out));
        }
        if camera.is_some() {
            // Painter's order by depth (stable: equal depths keep the layer order).
            layered.sort_by(|a, b| b.0.total_cmp(&a.0));
        }
        items.extend(layered.into_iter().flat_map(|(_, i)| i));
        items.extend(text::caption_frame(self, &palette, t).map(DrawItem::Text));
        transition::apply(self, &palette, t, &mut items);
        items
    }

    /// The layer at the other instants of its motion-blur shutter (none without the effect).
    fn motion_samples(&self, l: &Layer, t: f32, ctx: &EvalCtx) -> Vec<Vec<DrawItem>> {
        let Some((shutter, samples)) = l.effects.iter().find_map(|e| match e {
            paint::Effect::MotionBlur { shutter, samples } => Some((*shutter, *samples)),
            _ => None,
        }) else {
            return Vec::new();
        };
        let n = samples.clamp(2, paint::MAX_BLUR_SAMPLES);
        let open = shutter.clamp(0.0, 720.0) / 360.0 / self.fps.max(1.0);
        // `t` itself is the main sample; the others spread back over the shutter.
        let out = (1..n)
            .map(|k| {
                let tk = t - open * k as f32 / (n - 1) as f32;
                expr::set_scene_time(tk);
                self.layer_items(l, tk, ctx)
            })
            .collect();
        expr::set_scene_time(t);
        out
    }

    /// A tilted layer and the layers parented to it, projected in perspective. Runs of plain
    /// layers share one offscreen pass; a layer with effects, a blend mode or a matte gets its
    /// own (same projection), so card shadows and glows survive on a tilted page.
    #[allow(clippy::too_many_arguments)]
    fn tilted_items(&self, l: &Layer, idx: usize, owners: &[Option<usize>], t: f32, z: f32, ctx: &EvalCtx, camera: Option<(paint::View, Option<(f32, f32)>)>) -> Vec<DrawItem> {
        let lt = l.local_time(t);
        let c = l.world(lt, ctx, &self.parent_xform(l, t, ctx, 0)).origin;
        let lens = camera.map_or(paint::View { look: c, dolly: 0.0, focal: l.perspective.unwrap_or(paint::DEFAULT_PERSPECTIVE), screen: c }, |cam| cam.0);
        let Some(perspective) = paint::perspective_inverse(c, l.rotate_x.sample(lt), l.rotate_y.sample(lt), z, &lens) else { return Vec::new() };
        let defocus = camera.and_then(|cam| cam.1).map(|(focus, aperture)| aperture * (z - focus).abs() / 1000.0).filter(|b| *b > 0.5);
        let base_effects = || defocus.map(|radius| vec![paint::DrawEffect::Blur { radius }]).unwrap_or_default();
        let pass = |items: Vec<DrawItem>, effects: Vec<paint::DrawEffect>, blend: paint::BlendMode, matte| {
            DrawItem::Fx(Box::new(paint::DrawFx { items, effects, blend, matte, samples: Vec::new(), adjust: false, perspective: Some(perspective) }))
        };
        let mut out = Vec::new();
        let mut batch: Vec<DrawItem> = Vec::new();
        let members = std::iter::once(idx).chain((0..self.layers.len()).filter(|j| owners[*j] == Some(idx)));
        for j in members {
            let m = &self.layers[j];
            if !m.visible || !self.active(m, t) {
                continue;
            }
            let drawn = self.layer_items(m, t, ctx);
            if drawn.is_empty() {
                continue;
            }
            let glass = self.backdrop_pass(m, t, &drawn, Some(perspective));
            let own_pass = !m.effects.is_empty() || m.blend != paint::BlendMode::Normal || m.matte.is_some() || glass.is_some();
            if !own_pass {
                batch.extend(drawn);
                continue;
            }
            if !batch.is_empty() {
                out.push(pass(std::mem::take(&mut batch), base_effects(), paint::BlendMode::Normal, None));
            }
            out.extend(glass);
            let mlt = m.local_time(t);
            let mut effects = base_effects();
            effects.extend(m.effects.iter().filter_map(|e| e.resolve(mlt, ctx.palette)));
            let matte = m.matte.as_ref().and_then(|mt| {
                let src = self.layers.iter().find(|x| x.id == mt.layer)?;
                Some((if self.active(src, t) { self.layer_items(src, t, ctx) } else { Vec::new() }, mt.mode))
            });
            out.push(pass(drawn, effects, m.blend, matte));
        }
        if !batch.is_empty() {
            out.push(pass(batch, base_effects(), paint::BlendMode::Normal, None));
        }
        out
    }

    /// Frosted glass: an adjustment pass blurring what is already drawn, inside the layer's shape.
    fn backdrop_pass(&self, l: &Layer, t: f32, drawn: &[DrawItem], perspective: Option<[f32; 9]>) -> Option<DrawItem> {
        let radius = l.backdrop.sample(l.local_time(t));
        (radius > 0.5 && !drawn.is_empty()).then(|| {
            DrawItem::Fx(Box::new(paint::DrawFx {
                items: Vec::new(),
                effects: vec![paint::DrawEffect::Blur { radius }],
                blend: paint::BlendMode::Normal,
                matte: Some((drawn.to_vec(), paint::MatteMode::Alpha)),
                samples: Vec::new(),
                adjust: true,
                perspective,
            }))
        })
    }

    /// The camera layer's view at `t` and its depth of field (focus depth, aperture), if any.
    fn camera_view(&self, t: f32, ctx: &EvalCtx) -> Option<(paint::View, Option<(f32, f32)>)> {
        let cam = self.layers.iter().find(|l| l.camera.is_some() && self.active(l, t))?;
        let lens = cam.camera.as_ref()?;
        let lt = cam.local_time(t);
        let look = cam.world(lt, ctx, &self.parent_xform(cam, t, ctx, 0)).origin;
        let screen = [self.width as f32 / 2.0, self.height as f32 / 2.0];
        let focal = lens.focal * cam.scale.sample(lt).max(0.01);
        let aperture = lens.aperture.sample(lt);
        let dof = (aperture > 0.0).then(|| (lens.focus.sample(lt), aperture));
        Some((paint::View { look, dolly: cam.z.sample(lt), focal, screen }, dof))
    }

    /// Depth of a layer: its `z` plus its parents'.
    fn depth(&self, l: &Layer, t: f32) -> f32 {
        let mut z = l.z.sample(l.local_time(t));
        let mut cur = l;
        for _ in 0..MAX_PARENT_DEPTH {
            let Some(p) = cur.parent.as_ref().and_then(|pid| self.layer(pid)) else { break };
            if p.id == l.id {
                break;
            }
            z += p.z.sample(p.local_time(t));
            cur = p;
        }
        z
    }

    /// For every layer, the index of the nearest 3D layer up its parent chain (not itself).
    fn owners_3d(&self) -> Vec<Option<usize>> {
        self.layers
            .iter()
            .map(|l| {
                let mut cur = l;
                for _ in 0..=MAX_PARENT_DEPTH {
                    let pid = cur.parent.as_ref()?;
                    let (i, p) = self.layers.iter().enumerate().find(|(_, x)| &x.id == pid)?;
                    if p.id == l.id {
                        return None;
                    }
                    if p.is_3d() {
                        return Some(i);
                    }
                    cur = p;
                }
                None
            })
            .collect()
    }

    fn active(&self, l: &Layer, t: f32) -> bool {
        t >= l.start && t < l.end.unwrap_or(self.duration)
    }

    /// World transform a layer's `parent` chain gives it at scene time `t`.
    fn parent_xform(&self, l: &Layer, t: f32, ctx: &EvalCtx, depth: u8) -> Xform {
        let Some(pid) = &l.parent else { return Xform::default() };
        let Some(p) = self.layers.iter().find(|x| &x.id == pid) else { return Xform::default() };
        if depth > MAX_PARENT_DEPTH || p.id == l.id {
            return Xform::default();
        }
        let up = self.parent_xform(p, t, ctx, depth + 1);
        p.world(p.local_time(t), ctx, &up)
    }

    /// One layer's draw items at scene time `t`: all its repeater copies, inside its parent chain.
    fn layer_items(&self, l: &Layer, t: f32, ctx: &EvalCtx) -> Vec<DrawItem> {
        self.copies(l, t, l.local_time(t), &self.parent_xform(l, t, ctx, 0), ctx, 0)
    }

    /// Every repeater copy of `l` at layer time `lt` inside `base`. `gt` is the clock `T` reads
    /// (the component clock inside an instance) and `depth` how deep in instances `l` sits.
    fn copies(&self, l: &Layer, gt: f32, lt: f32, base: &Xform, ctx: &EvalCtx, depth: u8) -> Vec<DrawItem> {
        let Some(rep) = &l.repeat else {
            return expr::with_vars(gt, 0.0, 1.0, || self.draw_one(l, lt, ctx, base, depth));
        };
        let n = rep.count.min(paint::MAX_REPEAT);
        (0..n)
            .flat_map(|i| {
                let lt_i = lt - rep.delay * i as f32;
                if lt_i < 0.0 {
                    return Vec::new();
                }
                let (col, row) = rep.columns.filter(|c| *c > 0).map_or((i as f32, i as f32), |c| ((i % c) as f32, (i / c) as f32));
                let offset = if rep.columns.is_some() { [col * rep.x, row * rep.y] } else { [i as f32 * rep.x, i as f32 * rep.y] };
                let xf = Xform {
                    offset,
                    spin: (rep.rotation * i as f32).to_radians(),
                    grow: rep.scale.powi(i as i32),
                    opacity: base.opacity * rep.opacity.powi(i as i32),
                    ..*base
                };
                expr::with_vars(gt, i as f32, n as f32, || self.draw_one(l, lt_i, ctx, &xf, depth))
            })
            .collect()
    }

    /// Id of the top-most layer under scene point `(x, y)` at time `t`, for click-to-select.
    pub fn pick(&self, t: f32, x: f32, y: f32) -> Option<String> {
        self.with_refs(|| self.pick_at(t, x, y))
    }

    fn pick_at(&self, t: f32, x: f32, y: f32) -> Option<String> {
        self.measuring(t, |m| {
            let mut best: Option<(f32, &Layer)> = None;
            for (idx, l) in self.layers.iter().enumerate().rev().filter(|(_, l)| l.camera.is_none()) {
                let Some((b, map)) = self.screen_bounds(idx, t, m) else { continue };
                // An instance is hit on its layers, not on the gaps of its union box.
                if !b.contains([x, y]) || !self.instance_hit(l, t, m.ctx, &map, [x, y]) {
                    continue;
                }
                // Without a camera the top-most layer wins; with one, the nearest (depth order).
                let z = if m.camera.is_some() { self.depth(l, t) } else { 0.0 };
                if best.is_none_or(|(bz, _)| z < bz) {
                    best = Some((z, l));
                }
            }
            best.map(|(_, l)| l.id.clone())
        })
    }

    /// Evaluation context, 3D owners and camera at scene time `t`, for measuring layers.
    fn measuring<R>(&self, t: f32, f: impl FnOnce(&Measure) -> R) -> R {
        let palette = self.palette();
        let ctx = EvalCtx {
            palette: &palette,
            typography: self.typography.as_ref(),
            library: &self.library,
            scene_size: [self.width as f32, self.height as f32],
        };
        self.with_refs(|| {
            expr::with_vars(t, 0.0, 1.0, || {
                let camera = self.camera_view(t, &ctx).map(|c| c.0);
                f(&Measure { ctx: &ctx, owners: self.owners_3d(), camera })
            })
        })
    }

    /// How layer `idx` lands on the screen at `t`: as drawn, scaled by its depth toward the
    /// camera, or projected by the tilted layer that owns it. `None` when it is behind the camera.
    fn screen_map(&self, idx: usize, t: f32, m: &Measure) -> Option<ScreenMap> {
        let l = &self.layers[idx];
        let plane = m.owners[idx].map(|i| &self.layers[i]).or(l.is_3d().then_some(l));
        if let Some(p) = plane {
            let lt = p.local_time(t);
            let c = p.world(lt, m.ctx, &self.parent_xform(p, t, m.ctx, 0)).origin;
            let z = self.depth(p, t);
            let lens = m.camera.unwrap_or(paint::View { look: c, dolly: 0.0, focal: p.perspective.unwrap_or(paint::DEFAULT_PERSPECTIVE), screen: c });
            lens.scale_at(z)?;
            return Some(ScreenMap::Plane(paint::perspective_forward(c, p.rotate_x.sample(lt), p.rotate_y.sample(lt), z, &lens)));
        }
        let z = self.depth(l, t);
        if (m.camera.is_none() || l.fixed) && z == 0.0 {
            return Some(ScreenMap::Flat);
        }
        let center = [self.width as f32 / 2.0, self.height as f32 / 2.0];
        let view = m.camera.unwrap_or(paint::View { look: center, dolly: 0.0, focal: paint::DEFAULT_PERSPECTIVE, screen: center });
        Some(ScreenMap::Depth { look: view.look, screen: view.screen, k: view.scale_at(z)? })
    }

    /// Box of layer `idx` on screen at `t`, with the map that put it there.
    fn screen_bounds(&self, idx: usize, t: f32, m: &Measure) -> Option<(Bounds, ScreenMap)> {
        let l = &self.layers[idx];
        if !self.active(l, t) {
            return None;
        }
        let flat = self.flat_bounds(l, t, m.ctx)?;
        let map = self.screen_map(idx, t, m)?;
        Some((map.bounds(&flat)?, map))
    }

    /// A rect `[x0, y0, x1, y1]` drawn by layer `id` (flat scene px) as it lands on screen at `t`.
    pub fn rect_to_screen(&self, id: &str, t: f32, r: [f32; 4]) -> Option<[f32; 4]> {
        // A layer inside an instance lands where its instance's screen map puts it.
        let idx = self.layers.iter().position(|l| l.id == component::top_id(id))?;
        self.measuring(t, |m| {
            let flat = Bounds { center: [(r[0] + r[2]) / 2.0, (r[1] + r[3]) / 2.0], size: [r[2] - r[0], r[3] - r[1]], rotation: 0.0 };
            Some(self.screen_map(idx, t, m)?.bounds(&flat)?.rect())
        })
    }

    /// Where every active layer lands on screen at `t`: what an agent checks instead of
    /// rendering test frames.
    pub fn layout(&self, t: f32) -> Layout {
        self.measuring(t, |m| {
            let mut out = Layout { camera: m.camera.map(|v| LayoutCamera { look: v.look, dolly: v.dolly, focal: v.focal }), layers: Vec::new(), behind: Vec::new() };
            for (idx, l) in self.layers.iter().enumerate() {
                if l.camera.is_some() || !self.active(l, t) {
                    continue;
                }
                let Some((b, map)) = self.screen_bounds(idx, t, m) else {
                    if self.screen_map(idx, t, m).is_none() {
                        out.behind.push(l.id.clone());
                    }
                    continue;
                };
                let plane = m.owners[idx].map(|i| self.layers[i].id.clone()).or(l.is_3d().then(|| l.id.clone()));
                let z = self.depth(l, t);
                out.layers.push(LayoutRow { id: l.id.clone(), group: l.group.clone(), screen: b.rect(), k: map.scale_at(b.center), z, visible: l.visible, plane: plane.clone() });
                out.layers.extend(self.inner_rows(idx, t, m.ctx, &map, z, &plane));
            }
            out
        })
    }

    /// One layer's draw items at time `t` (for measuring what it really draws), empty when hidden.
    pub fn layer_items_at(&self, id: &str, t: f32) -> Vec<DrawItem> {
        if id.contains(component::PATH_SEP) {
            return self.inner_items_at(id, t);
        }
        let Some(l) = self.layer(id).filter(|l| self.active(l, t)) else { return Vec::new() };
        let palette = self.palette();
        let ctx = EvalCtx {
            palette: &palette,
            typography: self.typography.as_ref(),
            library: &self.library,
            scene_size: [self.width as f32, self.height as f32],
        };
        self.with_refs(|| {
            expr::set_scene_time(t);
            self.layer_items(l, t, &ctx)
        })
    }

    /// On-screen box of a layer at time `t`, after the camera and any tilted parent (selection
    /// outline, review checks). `None` when it is not on at `t` or behind the camera.
    pub fn layer_bounds(&self, id: &str, t: f32) -> Option<Bounds> {
        if id.contains(component::PATH_SEP) {
            return self.inner_bounds(id, t);
        }
        let idx = self.layers.iter().position(|l| l.id == id)?;
        self.measuring(t, |m| self.screen_bounds(idx, t, m).map(|(b, _)| b))
    }

    /// Image sources the layers use (for the host to load).
    pub fn image_sources(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .layers
            .iter()
            .filter_map(|l| match &l.content {
                LayerContent::Image { src, .. } => Some(src.clone()),
                _ => None,
            })
            .collect();
        self.inner_images(&mut v);
        v.sort();
        v.dedup();
        v
    }

    /// One layer as JSON, for agents that only need to touch that object.
    pub fn layer_json(&self, id: &str) -> Option<String> {
        self.layer(id).map(|l| serde_json::to_string(l).expect("layer always serializes"))
    }

    /// Compact, token-cheap description for agents. One line per layer.
    pub fn summary(&self) -> String {
        let mut s = format!(
            "{}x{} {}fps {}s palette={} captions={} layers={} sfx={}\n",
            self.width,
            self.height,
            self.fps,
            self.duration,
            if self.palette.is_some() { "brick".to_owned() } else { enum_name(&self.style) },
            enum_name(&self.caption_style),
            self.layers.len(),
            self.sfx.iter().map(|c| format!("{}@{:.2}", c.sound, c.at)).collect::<Vec<_>>().join(",")
        );
        for l in &self.layers {
            let end = l.end.unwrap_or(self.duration);
            let animated: Vec<&str> = [
                ("x", &l.x),
                ("y", &l.y),
                ("w", &l.w),
                ("h", &l.h),
                ("scale", &l.scale),
                ("rotation", &l.rotation),
                ("opacity", &l.opacity),
                ("radius", &l.radius),
            ]
            .into_iter()
            .filter(|(_, a)| matches!(a, Animated::Keys(_)))
            .map(|(n, _)| n)
            .collect();
            let uses: Vec<String> = l.anims.iter().map(|a| format!("{}@{}", a.key.trim_start_matches("animation/"), a.at)).collect();
            let anchor = l.anchor.as_ref().map(|a| format!(" anchor={a}")).unwrap_or_default()
                + &l.group.as_ref().map(|g| format!(" group={g}")).unwrap_or_default();
            let _ = writeln!(
                s,
                "- {} {} {:.2}-{:.2}s at ({:.0},{:.0}){} {:.0}x{:.0} fill={} keys=[{}] uses=[{}]",
                l.id,
                l.content.kind_name(),
                l.start,
                end,
                l.x.sample(0.0),
                l.y.sample(0.0),
                anchor,
                l.w.sample(0.0),
                l.h.sample(0.0),
                serde_json::to_string(&l.fill).unwrap_or_default().trim_matches('"'),
                animated.join(","),
                uses.join(",")
            );
        }
        if let Some(st) = &self.stage {
            let props: Vec<String> = st
                .props
                .iter()
                .map(|p| {
                    let what = p.prefab.clone().map(|n| format!("prefab:{n}")).unwrap_or_else(|| if p.node.is_some() { "node".into() } else { p.model.clone() });
                    format!("{}={}{}", p.id, what, p.action.as_ref().map(|a| format!(":{a}")).unwrap_or_default())
                })
                .collect();
            let _ = writeln!(s, "stage: camera={} props=[{}]", enum_name(&st.camera.kind), props.join(", "));
            for sh in &st.shots {
                let _ = writeln!(s, "shot {:.1}-{:.1}s {} -> {}", sh.start, sh.end, enum_name(&sh.kind), serde_json::to_string(&sh.target).unwrap_or_default());
            }
        }
        if let Some(sc) = &self.scenario {
            let _ = writeln!(s, "scenario: {}", enum_name(&sc.kind));
        }
        if let Some(r) = &self.render_style {
            let _ = writeln!(s, "finish: {} x{}", enum_name(&r.kind), r.amount);
        }
        if let Some(a) = &self.audio {
            let out = a.trim_out.map(|o| format!("{o:.2}")).unwrap_or_else(|| "end".into());
            let _ = writeln!(s, "audio: plays from {:.2}s, file {:.2}-{}", a.start, a.trim_in, out);
        }
        if let Some(c) = &self.captions {
            let shown: Vec<&str> = c.words.iter().take(12).map(|w| w.text.as_str()).collect();
            let _ = writeln!(s, "captions: {} words \"{}…\" style={}", c.words.len(), shown.join(" "), enum_name(&self.caption_style));
        }
        for tr in &self.transitions {
            let _ = writeln!(s, "cut @{:.2}s {} {:.2}s", tr.at, tr.key.trim_start_matches("transition/"), tr.duration);
        }
        if !self.library.is_empty() {
            let _ = writeln!(
                s,
                "library: {} animations, {} transitions, anchors=[{}]",
                self.library.animations.len(),
                self.library.transitions.len(),
                self.library.anchors.keys().cloned().collect::<Vec<_>>().join(",")
            );
        }
        s.push_str(&component::summary_lines(&self.library));
        s
    }
}

pub(crate) fn enum_name<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_default().trim_matches('"').to_owned()
}

/// What measuring layers at one instant needs.
struct Measure<'a> {
    ctx: &'a EvalCtx<'a>,
    owners: Vec<Option<usize>>,
    camera: Option<paint::View>,
}

/// How a layer's flat scene coordinates land on the screen at one instant.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ScreenMap {
    /// Drawn where it is.
    Flat,
    /// Pulled toward the camera axis by its depth: `screen + (p - look) * k`.
    Depth { look: [f32; 2], screen: [f32; 2], k: f32 },
    /// Projected with a tilted (rx/ry) layer: forward homography rows.
    Plane([[f32; 3]; 3]),
}

impl ScreenMap {
    /// Screen point of a flat point (`None` behind the camera).
    pub fn point(&self, p: [f32; 2]) -> Option<[f32; 2]> {
        match self {
            Self::Flat => Some(p),
            Self::Depth { look, screen, k } => Some([screen[0] + (p[0] - look[0]) * k, screen[1] + (p[1] - look[1]) * k]),
            Self::Plane(h) => {
                let w = h[2][0] * p[0] + h[2][1] * p[1] + h[2][2];
                (w > 1e-3).then(|| [(h[0][0] * p[0] + h[0][1] * p[1] + h[0][2]) / w, (h[1][0] * p[0] + h[1][1] * p[1] + h[1][2]) / w])
            }
        }
    }

    /// A flat box on screen: exact for flat and depth maps, the enclosing box on a tilted plane.
    pub fn bounds(&self, b: &Bounds) -> Option<Bounds> {
        match self {
            Self::Flat => Some(*b),
            Self::Depth { k, .. } => Some(Bounds { center: self.point(b.center)?, size: [b.size[0] * k, b.size[1] * k], rotation: b.rotation }),
            Self::Plane(_) => {
                let mut corners = Vec::with_capacity(4);
                for p in b.corners() {
                    corners.push(self.point(p)?);
                }
                Some(Bounds::enclosing(&corners))
            }
        }
    }

    /// Screen pixels per flat pixel around `p` (1 = drawn at its own size).
    pub fn scale_at(&self, p: [f32; 2]) -> f32 {
        match self {
            Self::Flat => 1.0,
            Self::Depth { k, .. } => *k,
            Self::Plane(_) => {
                let (Some(a), Some(bx), Some(by)) = (self.point(p), self.point([p[0] + 1.0, p[1]]), self.point([p[0], p[1] + 1.0])) else { return 0.0 };
                ((bx[0] - a[0]) * (by[1] - a[1]) - (bx[1] - a[1]) * (by[0] - a[0])).abs().sqrt()
            }
        }
    }
}

/// Where the layers land on screen at one instant (`Scene::layout`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Layout {
    pub camera: Option<LayoutCamera>,
    pub layers: Vec<LayoutRow>,
    /// Active layers the camera has already passed (not drawn).
    pub behind: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct LayoutCamera {
    pub look: [f32; 2],
    pub dolly: f32,
    /// Focal length after the camera layer's scale (zoom).
    pub focal: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LayoutRow {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// `[x0, y0, x1, y1]` on screen (enclosing box when rotated or tilted).
    pub screen: [f32; 4],
    /// Screen scale from depth and perspective (1 = its own size).
    pub k: f32,
    /// Depth with its parents' (layers inside a tilted plane follow the plane).
    pub z: f32,
    pub visible: bool,
    /// The tilted layer that projects it (its own id when it is the plane).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plane: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEMO: &str = include_str!("../../../examples/demo.scene.json");

    #[test]
    fn demo_scene_parses_and_renders() {
        let scene = Scene::from_json(DEMO).unwrap();
        assert!(!scene.frame(1.0).is_empty());
        assert!(scene.summary().contains("palette="));
    }

    #[test]
    fn old_layers_without_type_still_load() {
        let scene = Scene::from_json(r#"{"width":10,"height":10,"fps":30,"duration":1,
            "layers":[{"id":"a","shape":"ellipse","x":0,"y":0,"w":4,"h":4}]}"#)
        .unwrap();
        assert_eq!(scene.layers[0].content, LayerContent::Shape { shape: Shape::Ellipse });
    }

    #[test]
    fn sfx_cues_replace_by_id_and_stay_sorted() {
        let mut scene = Scene::default();
        let cue = |id: &str, at: f32| Op::PutSfx { cue: SfxCue { id: id.into(), sound: "pop".into(), src: "/media/x.wav".into(), at, gain: 1.0 } };
        scene.apply(&[cue("a", 2.0), cue("b", 1.0), cue("a", 0.5)]).unwrap();
        assert_eq!(scene.sfx.iter().map(|c| (c.id.as_str(), c.at)).collect::<Vec<_>>(), [("a", 0.5), ("b", 1.0)]);
        assert!(scene.summary().contains("sfx=pop@0.50,pop@1.00"));
    }

    #[test]
    fn layers_outside_their_range_are_hidden() {
        let mut scene = Scene::default();
        scene.layers.push(serde_json::from_str(r#"{"id":"a","type":"shape","shape":"rect","start":1,"end":2,"w":10,"h":10}"#).unwrap());
        assert!(scene.frame(0.5).is_empty());
        assert_eq!(scene.frame(1.5).len(), 1);
        assert!(scene.frame(2.0).is_empty());
    }

    fn shape_at(layer: &str, t: f32) -> DrawShape {
        let mut scene = Scene::default();
        scene.layers.push(serde_json::from_str(layer).unwrap());
        match scene.frame(t).into_iter().next() {
            Some(DrawItem::Shape(s)) => s,
            other => panic!("expected a shape, got {other:?}"),
        }
    }

    #[test]
    fn colors_animate_between_keys() {
        let layer = r##"{"id":"a","type":"shape","shape":"rect","w":10,"h":10,"fill":[{"t":0,"c":"#000000","ease":"linear"},{"t":1,"c":"#ffffff"}]}"##;
        let mid = shape_at(layer, 0.5).color.0;
        assert!((mid[0] - 0.5).abs() < 0.01, "{mid:?}");
        assert_eq!(shape_at(layer, 2.0).color.0[0], 1.0);
    }

    #[test]
    fn layers_follow_motion_paths() {
        let layer = r#"{"id":"a","type":"shape","shape":"rect","w":10,"h":10,"y":5,
            "motion_path":{"d":"M0 0 L100 0 L100 100","progress":0.75,"orient":true}}"#;
        let s = shape_at(layer, 0.0);
        assert!((s.center[0] - 100.0).abs() < 1e-3 && (s.center[1] - 55.0).abs() < 1e-3, "{:?}", s.center);
        assert!((s.rotation - std::f32::consts::FRAC_PI_2).abs() < 1e-3);
    }

    #[test]
    fn time_remap_loops_and_slows_layers() {
        let layer = r#"{"id":"a","type":"shape","shape":"rect","w":10,"h":10,"time":"mod(t, 1)",
            "x":[{"t":0,"v":0,"ease":"linear"},{"t":1,"v":100}]}"#;
        assert!((shape_at(layer, 1.25).center[0] - 25.0).abs() < 1e-3);
    }

    #[test]
    fn motion_blur_samples_the_shutter() {
        let mut scene = Scene::default();
        scene.layers.push(serde_json::from_str(r#"{"id":"a","type":"shape","shape":"rect","w":10,"h":10,
            "x":[{"t":0,"v":0,"ease":"linear"},{"t":1,"v":300}],"effects":[{"fx":"motion_blur","samples":4}]}"#).unwrap());
        let Some(DrawItem::Fx(fx)) = scene.frame(0.5).into_iter().next() else { panic!("expected an offscreen layer") };
        assert_eq!(fx.samples.len(), 3);
        assert!(fx.effects.is_empty());
        let Some(DrawItem::Shape(last)) = fx.samples[2].first() else { panic!() };
        // 180° at 30 fps: the shutter opened 1/60 s earlier.
        assert!((last.center[0] - (150.0 - 300.0 / 60.0)).abs() < 1e-3, "{:?}", last.center);
    }

    #[test]
    fn expressions_read_other_layers() {
        let mut scene = Scene::default();
        scene.layers.push(serde_json::from_str(r#"{"id":"lead","type":"shape","shape":"rect","w":10,"h":10,"x":[{"t":0,"v":0,"ease":"linear"},{"t":1,"v":100}]}"#).unwrap());
        scene.layers.push(serde_json::from_str(r#"{"id":"tail","type":"shape","shape":"rect","w":10,"h":10,"x":"lead.x(T - 0.5) + 5","y":"tail.y"}"#).unwrap());
        let items = scene.frame(0.75);
        let Some(DrawItem::Shape(tail)) = items.get(1) else { panic!() };
        assert!((tail.center[0] - 30.0).abs() < 1e-3, "{:?}", tail.center);
        // A self reference ends at the depth limit instead of recursing forever.
        assert_eq!(tail.center[1], 0.0);
    }

    #[test]
    fn three_d_layers_project_their_children() {
        let mut scene = Scene::default();
        for l in [
            r#"{"id":"plane","type":"shape","shape":"rect","x":960,"y":540,"w":1,"h":1,"visible":false,"rotate_x":45}"#,
            r#"{"id":"card","type":"shape","shape":"rect","x":0,"y":0,"w":100,"h":100,"parent":"plane"}"#,
            r#"{"id":"flat","type":"shape","shape":"rect","x":10,"y":10,"w":10,"h":10}"#,
        ] {
            scene.layers.push(serde_json::from_str(l).unwrap());
        }
        let items = scene.frame(0.0);
        assert_eq!(items.len(), 2, "{items:?}");
        let DrawItem::Fx(fx) = &items[0] else { panic!("the 3D layer is drawn offscreen") };
        assert_eq!(fx.items.len(), 1);
        assert!(fx.perspective.is_some());
        assert!(matches!(items[1], DrawItem::Shape(_)));
    }

    #[test]
    fn the_camera_gives_parallax_and_depth_order() {
        let mut scene = Scene::default();
        scene.width = 1000;
        scene.height = 1000;
        for l in [
            r#"{"id":"near","type":"shape","shape":"rect","x":500,"y":500,"w":100,"h":100}"#,
            r#"{"id":"far","type":"shape","shape":"rect","x":500,"y":500,"w":100,"h":100,"z":1800}"#,
            r#"{"id":"cam","type":"shape","shape":"rect","x":600,"y":500,"w":1,"h":1,"visible":false,"camera":{"focal":1800}}"#,
        ] {
            scene.layers.push(serde_json::from_str(l).unwrap());
        }
        let items = scene.frame(0.0);
        let shapes: Vec<&DrawShape> = items.iter().filter_map(|i| if let DrawItem::Shape(s) = i { Some(s) } else { None }).collect();
        assert_eq!(shapes.len(), 2);
        // Far first (painter's order), half size, and it moves half as much as the near one.
        assert!((shapes[0].size[0] - 50.0).abs() < 1e-3);
        assert!((shapes[0].center[0] - 450.0).abs() < 1e-3, "{:?}", shapes[0].center);
        assert!((shapes[1].center[0] - 400.0).abs() < 1e-3, "{:?}", shapes[1].center);
    }

    #[test]
    fn bounds_pick_and_layout_measure_what_the_camera_shows() {
        let mut scene = Scene::default();
        scene.width = 1000;
        scene.height = 1000;
        for l in [
            r#"{"id":"far","type":"shape","shape":"rect","x":500,"y":500,"w":100,"h":100,"z":1800}"#,
            r#"{"id":"gone","type":"shape","shape":"rect","x":500,"y":500,"w":100,"h":100,"z":-2000}"#,
            r#"{"id":"plane","type":"shape","shape":"rect","x":500,"y":800,"w":1,"h":1,"visible":false,"rotate_x":60}"#,
            r#"{"id":"card","type":"shape","shape":"rect","parent":"plane","x":0,"y":0,"w":200,"h":200}"#,
            r#"{"id":"cam","type":"shape","shape":"rect","x":600,"y":500,"w":1,"h":1,"visible":false,"camera":{"focal":1800}}"#,
        ] {
            scene.layers.push(serde_json::from_str(l).unwrap());
        }
        // Same numbers as the drawn frame: half size, shifted toward the look point.
        let far = scene.layer_bounds("far", 0.0).unwrap();
        assert!((far.center[0] - 450.0).abs() < 1e-3 && (far.size[0] - 50.0).abs() < 1e-3, "{far:?}");
        assert_eq!(scene.pick(0.0, 450.0, 500.0).as_deref(), Some("far"));
        assert_eq!(scene.pick(0.0, 520.0, 500.0), None, "the flat box is not where the camera shows it");
        let layout = scene.layout(0.0);
        assert_eq!(layout.behind, vec!["gone".to_owned()]);
        let card = layout.layers.iter().find(|r| r.id == "card").unwrap();
        assert_eq!(card.plane.as_deref(), Some("plane"));
        // A plane leaning back 60° is squashed vertically on screen.
        let [x0, y0, x1, y1] = card.screen;
        assert!(y1 - y0 < (x1 - x0) * 0.7, "{:?}", card.screen);
        assert!(layout.camera.is_some_and(|c| c.focal == 1800.0));
    }
}
