// Fetch's fixed rules for headers, methods and ports (Fetch §2.2.2, §2.6): which a script may not set, which keep a
// request simple — no preflight — and which a port a request never reaches. One table the page's `Headers`, XHR and
// WebSocket (header-rules.js, headers.js, websocket.js) and the host's CORS and port checks (browser.rb) all ask, so no
// two answers to "is `accept-language: x\x01` safelisted?" drift apart.

// A header name or value as bytes: a byte string's code units (one past U+00FF none of them, as no byte string has one).
fn bytes(units: &[u16]) -> Vec<u8> {
    units.iter().map(|&u| u8::try_from(u).unwrap_or(0xFF)).collect()
}

// "Bad port": one a request is never made to.
const BAD_PORTS: [u16; 83] = [
    0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
    111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
    540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
    6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
];
pub(crate) fn bad_port(port: u32) -> bool {
    u16::try_from(port).is_ok_and(|p| BAD_PORTS.contains(&p))
}

// "Forbidden method".
pub(crate) fn forbidden_method(method: &[u8]) -> bool {
    ["CONNECT", "TRACE", "TRACK"].iter().any(|m| m.as_bytes().eq_ignore_ascii_case(method))
}
// An HTTP `token` (RFC 9110 §5.6.2): a method, a header name — one or more `tchar`.
pub(crate) fn is_token(t: &[u8]) -> bool {
    !t.is_empty() && t.iter().all(|&b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}
// A Fetch "header value": no leading or trailing tab or space, and no NUL, CR or LF — what a value already normalized
// is (a `NavigationPreloadManager`'s `setHeaderValue` refuses any other, where a `Headers` write normalizes it).
pub(crate) fn is_header_value(v: &[u8]) -> bool {
    crate::headers::normalized_value(v).is_some_and(|n| n.len() == v.len())
}
// A response's status text: an RFC 9112 `reason-phrase` — HTAB, SP, VCHAR, obs-text.
pub(crate) fn is_reason_phrase(v: &[u8]) -> bool {
    v.iter().all(|&b| b == b'\t' || (0x20..=0x7E).contains(&b) || b >= 0x80)
}
// "Redirect status": the only codes `Response.redirect()` takes, and the hops a fetch follows.
pub(crate) fn redirect_status(status: u32) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}
// "Null body status": a response of one has no body.
pub(crate) fn null_body_status(status: u32) -> bool {
    matches!(status, 101 | 103 | 204 | 205 | 304)
}
// "Normalize a method": one of DELETE, GET, HEAD, OPTIONS, POST, PUT matched ASCII case-insensitively, byte-uppercased;
// None for any other, which keeps its case (`patch` stays `patch`).
pub(crate) fn normalized_method(method: &[u8]) -> Option<&'static str> {
    ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"].into_iter().find(|m| m.as_bytes().eq_ignore_ascii_case(method))
}
// "CORS-safelisted method".
pub(crate) fn cors_safelisted_method(method: &[u8]) -> bool {
    ["GET", "HEAD", "POST"].iter().any(|m| m.as_bytes() == method)
}

// Fetch "HTTP fetch" (§4.4) step 5.5: whether a service worker's response may answer a request in `mode` with
// `redirect` — none of an error, a CORS response to a same-origin request, an opaque one to a request not no-cors, an
// opaque redirect to one whose redirect mode is not manual, or a redirected response to one that does not follow.
pub(crate) fn service_worker_response_allowed(mode: &str, redirect: &str, response_type: &str, redirected: bool) -> bool {
    !(response_type == "error"
        || (mode == "same-origin" && response_type == "cors")
        || (mode != "no-cors" && response_type == "opaque")
        || (redirect != "manual" && response_type == "opaqueredirect")
        || (redirect != "follow" && redirected))
}

// Fetch "main fetch" (§4.1) step 12's `same-origin` branch: whether a request in mode `same-origin` for `url` (absolute,
// the Request's) from a client of origin `here` — its document's origin, serialized: an opaque one's "null" — is a
// network error: an http(s) URL of another origin. (A `data:` / `blob:` URL is its own scheme fetch's to answer.)
pub(crate) fn same_origin_mode_refused(url: &str, here: &str) -> bool {
    ada_url::Url::parse(url, None)
        .ok()
        .filter(|u| matches!(u.protocol(), "http:" | "https:"))
        .is_some_and(|u| u.origin() != here)
}

