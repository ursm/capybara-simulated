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

// The plan of a `kind` consumer's request:
// - its mode and credentials mode: an image's, a video's, an audio's, a classic script's, a style sheet's and a link's a
//   potential-CORS request by the element's `crossorigin` (HTML "create a potential-CORS request": fetch_rules.rs
//   `cors_request`), a module script's, a module preload's and a CSS module script's a module script's (a CORS one
//   whatever — a same-origin one for a module preload of a worker: "fetch a single module script" of a top-level
//   one); a font's a CORS one of credentials same-origin (CSS Fonts 4 §4.9.1); a CSS image's no-cors with its credentials included (CSS Values 4 "fetch a style resource"), a
//   prefetch's so too (as it has been: HTML's "create a link request" would honour its `crossorigin`); a plugin's a
//   navigation's; a timed resource's as `timed_resources` found it;
// - the referrer policy it is made under: the element's `referrerpolicy` (`attr`), else the one its document had as
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
        J_IMAGE | J_VIDEO | J_AUDIO | J_CLASSIC_SCRIPT | J_SHEET => crate::fetch_rules::cors_request(crossorigin, false),
        J_LINK if modulepreload && worker => ("same-origin", crate::fetch_rules::cors_request(crossorigin, true).1),
        J_LINK => crate::fetch_rules::cors_request(crossorigin, modulepreload),
        J_FONT => ("cors", "same-origin"),
        J_CSS_MODULE => crate::fetch_rules::cors_request(None, true),
        J_MODULE_SCRIPT => crate::fetch_rules::cors_request(crossorigin, true),
        J_OBJECT | J_EMBED => ("navigate", "include"),
        J_TIMED => crate::subresources::timed_cors_request(high),
        J_PREFETCH | J_CSS_IMAGE => ("no-cors", "include"),
        _ => ("no-cors", "include"),
    };
    let noted = noted.map(|p| if p.is_empty() { crate::url_ops::DEFAULT_POLICY } else { p });
    let load = matches!(kind, J_IMAGE | J_VIDEO | J_CSS_IMAGE);
    let policy = if !attr.is_empty() { attr } else { noted.unwrap_or(if load { document } else { "" }) };
    let index = |table: &[&str], v: &str| table.iter().position(|t| *t == v).unwrap_or(0) as u32;
    let policy = crate::url_ops::POLICIES.iter().position(|p| *p == policy).map_or(0, |i| i as u32 + 1);
    index(&MODES, mode) | index(&CREDENTIALS, credentials) << 2 | policy << 4 | if opaque { OPAQUE } else { 0 }
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
// Capybara::Simulated::Native.subresource_plan_fields(plan) -> `fields`, for the host's request.
pub(crate) fn fields_for_ruby(plan: u32) -> (String, String, String, bool) {
    let (mode, credentials, policy, opaque) = fields(plan);
    (mode.to_owned(), credentials.to_owned(), policy.to_owned(), opaque)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "subresourcePlan", plan_op, context_id);
    crate::dom::register(scope, ns, "subresourcePlanFields", fields_op, context_id);
}
// __dom.subresourcePlanFields(plan) -> [mode, credentials, referrer policy] of `plan` (`fields`).
fn fields_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (mode, credentials, policy, _) = fields(args.get(0).uint32_value(scope).unwrap_or(0));
    let items: Vec<v8::Local<v8::Value>> = [mode, credentials, policy].iter().filter_map(|t| v8::String::new(scope, t)).map(Into::into).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.subresourcePlan(kind, nid, doc) -> `plan` of the request a `kind` consumer makes for the element `nid` (none for
// one no element makes) in the document `doc`, from the calling realm, whose origin is its client's.
// (…the opaque bit the calling realm's: a load the host makes for an image or a video says it, as the host cannot ask a
// frame still parsing — the host asks a request element's realm its own)
fn plan_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let kind = args.get(0).uint32_value(scope).unwrap_or(0);
    let (el, doc) = (crate::dom::nid_arg(scope, &args, 1), crate::dom::nid_arg(scope, &args, 2));
    let cid = crate::dom::realm_id(scope, &args);
    let realm = crate::dom::realm(scope, cid);
    let node = el.and_then(|id| realm.get(id));
    let crossorigin = node.and_then(|n| n.plain_attr("crossorigin"));
    let attr = node.map_or("", crate::url_ops::referrer_policy_attribute);
    let worker = node
        .and_then(|n| crate::script::modulepreload_destination(n.plain_attr("as").unwrap_or("")))
        .is_some_and(|d| matches!(d, "worker" | "sharedworker" | "serviceworker"));
    let noted = el.and_then(|id| realm.request_policies.get(&id).copied());
    let document = doc.map_or("", |d| realm.document_referrer_policy(d));
    let opaque = realm.location.origin() == "null";
    rv.set_uint32(plan(kind, crossorigin, worker, attr, noted, document, opaque));
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // (…a module preload's a CORS request, a plugin's a navigation, a prefetch's no-cors)
        let modulepreload = J_LINK | crate::link_resource::OBTAINS_MODULEPRELOAD << 8;
        assert_eq!(fields(plan(modulepreload, None, false, "", None, "", false)).0, "cors");
        assert_eq!(fields(plan(J_LINK, None, false, "", None, "", false)).0, "no-cors");
        assert_eq!(fields(plan(J_OBJECT, None, false, "", None, "", false)).0, "navigate");
        assert_eq!(fields(plan(J_PREFETCH, Some(""), false, "", None, "", false)).0, "no-cors");
        // (…a worker's module preload a same-origin one, its credentials its `crossorigin`'s; a font's a CORS one)
        assert_eq!(fields(plan(modulepreload, Some("use-credentials"), true, "", None, "", false)), ("same-origin", "include", "", false));
        assert_eq!(fields(plan(J_FONT, None, false, "", None, "", false)), ("cors", "same-origin", "", false));
    }
}
