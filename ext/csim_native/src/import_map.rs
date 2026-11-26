// Import maps (HTML §8.1.5.3): a `<script type="importmap">`'s JSON parsed — its `imports`, `scopes` and `integrity`, each
// key normalized (a URL-like one parsed against the map's base URL), each address parsed and refused where it is no URL
// or a prefix key's is no prefix — merged into the document's (a later map's entry for a key the map already has
// ignored, and so is one that would change how a specifier already resolved resolves), and a module specifier resolved
// through it: the scopes that cover the referrer's URL first, most specific first, then the top-level imports, an exact
// key or the longest prefix key (`foo/`), then the specifier as a URL — a bare one nothing maps a TypeError. The map and
// the resolved module set are the global's (module_map.rs `ModuleMap`).

use serde_json::Value;

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

// What "parse an import map string" throws, which registering the map reports: a SyntaxError for text that is no JSON, a
// TypeError for JSON that is no map — or whose `imports`, `scopes`, one of its scopes or `integrity` is none. (The JSON
// is serde_json's, stricter than the JSON.parse the spec names in two corners no import map is written in: a lone
// surrogate's escape, and nesting past 128 levels — each a SyntaxError here.)
#[derive(Debug, PartialEq)]
pub(crate) enum ParseError {
    Syntax,
    Type,
}

// "Parse an import map string".
pub(crate) fn parse(text: &str, base: &str) -> Result<ImportMap, ParseError> {
    let top = match serde_json::from_str(text) {
        Ok(Value::Object(top)) => top,
        Ok(_) => return Err(ParseError::Type),
        Err(_) => return Err(ParseError::Syntax),
    };
    fn object(v: &Value) -> Result<&serde_json::Map<String, Value>, ParseError> {
        v.as_object().ok_or(ParseError::Type)
    }
    let mut map = ImportMap::default();
    if let Some(imports) = top.get("imports") {
        map.imports = normalize_specifier_map(object(imports)?, base);
    }
    if let Some(scopes) = top.get("scopes") {
        for (prefix, imports) in object(scopes)? {
            // (…a scope that is no map throwing before a prefix that is no URL is skipped)
            let imports = object(imports)?;
            let Some(prefix) = parse_url(prefix, Some(base)) else { continue };
            // (…a later key for the same prefix replacing the earlier, as a map's set does)
            map.scopes.retain(|(p, _)| *p != prefix);
            map.scopes.push((prefix, normalize_specifier_map(imports, base)));
        }
        sort_map(&mut map.scopes);
    }
    if let Some(integrity) = top.get("integrity") {
        for (url, metadata) in object(integrity)? {
            let (Some(url), Some(metadata)) = (resolve_url_like(url, base), metadata.as_str()) else { continue };
            map.integrity.retain(|(u, _)| *u != url);
            map.integrity.push((url, metadata.to_owned()));
        }
    }
    Ok(map)
}

// A record of the global's resolved module set (HTML "specifier resolution record"): the base URL a specifier was resolved
// against, the specifier as resolution normalized it, and — its "specifier as a URL", which only matters as whether it is
// null or special — None for a bare one, else whether its URL is special.
#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct Resolved {
    base: String,
    specifier: String,
    special: Option<bool>,
}

// "Merge existing and new import maps": the new map's scopes, its integrity and its top-level imports merged into the
// existing map — an entry for a key the existing one already has ignored ("merge module specifier maps"), and so is one
// that would change how a specifier already resolved resolves: a scoped rule whose scope covers a resolved record's base
// URL and whose key is, or as a prefix covers, its specifier; a top-level rule whose key starts with a resolved specifier.
pub(crate) fn merge(existing: &mut ImportMap, mut new: ImportMap, resolved: &[Resolved]) {
    fn merge_map(into: &mut SpecifierMap, from: SpecifierMap) {
        for (key, address) in from {
            if !into.iter().any(|(k, _)| *k == key) {
                into.push((key, address));
            }
        }
        sort_map(into);
    }
    for (prefix, imports) in &mut new.scopes {
        for record in resolved {
            if *prefix == record.base || (prefix.ends_with('/') && record.base.starts_with(prefix.as_str())) {
                imports.retain(|(key, _)| {
                    !(*key == record.specifier || (key.ends_with('/') && record.specifier.starts_with(key.as_str()) && record.special != Some(false)))
                });
            }
        }
    }
    for (prefix, imports) in new.scopes {
        match existing.scopes.iter_mut().find(|(p, _)| *p == prefix) {
            Some((_, into)) => merge_map(into, imports),
            None => existing.scopes.push((prefix, imports)),
        }
    }
    sort_map(&mut existing.scopes);
    for (url, metadata) in new.integrity {
        if !existing.integrity.iter().any(|(u, _)| *u == url) {
            existing.integrity.push((url, metadata));
        }
    }
    new.imports.retain(|(key, _)| !resolved.iter().any(|record| key.starts_with(record.specifier.as_str())));
    merge_map(&mut existing.imports, new.imports);
}

