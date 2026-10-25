// How a subresource is requested — the engine's plan of the request a consumer makes (Fetch "request"): its mode and
// credentials mode, the referrer policy it is made under, and whether its client's origin is opaque — packed in one
// small integer the bindings hand the host, which decodes it (`fields`) rather than be told each by hand.

use crate::subresource_judge::{J_IMAGE, J_VIDEO};

// The consumer: those of the judge (subresource_judge.rs `J_*`), and a CSS image (a `background-image` `url()` …).
pub(crate) const J_CSS_IMAGE: u32 = 12;

// The plan's fields: bits 0-1 the mode, 2-3 the credentials mode, 4-7 the referrer policy (0 none, else one past its
// index in url_ops.rs `POLICIES`), 8 an opaque client.
const MODES: [&str; 4] = ["no-cors", "cors", "same-origin", "navigate"];
const CREDENTIALS: [&str; 3] = ["omit", "same-origin", "include"];
const OPAQUE: u32 = 1 << 8;

// The plan of a `kind` consumer's request: an image's and a video's a potential-CORS request by the element's
// `crossorigin` (HTML "create a potential-CORS request": fetch_rules.rs `cors_request`), a CSS image's no-cors with its
// credentials included (CSS Values 4 "fetch a style resource"); under the element's `referrerpolicy` (`attr`), else
// its document's (`document`, its `<meta name="referrer">`'s); its client's origin opaque or not.
pub(crate) fn plan(kind: u32, crossorigin: Option<&str>, attr: &str, document: &str, opaque: bool) -> u32 {
    let (mode, credentials) = match kind {
        J_IMAGE | J_VIDEO => crate::fetch_rules::cors_request(crossorigin, false),
        _ => ("no-cors", "include"),
    };
    let policy = if attr.is_empty() { document } else { attr };
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
}
// __dom.subresourcePlan(kind, nid, doc) -> `plan` of the request a `kind` consumer makes for the element `nid` (none for
// one no element makes) in the document `doc`, from the calling realm, whose origin is its client's.
fn plan_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let kind = args.get(0).uint32_value(scope).unwrap_or(0);
    let (el, doc) = (crate::dom::nid_arg(scope, &args, 1), crate::dom::nid_arg(scope, &args, 2));
    let cid = crate::dom::realm_id(scope, &args);
    let realm = crate::dom::realm(scope, cid);
    let node = el.and_then(|id| realm.get(id));
    let crossorigin = node.and_then(|n| n.plain_attr("crossorigin"));
    let attr = node.map_or("", crate::url_ops::referrer_policy_attribute);
    let document = doc.map_or("", |d| realm.document_referrer_policy(d));
    let opaque = realm.location.origin() == "null";
    rv.set_uint32(plan(kind, crossorigin, attr, document, opaque));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plan_is_what_its_fields_say() {
        assert_eq!(fields(plan(J_IMAGE, None, "", "", false)), ("no-cors", "include", "", false));
        assert_eq!(fields(plan(J_IMAGE, Some(""), "", "origin", false)), ("cors", "same-origin", "origin", false));
        assert_eq!(fields(plan(J_VIDEO, Some("use-credentials"), "no-referrer", "origin", true)), ("cors", "include", "no-referrer", true));
        // (…a CSS image's no-cors whatever, its policy its document's)
        assert_eq!(fields(plan(J_CSS_IMAGE, Some(""), "", "unsafe-url", false)), ("no-cors", "include", "unsafe-url", false));
    }
}
