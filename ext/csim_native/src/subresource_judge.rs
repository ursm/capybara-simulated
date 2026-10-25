// What a subresource's response comes to for the consumer that fetched it — the engine's one verdict, whichever family
// of loader asks (the bindings hand it the response as the host, a service worker or a scheme's processor answered it):
// whether there is a response at all, whether it is one to use, and whether it is CORS-cross-origin (Fetch), which mutes
// a script's errors, leaves a style sheet not origin-clean and taints a canvas an image or a video frame of it is drawn
// into.

// The consumer (`kind`): what it makes of a status and of the response's content is its family's.
pub(crate) const J_WORKER_IMPORT: u32 = 2;
pub(crate) const J_SHEET: u32 = 3;
pub(crate) const J_CSS_MODULE: u32 = 4;
pub(crate) const J_IMAGE: u32 = 7;
pub(crate) const J_VIDEO: u32 = 8;
pub(crate) const J_AUDIO: u32 = 9;
pub(crate) const J_FONT: u32 = 10;
pub(crate) const J_OBJECT: u32 = 11;
// What answered (`source`, low bits): the network's response (or the host's facts of it); the asset cache's body, whose
// status the host judged and whose facts it may not have kept (a body cached before they were); a service worker's
// answer the host judged already (`blocked` its refusal — `sw_subresource_usable`); a service worker's answer to a fetch
// event; a `data:` or `blob:` URL's processor. And what the bindings saw of its body (high bits): none at all, or an
// empty one.
pub(crate) const SRC_NETWORK: u32 = 0;
pub(crate) const SRC_ASSET: u32 = 1;
pub(crate) const SRC_SW_SYNC: u32 = 2;
pub(crate) const SRC_SW_EVENT: u32 = 3;
pub(crate) const SRC_SCHEME: u32 = 4;
const SRC_MASK: u32 = 7;
pub(crate) const S_NO_BODY: u32 = 8;
pub(crate) const S_EMPTY: u32 = 16;
// The verdict: a response to use, a response at all (one to use or not: a style sheet of another type is an empty one),
// and one that is CORS-cross-origin.
pub(crate) const V_OK: u32 = 1;
pub(crate) const V_FETCHED: u32 = 2;
pub(crate) const V_CROSS_ORIGIN: u32 = 4;

// The facts of a response the verdict is made of — none of a network error, nor of an asset whose facts are not kept
// (`known`).
#[derive(Default)]
pub(crate) struct Facts {
    pub(crate) known: bool,
    pub(crate) network_error: bool,
    // (…its type: `basic`, `cors`, `opaque`, `opaqueredirect`, `error`, or `default` for one that names none)
    pub(crate) response_type: String,
    pub(crate) redirected: bool,
    pub(crate) status: Option<u32>,
    pub(crate) body_error: bool,
    // (…a no-cors request's whose chain left its client's origin: browser.rb `rack_fetch`)
    pub(crate) tainted: bool,
    pub(crate) content_type: String,
    pub(crate) nosniff: String,
}

