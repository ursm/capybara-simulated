// The face a family stack is measured with, at a weight / style bucket — what the layout measures a run with and a canvas
// shapes its text with: the document's `@font-face` the stack takes (font_faces.rs `pick`) under its `size-adjust`, read
// from the first of its sources that gives a file (font_files.rs `face_file`), else the family's system face — or,
// where the document's faces split a run's characters by `unicode-range`, the stack of them registered as one face
// (`font::register_stack`). Kept per (stack, bucket) until the document's face list moves (`fontFacesHand`) or a download
// lands (`fontFetchLand`). A face whose download is under way has no file yet: the stack falls back past it, as text is
// laid out with the fallback through a face's block and swap periods (CSS Fonts 4 §4.9). The page side fetches what a
// source names, takes a face through its FontFaceSet's loading cycle, and names a family's system file.

use crate::dom::{realm, realm_id, register};
use crate::font_files::{face_file, FaceFile, Terminated};

// A face as the layout takes it: its handle (-1 for none it can measure with) and the `@font-face` overrides of the
// vertical metrics its file has (`ascent-override`, `descent-override`, `line-gap-override`, em fractions; none for a
// system face's).
pub(crate) type Resolved = (i32, [Option<f64>; 3]);

// What the page side does for the engine: `subresources(step, …)` a source's file fetched or looked up (font_files.rs,
// subresource-host.js), `settle(index, what)` the document's face `index` as it comes to something (`FACE_*`),
// `system(family, bucket)` the file fontconfig resolves a family's system face to (null for none) — and whether a script
// asked (`by_script`: FontFaceSet `load()`), which makes the face's set `loading` as it asks, where a load the layout
// begins makes it so a task later (Chrome and Firefox, csim-bench font7 `f1`, `f7`).
struct Host<'s> {
    subresources: v8::Local<'s, v8::Function>,
    settle: v8::Local<'s, v8::Function>,
    system: v8::Local<'s, v8::Function>,
    by_script: bool,
    // (…and whether this is a download's landing task, which settles what it asks about in it)
    landing: bool,
}
// What a face came to, as `settle` is told (font-metrics.js `settleFace`): its file failed, or loaded — there as it was
// first asked for, which its load settles a task later (CSS Font Loading "load()": "when the load operation completes …
// queue a task"), or as its download lands (`FACE_LANDED` with it), in the landing's task — or its download began.
const FACE_ERROR: u32 = 0;
const FACE_LOADED: u32 = 1;
const FACE_LOADING: u32 = 2;
const FACE_LOADING_BY_SCRIPT: u32 = 3;
const FACE_LANDED: u32 = 4;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "fontFamilyFace", font_family_face, context_id);
    register(scope, ns, "fontFamilyHandle", font_family_handle, context_id);
    register(scope, ns, "fontFaceFile", font_face_file, context_id);
    register(scope, ns, "fontFetchLand", font_fetch_land, context_id);
    register(scope, ns, "fontFacesWanted", font_faces_wanted, context_id);
    register(scope, ns, "fontFetchesForget", font_fetches_forget, context_id);
    register(scope, ns, "fontFetchesAbort", font_fetches_abort, context_id);
    register(scope, ns, "fontGeneration", font_generation, context_id);
}

// The file the document's face `index` is read from (`face_file`), asked once per face list: the face's set told what it
// came to the first time (`settle`) — its download begun, or its file there or not.
fn indexed_file(scope: &mut v8::PinScope<'_, '_>, cid: i32, index: usize, host: &Host<'_>) -> Result<FaceFile, Terminated> {
    let arena = realm(scope, cid);
    if let Some(Some(known)) = arena.face_files.get(index) {
        return Ok(known.clone());
    }
    let none = FaceFile::Settled { file: None, loaded: false };
    let Some(face) = arena.font_faces.get(index).cloned() else { return Ok(none) };
    let got = face_file(scope, cid, face.file.as_deref(), &face.sources, face.local_style(), face.referrer.as_deref(), face.usable_for, host.subresources, None)?;
    let files = &mut realm(scope, cid).face_files;
    if files.len() <= index {
        files.resize(index + 1, None);
    }
    files[index] = Some(got.clone());
    let what = match got {
        FaceFile::Pending if host.by_script => FACE_LOADING_BY_SCRIPT,
        FaceFile::Pending => FACE_LOADING,
        FaceFile::Settled { loaded, .. } => (if loaded { FACE_LOADED } else { FACE_ERROR }) | if host.landing { FACE_LANDED } else { 0 },
    };
    let args = [v8::Integer::new_from_unsigned(scope, index as u32).into(), v8::Integer::new_from_unsigned(scope, what).into()];
    call(scope, host.settle, &args)?;
    Ok(got)
}

