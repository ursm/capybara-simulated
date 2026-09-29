// The walk-parity ops (`__dom.walkParity*`): the instrument that holds the Rust walk (`walk.rs`) against the JS one
// while both exist. A `layoutPass` made under it (`CSIM_WALK_PARITY=1`) keeps the records the JS walk sent; the JS side
// then asks `walkParity`, which walks the same pass root here and compares the two field by field — asking back for the
// faces it has not been told of (`walkFace`), which only the JS side can resolve today. `walkParityStats` answers the
// tally as JSON and starts a new one.

use std::collections::BTreeMap;
use std::fmt::Write;

use crate::dom::{dom, realm_id, register, NodeId};
use crate::layout::{InlineBox, Input, Run, RunText};
use crate::walk::{self, Basis, Face, Faces, FieldDiff, Outcome};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "walkParity", walk_parity, context_id);
    register(scope, ns, "walkFace", walk_face, context_id);
    register(scope, ns, "walkParityStats", walk_parity_stats, context_id);
}

// A realm's instrument: the pass the JS walk last sent, the faces it has resolved for the Rust walk, and the tally.
#[derive(Default)]
pub(crate) struct Parity {
    pending: Option<Pass>,
    // (…and whether the JS side has been asked for the pending pass's faces already: a second ask is a face it could not
    // resolve, and the pass is counted as declined for it rather than dropped)
    asked: bool,
    faces: Faces,
    stats: Stats,
}

impl Parity {
    // Keep a pass's records as the JS walk sent them, for `walkParity` to hold the Rust walk's against.
    pub(crate) fn keep(&mut self, inputs: &[Input], runs: &[Run], run_texts: &[RunText], inlines: &[InlineBox], grids: &[f64], maths: &[f64], basis: Basis) {
        self.pending = Some(Pass {
            inputs: inputs.to_vec(),
            runs: runs.to_vec(),
            run_texts: run_texts.to_vec(),
            inlines: inlines.to_vec(),
            grids: grids.to_vec(),
            maths: maths.to_vec(),
            basis,
        });
        self.asked = false;
    }
}

struct Pass {
    inputs: Vec<Input>,
    runs: Vec<Run>,
    run_texts: Vec<RunText>,
    inlines: Vec<InlineBox>,
    grids: Vec<f64>,
    maths: Vec<f64>,
    basis: Basis,
}

#[derive(Default)]
struct Stats {
    passes: u64,
    declined: BTreeMap<&'static str, u64>,
    compared: u64,
    // …of them, every record and run the same, or the same but for f32 precision.
    clean: u64,
    close: u64,
    // …and the passes whose streams differ in LENGTH, where no field can be lined up.
    shape: u64,
    // Per field: [really different, only f32-close].
    fields: BTreeMap<&'static str, [u64; 2]>,
    samples: Vec<String>,
}

const MAX_SAMPLES: usize = 40;

