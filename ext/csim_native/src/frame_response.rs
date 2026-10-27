// The response a frame's document is made of (HTML "process the iframe attributes" and "navigate", as far as "create and
// initialize a Document object" takes them): where its build loads it from — a scripted navigation's response, its
// `srcdoc`, an about:, data:, javascript: or blob: URL's, or the network's, a service worker's on the way — what that
// response says of the document (its URL after redirects, its Content-Type, its Content-Security-Policy, Referrer-Policy
// and Refresh, the Referer its request sent, the client it reserved), its Resource Timing entry, and the origins and
// sandboxing flags the document is made with. The bindings (bridge.entry.js `__csimFrameWindow`) unload the frame's old
// document and make the realm of what this answers.

use crate::dom::{realm, realm_id, NodeId};
use crate::font_files::Terminated;
use crate::frame_navigation::{Content, FrameSource, COMMIT_PENDING, DEFERRED_SW, LOAD_FIRED};
use crate::dom::member;
use crate::subresource_obtain::{call, now, text, text_or_null, H_FILE, H_FRAME_NAVIGATION, H_LOAD_BLOCKER_SETTLED};

// What a build makes of the response (`frameResponse`'s first item): the document it answers; none yet, its navigation
// parked on a service worker still activating; none at all, a response that makes no document leaving the frame at the
// one it is at, still its own.
const FRAME_BUILD: u32 = 0;
const FRAME_DEFERRED: u32 = 1;
const FRAME_KEPT: u32 = 2;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "frameResponse", frame_response_op, context_id);
}

// __dom.frameResponse(container, host) -> what a build of the frame `container`'s document makes of its response —
// `host` the bindings' (subresource-host.js) — `[FRAME_DEFERRED]`, `[FRAME_KEPT]`, or `[FRAME_BUILD, url, locationHref,
// body, contentType, javascriptSource, aboutBase, clientId, referrer, policy, refresh, documentOrigin, locationOrigin,
// sandbox]`: the document's URL, the one its location reports (about:srcdoc, about:blank), its body (its bytes, a
// srcdoc's text), its type, the script a javascript: URL runs in it, the base URL an about: document inherits from its
// creator, the client id its navigation reserved, the Referer its request sent and the Referrer-Policy and Refresh its
// response set (null for none), its origins (`frame_origins`) and its sandboxing flags.
fn frame_response_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    // (…a container of no node, or no host: no document made, as for a build parked)
    let deferred = |scope: &mut v8::PinScope<'_, '_>, mut rv: v8::ReturnValue<'_, v8::Value>| {
        let code = v8::Integer::new_from_unsigned(scope, FRAME_DEFERRED).into();
        rv.set(v8::Array::new_with_elements(scope, &[code]).into());
    };
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return deferred(scope, rv) };
    let Some(container) = crate::node_handle::nid_of(scope, args.get(0)) else { return deferred(scope, rv) };
    let doc = crate::node_handle::handle_of(scope, args.get(0))
        // SAFETY: the handle lives while the object, an argument, does.
        .and_then(|ptr| unsafe { ptr.as_ref() }.document(scope))
        .and_then(|d| crate::node_handle::nid_of(scope, d.into()));
    let cid = realm_id(scope, &args);
    if let Ok(answer) = frame_response(scope, host, cid, container, doc) {
        rv.set(answer);
    }
}

// The response, as the build's source has it.
struct Response<'s> {
    url: String,
    body: v8::Local<'s, v8::Value>,
    content_type: String,
    javascript: Option<String>,
    client_id: Option<String>,
    referrer: Option<String>,
    policy: Option<String>,
    refresh: Option<String>,
    csp: Option<String>,
}