// `f(args)` on the page side: the text it answers, none where it answers none or throws — Terminated where the script
// was.
fn call(scope: &mut v8::PinScope<'_, '_>, f: v8::Local<'_, v8::Function>, args: &[v8::Local<'_, v8::Value>]) -> Result<Option<String>, Terminated> {
    let undefined = v8::undefined(scope).into();
    v8::tc_scope!(let tc, scope);
    let answer = f.call(tc, undefined, args);
    if tc.has_terminated() {
        return Err(Terminated);
    }
    Ok(answer.filter(|v| v.is_string()).map(|v| v.to_rust_string_lossy(tc)))
}

// The file of a family's system face, as the page side names it.
fn system_file(scope: &mut v8::PinScope<'_, '_>, host: &Host<'_>, family: &str, bucket: &str) -> Result<Option<String>, Terminated> {
    let (Some(f), Some(b)) = (v8::String::new(scope, family), v8::String::new(scope, bucket)) else { return Ok(None) };
    call(scope, host.system, &[f.into(), b.into()])
}

// The face `family` takes at `bucket` (see the top of the file).
fn family_face(scope: &mut v8::PinScope<'_, '_>, cid: i32, family: &str, bucket: &str, host: &Host<'_>) -> Result<Resolved, Terminated> {
    if let Some(&known) = realm(scope, cid).family_faces.get(family).and_then(|by_bucket| by_bucket.get(bucket)) {
        return Ok(known);
    }
    let faces = realm(scope, cid).font_faces.clone();
    // (…a face whose `unicode-range` restricts it, which no character has asked for yet: loaded only once one does —
    // CSS Fonts 4 §4.5, "if the unicode-range of a font face does not cover any of the characters … it is not
    // downloaded", Chrome and Firefox csim-bench font7 `f10`, `u2` — a member of the split that asks as it is measured)
    let unasked = |arena: &crate::dom::RealmArena, k: usize| faces[k].ranges.is_some() && arena.face_files.get(k).is_none_or(Option::is_none);
    // (…the stack's own face: the one face of the first family that has any, where it has a file)
    let own = match crate::font_faces::pick(&faces, family, bucket, false).first() {
        Some(&k) if !unasked(realm(scope, cid), k) => indexed_file(scope, cid, k, host)?.file().map(|path| (k, path)),
        _ => None,
    };
    let overrides = own.as_ref().map_or([None; 3], |&(k, _)| faces[k].overrides);
    let mut handle = None;
    if faces.iter().any(|f| f.ranges.is_some()) {
        // The candidates a run's characters pick from — each character the FIRST whose range covers it, so a
        // `size-adjust` face scoped to A–Z reshapes only those glyphs — in pick order, the family's SYSTEM face the last
        // resort: Chrome never renders a code point through a face that excludes it.
        let mut candidates: Vec<(Option<usize>, Option<String>)> = Vec::new();
        let mut restricted = false;
        for k in crate::font_faces::pick(&faces, family, bucket, true) {
            if unasked(realm(scope, cid), k) {
                restricted = true;
                candidates.push((Some(k), None));
                continue;
            }
            let Some(path) = indexed_file(scope, cid, k, host)?.file() else { continue };
            restricted |= faces[k].ranges.is_some();
            candidates.push((Some(k), Some(path)));
        }
        if restricted {
            if let Some(path) = system_file(scope, host, family, bucket)?.filter(|p| crate::font::register_path(p) >= 0) {
                candidates.push((None, Some(path)));
            }
            handle = Some(stack_handle(cid, &faces, own.as_ref().map(|&(k, _)| k), &candidates));
        }
    }
    let handle = match handle {
        Some(h) => h,
        None => {
            let path = match &own {
                Some((_, path)) => Some(path.clone()),
                None => system_file(scope, host, family, bucket)?,
            };
            let h = path.map_or(-1, |p| crate::font::register_path(&p));
            own.as_ref().map_or(h, |&(k, _)| crate::font::register_scaled(h, faces[k].size_adjust))
        }
    };
    let resolved = (handle, overrides);
    realm(scope, cid).family_faces.entry(family.to_owned()).or_default().insert(bucket.to_owned(), resolved);
    Ok(resolved)
}

