// What a `<link>` obtains, and whether what it fetched is what it asked for (HTML "fetch and process the linked
// resource", by its link types): the engine's plan of a link's load, and its verdict on the response — the bindings
// fetch (a service worker's answer, the asset cache, the network, a `data:` URL), file the timing and fire the event.

use crate::dom::{nid_arg, realm, realm_id, NodeId, RealmArena, STATE_LINK_MEDIA_SKIPPED};
use crate::token_list::{link_types, LINK_MANIFEST, LINK_MODULEPRELOAD, LINK_PREFETCH, LINK_PRELOAD, LINK_STYLESHEET};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "linkPlan", link_plan_op, context_id);
    crate::dom::register(scope, ns, "linkMediaSkipped", link_media_skipped_op, context_id);
    crate::dom::register(scope, ns, "linkResponseAccepted", link_response_accepted_op, context_id);
}

// What a link's load does (`link_plan`): nothing — no fetch, no event; fail at once — its `error`, no fetch; or fetch.
const PLAN_NONE: u32 = 0;
const PLAN_FAIL: u32 = 1;
const PLAN_FETCH: u32 = 2;
// The resources a link obtains, by its link types (`link_plan`'s second answer): a style sheet, a prefetch, a module
// preload, a preload — one that is none of the others — and a manifest.
const OBTAINS_STYLESHEET: u32 = 1;
const OBTAINS_PREFETCH: u32 = 1 << 1;
const OBTAINS_MODULEPRELOAD: u32 = 1 << 2;
const OBTAINS_PRELOAD: u32 = 1 << 3;
const OBTAINS_MANIFEST: u32 = 1 << 4;

pub(crate) struct Plan {
    pub(crate) verdict: u32,
    pub(crate) obtains: u32,
    pub(crate) module_destination: Option<&'static str>,
    pub(crate) preload_destination: Option<&'static str>,
}

// A link's plan, `media_matches` asked of its `media` where that decides it: a disabled one obtains nothing; a
// modulepreload or a preload — one that is no style sheet — whose `media` does not match obtains nothing until a change
// of it matches (the element's `STATE_LINK_MEDIA_SKIPPED`, which `linkMediaSkipped` reads); a preload whose `as` names
// no preload destination nothing; one with no `href` nothing; a modulepreload whose `as` names a destination no module
// is fails without a fetch; anything else fetches.
pub(crate) fn link_plan(arena: &mut RealmArena, id: NodeId, media_matches: impl FnOnce(&str) -> bool) -> Plan {
    let none = Plan { verdict: PLAN_NONE, obtains: 0, module_destination: None, preload_destination: None };
    let Some(n) = arena.get(id) else { return none };
    if n.plain_attr("disabled").is_some() {
        return none;
    }
    let rel = link_types(n.plain_attr("rel").unwrap_or(""));
    let stylesheet = rel & LINK_STYLESHEET != 0;
    let module = rel & LINK_MODULEPRELOAD != 0;
    let preload = rel & LINK_PRELOAD != 0 && rel & (LINK_STYLESHEET | LINK_MODULEPRELOAD | LINK_PREFETCH | LINK_MANIFEST) == 0;
    let obtains = u32::from(stylesheet) * OBTAINS_STYLESHEET
        | u32::from(!stylesheet && rel & LINK_PREFETCH != 0) * OBTAINS_PREFETCH
        | u32::from(module) * OBTAINS_MODULEPRELOAD
        | u32::from(preload) * OBTAINS_PRELOAD
        | u32::from(rel & LINK_MANIFEST != 0) * OBTAINS_MANIFEST;
    let as_value = n.plain_attr("as").unwrap_or("");
    let module_destination = if module { crate::script::modulepreload_destination(as_value) } else { None };
    let preload_destination = if preload { crate::script::preload_destination(as_value) } else { None };
    let media = n.plain_attr("media").map(str::to_owned);
    let href = n.plain_attr("href").is_some_and(|h| !h.is_empty());
    let skipped = (module || preload) && !stylesheet && media.is_some_and(|m| !media_matches(&m));
    if let Some(n) = arena.get_mut_quietly(id) {
        n.state = if skipped { n.state | STATE_LINK_MEDIA_SKIPPED } else { n.state & !STATE_LINK_MEDIA_SKIPPED };
    }
    let verdict = if skipped || (preload && preload_destination.is_none()) || obtains == 0 || !href {
        PLAN_NONE
    } else if module && !stylesheet && module_destination.is_none() {
        PLAN_FAIL
    } else {
        PLAN_FETCH
    };
    Plan { verdict, obtains, module_destination, preload_destination }
}

