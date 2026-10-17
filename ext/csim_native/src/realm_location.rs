// A realm's URL — its document's, which its `Location` reflects (HTML §7.2.4: a Location object's url is its relevant
// document's URL) — as the parts each of the Location's getters reads (url_ops.rs `parts`' order), the origin a frame
// whose URL is opaque reports for it instead (`location.origin` "null" where the document's own origin is its
// parent's), and its document's target fragment: the fragment a load, a fragment navigation or a traversal scrolled to
// — not a history API URL change, which keeps it — from which `:target` resolves (HTML "the indicated part of the
// document"). And its document's origin where that is no origin of its URL's (`documentOrigin`): an opaque-URL frame's
// (about:blank, srcdoc, javascript:) is its creator's, a document sandboxed without allow-same-origin's an opaque one —
// and the key its origin is matched by (`originKey`), which for an opaque origin is the realm's own unless it inherited
// one. The realm's for as long as it lives: a page load sets each anew.

use crate::dom::{nid_arg, realm, realm_id, register, NodeId, RealmArena};

pub(crate) struct RealmLocation {
    parts: [String; 11],
    origin_override: Option<String>,
    // (…none until something scrolled to one: the URL's own fragment is it until then)
    target_hash: Option<String>,
    document_origin: Option<String>,
    origin_key: Option<String>,
    // Whether its document's origin is a NEW opaque one — sandboxed — which every frame it makes inherits.
    sandboxed: bool,
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
        RealmLocation {
            parts: crate::url_ops::texts(&url),
            origin_override: None,
            target_hash: None,
            document_origin: None,
            origin_key: None,
            sandboxed: false,
        }
    }
}

impl RealmLocation {
    // The realm's URL, serialized.
    pub(crate) fn href(&self) -> &str {
        &self.parts[HREF]
    }
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
    // The serialization of its document's origin: its own where it was given one, else its location's — "null" for an
    // opaque one.
    fn origin(&self) -> &str {
        self.document_origin.as_deref().or(self.origin_override.as_deref()).unwrap_or(&self.parts[ORIGIN])
    }
    // Its document's origin is `text`: an origin's serialization, "null" a new opaque one (sandboxed), `null|<key>` an
    // opaque one inherited with its key (a sandboxed creator's frame's) — none: its location's.
    fn set_document_origin(&mut self, text: Option<String>) {
        match text.as_deref().and_then(|t| t.strip_prefix("null|")) {
            Some(key) => {
                self.origin_key = Some(key.to_owned());
                self.document_origin = Some("null".to_owned());
            }
            None => {
                self.sandboxed |= text.as_deref() == Some("null");
                self.document_origin = text;
            }
        }
    }
    // The key its origin is matched by — what a BroadcastChannel is scoped to, a postMessage's target origin matched
    // against: a tuple origin's serialization, an opaque one's a token of the realm `cid` that has it (its own, made
    // the first time it is asked, unless it inherited one), so two unrelated opaque origins never match.
    fn origin_key(&mut self, cid: i32) -> String {
        if let Some(key) = &self.origin_key {
            return key.clone();
        }
        let origin = self.origin();
        if origin != "null" {
            return origin.to_owned();
        }
        self.origin_key.insert(format!("opaque:realm{cid}")).clone()
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
    register(scope, ns, "documentOrigin", document_origin, context_id);
    register(scope, ns, "setDocumentOrigin", set_document_origin, context_id);
    register(scope, ns, "originKey", origin_key, context_id);
    register(scope, ns, "realmOrigin", realm_origin, context_id);
    register(scope, ns, "realmOriginKey", realm_origin_key, context_id);
    register(scope, ns, "sameOriginRealm", same_origin_realm, context_id);
    register(scope, ns, "setOriginKey", set_origin_key, context_id);
    register(scope, ns, "sandboxedOrigin", sandboxed_origin, context_id);
}

// __dom.documentOrigin() -> the serialization of the calling realm's document's origin (`RealmLocation::origin`).
fn document_origin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let origin = realm(scope, cid).location.origin().to_owned();
    rv.set(v8::String::new(scope, &origin).unwrap().into());
}

// __dom.setDocumentOrigin(text) — the calling realm's document's origin (`set_document_origin`; null: its location's).
fn set_document_origin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let text = (!args.get(0).is_null_or_undefined()).then(|| args.get(0).to_rust_string_lossy(scope));
    let cid = realm_id(scope, &args);
    realm(scope, cid).location.set_document_origin(text);
}

// __dom.originKey() -> the key the calling realm's origin is matched by (`RealmLocation::origin_key`).
fn origin_key(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let key = realm(scope, cid).location.origin_key(cid);
    rv.set(v8::String::new(scope, &key).unwrap().into());
}

// …and realm `realm`'s, whichever realm asks — what a WindowProxy of another realm's window and a postMessage across
// realms compare: its origin's serialization, and its key (`origin_key`) — none for a realm dropped (its page torn
// down), or for an argument that is no realm's id. (A realm whose frame was discarded keeps its origin: a Window's
// outlives its browsing context.)
fn other_realm<R>(scope: &mut v8::PinScope<'_, '_>, realm_arg: v8::Local<'_, v8::Value>, read: impl FnOnce(&mut RealmLocation, i32) -> R) -> Option<R> {
    let realm = realm_arg.is_int32().then(|| realm_arg.int32_value(scope)).flatten()?;
    let arena = &mut crate::dom::dom(scope).arena;
    if arena.is_dropped(realm) {
        return None;
    }
    arena.realm_state_mut(realm).map(|st| read(&mut st.location, realm))
}
// __dom.realmOrigin(realm) -> realm `realm`'s document's origin, serialized ('' for none).
fn realm_origin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let origin = other_realm(scope, args.get(0), |l, _| l.origin().to_owned()).unwrap_or_default();
    rv.set(v8::String::new(scope, &origin).unwrap().into());
}
// __dom.realmOriginKey(realm) -> the key realm `realm`'s origin is matched by ('' for none).
fn realm_origin_key(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = other_realm(scope, args.get(0), |l, realm| l.origin_key(realm)).unwrap_or_default();
    rv.set(v8::String::new(scope, &key).unwrap().into());
}
// __dom.sameOriginRealm(realm) -> whether realm `realm`'s origin is the calling realm's — by their keys: an opaque
// origin is the same with the realms that share it alone (one that inherited it), never with another opaque one; false
// for a realm gone (fail CLOSED).
fn same_origin_realm(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let theirs = other_realm(scope, args.get(0), |l, realm| l.origin_key(realm));
    let cid = realm_id(scope, &args);
    let ours = realm(scope, cid).location.origin_key(cid);
    rv.set_bool(theirs.is_some_and(|k| k == ours));
}

// __dom.setOriginKey(key) — the key the calling realm's origin is matched by, inherited: a worker's, its creator's.
fn set_origin_key(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let key = (!args.get(0).is_null_or_undefined()).then(|| args.get(0).to_rust_string_lossy(scope));
    let cid = realm_id(scope, &args);
    realm(scope, cid).location.origin_key = key;
}

// __dom.sandboxedOrigin() -> whether the calling realm's document has a new opaque origin, sandboxed (`sandboxed`).
fn sandboxed_origin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_bool(realm(scope, cid).location.sandboxed);
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
    let hash = (!args.get(1).is_undefined()).then(|| args.get(1).to_rust_string_lossy(scope));
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
