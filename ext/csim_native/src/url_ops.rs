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
    register(scope, ns, "urlHasOpaquePath", url_has_opaque_path, context_id);
    register(scope, ns, "urlIsFragmentNavigation", url_is_fragment_navigation, context_id);
    register(scope, ns, "urlCanRewrite", url_can_rewrite, context_id);
    register(scope, ns, "postMessageTarget", post_message_target_op, context_id);
    register(scope, ns, "postMessageReaches", post_message_reaches_op, context_id);
    register(scope, ns, "urlencodedParse", urlencoded_parse, context_id);
    register(scope, ns, "urlencodedSerialize", urlencoded_serialize, context_id);
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

// Whether a URL has an opaque path (URL Standard): one with no host whose path is no list — a pathname not starting
// with "/" (`mailto:x`, `foo:`), where `foo://` has an empty host and `foo:/x` a list.
fn has_opaque_path(url: &Url) -> bool {
    !url.has_hostname() && !url.pathname().starts_with('/')
}
// __dom.urlHasOpaquePath(href) -> `has_opaque_path` (false for no URL).
fn url_has_opaque_path(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let href = usv(scope, args.get(0));
    rv.set_bool(Url::parse(href.as_str(), None).is_ok_and(|u| has_opaque_path(&u)));
}

// HTML "navigate" (step "navigate to a fragment"): whether a navigation to `url` from a document at `current` is one to a
// fragment of it — `url` has a fragment (an empty one too: `#`) and equals `current` but for their fragments. Not one
// without a fragment: `/a#x` → `/a` loads the document again, as does assigning a fragmentless URL its own.
pub(crate) fn is_fragment_navigation(current: &str, url: &str) -> bool {
    let (Ok(mut current), Ok(mut url)) = (Url::parse(current, None), Url::parse(url, None)) else { return false };
    if !url.has_hash() {
        return false;
    }
    current.set_hash(None);
    url.set_hash(None);
    current.href() == url.href()
}
fn url_is_fragment_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (current, url) = (usv(scope, args.get(0)), usv(scope, args.get(1)));
    rv.set_bool(is_fragment_navigation(&current, &url));
}
// …for the host.
pub(crate) fn is_fragment_navigation_for_ruby(current: String, url: String) -> bool {
    is_fragment_navigation(&current, &url)
}

// HTML "can have its URL rewritten": whether a document at `current` may have its URL replaced by `target` — by
// pushState / replaceState — the two alike in scheme, username, password, host and port; an HTTP(S) one in nothing
// more, a file: one in its path too, any other in its path and query as well (only its fragment may change).
pub(crate) fn can_rewrite(current: &str, target: &str) -> bool {
    let (Ok(current), Ok(target)) = (Url::parse(current, None), Url::parse(target, None)) else { return false };
    let same = |f: fn(&Url) -> &str| f(&current) == f(&target);
    if !(same(Url::protocol) && same(Url::username) && same(Url::password) && same(Url::host)) {
        return false;
    }
    match target.protocol() {
        "http:" | "https:" => true,
        "file:" => same(Url::pathname),
        _ => same(Url::pathname) && same(Url::search),
    }
}
fn url_can_rewrite(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (current, target) = (usv(scope, args.get(0)), usv(scope, args.get(1)));
    rv.set_bool(can_rewrite(&current, &target));
}

// HTML "window post message steps": the target origin a `targetOrigin` names — "*" and "/" themselves, else the origin
// of the absolute URL it is (serialized: "null" for an opaque one) — None where it is no URL (a SyntaxError).
fn post_message_target(arg: &str) -> Option<String> {
    if arg == "*" || arg == "/" {
        return Some(arg.to_owned());
    }
    Url::parse(arg, None).ok().map(|u| u.origin())
}
// …and whether a message so targeted reaches a window of origin `target` from one of `sender` — origins as their keys:
// a tuple origin its serialization, an opaque one a token of its own, which the windows that share it (one created
// inheriting it) share: "*" any, "/" the sender's own origin, any other the origin it names — never an opaque one,
// which a URL names anew (a `data:` URL's).
fn post_message_reaches(arg: &str, sender: &str, target: &str) -> Option<bool> {
    let wanted = post_message_target(arg)?;
    Some(match wanted.as_str() {
        "*" => true,
        "/" => sender == target,
        origin => origin != "null" && origin == target,
    })
}
// __dom.postMessageTarget(targetOrigin) -> `post_message_target`, or null.
fn post_message_target_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let arg = usv(scope, args.get(0));
    match post_message_target(&arg).and_then(|t| v8::String::new(scope, &t)) {
        Some(t) => rv.set(t.into()),
        None => rv.set_null(),
    }
}
// __dom.postMessageReaches(targetOrigin, senderOriginKey, targetOriginKey) -> 1 it reaches, 0 it does not, -1 the target
// origin is no URL (`post_message_reaches`).
fn post_message_reaches_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (arg, sender, target) = (usv(scope, args.get(0)), usv(scope, args.get(1)), usv(scope, args.get(2)));
    rv.set_int32(post_message_reaches(&arg, &sender, &target).map_or(-1, i32::from));
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

