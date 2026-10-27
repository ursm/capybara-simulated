// A worker's `importScripts` of one URL (HTML "importing scripts and libraries", its "fetch a classic worker-imported
// script"): a service worker's script resource map first — a URL it imported before is run again from it, before any
// fetch exists, so no fetch event fires for it (Service Workers §3.1.4) — and none it does not hold past installing
// (§4.3 "importScripts(urls)"); else a `data:` or `blob:` URL's own body, the Update probe's response where an update
// spawned the worker, its controlling service worker's answer, or the network's; judged as a worker-imported script's
// (subresource_judge.rs `judge`), its errors muted where it is of another origin. The bindings (workers.js
// `importScripts`) run what this answers.

use crate::dom::{realm, realm_id};
use crate::font_files::Terminated;
use crate::subresource_judge::{facts_of, judge, Consumer, J_WORKER_IMPORT, SRC_NETWORK, SRC_SCHEME, V_CROSS_ORIGIN, V_OK};
use crate::subresource_obtain::{call, member, text, H_IMPORT_NETWORK, H_SW_IMPORT, H_SW_NOTE_IMPORT};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "workerImport", worker_import_op, context_id);
}

// __dom.workerImport(url, host) -> `[body, muted]` of the script the calling worker imports from `url` (its source text,
// and whether its errors are muted), or null where it failed to load — `host` the bindings' (subresource-host.js).
fn worker_import_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return rv.set_null() };
    let url = args.get(0).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    match worker_import(scope, host, cid, &url) {
        Ok(Some((body, muted))) => {
            let muted = v8::Boolean::new(scope, muted).into();
            rv.set(v8::Array::new_with_elements(scope, &[body, muted]).into());
        }
        Ok(None) => rv.set_null(),
        Err(Terminated) => {}
    }
}

fn worker_import<'s>(scope: &mut v8::PinScope<'s, '_>, host: v8::Local<'_, v8::Function>, cid: i32, url: &str) -> Result<Option<(v8::Local<'s, v8::Value>, bool)>, Terminated> {
    let Some(state) = realm(scope, cid).realm_state_mut(cid) else { return Ok(None) };
    let handle = state.identity.worker_handle;
    let service = state.service_worker.is_some();
    if let Some((source, muted)) = state.script_resources.get(url).filter(|_| service).cloned() {
        return Ok(Some((crate::dom::utf16_value(scope, &source), muted)));
    }
    let worker = state.service_worker.as_mut();
    if worker.as_ref().is_some_and(|g| g.installed()) {
        return Ok(None);
    }
    let cache_mode = worker.as_ref().and_then(|g| g.import_cache_mode());
    let probed = worker.and_then(|g| g.take_probed_import(url));
    // (…a data: or blob: URL's its own — no server to ask, no fetch event — its body decoded as UTF-8, as any
    // worker-imported script's is, whatever its MIME type: the JavaScript MIME type check is an HTTP(S) response's)
    let route = crate::fetch_rules::fetch_route(url, 0, "");
    let (facts, body, source) = if matches!(route, crate::fetch_rules::ROUTE_DATA | crate::fetch_rules::ROUTE_BLOB) {
        let Some((bytes, content_type)) = crate::subresource_obtain::scheme_response(scope, host, url)? else { return Ok(None) };
        let (decoded, _, _) = encoding_rs::UTF_8.decode(&bytes);
        (crate::subresource_obtain::scheme_facts(content_type), text(scope, &decoded), SRC_SCHEME)
    } else {
        // (…a version an update spawned the Update probe's response — the 404 its byte check saw the one this sees, once
        // per URL — a controlled worker's its service worker's answer, null where it let the request through, and the
        // network's last: a script's request, its cache mode a service worker's updateViaCache's)
        let resp = match probed.and_then(|json| v8::String::new(scope, &json)).and_then(|json| v8::json::parse(scope, json)) {
            Some(resp) => Some(resp),
            None => {
                let (u, h) = (text(scope, url), v8::Integer::new_from_unsigned(scope, handle).into());
                match call(scope, host, H_SW_IMPORT, &[u, h])? {
                    Some(answer) => Some(v8::Local::new(scope, answer)),
                    None => {
                        let mode = match cache_mode {
                            Some(m) => text(scope, m),
                            None => v8::undefined(scope).into(),
                        };
                        call(scope, host, H_IMPORT_NETWORK, &[u, mode])?.map(|resp| v8::Local::new(scope, resp))
                    }
                }
            }
        };
        let resp = resp.and_then(|r| v8::Local::<v8::Object>::try_from(r).ok());
        let source = if route == crate::fetch_rules::ROUTE_NETWORK { SRC_NETWORK } else { SRC_SCHEME };
        let facts = facts_of(scope, resp, J_WORKER_IMPORT, source);
        let body = resp.and_then(|r| member(scope, r, "body")).unwrap_or_else(|| v8::String::empty(scope).into());
        (facts, body, source)
    };
    // (…a response that is no ok one — a network error, a 404, a body cut short — a NetworkError, as an HTTP(S) one whose
    // Content-Type is no JavaScript MIME type is)
    let verdict = judge(&Consumer::of(J_WORKER_IMPORT), source, &facts);
    if verdict & V_OK == 0 {
        return Ok(None);
    }
    // A service worker's import, by URL, on its registration's record: the Update algorithm byte-checks imports where the
    // main script came back identical.
    if service {
        let (u, h) = (text(scope, url), v8::Integer::new_from_unsigned(scope, handle).into());
        call(scope, host, H_SW_NOTE_IMPORT, &[u, body, h])?;
    }
    let muted = verdict & V_CROSS_ORIGIN != 0;
    let units: Option<Vec<u16>> = service.then(|| crate::dom::utf16_arg(scope, body));
    let arena = realm(scope, cid);
    crate::script::note_muted(arena, url, muted);
    // (…entered in the map before it runs: a re-import from inside it finds it)
    if let (Some(units), Some(s)) = (units, arena.realm_state_mut(cid)) {
        s.script_resources.insert(url.to_owned(), (units, muted));
    }
    Ok(Some((body, muted)))
}
