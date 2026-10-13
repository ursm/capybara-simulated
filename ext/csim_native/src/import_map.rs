// Import maps (HTML §8.1.5.3): a `<script type="importmap">`'s JSON parsed — its `imports`, `scopes` and `integrity`, each
// key normalized (a URL-like one parsed against the map's base URL), each address parsed and refused where it is no URL
// or a prefix key's is no prefix — merged into the document's (a later map's entry for a key the map already has
// ignored), and a module specifier resolved through it: the scopes that cover the referrer's URL first, most specific
// first, then the top-level imports, an exact key or the longest prefix key (`foo/`), then the specifier as a URL — a
// bare one nothing maps a TypeError. One answer for the page's module loader (esm-loader.js) and the host's
// (`Native.import_map_resolve`), which kept their own exact-key lookups. The map travels as JSON between them.

use serde_json::{json, Value};

// A specifier map: (key, address — None for one refused), sorted by key, descending in code-unit order — so a longer
// prefix is tried before a shorter one.
type SpecifierMap = Vec<(String, Option<String>)>;

#[derive(Default)]
pub(crate) struct ImportMap {
    imports: SpecifierMap,
    // (scope prefix, its imports), the prefixes sorted as the keys are
    scopes: Vec<(String, SpecifierMap)>,
    // (module URL, integrity metadata)
    integrity: Vec<(String, String)>,
}

fn parse_url(input: &str, base: Option<&str>) -> Option<String> {
    ada_url::Url::parse(input, base).ok().map(|u| u.href().to_owned())
}
// "Resolve a URL-like module specifier": one starting `/`, `./` or `../` parsed against `base`, any other parsed as an
// absolute URL — None for one that is neither.
fn resolve_url_like(specifier: &str, base: &str) -> Option<String> {
    if specifier.starts_with('/') || specifier.starts_with("./") || specifier.starts_with("../") {
        return parse_url(specifier, Some(base));
    }
    parse_url(specifier, None)
}
// "Sort and normalize a specifier map".
fn normalize_specifier_map(map: &serde_json::Map<String, Value>, base: &str) -> SpecifierMap {
    let mut out: SpecifierMap = Vec::new();
    for (key, value) in map {
        // ("normalize a specifier key": none for '', a URL-like one its URL)
        if key.is_empty() {
            continue;
        }
        let key = resolve_url_like(key, base).unwrap_or_else(|| key.clone());
        let address = value
            .as_str()
            .and_then(|v| resolve_url_like(v, base))
            .filter(|a| !key.ends_with('/') || a.ends_with('/'));
        out.retain(|(k, _)| *k != key);
        out.push((key, address));
    }
    sort_map(&mut out);
    out
}
fn sort_map<T>(map: &mut [(String, T)]) {
    map.sort_by(|a, b| b.0.encode_utf16().cmp(a.0.encode_utf16()));
}

// "Parse an import map string": None where the text is no JSON object (a TypeError a page's `onerror` reports).
pub(crate) fn parse(text: &str, base: &str) -> Option<ImportMap> {
    let Value::Object(top) = serde_json::from_str(text).ok()? else { return None };
    let mut map = ImportMap::default();
    if let Some(imports) = top.get("imports") {
        map.imports = normalize_specifier_map(imports.as_object()?, base);
    }
    if let Some(scopes) = top.get("scopes") {
        for (prefix, imports) in scopes.as_object()? {
            let Some(prefix) = parse_url(prefix, Some(base)) else { continue };
            map.scopes.push((prefix, normalize_specifier_map(imports.as_object()?, base)));
        }
        sort_map(&mut map.scopes);
    }
    if let Some(integrity) = top.get("integrity") {
        for (url, metadata) in integrity.as_object()? {
            let (Some(url), Some(metadata)) = (resolve_url_like(url, base), metadata.as_str()) else { continue };
            map.integrity.push((url, metadata.to_owned()));
        }
    }
    Some(map)
}