// Fetch "HTTP-redirect fetch" (§4.4) step 12: whether a redirect of `status` makes a request of `method` a bodyless GET —
// a 301 or 302 of a POST, a 303 of anything but a GET or HEAD.
pub(crate) fn redirect_to_get(status: u32, method: &[u8]) -> bool {
    ((status == 301 || status == 302) && method == b"POST") || (status == 303 && method != b"GET" && method != b"HEAD")
}
// …and a "request-body-header name", which that step removes with the body.
pub(crate) fn request_body_header(name: &[u8]) -> bool {
    ["content-encoding", "content-language", "content-location", "content-type"].iter().any(|h| h.as_bytes().eq_ignore_ascii_case(name))
}
// What following a redirect from `current` to `location` does to a request of `method` (`cors_mode`: its mode "cors"),
// made by a document of `request_origin`, its chain at another origin than that already where `crossed` (a response
// tainting stays) — None where it is a network error: a location that is no HTTP(S) URL (steps 5 and 6), one with
// credentials where the request is CORS-mode and the location of another origin (step 7) or where its response is
// CORS-tainted, a CORS-mode chain that has been at another origin, this hop included (step 8). Else whether it becomes a
// bodyless GET (step 12), whether its `Authorization` goes, as it does to another origin (step 13), and whether the
// chain has been at another origin once it is at the location — what makes a no-cors response opaque, a CORS one
// tainted.
pub(crate) struct Redirect {
    pub(crate) to_get: bool,
    pub(crate) drop_authorization: bool,
    pub(crate) crossed: bool,
}
pub(crate) fn redirect(status: u32, method: &[u8], current: &str, location: &str, cors_mode: bool, request_origin: &str, crossed: bool) -> Option<Redirect> {
    let to = ada_url::Url::parse(location, None).ok().filter(|u| matches!(u.protocol(), "http:" | "https:"))?;
    let from = ada_url::Url::parse(current, None).ok()?;
    let credentials = !to.username().is_empty() || !to.password().is_empty();
    let crossed = crossed || from.origin() != request_origin;
    if credentials && cors_mode && (to.origin() != request_origin || crossed) {
        return None;
    }
    Some(Redirect {
        to_get: redirect_to_get(status, method),
        drop_authorization: to.origin() != from.origin(),
        crossed: crossed || to.origin() != request_origin,
    })
}

// One hop of a request a service worker intercepts, and the response its `respondWith` handed back for it: Fetch "HTTP
// fetch" (§4.4) step 5.5 over that response, then — a redirect status — what the client's redirect mode makes of it: a
// network error, an opaque redirect, or "HTTP-redirect fetch" over it, the next hop intercepted again (the worker
// observes every followed hop).
pub(crate) struct InterceptedHop<'a> {
    pub(crate) mode: &'a str,
    pub(crate) redirect_mode: &'a str,
    pub(crate) url: &'a str,
    pub(crate) method: &'a [u8],
    pub(crate) request_origin: &'a str,
    // Whether the chain has been at another origin than the request's before this hop.
    pub(crate) crossed: bool,
    // How many redirects the chain has followed to reach this hop.
    pub(crate) hops: u32,
}
pub(crate) struct WorkerResponse<'a> {
    pub(crate) status: u32,
    pub(crate) response_type: &'a str,
    pub(crate) url: &'a str,
    pub(crate) redirected: bool,
    pub(crate) location: Option<&'a str>,
}
pub(crate) enum HopOutcome {
    // The response answers the request as it is.
    Answer,
    // Filtered to an opaque redirect of the hop's URL: a redirect the request's mode is "manual" for.
    OpaqueRedirect,
    // The next hop, at that URL, its request changed as the redirect says.
    Follow(String, Redirect),
    // A network error, and why.
    Fail(String),
}
pub(crate) fn intercepted_hop(hop: &InterceptedHop<'_>, response: &WorkerResponse<'_>) -> HopOutcome {
    let t = response.response_type;
    if !service_worker_response_allowed(hop.mode, hop.redirect_mode, t, response.redirected) {
        let redirected = if response.redirected { ", redirected" } else { "" };
        return HopOutcome::Fail(format!(
            "the service worker response (type \"{t}\"{redirected}) is disallowed for request mode \"{}\" / redirect \"{}\"",
            hop.mode, hop.redirect_mode
        ));
    }
    if !redirect_status(response.status) || t == "opaqueredirect" {
        return HopOutcome::Answer;
    }
    match hop.redirect_mode {
        "error" => return HopOutcome::Fail(format!("redirect mode is \"error\" but the response is a redirect: {}", hop.url)),
        "manual" => return HopOutcome::OpaqueRedirect,
        _ => {}
    }
    // (…"HTTP-redirect fetch": a redirect with no `Location` is the response itself)
    let Some(location) = response.location else { return HopOutcome::Answer };
    // The location resolves against the RESPONSE's URL — a synthetic response has none to anchor a relative one, which is
    // a network error (`Response.redirect()` absolutizes at creation, so it always carries one) — and, where it names
    // no fragment, takes the request's.
    let base = ada_url::Url::parse(response.url, None).ok();
    let Ok(mut next) = ada_url::Url::parse(location, base.as_ref().map(|b| b.href())) else {
        return HopOutcome::Fail(format!("invalid redirect location: {location}"));
    };
    if !next.has_hash() {
        if let Some(fragment) = ada_url::Url::parse(hop.url, None).ok().filter(|u| u.has_hash()) {
            next.set_hash(Some(fragment.hash()));
        }
    }
    if hop.hops >= 20 {
        return HopOutcome::Fail("exceeded 20 redirects".to_owned());
    }
    let next = next.href().to_owned();
    let Some(step) = redirect(response.status, hop.method, hop.url, &next, hop.mode == "cors", hop.request_origin, hop.crossed) else {
        return HopOutcome::Fail(format!("the redirect to {next} may not be followed"));
    };
    // (…a same-origin request whose chain has been at another origin fails, as main fetch fails it at each hop)
    if hop.mode == "same-origin" && step.crossed {
        return HopOutcome::Fail(format!("a same-origin request was redirected to another origin: {next}"));
    }
    HopOutcome::Follow(next, step)
}

