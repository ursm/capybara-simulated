// URLs, parsed and set by the URL Standard's own algorithms: Ada (`ada-url`, Node.js's URL parser, which passes the
// standard's tests — Servo's `url` crate fails ~300 of them, file URLs and opaque paths mostly). The page side keeps a
// URL as the parts these return, read without a crossing, and crosses only to parse one or to set one of its parts.
//
// A URL's parts, in this order (`parts`): href, protocol, username, password, host, hostname, port, pathname, search,
// hash, origin — the interface's attributes.

use ada_url::Url;

use crate::dom::register;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "urlParse", url_parse, context_id);
    register(scope, ns, "urlSet", url_set, context_id);
}

// A URL's parts, in `parts`' order.
fn texts(url: &Url) -> [String; 11] {
    [
        url.href(),
        url.protocol(),
        url.username(),
        url.password(),
        url.host(),
        url.hostname(),
        url.port(),
        url.pathname(),
        url.search(),
        url.hash(),
        &url.origin(),
    ]
    .map(str::to_owned)
}

// The parts of the URL `input` parses to (against `base`, given one) — or nil where it does not parse: for the host,
// which resolves the URL a `visit` names, and reads the current one, as the page would (`|` kept in a query, a space in
// a path `%20`, …).
pub(crate) fn parts_for_ruby(input: String, base: Option<String>) -> Option<Vec<String>> {
    Url::parse(input.as_str(), base.as_deref()).ok().map(|url| texts(&url).into())
}

fn parts<'s>(scope: &mut v8::PinScope<'s, '_>, url: &Url) -> v8::Local<'s, v8::Array> {
    let items: Vec<v8::Local<v8::Value>> = texts(url)
        .iter()
        .map(|t| v8::String::new(scope, t).map_or_else(|| v8::undefined(scope).into(), Into::into))
        .collect();
    v8::Array::new_with_elements(scope, &items)
}

// The string a page's value is as a USVString: a lone surrogate is U+FFFD (WebIDL), which the lossy conversion does.
fn usv(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> String {
    value.to_rust_string_lossy(scope)
}

// __dom.urlParse(input, base, encoding) -> parts, or null when it does not parse (nor its base, given one). `encoding`
// (a label, null for UTF-8) is the document's: HTML's "encoding-parse a URL" percent-encodes the QUERY in it.
fn url_parse(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let input = usv(scope, args.get(0));
    let base = (!args.get(1).is_null_or_undefined()).then(|| usv(scope, args.get(1)));
    let Ok(mut url) = Url::parse(input.as_str(), base.as_deref()) else { return rv.set_null() };
    if !args.get(2).is_null_or_undefined() {
        let label = usv(scope, args.get(2));
        if let Some(encoding) = encoding_rs::Encoding::for_label(label.as_bytes()).map(|e| e.output_encoding()) {
            if encoding != encoding_rs::UTF_8 {
                encode_query_in(&mut url, &input, encoding);
            }
        }
    }
    let parts = parts(scope, &url);
    rv.set(parts.into());
}

// The URL's query as the input wrote it, percent-encoded in `encoding` (the parser did it in UTF-8). A query is what
// follows the input's first `?` — no state before the query takes one — up to its `#`; a URL whose query came from its
// base (the input has none of its own) keeps it as it is. Only a special URL's, and not a `ws:` / `wss:` one's: the
// query state takes UTF-8 for the others whatever the document's encoding (`mailto:…?subject=é` stays `%C3%A9`).
fn encode_query_in(url: &mut Url, input: &str, encoding: &'static encoding_rs::Encoding) {
    if !url.has_search() || !matches!(url.protocol(), "http:" | "https:" | "ftp:" | "file:") {
        return;
    }
    // (…the input as the parser reads it: no leading or trailing C0 control or space, no tab or newline anywhere)
    let input: String =
        input.trim_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let Some(start) = input.find('?') else { return };
    if input[..start].contains('#') {
        return;
    }
    let query = input[start + 1..].split('#').next().unwrap_or_default();
    if query.is_ascii() && encoding.is_ascii_compatible() {
        return;
    }
    let mut encoded = String::from("?");
    for byte in encode(encoding, query) {
        // (…the special-query percent-encode set: C0 controls, space, `"`, `#`, `<`, `>`, `'`, and above `~`)
        let escape = !(0x21..=0x7E).contains(&byte) || matches!(byte, b'"' | b'#' | b'<' | b'>' | b'\'');
        if escape {
            encoded.push_str(&format!("%{byte:02X}"));
        } else {
            encoded.push(byte as char);
        }
    }
    url.set_search(Some(&encoded));
}

// `text` in `encoding`, a character it cannot encode written `&#N;` — and that already percent-encoded, as the URL
// Standard's "percent-encode after encoding" has it: "%26%23", its number in decimal, "%3B" (`%` is in no
// percent-encode set, so the bytes pass through as they are).
fn encode(encoding: &'static encoding_rs::Encoding, text: &str) -> Vec<u8> {
    let mut encoder = encoding.new_encoder();
    let mut out = Vec::with_capacity(text.len() + 16);
    let mut rest = text;
    loop {
        let mut buf = [0u8; 256];
        let (result, read, written) = encoder.encode_from_utf8_without_replacement(rest, &mut buf, true);
        out.extend_from_slice(&buf[..written]);
        rest = &rest[read..];
        match result {
            encoding_rs::EncoderResult::InputEmpty => break,
            encoding_rs::EncoderResult::OutputFull => {}
            encoding_rs::EncoderResult::Unmappable(c) => {
                // (…ISO-2022-JP's encoder errors on SO, SI and ESC "with U+FFFD", the Encoding Standard has it)
                let n = if encoding == encoding_rs::ISO_2022_JP && matches!(c, '\u{E}' | '\u{F}' | '\u{1B}') { 0xFFFD } else { u32::from(c) };
                out.extend_from_slice(format!("%26%23{n}%3B").as_bytes());
            }
        }
    }
    out
}

// __dom.urlSet(href, part, value) -> the URL's parts once `part` is set to `value`, as the interface's setter sets it
// (a value it rejects leaves the URL as it was); null when `href` itself does not parse, or — for `href` — `value`
// does not. `part` "query" sets the query to the already-serialized `value` (null: none), the URLSearchParams update
// steps.
fn url_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let href = usv(scope, args.get(0));
    let Ok(mut url) = Url::parse(href.as_str(), None) else { return rv.set_null() };
    let part = args.get(1).to_rust_string_lossy(scope);
    let raw = args.get(2);
    let value = usv(scope, raw);
    let value = Some(value.as_str());
    match part.as_str() {
        "href" => {
            if url.set_href(value.unwrap_or_default()).is_err() {
                return rv.set_null();
            }
        }
        "protocol" => drop(url.set_protocol(value.unwrap_or_default())),
        "username" => drop(url.set_username(value)),
        "password" => drop(url.set_password(value)),
        "host" => drop(url.set_host(value)),
        "hostname" => drop(url.set_hostname(value)),
        "port" => drop(url.set_port(value)),
        "pathname" => drop(url.set_pathname(value)),
        "search" => url.set_search(value),
        "hash" => url.set_hash(value),
        "query" => {
            // (…prefixed with the `?` the setter takes off, so a query that starts with one keeps it)
            let query = (!raw.is_null_or_undefined()).then(|| format!("?{}", value.unwrap_or_default()));
            url.set_search(query.as_deref());
        }
        _ => {}
    }
    let parts = parts(scope, &url);
    rv.set(parts.into());
}