// "Merge existing and new import maps": the new map's entries added where the existing one has none for the key — the
// existing entry wins — scope by scope, and the top-level imports and the integrity alike.
pub(crate) fn merge(existing: &mut ImportMap, new: ImportMap) {
    fn merge_map(into: &mut SpecifierMap, from: SpecifierMap) {
        for (key, address) in from {
            if !into.iter().any(|(k, _)| *k == key) {
                into.push((key, address));
            }
        }
        sort_map(into);
    }
    for (prefix, imports) in new.scopes {
        match existing.scopes.iter_mut().find(|(p, _)| *p == prefix) {
            Some((_, into)) => merge_map(into, imports),
            None => existing.scopes.push((prefix, imports)),
        }
    }
    sort_map(&mut existing.scopes);
    merge_map(&mut existing.imports, new.imports);
    for (url, metadata) in new.integrity {
        if !existing.integrity.iter().any(|(u, _)| *u == url) {
            existing.integrity.push((url, metadata));
        }
    }
}

// "Resolve an imports match": Some(Ok(url)) for a match, Some(Err(())) for a match blocked (a TypeError), None for none.
fn imports_match(normalized: &str, as_url: Option<&str>, map: &SpecifierMap) -> Option<Result<String, ()>> {
    for (key, address) in map {
        if key == normalized {
            return Some(address.clone().ok_or(()));
        }
        let special = as_url.is_none_or(|u| ada_url::Url::parse(u, None).is_ok_and(|u| matches!(u.protocol(), "http:" | "https:" | "ws:" | "wss:" | "ftp:" | "file:")));
        if key.ends_with('/') && normalized.starts_with(key.as_str()) && special {
            let Some(address) = address else { return Some(Err(())) };
            let after = &normalized[key.len()..];
            return Some(match parse_url(after, Some(address)) {
                Some(url) if url.starts_with(address.as_str()) => Ok(url),
                _ => Err(()),
            });
        }
    }
    None
}
// "Resolve a module specifier" against `base` (the referrer's URL): the URL, or None for a TypeError.
pub(crate) fn resolve(map: &ImportMap, specifier: &str, base: &str) -> Option<String> {
    let as_url = resolve_url_like(specifier, base);
    let normalized = as_url.as_deref().unwrap_or(specifier);
    for (prefix, imports) in &map.scopes {
        if prefix == base || (prefix.ends_with('/') && base.starts_with(prefix.as_str())) {
            if let Some(found) = imports_match(normalized, as_url.as_deref(), imports) {
                return found.ok();
            }
        }
    }
    if let Some(found) = imports_match(normalized, as_url.as_deref(), &map.imports) {
        return found.ok();
    }
    as_url
}
// "Resolve a module integrity metadata": the metadata the map gives `url`, '' for none.
pub(crate) fn integrity<'m>(map: &'m ImportMap, url: &str) -> &'m str {
    map.integrity.iter().find(|(u, _)| u == url).map_or("", |(_, m)| m)
}