const FORBIDDEN_REQUEST_HEADERS: [&str; 22] = [
    "accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method", "connection",
    "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin", "permissions-policy",
    "referer", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade", "via",
];
// "Forbidden request-header" (name, value): one the user agent controls — and the driver's own `x-csim-` markers, which a
// page must not forge either. A method-override header is one only where a token of its value is a forbidden method.
pub(crate) fn forbidden_request_header(name: &[u8], value: &[u8]) -> bool {
    let name = name.to_ascii_lowercase();
    if FORBIDDEN_REQUEST_HEADERS.iter().any(|h| h.as_bytes() == name) || [&b"proxy-"[..], b"sec-", b"x-csim-"].iter().any(|p| name.starts_with(p)) {
        return true;
    }
    if [&b"x-http-method"[..], b"x-http-method-override", b"x-method-override"].contains(&name.as_slice()) {
        return value.split(|&b| b == b',').any(|t| forbidden_method(trim_tab_or_space(t)));
    }
    false
}
// (…a token of a header value, its leading and trailing HTTP tab or space — no other whitespace — gone)
fn trim_tab_or_space(t: &[u8]) -> &[u8] {
    let tab_or_space = |b: &u8| *b == b'\t' || *b == b' ';
    let start = t.iter().position(|b| !tab_or_space(b)).unwrap_or(t.len());
    let end = t.iter().rposition(|b| !tab_or_space(b)).map_or(start, |e| e + 1);
    &t[start..end]
}
// "Forbidden response-header name".
pub(crate) fn forbidden_response_header(name: &[u8]) -> bool {
    name.eq_ignore_ascii_case(b"set-cookie") || name.eq_ignore_ascii_case(b"set-cookie2")
}