fn frame_response<'s>(scope: &mut v8::PinScope<'s, '_>, host: v8::Local<'_, v8::Function>, cid: i32, container: NodeId, doc: Option<NodeId>) -> Result<v8::Local<'s, v8::Value>, Terminated> {
    let code = |scope: &mut v8::PinScope<'s, '_>, code: u32| {
        let code = v8::Integer::new_from_unsigned(scope, code).into();
        v8::Array::new_with_elements(scope, &[code]).into()
    };
    let (source, reload) = realm(scope, cid).frame_source(container, doc);
    let empty = v8::String::empty(scope).into();
    let mut r = Response { url: String::new(), body: empty, content_type: "text/html".to_owned(), javascript: None, client_id: None, referrer: None, policy: None, refresh: None, csp: None };
    let (carried, srcdoc) = (matches!(source, FrameSource::Navigation(_)), matches!(source, FrameSource::Srcdoc(_)));
    match source {
        // (…a scripted navigation's: its response's as it carried it)
        FrameSource::Navigation(content) => {
            r.url = String::from_utf16_lossy(&content.url);
            r.body = crate::dom::u8_array(scope, content.bytes);
            let content_type = String::from_utf16_lossy(&content.content_type);
            if !content_type.is_empty() {
                r.content_type = content_type;
            }
            r.referrer = Some(String::from_utf16_lossy(&content.referrer)).filter(|s| !s.is_empty());
            r.policy = Some(String::from_utf16_lossy(&content.policy)).filter(|s| !s.is_empty());
        }
        FrameSource::Srcdoc(text_of) => r.body = text(scope, &text_of),
        // (…its initial about:blank document's referrer its creator's URL, this document's: HTML "create a new browsing
        // context and document")
        FrameSource::None => r.referrer = Some(realm(scope, cid).location.href().to_owned()).filter(|s| !s.is_empty()),
        // (…an about: URL no resource the network has: Fetch's scheme fetch answers about:blank with an empty document and
        // any other with a network error, an empty document too — the URL the document's, its fragment for :target)
        FrameSource::About(url) => r.url = url,
        // (…a data: URL its own response, its MIME type `text/plain;charset=US-ASCII` where it names none — a malformed
        // one a network error, the empty document — and a blob: URL the blob's bytes, kept as the document loaded last,
        // which a reload of it revoked by then loads again: HTML keeps the blob alive for the document)
        FrameSource::Data(url) => {
            if let Some((mime, bytes)) = crate::data_url::process(&url) {
                r.body = crate::dom::u8_array(scope, bytes);
                r.content_type = mime;
            }
            r.url = url;
        }
        FrameSource::Blob(url) => {
            if let Some((bytes, content_type)) = crate::subresource_obtain::scheme_response(scope, host, &url)? {
                let content_type = if content_type.is_empty() { "text/html".to_owned() } else { content_type };
                let units = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
                let content = Content { url: units(&url), bytes: bytes.clone(), content_type: units(&content_type), referrer: Vec::new(), policy: Vec::new() };
                realm(scope, cid).keep_frame_loaded(container, content);
                r.body = crate::dom::u8_array(scope, bytes);
                r.content_type = content_type;
            }
            r.url = url;
        }
        // (…a javascript: URL's document the initial about:blank one, the script it runs run in the frame's realm once
        // its parent and top are wired, a string result replacing the document: HTML "evaluate a javascript: URL")
        FrameSource::Javascript(url) => {
            r.javascript = Some(crate::url_ops::javascript_url_source(&url));
            r.url = url;
        }
        FrameSource::Fetch(url) => {
            r.url = url;
            match navigate(scope, host, cid, container, reload, &mut r)? {
                FRAME_BUILD => {}
                kept_or_deferred => return Ok(code(scope, kept_or_deferred)),
            }
        }
    }
    // The document's origins and sandboxing flags, as this realm — its creator's — makes them.
    let arena = realm(scope, cid);
    let sandbox = arena.take_frame_sandbox(container);
    let created = crate::realm_location::frame_origins(arena, cid, &r.url, sandbox.as_deref(), r.csp.as_deref());
    // The response is in: the URL the navigation started with let go of.
    arena.take_frame_src_url(container);
    // The URL its location reports — about:srcdoc for a srcdoc, about:blank for none and for a javascript: URL's, whose
    // result's document keeps its initial one's — and the base URL an about: one inherits from its creator, this
    // realm's document.
    let href = if !carried && srcdoc {
        "about:srcdoc".to_owned()
    } else if !carried && (r.url.is_empty() || r.javascript.is_some()) {
        "about:blank".to_owned()
    } else {
        r.url.clone()
    };
    let about = href.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("about:"));
    let base = match arena.realm_document(cid).filter(|_| about) {
        Some(doc) => arena.document_base_url(doc),
        None => String::new(),
    };
    let items = [
        v8::Integer::new_from_unsigned(scope, FRAME_BUILD).into(),
        text(scope, &r.url),
        text(scope, &href),
        r.body,
        text(scope, &r.content_type),
        text_or_null(scope, r.javascript.as_deref()),
        text(scope, &base),
        text_or_null(scope, r.client_id.as_deref()),
        text_or_null(scope, r.referrer.as_deref()),
        text_or_null(scope, r.policy.as_deref()),
        text_or_null(scope, r.refresh.as_deref()),
        text_or_null(scope, created.document.as_deref()),
        text_or_null(scope, created.location),
        v8::Integer::new_from_unsigned(scope, created.sandbox).into(),
    ];
    Ok(v8::Array::new_with_elements(scope, &items).into())
}

