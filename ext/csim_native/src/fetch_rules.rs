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

// Fetch "determine nosniff": whether an `X-Content-Type-Options` value's first (get, decode and split) is `nosniff`.
pub(crate) fn determine_nosniff(value: &str) -> bool {
    crate::headers::decode_split(value).first().is_some_and(|v| v.eq_ignore_ascii_case("nosniff"))
}
// …and "should response to request be blocked due to nosniff?": under it, a script-like destination's response that
// is no JavaScript MIME type, a style one's that is no `text/css` (`destination` as a request's, ASCII
// case-insensitively — a preload's `as` names it).
pub(crate) fn blocked_by_nosniff(destination: &str, content_type: &str, nosniff: &str) -> bool {
    if !determine_nosniff(nosniff) {
        return false;
    }
    let essence = crate::mime::extract(content_type).map(|m| m.essence);
    let is = |d: &str| destination.eq_ignore_ascii_case(d);
    if ["audioworklet", "paintworklet", "script", "serviceworker", "sharedworker", "worker"].iter().any(|d| is(d)) {
        return !essence.as_deref().is_some_and(crate::script::is_javascript_mime);
    }
    is("style") && essence.as_deref() != Some("text/css")
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

// …and whether a subresource the page fetches may use it (a `destination` request, `mode` its element's, redirect mode
// follow): one Fetch allows (`service_worker_response_allowed`), and by what its consumer makes of a status — an image
// decodes what it is given; a classic script and a style sheet want an ok status of the response they are made of, an
// opaque one's the one it hides ("fetch a classic script" takes the response's unsafe response — `status` that one —
// and a sheet's "process the linked resource", read of an opaque filtered response's 0, would refuse every no-cors
// sheet of another origin, which the network's is judged by its real status as); a media resource's fetch errs on an
// HTTP 4xx or 5xx (HTML's media data processing list), and a font's wants an ok status — an opaque answer, whose status
// a no-cors consumer cannot read, any of those.
pub(crate) fn sw_subresource_usable(destination: &str, mode: &str, response_type: &str, redirected: bool, status: u32) -> bool {
    if !service_worker_response_allowed(mode, "follow", response_type, redirected) {
        return false;
    }
    match destination {
        "image" => true,
        "script" | "style" => (200..=299).contains(&status),
        _ if response_type == "opaque" => true,
        "audio" | "video" | "track" => status < 400,
        _ => (200..=299).contains(&status),
    }
}

// What answers a request of the bindings' fetch() / XHR — Fetch "main fetch" (§4.1) and "HTTP fetch" (§4.3) as they take
// them, for `url` (absolute, the request's) made by a client of document origin `here` (serialized: an opaque one's
// "null"), `flags` its `FETCH_*` facts: a `data:` URL's processor; a `blob:` URL's entry; for an http(s) URL a
// navigation's chain (outside a worker: a service worker's re-fetch of one is a plain fetch), else a network error where
// its mode is `same-origin` and the URL of another origin (step 12, before any service worker), else the controlling
// service worker (Handle Fetch, which a synchronous request cannot await), else a keepalive request's own thread, else
// the network; for any other URL the network, which refuses it — Handle Fetch sees an HTTP(S) request alone.
pub(crate) const ROUTE_NETWORK: u32 = 0;
pub(crate) const ROUTE_DATA: u32 = 1;
pub(crate) const ROUTE_BLOB: u32 = 2;
pub(crate) const ROUTE_NAVIGATION: u32 = 3;
pub(crate) const ROUTE_REFUSED: u32 = 4;
pub(crate) const ROUTE_SERVICE_WORKER: u32 = 5;
pub(crate) const ROUTE_KEEPALIVE: u32 = 6;
pub(crate) const FETCH_CONTROLLED: u32 = 1;
pub(crate) const FETCH_SYNC: u32 = 2;
pub(crate) const FETCH_KEEPALIVE: u32 = 4;
pub(crate) const FETCH_NAVIGATE: u32 = 8;
pub(crate) const FETCH_IN_WORKER: u32 = 16;
pub(crate) const FETCH_SAME_ORIGIN: u32 = 32;
pub(crate) fn fetch_route(url: &str, flags: u32, here: &str) -> u32 {
    let Ok(u) = ada_url::Url::parse(url, None) else { return ROUTE_NETWORK };
    match u.protocol() {
        "data:" => ROUTE_DATA,
        "blob:" => ROUTE_BLOB,
        "http:" | "https:" if flags & (FETCH_NAVIGATE | FETCH_IN_WORKER) == FETCH_NAVIGATE => ROUTE_NAVIGATION,
        "http:" | "https:" if flags & FETCH_SAME_ORIGIN != 0 && u.origin() != here => ROUTE_REFUSED,
        "http:" | "https:" if flags & (FETCH_CONTROLLED | FETCH_SYNC) == FETCH_CONTROLLED => ROUTE_SERVICE_WORKER,
        "http:" | "https:" if flags & FETCH_KEEPALIVE != 0 => ROUTE_KEEPALIVE,
        _ => ROUTE_NETWORK,
    }
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
// A request a redirect response is followed for (Fetch "HTTP-redirect fetch"): its method, its current URL, whether its
// mode is "cors", its origin serialized ('' where it has none), whether its response tainting is "cors" — a CORS-mode
// request whose chain has been at another origin than its own — and whether its origin is tainted already.
pub(crate) struct Redirecting<'a> {
    pub(crate) method: &'a [u8],
    pub(crate) current: &'a str,
    pub(crate) cors_mode: bool,
    pub(crate) origin: &'a str,
    pub(crate) tainting_cors: bool,
    pub(crate) tainted_origin: bool,
}
// The request after it: at `url`, a bodyless GET where `to_get` (step 12), its `Authorization` gone where `drop_authorization`
// (step 13: the redirect leaves its current URL's origin), its origin tainted — serialized "null" — where `tainted_origin`:
// its redirect-taint no longer "same-origin", a URL of its list off another origin than its own led on to yet another
// ("serializing a request origin").
pub(crate) struct Redirect {
    pub(crate) url: String,
    pub(crate) to_get: bool,
    pub(crate) drop_authorization: bool,
    pub(crate) tainted_origin: bool,
}
pub(crate) enum Redirected {
    // No `Location`: the redirect response answers the request (step 3, a null location URL).
    Answer,
    Follow(Redirect),
    // A network error, and why.
    Fail(String),
}
// Fetch "HTTP-redirect fetch" steps 3-13 over a redirect response of `status` at `response_url` whose `Location` is
// `location`, for the request `r`: its location URL parsed against the response's URL, the current URL's fragment where
// it names none — a network error where it does not parse (step 3), is no HTTP(S) URL (step 5), has credentials where
// the request is CORS-mode and of another origin (step 7) or its response tainting "cors" (step 8), or names a blocked
// port (the next fetch's "should port be blocked?"). The redirect count (step 6) is the caller's, which counts its hops.
pub(crate) fn follow_redirect(r: &Redirecting<'_>, status: u32, response_url: &str, location: Option<&str>) -> Redirected {
    let Some(location) = location else { return Redirected::Answer };
    let base = ada_url::Url::parse(response_url, None).ok();
    let Ok(mut to) = ada_url::Url::parse(location, base.as_ref().map(|b| b.href())) else {
        return Redirected::Fail(format!("invalid redirect location: {location}"));
    };
    let Ok(from) = ada_url::Url::parse(r.current, None) else {
        return Redirected::Fail(format!("invalid request URL: {}", r.current));
    };
    if !to.has_hash() && from.has_hash() {
        to.set_hash(Some(from.hash()));
    }
    if !matches!(to.protocol(), "http:" | "https:") {
        return Redirected::Fail(format!("a redirect to a URL that is no HTTP(S) one: {}", to.href()));
    }
    let credentials = !to.username().is_empty() || !to.password().is_empty();
    if credentials && ((r.cors_mode && to.origin() != r.origin) || r.tainting_cors) {
        return Redirected::Fail(format!("a redirect to a URL with credentials: {}", to.href()));
    }
    if to.port().parse::<u32>().is_ok_and(bad_port) {
        return Redirected::Fail(format!("a redirect to a blocked port: {}", to.href()));
    }
    let tainted_origin = !r.origin.is_empty() && crate::referrer::redirect_taints(r.tainted_origin, r.origin, r.current, to.href());
    Redirected::Follow(Redirect {
        to_get: redirect_to_get(status, r.method),
        drop_authorization: to.origin() != from.origin(),
        tainted_origin,
        url: to.href().to_owned(),
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
    // Whether a redirect before this hop tainted the request's origin.
    pub(crate) tainted: bool,
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
    // The next hop, its request changed as the redirect says — and whether the chain has been at another origin than the
    // request's once it is there.
    Follow(Redirect, bool),
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
    // (…the chain at another origin than the request's once it is at this hop: its response tainting "cors" in CORS mode)
    let crossed = hop.crossed || ada_url::Url::parse(hop.url, None).is_ok_and(|u| u.origin() != hop.request_origin);
    let request = Redirecting {
        method: hop.method,
        current: hop.url,
        cors_mode: hop.mode == "cors",
        origin: hop.request_origin,
        tainting_cors: hop.mode == "cors" && crossed,
        tainted_origin: hop.tainted,
    };
    // (…a synthetic response has no URL to anchor a relative location against, which is a network error:
    // `Response.redirect()` absolutizes at creation, so it always carries one)
    let step = match follow_redirect(&request, response.status, response.url, response.location) {
        Redirected::Answer => return HopOutcome::Answer,
        Redirected::Fail(why) => return HopOutcome::Fail(why),
        Redirected::Follow(step) => step,
    };
    if hop.hops >= 20 {
        return HopOutcome::Fail("exceeded 20 redirects".to_owned());
    }
    let crossed = crossed || ada_url::Url::parse(&step.url, None).is_ok_and(|u| u.origin() != hop.request_origin);
    // (…a same-origin request whose chain has been at another origin fails, as main fetch fails it at each hop)
    if hop.mode == "same-origin" && crossed {
        return HopOutcome::Fail(format!("a same-origin request was redirected to another origin: {}", step.url));
    }
    HopOutcome::Follow(step, crossed)
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
// The headers a fetch's request has where its author set none of the name (Fetch §4 "fetching", its steps 12-13): its
// destination's `Accept` (`default_accept`) — `*/*` for one of none, which XHR's and fetch()'s are, a document's for a
// frame's navigation — and the user agent's `Accept-Language`.
const ACCEPT_LANGUAGE: &str = "en-US,en;q=0.9";
// Fetch "fetch" step 12: the `Accept` a request of `destination` carries where its header list has none (a prefetch's,
// whose initiator says so before its destination does, a document's: subresource_obtain.rs `dispatch`).
pub(crate) fn default_accept(destination: &str) -> &'static str {
    match destination {
        "document" | "frame" | "iframe" => "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "image" => "image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5",
        "json" => "application/json,*/*;q=0.5",
        "style" => "text/css,*/*;q=0.1",
        _ => "*/*",
    }
}
// …for the host: a request the host hands a service worker (browser.rb `sw_fetch_request`).
pub(crate) fn default_accept_for_ruby(destination: String) -> String {
    default_accept(&destination).to_owned()
}

// __dom.defaultRequestHeaders([destination]) -> [name, value, …]: those a request of `destination` (none: the empty one)
// has where its author set none of the name.
fn default_request_headers_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let destination = if args.get(0).is_string() { args.get(0).to_rust_string_lossy(scope) } else { String::new() };
    let headers = [("Accept", default_accept(&destination)), ("Accept-Language", ACCEPT_LANGUAGE)];
    let items: Vec<v8::Local<v8::Value>> =
        headers.iter().flat_map(|(n, v)| [n, v]).filter_map(|s| v8::String::new(scope, s)).map(Into::into).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "badPort", bad_port_op, context_id);
    crate::dom::register(scope, ns, "beaconCors", beacon_cors_op, context_id);
    crate::dom::register(scope, ns, "defaultRequestHeaders", default_request_headers_op, context_id);
    crate::dom::register(scope, ns, "blobResponse", blob_response_op, context_id);
    crate::dom::register(scope, ns, "corsSafelistedMethod", cors_safelisted_method_op, context_id);
    crate::dom::register(scope, ns, "interceptedHop", intercepted_hop_op, context_id);
    crate::dom::register(scope, ns, "requestBodyHeader", request_body_header_op, context_id);
    crate::dom::register(scope, ns, "responseHeader", response_header_op, context_id);
    crate::dom::register(scope, ns, "fetchRoute", fetch_route_op, context_id);
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
// location, tainted) -> `intercepted_hop`: 0 to answer, 1 for an opaque redirect, [nextUrl, bits] to follow (bits: 1 the
// request a bodyless GET, 2 its Authorization dropped, 4 its chain at another origin, 8 its origin tainted), or a network
// error's message.
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
        tainted: args.get(12).is_true(),
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
        HopOutcome::Follow(r, crossed) => {
            let next = v8::String::new(scope, &r.url).unwrap();
            let bits = v8::Integer::new(scope, r.to_get as i32 | (r.drop_authorization as i32) << 1 | (crossed as i32) << 2 | (r.tainted_origin as i32) << 3);
            rv.set(v8::Array::new_with_elements(scope, &[next.into(), bits.into()]).into());
        }
        HopOutcome::Fail(message) => rv.set(v8::String::new(scope, &message).unwrap().into()),
    }
}
// Beacon "sendBeacon" step 6: whether a beacon whose body's Content-Type is `content_type` ('' none) is a CORS request —
// mode "cors" for a type that is no CORS-safelisted one, "no-cors" for any other or none.
pub(crate) fn beacon_cors(content_type: &[u8]) -> bool {
    !content_type.is_empty() && !cors_safelisted_request_header(b"content-type", content_type)
}
// __dom.beaconCors(contentType) -> `beacon_cors`.
fn beacon_cors_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let content_type = byte_string(scope, args.get(0));
    rv.set_bool(beacon_cors(&content_type));
}
// __dom.requestBodyHeader(name) -> whether it is a request-body-header name.
fn request_body_header_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = byte_string(scope, args.get(0));
    rv.set_bool(request_body_header(&name));
}
// __dom.fetchRoute(url, flags, here) -> `fetch_route`.
fn fetch_route_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (url, here) = (args.get(0).to_rust_string_lossy(scope), args.get(2).to_rust_string_lossy(scope));
    let flags = args.get(1).uint32_value(scope).unwrap_or(0);
    rv.set_uint32(fetch_route(&url, flags, &here));
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
// The value of the header `name` (lowercase) among a response's headers as the host gives them — an object keyed by
// name, in any case, a list of values joined with ", " — or None for none.
pub(crate) fn response_header(scope: &mut v8::PinScope<'_, '_>, headers: v8::Local<'_, v8::Object>, name: &str) -> Option<String> {
    let [value] = response_headers(scope, headers, [name]);
    value
}
// …and those of several `names`, in one pass over the headers.
pub(crate) fn response_headers<const N: usize>(scope: &mut v8::PinScope<'_, '_>, headers: v8::Local<'_, v8::Object>, names: [&str; N]) -> [Option<String>; N] {
    let mut out = [const { None }; N];
    let Some(keys) = headers.get_own_property_names(scope, Default::default()) else { return out };
    for i in 0..keys.length() {
        let Some(key) = keys.get_index(scope, i) else { continue };
        let name = key.to_rust_string_lossy(scope);
        let Some(at) = names.iter().position(|n| name.eq_ignore_ascii_case(n)) else { continue };
        if out[at].is_some() {
            continue;
        }
        let Some(value) = headers.get(scope, key).filter(|v| !v.is_null_or_undefined()) else { continue };
        out[at] = Some(match v8::Local::<v8::Array>::try_from(value) {
            Ok(list) => (0..list.length()).filter_map(|j| list.get_index(scope, j)).map(|v| v.to_rust_string_lossy(scope)).collect::<Vec<_>>().join(", "),
            Err(_) => value.to_rust_string_lossy(scope),
        });
    }
    out
}
// __dom.responseHeader(headers, name) -> `response_header`, null for none.
fn response_header_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Ok(headers) = v8::Local::<v8::Object>::try_from(args.get(0)) else { return };
    let name = args.get(1).to_rust_string_lossy(scope);
    if let Some(text) = response_header(scope, headers, &name).and_then(|t| v8::String::new(scope, &t)) {
        rv.set(text.into());
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
pub(crate) fn ruby_bytes(s: magnus::RString) -> Vec<u8> {
    // SAFETY: copied at once, before anything could run Ruby code that moves or frees it.
    unsafe { s.as_slice() }.to_vec()
}
pub(crate) fn redirect_to_get_for_ruby(status: u32, method: magnus::RString) -> bool {
    redirect_to_get(status, &ruby_bytes(method))
}
pub(crate) fn service_worker_response_allowed_for_ruby(mode: String, redirect: String, response_type: String, redirected: bool) -> bool {
    service_worker_response_allowed(&mode, &redirect, &response_type, redirected)
}
pub(crate) fn sw_subresource_usable_for_ruby(destination: String, mode: String, response_type: String, redirected: bool, status: u32) -> bool {
    sw_subresource_usable(&destination, &mode, &response_type, redirected, status)
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

    // A beacon is a CORS request for a body of a type no CORS-safelisted Content-Type is, a no-cors one for any other.
    #[test]
    fn beacon_cors_by_content_type() {
        assert!(!beacon_cors(b""));
        assert!(!beacon_cors(b"text/plain;charset=UTF-8"));
        assert!(!beacon_cors(b"application/x-www-form-urlencoded;charset=UTF-8"));
        assert!(!beacon_cors(b"multipart/form-data; boundary=x"));
        assert!(beacon_cors(b"application/json"));
    }

    // Under `nosniff` (its first value, any case) a script-like destination takes a JavaScript MIME type alone, a style
    // one `text/css`; any other, and any response without it, is not blocked.
    #[test]
    fn nosniff_blocks_a_script_or_style_response_of_another_type() {
        assert!(determine_nosniff("NoSniff, x") && !determine_nosniff("x, nosniff") && !determine_nosniff(""));
        assert!(blocked_by_nosniff("Style", "text/plain", "nosniff") && !blocked_by_nosniff("style", "text/css; charset=x", "nosniff"));
        assert!(blocked_by_nosniff("worker", "", "nosniff") && !blocked_by_nosniff("script", "text/javascript", "nosniff"));
        assert!(!blocked_by_nosniff("image", "text/plain", "nosniff") && !blocked_by_nosniff("style", "text/plain", ""));
    }

    #[test]
    fn a_subresource_uses_an_ok_or_opaque_answer_fetch_allows() {
        assert!(sw_subresource_usable("audio", "no-cors", "opaque", false, 0));
        assert!(!sw_subresource_usable("audio", "cors", "opaque", false, 0));
        assert!(!sw_subresource_usable("video", "no-cors", "basic", false, 404));
        assert!(sw_subresource_usable("audio", "no-cors", "basic", false, 304));
        assert!(sw_subresource_usable("image", "no-cors", "basic", false, 404));
        assert!(!sw_subresource_usable("image", "no-cors", "opaqueredirect", false, 0));
        assert!(!sw_subresource_usable("script", "no-cors", "basic", false, 304));
        // (…a classic script's opaque answer by the status it hides)
        assert!(sw_subresource_usable("script", "no-cors", "opaque", false, 200));
        assert!(!sw_subresource_usable("script", "no-cors", "opaque", false, 404));
        assert!(sw_subresource_usable("style", "no-cors", "opaque", false, 200) && !sw_subresource_usable("style", "no-cors", "opaque", false, 404));
        assert!(sw_subresource_usable("font", "no-cors", "opaque", false, 0));
    }

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
    fn a_request_goes_to_its_schemes_processor_else_an_http_one_to_the_worker_or_the_network() {
        let here = "http://a.test";
        assert_eq!(fetch_route("data:,x", FETCH_CONTROLLED | FETCH_SAME_ORIGIN, here), ROUTE_DATA);
        assert_eq!(fetch_route("blob:http://b.test/u", FETCH_CONTROLLED | FETCH_SAME_ORIGIN, here), ROUTE_BLOB);
        assert_eq!(fetch_route("http://a.test/x", 0, here), ROUTE_NETWORK);
        assert_eq!(fetch_route("http://a.test/x", FETCH_CONTROLLED, here), ROUTE_SERVICE_WORKER);
        assert_eq!(fetch_route("http://a.test/x", FETCH_CONTROLLED | FETCH_SYNC, here), ROUTE_NETWORK);
        assert_eq!(fetch_route("http://a.test/x", FETCH_CONTROLLED | FETCH_KEEPALIVE, here), ROUTE_SERVICE_WORKER);
        assert_eq!(fetch_route("http://a.test/x", FETCH_KEEPALIVE, here), ROUTE_KEEPALIVE);
        assert_eq!(fetch_route("http://a.test/x", FETCH_NAVIGATE | FETCH_CONTROLLED, here), ROUTE_NAVIGATION);
        assert_eq!(fetch_route("http://a.test/x", FETCH_NAVIGATE | FETCH_IN_WORKER | FETCH_CONTROLLED, here), ROUTE_SERVICE_WORKER);
        // (…a scheme Handle Fetch never sees, even controlled: the network's to refuse)
        assert_eq!(fetch_route("about:blank", FETCH_CONTROLLED, here), ROUTE_NETWORK);
        assert_eq!(fetch_route("x-custom:y", FETCH_CONTROLLED | FETCH_KEEPALIVE, here), ROUTE_NETWORK);
    }

    // Main fetch's `same-origin` branch refuses an http(s) URL of another origin than the client's document — an opaque
    // one's every URL — before any service worker; a scheme of its own processor is not judged.
    #[test]
    fn a_same_origin_request_refuses_an_http_url_of_another_origin() {
        let (here, flags) = ("http://a.test", FETCH_SAME_ORIGIN | FETCH_CONTROLLED);
        assert_eq!(fetch_route("http://a.test/x", flags, here), ROUTE_SERVICE_WORKER);
        assert_eq!(fetch_route("http://A.TEST:80/x", flags, here), ROUTE_SERVICE_WORKER);
        assert_eq!(fetch_route("http://b.test/x", flags, here), ROUTE_REFUSED);
        assert_eq!(fetch_route("https://a.test/x", FETCH_SAME_ORIGIN, here), ROUTE_REFUSED);
        assert_eq!(fetch_route("http://a.test/x", flags, "null"), ROUTE_REFUSED);
        assert_eq!(fetch_route("about:blank", flags, here), ROUTE_NETWORK);
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
            tainted: false,
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
            HopOutcome::Follow(Redirect { ref url, to_get: true, .. }, false) if url == "http://a.test/y"
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
        // (…a hop off another origin than the request's led on to yet another taints its origin, and a tainted one stays so)
        let away = InterceptedHop { url: "http://b.test/x", crossed: true, ..hop("follow", "no-cors", 1) };
        let to_c = response(302, Some("http://c.test/"), "http://b.test/x");
        assert!(matches!(intercepted_hop(&away, &to_c), HopOutcome::Follow(Redirect { tainted_origin: true, .. }, true)));
        assert!(matches!(intercepted_hop(&hop("follow", "no-cors", 0), &r302), HopOutcome::Follow(Redirect { tainted_origin: false, .. }, false)));
        let tainted = InterceptedHop { tainted: true, ..hop("follow", "no-cors", 0) };
        assert!(matches!(intercepted_hop(&tainted, &r302), HopOutcome::Follow(Redirect { tainted_origin: true, .. }, false)));
        let fragment = InterceptedHop { url: "http://a.test/x#f", ..hop("follow", "cors", 0) };
        assert!(matches!(intercepted_hop(&fragment, &r302), HopOutcome::Follow(ref next, _) if next.url == "http://a.test/y#f"));
        assert!(matches!(
            intercepted_hop(&fragment, &response(302, Some("y#g"), "http://a.test/x")),
            HopOutcome::Follow(ref next, _) if next.url == "http://a.test/y#g"
        ));
    }

    #[test]
    fn a_redirect_follows_the_fetch_steps() {
        let request = |current, cors_mode, tainting_cors, tainted_origin| Redirecting { method: b"GET", current, cors_mode, origin: "http://a.test", tainting_cors, tainted_origin };
        let follow = |r: &Redirecting<'_>, status, to: &str| match follow_redirect(r, status, r.current, Some(to)) {
            Redirected::Follow(step) => Some(step),
            _ => None,
        };
        let at_a = request("http://a.test/x", false, false, false);
        let post = Redirecting { method: b"POST", ..request("http://a.test/x", false, false, false) };
        let head = Redirecting { method: b"HEAD", ..request("http://a.test/x", false, false, false) };
        let steps = |r, status, to| follow(r, status, to).map(|s| (s.to_get, s.drop_authorization));
        assert_eq!(steps(&post, 302, "http://a.test/y"), Some((true, false)));
        assert_eq!(steps(&post, 307, "http://b.test/y"), Some((false, true)));
        assert_eq!(steps(&head, 303, "http://a.test/y"), Some((false, false)));
        assert_eq!(steps(&at_a, 301, "data:,x"), None);
        assert_eq!(steps(&at_a, 301, "http://a.test:6000/"), None);
        assert!(matches!(follow_redirect(&at_a, 301, "http://a.test/x", None), Redirected::Answer));
        assert!(matches!(follow_redirect(&at_a, 301, "http://a.test/x", Some("http://[x")), Redirected::Fail(_)));
        // (…credentials refused to a CORS request of another origin, or one whose response tainting is "cors")
        let cors = request("http://a.test/x", true, false, false);
        assert_eq!(steps(&cors, 301, "http://u:p@b.test/"), None);
        assert_eq!(steps(&cors, 301, "http://u:p@a.test/"), Some((false, false)));
        let tainting = request("http://b.test/x", true, true, false);
        assert_eq!(steps(&tainting, 301, "http://u:p@a.test/"), None);
        let at_b = request("http://b.test/x", false, false, false);
        assert_eq!(steps(&at_b, 301, "http://u:p@a.test/"), Some((false, true)));
        // (…the origin tainted by a redirect off another origin than the request's, whatever its mode; the first hop
        // away keeps it, and a tainted one stays so)
        let tainted = |r: &Redirecting<'_>, to| follow(r, 301, to).is_some_and(|s| s.tainted_origin);
        assert!(!tainted(&at_a, "http://b.test/"));
        assert!(tainted(&at_b, "http://c.test/"));
        assert!(tainted(&at_b, "http://a.test/"));
        assert!(!tainted(&at_b, "http://b.test/y"));
        let already = request("http://a.test/x", false, false, true);
        assert!(tainted(&already, "http://a.test/y"));
        let no_origin = Redirecting { origin: "", ..request("http://b.test/x", false, false, false) };
        assert!(!tainted(&no_origin, "http://c.test/"));
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
