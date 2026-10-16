// The Rust walk's ops: `layoutBuild`, the layout pass the Rust walk builds from the style engine's values, and the faces
// it asks the JS side for (`styleFaces`, `walkFace`), which only that side resolves today.

use crate::dom::{dom, realm, realm_id, register, NodeId, GEN_CASCADE, GEN_DIRTY, GEN_SCROLL, GEN_SETTLE};
use crate::walk::{self, Basis, Face, Outcome};
use crate::walk_reuse;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "layoutBuild", layout_build, context_id);
    register(scope, ns, "walkFace", walk_face, context_id);
    register(scope, ns, "fontMeasures", font_measures, context_id);
    register(scope, ns, "styleFaces", style_faces, context_id);
    register(scope, ns, "layoutDue", layout_due, context_id);
    register(scope, ns, "forgetLayout", forget_layout, context_id);
    register(scope, ns, "layoutGeneration", layout_generation, context_id);
    register(scope, ns, "noteScrolled", note_scrolled, context_id);
}

// __dom.layoutDue() -> whether the realm's document is to be laid out again: what a pass reads moved since the last —
// the settle generation (a mutation), the rule set's, and the layout dirty sequence (the marks a restyle made, which move
// neither) — taken as laid out as of them now.
fn layout_due(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let now = [GEN_SETTLE, GEN_CASCADE, GEN_DIRTY].map(|w| arena.generations.get(w));
    let due = arena.laid_out_at != Some(now);
    arena.laid_out_at = Some(now);
    rv.set_bool(due);
}
// __dom.forgetLayout(): the next layout read lays the document out whatever the generations say — a viewport moved
// (the window's, or the frame's container), which moves none of them, or a pass recording what it lays out.
fn forget_layout(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    realm(scope, cid).laid_out_at = None;
}
// __dom.layoutGeneration() -> the generation geometry is valid for: two reads of one value cannot see different boxes,
// so a repeated observer pass over unchanged geometry returns at once — the settle, rule set, scroll and layout dirty
// generations' sum, which moves whenever one does (each only counts up; four u32 words stay inside a double's exact
// integers).
fn layout_generation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let g = &realm(scope, cid).generations;
    rv.set_double([GEN_SETTLE, GEN_CASCADE, GEN_SCROLL, GEN_DIRTY].iter().map(|&w| f64::from(g.get(w))).sum());
}
// __dom.noteScrolled(): a scroll offset moved, or a scroll into view was asked for — the scroll generation moved.
fn note_scrolled(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    realm(scope, cid).generations.bump(GEN_SCROLL);
}

