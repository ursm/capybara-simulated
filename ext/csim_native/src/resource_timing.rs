// What a resource timing entry reads off its response (Resource Timing, Server Timing): the metrics its `Server-Timing`
// header lists, its `contentType` (the response's MIME type minimized), its `contentEncoding`, and whether its
// `Timing-Allow-Origin` lets the document see its timing. The bindings (performance.js) make the entries.

// A `Server-Timing` metric: its name, its `dur` (0 for none) and its `desc` ('' for none).
#[derive(Debug, PartialEq)]
pub(crate) struct Metric {
    pub(crate) name: String,
    pub(crate) duration: f64,
    pub(crate) description: String,
}

// Server Timing §3 "parse a server-timing header": its comma-separated metrics, each `name *( OWS ";" OWS param )`, a
// param `key [ OWS "=" OWS value ]` — a value a token or an HTTP quoted-string (a `\` taking the character after it, a
// comma inside it no metric's end; one never closed `""`) — the first `dur` and the first `desc` of a metric taken, any
// other param ignored, and what the grammar cannot take after a name or a param skipped to the next `;` or `,` ("user
// agents MUST ignore extraneous characters"). A metric with no name is none.
pub(crate) fn server_timing(value: &str) -> Vec<Metric> {
    type Chars<'a> = std::iter::Peekable<std::str::Chars<'a>>;
    fn ows(chars: &mut Chars) {
        while chars.next_if(|c| matches!(c, ' ' | '\t')).is_some() {}
    }
    fn token(chars: &mut Chars) -> String {
        let mut t = String::new();
        while let Some(c) = chars.next_if(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(*c)) {
            t.push(c);
        }
        t
    }
    // (…up to the next `;` or `,`, a quoted string skipped whole)
    fn extraneous(chars: &mut Chars) {
        let mut quoted = false;
        while let Some(c) = chars.next_if(|&c| quoted || (c != ';' && c != ',')) {
            match c {
                '"' => quoted = !quoted,
                '\\' if quoted => {
                    chars.next();
                }
                _ => {}
            }
        }
    }
    fn quoted_string(chars: &mut Chars) -> String {
        let mut s = String::new();
        loop {
            match chars.next() {
                None => return String::new(),
                Some('"') => return s,
                Some('\\') => match chars.next() {
                    Some(c) => s.push(c),
                    None => return String::new(),
                },
                Some(c) => s.push(c),
            }
        }
    }
    let mut metrics = Vec::new();
    let mut chars = value.chars().peekable();
    loop {
        ows(&mut chars);
        if chars.peek().is_none() {
            return metrics;
        }
        let name = token(&mut chars);
        extraneous(&mut chars);
        let (mut duration, mut description) = (None, None);
        while chars.next_if_eq(&';').is_some() {
            ows(&mut chars);
            let key = token(&mut chars).to_ascii_lowercase();
            ows(&mut chars);
            let mut param = String::new();
            if chars.next_if_eq(&'=').is_some() {
                ows(&mut chars);
                param = if chars.next_if_eq(&'"').is_some() { quoted_string(&mut chars) } else { token(&mut chars) };
            }
            extraneous(&mut chars);
            match key.as_str() {
                // (…a number past leading whitespace, as Chrome reads one; anything else, or none finite, 0)
                "dur" if duration.is_none() => {
                    let number = param.trim_start_matches([' ', '\t', '\n', '\r', '\x0c']).parse::<f64>().ok();
                    duration = Some(number.filter(|d| d.is_finite()).unwrap_or(0.0));
                }
                "desc" if description.is_none() => description = Some(param),
                _ => {}
            }
        }
        chars.next_if_eq(&',');
        if !name.is_empty() {
            metrics.push(Metric { name, duration: duration.unwrap_or(0.0), description: description.unwrap_or_default() });
        }
    }
}

