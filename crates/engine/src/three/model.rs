//! glTF (GLB) loading into CPU-side data: vertices, node tree, skins and
//! animation clips. GPU upload and drawing live in `mod.rs`.

use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Quat, Vec3};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Default)]
pub struct Vertex3D {
    pub pos: [f32; 3],
    pub normal: [f32; 3],
    pub uv: [f32; 2],
    /// Joint indices as floats (integer attributes are awkward on WebGL2).
    pub joints: [f32; 4],
    pub weights: [f32; 4],
}

pub struct PrimData {
    pub vertices: Vec<Vertex3D>,
    pub indices: Vec<u32>,
    pub color: [f32; 4],
    pub textured: bool,
    pub node: usize,
    pub skin: Option<usize>,
}

#[derive(Clone, Copy)]
pub struct Trs {
    pub t: Vec3,
    pub r: Quat,
    pub s: Vec3,
}

impl Trs {
    pub fn matrix(&self) -> Mat4 {
        Mat4::from_scale_rotation_translation(self.s, self.r, self.t)
    }
}

pub struct NodeData {
    pub parent: Option<usize>,
    pub rest: Trs,
}

pub struct SkinData {
    pub joints: Vec<usize>,
    pub inverse_bind: Vec<Mat4>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Path {
    Translation,
    Rotation,
    Scale,
}

pub struct Channel {
    pub node: usize,
    pub path: Path,
    pub step: bool,
    pub times: Vec<f32>,
    /// 3 floats per key (translation/scale) or 4 (rotation quaternion xyzw).
    pub values: Vec<f32>,
}

pub struct Clip {
    pub name: String,
    pub duration: f32,
    pub channels: Vec<Channel>,
}

pub struct ModelData {
    pub prims: Vec<PrimData>,
    pub nodes: Vec<NodeData>,
    pub skins: Vec<SkinData>,
    pub clips: Vec<Clip>,
    pub uses_texture: bool,
}

pub fn parse_glb(bytes: &[u8]) -> Result<ModelData, String> {
    let gltf = gltf::Gltf::from_slice(bytes).map_err(|e| e.to_string())?;
    let blob = gltf.blob.as_deref();
    let buffer = |b: gltf::Buffer| match b.source() {
        gltf::buffer::Source::Bin => blob,
        gltf::buffer::Source::Uri(_) => None,
    };

    let mut nodes: Vec<NodeData> = gltf
        .nodes()
        .map(|n| {
            let (t, r, s) = n.transform().decomposed();
            NodeData { parent: None, rest: Trs { t: Vec3::from(t), r: Quat::from_array(r), s: Vec3::from(s) } }
        })
        .collect();
    for n in gltf.nodes() {
        for c in n.children() {
            nodes[c.index()].parent = Some(n.index());
        }
    }

    let mut prims = Vec::new();
    let mut uses_texture = false;
    for node in gltf.nodes() {
        let Some(mesh) = node.mesh() else { continue };
        for prim in mesh.primitives() {
            let reader = prim.reader(buffer);
            let Some(positions) = reader.read_positions() else { continue };
            let mut vertices: Vec<Vertex3D> = positions.map(|p| Vertex3D { pos: p, ..Default::default() }).collect();
            if let Some(normals) = reader.read_normals() {
                for (v, n) in vertices.iter_mut().zip(normals) {
                    v.normal = n;
                }
            }
            if let Some(uvs) = reader.read_tex_coords(0) {
                for (v, uv) in vertices.iter_mut().zip(uvs.into_f32()) {
                    v.uv = uv;
                }
            }
            if let Some(joints) = reader.read_joints(0) {
                for (v, j) in vertices.iter_mut().zip(joints.into_u16()) {
                    v.joints = j.map(f32::from);
                }
            }
            if let Some(weights) = reader.read_weights(0) {
                for (v, w) in vertices.iter_mut().zip(weights.into_f32()) {
                    v.weights = w;
                }
            }
            let indices = reader
                .read_indices()
                .map(|i| i.into_u32().collect())
                .unwrap_or_else(|| (0..vertices.len() as u32).collect());
            let pbr = prim.material().pbr_metallic_roughness();
            let textured = pbr.base_color_texture().is_some();
            uses_texture |= textured;
            prims.push(PrimData {
                vertices,
                indices,
                color: pbr.base_color_factor(),
                textured,
                node: node.index(),
                skin: node.skin().map(|s| s.index()),
            });
        }
    }

    let skins = gltf
        .skins()
        .map(|skin| {
            let joints: Vec<usize> = skin.joints().map(|j| j.index()).collect();
            let inverse_bind = skin
                .reader(buffer)
                .read_inverse_bind_matrices()
                .map(|m| m.map(|c| Mat4::from_cols_array_2d(&c)).collect())
                .unwrap_or_else(|| vec![Mat4::IDENTITY; joints.len()]);
            SkinData { joints, inverse_bind }
        })
        .collect();

    let clips = gltf
        .animations()
        .map(|anim| {
            let mut duration: f32 = 0.0;
            let channels = anim
                .channels()
                .filter_map(|ch| {
                    let reader = ch.reader(buffer);
                    let times: Vec<f32> = reader.read_inputs()?.collect();
                    duration = duration.max(times.last().copied().unwrap_or(0.0));
                    let (path, values): (Path, Vec<f32>) = match reader.read_outputs()? {
                        gltf::animation::util::ReadOutputs::Translations(v) => (Path::Translation, v.flatten().collect()),
                        gltf::animation::util::ReadOutputs::Scales(v) => (Path::Scale, v.flatten().collect()),
                        gltf::animation::util::ReadOutputs::Rotations(v) => (Path::Rotation, v.into_f32().flatten().collect()),
                        gltf::animation::util::ReadOutputs::MorphTargetWeights(_) => return None,
                    };
                    let step = ch.sampler().interpolation() == gltf::animation::Interpolation::Step;
                    Some(Channel { node: ch.target().node().index(), path, step, times, values })
                })
                .collect();
            Clip { name: anim.name().unwrap_or_default().to_owned(), duration, channels }
        })
        .collect();

    Ok(ModelData { prims, nodes, skins, clips, uses_texture })
}

impl ModelData {
    /// Local transform of every node with `clip` applied at time `t` (looping).
    pub fn pose(&self, clip: Option<&Clip>, t: f32) -> Vec<Trs> {
        let mut locals: Vec<Trs> = self.nodes.iter().map(|n| n.rest).collect();
        let Some(clip) = clip else { return locals };
        let t = if clip.duration > 0.0 { t.rem_euclid(clip.duration) } else { 0.0 };
        for ch in &clip.channels {
            let n = ch.times.len();
            if n == 0 {
                continue;
            }
            let i = ch.times.partition_point(|&x| x <= t).clamp(1, n) - 1;
            let j = (i + 1).min(n - 1);
            let span = ch.times[j] - ch.times[i];
            let f = if ch.step || span <= 0.0 { 0.0 } else { ((t - ch.times[i]) / span).clamp(0.0, 1.0) };
            let local = &mut locals[ch.node];
            match ch.path {
                Path::Rotation => {
                    let q = |k: usize| Quat::from_slice(&ch.values[k * 4..k * 4 + 4]);
                    local.r = q(i).slerp(q(j), f).normalize();
                }
                Path::Translation | Path::Scale => {
                    let v = |k: usize| Vec3::from_slice(&ch.values[k * 3..k * 3 + 3]);
                    let value = v(i).lerp(v(j), f);
                    if ch.path == Path::Translation {
                        local.t = value;
                    } else {
                        local.s = value;
                    }
                }
            }
        }
        locals
    }