// The verdict on `facts` for a `kind` consumer whose request was in `mode` (its element's `crossorigin`: fetch_rules.rs
// `cors_request`), in a document in quirks mode or not:
// - a network error is no response — a service worker's answer or an asset the host refused for its status one all the
//   same — and so, for a service worker's answer to a fetch event, is one Fetch "HTTP fetch" step 5.5 does not let
//   answer the request (`service_worker_response_allowed`, redirect mode follow);
// - its status by what the consumer makes of one: an image decodes what it is given and a font's file is what it is,
//   a media resource's fetch errs on an HTTP 4xx or 5xx (HTML's media data processing list), a classic
//   worker-imported script and an `<object>`'s resource want an ok status ("fetch a classic worker-imported script",
//   the object element's processing model) — none the bindings judge of an answer the host judged already, nor of an
//   opaque answer to a fetch event, whose status a no-cors consumer cannot read, nor of a scheme's;
// - a body cut short is none to use, nor one with no body or (for a decoded one) an empty one;
// - a worker-imported script's from the network must be of a JavaScript MIME type; a style sheet's must be one
//   (sheet_owners.rs `sheet_response_accepted`, a quirks document's CORS-same-origin one of any type) — a service
//   worker's answer whatever its type, and one whose facts were not kept; a CSS module script's must be `text/css`;
// and it is CORS-cross-origin where it is opaque, or tainted.
pub(crate) fn judge(kind: u32, source: u32, facts: &Facts, mode: &str, quirks: bool) -> u32 {
    let from = source & SRC_MASK;
    let cross = facts.tainted || matches!(facts.response_type.as_str(), "opaque" | "opaqueredirect");
    let cross_bit = if cross { V_CROSS_ORIGIN } else { 0 };
    // (…a response the host refused for its status — a service worker's answer, an asset — one all the same)
    let refused = if matches!(from, SRC_SW_SYNC | SRC_ASSET) && facts.status.is_some_and(|s| s > 0) { V_FETCHED | cross_bit } else { 0 };
    if from == SRC_ASSET {
        if source & S_NO_BODY != 0 {
            return refused;
        }
    } else if facts.network_error || facts.response_type == "error" {
        return refused;
    }
    if from == SRC_SW_EVENT && !crate::fetch_rules::service_worker_response_allowed(mode, "follow", &facts.response_type, facts.redirected) {
        return 0;
    }
    let status_judged = matches!(from, SRC_ASSET | SRC_SW_SYNC | SRC_SCHEME) || (from == SRC_SW_EVENT && facts.response_type == "opaque");
    if !status_judged {
        let status = facts.status.unwrap_or(if from == SRC_SW_EVENT { 200 } else { 0 });
        let ok = match kind {
            J_IMAGE | J_FONT => true,
            J_AUDIO | J_VIDEO => status < 400,
            _ => (200..=299).contains(&status),
        };
        if !ok {
            return 0;
        }
    }
    if facts.body_error || source & S_NO_BODY != 0 {
        return refused;
    }
    if source & S_EMPTY != 0 && matches!(kind, J_IMAGE | J_VIDEO | J_AUDIO | J_FONT) {
        return 0;
    }
    let essence = || crate::mime::extract(&facts.content_type).map(|m| m.essence);
    let content = match kind {
        J_WORKER_IMPORT => from == SRC_SCHEME || essence().as_deref().is_some_and(crate::script::is_javascript_mime),
        J_SHEET => !facts.known || matches!(from, SRC_SW_SYNC | SRC_SW_EVENT) || crate::sheet_owners::sheet_response_accepted(&facts.content_type, &facts.nosniff, quirks, || !cross),
        J_CSS_MODULE => essence().as_deref() == Some("text/css"),
        _ => true,
    };
    if !content {
        return if kind == J_WORKER_IMPORT { 0 } else { V_FETCHED | cross_bit };
    }
    V_OK | V_FETCHED | cross_bit
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "subresourceJudge", judge_op, context_id);
}
// The member `key` of `obj`, None where it is null or undefined.
fn member<'s>(scope: &mut v8::PinScope<'s, '_>, obj: v8::Local<'_, v8::Object>, key: &str) -> Option<v8::Local<'s, v8::Value>> {
    let k = v8::String::new(scope, key)?;
    obj.get(scope, k.into()).filter(|v| !v.is_null_or_undefined())
}
// __dom.subresourceJudge(kind, nid, resp, source, doc) -> `judge` of `resp` — the response as the host, a service worker
// or a scheme's processor gives it (its `status`, `type`, `redirected`, `tainted`, `body_error`, its `headers`'
// Content-Type — else its `contentType` — and `X-Content-Type-Options`; `blocked` or `__networkError` a network error, as
// no response at all is, but for an asset's, whose facts the host may not have kept), its request made for the element
// `nid` (none for a worker's own), in the document `doc` — as its verdict bits.
fn judge_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let kind = args.get(0).uint32_value(scope).unwrap_or(0);
    let source = args.get(3).uint32_value(scope).unwrap_or(0);
    let attr = crate::dom::nid_arg(scope, &args, 1)
        .and_then(|id| crate::dom::dom(scope).arena.get(id))
        .and_then(|n| n.plain_attr("crossorigin").map(str::to_owned));
    let (mode, _) = crate::fetch_rules::cors_request(attr.as_deref(), false);
    let quirks = kind == J_SHEET && {
        let doc = crate::dom::nid_arg(scope, &args, 4);
        let cid = crate::dom::realm_id(scope, &args);
        crate::dom::realm(scope, cid).document_mode(doc).0
    };
    let facts = match v8::Local::<v8::Object>::try_from(args.get(2)) {
        Err(_) => Facts { network_error: source & SRC_MASK != SRC_ASSET, ..Facts::default() },
        Ok(resp) => {
            let flag = |scope: &mut v8::PinScope<'_, '_>, key: &str| member(scope, resp, key).is_some_and(|v| v.boolean_value(scope));
            let network_error = flag(scope, "blocked") || flag(scope, "__networkError");
            let response_type = member(scope, resp, "type").map_or_else(|| "default".to_owned(), |v| v.to_rust_string_lossy(scope));
            let status = member(scope, resp, "status").and_then(|v| v.number_value(scope)).map(|n| n as u32);
            let typed = matches!(kind, J_WORKER_IMPORT | J_SHEET | J_CSS_MODULE);
            let headers = if typed { member(scope, resp, "headers").and_then(|h| v8::Local::<v8::Object>::try_from(h).ok()) } else { None };
            let header = |scope: &mut v8::PinScope<'_, '_>, name: &str| headers.and_then(|h| crate::fetch_rules::response_header(scope, h, name));
            let content_type = if typed {
                header(scope, "content-type").or_else(|| member(scope, resp, "contentType").map(|v| v.to_rust_string_lossy(scope))).unwrap_or_default()
            } else {
                String::new()
            };
            let nosniff = if kind == J_SHEET { header(scope, "x-content-type-options").unwrap_or_default() } else { String::new() };
            Facts {
                known: true,
                network_error,
                response_type,
                redirected: flag(scope, "redirected"),
                status,
                body_error: flag(scope, "body_error"),
                tainted: flag(scope, "tainted"),
                content_type,
                nosniff,
            }
        }
    };
    rv.set_uint32(judge(kind, source, &facts, mode, quirks));
}

