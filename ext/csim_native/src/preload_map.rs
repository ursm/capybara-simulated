// A document's map of preloaded resources (HTML §4.6.7 `preload`): what a `<link rel=preload>` fetched, kept by its
// preload key — its URL, destination, mode and credentials mode — for the first fetch that matches it to take ("consume
// a preloaded resource", which Fetch's "fetch" runs before its main fetch: the consumer's request then reaches no
// service worker and no network, and files no Resource Timing entry). An entry is in the map from the moment the
// preload's fetch is planned, its response pending until that fetch has run — which a consumer that finds it runs then
// (subresource_obtain.rs `run_preload`). Kept in the arena (`RealmArena::preloads`) until it is consumed, or its document
// goes or loads anew (`forget_preloads`).

use crate::dom::{NodeId, RealmArena};
use crate::subresource_plan::PLAN_REQUEST;

#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct Key {
    doc: NodeId,
    url: String,
    destination: String,
    request: u32,
}

pub(crate) struct Preloaded {
    integrity: String,
    response: Had,
}

// What a preload had: its fetch yet to run — the request its link made, which a consumer that wants its response first
// runs — or its response, None for a network error, which a consumer takes as its own.
enum Had {
    Pending(Box<crate::subresource_obtain::Request>),
    Response(Option<Response>),
}

// The response a preload had, as its consumer reads it.
pub(crate) struct Response {
    status: u32,
    status_text: String,
    kind: String,
    url: String,
    redirected: bool,
    tainted: bool,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Key {
    pub(crate) fn new(doc: NodeId, url: &str, destination: &str, plan: u32) -> Key {
        Key { doc, url: url.to_owned(), destination: destination.to_owned(), request: plan & PLAN_REQUEST }
    }
    pub(crate) fn doc(&self) -> NodeId {
        self.doc
    }
}
impl Response {
    // The facts its consumer's verdict is made of (subresource_judge.rs `judge`), and its body.
    pub(crate) fn facts(&self) -> crate::subresource_judge::Facts {
        crate::subresource_judge::Facts {
            response_type: self.kind.clone(),
            redirected: self.redirected,
            status: Some(self.status),
            tainted: self.tainted,
            ..Default::default()
        }
    }
    pub(crate) fn into_body(self) -> Vec<u8> {
        self.body
    }
}

impl RealmArena {
    // A preload's entry put in its document's map as its fetch is planned, its response pending — the request its link
    // made (HTML `preload`: the entry is in the map from the start, a consumer that comes meanwhile waiting for its
    // response) — one of the same key replaced.
    pub(crate) fn preload_begin(&mut self, key: Key, integrity: String, request: crate::subresource_obtain::Request) {
        self.preloads.insert(key, Preloaded { integrity, response: Had::Pending(Box::new(request)) });
    }
    // …its response committed, None for a network error.
    pub(crate) fn preload_commit(&mut self, key: Key, integrity: String, response: Option<Response>) {
        self.preloads.insert(key, Preloaded { integrity, response: Had::Response(response) });
    }
    // …the pending entry of `key` taken out of the map, where it is the one `is_it` names: its request, to run or to
    // let go of (its link planned another before it ran).
    pub(crate) fn preload_take_pending(&mut self, key: &Key, is_it: impl FnOnce(&crate::subresource_obtain::Request) -> bool) -> Option<crate::subresource_obtain::Request> {
        if !self.preloads.get(key).is_some_and(|entry| matches!(&entry.response, Had::Pending(r) if is_it(r))) {
            return None;
        }
        match self.preloads.remove(key).map(|entry| entry.response) {
            Some(Had::Pending(r)) => Some(*r),
            _ => None,
        }
    }
    // …and every entry of `doc`'s, as it loads anew (an in-place reload keeps its node): a new document's map is empty.
    pub(crate) fn forget_preloads(&mut self, doc: NodeId) {
        self.preloads.retain(|key, _| key.doc != doc);
    }
    // "Consume a preloaded resource": the entry of `key` taken out of the map — its response, None for a network
    // error, or its fetch yet to run — None where there is none, or where `integrity` names metadata other than the
    // preload's.
    fn preload_consume(&mut self, key: &Key, integrity: &str) -> Option<Had> {
        let entry = self.preloads.get(key)?;
        if !integrity_matches(integrity, &entry.integrity) {
            return None;
        }
        self.preloads.remove(key).map(|entry| entry.response)
    }
}

// "Consume a preloaded resource" for a request of `doc` — `url`, its `destination`, its `plan`'s mode and credentials
// mode — of `integrity` metadata: the response, None for a network error — a preload whose fetch is yet to run running
// it first (subresource_obtain.rs `run_preload`, through the bindings' `host`), the response the consumer waits for — or
// None where none matches.
pub(crate) fn consume(
    scope: &mut v8::PinScope<'_, '_>,
    cid: i32,
    (doc, url, destination, plan): (NodeId, &str, &str, u32),
    integrity: &str,
    host: v8::Local<'_, v8::Function>,
) -> Result<Option<Option<Response>>, crate::font_files::Terminated> {
    let key = Key::new(doc, url, destination, plan);
    let pending = match crate::dom::realm(scope, cid).preload_consume(&key, integrity) {
        None => return Ok(None),
        Some(Had::Response(r)) => return Ok(Some(r)),
        Some(Had::Pending(r)) => r,
    };
    crate::subresource_obtain::run_preload(scope, host, *pending)?;
    Ok(match crate::dom::realm(scope, cid).preload_consume(&key, integrity) {
        Some(Had::Response(r)) => Some(r),
        _ => None,
    })
}

// Whether a consumer of `consumer` integrity metadata takes a preload of `preload`'s: one of no metadata any, else one
// of the same metadata (SRI "parse metadata": the set of its hash expressions of a valid algorithm, their options
// dropped — an empty value one too).
fn integrity_matches(consumer: &str, preload: &str) -> bool {
    fn parsed(metadata: &str) -> Vec<(String, &str)> {
        let mut hashes: Vec<(String, &str)> = metadata
            .split_ascii_whitespace()
            .filter_map(|token| token.split('?').next()?.split_once('-'))
            .filter(|(alg, _)| ["sha256", "sha384", "sha512"].iter().any(|valid| alg.eq_ignore_ascii_case(valid)))
            .map(|(alg, value)| (alg.to_ascii_lowercase(), value))
            .collect();
        hashes.sort_unstable();
        hashes.dedup();
        hashes
    }
    let wanted = parsed(consumer);
    wanted.is_empty() || wanted == parsed(preload)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "preloadConsume", consume_op, context_id);
    crate::dom::register(scope, ns, "preloadsForget", forget_op, context_id);
}

