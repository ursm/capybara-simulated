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
    // Its document's active sandboxing flag set (sandbox.rs), which every frame it makes inherits — its origin a NEW
    // opaque one where that has the sandboxed origin flag.
    pub(crate) sandbox: u32,
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
            sandbox: 0,
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
    pub(crate) fn origin(&self) -> &str {
        self.document_origin.as_deref().unwrap_or(self.url_origin())
    }
    // …and its location's: its URL's origin — a creator's, where it inherited one (about:blank) — whatever a sandbox
    // made of its document's: the host it was served from.
    pub(crate) fn url_origin(&self) -> &str {
        self.origin_override.as_deref().unwrap_or(&self.parts[ORIGIN])
    }
    // Its document's origin is `text`: an origin's serialization, "null" a new opaque one (sandboxed), `null|<key>` an
    // opaque one inherited with its key (an opaque creator's frame's) — none: its location's.
    fn set_document_origin(&mut self, text: Option<String>) {
        match text.as_deref().and_then(|t| t.strip_prefix("null|")) {
            Some(key) => {
                self.origin_key = Some(key.to_owned());
                self.document_origin = Some("null".to_owned());
            }
            None => self.document_origin = text,
        }
    }
    // Its document's sandboxing is `flags` — its origin a new opaque one where they have the sandboxed origin flag.
    fn set_sandbox(&mut self, flags: u32) {
        self.sandbox = flags;
        if self.sandboxed_origin() {
            self.document_origin = Some("null".to_owned());
        }
    }
    // Whether its document's origin is a new opaque one its sandboxing made.
    pub(crate) fn sandboxed_origin(&self) -> bool {
        self.sandbox & crate::sandbox::ORIGIN != 0
    }
    // The key its origin is matched by — what a BroadcastChannel is scoped to, a postMessage's target origin matched
    // against: a tuple origin's serialization, an opaque one's a token of the realm `cid` that has it (its own, made
    // the first time it is asked, unless it inherited one), so two unrelated opaque origins never match.
    pub(crate) fn origin_key(&mut self, cid: i32) -> String {
        if let Some(key) = &self.origin_key {
            return key.clone();
        }
        let origin = self.origin();
        if origin != "null" {
            return origin.to_owned();
        }
        self.origin_key.insert(format!("{OPAQUE_KEY}realm{cid}")).clone()
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
    register(scope, ns, "opaqueOriginCause", opaque_origin_cause, context_id);
    register(scope, ns, "frameOrigins", frame_origins_op, context_id);
    register(scope, ns, "cspSandboxing", csp_sandboxing, context_id);
    register(scope, ns, "popupOrigins", popup_origins_op, context_id);
    register(scope, ns, "setSandbox", set_sandbox, context_id);
    register(scope, ns, "takeOpenerOrigins", take_opener_origins, context_id);
    register(scope, ns, "sandbox", sandbox, context_id);
    register(scope, ns, "setDocumentOrigin", set_document_origin, context_id);
    register(scope, ns, "originKey", origin_key, context_id);
    register(scope, ns, "originStorageKey", origin_storage_key, context_id);
    register(scope, ns, "keyOrigin", key_origin, context_id);
    register(scope, ns, "realmOrigin", realm_origin, context_id);
    register(scope, ns, "realmOriginKey", realm_origin_key, context_id);
    register(scope, ns, "sameOriginRealm", same_origin_realm, context_id);
    register(scope, ns, "setOriginKey", set_origin_key, context_id);
    register(scope, ns, "effectiveDomain", effective_domain_op, context_id);
    register(scope, ns, "setDomain", set_domain_op, context_id);
    register(scope, ns, "ipHost", ip_host_op, context_id);
    register(scope, ns, "registrableDomainSuffix", registrable_domain_suffix_op, context_id);
}

// __dom.documentOrigin() -> the serialization of the calling realm's document's origin (`RealmLocation::origin`).
fn document_origin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let origin = realm(scope, cid).location.origin().to_owned();
    rv.set(v8::String::new(scope, &origin).unwrap().into());
}
// __dom.opaqueOriginCause() -> why the calling realm's document's origin is opaque, as a refusal of its storage or its
// cookies tells it: 0 it is not, 1 its document is sandboxed — first, whatever its URL — 2 its URL is a `data:` one's,
// 3 it inherited one (an about:blank frame of a `data:` document).
fn opaque_origin_cause(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let location = &realm(scope, cid).location;
    let cause = if location.origin() != "null" {
        0
    } else if location.sandboxed_origin() {
        1
    } else if location.href().get(..5).is_some_and(|s| s.eq_ignore_ascii_case("data:")) {
        2
    } else {
        3
    };
    rv.set_uint32(cause);
}