#[cfg(test)]
mod tests {
    use super::*;

    // (…a response to use is one at all)
    const OK: u32 = V_OK | V_FETCHED;

    fn resp(response_type: &str, status: Option<u32>) -> Facts {
        Facts { known: true, response_type: response_type.to_owned(), status, content_type: "text/javascript".to_owned(), ..Facts::default() }
    }

    #[test]
    fn a_network_error_is_none_to_use() {
        for kind in [J_WORKER_IMPORT, J_IMAGE, J_VIDEO, J_AUDIO, J_FONT, J_OBJECT] {
            assert_eq!(judge(kind, SRC_NETWORK, &Facts { network_error: true, ..resp("basic", Some(200)) }, "no-cors", false), 0);
            assert_eq!(judge(kind, SRC_SW_EVENT, &resp("error", None), "no-cors", false), 0);
        }
    }

    #[test]
    fn a_status_is_judged_by_its_consumer() {
        let at = |kind, status| judge(kind, SRC_NETWORK, &resp("basic", Some(status)), "no-cors", false) & V_OK;
        assert_eq!([at(J_IMAGE, 404), at(J_FONT, 500)], [V_OK, V_OK]);
        assert_eq!([at(J_VIDEO, 399), at(J_VIDEO, 404), at(J_AUDIO, 500)], [V_OK, 0, 0]);
        assert_eq!([at(J_WORKER_IMPORT, 200), at(J_WORKER_IMPORT, 304), at(J_OBJECT, 404)], [V_OK, 0, 0]);
        // (…none where the host judged it, nor of an opaque answer to a fetch event)
        assert_eq!(judge(J_OBJECT, SRC_SW_SYNC, &resp("basic", Some(404)), "no-cors", false), OK);
        assert_eq!(judge(J_AUDIO, SRC_SW_EVENT, &resp("opaque", Some(0)), "no-cors", false), OK | V_CROSS_ORIGIN);
        // (…a fetch event's answer that names no status an ok one)
        assert_eq!(judge(J_AUDIO, SRC_SW_EVENT, &resp("default", None), "no-cors", false), OK);
    }

    #[test]
    fn a_fetch_event_answer_is_one_fetch_lets_answer() {
        assert_eq!(judge(J_IMAGE, SRC_SW_EVENT, &resp("opaque", Some(0)), "cors", false), 0);
        assert_eq!(judge(J_IMAGE, SRC_SW_EVENT, &resp("opaqueredirect", Some(0)), "no-cors", false), 0);
        assert_eq!(judge(J_IMAGE, SRC_SW_EVENT, &resp("cors", Some(200)), "cors", false), OK);
    }