    /// World-space (model-space) matrix of every node for the given local transforms.
    pub fn globals(&self, locals: &[Trs]) -> Vec<Mat4> {
        let mut out: Vec<Option<Mat4>> = vec![None; self.nodes.len()];
        fn resolve(i: usize, nodes: &[NodeData], locals: &[Trs], out: &mut Vec<Option<Mat4>>) -> Mat4 {
            if let Some(m) = out[i] {
                return m;
            }
            let local = locals[i].matrix();
            let m = match nodes[i].parent {
                Some(p) => resolve(p, nodes, locals, out) * local,
                None => local,
            };
            out[i] = Some(m);
            m
        }
        (0..self.nodes.len()).map(|i| resolve(i, &self.nodes, locals, &mut out)).collect()
    }

    pub fn clip(&self, name: &str) -> Option<&Clip> {
        self.clips.iter().find(|c| c.name == name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHARACTER: &[u8] = include_bytes!("../../../../apps/web/public/models/characters/character-female-b.glb");

    #[test]
    fn loads_a_skinned_character_with_its_clips() {
        let m = parse_glb(CHARACTER).unwrap();
        assert!(!m.prims.is_empty() && m.prims.iter().all(|p| !p.indices.is_empty()));
        assert!(m.skins[0].joints.len() <= 16, "fits the shader's joint budget");
        let walk = m.clip("walk").expect("walk clip");
        assert!(walk.duration > 0.0);
        let a = m.globals(&m.pose(Some(walk), 0.0));
        let b = m.globals(&m.pose(Some(walk), walk.duration * 0.5));
        let joint = m.skins[0].joints[1];
        assert_ne!(a[joint], b[joint], "walking moves the skeleton");
    }
}