// Whether a link's fetched response is what it obtains (HTML "process the linked resource", by its link types): a
// style sheet's — `sheet_owners.rs` `sheet_response_accepted`, but for one a service worker answered (`worker`), taken
// as the sheet it answers (static-router's `new Response(text)`); a module preload's — a module of its destination's
// kind (`script.rs` `module_content`), whoever answered; a preload's — none `nosniff` refuses its destination
// (`fetch_rules.rs` `blocked_by_nosniff`). The fetch's own failure — a network error, a non-ok status — is the
// caller's.
#[allow(clippy::too_many_arguments)]
pub(crate) fn link_response_accepted(
    obtains: u32,
    module_destination: &str,
    preload_destination: &str,
    content_type: &str,
    nosniff: &str,
    quirks: bool,
    worker: bool,
    same_origin: impl FnOnce() -> bool,
) -> bool {
    let stylesheet = obtains & OBTAINS_STYLESHEET != 0;
    if stylesheet && !worker && !crate::sheet_owners::sheet_response_accepted(content_type, nosniff, quirks, same_origin) {
        return false;
    }
    if obtains & OBTAINS_MODULEPRELOAD != 0 && !stylesheet && !crate::script::module_content(content_type, module_destination) {
        return false;
    }
    !(obtains & OBTAINS_PRELOAD != 0 && crate::fetch_rules::blocked_by_nosniff(preload_destination, content_type, nosniff))
}

// __dom.linkPlan(nid) -> [verdict, obtains, moduleDestination | null, preloadDestination | null] (`link_plan`, its media
// matched on this realm's viewport).
fn link_plan_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let viewport = crate::media_query_lists::viewport_here(scope, &args);
    let media = realm(scope, cid).get(id).and_then(|n| n.plain_attr("media").map(str::to_owned));
    let matched = media.map(|m| crate::media_query_lists::matches(scope, cid, &m, viewport));
    let plan = link_plan(crate::dom::dom(scope).arena.enter(cid), id, |_| matched.unwrap_or(true));
    let items = [
        v8::Integer::new_from_unsigned(scope, plan.verdict).into(),
        v8::Integer::new_from_unsigned(scope, plan.obtains).into(),
        text(scope, plan.module_destination),
        text(scope, plan.preload_destination),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// (…a destination as a string, null for none)
fn text<'s>(scope: &mut v8::PinScope<'s, '_>, d: Option<&str>) -> v8::Local<'s, v8::Value> {
    d.and_then(|d| v8::String::new(scope, d)).map_or_else(|| v8::null(scope).into(), Into::into)
}

// __dom.linkMediaSkipped(nid) -> whether the link's last plan obtained nothing for its `media` (a change of that is
// what plans it again).
fn link_media_skipped_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let cid = realm_id(scope, &args);
    rv.set_bool(realm(scope, cid).get(id).is_some_and(|n| n.state & STATE_LINK_MEDIA_SKIPPED != 0));
}

// __dom.linkResponseAccepted(obtains, moduleDestination, preloadDestination, contentType, nosniff, url, quirks, worker)
// -> `link_response_accepted`, same-origin by `url` against this realm's origin.
fn link_response_accepted_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let obtains = args.get(0).uint32_value(scope).unwrap_or(0);
    let [module, preload, content_type, nosniff, url] = [1, 2, 3, 4, 5].map(|i| {
        let v = args.get(i);
        if v.is_null_or_undefined() { String::new() } else { v.to_rust_string_lossy(scope) }
    });
    let (quirks, worker) = (args.get(6).is_true(), args.get(7).is_true());
    let cid = realm_id(scope, &args);
    let origin = realm(scope, cid).location.origin().to_owned();
    let same_origin = || ada_url::Url::parse(&url, None).is_ok_and(|u| u.origin() == origin);
    rv.set_bool(link_response_accepted(obtains, &module, &preload, &content_type, &nosniff, quirks, worker, same_origin));
}

#[cfg(test)]
mod tests {
    use super::*;

    // A style sheet by its type — a worker's answer taken as it is — a module preload by its module's kind, a preload by
    // `nosniff` against its destination; a link of several types by each.
    #[test]
    fn a_links_response_is_judged_by_what_it_obtains() {
        let ok = |obtains, module, preload, ct, nosniff, worker| link_response_accepted(obtains, module, preload, ct, nosniff, false, worker, || false);
        assert!(ok(OBTAINS_STYLESHEET, "", "", "text/css", "", false) && !ok(OBTAINS_STYLESHEET, "", "", "text/plain", "", false));
        assert!(ok(OBTAINS_STYLESHEET, "", "", "text/plain", "", true));
        assert!(ok(OBTAINS_MODULEPRELOAD, "script", "", "text/javascript", "", true) && !ok(OBTAINS_MODULEPRELOAD, "style", "", "text/javascript", "", false));
        assert!(!ok(OBTAINS_PRELOAD, "", "style", "text/plain", "nosniff", false) && ok(OBTAINS_PRELOAD, "", "font", "text/plain", "nosniff", false));
        assert!(ok(OBTAINS_STYLESHEET | OBTAINS_MODULEPRELOAD, "script", "", "text/css", "", false));
        assert!(ok(OBTAINS_PREFETCH | OBTAINS_MANIFEST, "", "", "text/html", "nosniff", false));
    }
}