// A `unicode-range` split registered as one face: each candidate its own registered face — a downloaded one under its
// `size-adjust` — in pick order with its `@font-face` metric overrides (its vertical metrics raise the line a run's
// characters select it on, font.rs `run_vmax`) and its ranges. The stack's own face is the stack's primary — what a
// character no candidate covers is measured by, and what a `ch` is (style_fonts.rs) — or the system face, the candidate
// of no face, where it has none. -1 where any candidate has no file native reads, or none is the stack's own. A candidate
// of no file (`None`) is one no character has asked for: a member that asks as one does (`StackMember::wanted`).
fn stack_handle(cid: i32, faces: &[crate::font_faces::FaceRecord], own: Option<usize>, candidates: &[(Option<usize>, Option<String>)]) -> i32 {
    let mut primary = -1;
    let mut members = Vec::new();
    for (k, path) in candidates {
        let face = k.map(|k| &faces[k]);
        let ranges = face.and_then(|f| f.ranges.clone());
        let Some(path) = path else {
            members.push(crate::font::StackMember { ranges, handle: -1, vertical: None, wanted: k.map(|k| (cid, k)) });
            continue;
        };
        let h = crate::font::register_scaled(crate::font::register_path(path), face.map_or(1.0, |f| f.size_adjust));
        if h < 0 {
            return -1;
        }
        if *k == own && primary < 0 {
            primary = h;
        }
        let overrides = face.map_or([None; 3], |f| f.overrides);
        let vertical = crate::font::with_font(h, |fm| fm.face(overrides).map(|(v, _, _)| v)).flatten();
        members.push(crate::font::StackMember { ranges, handle: h, vertical, wanted: None });
    }
    crate::font::register_stack(primary, members)
}

// The functions of the page side's `Host`, from `args` at `at`, …
fn host<'s>(args: &v8::FunctionCallbackArguments<'s>, at: i32) -> Option<Host<'s>> {
    let f = |k: i32| v8::Local::<v8::Function>::try_from(args.get(at + k)).ok();
    Some(Host { subresources: f(0)?, settle: f(1)?, system: f(2)?, by_script: false, landing: false })
}

