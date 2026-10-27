// The resources connecting an element fetches that nothing here consumes — a media element's poster, media data and
// shown tracks, an SVG `<use>`'s external document — which the bindings fetch for what a page observes of them: their
// Resource Timing entries, and a controlling service worker's `fetch` events. Which ones, by what URL and initiator, is
// decided here; each once for the page (`RealmState::timed_resources`). And a plugin's resource — an `<embed>`'s, an
// `<object>`'s — fetched as each of its element's processing runs, whose `load` its page may wait on.

use std::collections::HashSet;

use web_atoms::ns;

use crate::dom::{nid_arg, NodeId, NodeKind, RealmArena};

// The resources `timed_resources` handed out for the page, by initiator and URL — and the images
// and `@import`s whose entries it filed (resource_timing.rs `filed_once`: "img", "css"), as its memory cache serves them
// after. (An SVG `<use>`'s external document is a resource of another type, kept apart: `use`.)
pub(crate) type TimedResources = HashSet<(&'static str, String)>;

// What a resource's request carries of its element's `crossorigin`: none (a no-cors request), `anonymous` (cors, the
// same-origin credentials mode), `use-credentials` (cors, credentials included).
const NO_CORS: u32 = 0;
const CORS: u32 = 1;
const CORS_CREDENTIALS: u32 = 2;
// …or none of another origin's (a same-origin request): a track's of a media element of no `crossorigin` (HTML's track
// processing model, its potential-CORS request's "same-origin fallback flag"), an SVG `<use>`'s external document.
const SAME_ORIGIN: u32 = 3;
// …and such a request of another origin's URL than its document's: a network error before any worker could answer it
// (Fetch "main fetch": a same-origin request's to another origin), no request made.
pub(crate) const SAME_ORIGIN_REFUSED: u32 = 4;
// A timed resource's code, which its consumer's kind carries (J_TIMED's high bits, subresource_plan.rs): its `crossorigin`
// code above, and over it whether its request's destination is `track` — else `image` (a poster, an SVG `<use>`'s
// document).
pub(crate) const TRACK: u32 = 1 << 4;
pub(crate) fn timed_destination(code: u32) -> &'static str {
    if code & TRACK != 0 { "track" } else { "image" }
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
// yet, each `(initiator, url, code)` — its Resource Timing initiator type and its request's code (`TRACK` among its
// bits for a track's: its request's destination, what Fetch Metadata's `Sec-Fetch-Dest` reports, else an image's) —
// none in a document with no browsing context, which loads nothing:
//   a `<video>`'s `poster` ('video', an image);
//   each `<track default src>` child of a `<video>` / `<audio>` ('track': Chrome loads a track only when its mode shows,
//     the `default` tracks standing in) — its media data the element's own fetch, its load algorithm's (media.js);
//   an SVG `<use>`'s external document (`use_reference`), 'other' (resource-timing/initiator-type/svg), an image
//     (whatwg/fetch#1012).
pub(crate) fn timed_resources(arena: &mut RealmArena, id: NodeId, doc: NodeId) -> Vec<(&'static str, String, u32)> {
    if !arena.document_states.has_browsing_context(doc) {
        return Vec::new();
    }
    let Some(n) = arena.get(id).filter(|n| n.kind == NodeKind::Element) else { return Vec::new() };
    // (…each by the element whose `crossorigin` its request takes, none for one of no CORS settings: a poster's)
    let mut wanted: Vec<(&'static str, u32, Option<NodeId>, String)> = Vec::new();
    if n.ns == ns!(html) {
        let attr = |name: &str| n.plain_attr(name).filter(|v| !v.is_empty()).map(str::to_owned);
        match &*n.local_name {
            tag @ ("video" | "audio") => {
                // (…a poster's a plain request, its credentials included: HTML's poster frame steps)
                if let Some(poster) = attr("poster").filter(|_| tag == "video") {
                    wanted.push(("video", 0, None, poster));
                }
                // (…a track's request by its media element's `crossorigin`: HTML's track processing model, "the state of
                // the parent media element's crossorigin content attribute")
                for &c in &n.children {
                    let Some(track) = arena.get(c).filter(|c| c.is_html_named("track") && c.plain_attr("default").is_some()) else { continue };
                    if let Some(src) = track.plain_attr("src").filter(|v| !v.is_empty()) {
                        wanted.push(("track", TRACK, Some(id), src.to_owned()));
                    }
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    for (initiator, track, el, raw) in wanted {
        let Some(url) = arena.parse_document_url(doc, &raw) else { continue };
        let cors = match el.map_or(NO_CORS, |el| cors_of(arena, el)) {
            NO_CORS if track != 0 => same_origin(arena, url.origin()),
            cors => cors,
        };
        out.push((initiator, url.href().to_owned(), cors | track));
    }
    if let Some(url) = use_reference(arena, id, doc) {
        let cors = ada_url::Url::parse(&url, None).map_or(SAME_ORIGIN_REFUSED, |u| same_origin(arena, u.origin()));
        out.push(("other", url, cors));
    }
    let seen = &mut arena.timed_resources;
    out.retain(|(initiator, url, _)| seen.insert((initiator, url.clone())));
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

// …and the mode and credentials mode a `cors` code (`cors_of`) is.
// A same-origin request's code for a URL of `origin`: its document's own, else refused.
fn same_origin(arena: &RealmArena, origin: String) -> u32 {
    if origin == arena.location.origin() { SAME_ORIGIN } else { SAME_ORIGIN_REFUSED }
}
pub(crate) fn timed_cors_request(code: u32) -> (&'static str, &'static str) {
    match code & !TRACK {
        NO_CORS => ("no-cors", "include"),
        CORS_CREDENTIALS => ("cors", "include"),
        SAME_ORIGIN | SAME_ORIGIN_REFUSED => ("same-origin", "include"),
        _ => ("cors", "same-origin"),
    }
}



// The resource a connected `<embed>` or `<object>` element `id` (of document `doc`) is to fetch as its processing runs
// — HTML's embed setup steps and object processing model, at its insertion and as its `src` / `data` / `type` change —
// `(destination, url)`: an `<embed src>`'s ('embed'), an `<object data>`'s ('object'), each parsed against `doc`'s base
// URL; none for one with none, in a document with no browsing context, or that is a descendant of an `<object>` not
// showing its fallback content (rendered.rs `object_shows_fallback`) — it shows its resource instead — or of a media
// element, whose children are no content of its. (Whether it is being rendered, which an `<embed>`'s being potentially
// active also asks, is not asked: the layout may not be made yet.)
pub(crate) fn plugin_resource(arena: &mut RealmArena, id: NodeId, doc: NodeId) -> Option<(&'static str, String)> {
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
        if (p.is_html_named("object") && !crate::rendered::object_shows_fallback(p)) || p.is_html_named("video") || p.is_html_named("audio") {
            return None;
        }
        at = p.parent;
    }
    Some((destination, arena.parse_document_url(doc, &raw)?.href().to_owned()))
}

// Whether the `<object>` `id` showing its fallback content as its processing ends — its resource failed to load, or it
// has none — or no longer, `on`, changed it (`STATE_OBJECT_FALLBACK`).
pub(crate) fn set_object_fallback(arena: &mut RealmArena, id: NodeId, on: bool) -> bool {
    let Some(state) = arena.get(id).map(|n| n.state) else { return false };
    let was = state & crate::dom::STATE_OBJECT_FALLBACK != 0;
    if was != on {
        arena.set_state(id, state ^ crate::dom::STATE_OBJECT_FALLBACK);
    }
    was != on
}
