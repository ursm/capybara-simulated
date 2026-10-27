// The font files a realm's faces are read from, as its sources came to them: a downloaded face's URL fetched once, a
// `local()` name looked up once per weight / style — each the file it gave, or none (a 404, a broken file, no such
// font on this machine), so a relayout neither fetches nor asks fontconfig again. The realm's for as long as its
// context lives; which face a family takes is font_resolve.rs's.

use std::collections::HashMap;

use crate::dom::realm;
use crate::font_faces::FaceSource;

// A source, by its kind (`URL`, `LOCAL`) and its key: the URL, or the name and the weight / style it was asked under.
#[derive(Default)]
pub(crate) struct FontFiles(HashMap<(u32, String), Option<String>>);

// A source's kind, by number, as its file is kept by.
pub(crate) const URL: u32 = 0;
const LOCAL: u32 = 1;

// The script was terminated while the page side was asked: nothing it answered is kept.
pub(crate) struct Terminated;

// The file a source gives that native reads (`font::register_path`, which keeps what it parsed), or none — a download
// (subresource_obtain.rs `font_file`), requested with the face's `referrer` where it has one (a rule's:
// `FaceRecord::referrer`), or the font installed under a `local()` name at the weight / style `bucket`, which the page
// side's `host` names (subresource-host.js) — once per source per realm, which a relayout asks again of no one.
fn source_file(
    scope: &mut v8::PinScope<'_, '_>,
    cid: i32,
    source: &FaceSource,
    bucket: &str,
    referrer: Option<&str>,
    host: v8::Local<'_, v8::Function>,
) -> Result<Option<String>, Terminated> {
    let (kind, value) = match source {
        FaceSource::Url(url) => (URL, url.as_str()),
        FaceSource::Local(name) => (LOCAL, name.as_str()),
    };
    let key = (kind, if kind == LOCAL { format!("{value}|{bucket}") } else { value.to_owned() });
    let known = realm(scope, cid).font_files.0.get(&key).cloned();
    let path = match known {
        Some(path) => path,
        None => {
            let got = match source {
                FaceSource::Url(url) => crate::subresource_obtain::font_file(scope, cid, url, referrer, host)?,
                FaceSource::Local(name) => {
                    let (Some(v), Some(b)) = (v8::String::new(scope, name), v8::String::new(scope, bucket)) else { return Ok(None) };
                    let got = crate::subresource_obtain::call(scope, host, crate::subresource_obtain::H_LOCAL_FONT, &[v.into(), b.into()])?;
                    got.map(|g| v8::Local::new(scope, g)).filter(|g| g.is_string()).map(|g| g.to_rust_string_lossy(scope))
                }
            };
            realm(scope, cid).font_files.0.insert(key, got.clone());
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
    referrer: Option<&str>,
    host: v8::Local<'_, v8::Function>,
) -> Result<Option<String>, Terminated> {
    if let Some(file) = file {
        return Ok(Some(file.to_owned()).filter(|p| crate::font::register_path(p) >= 0));
    }
    for source in sources {
        if let Some(path) = source_file(scope, cid, source, bucket, referrer, host)? {
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