// __dom.walkParity(generation) -> null (compared, declined, or no pass kept), or [family, bucket, …] — the faces the
// Rust walk needs before it can walk the kept pass, for the JS side to resolve (`walkFace`) and ask again. The faces
// learnt are kept while `generation` (what a family resolves by) holds.
fn walk_parity(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let generation = args.get(0).to_rust_string_lossy(scope);
    let d = dom(scope);
    let Some(parity) = d.walk_parity.get_mut(&cid) else { return };
    let Some(pass) = parity.pending.take() else { return };
    let Some(arena) = d.realms.get(&cid) else { return };
    let Some(root) = pass.inputs.first().and_then(|r| NodeId::from_i64(r.nid as i64)) else { return };
    parity.faces.at_generation(&generation);
    match walk::build(arena, root, pass.basis, &mut parity.faces) {
        Outcome::NeedsFaces if parity.asked => {
            parity.stats.passes += 1;
            *parity.stats.declined.entry("faces-unresolved").or_default() += 1;
        }
        Outcome::NeedsFaces => {
            parity.asked = true;
            let wanted: Vec<(String, &'static str)> = parity.faces.missing.clone();
            parity.pending = Some(pass);
            let out = v8::Array::new(scope, (wanted.len() * 2) as i32);
            for (i, (family, bucket)) in wanted.iter().enumerate() {
                let f = v8::String::new(scope, family).unwrap();
                let b = v8::String::new(scope, bucket).unwrap();
                out.set_index(scope, (i * 2) as u32, f.into());
                out.set_index(scope, (i * 2 + 1) as u32, b.into());
            }
            rv.set(out.into());
        }
        Outcome::Declined(why) => {
            parity.stats.passes += 1;
            *parity.stats.declined.entry(why).or_default() += 1;
        }
        Outcome::Built(built) => {
            let stats = &mut parity.stats;
            stats.passes += 1;
            stats.compared += 1;
            let tag = |nid: f64| {
                NodeId::from_i64(nid as i64).and_then(|id| arena.get(id)).map(|n| n.local_name.to_string()).unwrap_or_else(|| "anon".into())
            };
            if built.inputs.len() != pass.inputs.len()
                || built.runs.len() != pass.runs.len()
                || built.inlines.len() != pass.inlines.len()
                || built.grids.len() != pass.grids.len()
            {
                stats.shape += 1;
                if stats.samples.len() < MAX_SAMPLES {
                    stats.samples.push(format!(
                        "shape at <{}>: records js {} rust {}, runs js {} rust {}, inlines js {} rust {}, grids js {} rust {}",
                        tag(pass.inputs[0].nid),
                        pass.inputs.len(),
                        built.inputs.len(),
                        pass.runs.len(),
                        built.runs.len(),
                        pass.inlines.len(),
                        built.inlines.len(),
                        pass.grids.len(),
                        built.grids.len()
                    ));
                }
                return;
            }
            let mut real = false;
            let mut close = false;
            let mut note = |stats: &mut Stats, what: String, diffs: Vec<FieldDiff>| {
                for d in diffs {
                    stats.fields.entry(d.field).or_default()[d.close as usize] += 1;
                    if d.close {
                        close = true;
                    } else {
                        real = true;
                        if stats.samples.len() < MAX_SAMPLES {
                            stats.samples.push(format!("{what} {}: js {} rust {}", d.field, d.js, d.rust));
                        }
                    }
                }
            };
            for (i, (js, rust)) in pass.inputs.iter().zip(&built.inputs).enumerate() {
                note(stats, format!("rec {i} <{}>", tag(js.nid)), walk::input_diff(js, &pass.maths, rust, &built.maths));
            }
            for (i, (js, rust)) in pass.runs.iter().zip(&built.runs).enumerate() {
                let mut diffs = walk::run_diff(js, rust);
                if pass.run_texts[i] != built.run_texts[i] {
                    let text = |t: &RunText| t.as_ref().map(|u| String::from_utf16_lossy(u)).unwrap_or_default();
                    diffs.push(FieldDiff { field: "text", close: false, js: format!("{:?}", text(&pass.run_texts[i])), rust: format!("{:?}", text(&built.run_texts[i])) });
                }
                note(stats, format!("run {i}"), diffs);
            }
            for (i, (js, rust)) in pass.inlines.iter().zip(&built.inlines).enumerate() {
                note(stats, format!("inline {i}"), walk::inline_diff(js, &pass.maths, rust, &built.maths));
            }
            // (…the grid stream by its numbers: a table's column count, then each column's declared px and fraction)
            for (i, (js, rust)) in pass.grids.iter().zip(&built.grids).enumerate() {
                note(stats, format!("grid {i}"), walk::grid_diff(*js, *rust));
            }
            if !real {
                stats.clean += 1;
                if close {
                    stats.close += 1;
                }
            }
        }
    }
}

// __dom.walkFace(family, bucket, handle, asc, desc, gap, space, xh): the face the JS side resolved for a family and a bucket
// — a handle below 0 (or no metrics) where it resolves to none the layout can measure with.
fn walk_face(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let family = args.get(0).to_rust_string_lossy(scope);
    let bucket = match args.get(1).to_rust_string_lossy(scope).as_str() {
        "bold" => "bold",
        "italic" => "italic",
        "bold:italic" => "bold:italic",
        _ => "",
    };
    let num = |scope: &mut v8::PinScope<'_, '_>, i: i32| args.get(i).number_value(scope).unwrap_or(f64::NAN);
    let handle = num(scope, 2);
    let xh = num(scope, 7);
    let face = Face {
        handle: if handle.is_finite() { handle as i32 } else { -1 },
        asc: num(scope, 3),
        desc: num(scope, 4),
        gap: num(scope, 5),
        space: num(scope, 6),
        xh: if xh > 0.0 { xh } else { 0.5 },
    };
    let usable = face.handle >= 0 && [face.asc, face.desc, face.gap, face.space].iter().all(|v| v.is_finite());
    dom(scope).walk_parity.entry(cid).or_default().faces.learn((family, bucket), usable.then_some(face));
}

// __dom.walkParityStats() -> the tally as JSON, and a fresh one.
fn walk_parity_stats(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let s = dom(scope).walk_parity.get_mut(&cid).map(|p| std::mem::take(&mut p.stats)).unwrap_or_default();
    let mut j = String::new();
    let _ = write!(j, r#"{{"passes":{},"compared":{},"clean":{},"close":{},"shape":{},"declined":{{"#, s.passes, s.compared, s.clean, s.close, s.shape);
    for (i, (k, v)) in s.declined.iter().enumerate() {
        let _ = write!(j, "{}{}:{}", if i > 0 { "," } else { "" }, json_str(k), v);
    }
    j.push_str(r#"},"fields":{"#);
    for (i, (k, [real, close])) in s.fields.iter().enumerate() {
        let _ = write!(j, "{}{}:[{},{}]", if i > 0 { "," } else { "" }, json_str(k), real, close);
    }
    j.push_str(r#"},"samples":["#);
    for (i, sample) in s.samples.iter().enumerate() {
        let _ = write!(j, "{}{}", if i > 0 { "," } else { "" }, json_str(sample));
    }
    j.push_str("]}");
    let out = v8::String::new(scope, &j).unwrap();
    rv.set(out.into());
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