// Resource Timing "minimize a supported MIME type" of the response's MIME type (Fetch "extract a MIME type" from its
// `Content-Type`, the last of a combined list that parses): a JavaScript type `text/javascript`, a JSON one
// `application/json`, SVG `image/svg+xml`, any other XML type `application/xml`, any other its essence — '' where none
// parses. (OPEN: mimesniff's "supported by the user agent" gate, '' for a type it does not support, is not modelled.)
pub(crate) fn minimize_mime(content_type: &str) -> String {
    let Some(mime) = crate::mime::extract(content_type) else { return String::new() };
    let essence = mime.essence.as_str();
    if crate::script::is_javascript_mime(essence) {
        "text/javascript".to_owned()
    } else if crate::mime::is_json(essence) {
        "application/json".to_owned()
    } else if essence == "image/svg+xml" {
        essence.to_owned()
    } else if crate::mime::is_xml(essence) {
        "application/xml".to_owned()
    } else {
        essence.to_owned()
    }
}

// Resource Timing's `contentEncoding`: one coding the user agent knows, as written (case-folded); a list "multiple"; a
// coding it does not know — `identity` is none on the wire — "@unknown"; no header, or an empty one, ''.
pub(crate) fn content_encoding(header: &str) -> String {
    let raw = header.trim_matches([' ', '\t', '\n', '\r']);
    if raw.is_empty() {
        return String::new();
    }
    if raw.contains(',') {
        return "multiple".to_owned();
    }
    let coding = raw.to_ascii_lowercase();
    if matches!(coding.as_str(), "br" | "dcb" | "dcz" | "deflate" | "gzip" | "zstd") { coding } else { "@unknown".to_owned() }
}

// Fetch's "TAO check" for a cross-origin response: its `Timing-Allow-Origin` values, comma-separated, one `*` or the
// requesting document's origin serialized.
fn timing_allowed(tao: &str, origin: &str) -> bool {
    crate::headers::decode_split(tao).iter().any(|v| v == "*" || (!v.is_empty() && v == origin))
}

// What a resource's entry lets the document see (Resource Timing §4.7, Fetch): whether its timing is allowed — a
// response that is not opaque, of the document's own origin (or a URL with none) or admitted by its
// `Timing-Allow-Origin`, and, where a redirect crossed origins, its final URL so too (the hops between are not kept) —
// and whether its response's status and type are exposed: not an opaque response, not a cross-origin document's (a
// frame's), not a no-cors element load's of a cross-origin URL.
pub(crate) struct Exposure {
    pub(crate) allowed: bool,
    pub(crate) exposed: bool,
}
pub(crate) fn exposure(name: &str, final_url: &str, document_origin: &str, tao: Option<&str>, opaque: bool, document: bool, no_cors: bool) -> Exposure {
    let origin_of = |url: &str| ada_url::Url::parse(url, None).ok().map(|u| u.origin());
    let here = (!document_origin.is_empty()).then_some(document_origin);
    let allowed_for = |url: &str| {
        !opaque
            && match origin_of(url) {
                None => true,
                Some(there) => Some(there.as_str()) == here || tao.is_some_and(|t| timing_allowed(t, here.unwrap_or_default())),
            }
    };
    let cross_origin_chain = final_url != name && origin_of(final_url) != origin_of(name);
    let cross_origin = origin_of(name).as_deref() != here;
    Exposure {
        allowed: allowed_for(name) && (!cross_origin_chain || allowed_for(final_url)),
        exposed: !opaque && !(cross_origin && (document || no_cors)),
    }
}

