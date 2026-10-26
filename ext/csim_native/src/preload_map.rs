// A document's map of preloaded resources (HTML §4.6.7 `preload`): what a `<link rel=preload>` fetched, kept by its
// preload key — its URL, destination, mode and credentials mode — for the first fetch that matches it to take ("consume
// a preloaded resource", which Fetch's "fetch" runs before its main fetch: the consumer's request then reaches no
// service worker and no network, and files no Resource Timing entry). An entry is in the map from the moment the
// preload's fetch is planned, its response pending until that fetch has run — which a consumer that finds it runs then.
// Kept in the arena (`RealmArena::preloads`) until it is consumed or its document goes.

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

// What a preload had: its fetch yet to run — the bindings' to run, by the token they named it with, when a consumer
// wants its response first — or its response, None for a network error, which a consumer takes as its own.
enum Had {
    Pending(u32),
    Response(Option<Response>),
}

// The response a preload had, as its consumer reads it.
pub(crate) struct Response {
    status: u32,
    kind: String,
    url: String,
    redirected: bool,
    tainted: bool,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Key {
    pub(crate) fn doc(&self) -> NodeId {
        self.doc
    }
}

impl RealmArena {
    // The preload's entry committed to its document's map, one of the same key replaced.
    fn preload_commit(&mut self, key: Key, entry: Preloaded) {
        self.preloads.insert(key, entry);
    }
    // "Consume a preloaded resource": the entry of `key` taken out of the map — its response, None for a network
    // error — or, its fetch yet to run, left in it; None where there is none, or where `integrity` names metadata other
    // than the preload's.
    fn preload_consume(&mut self, key: &Key, integrity: &str) -> Option<Had> {
        let entry = self.preloads.get(key)?;
        if !integrity_matches(integrity, &entry.integrity) {
            return None;
        }
        if let Had::Pending(token) = entry.response {
            return Some(Had::Pending(token));
        }
        self.preloads.remove(key).map(|entry| entry.response)
    }
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
    crate::dom::register(scope, ns, "preloadBegin", begin_op, context_id);
    crate::dom::register(scope, ns, "preloadCommit", commit_op, context_id);
    crate::dom::register(scope, ns, "preloadWithdraw", withdraw_op, context_id);
    crate::dom::register(scope, ns, "preloadConsume", consume_op, context_id);
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

// __dom.preloadBegin(doc, url, destination, plan, integrity, token): a preload's entry put in `doc`'s map as its fetch is
// planned, its response pending — the fetch the bindings name `token` (HTML `preload`: the entry is in the map from
// the start, a consumer that comes meanwhile waiting for its response).
fn begin_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(key) = key_arg(scope, &args) else { return };
    let integrity = args.get(4).to_rust_string_lossy(scope);
    let token = args.get(5).uint32_value(scope).unwrap_or(0);
    crate::dom::dom(scope).arena.preload_commit(key, Preloaded { integrity, response: Had::Pending(token) });
}

// __dom.preloadWithdraw(doc, url, destination, plan, token): the pending entry of the fetch the bindings named `token`
// taken out of `doc`'s map — its link planned another before it ran (its `crossorigin` set as it was inserted).
fn withdraw_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(key) = key_arg(scope, &args) else { return };
    let token = args.get(4).uint32_value(scope).unwrap_or(0);
    let preloads = &mut crate::dom::dom(scope).arena.preloads;
    if preloads.get(&key).is_some_and(|entry| matches!(entry.response, Had::Pending(t) if t == token)) {
        preloads.remove(&key);
    }
}

// __dom.preloadCommit(doc, url, destination, plan, integrity, resp): a preload's entry committed to `doc`'s map — the
// response it had, `resp` (its `status`, `type`, `url`, `redirected`, `tainted`, `headers` and its body's bytes — a
// service worker's answer's `bytes`, the network's `body_bytes`, else its text `body`), a network error where it is none
// or `blocked`.
fn commit_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(key) = key_arg(scope, &args) else { return };
    let integrity = args.get(4).to_rust_string_lossy(scope);
    let response = v8::Local::<v8::Object>::try_from(args.get(5)).ok().and_then(|resp| {
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
            kind: text(scope, "type").unwrap_or_else(|| "basic".to_owned()),
            url: text(scope, "url").unwrap_or_default(),
            redirected: flag(scope, "redirected"),
            tainted: flag(scope, "tainted"),
            headers,
            body,
        })
    });
    crate::dom::dom(scope).arena.preload_commit(key, Preloaded { integrity, response: Had::Response(response) });
}

// __dom.preloadConsume(doc, url, destination, plan, integrity) -> what "consume a preloaded resource" takes for a
// consumer's request of `integrity`: the response the preload had — `{status, type, url, redirected, tainted, headers,
// body_bytes}` — null for a network error, undefined where no preload matches; the token of its fetch where that is yet
// to run (`preloadBegin`), its entry left for the consumer to take once it has.
fn consume_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(key) = key_arg(scope, &args) else { return };
    let integrity = args.get(4).to_rust_string_lossy(scope);
    let r = match crate::dom::dom(scope).arena.preload_consume(&key, &integrity) {
        None => return,
        Some(Had::Pending(token)) => return rv.set_uint32(token),
        Some(Had::Response(None)) => return rv.set_null(),
        Some(Had::Response(Some(r))) => r,
    };
    let obj = v8::Object::new(scope);
    let headers = v8::Object::new(scope);
    for (name, value) in &r.headers {
        let (Some(name), Some(value)) = (v8::String::new(scope, name), v8::String::new(scope, value)) else { continue };
        headers.set(scope, name.into(), value.into());
    }
    let fields: [(&str, v8::Local<'_, v8::Value>); 7] = [
        ("status", v8::Integer::new_from_unsigned(scope, r.status).into()),
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
