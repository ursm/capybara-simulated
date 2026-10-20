// The face a family stack is measured with, at a weight / style bucket — what the layout measures a run with and a canvas
// shapes its text with: the document's `@font-face` the stack takes (font_faces.rs `pick`) under its `size-adjust`, read
// from the first of its sources that gives a file (font_files.rs `face_file`), else the family's system face — or,
// where the document's faces split a run's characters by `unicode-range`, the stack of them registered as one face
// (`font::register_stack`). Kept per (stack, bucket) until the document's face list moves (`fontFacesSet`). The page side
// fetches what a source names, settles a face in its FontFaceSet's loading cycle, and names a family's system file.

use crate::dom::{realm, realm_id, register};
use crate::font_files::{face_file, Terminated};

// A face as the layout takes it: its handle (-1 for none it can measure with) and the `@font-face` overrides of the
// vertical metrics its file has (`ascent-override`, `descent-override`, `line-gap-override`, em fractions; none for a
// system face's).
pub(crate) type Resolved = (i32, [Option<f64>; 3]);

// What the page side does for the engine: `fetch(kind, value, bucket)` a source's file (font_files.rs), `settle(index,
// ok)` the document's face `index` once its file is known, `system(family, bucket)` the file fontconfig resolves a
// family's system face to (null for none).
struct Host<'s> {
    fetch: v8::Local<'s, v8::Function>,
    settle: v8::Local<'s, v8::Function>,
    system: v8::Local<'s, v8::Function>,
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "fontFamilyFace", font_family_face, context_id);
    register(scope, ns, "fontFamilyHandle", font_family_handle, context_id);
    register(scope, ns, "fontFaceFile", font_face_file, context_id);
}

// The file the document's face `index` is read from (`face_file`), asked once per face list: the face settled by
// whether it has one the first time.
fn indexed_file(scope: &mut v8::PinScope<'_, '_>, cid: i32, index: usize, host: &Host<'_>) -> Result<Option<String>, Terminated> {
    let arena = realm(scope, cid);
    if let Some(Some(known)) = arena.face_files.get(index) {
        return Ok(known.clone());
    }
    let Some(face) = arena.font_faces.get(index).cloned() else { return Ok(None) };
    let file = face_file(scope, cid, face.file.as_deref(), &face.sources, face.local_style(), host.fetch)?;
    let files = &mut realm(scope, cid).face_files;
    if files.len() <= index {
        files.resize(index + 1, None);
    }
    files[index] = Some(file.clone());
    let args = [v8::Integer::new_from_unsigned(scope, index as u32).into(), v8::Boolean::new(scope, file.is_some()).into()];
    call(scope, host.settle, &args)?;
    Ok(file)
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
    // (…the stack's own face: the one face of the first family that has any, where it has a file)
    let own = match crate::font_faces::pick(&faces, family, bucket, false).first() {
        Some(&k) => indexed_file(scope, cid, k, host)?.map(|path| (k, path)),
        None => None,
    };
    let overrides = own.as_ref().map_or([None; 3], |&(k, _)| faces[k].overrides);
    let mut handle = None;
    if faces.iter().any(|f| f.ranges.is_some()) {
        // The candidates a run's characters pick from — each character the FIRST whose range covers it, so a
        // `size-adjust` face scoped to A–Z reshapes only those glyphs — in pick order, the family's SYSTEM face the last
        // resort: Chrome never renders a code point through a face that excludes it.
        let mut candidates: Vec<(Option<usize>, String)> = Vec::new();
        let mut restricted = false;
        for k in crate::font_faces::pick(&faces, family, bucket, true) {
            let Some(path) = indexed_file(scope, cid, k, host)? else { continue };
            restricted |= faces[k].ranges.is_some();
            candidates.push((Some(k), path));
        }
        if restricted {
            if let Some(path) = system_file(scope, host, family, bucket)?.filter(|p| crate::font::register_path(p) >= 0) {
                candidates.push((None, path));
            }
            handle = Some(stack_handle(&faces, own.as_ref().map(|&(k, _)| k), &candidates));
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
// of no face, where it has none. -1 where any candidate has no file native reads, or none is the stack's own.
fn stack_handle(faces: &[crate::font_faces::FaceRecord], own: Option<usize>, candidates: &[(Option<usize>, String)]) -> i32 {
    let mut primary = -1;
    let mut members = Vec::new();
    for (k, path) in candidates {
        let face = k.map(|k| &faces[k]);
        let h = crate::font::register_scaled(crate::font::register_path(path), face.map_or(1.0, |f| f.size_adjust));
        if h < 0 {
            return -1;
        }
        if *k == own && primary < 0 {
            primary = h;
        }
        let overrides = face.map_or([None; 3], |f| f.overrides);
        let vertical = crate::font::with_font(h, |fm| fm.face(overrides).map(|(v, _, _)| v)).flatten();
        members.push(crate::font::StackMember { ranges: face.and_then(|f| f.ranges.clone()), handle: h, vertical });
    }
    crate::font::register_stack(primary, members)
}

// The functions of the page side's `Host`, from `args` at `at`, …
fn host<'s>(args: &v8::FunctionCallbackArguments<'s>, at: i32) -> Option<Host<'s>> {
    let f = |k: i32| v8::Local::<v8::Function>::try_from(args.get(at + k)).ok();
    Some(Host { fetch: f(0)?, settle: f(1)?, system: f(2)? })
}

// __dom.fontFamilyFace(family, bucket, fetch, settle, system) -> `[handle, ascentOverride, descentOverride,
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

// __dom.fontFamilyHandle(family, bucket, fetch, settle, system) -> the handle alone (what a canvas's text op shapes
// with, asked on every one).
fn font_family_handle(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(host) = host(&args, 2) else { return };
    let (family, bucket) = (args.get(0).to_rust_string_lossy(scope), args.get(1).to_rust_string_lossy(scope));
    let cid = realm_id(scope, &args);
    if let Ok((handle, _)) = family_face(scope, cid, &family, &bucket, &host) {
        rv.set_int32(handle);
    }
}

// __dom.fontFaceFile(index, fetch, settle, system) -> the file the document's face `index` is read from (`indexed_file`),
// or null where it has none native reads.
fn font_face_file(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(host) = host(&args, 1) else { return rv.set_null() };
    let index = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let cid = realm_id(scope, &args);
    let file = indexed_file(scope, cid, index, &host);
    crate::font_files::answer_file(scope, &mut rv, file);
}
