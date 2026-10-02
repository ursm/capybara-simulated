// The Rust walk's ops: `layoutBuild`, the layout pass the Rust walk builds from the style engine's values, and the faces
// it asks the JS side for (`styleFaces`, `walkFace`), which only that side resolves today.

use crate::dom::{dom, f64_array, laid_answer, realm_id, register, NodeId};
use crate::walk::{self, Basis, Face, Outcome};
use crate::walk_reuse;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "layoutBuild", layout_build, context_id);
    register(scope, ns, "walkFace", walk_face, context_id);
    register(scope, ns, "styleFaces", style_faces, context_id);
}

// __dom.layoutBuild(rootNid, fontGeneration, rootCbW, rootCbH, texts, check): a whole layout pass the Rust walk builds
// from the arena and the style engine — its records, runs and tables — and lays out (the root placed natively), answered
// as `[fragRows, boxRows, changed]` with what names its boxes to the JS side beside it: `[…, , recordNids, anonymous,
// inlineNids, unchanged]` (an anonymous cell or item as `[record, kind, container nid, ordinal]`, flat; `unchanged` the
// records built as the last pass built them) — and where `texts` asks, for a pass a painter records, each text piece as
// it draws it at 8 and 9: `[x, y, baseline, width, justify, owner nid]` and the texts (`paint_rows`). Or `[family,
// bucket, …]` — the faces the walk needs first, for the JS side to resolve (`walkFace`) and ask again — or the walk's
// decline, a string.
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
    // (…the edge of the initial containing block the root sits at: `walk::principal_starts_right`)
    let root_rtl = walk::principal_starts_right(arena, root);
    // (…splicing back from the last kept pass what did not change since it: `Walk::splice`; under the check, the pass is
    // walked whole as well, and the two held against each other)
    let (maths, prior) = d.walk_reuse.entry(cid).or_default().for_walk(&generation);
    // (…but none for a pass that paints: a spliced subtree's runs carry no `PaintMark`)
    let prior = prior.filter(|_| !texts);
    let (built, whole) = arena.faces.with(|faces| {
        faces.at_generation(&generation);
        let built = walk::build(arena, root, basis, faces, maths, prior, texts);
        let whole = (check && prior.is_some()).then(|| walk::build(arena, root, basis, faces, maths, None, texts));
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
    let walk::Built { mut inputs, runs, run_texts, inlines, grids, anon, inline_nids, extents, spliced, walked, paint } = built;
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
    // (…and a pass that paints answers each text piece as the painter draws it — beside the rows that index the runs, which
    // only this side has: `[x, y, baseline, width, justify, owner nid]` and the text, the baseline's run shift taken back
    // off and a hyphen's owner the character's before it)
    let painted = match &out {
        crate::layout::Outcome::LaidOut(laid) if texts => Some(paint_rows(&laid.texts, &paint, &run_texts)),
        _ => None,
    };
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
    let crate::layout::Outcome::LaidOut(mut laid) = out else {
        let s = v8::String::new(scope, "native declined").unwrap();
        rv.set(s.into());
        return;
    };
    // (…and each box's `position`, which the walk read off the same style: the writer's own question of it, answered
    // by the style engine here)
    if let Some(arena) = dom(scope).realms.get(&cid) {
        for b in laid.boxes.iter_mut().filter(|b| b.nid >= 0.0) {
            b.position = NodeId::from_i64(b.nid as i64)
                .and_then(|id| crate::style::primary_style(arena, id))
                .map_or(0, |s| walk::position_code(s.get_box().clone_position()));
        }
    }
    // (…its text rows answered as the painter's pieces alone, below: nothing on that side reads the rows that index runs)
    let answer = laid_answer(scope, cid, laid);
    if let Some((rows, strings)) = painted {
        let rows: v8::Local<v8::Value> = f64_array(scope, &rows).into();
        answer.set_index(scope, 8, rows);
        let list = v8::Array::new(scope, strings.len() as i32);
        for (k, t) in strings.iter().enumerate() {
            let v = v8::String::new_from_two_byte(scope, t, v8::NewStringType::Normal).unwrap();
            list.set_index(scope, k as u32, v.into());
        }
        answer.set_index(scope, 9, list.into());
    }
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

// Each text row (`[run, start, end, x, y, baseline, width, justify]`) as the painter draws it.
fn paint_rows(rows: &[crate::layout::TextRow], paint: &[walk::PaintMark], run_texts: &[crate::layout::RunText]) -> (Vec<f64>, Vec<Vec<u16>>) {
    let mut out = Vec::new();
    let mut strings = Vec::new();
    for r in rows {
        let (run, start, end) = (r[0] as usize, r[1] as usize, r[2] as usize);
        let hyphen = start == end;
        // (…the marks in run order, as the walk committed them)
        let mark = paint.binary_search_by_key(&run, |m| m.run).ok().map(|k| &paint[k]);
        let text = run_texts.get(run).and_then(|t| t.as_deref()).unwrap_or(&[]);
        strings.push(if hyphen { vec![u16::from(b'-')] } else { text.get(start..end).unwrap_or(&[]).to_vec() });
        let at = if hyphen { start.saturating_sub(1) } else { start } as u32;
        let owner = mark.and_then(|m| m.owners.iter().rev().find(|&&(o, _)| o <= at)).map_or(-1.0, |&(_, nid)| nid);
        out.extend([r[3], r[4], r[5] - mark.map_or(0.0, |m| m.shift), r[6], r[7], owner]);
    }
    (out, strings)
}
