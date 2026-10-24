// The resources connecting an element fetches that nothing here consumes — a media element's poster, media data and
// shown tracks, an SVG `<use>`'s external document — which the bindings fetch for what a page observes of them: their
// Resource Timing entries, and a controlling service worker's `fetch` events. Which ones, by what URL and initiator, is
// decided here; each once for the page (`RealmState::timed_resources`). And a plugin's resource — an `<embed>`'s, an
// `<object>`'s — fetched as each of its element's processing runs, whose `load` its page may wait on.

use std::collections::HashSet;

use web_atoms::ns;

use crate::dom::{nid_arg, NodeId, NodeKind, RealmArena};

// The resources `timed_resources` (and `useReference`) handed out for the page, by initiator and URL.
pub(crate) type TimedResources = HashSet<(&'static str, String)>;

// What a resource's request carries of its element's `crossorigin`: none (a no-cors request), `anonymous` (cors, the
// same-origin credentials mode), `use-credentials` (cors, credentials included).
const NO_CORS: u32 = 0;
const CORS: u32 = 1;
const CORS_CREDENTIALS: u32 = 2;


pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "timedResources", timed_resources_op, context_id);
    crate::dom::register(scope, ns, "pluginResource", plugin_resource_op, context_id);
    crate::dom::register(scope, ns, "useReference", use_reference_op, context_id);
}

// The URL an SVG `<use>` element `id` references in another document — its `href`, else its XLink one, trimmed and
// parsed against `doc`'s base URL, the fragment (which names the piece, not the resource) dropped — or None for a
// same-document reference (`#id`), none, or no URL, and in a document with no browsing context, which loads nothing.
pub(crate) fn use_reference(arena: &mut RealmArena, id: NodeId, doc: NodeId) -> Option<String> {
    if !arena.document_states.has_browsing_context(doc) {
        return None;
    }
    let n = arena.get(id).filter(|n| n.kind == NodeKind::Element && n.ns == ns!(svg) && &*n.local_name == "use")?;
    let raw = n.plain_attr("href").or_else(|| n.ns_attr("http://www.w3.org/1999/xlink", "href"))?;
    let s = raw.trim().to_owned();
    if s.is_empty() || s.starts_with('#') {
        return None;
    }
    let mut url = arena.parse_document_url(doc, &s)?;
    url.set_hash(None);
    Some(url.href().to_owned())
}