// __dom.layoutBuild(rootNid, fontGeneration, rootCbW, rootCbH, records, check): a whole layout pass the Rust walk builds
// from the arena and the style engine — its records, runs and tables — and lays out (the root placed natively), its
// boxes kept in the arena for the geometry (geometry.rs `store_layout`) — `records` 1 or 2 recording its text pieces
// for the text geometry too (text_geometry.rs) — and where `records` is 2, for a pass a painter records, each text piece
// as it draws it, kept for the painter (paint.rs `Painted`): answered `true`. Or `[family, bucket, …]` — the faces the
// walk needs first, for the JS side to resolve (`walkFace`) and ask again — or the walk's decline, a string.
fn layout_build(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some(root) = NodeId::from_i64(args.get(0).number_value(scope).unwrap_or(-1.0) as i64) else { return };
    let generation = args.get(1).to_rust_string_lossy(scope);
    let root_cb_w = args.get(2).number_value(scope).unwrap_or(0.0);
    let basis = Basis { w: root_cb_w, h: args.get(3).number_value(scope).unwrap_or(f64::NAN) };
    let records = args.get(4).integer_value(scope).unwrap_or(0);
    let (texts, paints) = (records >= 1, records == 2);
    // …and whether to CHECK every measure put back against laying it out again (`CSIM_NL_REUSE_VERIFY`).
    let check = args.get(5).is_true();
    let d = dom(scope);
    let Some(arena) = d.arena.enter_known(cid) else { return };
    // (…a pass that paints keeps the pieces it placed, or none where it lays nothing out)
    if paints {
        arena.painted.replace(None);
    }
    // (…and its style engine, for a style the traversal leaves to whoever asks: a `::placeholder`'s)
    let engine = d.styles.get(&cid);
    // (…the edge of the initial containing block the root sits at: `walk::principal_starts_right`)
    let root_rtl = walk::principal_starts_right(arena, root);
    // (…splicing back from the last kept pass what did not change since it: `Walk::splice`; under the check, the pass is
    // walked whole as well, and the two held against each other)
    // (…a pass that paints splicing only what the last kept whole, the marks of its text runs included)
    let (maths, prior) = d.walk_reuse.entry(cid).or_default().for_walk(&generation);
    let (built, whole) = loop {
        let (built, whole) = arena.faces.with(|faces| {
            faces.at_generation(&generation);
            let built = walk::build(arena, engine, root, basis, faces, maths, prior, texts);
            let whole = (check && prior.is_some()).then(|| walk::build(arena, engine, root, basis, faces, maths, None, texts));
            (built, whole)
        });
        // (…the generated boxes it met that render with no slot to name them by: made, and the pass walked again)
        let Outcome::NeedsBoxes(boxes) = &built else { break (built, whole) };
        for &(el, which) in boxes {
            arena.link_generated(el, which);
        }
    };
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
        Outcome::NeedsBoxes(_) => unreachable!("the loop above made every generated box the walk asked for"),
        Outcome::NeedsFaces => {
            let wanted = arena.faces.with(|faces| faces.missing.clone());
            rv.set(faces_answer(scope, &wanted).into());
            return;
        }
    };
    let walk::Built { mut inputs, runs, run_texts, inlines, grids, anon, inline_nids, extents, spliced, walked, paint } = built;
    // The layout of every subtree built as the last pass built it is the measure cache's to put back (`walk_reuse`) — for
    // a pass that answers its text pieces, a measure that holds them (`layout::Measured::texts`).
    let reuse = dom(scope).walk_reuse.entry(cid).or_default();
    let streams = walk_reuse::Streams { inputs: &inputs, runs: &runs, run_texts: &run_texts, grids: &grids, inlines: &inlines, extents: &extents, spliced: &spliced };
    let walk_reuse::Pass { roots, ends, ids } = reuse.chunks(&streams);
    let built_inputs = inputs.clone();
    let mut measure = std::mem::take(&mut reuse.measure);
    let maths = std::mem::take(&mut reuse.maths);
    let cache = Some((&mut measure, roots, check));
    let out = crate::layout::layout_block_in_place(&mut inputs, &runs, &run_texts, &grids, &inlines, &maths.values, f64::NAN, f64::NAN, root_cb_w, root_rtl, cache, texts);
    // (…and a pass that paints answers each text piece as the painter draws it — beside the rows that index the runs, which
    // only this side has: its row, its text and its pen steps, the baseline's run shift taken back off and a hyphen's owner
    // the character's before it)
    let painted = match &out {
        crate::layout::Outcome::LaidOut(laid) if paints => Some(paint_rows(&laid.texts, &paint, &runs, &run_texts)),
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
        paint,
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
    // by the style engine here — and the root and the viewport the geometry reads the boxes against)
    if let Some(arena) = dom(scope).arena.enter_known(cid) {
        for b in laid.boxes.iter_mut().filter(|b| b.nid >= 0.0) {
            b.position = NodeId::from_i64(b.nid as i64)
                .and_then(|id| crate::geometry::box_style(arena, id))
                .map_or(0, |s| walk::position_code(s.get_box().clone_position()));
        }
        arena.begin_layout(root, [basis.w, basis.h]);
        crate::geometry::store_layout(arena, &laid, &inline_nids, &anon);
        // (…and where its text is, with the runs the walk kept: text_geometry.rs)
        if texts {
            *arena.text_geometry.borrow_mut() = Some(crate::text_geometry::TextGeometry::new(arena.layout_pass, walked, std::mem::take(&mut laid.texts)));
        }
    }
    // (…answered `true` — the boxes are the arena's now — a pass that paints keeping its text pieces for the painter)
    if let (Some((rows, texts, steps)), Some(arena)) = (painted, dom(scope).arena.enter_known(cid)) {
        arena.painted.replace(Some(crate::paint::Painted { rows, texts, steps }));
    }
    rv.set(v8::Boolean::new(scope, true).into());
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
    let Some(arena) = dom(scope).arena.enter_known(cid) else { return };
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

// __dom.walkFace(family, bucket, handle, ascOverride, descOverride, gapOverride): the face the JS side resolved for a
// family and a bucket, laid out by the metrics its file has (`FontMetrics::face`) or the `@font-face` overrides of
// them given (NaN for none) — a handle below 0 where it resolves to none the layout can measure with.
fn walk_face(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let family = args.get(0).to_rust_string_lossy(scope);
    let bucket = match args.get(1).to_rust_string_lossy(scope).as_str() {
        "bold" => "bold",
        "italic" => "italic",
        "bold:italic" => "bold:italic",
        _ => "",
    };
    let handle = args.get(2).int32_value(scope).unwrap_or(-1);
    let overrides = [3, 4, 5].map(|i| args.get(i).number_value(scope).filter(|v| v.is_finite()));
    let metrics = crate::font::with_font(handle, |fm| fm.face(overrides)).flatten();
    let face = match metrics {
        Some((v, space, xh)) => Face { handle, asc: v.asc, desc: v.desc, gap: v.gap, space, xh: if xh > 0.0 { xh } else { 0.5 } },
        None => Face { handle: -1, asc: f64::NAN, desc: f64::NAN, gap: f64::NAN, space: f64::NAN, xh: 0.5 },
    };
    let usable = face.handle >= 0;
    // (…a face the style engine computed a font metric without: its styles are computed again, `ex` and `ch` from it)
    let d = dom(scope);
    let Some(arena) = d.arena.enter_known(cid) else { return };
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

// __dom.fontMeasures(handle, ascOverride, descOverride, gapOverride) -> whether the face has metrics to lay a line out
// by (`FontMetrics::face`): a colour emoji font has none, and its text falls back to the next family that has.
fn font_measures(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let handle = args.get(0).int32_value(scope).unwrap_or(-1);
    let overrides = [1, 2, 3].map(|i| args.get(i).number_value(scope).filter(|v| v.is_finite()));
    rv.set_bool(crate::font::with_font(handle, |fm| fm.face(overrides).is_some()).unwrap_or(false));
}

// The rows a painter draws, a word each: a row the line made of several pieces across plain spaces (layout.rs, which keeps
// one for them) split back at its spaces, each word where the pen over the run's text puts it — the flow's own advance,
// the figure a painter condenses a word to.
fn words(rows: &[crate::layout::TextRow], runs: &[crate::layout::Run], run_texts: &[crate::layout::RunText]) -> Vec<crate::layout::TextRow> {
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let (run, start, end) = (r[0] as usize, r[1] as usize, r[2] as usize);
        let piece = run_texts.get(run).and_then(|t| t.as_deref()).and_then(|t| t.get(start..end)).unwrap_or(&[]);
        let per = (start < end && piece.contains(&0x20))
            .then(|| runs.get(run).and_then(|ri| crate::font::with_font(ri.font, |fm| fm.pen_steps(piece, ri.size, ri.ls, ri.ws, r[7], r[8], ri.tab_px, ri.tab_min))))
            .flatten();
        let Some(per) = per else {
            out.push(*r);
            continue;
        };
        // (…walking its code points: a word from its first unit to the space after it, its width the steps over it)
        let (mut pen, mut unit, mut word): (f64, usize, Option<(usize, f64, f64)>) = (0.0, 0, None);
        for (k, cp) in crate::font::code_points(piece).enumerate() {
            let step = per.get(k * 3 + 1).copied().unwrap_or(0.0);
            let len = if cp > 0xFFFF { 2 } else { 1 };
            if cp == 0x20 {
                if let Some((ws, x, w)) = word.take() {
                    out.push([r[0], (start + ws) as f64, (start + unit) as f64, r[3] + x, r[4], r[5], w, r[7], r[8] + x, r[9], r[10], r[11], r[12]]);
                }
            } else {
                let (_, _, w) = word.get_or_insert((unit, pen, 0.0));
                *w += step;
            }
            pen += step;
            unit += len;
        }
        if let Some((ws, x, w)) = word {
            out.push([r[0], (start + ws) as f64, end as f64, r[3] + x, r[4], r[5], w, r[7], r[8] + x, r[9], r[10], r[11], r[12]]);
        }
    }
    out
}

// Each text row (`layout::TextRow`) as the painter draws it — whether its owner's `::placeholder` is what it is drawn
// in, and where its characters' pen steps start in the third list and how many there are, for a piece it cannot draw
// whole (`FontMetrics::pen_steps`): a spaced, justified or tabbed one, or one whose characters a split face spreads
// over several faces.
fn paint_rows(rows: &[crate::layout::TextRow], paint: &[walk::PaintMark], runs: &[crate::layout::Run], run_texts: &[crate::layout::RunText]) -> (Vec<f64>, Vec<Vec<u16>>, Vec<f64>) {
    let mut out = Vec::new();
    let mut strings = Vec::new();
    let mut steps = Vec::new();
    for r in &words(rows, runs, run_texts) {
        let (run, start, end) = (r[0] as usize, r[1] as usize, r[2] as usize);
        let hyphen = start == end;
        // (…the marks in run order, as the walk committed them)
        let mark = paint.binary_search_by_key(&run, |m| m.run).ok().map(|k| &paint[k]);
        let text = run_texts.get(run).and_then(|t| t.as_deref()).unwrap_or(&[]);
        let piece = if hyphen { vec![u16::from(b'-')] } else { text.get(start..end).unwrap_or(&[]).to_vec() };
        let at = if hyphen { start.saturating_sub(1) } else { start } as u32;
        let owner = mark.and_then(|m| m.owners.iter().rev().find(|&&(o, _)| o <= at)).map_or(-1.0, |&(_, nid)| nid);
        let from = steps.len();
        if let Some(run) = runs.get(run) {
            let by_char = run.ls != 0.0 || run.ws != 0.0 || r[7] != 0.0 || piece.contains(&0x09);
            if let Some(per) = crate::font::with_font(run.font, |fm| (by_char || fm.splits(&piece)).then(|| fm.pen_steps(&piece, run.size, run.ls, run.ws, r[7], r[8], run.tab_px, run.tab_min))).flatten() {
                steps.extend(per);
            }
        }
        let placeholder = f64::from(u8::from(mark.is_some_and(|m| m.placeholder)));
        out.extend([r[3], r[4], r[5] - mark.map_or(0.0, |m| m.shift), r[6], r[7], owner, placeholder, from as f64, ((steps.len() - from) / 3) as f64]);
        strings.push(piece);
    }
    (out, strings, steps)
}
