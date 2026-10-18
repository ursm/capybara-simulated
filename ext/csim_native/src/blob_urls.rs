// The blob URL store (File API §8.3): the blob each blob URL a realm of the isolate made — or took in, a blob: document
// loaded into it — names, with that realm, for whichever realm resolves the URL. A worker isolate, and another window's,
// resolve it through the host's registry, which is also what says whether a revoke anywhere reached it.

use std::collections::HashMap;

use crate::dom::{dom, realm_id, register};

// One entry a URL (§8.3: the blob and the environment that made it), whichever realm revokes it.
#[derive(Default)]
pub(crate) struct BlobUrls(HashMap<String, (i32, v8::Global<v8::Object>)>);

impl BlobUrls {
    // …of realm `cid` no more: its document went (a frame removed or navigated, its page torn down, a new one begun in
    // its context), and the URLs it made with it (url-lifetime: "Removing an iframe").
    pub(crate) fn forget_realm(&mut self, cid: i32) {
        self.0.retain(|_, (realm, _)| *realm != cid);
    }
}

// The store's key for `url` as "resolve a blob URL" looks it up (§8.3.4): the URL serialized with its fragment
// excluded — a fragment names no other resource, a query or a path more does — its text up to a `#` where it is no URL.
pub(crate) fn entry_key(url: &str) -> String {
    match ada_url::Url::parse(url, None) {
        Ok(mut parsed) => {
            parsed.set_hash(None);
            parsed.href().to_owned()
        }
        Err(_) => url.split('#').next().unwrap_or_default().to_owned(),
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "blobUrlKey", blob_url_key, context_id);
    register(scope, ns, "blobUrlSet", blob_url_set, context_id);
    register(scope, ns, "blobUrlGet", blob_url_get, context_id);
    register(scope, ns, "blobUrlRealm", blob_url_realm, context_id);
    register(scope, ns, "blobUrlDelete", blob_url_delete, context_id);
}

// __dom.blobUrlKey(url) -> `entry_key`: what the host's registry knows the URL by too.
fn blob_url_key(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let url = args.get(0).to_rust_string_lossy(scope);
    if let Some(key) = v8::String::new(scope, &entry_key(&url)) {
        rv.set(key.into());
    }
}

// __dom.blobUrlSet(url, blob): `url` (its fragment excluded) names `blob`, made in the calling realm.
fn blob_url_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(blob) = v8::Local::<v8::Object>::try_from(args.get(1)) else { return };
    let url = entry_key(&args.get(0).to_rust_string_lossy(scope));
    let cid = realm_id(scope, &args);
    let blob = v8::Global::new(scope, blob);
    dom(scope).arena.blob_urls.0.insert(url, (cid, blob));
}

// __dom.blobUrlGet(url) -> the blob `url` resolves to (`entry_key`: its fragment excluded), whichever realm of the
// isolate made it, or undefined for none.
fn blob_url_get(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let url = entry_key(&args.get(0).to_rust_string_lossy(scope));
    let Some((_, blob)) = dom(scope).arena.blob_urls.0.get(&url) else { return };
    let blob = blob.clone();
    rv.set(v8::Local::new(scope, blob).into());
}

// __dom.blobUrlRealm(url) -> whether the calling realm made the blob `url` resolves to.
fn blob_url_realm(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let url = entry_key(&args.get(0).to_rust_string_lossy(scope));
    let cid = realm_id(scope, &args);
    rv.set_bool(dom(scope).arena.blob_urls.0.get(&url).is_some_and(|(realm, _)| *realm == cid));
}

// __dom.blobUrlDelete(url): `url` names no blob any more — revoked (the origin's check the bindings', before), or
// dropped as another window revoked it — whichever realm made it. Matched as it is, its fragment and all: revoking
// `<url>#frag` removes no entry (§8.3.2: the URL serialized whole).
fn blob_url_delete(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let url = args.get(0).to_rust_string_lossy(scope);
    dom(scope).arena.blob_urls.0.remove(&url);
}