    #[test]
    fn a_body_cut_short_or_missing_is_none_to_use() {
        assert_eq!(judge(J_WORKER_IMPORT, SRC_NETWORK, &Facts { body_error: true, ..resp("basic", Some(200)) }, "no-cors", false), 0);
        assert_eq!(judge(J_OBJECT, SRC_NETWORK | S_NO_BODY, &resp("basic", Some(200)), "no-cors", false), 0);
        assert_eq!(judge(J_VIDEO, SRC_SW_SYNC | S_EMPTY, &resp("basic", Some(200)), "no-cors", false), 0);
        assert_eq!(judge(J_OBJECT, SRC_NETWORK | S_EMPTY, &resp("basic", Some(200)), "no-cors", false), OK);
    }

    #[test]
    fn a_network_import_is_of_a_javascript_type() {
        let typed = |ct: &str, source| judge(J_WORKER_IMPORT, source, &Facts { content_type: ct.to_owned(), ..resp("basic", Some(200)) }, "no-cors", false);
        assert_eq!([typed("text/javascript; charset=utf-8", SRC_NETWORK), typed("text/plain", SRC_NETWORK), typed("", SRC_SCHEME)], [OK, 0, OK]);
    }

    #[test]
    fn an_opaque_or_tainted_response_is_cross_origin() {
        assert_eq!(judge(J_IMAGE, SRC_SW_EVENT, &resp("opaque", Some(0)), "no-cors", false), OK | V_CROSS_ORIGIN);
        assert_eq!(judge(J_WORKER_IMPORT, SRC_NETWORK, &Facts { tainted: true, ..resp("basic", Some(200)) }, "no-cors", false), OK | V_CROSS_ORIGIN);
        assert_eq!(judge(J_WORKER_IMPORT, SRC_NETWORK, &resp("cors", Some(200)), "cors", false), OK);
    }

    #[test]
    fn a_style_sheet_is_one_by_its_type() {
        let sheet = |ct: &str, response_type, source, quirks| {
            let facts = Facts { content_type: ct.to_owned(), ..resp(response_type, Some(200)) };
            judge(J_SHEET, source, &facts, "no-cors", quirks)
        };
        assert_eq!(sheet("text/css", "basic", SRC_ASSET, false), OK);
        // (…one of another type a response all the same — an empty sheet — but a quirks document's CORS-same-origin one)
        assert_eq!(sheet("text/html", "basic", SRC_ASSET, false), V_FETCHED);
        assert_eq!(sheet("text/html", "basic", SRC_ASSET, true), OK);
        assert_eq!(sheet("text/html", "opaque", SRC_ASSET, true), V_FETCHED | V_CROSS_ORIGIN);
        // (…a service worker's answer whatever its type; one the host refused for its status still a response; an asset
        // with no body none, one with no facts kept one to use)
        assert_eq!(sheet("text/html", "basic", SRC_SW_SYNC, false), OK);
        assert_eq!(judge(J_SHEET, SRC_SW_SYNC, &Facts { network_error: true, ..resp("basic", Some(404)) }, "no-cors", false), V_FETCHED);
        assert_eq!(judge(J_SHEET, SRC_SW_SYNC, &Facts { network_error: true, ..resp("basic", None) }, "no-cors", false), 0);
        assert_eq!(judge(J_SHEET, SRC_ASSET | S_NO_BODY, &Facts::default(), "no-cors", false), 0);
        assert_eq!(judge(J_SHEET, SRC_ASSET | S_NO_BODY, &resp("basic", Some(404)), "no-cors", false), V_FETCHED);
        assert_eq!(judge(J_SHEET, SRC_ASSET, &Facts::default(), "no-cors", false), OK);
    }

    #[test]
    fn a_css_module_is_text_css() {
        let module = |ct: &str| judge(J_CSS_MODULE, SRC_SCHEME, &Facts { content_type: ct.to_owned(), ..resp("basic", None) }, "cors", false) & V_OK;
        assert_eq!([module("text/css; charset=x"), module(""), module("text/plain")], [V_OK, 0, 0]);
    }
}
