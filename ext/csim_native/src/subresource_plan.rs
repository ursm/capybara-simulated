// How a subresource is requested — the engine's plan of the request a consumer makes (Fetch "request"): its mode and
// credentials mode, the referrer policy it is made under, and whether its client's origin is opaque — packed in one
// small integer the bindings hand the host, which decodes it (`fields`) rather than be told each by hand.

use crate::subresource_judge::{J_AUDIO, J_CLASSIC_SCRIPT, J_CSS_MODULE, J_FONT, J_IMAGE, J_LINK, J_OBJECT, J_PREFETCH, J_SHEET, J_VIDEO};

// The consumer (`kind`, low byte; a link's what it obtains, a timed resource's its CORS code, in the high bits): those of
// the judge (subresource_judge.rs `J_*`), a CSS image (a `background-image` `url()` …), an `<embed>`'s resource, and a
// resource fetched for its Resource Timing entry alone (subresources.rs `timed_resources`).
pub(crate) const J_CSS_IMAGE: u32 = 12;
pub(crate) const J_EMBED: u32 = 13;
pub(crate) const J_TIMED: u32 = 14;
pub(crate) const J_MODULE_SCRIPT: u32 = 15;

// The plan's fields: bits 0-1 the mode, 2-3 the credentials mode, 4-7 the referrer policy (0 none, else one past its
// index in url_ops.rs `POLICIES`), 8 an opaque client.
const MODES: [&str; 4] = ["no-cors", "cors", "same-origin", "navigate"];
// (…a plan of nothing a request's defaults: no-cors, same-origin — Fetch "request")
const CREDENTIALS: [&str; 3] = ["same-origin", "include", "omit"];
const OPAQUE: u32 = 1 << 8;
// …bits 9-13 its destination (Fetch's request destination: what its Fetch Metadata reports, what a service worker's
// fetch event reads), by its index in `DESTINATIONS` — a plan of none, the empty string.
const DESTINATION_SHIFT: u32 = 9;
const DESTINATIONS: [&str; 23] = [
    "", "audio", "audioworklet", "document", "embed", "font", "frame", "iframe", "image", "json", "manifest", "object",
    "paintworklet", "report", "script", "serviceworker", "sharedworker", "style", "track", "video", "webidentity", "worker",
    "xslt",
];
// …bit 14 its initiator `prefetch` (a `<link rel=prefetch>`'s), whose `Accept` that says before its destination does.
const PREFETCH: u32 = 1 << 14;
// …its request's fields alone, its mode and credentials mode: what tells two requests of one URL apart (a preload key's).
pub(crate) const PLAN_REQUEST: u32 = 15;

