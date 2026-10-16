// The font files a realm's faces are read from, as its sources came to them: a downloaded face's URL fetched once, a
// `local()` name looked up once per weight / style — each the file it gave, or none (a 404, a broken file, no such
// font on this machine), so a relayout neither fetches nor asks fontconfig again. The realm's for as long as its
// context lives; which face a family takes is font_faces.rs's.

use std::collections::HashMap;

use crate::dom::{realm, realm_id, register};

// A source, by its kind (`URL`, `LOCAL`) and its key: the URL, or the name and the weight / style it was asked under.
#[derive(Default)]
pub(crate) struct FontFiles(HashMap<(u32, String), Option<String>>);

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "fontFile", font_file, context_id);
    register(scope, ns, "setFontFile", set_font_file, context_id);
}

// __dom.fontFile(kind, key) -> the file the source gave (null: none), or undefined where it was never tried.
fn font_file(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let kind = args.get(0).uint32_value(scope).unwrap_or(0);
    let key = args.get(1).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    let Some(file) = realm(scope, cid).font_files.0.get(&(kind, key)).cloned() else { return };
    match file.and_then(|f| v8::String::new(scope, &f)) {
        Some(path) => rv.set(path.into()),
        None => rv.set_null(),
    }
}

// __dom.setFontFile(kind, key, path) — the file the source gave, null for none.
fn set_font_file(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let kind = args.get(0).uint32_value(scope).unwrap_or(0);
    let key = args.get(1).to_rust_string_lossy(scope);
    let path = (!args.get(2).is_null_or_undefined()).then(|| args.get(2).to_rust_string_lossy(scope));
    let cid = realm_id(scope, &args);
    realm(scope, cid).font_files.0.insert((kind, key), path);
}
