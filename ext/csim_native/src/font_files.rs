// The font files a realm's faces are read from, as its sources came to them: a downloaded face's URL fetched once, a
// `local()` name looked up once per weight / style — each the file it gave, or none (a 404, a broken file, no such
// font on this machine), so a relayout neither fetches nor asks fontconfig again. The realm's for as long as its
// context lives; which face a family takes is font_faces.rs's.

use std::collections::HashMap;

use crate::dom::{realm, realm_id, register};

// A source, by its kind (`URL`, `LOCAL`) and its key: the URL, or the name and the weight / style it was asked under.
#[derive(Default)]
pub(crate) struct FontFiles(HashMap<(u32, String), Option<String>>);

// A source's kind, by number (font-metrics.js names them).
pub(crate) const URL: u32 = 0;
pub(crate) const LOCAL: u32 = 1;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "fontSourceFile", font_source_file, context_id);
    register(scope, ns, "fontFaceFile", font_face_file, context_id);
}

// The file a source gives that native reads (`font::register_path`, which keeps what it parsed), or none: asked of the
// page side's `fetch(kind, value, bucket)` — a download, or the font installed under a `local()` name at the weight /
// style `bucket` — once per source per realm, which a relayout asks again of no one. A `fetch` that throws gave none.
pub(crate) fn source_file(scope: &mut v8::PinScope<'_, '_>, cid: i32, kind: u32, value: &str, bucket: &str, fetch: v8::Local<'_, v8::Function>) -> Option<String> {
    let key = (kind, if kind == LOCAL { format!("{value}|{bucket}") } else { value.to_owned() });
    let known = realm(scope, cid).font_files.0.get(&key).cloned();
    let path = match known {
        Some(path) => path,
        None => {
            let args = [v8::Integer::new_from_unsigned(scope, kind).into(), v8::String::new(scope, value)?.into(), v8::String::new(scope, bucket)?.into()];
            let undefined = v8::undefined(scope).into();
            v8::tc_scope!(let tc, scope);
            let got = fetch.call(tc, undefined, &args).filter(|v| v.is_string()).map(|v| v.to_rust_string_lossy(tc));
            realm(tc, cid).font_files.0.insert(key, got.clone());
            got
        }
    };
    path.filter(|p| crate::font::register_path(p) >= 0)
}
// …whether a source was asked already and gave none (`Some(false)`), gave a file native reads (`Some(true)`), or was
// never asked (None).
pub(crate) fn source_tried(arena: &crate::dom::RealmArena, kind: u32, value: &str) -> Option<bool> {
    let path = arena.font_files.0.get(&(kind, value.to_owned()))?;
    Some(path.as_deref().is_some_and(|p| crate::font::register_path(p) >= 0))
}

// __dom.fontSourceFile(kind, value, bucket, fetch) -> the file the source gives that native reads, or null (`source_file`).
fn font_source_file(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(fetch) = v8::Local::<v8::Function>::try_from(args.get(3)) else { return rv.set_null() };
    let kind = args.get(0).uint32_value(scope).unwrap_or(URL);
    let (value, bucket) = (args.get(1).to_rust_string_lossy(scope), args.get(2).to_rust_string_lossy(scope));
    let cid = realm_id(scope, &args);
    match source_file(scope, cid, kind, &value, &bucket, fetch).and_then(|p| v8::String::new(scope, &p)) {
        Some(path) => rv.set(path.into()),
        None => rv.set_null(),
    }
}

// __dom.fontFaceFile(index, fetch) -> the file the document's face `index` is read from (font_faces.rs, the realm's
// list), or null where it has none native reads: a buffer face's own, else the first of its sources that gives one
// (`source_file`) — a browser tries each in turn: a `src` listing woff2, then woff, then ttf takes the first that comes;
// a `local()` name looked up at the weight / style the face's descriptors name.
fn font_face_file(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(fetch) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return rv.set_null() };
    let index = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let cid = realm_id(scope, &args);
    let Some(face) = realm(scope, cid).font_faces.get(index).cloned() else { return rv.set_null() };
    let file = match &face.file {
        Some(file) => Some(file.clone()).filter(|p| crate::font::register_path(p) >= 0),
        None => face.sources.iter().find_map(|source| match source {
            crate::font_faces::FaceSource::Url(url) => source_file(scope, cid, URL, url, "", fetch),
            crate::font_faces::FaceSource::Local(name) => source_file(scope, cid, LOCAL, name, face.local_style(), fetch),
        }),
    };
    match file.and_then(|p| v8::String::new(scope, &p)) {
        Some(path) => rv.set(path.into()),
        None => rv.set_null(),
    }
}