// "Resolve an imports match": Some(Ok(url)) for a match, Some(Err(())) for a match blocked (a TypeError), None for none.
// (…`special` whether the specifier as a URL is special, None for a bare one)
fn imports_match(normalized: &str, special: Option<bool>, map: &SpecifierMap) -> Option<Result<String, ()>> {
    // (…a prefix key matching a bare specifier, or a URL-like one of a special scheme)
    let special = special != Some(false);
    for (key, address) in map {
        if key == normalized {
            return Some(address.clone().ok_or(()));
        }
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
// "Resolve a module specifier" against `base` (the referrer's URL): the URL, and the record the global's resolved module
// set adds — or None for a TypeError.
pub(crate) fn resolve(map: &ImportMap, specifier: &str, base: &str) -> Option<(String, Resolved)> {
    let as_url = resolve_url_like(specifier, base);
    let normalized = as_url.as_deref().unwrap_or(specifier);
    let special = as_url.as_deref().map(is_special);
    let record = || Resolved { base: base.to_owned(), specifier: normalized.to_owned(), special };
    for (prefix, imports) in &map.scopes {
        if prefix == base || (prefix.ends_with('/') && base.starts_with(prefix.as_str())) {
            if let Some(found) = imports_match(normalized, special, imports) {
                return found.ok().map(|url| (url, record()));
            }
        }
    }
    if let Some(found) = imports_match(normalized, special, &map.imports) {
        return found.ok().map(|url| (url, record()));
    }
    as_url.clone().map(|url| (url, record()))
}
fn is_special(url: &str) -> bool {
    ada_url::Url::parse(url, None).is_ok_and(|u| matches!(u.protocol(), "http:" | "https:" | "ws:" | "wss:" | "ftp:" | "file:"))
}
// "Resolve a module integrity metadata": the metadata the map gives `url`, '' for none.
pub(crate) fn integrity<'m>(map: &'m ImportMap, url: &str) -> &'m str {
    map.integrity.iter().find(|(u, _)| u == url).map_or("", |(_, m)| m)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(map: &ImportMap, specifier: &str, base: &str) -> Option<String> {
        resolve(map, specifier, base).map(|(url, _)| url)
    }

    #[test]
    fn specifiers_resolve_through_a_map_as_html_says() {
        let base = "https://a.test/app/index.html";
        let mut map = parse(r#"{"imports": {"lodash": "/js/lodash.js", "lib/": "./lib/", "bad/": "/nope", "": "/x"},
                                "scopes": {"/app/": {"lodash": "/js/lodash-app.js"}}}"#, base).unwrap();
        merge(&mut map, parse(r#"{"imports": {"lodash": "/js/other.js", "react": "https://cdn.test/react.js"}}"#, base).unwrap(), &[]);
        assert_eq!(url(&map, "lodash", "https://a.test/other.js").as_deref(), Some("https://a.test/js/lodash.js"));
        assert_eq!(url(&map, "lodash", base).as_deref(), Some("https://a.test/js/lodash-app.js"));
        assert_eq!(url(&map, "lib/x.js", "https://a.test/").as_deref(), Some("https://a.test/app/lib/x.js"));
        assert_eq!(url(&map, "react", "https://a.test/").as_deref(), Some("https://cdn.test/react.js"));
        assert_eq!(url(&map, "bad/y", "https://a.test/"), None);
        assert_eq!(url(&map, "./m.js", base).as_deref(), Some("https://a.test/app/m.js"));
        assert_eq!(url(&map, "unmapped", base), None);
        assert_eq!(parse("[]", base).err(), Some(ParseError::Type));
        assert_eq!(parse("{", base).err(), Some(ParseError::Syntax));
        assert_eq!(parse(r#"{"scopes": {"/a/": []}}"#, base).err(), Some(ParseError::Type));
        assert_eq!(parse(r#"{"scopes": {"http://[": []}}"#, base).err(), Some(ParseError::Type));
        // (…a key normalized to another's, the later in the source winning)
        let dup = parse(r#"{"imports": {"/js/a1.js": "/js/a1.js", "./a1.js": "/js/a2.js"}}"#, "https://a.test/js/").unwrap();
        assert_eq!(url(&dup, "/js/a1.js", "https://a.test/").as_deref(), Some("https://a.test/js/a2.js"));
    }

    #[test]
    fn a_later_map_changes_no_specifier_already_resolved() {
        let base = "https://a.test/app/index.html";
        let mut map = ImportMap::default();
        let (_, bare) = resolve(&parse(r#"{"imports": {"a": "/a1.js"}}"#, base).unwrap(), "a", base).unwrap();
        let (_, prefixed) = resolve(&parse(r#"{"imports": {"pkg/": "/pkg/"}}"#, base).unwrap(), "pkg/x.js", base).unwrap();
        let resolved = [bare, prefixed];
        merge(&mut map, parse(r#"{"imports": {"a": "/a2.js", "ab": "/ab.js", "b": "/b.js", "pkg/x.js": "/other.js"},
                                  "scopes": {"/app/": {"a": "/s.js", "pkg/": "/spkg/", "c": "/c.js"}, "/elsewhere/": {"a": "/e.js"}}}"#, base).unwrap(), &resolved);
        // (…top-level keys starting with a resolved specifier ignored — `a` and `ab` alike — the rest kept)
        assert_eq!(url(&map, "a", "https://a.test/x.js"), None);
        assert_eq!(url(&map, "ab", "https://a.test/x.js"), None);
        assert_eq!(url(&map, "b", "https://a.test/x.js").as_deref(), Some("https://a.test/b.js"));
        assert_eq!(url(&map, "pkg/x.js", "https://a.test/x.js"), None);
        // (…a scope covering the resolved base: its rule for the specifier, and its prefix rule covering one, ignored)
        assert_eq!(url(&map, "c", base).as_deref(), Some("https://a.test/c.js"));
        assert_eq!(url(&map, "pkg/y.js", base), None);
        assert_eq!(url(&map, "a", "https://a.test/elsewhere/z.js").as_deref(), Some("https://a.test/e.js"));
    }
}
