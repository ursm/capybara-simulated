// The Rust walk's ops: `layoutBuild`, the layout pass the Rust walk builds on its own (the style engine's values, no JS
// walk), and the walk-parity ops (`__dom.walkParity*`): the instrument that holds the Rust walk (`walk.rs`) against the
// JS one while both exist. A `layoutPass` made under it (`CSIM_WALK_PARITY=1`) keeps the records the JS walk sent; the JS side
// then asks `walkParity`, which walks the same pass root here and compares the two field by field — asking back for the
// faces it has not been told of (`walkFace`), which only the JS side can resolve today. `walkParityStats` answers the
// tally as JSON and starts a new one.

use std::collections::BTreeMap;
use std::fmt::Write;

use style::computed_values::direction::T as Direction;

use crate::dom::{dom, f64_array, laid_answer, realm_id, register, NodeId};
use crate::layout::{InlineBox, Input, Run, RunText};
use crate::walk::{self, Basis, Face, FieldDiff, Outcome};
use crate::walk_reuse;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "layoutBuild", layout_build, context_id);
    register(scope, ns, "walkParity", walk_parity, context_id);
    register(scope, ns, "walkFace", walk_face, context_id);
    register(scope, ns, "styleFaces", style_faces, context_id);
    register(scope, ns, "walkParityStats", walk_parity_stats, context_id);
}

// A realm's instrument: the pass the JS walk last sent, and the tally.
#[derive(Default)]
pub(crate) struct Parity {
    pending: Option<Pass>,
    // (…and whether the JS side has been asked for the pending pass's faces already: a second ask is a face it could not
    // resolve, and the pass is counted as declined for it rather than dropped)
    asked: bool,
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
    // (…its programs by content, beside the JS walk's: a table of its own, whose offsets need not last)
    let mut maths = walk::MathTable::default();
    let built = arena.faces.with(|faces| {
        faces.at_generation(&generation);
        walk::build(arena, root, pass.basis, faces, &mut maths, None)
    });
    match built {
        Outcome::NeedsFaces if parity.asked => {
            parity.stats.passes += 1;
            *parity.stats.declined.entry("faces-unresolved").or_default() += 1;
        }
        Outcome::NeedsFaces => {
            parity.asked = true;
            let wanted = arena.faces.with(|faces| faces.missing.clone());
            parity.pending = Some(pass);
            rv.set(faces_answer(scope, &wanted).into());
        }
        Outcome::Declined(why) => {
            parity.stats.passes += 1;
            *parity.stats.declined.entry(why).or_default() += 1;
        }
        // (…the JS walk makes and links every box it lays out: one not linked yet is one it did not)
        Outcome::NeedsBoxes(_) => {
            parity.stats.passes += 1;
            *parity.stats.declined.entry("generated content unlinked").or_default() += 1;
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
                note(stats, format!("rec {i} <{}>", tag(js.nid)), walk::input_diff(js, &pass.maths, rust, &maths.values));
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
                note(stats, format!("inline {i}"), walk::inline_diff(js, &pass.maths, rust, &maths.values));
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

// __dom.layoutBuild(rootNid, fontGeneration, rootCbW, rootCbH, texts, check): a whole layout pass the Rust walk builds
// from the arena and the style engine — the records, runs and tables the JS walk would have sent — laid out as
// `layoutPass` lays those out (the root placed natively). Answers the pass as `layoutPass` does, `[fragRows, boxRows,
// changed, textRows?]`, with what names its boxes to the JS side beside it: `[…, recordNids, anonymous, inlineNids]`
// (an anonymous cell or item as `[record, kind, container nid, ordinal]`, flat). Or `[family, bucket, …]` — the faces
// the walk needs first, for the JS side to resolve (`walkFace`) and ask again — or the walk's decline, a string, for
// the JS walk to take the pass.
fn layout_build(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some(root) = NodeId::from_i64(args.get(0).number_value(scope).unwrap_or(-1.0) as i64) else { return };
    let generation = args.get(1).to_rust_string_lossy(scope);
    let root_cb_w = args.get(2).number_value(scope).unwrap_or(0.0);
    let basis = Basis { w: root_cb_w, h: args.get(3).number_value(scope).unwrap_or(f64::NAN) };
    let texts = args.get(4).is_true();
    // …and whether to CHECK every measure put back against laying it out again (`CSIM_NL_REUSE_VERIFY`).
    let check = args.get(5).is_true();
    let d = dom(scope);
    let Some(arena) = d.realms.get(&cid) else { return };
    // (…the root's direction, which places it — the style engine's, as every other value the walk reads)
    let root_rtl = crate::style::primary_style(arena, root).is_some_and(|s| s.get_inherited_box().direction == Direction::Rtl);
    // (…splicing back from the last kept pass what did not change since it: `Walk::splice`; under the check, the pass is
    // walked whole as well, and the two held against each other)
    let (maths, prior) = d.walk_reuse.entry(cid).or_default().for_walk(&generation);
    let (built, whole) = arena.faces.with(|faces| {
        faces.at_generation(&generation);
        let built = walk::build(arena, root, basis, faces, maths, prior);
        let whole = (check && prior.is_some()).then(|| walk::build(arena, root, basis, faces, maths, None));
        (built, whole)
    });
    // (…a whole walk that could not build what the spliced one built — it asked for a face, a box, or declined — is a
    // difference as much as a record that differs: the spliced one got past what the whole walk met)
    let mismatch = match (&built, &whole) {
        (Outcome::Built(spliced), Some(Outcome::Built(whole))) => walk_reuse::splice_mismatch(spliced, whole),
        (Outcome::Built(_), Some(_)) => Some("the whole walk built no pass".to_owned()),
        _ => None,
    };
    if let Some(why) = mismatch {
        let s = v8::String::new(scope, &format!("reuse mismatch: {why}")).unwrap();
        rv.set(s.into());
        return;
    }
    let built = match built {
        Outcome::Built(built) => built,
        Outcome::Declined(why) => {
            let s = v8::String::new(scope, why).unwrap();
            rv.set(s.into());
            return;
        }
        Outcome::NeedsFaces => {
            let wanted = arena.faces.with(|faces| faces.missing.clone());
            rv.set(faces_answer(scope, &wanted).into());
            return;
        }
        Outcome::NeedsBoxes(boxes) => {
            // (…as `{boxes: [nid, which, …]}`)
            let out = v8::Object::new(scope);
            let key = v8::String::new(scope, "boxes").unwrap();
            let list: v8::Local<v8::Value> = f64_array(scope, &boxes).into();
            out.set(scope, key.into(), list);
            rv.set(out.into());
            return;
        }
    };
    let walk::Built { mut inputs, runs, run_texts, inlines, grids, anon, inline_nids, extents, spliced, walked } = built;
    let nids: Vec<f64> = inputs.iter().map(|r| r.nid).collect();
    // The layout of every subtree built as the last pass built it is the measure cache's to put back (`walk_reuse`) —
    // except for a pass that answers its text pieces, which a put-back measure does not hold.
    let reuse = dom(scope).walk_reuse.entry(cid).or_default();
    let streams = walk_reuse::Streams { inputs: &inputs, runs: &runs, run_texts: &run_texts, grids: &grids, inlines: &inlines, extents: &extents, spliced: &spliced };
    let walk_reuse::Pass { roots, ends, ids, unchanged } = reuse.chunks(&streams);
    let built_inputs = inputs.clone();
    let mut measure = std::mem::take(&mut reuse.measure);
    let maths = std::mem::take(&mut reuse.maths);
    let cache = (!texts).then_some((&mut measure, roots, check));
    let out = crate::layout::layout_block_in_place(&mut inputs, &runs, &run_texts, &grids, &inlines, &maths.values, f64::NAN, f64::NAN, root_cb_w, root_rtl, cache, texts);
    let mismatch = measure.mismatch.take();
    let reuse = dom(scope).walk_reuse.entry(cid).or_default();
    reuse.measure = measure;
    reuse.maths = maths;
    let kept = walk_reuse::KeptPass {
        inputs: built_inputs,
        runs,
        run_texts,
        grids,
        inlines,
        extents,
        anon: anon.clone(),
        inline_nids: inline_nids.clone(),
        walked,
    };
    reuse.keep(kept, ends, ids);
    if let Some(why) = mismatch {
        let s = v8::String::new(scope, &format!("reuse mismatch: {why}")).unwrap();
        rv.set(s.into());
        return;
    }
    let crate::layout::Outcome::LaidOut(laid) = out else {
        let s = v8::String::new(scope, "native declined").unwrap();
        rv.set(s.into());
        return;
    };
    let answer = laid_answer(scope, cid, laid, texts);
    let anon: Vec<f64> = anon.iter().flatten().copied().collect();
    for (at, list) in [(4, &nids), (5, &anon), (6, &inline_nids), (7, &unchanged)] {
        let v: v8::Local<v8::Value> = f64_array(scope, list).into();
        answer.set_index(scope, at, v);
    }
    rv.set(answer.into());
}

// The faces a walk needs, `[family, bucket, …]`, for the JS side to resolve.
fn faces_answer<'s>(scope: &mut v8::PinScope<'s, '_>, wanted: &[(String, &'static str)]) -> v8::Local<'s, v8::Array> {
    let out = v8::Array::new(scope, (wanted.len() * 2) as i32);
    for (i, (family, bucket)) in wanted.iter().enumerate() {
        let f = v8::String::new(scope, family).unwrap();
        let b = v8::String::new(scope, bucket).unwrap();
        out.set_index(scope, (i * 2) as u32, f.into());
        out.set_index(scope, (i * 2 + 1) as u32, b.into());
    }
    out
}