// "CORS-unsafe request-header byte".
fn cors_unsafe_byte(b: u8) -> bool {
    (b < 0x20 && b != 0x09) || b == 0x7F || b"\"():<>?@[\\]{}".contains(&b)
}
// "CORS-safelisted request-header" (name, value): one that keeps a request simple.
pub(crate) fn cors_safelisted_request_header(name: &[u8], value: &[u8]) -> bool {
    if value.len() > 128 {
        return false;
    }
    match name.to_ascii_lowercase().as_slice() {
        b"accept" => !value.iter().any(|&b| cors_unsafe_byte(b)),
        b"accept-language" | b"content-language" => value.iter().all(|&b| b.is_ascii_alphanumeric() || b" *,-.;=".contains(&b)),
        b"content-type" => {
            if value.iter().any(|&b| cors_unsafe_byte(b)) {
                return false;
            }
            // (…the value isomorphic-decoded, each byte the code point it is)
            let decoded: String = value.iter().map(|&b| char::from(b)).collect();
            let Some(mime) = crate::mime::parse(&decoded) else { return false };
            matches!(mime.essence.as_str(), "application/x-www-form-urlencoded" | "multipart/form-data" | "text/plain")
        }
        b"range" => simple_range(value),
        _ => false,
    }
}
// …"no-CORS-safelisted request-header": one of the four names a `no-cors` request may carry, safelisted.
pub(crate) fn no_cors_safelisted_request_header(name: &[u8], value: &[u8]) -> bool {
    let lower = name.to_ascii_lowercase();
    [&b"accept"[..], b"accept-language", b"content-language", b"content-type"].contains(&lower.as_slice()) && cors_safelisted_request_header(name, value)
}
// The CORS-safelisted `Range`: a single range, no white space in it, its start given (a suffix one is not: browsers never
// sent one, Fetch §2.2.2).
fn simple_range(value: &[u8]) -> bool {
    matches!(single_range(value, false), Some((Some(_), _)))
}
// Fetch "parse a single range header value": `bytes` (byte for byte), `=`, a start, `-`, an end — each number ASCII
// digits, either omitted but not both, a start past its end none — with HTTP tabs or spaces between where
// `allow_whitespace`; the start and the end (one past a u64 its greatest — past any body's end), None for failure.
pub(crate) fn single_range(value: &[u8], allow_whitespace: bool) -> Option<(Option<u64>, Option<u64>)> {
    let mut rest = value;
    let skip = |rest: &mut &[u8]| {
        while allow_whitespace && matches!(rest.first(), Some(b'\t' | b' ')) {
            *rest = &rest[1..];
        }
    };
    let expect = |rest: &mut &[u8], what: &[u8]| -> Option<()> {
        *rest = rest.strip_prefix(what)?;
        Some(())
    };
    // (…its digits, leading zeros gone: two numbers compare by these, whatever their size)
    let number = |rest: &mut &[u8]| -> Option<Vec<u8>> {
        let n = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        let digits = rest[..n].to_vec();
        *rest = &rest[n..];
        (n > 0).then(|| {
            let zeros = digits.iter().take_while(|&&d| d == b'0').count().min(n - 1);
            digits[zeros..].to_vec()
        })
    };
    expect(&mut rest, b"bytes")?;
    skip(&mut rest);
    expect(&mut rest, b"=")?;
    skip(&mut rest);
    let start = number(&mut rest);
    skip(&mut rest);
    expect(&mut rest, b"-")?;
    skip(&mut rest);
    let end = number(&mut rest);
    skip(&mut rest);
    let past_end = matches!((&start, &end), (Some(a), Some(b)) if (a.len(), a) > (b.len(), b));
    let value = |d: Vec<u8>| std::str::from_utf8(&d).ok().and_then(|d| d.parse::<u64>().ok()).unwrap_or(u64::MAX);
    (rest.is_empty() && (start.is_some() || end.is_some()) && !past_end).then(|| (start.map(value), end.map(value)))
}
// …and the bytes of a body `total` long a blob URL's range takes (Fetch's blob URL fetch, white space allowed): its first
// and last, None where the range is none or none of the body — a suffix its last bytes (all of them where it is longer),
// an end past the body's the body's last.
pub(crate) fn blob_range(value: &[u8], total: u64) -> Option<(u64, u64)> {
    match single_range(value, true)? {
        (None, Some(suffix)) => (suffix > 0 && total > 0).then(|| (total.saturating_sub(suffix), total - 1)),
        (Some(start), end) if start < total => Some((start, end.map_or(total - 1, |e| e.min(total - 1)))),
        _ => None,
    }
}
// Fetch's "scheme fetch" (§4.2) of a `blob:` URL whose blob (the bindings' to resolve: its type and its size) a request
// of `method` and `range` (its `Range` header's value) fetches — the response, or None for a network error: a GET
// alone; its Content-Type the blob's type where that parses as a MIME type (fetch/api/basic/scheme-blob
// "invalid_type_blob"), else empty; a single satisfiable byte range a 206 of that slice, with its Content-Range, and a
// malformed or unsatisfiable one a network error (a blob URL answers no 416) — as `(status, content type, first byte,
// end, content range)`.
pub(crate) fn blob_response(method: &str, range: Option<&[u8]>, blob_type: &str, size: u64) -> Option<(u32, String, u64, u64, Option<String>)> {
    if method != "GET" {
        return None;
    }
    let content_type = if crate::mime::parse(blob_type).is_some() { blob_type.to_owned() } else { String::new() };
    match range {
        None => Some((200, content_type, 0, size, None)),
        Some(value) => {
            let (first, last) = blob_range(value, size)?;
            Some((206, content_type, first, last + 1, Some(format!("bytes {first}-{last}/{size}"))))
        }
    }
}

// HTML "create a potential-CORS request" (§2.5.5) for an element whose CORS settings attribute (`crossorigin`, §2.5.4)
// is `attr` — the request's mode and credentials mode: No CORS (no attribute) a no-cors request with credentials
// (a module script's — `module` — a cors one, same-origin), Use Credentials (`use-credentials`, ASCII
// case-insensitively) a cors one with credentials, Anonymous (any other value, an empty or invalid one included) a cors
// one, same-origin.
pub(crate) fn cors_request(attr: Option<&str>, module: bool) -> (&'static str, &'static str) {
    match attr {
        None if module => ("cors", "same-origin"),
        None => ("no-cors", "include"),
        Some(v) if v.eq_ignore_ascii_case("use-credentials") => ("cors", "include"),
        Some(_) => ("cors", "same-origin"),
    }
}

// "CORS-safelisted response-header name" (with no `Access-Control-Expose-Headers` naming more).
pub(crate) fn cors_safelisted_response_header(name: &[u8]) -> bool {
    ["cache-control", "content-language", "content-length", "content-type", "expires", "last-modified", "pragma"]
        .iter()
        .any(|h| h.as_bytes().eq_ignore_ascii_case(name))
}