// What a document realm `cid`'s document creates is seeded with before it loads: its sandboxing flag set (sandbox.rs),
// and its two origins, None for each it takes from its URL —
//   its document's (HTML "determine the origin"): a new opaque one ("null") where its sandboxing has the sandboxed
//   origin flag; else, inherited from this document — an opaque one with its key (`null|<key>`), which no serialization
//   carries — for an about: or javascript: URL, or a blob: URL this realm made (the origin of the document that made
//   it); else its URL's;
//   its location's (`location.origin`): "null" for an opaque URL — about:, javascript:, none — though the document's is
//   inherited; else its URL's, sandboxed or not.
#[derive(Debug, PartialEq)]
pub(crate) struct Creation {
    pub(crate) document: Option<String>,
    pub(crate) location: Option<&'static str>,
    pub(crate) sandbox: u32,
}
fn creation(arena: &mut RealmArena, cid: i32, url: &str, sandbox: u32) -> Creation {
    let scheme = |s: &str| url.get(..s.len()).is_some_and(|p| p.eq_ignore_ascii_case(s));
    let opaque_url = url.is_empty() || scheme("about:") || scheme("javascript:");
    let own_blob = scheme("blob:") && arena.blob_urls.made_by(url, cid);
    let location = &mut arena.location;
    let document = if sandbox & crate::sandbox::ORIGIN != 0 {
        Some("null".to_owned())
    } else if opaque_url || own_blob {
        let origin = location.origin().to_owned();
        Some(if origin == "null" { format!("null|{}", location.origin_key(cid)) } else { origin })
    } else {
        None
    };
    Creation { document, location: opaque_url.then_some("null"), sandbox }
}
// …a frame's, loading `url` ('' for none: about:blank), its container's `sandbox` attribute `sandbox` and its response's
// Content-Security-Policy `csp` (None for none): sandboxed by either, and by this document, whose flags every frame it
// makes takes on (HTML "determine the creation sandboxing flags").
pub(crate) fn frame_origins(arena: &mut RealmArena, cid: i32, url: &str, sandbox: Option<&str>, csp: Option<&str>) -> Creation {
    let flags = arena.location.sandbox | crate::sandbox::sandboxing(csp, sandbox);
    creation(arena, cid, url, flags)
}
// …and an about:blank popup's: sandboxed as this document is where its sandbox propagates to the auxiliary browsing
// contexts it opens — no `allow-popups-to-escape-sandbox` — else not at all, its origin then this document's.
pub(crate) fn popup_origins(arena: &mut RealmArena, cid: i32) -> Creation {
    let own = arena.location.sandbox;
    let flags = if own & crate::sandbox::PROPAGATES_TO_AUXILIARY != 0 { own } else { 0 };
    creation(arena, cid, "", flags)
}
// __dom.cspSandboxing(csp) -> the sandboxing flags a document whose response's Content-Security-Policy is `csp` has —
// a top-level document's, which no container sandboxes.
fn csp_sandboxing(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let csp = args.get(0).to_rust_string_lossy(scope);
    rv.set_uint32(crate::sandbox::sandboxing(Some(&csp), None));
}
// `[document, location, sandbox]` of a `Creation`, each origin null for its URL's.
fn creation_value<'s>(scope: &mut v8::PinScope<'s, '_>, created: Creation) -> v8::Local<'s, v8::Value> {
    let mut items: Vec<v8::Local<v8::Value>> = Vec::new();
    for text in [created.document.as_deref(), created.location] {
        items.push(match text.and_then(|t| v8::String::new(scope, t)) {
            Some(t) => t.into(),
            None => v8::null(scope).into(),
        });
    }
    items.push(v8::Integer::new_from_unsigned(scope, created.sandbox).into());
    v8::Array::new_with_elements(scope, &items).into()
}
// __dom.frameOrigins(url, sandbox, csp) -> `frame_origins`.
fn frame_origins_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = |scope: &mut v8::PinScope<'_, '_>, i: i32| (!args.get(i).is_null_or_undefined()).then(|| args.get(i).to_rust_string_lossy(scope));
    let url = text(scope, 0).unwrap_or_default();
    let (sandbox, csp) = (text(scope, 1), text(scope, 2));
    let cid = realm_id(scope, &args);
    let created = frame_origins(realm(scope, cid), cid, &url, sandbox.as_deref(), csp.as_deref());
    let value = creation_value(scope, created);
    rv.set(value);
}
// __dom.popupOrigins() -> `popup_origins`.
fn popup_origins_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let created = popup_origins(realm(scope, cid), cid);
    let value = creation_value(scope, created);
    rv.set(value);
}
// __dom.setSandbox(flags) — the calling realm's document's active sandboxing flag set, before it loads
// (`RealmLocation::set_sandbox`).
fn set_sandbox(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let flags = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    realm(scope, cid).location.set_sandbox(flags);
}
// __dom.takeOpenerOrigins(opener) — the calling realm's about:blank popup document seeded from the document of realm
// `opener` that opened it (`popup_origins`): its two origins and its sandboxing.
fn take_opener_origins(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let opener = args.get(0).int32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let created = popup_origins(realm(scope, opener), opener);
    let location = &mut realm(scope, cid).location;
    location.set_sandbox(created.sandbox);
    location.set_document_origin(created.document);
    location.origin_override = created.location.map(str::to_owned);
}
// __dom.sandbox() -> the calling realm's document's active sandboxing flag set.
fn sandbox(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_uint32(realm(scope, cid).location.sandbox);
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

// What an opaque origin's key begins with.
const OPAQUE_KEY: &str = "opaque:";

// __dom.originStorageKey() -> the realm's storage key ("obtain a storage key"): its origin's key — null for an opaque
// origin (a sandboxed frame's, a data: worker's), whose every storage request (IndexedDB, Cache Storage, Web Locks) is
// a SecurityError.
fn origin_storage_key(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let key = realm(scope, cid).location.origin_key(cid);
    if key.starts_with(OPAQUE_KEY) {
        return rv.set_null();
    }
    rv.set(v8::String::new(scope, &key).unwrap().into());
}

// __dom.keyOrigin(key) -> the origin an origin key serializes (what MessageEvent.origin exposes): "null" for an opaque
// one's, a tuple origin's itself, '' for none.
fn key_origin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = if args.get(0).is_string() { args.get(0).to_rust_string_lossy(scope) } else { String::new() };
    let origin = if key.starts_with(OPAQUE_KEY) { "null" } else { &key };
    rv.set(v8::String::new(scope, origin).unwrap().into());
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

// An origin's effective domain (HTML §7.5.2): `domain`, the one a `document.domain` write set, else its host — None
// for an opaque origin (serialized "null", or none at all).
pub(crate) fn effective_domain(origin: &str, domain: Option<&str>) -> Option<String> {
    if origin.is_empty() || origin == "null" {
        return None;
    }
    domain.map(str::to_owned).or_else(|| ada_url::Url::parse(origin, None).ok().map(|u| u.hostname().to_owned()))
}
// Whether `host` is an IP address — an IPv6 one in its brackets, as a URL's host serializes it.
pub(crate) fn ip_host(host: &str) -> bool {
    host.starts_with('[') || host.parse::<std::net::Ipv4Addr>().is_ok()
}
// A host's public suffix (URL §3.2: the Public Suffix List's, a TLD it does not list its own — the `*` rule) and its
// registrable domain, that suffix and the label before it — none for an IP address, nor the latter for a host that is
// a public suffix itself; a host's trailing dot theirs too (`example.com.`'s are `com.` and `example.com.`), which the
// list's lookup drops — and none for a host whose last label is empty after it (`example.com..`: its own site, Chrome
// measured).
fn public_suffix(host: &str) -> Option<String> {
    listed(host).then(|| psl::suffix_str(host)).flatten().map(|s| with_trailing_dot(host, s))
}
fn registrable_domain(host: &str) -> Option<String> {
    listed(host).then(|| psl::domain_str(host)).flatten().map(|d| with_trailing_dot(host, d))
}
fn listed(host: &str) -> bool {
    !ip_host(host) && !host.ends_with("..")
}
// Whether a host is a public suffix itself (`com`, `co.uk`, `github.io`).
pub(crate) fn is_public_suffix(host: &str) -> bool {
    public_suffix(host).as_deref() == Some(host)
}
fn with_trailing_dot(host: &str, part: &str) -> String {
    if host.ends_with('.') && !part.ends_with('.') { format!("{part}.") } else { part.to_owned() }
}
// HTML "is a registrable domain suffix of or is equal to": `suffix` the host itself, or — both domains — the end of it
// after a dot, where `suffix` is no public suffix, nor the end of the host's (and neither with an empty last label, nor
// `suffix` with an empty first one — `com..`, `.com` — which Chrome refuses).
pub(crate) fn registrable_domain_suffix(suffix: &str, host: &str) -> bool {
    if suffix == host {
        return true;
    }
    if !listed(suffix) || !listed(host) || suffix.starts_with('.') {
        return false;
    }
    if !host.strip_suffix(suffix).is_some_and(|sub| sub.ends_with('.')) {
        return false;
    }
    let public = public_suffix(host).unwrap_or_else(|| host.to_owned());
    public_suffix(suffix).as_deref() != Some(suffix) && public != suffix && !public.ends_with(&format!(".{suffix}"))
}
// The site of `url`'s origin (HTML "obtain a site"), a `blob:` URL's its inner URL's: its scheme and its host's
// registrable domain — the host itself where it has none (an IP address, a public suffix). None for a URL that is no
// http(s) one with a host. One rule for every partition keyed on a site: storage, blob URLs, `Sec-Fetch-Site`.
pub(crate) fn site(url: &str) -> Option<String> {
    let url = ada_url::Url::parse(url.strip_prefix("blob:").unwrap_or(url), None).ok()?;
    let host = url.hostname();
    if !matches!(url.protocol(), "http:" | "https:") || host.is_empty() {
        return None;
    }
    Some(format!("{}//{}", url.protocol(), registrable_domain(host).as_deref().unwrap_or(host)))
}
pub(crate) fn site_for_ruby(url: String) -> Option<String> {
    site(&url)
}
// `value` host-parsed (URL "host parsing"), or None where it is no host — nothing but a host, as a URL's authority would
// take it, with no port (`:` a forbidden host code point outside an IPv6 address's brackets).
fn domain_host(value: &str) -> Option<String> {
    if !value.starts_with('[') && value.contains(':') {
        return None;
    }
    let url = ada_url::Url::parse(format!("http://{value}/"), None).ok()?;
    let bare = url.host() == url.hostname() && url.pathname() == "/" && url.search().is_empty() && url.hash().is_empty();
    (bare && url.href() == format!("http://{}/", url.host())).then(|| url.hostname().to_owned())
}
// `document.domain`'s setter steps past "has a browsing context" (HTML §7.5.2): what a write of `value` sets, or why it
// may not (dom-nodes.js `DOMAIN_*`) — an opaque origin, no host, or one that is no registrable domain suffix of the
// effective domain, nor it — with the host it did parse to.
const DOMAIN_OPAQUE: u32 = 1;
const DOMAIN_UNPARSED: u32 = 2;
const DOMAIN_NOT_SUFFIX: u32 = 3;
fn domain_to_set(effective: Option<&str>, value: &str) -> Result<String, (u32, String)> {
    let effective = effective.ok_or((DOMAIN_OPAQUE, String::new()))?;
    let host = domain_host(value).ok_or((DOMAIN_UNPARSED, String::new()))?;
    if registrable_domain_suffix(&host, effective) {
        Ok(host)
    } else {
        Err((DOMAIN_NOT_SUFFIX, host))
    }
}
// …a document's: realm `realm`'s origin (its creator's, for a document with none of its own), with what a write set on
// `doc` — None for a realm gone.
fn document_effective_domain(scope: &mut v8::PinScope<'_, '_>, doc: Option<NodeId>, realm: v8::Local<'_, v8::Value>) -> Option<String> {
    let origin = other_realm(scope, realm, |l, _| l.origin().to_owned())?;
    let states = &crate::dom::dom(scope).arena.document_states;
    effective_domain(&origin, doc.and_then(|d| states.domain(d)))
}
// __dom.effectiveDomain(doc, realm) -> `doc`'s effective domain (`effective_domain`) — `doc` null for the origin's own —
// or null for an opaque origin.
fn effective_domain_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let doc = crate::node_handle::nid_of(scope, args.get(0));
    match document_effective_domain(scope, doc, args.get(1)).and_then(|d| v8::String::new(scope, &d)) {
        Some(d) => rv.set(d.into()),
        None => rv.set_null(),
    }
}
// __dom.setDomain(doc, realm, value) -> null with `doc`'s domain set to `value` host-parsed, else `[why, host,
// effective]`: why not (`domain_to_set`), the host it parsed to and the effective domain ('' for none).
fn set_domain_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let value = args.get(2).to_rust_string_lossy(scope);
    let doc = crate::node_handle::nid_of(scope, args.get(0));
    let effective = doc.and_then(|doc| document_effective_domain(scope, Some(doc), args.get(1)));
    // (…no document, no effective domain: an opaque origin's refusal)
    let (why, host) = match domain_to_set(effective.as_deref(), &value) {
        Ok(host) => {
            if let Some(doc) = doc {
                crate::dom::dom(scope).arena.document_states.set_domain(doc, host);
            }
            return rv.set_null();
        }
        Err(refused) => refused,
    };
    let why = v8::Integer::new_from_unsigned(scope, why).into();
    let item = |s: &str| v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into);
    let (host, effective) = (item(&host), item(effective.as_deref().unwrap_or_default()));
    rv.set(v8::Array::new_with_elements(scope, &[why, host, effective]).into());
}
// __dom.ipHost(host) -> whether it is an IP address (`ip_host`).
fn ip_host_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let host = args.get(0).to_rust_string_lossy(scope);
    rv.set_bool(ip_host(&host));
}
// __dom.registrableDomainSuffix(suffix, host) -> whether `suffix` is a registrable domain suffix of `host` or it
// (`registrable_domain_suffix`).
fn registrable_domain_suffix_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (suffix, host) = (args.get(0).to_rust_string_lossy(scope), args.get(1).to_rust_string_lossy(scope));
    rv.set_bool(registrable_domain_suffix(&suffix, &host));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_site_is_a_registrable_domain_by_the_public_suffix_list() {
        assert_eq!(site("https://a.b.example.com/x").as_deref(), Some("https://example.com"));
        assert_eq!(site("https://a.example.co.uk/").as_deref(), Some("https://example.co.uk"));
        assert_eq!(site("https://user.github.io/").as_deref(), Some("https://user.github.io"));
        assert_eq!(site("http://www1.web-platform.test:8000/").as_deref(), Some("http://web-platform.test"));
        assert_eq!(site("http://localhost:3000/").as_deref(), Some("http://localhost"));
        assert_eq!(site("http://127.0.0.1:3000/").as_deref(), Some("http://127.0.0.1"));
        assert_eq!(site("http://co.uk/").as_deref(), Some("http://co.uk"));
        assert!(registrable_domain_suffix("example.co.uk", "a.example.co.uk"));
        assert!(!registrable_domain_suffix("co.uk", "a.example.co.uk"));
        assert!(!registrable_domain_suffix("github.io", "user.github.io"));
        assert!(!registrable_domain_suffix("test", "a.b.test"));
        // (…a trailing dot the host's, and its parts': another site than the host without it)
        assert_eq!(site("http://www.example.com./").as_deref(), Some("http://example.com."));
        assert_eq!(site("http://com./").as_deref(), Some("http://com."));
        assert!(!registrable_domain_suffix("com.", "www.example.com."));
        assert!(!registrable_domain_suffix("com", "www.example.com."));
        assert!(registrable_domain_suffix("example.com.", "www.example.com."));
        // (…an empty label: a host ending in two dots its own site, `.com` / `com..` no suffix — `a..com` one, Chrome's)
        assert_eq!(site("http://www.example.com../").as_deref(), Some("http://www.example.com.."));
        assert!(!registrable_domain_suffix("com..", "example.com.."));
        assert!(!registrable_domain_suffix(".com", "x.a..com"));
        assert!(registrable_domain_suffix("a..com", "x.a..com"));
        assert!(!registrable_domain_suffix("example.com.", "www.example.com.."));
    }

    #[test]
    fn a_domain_is_set_to_the_effective_one_or_a_superdomain_of_it() {
        assert_eq!(effective_domain("http://a.b.test:8080", None).as_deref(), Some("a.b.test"));
        assert_eq!(effective_domain("http://a.b.test", Some("b.test")).as_deref(), Some("b.test"));
        assert_eq!(effective_domain("null", None), None);
        assert_eq!(domain_to_set(Some("a.b.test"), "B.Test"), Ok("b.test".to_owned()));
        assert_eq!(domain_to_set(Some("a.b.test"), "a.b.test"), Ok("a.b.test".to_owned()));
        assert_eq!(domain_to_set(Some("a.b.test"), "c.test"), Err((DOMAIN_NOT_SUFFIX, "c.test".to_owned())));
        assert_eq!(domain_to_set(Some("ab.test"), "b.test"), Err((DOMAIN_NOT_SUFFIX, "b.test".to_owned())));
        assert_eq!(domain_to_set(Some("a.b.test"), "b.test:80"), Err((DOMAIN_UNPARSED, String::new())));
        assert_eq!(domain_to_set(Some("a.b.test"), "b.test/x"), Err((DOMAIN_UNPARSED, String::new())));
        assert_eq!(domain_to_set(Some("a.b.test"), ""), Err((DOMAIN_UNPARSED, String::new())));
        assert_eq!(domain_to_set(None, "b.test"), Err((DOMAIN_OPAQUE, String::new())));
        // (…an IP address only ever itself, however it was written)
        assert_eq!(domain_to_set(Some("127.0.0.1"), "0x7f.0.0.1"), Ok("127.0.0.1".to_owned()));
        assert_eq!(domain_to_set(Some("1.0.0.1"), "0.1"), Err((DOMAIN_NOT_SUFFIX, "0.0.0.1".to_owned())));
        assert!(ip_host("[::1]") && ip_host("10.0.0.1") && !ip_host("a.test"));
    }

    fn at(href: &str) -> RealmLocation {
        let mut location = RealmLocation::default();
        location.set_url(href);
        location
    }

    #[test]
    fn a_frame_document_takes_its_origins() {
        let mut arena = RealmArena::default();
        arena.location = at("http://a.test/p");
        let origins = |arena: &mut RealmArena, url: &str, sandbox: Option<&str>, csp: Option<&str>| {
            let c = frame_origins(arena, 0, url, sandbox, csp);
            (c.document, c.location)
        };
        let inherited = (Some("http://a.test".to_owned()), Some("null"));
        for url in ["", "about:blank#x", "JAVASCRIPT:void 0"] {
            assert_eq!(origins(&mut arena, url, None, None), inherited, "{url}");
        }
        for url in ["http://b.test/", "data:,x", "blob:http://a.test/0000"] {
            assert_eq!(origins(&mut arena, url, None, None), (None, None), "{url}");
        }
        assert_eq!(origins(&mut arena, "http://b.test/", Some(""), None), (Some("null".to_owned()), None));
        assert_eq!(origins(&mut arena, "", Some("allow-same-origin"), None), inherited);
        assert_eq!(origins(&mut arena, "http://a.test/", None, Some("sandbox")), (Some("null".to_owned()), None));
        assert_eq!(frame_origins(&mut arena, 0, "", Some("allow-scripts"), None).sandbox, crate::sandbox::sandboxing(None, Some("allow-scripts")));
        // (…an opaque origin inherited, its key with it; a sandboxed creator's frames each a new one, its flags theirs)
        arena.location.set_document_origin(Some("null|k".to_owned()));
        assert_eq!(origins(&mut arena, "", None, None), (Some("null|k".to_owned()), Some("null")));
        arena.location.sandbox = crate::sandbox::sandboxing(None, Some("allow-scripts"));
        assert_eq!(origins(&mut arena, "", None, None), (Some("null".to_owned()), Some("null")));
        // (…what this document restricts restricted still, whatever the frame's attribute lifts)
        assert!(frame_origins(&mut arena, 0, "", Some("allow-forms"), None).sandbox & crate::sandbox::FORMS != 0);
    }

    #[test]
    fn a_popup_is_sandboxed_as_its_opener_unless_it_escapes() {
        let mut arena = RealmArena::default();
        arena.location = at("http://a.test/p");
        assert_eq!(popup_origins(&mut arena, 0), Creation { document: Some("http://a.test".to_owned()), location: Some("null"), sandbox: 0 });
        arena.location.set_document_origin(Some("null|k".to_owned()));
        arena.location.sandbox = crate::sandbox::sandboxing(None, Some("allow-scripts allow-popups"));
        let propagated = popup_origins(&mut arena, 0);
        assert_eq!((propagated.document.as_deref(), propagated.sandbox), (Some("null"), arena.location.sandbox));
        arena.location.sandbox = crate::sandbox::sandboxing(None, Some("allow-scripts allow-popups allow-popups-to-escape-sandbox"));
        assert_eq!(popup_origins(&mut arena, 0), Creation { document: Some("null|k".to_owned()), location: Some("null"), sandbox: 0 });
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