// __dom.fontFamilyFace(family, bucket, subresources, settle, system) -> `[handle, ascentOverride, descentOverride,
// lineGapOverride]` of the face `family` takes at `bucket` (`family_face`), NaN for an override it has none of.
fn font_family_face(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(host) = host(&args, 2) else { return };
    let (family, bucket) = (args.get(0).to_rust_string_lossy(scope), args.get(1).to_rust_string_lossy(scope));
    let cid = realm_id(scope, &args);
    let Ok((handle, overrides)) = family_face(scope, cid, &family, &bucket, &host) else { return };
    let values = [f64::from(handle), overrides[0].unwrap_or(f64::NAN), overrides[1].unwrap_or(f64::NAN), overrides[2].unwrap_or(f64::NAN)];
    let items: Vec<v8::Local<v8::Value>> = values.iter().map(|&v| v8::Number::new(scope, v).into()).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.fontFamilyHandle(family, bucket, subresources, settle, system) -> the handle alone (what a canvas's text op shapes
// with, asked on every one).
fn font_family_handle(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(host) = host(&args, 2) else { return };
    let (family, bucket) = (args.get(0).to_rust_string_lossy(scope), args.get(1).to_rust_string_lossy(scope));
    let cid = realm_id(scope, &args);
    if let Ok((handle, _)) = family_face(scope, cid, &family, &bucket, &host) {
        rv.set_int32(handle);
    }
}

// __dom.fontFaceFile(index, subresources, settle, system) -> the file the document's face `index` is read from
// (`indexed_file`), null where it has none native reads, undefined while its download is under way: a script's ask
// (FontFaceSet `load()`).
fn font_face_file(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(host) = host(&args, 1) else { return rv.set_null() };
    let host = Host { by_script: true, ..host };
    let index = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let cid = realm_id(scope, &args);
    let file = indexed_file(scope, cid, index, &host);
    crate::font_files::answer_file(scope, &mut rv, file);
}

// __dom.fontFetchLand(id, subresources, settle, system) -> the FontFaces whose `load()` the download `id` (font_files.rs; a
// host slot's number, where it has one) settles, `[face, loaded, …]`: CSS Font Loading "load()", "when the load operation completes … queue a task" — this
// task, the document's load waiting for it (bridge.entry.js `queueFontLand`). Its file kept (font_files.rs `land`), what the
// realm's faces read from moved: the faces each family stack takes forgotten, the layout due again (`GEN_DIRTY`) — text
// laid out with the fallback measured with the face now, where it came within its `font-display` periods — and every face
// of the document's list that reads from it asked about again, its set told what it came to (`indexed_file`: loaded or
// not, or the next of its sources begun); and each FontFace whose own `load()` waited asked again in turn.
fn font_fetch_land(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(host) = host(&args, 1) else { return };
    let host = Host { landing: true, ..host };
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let Ok(Some(landed)) = crate::font_files::land(scope, cid, id, host.subresources) else { return };
    let arena = realm(scope, cid);
    let reading: Vec<usize> = (0..arena.font_faces.len())
        .filter(|&k| arena.font_faces[k].sources.iter().any(|s| matches!(s, crate::font_faces::FaceSource::Url(u) if *u == landed.url)))
        .filter(|&k| !matches!(arena.face_files.get(k), Some(Some(FaceFile::Settled { .. }))))
        .collect();
    arena.face_files.clear();
    arena.family_faces.clear();
    arena.generations.bump(crate::dom::GEN_DIRTY);
    for k in reading {
        if indexed_file(scope, cid, k, &host).is_err() {
            return;
        }
    }
    let mut settled: Vec<v8::Local<v8::Value>> = Vec::new();
    for (face, state) in landed.waiters {
        let (face, state) = (v8::Local::new(scope, face), v8::Local::new(scope, state));
        let Some((file, sources, bucket, referrer)) = crate::font_face_state::load_inputs(scope, state.into()) else { continue };
        let Ok(got) = face_file(scope, cid, file.as_deref(), &sources, bucket, referrer.as_deref(), f64::INFINITY, host.subresources, Some((face, state))) else { return };
        if let FaceFile::Settled { loaded, .. } = got {
            settled.push(face.into());
            settled.push(v8::Boolean::new(scope, loaded).into());
        }
    }
    rv.set(v8::Array::new_with_elements(scope, &settled).into());
}

// __dom.fontFacesWanted(subresources, settle, system) -> whether a face's file was there at once: the faces of the realm's
// list a character measured has asked for since (font.rs `take_wanted`: a `unicode-range` face, loaded only once text
// uses it) asked for now — its load begun (`indexed_file`) — and the faces each family stack takes made again of them;
// one whose file was there at once moves what the realm's faces read from (the layout due again, as a landing does).
fn font_faces_wanted(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(false);
    let Some(host) = host(&args, 0) else { return };
    let cid = realm_id(scope, &args);
    let wanted = crate::font::take_wanted(cid);
    if wanted.is_empty() {
        return;
    }
    let mut there = false;
    for k in wanted {
        match indexed_file(scope, cid, k, &host) {
            Ok(got) => there |= got.file().is_some(),
            Err(Terminated) => return,
        }
    }
    let arena = realm(scope, cid);
    arena.family_faces.clear();
    if there {
        arena.font_files.generation = arena.font_files.generation.wrapping_add(1);
        arena.generations.bump(crate::dom::GEN_DIRTY);
    }
    rv.set_bool(there);
}

// __dom.fontFetchesForget(subresources) — the realm's downloads under way let go of: a new document begins in it.
fn font_fetches_forget(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(0)) else { return };
    let cid = realm_id(scope, &args);
    let _ = crate::font_files::drop_flights(scope, cid, host, false);
}
// __dom.fontFetchesAbort(subresources) -> the numbers of the realm's downloads under way, cancelled by its document's abort
// (HTML "abort a document": "cancel any instances of the fetch algorithm"): each to land at once as a network error, its
// faces failed — in a task, as their load's completion is (Firefox `st1`: `loading` after `stop()`, `error` a task later;
// Chrome errors them as it stops) — bridge.entry.js `wakeFontLands`.
fn font_fetches_abort(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(0)) else { return };
    let cid = realm_id(scope, &args);
    let Ok(ids) = crate::font_files::drop_flights(scope, cid, host, true) else { return };
    rv.set(crate::dom::f64_array(scope, &ids.into_iter().map(f64::from).collect::<Vec<_>>()).into());
}

// __dom.fontGeneration(set) -> the generation of what the realm's faces resolve by beside its rules: what its FontFaceSet
// `set` holds (font_face_set.rs, none for no set) and what its downloads gave (font_files.rs) — the sum, which moves as
// either does (each only counts up).
fn font_generation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let set = crate::font_face_set::set(scope, args.get(0)).map_or(0, crate::font_face_set::SetHandle::generation);
    let cid = realm_id(scope, &args);
    rv.set_double(f64::from(set) + f64::from(realm(scope, cid).font_files.generation));
}