// ── as JSON, between the page's loader and the host's ──
fn map_json(map: &SpecifierMap) -> Value {
    Value::Array(map.iter().map(|(k, a)| json!([k, a])).collect())
}
fn map_of(value: &Value) -> SpecifierMap {
    value
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|e| Some((e.get(0)?.as_str()?.to_owned(), e.get(1)?.as_str().map(str::to_owned))))
                .collect()
        })
        .unwrap_or_default()
}
pub(crate) fn to_json(map: &ImportMap) -> String {
    json!({
        "imports": map_json(&map.imports),
        "scopes": map.scopes.iter().map(|(p, m)| json!([p, map_json(m)])).collect::<Vec<_>>(),
        "integrity": map.integrity.iter().map(|(u, m)| json!([u, m])).collect::<Vec<_>>(),
    })
    .to_string()
}
pub(crate) fn from_json(text: &str) -> ImportMap {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return ImportMap::default() };
    ImportMap {
        imports: map_of(&v["imports"]),
        scopes: v["scopes"]
            .as_array()
            .map(|s| s.iter().filter_map(|e| Some((e.get(0)?.as_str()?.to_owned(), map_of(e.get(1)?)))).collect())
            .unwrap_or_default(),
        integrity: v["integrity"]
            .as_array()
            .map(|s| s.iter().filter_map(|e| Some((e.get(0)?.as_str()?.to_owned(), e.get(1)?.as_str()?.to_owned()))).collect())
            .unwrap_or_default(),
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "importMapMerge", merge_op, context_id);
    crate::dom::register(scope, ns, "importMapResolve", resolve_op, context_id);
    crate::dom::register(scope, ns, "importMapIntegrity", integrity_op, context_id);
}
fn text(scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>) -> String {
    if v.is_null_or_undefined() { String::new() } else { v.to_rust_string_lossy(scope) }
}
fn string_or_null(scope: &mut v8::PinScope<'_, '_>, rv: &mut v8::ReturnValue<'_, v8::Value>, s: Option<&str>) {
    match s.and_then(|s| v8::String::new(scope, s)) {
        Some(s) => rv.set(s.into()),
        None => rv.set_null(),
    }
}
// __dom.importMapMerge(existing, text, base) -> the document's map (JSON; null `existing` an empty one) with the map
// `text` parses to against `base` merged in — or null where `text` is no import map.
fn merge_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (existing, map_text, base) = (text(scope, args.get(0)), text(scope, args.get(1)), text(scope, args.get(2)));
    let Some(new) = parse(&map_text, &base) else { return rv.set_null() };
    let mut map = from_json(&existing);
    merge(&mut map, new);
    let json = to_json(&map);
    string_or_null(scope, &mut rv, Some(&json));
}
// __dom.importMapResolve(map, specifier, base) -> the URL `specifier` resolves to through the map (JSON), or null for a
// TypeError.
fn resolve_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (map, specifier, base) = (text(scope, args.get(0)), text(scope, args.get(1)), text(scope, args.get(2)));
    let url = resolve(&from_json(&map), &specifier, &base);
    string_or_null(scope, &mut rv, url.as_deref());
}
// __dom.importMapIntegrity(map, url) -> `integrity`.
fn integrity_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (map, url) = (text(scope, args.get(0)), text(scope, args.get(1)));
    let map = from_json(&map);
    string_or_null(scope, &mut rv, Some(integrity(&map, &url)));
}
// Capybara::Simulated::Native.import_map_resolve(map, specifier, base) -> `resolve`, nil for a TypeError; and
// .import_map_integrity(map, url).
pub(crate) fn resolve_for_ruby(map: String, specifier: String, base: String) -> Option<String> {
    resolve(&from_json(&map), &specifier, &base)
}
pub(crate) fn integrity_for_ruby(map: String, url: String) -> String {
    integrity(&from_json(&map), &url).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specifiers_resolve_through_a_map_as_html_says() {
        let base = "https://a.test/app/index.html";
        let mut map = parse(r#"{"imports": {"lodash": "/js/lodash.js", "lib/": "./lib/", "bad/": "/nope", "": "/x"},
                                "scopes": {"/app/": {"lodash": "/js/lodash-app.js"}}}"#, base).unwrap();
        merge(&mut map, parse(r#"{"imports": {"lodash": "/js/other.js", "react": "https://cdn.test/react.js"}}"#, base).unwrap());
        assert_eq!(resolve(&map, "lodash", "https://a.test/other.js").as_deref(), Some("https://a.test/js/lodash.js"));
        assert_eq!(resolve(&map, "lodash", base).as_deref(), Some("https://a.test/js/lodash-app.js"));
        assert_eq!(resolve(&map, "lib/x.js", "https://a.test/").as_deref(), Some("https://a.test/app/lib/x.js"));
        assert_eq!(resolve(&map, "react", "https://a.test/").as_deref(), Some("https://cdn.test/react.js"));
        assert_eq!(resolve(&map, "bad/y", "https://a.test/"), None);
        assert_eq!(resolve(&map, "./m.js", base).as_deref(), Some("https://a.test/app/m.js"));
        assert_eq!(resolve(&map, "unmapped", base), None);
        let back = from_json(&to_json(&map));
        assert_eq!(resolve(&back, "lodash", base).as_deref(), Some("https://a.test/js/lodash-app.js"));
        assert!(parse("[]", base).is_none());
    }
}