// The key of args `[doc, url, destination, plan]`.
fn key_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> Option<Key> {
    let doc = crate::dom::nid_arg(scope, args, 0)?;
    let url = args.get(1).to_rust_string_lossy(scope);
    let destination = args.get(2).to_rust_string_lossy(scope);
    let request = args.get(3).uint32_value(scope).unwrap_or(0) & PLAN_REQUEST;
    Some(Key { doc, url, destination, request })
}

fn member<'s>(scope: &mut v8::PinScope<'s, '_>, obj: v8::Local<'_, v8::Object>, key: &str) -> Option<v8::Local<'s, v8::Value>> {
    let k = v8::String::new(scope, key)?;
    obj.get(scope, k.into()).filter(|v| !v.is_null_or_undefined())
}

// The response a preload had as the host, a service worker or the asset cache gave it, `resp` — its `status`,
// `statusText`, `type`, `url`, `redirected`, `tainted`, `headers` and its body's bytes (a service worker's answer's
// `bytes`, the network's `body_bytes`, else its text `body`) — none for a network error: none, or `blocked`.
pub(crate) fn response_of(scope: &mut v8::PinScope<'_, '_>, resp: Option<v8::Local<'_, v8::Object>>) -> Option<Response> {
    resp.and_then(|resp| {
        if member(scope, resp, "blocked").is_some_and(|v| v.boolean_value(scope)) {
            return None;
        }
        let text = |scope: &mut v8::PinScope<'_, '_>, key: &str| member(scope, resp, key).map(|v| v.to_rust_string_lossy(scope));
        let flag = |scope: &mut v8::PinScope<'_, '_>, key: &str| member(scope, resp, key).is_some_and(|v| v.boolean_value(scope));
        let mut headers = Vec::new();
        if let Some(h) = member(scope, resp, "headers").and_then(|h| v8::Local::<v8::Object>::try_from(h).ok()) {
            let names = h.get_own_property_names(scope, Default::default());
            for i in 0..names.map_or(0, |n| n.length()) {
                let Some(name) = names.and_then(|n| n.get_index(scope, i)) else { continue };
                let Some(value) = h.get(scope, name).filter(|v| !v.is_null_or_undefined()) else { continue };
                headers.push((name.to_rust_string_lossy(scope), value.to_rust_string_lossy(scope)));
            }
        }
        // (…a network response's `bytes` its size: its bytes the view of the two that is one)
        let view = ["body_bytes", "bytes"].into_iter().find_map(|key| member(scope, resp, key).filter(|v| v.is_array_buffer_view()));
        let body = match view {
            Some(bytes) => crate::blob_data::bytes_arg(scope, bytes),
            None => text(scope, "body").unwrap_or_default().into_bytes(),
        };
        Some(Response {
            status: member(scope, resp, "status").and_then(|v| v.uint32_value(scope)).unwrap_or(200),
            status_text: text(scope, "statusText").unwrap_or_default(),
            kind: text(scope, "type").unwrap_or_else(|| "basic".to_owned()),
            url: text(scope, "url").unwrap_or_default(),
            redirected: flag(scope, "redirected"),
            tainted: flag(scope, "tainted"),
            headers,
            body,
        })
    })
}
impl Response {
    // …one of a body alone, its facts none kept: an asset's cached before they were.
    pub(crate) fn of_body(body: Vec<u8>) -> Response {
        Response { status: 200, status_text: String::new(), kind: "basic".to_owned(), url: String::new(), redirected: false, tainted: false, headers: Vec::new(), body }
    }
    // …its body replaced: an asset's, whose facts the cache keeps beside it.
    pub(crate) fn with_body(self, body: Vec<u8>) -> Response {
        Response { body, ..self }
    }
    // (…its body's bytes, and whether it is opaque: what its integrity is checked against)
    pub(crate) fn body(&self) -> &[u8] {
        &self.body
    }
    pub(crate) fn opaque(&self) -> bool {
        self.kind == "opaque"
    }
}

