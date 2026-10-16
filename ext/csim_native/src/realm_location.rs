// A realm's URL — its document's, which its `Location` reflects (HTML §7.2.4: a Location object's url is its relevant
// document's URL) — as the parts each of the Location's getters reads (url_ops.rs `parts`' order), the origin a frame
// whose URL is opaque reports for it instead (`location.origin` "null" where the document's own origin is its
// parent's), and its document's target fragment: the fragment a load, a fragment navigation or a traversal scrolled to
// — not a history API URL change, which keeps it — from which `:target` resolves (HTML "the indicated part of the
// document"). The realm's for as long as it lives: a page load sets each anew.

use crate::dom::{nid_arg, realm, realm_id, register, NodeId, RealmArena};

pub(crate) struct RealmLocation {
    parts: [String; 11],
    origin_override: Option<String>,
    // (…none until something scrolled to one: the URL's own fragment is it until then)
    target_hash: Option<String>,
}

const HREF: usize = 0;
const PATHNAME: usize = 7;
const SEARCH: usize = 8;
const HASH: usize = 9;
const ORIGIN: usize = 10;

// A realm's URL until a document of its own sets one: a page reads `location.href` at module time.
const INITIAL_URL: &str = "http://www.example.com/";

impl Default for RealmLocation {
    fn default() -> Self {
        let url = ada_url::Url::parse(INITIAL_URL, None).expect("the initial URL parses");
        RealmLocation { parts: crate::url_ops::texts(&url), origin_override: None, target_hash: None }
    }
}

impl RealmLocation {
    // The realm's URL is `href` — where it is no URL, `href` its serialization, of a root path and no query nor fragment,
    // the rest as it was.
    fn set_url(&mut self, href: &str) {
        match ada_url::Url::parse(href, None) {
            Ok(url) => self.parts = crate::url_ops::texts(&url),
            Err(_) => {
                self.parts[HREF] = href.to_owned();
                self.parts[PATHNAME] = "/".to_owned();
                self.parts[SEARCH].clear();
                self.parts[HASH].clear();
            }
        }
    }
    // The fragments to look for the target element by: the target fragment as it stands, then percent-decoded and UTF-8
    // decoded (the one when they say the same) — none for an empty fragment.
    fn target_fragments(&self) -> Vec<String> {
        let hash = self.target_hash.as_deref().unwrap_or(&self.parts[HASH]);
        let raw = hash.strip_prefix('#').unwrap_or(hash);
        if raw.is_empty() {
            return Vec::new();
        }
        let decoded = percent_encoding::percent_decode_str(raw).decode_utf8_lossy();
        if decoded == raw { vec![raw.to_owned()] } else { vec![raw.to_owned(), decoded.into_owned()] }
    }
}

impl RealmArena {
    // The realm's target fragment is `hash` (none: the one it has) — and its document `doc`'s target, given one in the
    // arena, the element it indicates.
    fn retarget(&mut self, doc: Option<NodeId>, hash: Option<String>) {
        if hash.is_some() {
            self.location.target_hash = hash;
        }
        if let Some(doc) = doc {
            let fragments = self.location.target_fragments();
            self.set_target(doc, fragments);
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "locationPart", location_part, context_id);
    register(scope, ns, "setLocationURL", set_location_url, context_id);
    register(scope, ns, "setLocationOrigin", set_location_origin, context_id);
    register(scope, ns, "setTargetHash", set_target_hash, context_id);
}

// __dom.locationPart(part) -> the realm's URL's part number `part` (url_ops.rs `parts`' order) — its origin the one a
// frame's opaque URL reports, where one is set.
fn location_part(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let part = args.get(0).int32_value(scope).unwrap_or(0) as usize;
    let cid = realm_id(scope, &args);
    let location = &realm(scope, cid).location;
    let text = match &location.origin_override {
        Some(origin) if part == ORIGIN => origin.clone(),
        _ => location.parts.get(part).cloned().unwrap_or_default(),
    };
    let text = v8::String::new(scope, &text).unwrap();
    rv.set(text.into());
}

// __dom.setLocationURL(href) — the realm's URL is `href` (`RealmLocation::set_url`).
fn set_location_url(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let href = args.get(0).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    realm(scope, cid).location.set_url(&href);
}

// __dom.setLocationOrigin(origin) — the origin the realm's location reports, that of its document's opaque URL (null:
// its URL's own).
fn set_location_origin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let origin = (!args.get(0).is_null_or_undefined()).then(|| args.get(0).to_rust_string_lossy(scope));
    let cid = realm_id(scope, &args);
    realm(scope, cid).location.origin_override = origin;
}

// __dom.setTargetHash(docNid[, hash]) — the realm's target fragment is `hash`, as `location.hash` spells it (none: the
// one it has, the URL's until something scrolled to one), and its document's target (-1: none in the arena yet) the
// element it indicates.
fn set_target_hash(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let doc = nid_arg(scope, &args, 0);
    let hash = (args.length() > 1).then(|| args.get(1).to_rust_string_lossy(scope));
    let cid = realm_id(scope, &args);
    realm(scope, cid).retarget(doc, hash);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(href: &str) -> RealmLocation {
        let mut location = RealmLocation::default();
        location.set_url(href);
        location
    }

    #[test]
    fn a_fragment_is_looked_for_as_it_stands_then_decoded() {
        assert_eq!(at("http://a/#x").target_fragments(), ["x"]);
        assert_eq!(at("http://a/#%C3%A9").target_fragments(), ["%C3%A9", "é"]);
        assert!(at("http://a/#").target_fragments().is_empty());
        assert!(at("http://a/").target_fragments().is_empty());
        // (…a percent sign that escapes nothing kept, a byte that is no UTF-8 U+FFFD: URL "percent-decode", "UTF-8 decode")
        assert_eq!(at("http://a/#%zz%41").target_fragments(), ["%zz%41", "%zzA"]);
        assert_eq!(at("http://a/#%FF").target_fragments(), ["%FF", "\u{FFFD}"]);
    }

    #[test]
    fn a_target_hash_outlives_the_url() {
        let mut location = at("http://a/#x");
        location.target_hash = Some("#y".to_owned());
        location.set_url("http://a/#z");
        assert_eq!(location.target_fragments(), ["y"]);
    }

    #[test]
    fn no_url_keeps_the_rest() {
        let location = at("not a url");
        assert_eq!(location.parts[HREF], "not a url");
        assert_eq!(location.parts[PATHNAME], "/");
        assert_eq!(location.parts[ORIGIN], "http://www.example.com");
    }
}