// ── For the bindings ──
// The headers a fetch's request has where its author set none of the name (Fetch §4.1 "main fetch": `Accept: */*`
// for one with no destination, which XHR's and fetch()'s are — not a document navigation's richer Accept, which the
// host fills in — and the user agent's `Accept-Language`).
const DEFAULT_REQUEST_HEADERS: [(&str, &str); 2] = [("Accept", "*/*"), ("Accept-Language", "en-US,en;q=0.9")];
// __dom.defaultRequestHeaders() -> [name, value, …]: `DEFAULT_REQUEST_HEADERS`.
fn default_request_headers_op(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let items: Vec<v8::Local<v8::Value>> =
        DEFAULT_REQUEST_HEADERS.iter().flat_map(|(n, v)| [n, v]).filter_map(|s| v8::String::new(scope, s)).map(Into::into).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "badPort", bad_port_op, context_id);
    crate::dom::register(scope, ns, "defaultRequestHeaders", default_request_headers_op, context_id);
    crate::dom::register(scope, ns, "blobResponse", blob_response_op, context_id);
    crate::dom::register(scope, ns, "corsRequest", cors_request_op, context_id);
    crate::dom::register(scope, ns, "corsSafelistedMethod", cors_safelisted_method_op, context_id);
    crate::dom::register(scope, ns, "interceptedHop", intercepted_hop_op, context_id);
    crate::dom::register(scope, ns, "requestBodyHeader", request_body_header_op, context_id);
    crate::dom::register(scope, ns, "responseHeader", response_header_op, context_id);
    crate::dom::register(scope, ns, "sameOriginModeRefused", same_origin_mode_refused_op, context_id);
    crate::dom::register(scope, ns, "swResponseAllowed", sw_response_allowed_op, context_id);
    crate::dom::register(scope, ns, "forbiddenMethod", forbidden_method_op, context_id);
    crate::dom::register(scope, ns, "headerValue", header_value_op, context_id);
    crate::dom::register(scope, ns, "httpToken", http_token_op, context_id);
    crate::dom::register(scope, ns, "normalizedMethod", normalized_method_op, context_id);
}
pub(crate) fn byte_string(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Vec<u8> {
    let Some(s) = value.to_string(scope) else { return Vec::new() };
    let mut units = vec![0u16; s.length()];
    s.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
    bytes(&units)
}
// __dom.badPort(port) -> whether a request to it is never made.
fn bad_port_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let port = args.get(0).uint32_value(scope).unwrap_or(0);
    rv.set_bool(bad_port(port));
}
// __dom.corsSafelistedMethod(method) -> whether it is a CORS-safelisted method.
fn cors_safelisted_method_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let method = byte_string(scope, args.get(0));
    rv.set_bool(cors_safelisted_method(&method));
}
// __dom.interceptedHop(mode, redirectMode, url, method, requestOrigin, crossed, hops, status, type, responseUrl, redirected,
// location) -> `intercepted_hop`: 0 to answer, 1 for an opaque redirect, [nextUrl, bits] to follow (bits: 1 the request a
// bodyless GET, 2 its Authorization dropped, 4 its chain at another origin), or a network error's message.
fn intercepted_hop_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let [mode, redirect_mode, url, request_origin, response_type, response_url] = [0, 1, 2, 4, 8, 9].map(|k| args.get(k).to_rust_string_lossy(scope));
    let method = byte_string(scope, args.get(3));
    let location = (!args.get(11).is_null_or_undefined()).then(|| args.get(11).to_rust_string_lossy(scope));
    let hop = InterceptedHop {
        mode: &mode,
        redirect_mode: &redirect_mode,
        url: &url,
        method: &method,
        request_origin: &request_origin,
        crossed: args.get(5).is_true(),
        hops: args.get(6).uint32_value(scope).unwrap_or(0),
    };
    let response = WorkerResponse {
        status: args.get(7).uint32_value(scope).unwrap_or(0),
        response_type: &response_type,
        url: &response_url,
        redirected: args.get(10).is_true(),
        location: location.as_deref(),
    };
    match intercepted_hop(&hop, &response) {
        HopOutcome::Answer => rv.set_int32(0),
        HopOutcome::OpaqueRedirect => rv.set_int32(1),
        HopOutcome::Follow(next, r) => {
            let next = v8::String::new(scope, &next).unwrap();
            let bits = v8::Integer::new(scope, r.to_get as i32 | (r.drop_authorization as i32) << 1 | (r.crossed as i32) << 2);
            rv.set(v8::Array::new_with_elements(scope, &[next.into(), bits.into()]).into());
        }
        HopOutcome::Fail(message) => rv.set(v8::String::new(scope, &message).unwrap().into()),
    }
}
// __dom.requestBodyHeader(name) -> whether it is a request-body-header name.
fn request_body_header_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = byte_string(scope, args.get(0));
    rv.set_bool(request_body_header(&name));
}
// __dom.sameOriginModeRefused(url, here) -> `same_origin_mode_refused`.
fn same_origin_mode_refused_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (url, here) = (args.get(0).to_rust_string_lossy(scope), args.get(1).to_rust_string_lossy(scope));
    rv.set_bool(same_origin_mode_refused(&url, &here));
}
// __dom.swResponseAllowed(mode, redirectMode, type, redirected) -> `service_worker_response_allowed`.
fn sw_response_allowed_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let [mode, redirect, response_type] = [0, 1, 2].map(|k| args.get(k).to_rust_string_lossy(scope));
    rv.set_bool(service_worker_response_allowed(&mode, &redirect, &response_type, args.get(3).is_true()));
}
// __dom.corsRequest(el, module) -> [mode, credentials] of the request element `el` makes (`cors_request`, by its
// `crossorigin` attribute) — one of no element (a module graph's root nobody's) as one of no attribute.
fn cors_request_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = crate::node_handle::nid_of(scope, args.get(0));
    let module = args.get(1).is_true();
    let attr = id.and_then(|id| crate::dom::dom(scope).arena.get(id).and_then(|n| n.plain_attr("crossorigin").map(str::to_owned)));
    let (mode, credentials) = cors_request(attr.as_deref(), module);
    let (Some(mode), Some(credentials)) = (v8::String::new(scope, mode), v8::String::new(scope, credentials)) else { return };
    rv.set(v8::Array::new_with_elements(scope, &[mode.into(), credentials.into()]).into());
}
// __dom.blobResponse(method, range, type, size) -> [status, content type, first byte, end, content range] of
// `blob_response` (`range` null for none; the content range null for a whole blob), or null for a network error.
fn blob_response_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let method = args.get(0).to_rust_string_lossy(scope);
    let range = (!args.get(1).is_null_or_undefined()).then(|| byte_string(scope, args.get(1)));
    let blob_type = args.get(2).to_rust_string_lossy(scope);
    let size = args.get(3).number_value(scope).unwrap_or(0.0) as u64;
    let Some((status, content_type, first, end, content_range)) = blob_response(&method, range.as_deref(), &blob_type, size) else { return rv.set_null() };
    let content_type = v8::String::new(scope, &content_type).map_or_else(|| v8::undefined(scope).into(), Into::into);
    let content_range = content_range.and_then(|r| v8::String::new(scope, &r)).map_or_else(|| v8::null(scope).into(), Into::into);
    let items = [
        v8::Integer::new_from_unsigned(scope, status).into(),
        content_type,
        v8::Number::new(scope, first as f64).into(),
        v8::Number::new(scope, end as f64).into(),
        content_range,
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.forbiddenMethod(method) -> whether it is a forbidden method.
fn forbidden_method_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let method = byte_string(scope, args.get(0));
    rv.set_bool(forbidden_method(&method));
}
// __dom.responseHeader(headers, name) -> the value of the header `name` (lowercase) among a response's headers as the
// host gives them — an object keyed by name, in any case, a list of values joined with ", " — or null for none.
fn response_header_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Ok(headers) = v8::Local::<v8::Object>::try_from(args.get(0)) else { return };
    let name = args.get(1).to_rust_string_lossy(scope);
    let Some(keys) = headers.get_own_property_names(scope, Default::default()) else { return };
    for i in 0..keys.length() {
        let Some(key) = keys.get_index(scope, i) else { continue };
        if !key.to_rust_string_lossy(scope).eq_ignore_ascii_case(&name) {
            continue;
        }
        let Some(value) = headers.get(scope, key).filter(|v| !v.is_null_or_undefined()) else { return };
        let text = match v8::Local::<v8::Array>::try_from(value) {
            Ok(list) => {
                let mut values = Vec::new();
                for j in 0..list.length() {
                    if let Some(v) = list.get_index(scope, j) {
                        values.push(v.to_rust_string_lossy(scope));
                    }
                }
                values.join(", ")
            }
            Err(_) => value.to_rust_string_lossy(scope),
        };
        if let Some(text) = v8::String::new(scope, &text) {
            rv.set(text.into());
        }
        return;
    }
}
// (…these take a ByteString the bindings converted already: `byte_string` reads a unit past U+00FF as 0xFF, which is
// obs-text to them)
// __dom.headerValue(s) -> whether `s` is a header value (`is_header_value`).
fn header_value_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let s = byte_string(scope, args.get(0));
    rv.set_bool(is_header_value(&s));
}
// __dom.httpToken(s) -> whether `s` is an HTTP token (`is_token`).
fn http_token_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let s = byte_string(scope, args.get(0));
    rv.set_bool(is_token(&s));
}
// __dom.normalizedMethod(method) -> `normalized_method`: the uppercase method, or null for one that keeps its case.
fn normalized_method_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let method = byte_string(scope, args.get(0));
    match normalized_method(&method).and_then(|m| v8::String::new(scope, m)) {
        Some(m) => rv.set(m.into()),
        None => rv.set_null(),
    }
}
// ── For the host ──
// (…a Ruby string's bytes, whatever its encoding)
fn ruby_bytes(s: magnus::RString) -> Vec<u8> {
    // SAFETY: copied at once, before anything could run Ruby code that moves or frees it.
    unsafe { s.as_slice() }.to_vec()
}
pub(crate) fn bad_port_for_ruby(port: u32) -> bool {
    bad_port(port)
}
pub(crate) fn redirect_to_get_for_ruby(status: u32, method: magnus::RString) -> bool {
    redirect_to_get(status, &ruby_bytes(method))
}
pub(crate) fn service_worker_response_allowed_for_ruby(mode: String, redirect: String, response_type: String, redirected: bool) -> bool {
    service_worker_response_allowed(&mode, &redirect, &response_type, redirected)
}
pub(crate) fn cors_safelisted_method_for_ruby(method: magnus::RString) -> bool {
    cors_safelisted_method(&ruby_bytes(method))
}
pub(crate) fn cors_safelisted_request_header_for_ruby(name: magnus::RString, value: magnus::RString) -> bool {
    cors_safelisted_request_header(&ruby_bytes(name), &ruby_bytes(value))
}
pub(crate) fn cors_safelisted_response_header_for_ruby(name: magnus::RString) -> bool {
    cors_safelisted_response_header(&ruby_bytes(name))
}
pub(crate) fn forbidden_response_header_for_ruby(name: magnus::RString) -> bool {
    forbidden_response_header(&ruby_bytes(name))
}
pub(crate) fn http_token_for_ruby(s: magnus::RString) -> bool {
    is_token(&ruby_bytes(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_service_worker_response_answers_only_the_requests_its_type_may() {
        assert!(service_worker_response_allowed("no-cors", "follow", "opaque", false));
        assert!(!service_worker_response_allowed("cors", "follow", "opaque", false));
        assert!(!service_worker_response_allowed("same-origin", "follow", "cors", false));
        assert!(service_worker_response_allowed("cors", "follow", "cors", true));
        assert!(!service_worker_response_allowed("navigate", "manual", "basic", true));
        assert!(service_worker_response_allowed("navigate", "manual", "opaqueredirect", false));
        assert!(!service_worker_response_allowed("cors", "follow", "opaqueredirect", false));
        assert!(!service_worker_response_allowed("no-cors", "follow", "error", false));
    }

    #[test]
    fn a_same_origin_request_refuses_an_http_url_of_another_origin() {
        let here = "http://a.test";
        assert!(!same_origin_mode_refused("http://a.test/x", here));
        assert!(!same_origin_mode_refused("http://A.TEST:80/x", here));
        assert!(same_origin_mode_refused("http://b.test/x", here));
        assert!(same_origin_mode_refused("https://a.test/x", here));
        assert!(same_origin_mode_refused("http://a.test/x", "null"));
        assert!(!same_origin_mode_refused("data:,x", here));
        assert!(!same_origin_mode_refused("blob:http://b.test/u", here));
        assert!(!same_origin_mode_refused("about:blank", here));
    }

    #[test]
    fn an_intercepted_hop_answers_fails_or_follows() {
        let hop = |redirect_mode, mode, hops| InterceptedHop {
            mode,
            redirect_mode,
            url: "http://a.test/x",
            method: b"POST",
            request_origin: "http://a.test",
            crossed: false,
            hops,
        };
        let response = |status, location, url| WorkerResponse { status, response_type: "basic", url, redirected: false, location };
        let r302 = response(302, Some("y"), "http://a.test/x");
        assert!(matches!(intercepted_hop(&hop("follow", "cors", 0), &response(200, Some("y"), "")), HopOutcome::Answer));
        assert!(matches!(intercepted_hop(&hop("manual", "cors", 0), &r302), HopOutcome::OpaqueRedirect));
        assert!(matches!(intercepted_hop(&hop("error", "cors", 0), &r302), HopOutcome::Fail(_)));
        assert!(matches!(intercepted_hop(&hop("follow", "cors", 20), &r302), HopOutcome::Fail(_)));
        assert!(matches!(
            intercepted_hop(&hop("follow", "cors", 19), &r302),
            HopOutcome::Follow(ref next, Redirect { to_get: true, .. }) if next == "http://a.test/y"
        ));
        // (…a relative location with no response URL to anchor it, and a same-origin request led to another origin)
        assert!(matches!(intercepted_hop(&hop("follow", "cors", 0), &response(302, Some("y"), "")), HopOutcome::Fail(_)));
        assert!(matches!(intercepted_hop(&hop("follow", "same-origin", 0), &response(307, Some("http://b.test/"), "")), HopOutcome::Fail(_)));
        assert!(matches!(intercepted_hop(&hop("follow", "cors", 0), &response(304, Some("y"), "")), HopOutcome::Answer));
        // (…a redirect with no `Location` the response where it is followed, and as any other redirect where it is not)
        let bare = response(302, None, "http://a.test/x");
        assert!(matches!(intercepted_hop(&hop("follow", "cors", 20), &bare), HopOutcome::Answer));
        assert!(matches!(intercepted_hop(&hop("manual", "cors", 0), &bare), HopOutcome::OpaqueRedirect));
        assert!(matches!(intercepted_hop(&hop("error", "cors", 0), &bare), HopOutcome::Fail(_)));
        // (…and a location naming no fragment takes the request's)
        let fragment = InterceptedHop { url: "http://a.test/x#f", ..hop("follow", "cors", 0) };
        assert!(matches!(intercepted_hop(&fragment, &r302), HopOutcome::Follow(ref next, _) if next == "http://a.test/y#f"));
        assert!(matches!(
            intercepted_hop(&fragment, &response(302, Some("y#g"), "http://a.test/x")),
            HopOutcome::Follow(ref next, _) if next == "http://a.test/y#g"
        ));
    }

    #[test]
    fn a_redirect_follows_the_fetch_steps() {
        let r = |status, method: &[u8], to: &str, cors| redirect(status, method, "http://a.test/x", to, cors, "http://a.test", false).map(|r| (r.to_get, r.drop_authorization));
        assert_eq!(r(302, b"POST", "http://a.test/y", false), Some((true, false)));
        assert_eq!(r(307, b"POST", "http://b.test/y", false), Some((false, true)));
        assert_eq!(r(303, b"HEAD", "http://a.test/y", false), Some((false, false)));
        assert_eq!(r(301, b"GET", "data:,x", false), None);
        assert_eq!(r(301, b"GET", "http://u:p@b.test/", true), None);
        assert_eq!(r(301, b"GET", "http://u:p@a.test/", true), Some((false, false)));
        assert!(redirect(301, b"GET", "http://b.test/x", "http://u:p@b.test/", true, "http://a.test", false).is_none());
        // (…a chain that left its origin and came back is still tainted; and has crossed, whatever its mode)
        assert!(redirect(301, b"GET", "http://a.test/x", "http://u:p@a.test/", true, "http://a.test", true).is_none());
        assert!(redirect(301, b"GET", "http://a.test/x", "http://b.test/", false, "http://a.test", false).is_some_and(|r| r.crossed));
        assert!(redirect(301, b"GET", "http://b.test/x", "http://a.test/", false, "http://a.test", false).is_some_and(|r| r.crossed));
        assert!(redirect(301, b"GET", "http://a.test/x", "http://a.test/y", false, "http://a.test", false).is_some_and(|r| !r.crossed));
        assert!(request_body_header(b"Content-Type") && !request_body_header(b"content-length"));
    }

    #[test]
    fn headers_keep_to_the_tables() {
        assert!(forbidden_request_header(b"Sec-Fetch-Mode", b""));
        assert!(forbidden_request_header(b"X-HTTP-Method-Override", b"get, \tTRACE "));
        assert!(!forbidden_request_header(b"x-http-method", b"GET"));
        assert!(cors_safelisted_request_header(b"Accept-Language", b"en-US,en;q=0.5"));
        assert!(!cors_safelisted_request_header(b"accept-language", b"en\x01"));
        assert!(!cors_safelisted_request_header(b"content-language", b"a\"b"));
        assert!(cors_safelisted_request_header(b"content-type", b"text/plain; charset=utf-8"));
        assert!(cors_safelisted_request_header(b"content-type", b"text/plain;charset=\xe9"));
        assert!(!cors_safelisted_request_header(b"content-type", b"application/json"));
        assert!(cors_safelisted_request_header(b"range", b"bytes=0-"));
        assert!(!cors_safelisted_request_header(b"range", b"bytes=-5"));
        assert!(!cors_safelisted_request_header(b"range", b"BYTES=0-"));
        assert!(!cors_safelisted_request_header(b"range", b"bytes=99999999999999999999999-99999999999999999999998"));
        assert!(cors_safelisted_request_header(b"range", b"bytes=007-8"));
        assert!(!cors_safelisted_request_header(b"range", b"bytes=5-1"));
        assert!(!cors_safelisted_request_header(b"range", b"bytes= 0-"));
        assert_eq!(blob_range(b"bytes = 2 - ", 10), Some((2, 9)));
        assert_eq!(blob_range(b"BYTES=0-2", 10), None);
        assert_eq!(blob_range(b"bytes=-3", 10), Some((7, 9)));
        assert_eq!(blob_range(b"bytes=-30", 10), Some((0, 9)));
        assert_eq!(blob_range(b"bytes=2-99", 10), Some((2, 9)));
        assert_eq!(blob_range(b"bytes=10-", 10), None);
        assert_eq!(blob_range(b"bytes=-0", 10), None);
        assert_eq!(blob_range(b"bytes=0-1,3-4", 10), None);
        assert!(!no_cors_safelisted_request_header(b"range", b"bytes=0-"));
        assert!(bad_port(6000) && !bad_port(80) && !bad_port(70000));
        assert!(!forbidden_request_header(b"x-method-override", b"\nTRACE"));
    }
}
