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
// "Normalize a method": one of DELETE, GET, HEAD, OPTIONS, POST, PUT matched ASCII case-insensitively, byte-uppercased;
// None for any other, which keeps its case (`patch` stays `patch`).
pub(crate) fn normalized_method(method: &[u8]) -> Option<&'static str> {
    ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"].into_iter().find(|m| m.as_bytes().eq_ignore_ascii_case(method))
}
// "CORS-safelisted method".
pub(crate) fn cors_safelisted_method(method: &[u8]) -> bool {
    ["GET", "HEAD", "POST"].iter().any(|m| m.as_bytes() == method)
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
// "Simple range header value": `bytes=` a start and an end, either one omitted but not both.
fn simple_range(value: &[u8]) -> bool {
    let Some(rest) = value.strip_prefix(b"bytes=") else { return false };
    let Some(dash) = rest.iter().position(|&b| b == b'-') else { return false };
    let (start, end) = (&rest[..dash], &rest[dash + 1..]);
    let digits = |s: &[u8]| s.iter().all(u8::is_ascii_digit);
    if !digits(start) || !digits(end) || (start.is_empty() && end.is_empty()) {
        return false;
    }
    let number = |s: &[u8]| std::str::from_utf8(s).ok().and_then(|s| s.parse::<u64>().ok());
    match (number(start), number(end)) {
        (Some(a), Some(b)) => a <= b,
        _ => true,
    }
}
// "CORS-safelisted response-header name" (with no `Access-Control-Expose-Headers` naming more).
pub(crate) fn cors_safelisted_response_header(name: &[u8]) -> bool {
    ["cache-control", "content-language", "content-length", "content-type", "expires", "last-modified", "pragma"]
        .iter()
        .any(|h| h.as_bytes().eq_ignore_ascii_case(name))
}

// ── For the bindings ──
pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "badPort", bad_port_op, context_id);
    crate::dom::register(scope, ns, "forbiddenMethod", forbidden_method_op, context_id);
    crate::dom::register(scope, ns, "headerRule", header_rule_op, context_id);
    crate::dom::register(scope, ns, "httpToken", http_token_op, context_id);
    crate::dom::register(scope, ns, "normalizedMethod", normalized_method_op, context_id);
}
fn units(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Vec<u8> {
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
// __dom.forbiddenMethod(method) -> whether it is a forbidden method.
fn forbidden_method_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let method = units(scope, args.get(0));
    rv.set_bool(forbidden_method(&method));
}
// __dom.httpToken(s) -> whether `s` is an HTTP token (`is_token`).
fn http_token_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let s = units(scope, args.get(0));
    rv.set_bool(is_token(&s));
}
// __dom.normalizedMethod(method) -> `normalized_method`: the uppercase method, or null for one that keeps its case.
fn normalized_method_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let method = units(scope, args.get(0));
    match normalized_method(&method).and_then(|m| v8::String::new(scope, m)) {
        Some(m) => rv.set(m.into()),
        None => rv.set_null(),
    }
}
// The header rules `headerRule` answers.
const FORBIDDEN_REQUEST: u32 = 0;
const FORBIDDEN_RESPONSE: u32 = 1;
const NO_CORS_SAFELISTED: u32 = 2;
// __dom.headerRule(rule, name, value) -> whether the header is a forbidden request-header (`FORBIDDEN_REQUEST`), a
// forbidden response-header name (`FORBIDDEN_RESPONSE`), or a no-CORS-safelisted request-header (`NO_CORS_SAFELISTED`).
fn header_rule_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let rule = args.get(0).uint32_value(scope).unwrap_or(u32::MAX);
    let name = units(scope, args.get(1));
    let value = units(scope, args.get(2));
    rv.set_bool(match rule {
        FORBIDDEN_REQUEST => forbidden_request_header(&name, &value),
        FORBIDDEN_RESPONSE => forbidden_response_header(&name),
        NO_CORS_SAFELISTED => no_cors_safelisted_request_header(&name, &value),
        _ => false,
    });
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
        assert!(cors_safelisted_request_header(b"range", b"bytes=-5"));
        assert!(!cors_safelisted_request_header(b"range", b"bytes=5-1"));
        assert!(!no_cors_safelisted_request_header(b"range", b"bytes=0-"));
        assert!(bad_port(6000) && !bad_port(80) && !bad_port(70000));
        assert!(!forbidden_request_header(b"x-method-override", b"\nTRACE"));
    }
}