// __dom.urlencodedParse(input) -> [name, value, name, value, …]: the application/x-www-form-urlencoded parser's tuples
// (URL Standard §5.1) of `input`'s UTF-8 bytes — `+` a space, each `%XX` its byte, the bytes UTF-8 decoded without BOM,
// an invalid sequence U+FFFD.
fn urlencoded_parse(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let input = usv(scope, args.get(0));
    let items: Vec<v8::Local<v8::Value>> = url::form_urlencoded::parse(input.as_bytes())
        .flat_map(|(name, value)| [name, value])
        .map(|text| v8::String::new(scope, &text).map_or_else(|| v8::undefined(scope).into(), Into::into))
        .collect();
    let array = v8::Array::new_with_elements(scope, &items);
    rv.set(array.into());
}

// __dom.urlencodedSerialize(list) -> the application/x-www-form-urlencoded serializer's string (URL Standard §5.2) of the
// tuples in `list`, flat as the parser answers them: each name and value percent-encoded in UTF-8 with the
// application/x-www-form-urlencoded set, a space `+`.
fn urlencoded_serialize(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(0)) else { return };
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for i in (0..list.length()).step_by(2) {
        let [name, value] = [i, i + 1].map(|k| list.get_index(scope, k).map(|v| usv(scope, v)).unwrap_or_default());
        serializer.append_pair(&name, &value);
    }
    let text = serializer.finish();
    if let Some(string) = v8::String::new(scope, &text) {
        rv.set(string.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_a_url_a_document_may_rewrite_its_own_to() {
        assert!(can_rewrite("https://a.test/p?q#f", "https://a.test/other?z"));
        assert!(!can_rewrite("https://a.test/p", "https://b.test/p"));
        assert!(!can_rewrite("https://a.test/p", "http://a.test/p"));
        assert!(!can_rewrite("https://a.test/p", "https://a.test:8443/p"));
        assert!(!can_rewrite("https://a.test/p", "https://u@a.test/p"));
        assert!(can_rewrite("file:///x/a", "file:///x/a?q"));
        assert!(!can_rewrite("file:///x/a", "file:///x/b"));
        assert!(can_rewrite("about:blank", "about:blank#x"));
        assert!(!can_rewrite("about:blank", "about:blank?q"));
        assert!(!can_rewrite("data:text/html,a", "data:text/html,b"));
    }

    #[test]
    fn tells_a_navigation_to_a_fragment() {
        let at = "https://a.test/p?q#x";
        assert!(is_fragment_navigation(at, "https://a.test/p?q#y"));
        assert!(is_fragment_navigation(at, "https://a.test/p?q#x"));
        assert!(is_fragment_navigation(at, "https://a.test/p?q#"));
        assert!(!is_fragment_navigation(at, "https://a.test/p?q"));
        assert!(!is_fragment_navigation(at, "https://a.test/p?r#x"));
        assert!(!is_fragment_navigation("https://a.test/p", "https://a.test/p"));
        assert!(is_fragment_navigation("https://a.test/p", "https://a.test/p#z"));
    }


    #[test]
    fn a_posted_message_reaches_its_target_origin() {
        assert_eq!(post_message_reaches("*", "opaque:realm1", "https://a"), Some(true));
        assert_eq!(post_message_reaches("/", "https://a", "https://a"), Some(true));
        assert_eq!(post_message_reaches("/", "opaque:realm1", "opaque:realm2"), Some(false));
        assert_eq!(post_message_reaches("/", "opaque:realm1", "opaque:realm1"), Some(true));
        assert_eq!(post_message_reaches("https://a/x?y", "https://b", "https://a"), Some(true));
        assert_eq!(post_message_reaches("data:,x", "opaque:realm1", "opaque:realm1"), Some(false));
        assert_eq!(post_message_reaches("nope", "https://a", "https://a"), None);
    }
}