// The network's response to the frame's navigation — ONE host call owning the whole chain, a service worker's per hop
// across every window's registrations (a redirect out of one's scope entering another's) with the network after
// (browser.rb `frame_navigation_fetch`) — filed as its Resource Timing entry, and what it says of the document: none
// for a failed navigation (a worker's network error, a redirect loop), the empty document. A build parked on a worker
// still activating (`FRAME_DEFERRED`) — HTML "Handle Fetch" waits for it — loads nothing and owes no `load`, its replay
// the full build and load; a response that makes no document (a 204 / 205: HTML "navigate" aborted) leaves the frame at
// the document it is at, its navigation over with no `load` (`FRAME_KEPT`) — one with none yet at its initial
// about:blank, Chrome.
fn navigate<'s>(scope: &mut v8::PinScope<'s, '_>, host: v8::Local<'_, v8::Function>, cid: i32, container: NodeId, reload: bool, r: &mut Response<'s>) -> Result<u32, Terminated> {
    let started = now(scope, host)?;
    let arena = realm(scope, cid);
    let node = arena.get(container);
    let dest = if node.is_some_and(|n| n.is_html_named("frame")) { "frame" } else { "iframe" };
    let policy = node.map_or("", crate::url_ops::referrer_policy_attribute);
    let referrer = arena.location.href().to_owned();
    let sandbox = arena.frame_sandbox(container);
    let activated = arena.frame_navigation_activated(container);
    let reloaded = arena.frame_realm(container).filter(|_| reload);
    let controlled = crate::dom::dom(scope).arena.sw_may_control_navigation(cid, Some(container));
    let request = [
        text(scope, &r.url),
        v8::Boolean::new(scope, reload).into(),
        text(scope, &referrer),
        v8::Boolean::new(scope, controlled).into(),
        text(scope, "GET"),
        v8::String::empty(scope).into(),
        v8::null(scope).into(),
        v8::Boolean::new(scope, true).into(),
        text(scope, dest),
        v8::Integer::new(scope, cid).into(),
        text(scope, policy),
        reloaded.map_or_else(|| v8::null(scope).into(), |id| v8::Integer::new(scope, id).into()),
        text_or_null(scope, sandbox.as_deref()),
        v8::Boolean::new(scope, activated).into(),
    ];
    let request = v8::Array::new_with_elements(scope, &request).into();
    let resp = call(scope, host, H_FRAME_NAVIGATION, &[request])?.map(|resp| v8::Local::new(scope, resp));
    let resp = resp.and_then(|resp| v8::Local::<v8::Object>::try_from(resp).ok());
    let flag = |scope: &mut v8::PinScope<'_, '_>, k: &str| resp.and_then(|resp| member(scope, resp, k)).is_some_and(|v| v.is_true());
    let no_document = flag(scope, "no_document");
    if no_document {
        let arena = realm(scope, cid);
        arena.take_frame_history_url(container);
        arena.supersede_frame_nav(container);
        call(scope, host, H_LOAD_BLOCKER_SETTLED, &[])?;
        let arena = realm(scope, cid);
        if arena.frame_nav_has(container, COMMIT_PENDING) {
            arena.set_frame_nav(container, COMMIT_PENDING, false);
            return Ok(FRAME_KEPT);
        }
    }
    if flag(scope, "deferred") {
        // (…shelved with no realm made and no `load`: the replay — or a read of its window meanwhile, which parks it
        // again — builds it, its `load` re-armed to fire then)
        let arena = realm(scope, cid);
        arena.set_frame_nav(container, DEFERRED_SW, true);
        arena.set_frame_nav(container, LOAD_FIRED, false);
        return Ok(FRAME_DEFERRED);
    }
    // (…its entry the frame's — an `iframe` / `frame` initiator's — named by the URL it asked for, a network error's too:
    // resource-timing iframe-failed-commit)
    let entry = v8::Object::new(scope);
    let resp_value: v8::Local<v8::Value> = resp.map_or_else(|| v8::null(scope).into(), Into::into);
    let fields = [
        ("name", text(scope, &r.url)),
        ("kind", v8::Integer::new_from_unsigned(scope, crate::resource_timing::J_FRAME).into()),
        ("nid", v8::Number::new(scope, container.to_f64()).into()),
        ("startTime", v8::Number::new(scope, started).into()),
        ("resp", resp_value),
    ];
    for (k, v) in fields {
        let k = text(scope, k);
        entry.set(scope, k, v);
    }
    call(scope, host, H_FILE, &[entry.into()])?;
    let Some(resp) = resp else { return Ok(FRAME_BUILD) };
    let string = |scope: &mut v8::PinScope<'_, '_>, k: &str| member(scope, resp, k).map(|v| v.to_rust_string_lossy(scope)).filter(|s| !s.is_empty());
    r.client_id = string(scope, "resulting_client_id");
    r.referrer = string(scope, "referrer");
    // (…its bytes — a pure-ASCII text body comes without them, its text its bytes)
    r.body = match member(scope, resp, "body_bytes") {
        Some(bytes) => bytes,
        None => {
            let body = string(scope, "body").unwrap_or_default();
            crate::dom::u8_array(scope, body.into_bytes())
        }
    };
    // (…its URL after redirects the response's, as the URL parser serializes it, the one it asked for where none
    // redirected it; its headers by name, ASCII case-insensitively)
    if flag(scope, "redirected") {
        if let Some(url) = string(scope, "url") {
            let parsed = ada_url::Url::parse(&url, None).ok().map(|u| u.href().to_owned());
            r.url = parsed.unwrap_or(url);
        }
    }
    if let Some(headers) = member(scope, resp, "headers").and_then(|h| v8::Local::<v8::Object>::try_from(h).ok()) {
        let header = |scope: &mut v8::PinScope<'_, '_>, name: &str| crate::fetch_rules::response_header(scope, headers, name);
        r.csp = header(scope, "content-security-policy").filter(|s| !s.is_empty());
        r.policy = header(scope, "referrer-policy");
        r.refresh = header(scope, "refresh");
        if let Some(content_type) = header(scope, "content-type").filter(|s| !s.is_empty()) {
            r.content_type = content_type;
        }
    }
    if no_document {
        r.url = "about:blank".to_owned();
    }
    Ok(FRAME_BUILD)
}