// __dom.styleFaces(generation) -> null, or [family, bucket, …]: the faces the style engine computed a font metric (`ex`,
// `ch`) without since it was last told — asked after a style flush, so a value read before any layout is not the
// stand-in's (`flushStyleEngine`). The faces are the realm's as of `generation`, as the walk's are; an undefined one is
// the generation last given (asked on every style-engine read, it crosses only when it moves).
fn style_faces(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let generation = (!args.get(0).is_undefined()).then(|| args.get(0).to_rust_string_lossy(scope));
    let Some(arena) = dom(scope).realms.get(&cid) else { return };
    let wanted = arena.faces.with(|faces| {
        if let Some(generation) = &generation {
            faces.at_generation(generation);
        }
        faces.metrics_missing().to_vec()
    });
    if wanted.is_empty() {
        rv.set_null();
    } else {
        rv.set(faces_answer(scope, &wanted).into());
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
    // (…a face the style engine computed a font metric without: its styles are computed again, `ex` and `ch` from it)
    let d = dom(scope);
    let Some(arena) = d.realms.get(&cid) else { return };
    if arena.faces.with(|faces| faces.learn((family, bucket), usable.then_some(face))) {
        if let Some(engine) = d.styles.get_mut(&cid) {
            engine.restyle_everything();
        }
        // (…and nothing a walk built before is spliced back: its font metrics were a stand-in's)
        if let Some(reuse) = d.walk_reuse.get_mut(&cid) {
            reuse.forget();
        }
    }
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