// The resources connecting element `id` (of document `doc`) fetches for no consumer, those the page has not fetched
// yet, each `(initiator, destination, url, cors)` — its Resource Timing initiator type and its request's destination
// (Fetch: what Fetch Metadata's `Sec-Fetch-Dest` reports) — none in a document with no browsing context, which loads
// nothing:
//   a `<video>`'s `poster` ('video', an image);
//   a `<video>` / `<audio>`'s media data — its `src` attribute's where it has one (an empty one is a failure, no fetch),
//     else its first `<source src>` — unless `preload` says `none` (ASCII case-insensitively) and opts it out until it
//     plays ('video' / 'audio', of their own destinations); and each `<track default src>` child ('track'). (Chrome
//     picks the first PLAYABLE source and loads a track only when its mode shows: the first source and the `default`
//     tracks stand in.)
//   an SVG `<use>`'s external document (`use_reference`), 'other' (resource-timing/initiator-type/svg), an image
//     (whatwg/fetch#1012).
fn timed_resources(arena: &mut RealmArena, id: NodeId, doc: NodeId) -> Vec<(&'static str, &'static str, String, u32)> {
    if !arena.document_states.has_browsing_context(doc) {
        return Vec::new();
    }
    let Some(n) = arena.get(id).filter(|n| n.kind == NodeKind::Element) else { return Vec::new() };
    let mut wanted: Vec<(&'static str, &'static str, NodeId, String)> = Vec::new();
    if n.ns == ns!(html) {
        let attr = |name: &str| n.plain_attr(name).filter(|v| !v.is_empty()).map(str::to_owned);
        match &*n.local_name {
            tag @ ("video" | "audio") => {
                let initiator = if tag == "video" { "video" } else { "audio" };
                if let Some(poster) = attr("poster").filter(|_| tag == "video") {
                    wanted.push(("video", "image", id, poster));
                }
                let first_source = || {
                    n.children.iter().find_map(|&c| {
                        let c = arena.get(c).filter(|c| c.is_html_named("source"))?;
                        c.plain_attr("src").filter(|v| !v.is_empty()).map(str::to_owned)
                    })
                };
                if !n.plain_attr("preload").is_some_and(|p| p.eq_ignore_ascii_case("none")) {
                    let src = match n.plain_attr("src") {
                        Some(src) => Some(src.to_owned()).filter(|s| !s.is_empty()),
                        None => first_source(),
                    };
                    wanted.extend(src.map(|src| (initiator, initiator, id, src)));
                }
                for &c in &n.children {
                    let Some(track) = arena.get(c).filter(|c| c.is_html_named("track") && c.plain_attr("default").is_some()) else { continue };
                    if let Some(src) = track.plain_attr("src").filter(|v| !v.is_empty()) {
                        wanted.push(("track", "track", c, src.to_owned()));
                    }
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    for (initiator, destination, el, raw) in wanted {
        let Some(url) = arena.parse_document_url(doc, &raw) else { continue };
        out.push((initiator, destination, url.href().to_owned(), cors_of(arena, el)));
    }
    if let Some(url) = use_reference(arena, id, doc) {
        out.push(("other", "image", url, NO_CORS));
    }
    let seen = &mut arena.timed_resources;
    out.retain(|(initiator, _, url, _)| seen.insert((initiator, url.clone())));
    out
}

// What element `id`'s `crossorigin` asks of its resource's request (fetch_rules.rs `cors_request`).
fn cors_of(arena: &RealmArena, id: NodeId) -> u32 {
    match crate::fetch_rules::cors_request(arena.get(id).and_then(|n| n.plain_attr("crossorigin")), false) {
        ("no-cors", _) => NO_CORS,
        (_, "include") => CORS_CREDENTIALS,
        _ => CORS,
    }
}

// __dom.timedResources(el, docNid) -> `[initiator, destination, url, cors, …]`: the resources connecting `el` fetches
// for no consumer (`timed_resources`), `cors` NO_CORS / CORS / CORS_CREDENTIALS; undefined for none.
fn timed_resources_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(id), Some(doc)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return };
    let found = timed_resources(&mut crate::dom::dom(scope).arena, id, doc);
    if found.is_empty() {
        return;
    }
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(found.len() * 4);
    for (initiator, destination, url, cors) in &found {
        let (Some(i), Some(d), Some(u)) = (v8::String::new(scope, initiator), v8::String::new(scope, destination), v8::String::new(scope, url)) else { continue };
        items.push(i.into());
        items.push(d.into());
        items.push(u.into());
        items.push(v8::Integer::new_from_unsigned(scope, *cors).into());
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.useReference(el, docNid) -> the external document an SVG `<use>` references (`use_reference`), which a
// controlled document fetches through its service worker (destination `image`) — once for the page, undefined after.
fn use_reference_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(id), Some(doc)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return };
    let arena = &mut crate::dom::dom(scope).arena;
    let Some(url) = use_reference(arena, id, doc).filter(|u| arena.timed_resources.insert(("image", u.clone()))) else { return };
    if let Some(url) = v8::String::new(scope, &url) {
        rv.set(url.into());
    }
}

// The resource a connected `<embed>` or `<object>` element `id` (of document `doc`) is to fetch as its processing runs
// — HTML's embed setup steps and object processing model, at its insertion and as its `src` / `data` / `type` change —
// `(destination, url)`: an `<embed src>`'s ('embed'), an `<object data>`'s ('object'), each parsed against `doc`'s base
// URL; none for one with none, in a document with no browsing context, or that is a descendant of an `<object>` with a
// resource of its own, which shows that rather than the fallback content it is part of. (Whether it is being rendered,
// which an `<embed>`'s being potentially active also asks, is not asked: the layout may not be made yet.)
fn plugin_resource(arena: &mut RealmArena, id: NodeId, doc: NodeId) -> Option<(&'static str, String)> {
    if !arena.document_states.has_browsing_context(doc) || !arena.is_connected(id) {
        return None;
    }
    let n = arena.get(id).filter(|n| n.kind == NodeKind::Element && n.ns == ns!(html))?;
    let (destination, raw) = match &*n.local_name {
        "embed" => ("embed", n.plain_attr("src")?.to_owned()),
        "object" => ("object", n.plain_attr("data")?.to_owned()),
        _ => return None,
    };
    if raw.is_empty() {
        return None;
    }
    let mut at = n.parent;
    while let Some(p) = at.and_then(|p| arena.get(p)) {
        if p.is_html_named("object") && p.plain_attr("data").is_some_and(|d| !d.is_empty()) {
            return None;
        }
        at = p.parent;
    }
    Some((destination, arena.parse_document_url(doc, &raw)?.href().to_owned()))
}

// __dom.pluginResource(el, docNid) -> `[destination, url]` (`plugin_resource`), or undefined.
fn plugin_resource_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(id), Some(doc)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return };
    let Some((destination, url)) = plugin_resource(&mut crate::dom::dom(scope).arena, id, doc) else { return };
    let (Some(d), Some(u)) = (v8::String::new(scope, destination), v8::String::new(scope, &url)) else { return };
    rv.set(v8::Array::new_with_elements(scope, &[d.into(), u.into()]).into());
}
