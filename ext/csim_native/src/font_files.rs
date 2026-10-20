// The font files a realm's faces are read from, as its sources came to them: a downloaded face's URL fetched once, a
// `local()` name looked up once per weight / style — each the file it gave, or none (a 404, a broken file, no such
// font on this machine), so a relayout neither fetches nor asks fontconfig again. The realm's for as long as its
// context lives; which face a family takes is font_faces.rs's.

use std::collections::HashMap;

use crate::dom::{realm, realm_id, register};
use crate::font_faces::FaceSource;

// A source, by its kind (`URL`, `LOCAL`) and its key: the URL, or the name and the weight / style it was asked under.
#[derive(Default)]
pub(crate) struct FontFiles(HashMap<(u32, String), Option<String>>);

// A source's kind, by number (font-metrics.js names them).
pub(crate) const URL: u32 = 0;
pub(crate) const LOCAL: u32 = 1;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "fontFaceFile", font_face_file, context_id);
}

// The script was terminated while the page side was asked: nothing it answered is kept.
pub(crate) struct Terminated;

// The file a source gives that native reads (`font::register_path`, which keeps what it parsed), or none: asked of the
// page side's `fetch(kind, value, bucket)` — a download, or the font installed under a `local()` name at the weight /
// style `bucket` — once per source per realm, which a relayout asks again of no one. A `fetch` that throws gave none.
fn source_file(scope: &mut v8::PinScope<'_, '_>, cid: i32, source: &FaceSource, bucket: &str, fetch: v8::Local<'_, v8::Function>) -> Result<Option<String>, Terminated> {
    let (kind, value) = match source {
        FaceSource::Url(url) => (URL, url.as_str()),
        FaceSource::Local(name) => (LOCAL, name.as_str()),
    };
    let key = (kind, if kind == LOCAL { format!("{value}|{bucket}") } else { value.to_owned() });
    let known = realm(scope, cid).font_files.0.get(&key).cloned();
    let path = match known {
        Some(path) => path,
        None => {
            let (Some(v), Some(b)) = (v8::String::new(scope, value), v8::String::new(scope, bucket)) else { return Ok(None) };
            let args = [v8::Integer::new_from_unsigned(scope, kind).into(), v.into(), b.into()];
            let undefined = v8::undefined(scope).into();
            v8::tc_scope!(let tc, scope);
            let got = fetch.call(tc, undefined, &args);
            if tc.has_terminated() {
                return Err(Terminated);
            }
            let got = got.filter(|v| v.is_string()).map(|v| v.to_rust_string_lossy(tc));
            realm(tc, cid).font_files.0.insert(key, got.clone());
            got
        }
    };
    Ok(path.filter(|p| crate::font::register_path(p) >= 0))
}
// …and the file a face is read from: a buffer face's own `file`, else the first of its `sources` that gives one — a
// browser tries each in turn: a `src` listing woff2, then woff, then ttf takes the first that comes; a `local()` name
// looked up at the weight / style `bucket` its descriptors name.
pub(crate) fn face_file(
    scope: &mut v8::PinScope<'_, '_>,
    cid: i32,
    file: Option<&str>,
    sources: &[FaceSource],
    bucket: &str,
    fetch: v8::Local<'_, v8::Function>,
) -> Result<Option<String>, Terminated> {
    if let Some(file) = file {
        return Ok(Some(file.to_owned()).filter(|p| crate::font::register_path(p) >= 0));
    }
    for source in sources {
        if let Some(path) = source_file(scope, cid, source, bucket, fetch)? {
            return Ok(Some(path));
        }
    }
    Ok(None)
}
// …the answer an op gives of it: the path, null for none, nothing at all once the script is terminated.
pub(crate) fn answer_file(scope: &mut v8::PinScope<'_, '_>, rv: &mut v8::ReturnValue<'_, v8::Value>, file: Result<Option<String>, Terminated>) {
    match file {
        Ok(Some(path)) => match v8::String::new(scope, &path) {
            Some(path) => rv.set(path.into()),
            None => rv.set_null(),
        },
        Ok(None) => rv.set_null(),
        Err(Terminated) => {}
    }
}
// …whether a source was asked already and gave none (`Some(false)`), gave a file native reads (`Some(true)`), or was
// never asked (None).
pub(crate) fn source_tried(arena: &crate::dom::RealmArena, kind: u32, value: &str) -> Option<bool> {
    let path = arena.font_files.0.get(&(kind, value.to_owned()))?;
    Some(path.as_deref().is_some_and(|p| crate::font::register_path(p) >= 0))
}

// __dom.fontFaceFile(index, fetch) -> the file the document's face `index` is read from (font_faces.rs, the realm's
// list), or null where it has none native reads (`face_file`).
fn font_face_file(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(fetch) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return rv.set_null() };
    let index = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let cid = realm_id(scope, &args);
    let Some(face) = realm(scope, cid).font_faces.get(index).cloned() else { return rv.set_null() };
    let file = face_file(scope, cid, face.file.as_deref(), &face.sources, face.local_style(), fetch);
    answer_file(scope, &mut rv, file);
}
