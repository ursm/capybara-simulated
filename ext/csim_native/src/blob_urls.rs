// The blob URL store (File API §8.3): the blob each blob URL a realm of the isolate made — or took in, a blob: document
// loaded into it — names, with that realm, for whichever realm resolves the URL. A worker isolate, and another window's,
// resolve it through the host's registry, which is also what says whether a revoke anywhere reached it.

use std::collections::HashMap;

use crate::dom::{dom, realm_id, register};

#[derive(Default)]
pub(crate) struct BlobUrls(HashMap<String, Vec<(i32, v8::Global<v8::Object>)>>);

impl BlobUrls {
    // …of realm `cid` no more: its document went (a frame removed, its page torn down), and the URLs it made with it
    // (url-lifetime: "Removing an iframe").
    pub(crate) fn forget_realm(&mut self, cid: i32) {
        self.0.retain(|_, entries| {
            entries.retain(|(realm, _)| *realm != cid);
            !entries.is_empty()
        });
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "blobUrlSet", blob_url_set, context_id);
    register(scope, ns, "blobUrlGet", blob_url_get, context_id);
    register(scope, ns, "blobUrlRealm", blob_url_realm, context_id);
    register(scope, ns, "blobUrlDelete", blob_url_delete, context_id);
}

// __dom.blobUrlSet(url, blob): the calling realm's entry for `url` names `blob`.
fn blob_url_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(blob) = v8::Local::<v8::Object>::try_from(args.get(1)) else { return };
    let url = args.get(0).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    let blob = v8::Global::new(scope, blob);
    let entries = dom(scope).arena.blob_urls.0.entry(url).or_default();
    entries.retain(|(realm, _)| *realm != cid);
    entries.push((cid, blob));
}

// __dom.blobUrlGet(url) -> the blob `url` names — the calling realm's entry first, else the first another realm of the
// isolate made — or undefined for none.
fn blob_url_get(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let url = args.get(0).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    let Some(entries) = dom(scope).arena.blob_urls.0.get(&url) else { return };
    let Some((_, blob)) = entries.iter().find(|(realm, _)| *realm == cid).or_else(|| entries.first()) else { return };
    let blob = blob.clone();
    rv.set(v8::Local::new(scope, blob).into());
}

// __dom.blobUrlRealm(url) -> whether the calling realm has an entry for `url`.
fn blob_url_realm(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let url = args.get(0).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    let has = dom(scope).arena.blob_urls.0.get(&url).is_some_and(|entries| entries.iter().any(|(realm, _)| *realm == cid));
    rv.set_bool(has);
}

// __dom.blobUrlDelete(url): the calling realm's entry for `url` let go of (revoked, or dropped as another window revoked
// it).
fn blob_url_delete(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let url = args.get(0).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    let urls = &mut dom(scope).arena.blob_urls.0;
    if let Some(entries) = urls.get_mut(&url) {
        entries.retain(|(realm, _)| *realm != cid);
        if entries.is_empty() {
            urls.remove(&url);
        }
    }
}