// What a fetch tells its entry (Resource Timing §4.6 "mark resource timing" — the response's facts as the host has them):
// its URL and the one it ended at, the document's origin, the response's `Timing-Allow-Origin`, whether it is opaque, a
// frame's document or a no-cors element load, when it started and ended, whether it came from the cache ("cache") or
// was revalidated ("validated"), its body's encoded and decoded sizes, whether it was redirected, its status, its
// `Content-Type`, `Content-Encoding` and `Server-Timing` headers, whether it blocked rendering; and whether it failed
// (a network error: nothing but its times).
pub(crate) struct Facts {
    pub(crate) name: String,
    pub(crate) final_url: String,
    pub(crate) document_origin: String,
    pub(crate) tao: Option<String>,
    pub(crate) opaque: bool,
    pub(crate) document: bool,
    pub(crate) no_cors: bool,
    pub(crate) start: f64,
    pub(crate) end: f64,
    pub(crate) cached: Option<String>,
    pub(crate) encoded: f64,
    pub(crate) decoded: f64,
    pub(crate) redirected: bool,
    pub(crate) status: f64,
    pub(crate) content_type: Option<String>,
    pub(crate) content_encoding: Option<String>,
    pub(crate) server_timing: Option<String>,
    pub(crate) render_blocking: bool,
    pub(crate) failed: bool,
}
// …and what the entry's attributes are made of them: a timing not allowed reads 0 (or ""), as its sizes and its
// `Server-Timing`; a status and a content type not exposed too. Its times are the fetch's start, but `responseEnd` (the
// network the driver models is instantaneous), a TLS handshake only for an https: URL, a redirect's only where one was;
// its `transferSize` the body's encoded size and 300 octets of headers — nothing from the cache, the headers alone for a
// revalidation.
pub(crate) enum Field {
    Number(f64),
    Text(String),
    Metrics(Vec<Metric>),
}
pub(crate) fn entry_fields(f: &Facts) -> Vec<(&'static str, Field)> {
    use Field::{Metrics, Number, Text};
    let Exposure { allowed, exposed } =
        if f.failed { Exposure { allowed: false, exposed: false } } else { exposure(&f.name, &f.final_url, &f.document_origin, f.tao.as_deref(), f.opaque, f.document, f.no_cors) };
    let at = |yes: bool| Number(if yes { f.start } else { 0.0 });
    let cached = f.cached.as_deref();
    let transfer = match (allowed, cached) {
        (false, _) | (true, Some("cache")) => 0.0,
        (true, Some("validated")) => 300.0,
        (true, _) => f.encoded + 300.0,
    };
    let shown = |yes: bool, s: String| Text(if yes { s } else { String::new() });
    vec![
        ("deliveryType", shown(allowed && cached == Some("cache"), "cache".to_owned())),
        ("nextHopProtocol", shown(allowed, "http/1.1".to_owned())),
        ("workerStart", Number(0.0)),
        ("redirectStart", at(allowed && f.redirected)),
        ("redirectEnd", at(allowed && f.redirected)),
        ("fetchStart", Number(f.start)),
        ("domainLookupStart", at(allowed)),
        ("domainLookupEnd", at(allowed)),
        ("connectStart", at(allowed)),
        ("connectEnd", at(allowed)),
        ("secureConnectionStart", at(allowed && f.name.get(..6).is_some_and(|s| s.eq_ignore_ascii_case("https:")))),
        ("requestStart", at(allowed)),
        ("finalResponseHeadersStart", at(allowed)),
        ("firstInterimResponseStart", Number(0.0)),
        ("responseStart", at(allowed)),
        ("responseEnd", Number(f.end)),
        ("workerRouterEvaluationStart", Number(0.0)),
        ("workerCacheLookupStart", Number(0.0)),
        ("workerMatchedRouterSource", Text(String::new())),
        ("workerFinalRouterSource", Text(String::new())),
        ("transferSize", Number(transfer)),
        ("encodedBodySize", Number(if allowed { f.encoded } else { 0.0 })),
        ("decodedBodySize", Number(if allowed { f.decoded } else { 0.0 })),
        ("responseStatus", Number(if exposed { f.status } else { 0.0 })),
        ("renderBlockingStatus", Text(if f.render_blocking { "blocking" } else { "non-blocking" }.to_owned())),
        ("contentType", shown(exposed, f.content_type.as_deref().map(minimize_mime).unwrap_or_default())),
        ("contentEncoding", shown(allowed, f.content_encoding.as_deref().map(content_encoding).unwrap_or_default())),
        ("serverTiming", Metrics(if allowed { f.server_timing.as_deref().map(server_timing).unwrap_or_default() } else { Vec::new() })),
    ]
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "resourceTimingEntry", entry_op, context_id);
}
// A string of `s` — a key internalized, as a property key is (every entry makes its fields).
fn key<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> Option<v8::Local<'s, v8::String>> {
    v8::String::new_from_one_byte(scope, s.as_bytes(), v8::NewStringType::Internalized)
}
fn text<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
}
// The member `name` of `obj` (none: no object) as it is, undefined where it has none.
fn raw<'s>(scope: &mut v8::PinScope<'s, '_>, obj: Option<v8::Local<'_, v8::Object>>, name: &str) -> v8::Local<'s, v8::Value> {
    obj.and_then(|o| key(scope, name).and_then(|k| o.get(scope, k.into()))).unwrap_or_else(|| v8::undefined(scope).into())
}
// …None where it is null or undefined.
fn member<'s>(scope: &mut v8::PinScope<'s, '_>, obj: Option<v8::Local<'_, v8::Object>>, name: &str) -> Option<v8::Local<'s, v8::Value>> {
    Some(raw(scope, obj, name)).filter(|v| !v.is_null_or_undefined())
}
// …as a string (None for none, or one falsy where `truthy`); as `x | 0`, 0 for none.
fn string_of(scope: &mut v8::PinScope<'_, '_>, obj: Option<v8::Local<'_, v8::Object>>, name: &str, truthy: bool) -> Option<String> {
    let v = member(scope, obj, name)?;
    (!truthy || v.boolean_value(scope)).then(|| v.to_rust_string_lossy(scope))
}
fn int_of(scope: &mut v8::PinScope<'_, '_>, obj: Option<v8::Local<'_, v8::Object>>, name: &str) -> Option<f64> {
    let v = member(scope, obj, name)?;
    Some(v.int32_value(scope).unwrap_or(0) as f64)
}
fn flag_of(scope: &mut v8::PinScope<'_, '_>, obj: Option<v8::Local<'_, v8::Object>>, name: &str) -> bool {
    let v = raw(scope, obj, name);
    v.boolean_value(scope)
}
// The kinds of a fetch only a Resource Timing entry is filed for, which no consumer of the judge's or the plan's makes: a
// frame's document; a dedicated worker's main script (`WORKER_MODULE` a module worker's); a `fetch()` (`FETCH_BEACON`
// `sendBeacon`'s); an XMLHttpRequest; an EventSource's connection. (constants.js mirrors them.)
pub(crate) const J_FRAME: u32 = 16;
pub(crate) const J_WORKER_SCRIPT: u32 = 17;
pub(crate) const J_FETCH: u32 = 18;
pub(crate) const J_XHR: u32 = 19;
pub(crate) const J_EVENT_SOURCE: u32 = 20;
const WORKER_MODULE: u32 = 1;
const FETCH_BEACON: u32 = 1;
// The initiator type of an entry of `kind` (the detail in its high bits), of its element `nid` (Resource Timing
// "initiator type", resource-timing/initiator-type/*) — None where the caller names it: a timed resource's, a CSS
// image's, which the engine handed it (subresources.rs `timed_resources`, rendered.rs `css_images_owed`).
fn initiator_of(realm: &crate::dom::RealmArena, kind: u32, nid: Option<crate::dom::NodeId>) -> Option<&'static str> {
    use crate::subresource_judge::{J_CLASSIC_SCRIPT, J_FONT, J_IMAGE, J_LINK, J_SHEET};
    let node = nid.and_then(|id| realm.get(id));
    let detail = kind >> 8;
    Some(match kind & 0xff {
        J_IMAGE if node.is_some_and(|n| n.is_html_named("input")) => "input",
        J_IMAGE if node.is_some_and(|n| &*n.local_name == "image") => "image",
        J_IMAGE => "img",
        J_CLASSIC_SCRIPT | crate::subresource_plan::J_MODULE_SCRIPT => "script",
        // (…a module preload's a script fetched, not run: 'other' — Resource Timing L2)
        J_LINK if detail & crate::link_resource::OBTAINS_MODULEPRELOAD != 0 => "other",
        J_LINK => "link",
        // (…an `@import`'s and a face's: the sheet's)
        J_SHEET | J_FONT => "css",
        J_FRAME if node.is_some_and(|n| n.is_html_named("frame")) => "frame",
        J_FRAME => "iframe",
        J_WORKER_SCRIPT if detail & WORKER_MODULE != 0 => "script",
        J_WORKER_SCRIPT | J_EVENT_SOURCE => "other",
        J_FETCH if detail & FETCH_BEACON != 0 => "beacon",
        J_FETCH => "fetch",
        J_XHR => "xmlhttprequest",
        _ => return None,
    })
}
// Whether an entry of `kind` is of a request the engine plans (subresource_plan.rs), whose no-cors-ness its plan says —
// no fetch only an entry is filed for, whose own is a CORS request's or a navigation's.
fn planned_kind(kind: u32) -> bool {
    use crate::subresource_judge::{J_CLASSIC_SCRIPT, J_FONT, J_IMAGE, J_LINK, J_SHEET};
    matches!(kind & 0xff, J_IMAGE | J_CLASSIC_SCRIPT | crate::subresource_plan::J_MODULE_SCRIPT | J_LINK | J_SHEET | J_FONT | crate::subresource_plan::J_CSS_IMAGE | crate::subresource_plan::J_TIMED)
}
// Whether the page files the entry of `name` of `kind` now: an image's (but a failed load's, `failed`, each time) and an
// `@import`'s once for the page, as its memory cache serves them after (`RealmArena::timed_resources`, Chrome:
// cached-image-gets-single-entry); a `<link>`'s once per load of its URL — its load task can run twice for one element,
// on connection and on the attribute change that completed it (`RealmArena::link_timings`, the URL it filed last); every
// other each time.
fn filed_once(realm: &mut crate::dom::RealmArena, kind: u32, nid: Option<crate::dom::NodeId>, name: &str, failed: bool) -> bool {
    use crate::subresource_judge::{J_IMAGE, J_LINK, J_SHEET};
    match kind & 0xff {
        J_IMAGE => failed || realm.timed_resources.insert(("img", name.to_owned())),
        J_SHEET if nid.is_none() => realm.timed_resources.insert(("css", name.to_owned())),
        J_LINK => match nid {
            Some(id) if realm.link_timings.get(&id).is_some_and(|last| **last == *name) => false,
            Some(id) => {
                realm.link_timings.insert(id, name.into());
                true
            }
            None => true,
        },
        _ => true,
    }
}
// __dom.resourceTimingEntry(desc, now) -> the fields of the entry a fetch files (`entry_fields`), its `name`, `startTime`
// and `initiatorType` among them, `serverTiming` a flat [name, duration, description, …] list — or null for a resource
// of no network scheme, or that the page files no more. `desc` what the fetch tells of it: `{ name, kind, nid, plan,
// initiatorType, startTime, endTime, resp, body, renderBlocking, noCors, cached, encoded, decoded, status, headers,
// type, redirected, broken }`, `resp` a response hash (status / headers / bytes / encoded / cached / redirected / type /
// url / tao / contentEncoding / serverTiming) the rest defaults from — none for a network error, an entry of its times
// alone, but where `status` is given — `body` a text body of the asset cache's that sizes one with no hash; `now` its
// end, where no `endTime` says, the clock the bindings keep. The document's origin is the calling realm's.
fn entry_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Ok(desc) = v8::Local::<v8::Object>::try_from(args.get(0)) else { return };
    let desc = Some(desc);
    let now = args.get(1).number_value(scope).unwrap_or(0.0);
    let resp = member(scope, desc, "resp").and_then(|v| v8::Local::<v8::Object>::try_from(v).ok());
    // (…its name the description's, else its response's URL)
    let name = string_of(scope, desc, "name", true).or_else(|| string_of(scope, resp, "url", true)).unwrap_or_default();
    // (…none for a resource whose URL is of no HTTP(S) scheme — Fetch's "finalize and report timing" returns for its
    // original URL's: data:, blob:, about: …)
    if !name.get(..5).is_some_and(|s| s.eq_ignore_ascii_case("http:")) && !name.get(..6).is_some_and(|s| s.eq_ignore_ascii_case("https:")) {
        return;
    }
    let status_given = member(scope, desc, "status").map(|v| v.number_value(scope).unwrap_or(0.0));
    let failed = resp.is_none() && status_given.is_none();
    let headers = member(scope, desc, "headers").or_else(|| member(scope, resp, "headers")).and_then(|h| v8::Local::<v8::Object>::try_from(h).ok());
    let [tao_header, content_type, encoding_header, timing_header] = match headers {
        Some(h) => crate::fetch_rules::response_headers(scope, h, ["timing-allow-origin", "content-type", "content-encoding", "server-timing"]),
        None => [None, None, None, None],
    };
    // (…its sizes a text body's, its response's, or as given; none of a network error)
    let (mut encoded, mut decoded) = (0.0, 0.0);
    if !failed {
        if let Some(body) = string_of(scope, desc, "body", false) {
            (encoded, decoded) = (body.len() as f64, body.len() as f64);
        } else {
            let sized = if resp.is_some() { [resp, resp] } else { [desc, desc] };
            let (bytes_key, encoded_key) = if resp.is_some() { ("bytes", "encoded") } else { ("decoded", "encoded") };
            decoded = int_of(scope, sized[0], bytes_key).unwrap_or(0.0);
            encoded = int_of(scope, sized[1], encoded_key).unwrap_or(decoded);
        }
    }
    let redirected_resp = flag_of(scope, resp, "redirected");
    let final_url = if redirected_resp { string_of(scope, resp, "url", true) } else { None };
    let mut initiator = string_of(scope, desc, "initiatorType", true).unwrap_or_else(|| "other".to_owned());
    let mut no_cors = flag_of(scope, desc, "noCors");
    // (…a navigation's request — a frame's document's, a plugin's resource's — whose status and type a cross-origin
    // response exposes none of: Resource Timing "mark resource timing", the response's origin not the request's)
    let mut navigation = false;
    let cid = crate::dom::realm_id(scope, &args);
    // (…of its consumer's `kind` — `J_*`, constants.js, `J_*` here for a fetch only an entry is filed for — its request's
    // `plan`, else its element's (`nid`) now: what says its initiator type, whether its request is a no-cors one and
    // whether the page files it at all — `filed_once`)
    if let Some(kind) = member(scope, desc, "kind").and_then(|v| v.uint32_value(scope)) {
        let nid = member(scope, desc, "nid").and_then(|v| v.integer_value(scope)).and_then(crate::dom::NodeId::from_i64);
        let planned = member(scope, desc, "plan").and_then(|v| v.uint32_value(scope));
        let broken = flag_of(scope, desc, "broken");
        let realm = crate::dom::realm(scope, cid);
        if let Some(by_kind) = initiator_of(realm, kind, nid) {
            initiator = by_kind.to_owned();
        }
        if planned.is_some() || planned_kind(kind) {
            let plan = planned.unwrap_or_else(|| crate::subresource_plan::plan_in(realm, kind, nid, None, None));
            no_cors = crate::subresource_plan::no_cors(plan);
            navigation = crate::subresource_plan::navigation(plan);
        }
        if !filed_once(realm, kind, nid, &name, failed || broken) {
            return;
        }
    }
    let response_type = string_of(scope, desc, "type", true).or_else(|| string_of(scope, resp, "type", true));
    let cached_given = raw(scope, desc, "cached");
    let cached = if cached_given.is_undefined() { string_of(scope, resp, "cached", true) } else { cached_given.boolean_value(scope).then(|| cached_given.to_rust_string_lossy(scope)) };
    let redirected_given = raw(scope, desc, "redirected");
    let redirected = if redirected_given.is_undefined() { redirected_resp } else { redirected_given.boolean_value(scope) };
    let status = match status_given {
        Some(n) => n,
        None => int_of(scope, resp, "status").unwrap_or(0.0),
    };
    let start = member(scope, desc, "startTime").and_then(|v| v.number_value(scope)).unwrap_or(now);
    let facts = Facts {
        final_url: final_url.unwrap_or_else(|| name.clone()),
        document_origin: crate::dom::realm(scope, cid).location.origin().to_owned(),
        tao: string_of(scope, resp, "tao", false).or(tao_header),
        opaque: response_type.as_deref() == Some("opaque"),
        document: navigation || matches!(initiator.as_str(), "iframe" | "frame"),
        no_cors,
        start,
        end: member(scope, desc, "endTime").and_then(|v| v.number_value(scope)).unwrap_or(now),
        cached,
        encoded,
        decoded,
        redirected,
        status,
        content_type,
        content_encoding: string_of(scope, resp, "contentEncoding", false).or(encoding_header),
        server_timing: string_of(scope, resp, "serverTiming", false).or(timing_header),
        render_blocking: flag_of(scope, desc, "renderBlocking"),
        failed,
        name,
    };
    let out = v8::Object::new(scope);
    let mut set = |scope: &mut v8::PinScope<'_, '_>, k: &str, value: v8::Local<'_, v8::Value>| {
        if let Some(k) = key(scope, k) {
            out.set(scope, k.into(), value);
        }
    };
    let (name, start) = (text(scope, &facts.name), v8::Number::new(scope, facts.start).into());
    set(scope, "name", name);
    set(scope, "startTime", start);
    let initiator = text(scope, &initiator);
    set(scope, "initiatorType", initiator);
    for (k, field) in entry_fields(&facts) {
        let value: v8::Local<v8::Value> = match field {
            Field::Number(n) => v8::Number::new(scope, n).into(),
            Field::Text(t) => text(scope, &t),
            Field::Metrics(metrics) => {
                let mut items: Vec<v8::Local<v8::Value>> = Vec::new();
                for m in metrics {
                    items.push(text(scope, &m.name));
                    items.push(v8::Number::new(scope, m.duration).into());
                    items.push(text(scope, &m.description));
                }
                v8::Array::new_with_elements(scope, &items).into()
            }
        };
        set(scope, k, value);
    }
    rv.set(out.into());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> Facts {
        Facts {
            name: "https://a.test/x.js".into(),
            final_url: "https://a.test/x.js".into(),
            document_origin: "https://a.test".into(),
            tao: None,
            opaque: false,
            document: false,
            no_cors: false,
            start: 10.0,
            end: 12.0,
            cached: None,
            encoded: 100.0,
            decoded: 400.0,
            redirected: false,
            status: 200.0,
            content_type: Some("text/javascript; charset=utf-8".into()),
            content_encoding: Some("gzip".into()),
            server_timing: Some("db;dur=5".into()),
            render_blocking: true,
            failed: false,
        }
    }
    fn number(fields: &[(&str, Field)], key: &str) -> f64 {
        match fields.iter().find(|(k, _)| *k == key) {
            Some((_, Field::Number(n))) => *n,
            _ => f64::NAN,
        }
    }
    fn string(fields: &[(&str, Field)], key: &str) -> String {
        match fields.iter().find(|(k, _)| *k == key) {
            Some((_, Field::Text(t))) => t.clone(),
            _ => "?".into(),
        }
    }

    #[test]
    fn an_entry_shows_what_its_fetch_lets_it() {
        let own = entry_fields(&facts());
        assert_eq!((number(&own, "transferSize"), number(&own, "secureConnectionStart"), number(&own, "responseStatus")), (400.0, 10.0, 200.0));
        assert_eq!((string(&own, "contentType"), string(&own, "contentEncoding"), string(&own, "renderBlockingStatus")), ("text/javascript".into(), "gzip".into(), "blocking".into()));
        let cross = entry_fields(&Facts { name: "https://b.test/x.js".into(), final_url: "https://b.test/x.js".into(), ..facts() });
        assert_eq!((number(&cross, "transferSize"), number(&cross, "connectStart"), number(&cross, "responseStatus")), (0.0, 0.0, 200.0));
        assert_eq!((string(&cross, "contentEncoding"), string(&cross, "nextHopProtocol")), ("".into(), "".into()));
        let cached = entry_fields(&Facts { cached: Some("cache".into()), ..facts() });
        assert_eq!((number(&cached, "transferSize"), string(&cached, "deliveryType")), (0.0, "cache".into()));
        let failed = entry_fields(&Facts { failed: true, ..facts() });
        assert_eq!((number(&failed, "fetchStart"), number(&failed, "responseEnd"), number(&failed, "requestStart")), (10.0, 12.0, 0.0));
    }

    fn st(value: &str) -> Vec<(String, f64, String)> {
        server_timing(value).into_iter().map(|m| (m.name, m.duration, m.description)).collect()
    }

    #[test]
    fn server_timing_parses_as_its_spec_says() {
        assert_eq!(st(r#"db;dur=53, app;dur=47.2;desc="a, b""#), vec![("db".into(), 53.0, "".into()), ("app".into(), 47.2, "a, b".into())]);
        assert_eq!(st("cache;desc=hit;desc=miss;dur=1;dur=2"), vec![("cache".into(), 1.0, "hit".into())]);
        assert_eq!(st(r#"x;desc="q\"q""#), vec![("x".into(), 0.0, "q\"q".into())]);
        // (…what the grammar cannot take ignored, not the metric — WPT server_timing_header-parsing 63, 65, 67, 69, 70)
        assert_eq!(st("bad junk, ok"), vec![("bad".into(), 0.0, "".into()), ("ok".into(), 0.0, "".into())]);
        assert_eq!(st("metric;desc=d1 d2;dur=123.4"), vec![("metric".into(), 123.4, "d1".into())]);
        assert_eq!(st(r#"metric==   ""foo;dur=123.4"#), vec![("metric".into(), 123.4, "".into())]);
        assert_eq!(st("metric;dur foo=12"), vec![("metric".into(), 0.0, "".into())]);
        assert_eq!(st(r#"metric;desc="\\"#), vec![("metric".into(), 0.0, "".into())]);
        assert_eq!(st("m;dur= 7"), vec![("m".into(), 7.0, "".into())]);
        assert_eq!(st(r#"m;dur=" 7""#), vec![("m".into(), 7.0, "".into())]);
        assert_eq!(st(";dur=1, ,y"), vec![("y".into(), 0.0, "".into())]);
    }

    #[test]
    fn mime_types_and_codings_minimize() {
        assert_eq!(minimize_mime("application/x-javascript; charset=utf-8"), "text/javascript");
        assert_eq!(minimize_mime("application/ld+json"), "application/json");
        assert_eq!(minimize_mime("image/svg+xml"), "image/svg+xml");
        assert_eq!(minimize_mime("application/atom+xml"), "application/xml");
        assert_eq!(minimize_mime("TEXT/HTML"), "text/html");
        assert_eq!(minimize_mime("nonsense"), "");
        assert_eq!(minimize_mime("text/plain, application/json"), "application/json");
        assert_eq!(content_encoding(" GZIP "), "gzip");
        assert_eq!(content_encoding("gzip, br"), "multiple");
        assert_eq!(content_encoding("identity"), "@unknown");
        assert!(timing_allowed(" https://a.test , *", "https://b.test"));
        let seen = |name, final_url, tao, opaque, document, no_cors| {
            let e = exposure(name, final_url, "https://a.test", tao, opaque, document, no_cors);
            (e.allowed, e.exposed)
        };
        assert_eq!(seen("https://a.test/x", "https://a.test/x", None, false, false, false), (true, true));
        assert_eq!(seen("https://b.test/x", "https://b.test/x", None, false, false, false), (false, true));
        assert_eq!(seen("https://b.test/x", "https://b.test/x", Some("https://a.test"), false, false, true), (true, false));
        assert_eq!(seen("https://a.test/x", "https://b.test/y", None, false, false, false), (false, true));
        assert_eq!(seen("https://a.test/x", "https://a.test/x", None, true, false, false), (false, false));
        assert_eq!(seen("https://b.test/f", "https://b.test/f", Some("*"), false, true, false), (true, false));
        assert!(!timing_allowed("https://a.test", "https://b.test"));
    }
}
