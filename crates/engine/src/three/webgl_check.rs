//! The stage shader must also run on the WebGL2 fallback: every entry point has to translate to
//! GLSL ES 3.0 through naga (what wgpu's GL backend does at pipeline creation).

use naga::back::glsl;

#[test]
fn the_stage_shader_translates_to_glsl_es_300() {
    let module = naga::front::wgsl::parse_str(include_str!("mesh.wgsl")).expect("valid WGSL");
    let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty())
        .validate(&module)
        .expect("the shader validates without extra capabilities");
    let options = glsl::Options { version: glsl::Version::Embedded { version: 300, is_webgl: true }, ..Default::default() };
    for ep in &module.entry_points {
        let pipeline = glsl::PipelineOptions { shader_stage: ep.stage, entry_point: ep.name.clone(), multiview: None };
        let mut out = String::new();
        let mut writer = glsl::Writer::new(&mut out, &module, &info, &options, &pipeline, naga::proc::BoundsCheckPolicies::default())
            .unwrap_or_else(|e| panic!("{}: {e}", ep.name));
        writer.write().unwrap_or_else(|e| panic!("{}: {e}", ep.name));
        assert!(!out.contains("#extension"), "{} needs a GLSL extension WebGL2 may lack:\n{out}", ep.name);
        if ep.name == "fs" {
            assert!(out.contains("sampler2DShadow") && out.contains("textureLod("), "shadow lookups are plain ES 3.0:\n{out}");
        }
    }
}