// __dom.preloadsForget(doc): every entry of `doc`'s map let go of, as it loads anew (`forget_preloads`), and its links'
// plans of them (subresource_obtain.rs).
fn forget_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let arena = &mut crate::dom::dom(scope).arena;
    arena.forget_preloads(doc);
    arena.link_preloads.retain(|_, plan| plan.doc() != doc);
}

// __dom.preloadConsume(doc, url, destination, plan, integrity, host) -> what "consume a preloaded resource" takes for a
// consumer's request of `integrity` (`consume`): the response the preload had — `{status, statusText, type, url,
// redirected, tainted, headers, body_bytes}` — null for a network error, undefined where no preload matches; one whose
// fetch was yet to run run first, through the bindings' `host` (subresource-host.js).
fn consume_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(key) = key_arg(scope, &args) else { return };
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(5)) else { return };
    let integrity = args.get(4).to_rust_string_lossy(scope);
    let cid = crate::dom::realm_id(scope, &args);
    let r = match consume(scope, cid, (key.doc, &key.url, &key.destination, key.request), &integrity, host) {
        Ok(None) | Err(_) => return,
        Ok(Some(None)) => return rv.set_null(),
        Ok(Some(Some(r))) => r,
    };
    let obj = v8::Object::new(scope);
    let headers = v8::Object::new(scope);
    for (name, value) in &r.headers {
        let (Some(name), Some(value)) = (v8::String::new(scope, name), v8::String::new(scope, value)) else { continue };
        headers.set(scope, name.into(), value.into());
    }
    let fields: [(&str, v8::Local<'_, v8::Value>); 8] = [
        ("status", v8::Integer::new_from_unsigned(scope, r.status).into()),
        ("statusText", v8::String::new(scope, &r.status_text).map_or_else(|| v8::undefined(scope).into(), Into::into)),
        ("type", v8::String::new(scope, &r.kind).map_or_else(|| v8::undefined(scope).into(), Into::into)),
        ("url", v8::String::new(scope, &r.url).map_or_else(|| v8::undefined(scope).into(), Into::into)),
        ("redirected", v8::Boolean::new(scope, r.redirected).into()),
        ("tainted", v8::Boolean::new(scope, r.tainted).into()),
        ("headers", headers.into()),
        ("body_bytes", crate::blob_data::byte_array(scope, r.body)),
    ];
    for (name, value) in fields {
        let Some(name) = v8::String::new(scope, name) else { continue };
        obj.set(scope, name.into(), value);
    }
    rv.set(obj.into());
}

#[cfg(test)]
mod tests {
    use super::integrity_matches;

    #[test]
    fn a_consumer_of_no_metadata_takes_any_preload() {
        assert!(integrity_matches("", "sha256-abc"));
        assert!(integrity_matches("md5-abc", ""));
    }

    #[test]
    fn a_consumer_of_metadata_takes_a_preload_of_the_same() {
        assert!(integrity_matches("sha384-b sha256-a", "sha256-a?opt sha384-b"));
        assert!(!integrity_matches("sha256-a", ""));
        assert!(!integrity_matches("sha256-a", "sha256-b"));
        assert!(integrity_matches("sha256-a sha256-a", "SHA256-a"));
        assert!(!integrity_matches("sha256-", "sha256-a"));
    }
}