// The plan of a `kind` consumer's request:
// - its mode and credentials mode: an image's, a video's, an audio's, a classic script's, a style sheet's, a link's and a
//   prefetch's a potential-CORS request by the element's `crossorigin` (HTML "create a potential-CORS request": fetch_rules.rs
//   `cors_request`), a module script's, a module preload's and a CSS module script's a module script's (a CORS one
//   whatever — a same-origin one for a module preload of a worker: "fetch a single module script" of a top-level
//   one); a font's a CORS one of credentials same-origin (CSS Fonts 4 §4.9.1); a CSS image's no-cors with its
//   credentials included (CSS Values 4 "fetch a style resource"); a plugin's a navigation's; a timed resource's as
//   `timed_resources` found it;
// - the referrer policy it is made under: the element's `referrerpolicy` (`attr`) — or the style sheet's responsible
//   for it, where its response set one (`plan_op`'s `sheet`: Referrer Policy §7) — else the one its document had as
//   the element was inserted (`noted`: its default where it had none); else, for a load the host makes for an image, a
//   video or a CSS image, its document's (`document`, its `<meta name="referrer">`'s) — none for any other, whose
//   fetch takes its policy container's as it is made (Fetch "main fetch"): a module script's options keep its own;
// - its client's origin opaque or not.
// (`worker` whether a module preload's `as` names a worker's destination)
#[allow(clippy::too_many_arguments)]
pub(crate) fn plan(kind: u32, crossorigin: Option<&str>, worker: bool, attr: &str, noted: Option<&str>, document: &str, opaque: bool) -> u32 {
    let (kind, high) = (kind & 0xff, kind >> 8);
    let modulepreload = kind == J_LINK && high & crate::link_resource::OBTAINS_MODULEPRELOAD != 0;
    let (mode, credentials) = match kind {
        J_IMAGE | J_VIDEO | J_AUDIO | J_CLASSIC_SCRIPT | J_SHEET | J_PREFETCH => crate::fetch_rules::cors_request(crossorigin, false),
        J_LINK if modulepreload && worker => ("same-origin", crate::fetch_rules::cors_request(crossorigin, true).1),
        J_LINK => crate::fetch_rules::cors_request(crossorigin, modulepreload),
        J_FONT => ("cors", "same-origin"),
        J_CSS_MODULE => crate::fetch_rules::cors_request(None, true),
        J_MODULE_SCRIPT => crate::fetch_rules::cors_request(crossorigin, true),
        J_OBJECT | J_EMBED => ("navigate", "include"),
        J_TIMED => crate::subresources::timed_cors_request(high),
        J_CSS_IMAGE => ("no-cors", "include"),
        _ => ("no-cors", "include"),
    };
    let noted = noted.map(|p| if p.is_empty() { crate::url_ops::DEFAULT_POLICY } else { p });
    let load = matches!(kind, J_IMAGE | J_VIDEO | J_CSS_IMAGE);
    let policy = if !attr.is_empty() { attr } else { noted.unwrap_or(if load { document } else { "" }) };
    let policy = crate::url_ops::POLICIES.iter().position(|p| *p == policy).map_or(0, |i| i as u32 + 1);
    request_bits(mode, credentials) | policy << 4 | if opaque { OPAQUE } else { 0 }
}
// …its request fields alone (`PLAN_REQUEST`'s): its mode's and its credentials mode's.
fn request_bits(mode: &str, credentials: &str) -> u32 {
    let index = |table: &[&str], v: &str| table.iter().position(|t| *t == v).unwrap_or(0) as u32;
    index(&MODES, mode) | index(&CREDENTIALS, credentials) << 2
}
// …and its fields: [mode, credentials, referrer policy ('' for none), opaque client].
pub(crate) fn fields(plan: u32) -> (&'static str, &'static str, &'static str, bool) {
    let policy = (plan >> 4 & 15) as usize;
    (
        MODES[(plan & 3) as usize],
        CREDENTIALS.get((plan >> 2 & 3) as usize).copied().unwrap_or("omit"),
        if policy == 0 { "" } else { crate::url_ops::POLICIES.get(policy - 1).copied().unwrap_or("") },
        plan & OPAQUE != 0,
    )
}
// Capybara::Simulated::Native.subresource_plan_fields(plan) -> `fields`, for the host's request, its destination and its
// `Accept`.
pub(crate) fn fields_for_ruby(plan: u32) -> (String, String, String, bool, String, String) {
    let (mode, credentials, policy, opaque) = fields(plan);
    (mode.to_owned(), credentials.to_owned(), policy.to_owned(), opaque, destination(plan).to_owned(), accept(plan).to_owned())
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "subresourcePlan", plan_op, context_id);
    crate::dom::register(scope, ns, "subresourcePlanFields", fields_op, context_id);
    crate::dom::register(scope, ns, "requestPlanOf", request_plan_op, context_id);
    crate::dom::register(scope, ns, "requestReferrerPolicy", request_referrer_policy_op, context_id);
}
// __dom.requestReferrerPolicy(plan) -> the referrer policy a request of `plan` (0: a request's defaults, which name none)
// is made under: its own, else its policy container's — the calling realm's document's (its `<meta name="referrer">`'s,
// url_ops.rs `document_referrer_policy`), none for a worker's — else the default (Fetch "main fetch", Referrer Policy §3).
fn request_referrer_policy_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (_, _, own, _) = fields(args.get(0).uint32_value(scope).unwrap_or(0));
    let cid = crate::dom::realm_id(scope, &args);
    let realm = crate::dom::realm(scope, cid);
    let container = realm.realm_document(cid).map_or("", |doc| realm.document_referrer_policy(doc));
    let policy = [own, container].into_iter().find(|p| !p.is_empty()).unwrap_or(crate::url_ops::DEFAULT_POLICY);
    if let Some(s) = v8::String::new(scope, policy) {
        rv.set(s.into());
    }
}
// __dom.subresourcePlanFields(plan) -> [mode, credentials, referrer policy, destination] of `plan` (`fields`,
// `destination`).
fn fields_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let plan = args.get(0).uint32_value(scope).unwrap_or(0);
    let (mode, credentials, policy, _) = fields(plan);
    let items: Vec<v8::Local<v8::Value>> =
        [mode, credentials, policy, destination(plan)].iter().filter_map(|t| v8::String::new(scope, t)).map(Into::into).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.requestPlanOf(mode, credentials) -> the plan of a request of `mode` and `credentials` mode alone — a `fetch()`'s,
// whose fields its Request holds — no referrer policy of its own (`PLAN_REQUEST`'s fields: what a preload key holds).
fn request_plan_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let [mode, credentials] = [0, 1].map(|i| args.get(i).to_rust_string_lossy(scope));
    rv.set_uint32(request_bits(&mode, &credentials));
}
// __dom.subresourcePlan(kind, nid, doc[, sheet]) -> `plan` of the request a `kind` consumer makes for the element `nid`
// (none for one no element makes) in the document `doc`, from the calling realm, whose origin is its client's — one a
// style sheet is responsible for (an `@import`'s, an image's, a font's) under that sheet's policy, `sheet` its location
// (url_ops.rs `sheet_referrer_policy`).
// (…the opaque bit the calling realm's: a load the host makes for an image or a video says it, as the host cannot ask a
// frame still parsing — the host asks a request element's realm its own)
fn plan_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let kind = args.get(0).uint32_value(scope).unwrap_or(0);
    let (el, doc) = (crate::dom::nid_arg(scope, &args, 1), crate::dom::nid_arg(scope, &args, 2));
    let sheet = args.get(3).is_string().then(|| args.get(3).to_rust_string_lossy(scope));
    let cid = crate::dom::realm_id(scope, &args);
    rv.set_uint32(plan_in(crate::dom::realm(scope, cid), kind, el, doc, sheet.as_deref()));
}
// …the plan of it in `realm`: what of the element, its document and the sheet `plan` takes.
pub(crate) fn plan_in(realm: &crate::dom::RealmArena, kind: u32, el: Option<crate::dom::NodeId>, doc: Option<crate::dom::NodeId>, sheet: Option<&str>) -> u32 {
    let node = el.and_then(|id| realm.get(id));
    // (…an `<input type=image>`'s request no potential-CORS one: it has no CORS settings attribute)
    let crossorigin = node.filter(|n| !n.is_html_named("input")).and_then(|n| n.plain_attr("crossorigin"));
    // (…the attribute of an element that has one: an `<img>`'s, a `<script>`'s, a `<link>`'s — no media element's, no
    // plugin's, no `<use>`'s, no image input's, no SVG `<image>`'s)
    let referring = match kind & 0xff {
        J_IMAGE => node.is_some_and(|n| n.is_html_named("img")),
        k => matches!(k, J_CLASSIC_SCRIPT | J_MODULE_SCRIPT | J_SHEET | J_LINK | J_PREFETCH),
    };
    let attr = match sheet.and_then(|s| realm.sheet_referrer_policy(s)) {
        Some(policy) => policy,
        None => node.filter(|_| referring).map_or("", crate::url_ops::referrer_policy_attribute),
    };
    let worker = node
        .and_then(|n| crate::script::modulepreload_destination(n.plain_attr("as").unwrap_or("")))
        .is_some_and(|d| matches!(d, "worker" | "sharedworker" | "serviceworker"));
    let noted = el.and_then(|id| realm.request_policies.get(&id).copied());
    let document = doc.map_or("", |d| realm.document_referrer_policy(d));
    let opaque = realm.location.origin() == "null";
    let destination = destination_of(kind, node.and_then(|n| n.plain_attr("as")).unwrap_or(""));
    let prefetch = match kind & 0xff {
        J_PREFETCH => true,
        J_LINK => (kind >> 8) & crate::link_resource::OBTAINS_PREFETCH != 0,
        _ => false,
    };
    plan(kind, crossorigin, worker, attr, noted, document, opaque) | destination_bits(destination) | if prefetch { PREFETCH } else { 0 }
}
// …and the destination of it, by its consumer's `kind` — a link's by what it obtains (its `kind`'s high bits) of the
// destinations its `as` names, a timed resource's by its code (subresources.rs `timed_code`) — and its index in a plan.
pub(crate) fn destination_of(kind: u32, as_value: &str) -> &'static str {
    let (low, high) = (kind & 0xff, kind >> 8);
    match low {
        J_IMAGE | J_CSS_IMAGE => "image",
        J_VIDEO => "video",
        J_AUDIO => "audio",
        J_CLASSIC_SCRIPT | J_MODULE_SCRIPT => "script",
        J_SHEET | J_CSS_MODULE => "style",
        J_FONT => "font",
        J_OBJECT => "object",
        J_EMBED => "embed",
        J_TIMED => crate::subresources::timed_destination(high),
        J_LINK => {
            let module = crate::script::modulepreload_destination(as_value);
            crate::link_resource::link_destination(high, module, crate::script::preload_destination(as_value))
        }
        _ => "",
    }
}
pub(crate) fn destination_bits(destination: &str) -> u32 {
    (DESTINATIONS.iter().position(|d| *d == destination).unwrap_or(0) as u32) << DESTINATION_SHIFT
}
// …and the destination a plan names.
pub(crate) fn destination(plan: u32) -> &'static str {
    DESTINATIONS.get((plan >> DESTINATION_SHIFT & 31) as usize).copied().unwrap_or("")
}
// …and the `Accept` a request of a plan carries where its header list has none (Fetch "fetch" step 12): a prefetch's a
// document's, its initiator saying so before its destination does, else its destination's.
pub(crate) fn accept(plan: u32) -> &'static str {
    crate::fetch_rules::default_accept(if plan & PREFETCH != 0 { "document" } else { destination(plan) })
}
// …and whether a plan is of a `no-cors` request (its mode's bits: `MODES`), of a `navigate` one.
pub(crate) fn no_cors(plan: u32) -> bool {
    plan & 3 == 0
}
pub(crate) fn navigation(plan: u32) -> bool {
    plan & 3 == 3
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plan_names_its_consumers_destination() {
        use crate::link_resource::{OBTAINS_MODULEPRELOAD, OBTAINS_PRELOAD, OBTAINS_STYLESHEET};
        let of = |kind, as_value| destination(destination_bits(destination_of(kind, as_value)));
        assert_eq!([of(J_IMAGE, ""), of(J_CSS_IMAGE, ""), of(J_FONT, ""), of(J_CSS_MODULE, ""), of(J_PREFETCH, "")], ["image", "image", "font", "style", ""]);
        assert_eq!([of(J_LINK | OBTAINS_STYLESHEET << 8, "font"), of(J_LINK | OBTAINS_PRELOAD << 8, "FONT"), of(J_LINK | OBTAINS_PRELOAD << 8, "fetch")], ["style", "font", ""]);
        assert_eq!([of(J_LINK | OBTAINS_MODULEPRELOAD << 8, ""), of(J_LINK | OBTAINS_MODULEPRELOAD << 8, "worker")], ["script", "worker"]);
        assert_eq!([of(J_TIMED, ""), of(J_TIMED | crate::subresources::TRACK << 8, "")], ["image", "track"]);
        // (…beside the request's fields, which it moves none of)
        let plan = plan(J_IMAGE, Some(""), false, "", None, "origin", true) | destination_bits("image");
        assert_eq!((fields(plan), destination(plan)), (("cors", "same-origin", "origin", true), "image"));
        // (…and its `Accept` its destination's — a prefetch's a document's, whatever its destination)
        assert_eq!([accept(plan), accept(destination_bits("style")), accept(0), accept(PREFETCH)], [
            "image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5",
            "text/css,*/*;q=0.1",
            "*/*",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        ]);
    }

    #[test]
    fn a_plan_is_what_its_fields_say() {
        assert_eq!(fields(plan(J_IMAGE, None, false, "", None, "", false)), ("no-cors", "include", "", false));
        assert_eq!(fields(plan(J_IMAGE, Some(""), false, "", None, "origin", false)), ("cors", "same-origin", "origin", false));
        assert_eq!(fields(plan(J_VIDEO, Some("use-credentials"), false, "no-referrer", None, "origin", true)), ("cors", "include", "no-referrer", true));
        // (…a CSS image's no-cors whatever, its policy its document's)
        assert_eq!(fields(plan(J_CSS_IMAGE, Some(""), false, "", None, "unsafe-url", false)), ("no-cors", "include", "unsafe-url", false));
        // (…a request element's policy the one noted as it was inserted — its default for none — over its document's now)
        assert_eq!(fields(plan(J_CLASSIC_SCRIPT, None, false, "", Some(""), "origin", false)).2, "strict-origin-when-cross-origin");
        assert_eq!(fields(plan(J_SHEET, None, false, "", Some("same-origin"), "origin", false)).2, "same-origin");
        assert_eq!(fields(plan(J_SHEET, None, false, "unsafe-url", Some("same-origin"), "origin", false)).2, "unsafe-url");
        // (…and none of its document's now but a load's: a module script's fetch reads its container's as it is made)
        assert_eq!(fields(plan(J_MODULE_SCRIPT, None, false, "", None, "origin", false)).2, "");
        assert_eq!(fields(0), ("no-cors", "same-origin", "", false));
        // (…a module preload's a CORS request, a plugin's a navigation)
        let modulepreload = J_LINK | crate::link_resource::OBTAINS_MODULEPRELOAD << 8;
        assert_eq!(fields(plan(modulepreload, None, false, "", None, "", false)).0, "cors");
        assert_eq!(fields(plan(J_LINK, None, false, "", None, "", false)).0, "no-cors");
        assert_eq!(fields(plan(J_OBJECT, None, false, "", None, "", false)).0, "navigate");
        // (…a prefetch's a link request, by its `crossorigin`: HTML "create a link request")
        assert_eq!(fields(plan(J_PREFETCH, Some(""), false, "", None, "", false)).0, "cors");
        assert_eq!(fields(plan(J_PREFETCH, None, false, "", None, "", false)).0, "no-cors");
        // (…a worker's module preload a same-origin one, its credentials its `crossorigin`'s; a font's a CORS one)
        assert_eq!(fields(plan(modulepreload, Some("use-credentials"), true, "", None, "", false)), ("same-origin", "include", "", false));
        assert_eq!(fields(plan(J_FONT, None, false, "", None, "", false)), ("cors", "same-origin", "", false));
    }
}
