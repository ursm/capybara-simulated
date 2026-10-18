// MIME types (WHATWG MIME Sniffing §4): parsing a string into a type, a subtype and its parameters, and serializing one
// back — what `Content-Type` handling everywhere asks (XHR's charset fix, `overrideMimeType`, a `data:` URL's type, a
// `Response`'s `blob()` type).

// A parsed MIME type: its type and subtype, ASCII-lowercased, and its parameters in order, each name lowercased and
// each value as written (the first of a name kept).
#[derive(Debug, PartialEq)]
pub(crate) struct MimeType {
    pub(crate) essence: String,
    pub(crate) parameters: Vec<(String, String)>,
}

// An HTTP token code point (Fetch).
fn token(c: char) -> bool {
    c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c)
}
// An HTTP quoted-string token code point: a tab, or U+0020 to U+007E, or U+0080 to U+00FF.
fn quoted_token(c: char) -> bool {
    c == '\t' || ('\u{20}'..='\u{7e}').contains(&c) || ('\u{80}'..='\u{ff}').contains(&c)
}
fn http_ws(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r' | ' ')
}

// "Parse a MIME type": None where it is no MIME type.
pub(crate) fn parse(input: &str) -> Option<MimeType> {
    let input = input.trim_matches(http_ws);
    let (kind, rest) = input.split_once('/')?;
    if kind.is_empty() || !kind.chars().all(token) {
        return None;
    }
    let (subtype, mut rest) = match rest.find(';') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, ""),
    };
    let subtype = subtype.trim_end_matches(http_ws);
    if subtype.is_empty() || !subtype.chars().all(token) {
        return None;
    }
    let mut parameters: Vec<(String, String)> = Vec::new();
    while let Some(after) = rest.strip_prefix(';') {
        rest = after.trim_start_matches(http_ws);
        let name_end = rest.find([';', '=']).unwrap_or(rest.len());
        let name = rest[..name_end].to_ascii_lowercase();
        rest = &rest[name_end..];
        if rest.starts_with(';') {
            continue;
        }
        let Some(after) = rest.strip_prefix('=') else { break };
        rest = after;
        let value = if rest.starts_with('"') {
            let (value, after) = collect_quoted(rest);
            rest = after;
            // (…and whatever follows the closing quote up to the next `;` is ignored)
            rest = rest.find(';').map_or("", |at| &rest[at..]);
            value
        } else {
            let end = rest.find(';').unwrap_or(rest.len());
            let value = rest[..end].trim_end_matches(http_ws).to_owned();
            rest = &rest[end..];
            if value.is_empty() {
                continue;
            }
            value
        };
        let valid = !name.is_empty() && name.chars().all(token) && value.chars().all(quoted_token);
        if valid && !parameters.iter().any(|(n, _)| *n == name) {
            parameters.push((name, value));
        }
    }
    Some(MimeType { essence: format!("{}/{}", kind.to_ascii_lowercase(), subtype.to_ascii_lowercase()), parameters })
}

// "Collect an HTTP quoted string" with the extract-value flag: the value inside the quotes, backslash escapes undone,
// and what follows the string.
fn collect_quoted(input: &str) -> (String, &str) {
    let mut value = String::new();
    let mut chars = input.char_indices().skip(1);
    while let Some((_, c)) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some((_, escaped)) => value.push(escaped),
                None => {
                    value.push('\\');
                    return (value, "");
                }
            },
            '"' => {
                let at = chars.next().map_or(input.len(), |(i, _)| i);
                return (value, &input[at..]);
            }
            c => value.push(c),
        }
    }
    (value, "")
}

// "Serialize a MIME type": the essence, then each parameter, its value quoted (and `"` / `\` escaped) where it is
// empty or holds anything but token code points.
pub(crate) fn serialize(mime: &MimeType) -> String {
    let mut out = mime.essence.clone();
    for (name, value) in &mime.parameters {
        out.push(';');
        out.push_str(name);
        out.push('=');
        if value.is_empty() || !value.chars().all(token) {
            out.push('"');
            for c in value.chars() {
                if c == '"' || c == '\\' {
                    out.push('\\');
                }
                out.push(c);
            }
            out.push('"');
        } else {
            out.push_str(value);
        }
    }
    out
}

// Fetch's "extract a MIME type" from a `Content-Type` header's combined value: the last of its comma-separated values
// that parses (and is not `*/*`), a charset an earlier value of the same essence gave it carried on where it names none.
// None where no value parses.
pub(crate) fn extract(header: &str) -> Option<MimeType> {
    let mut charset: Option<String> = None;
    let mut essence: Option<String> = None;
    let mut mime: Option<MimeType> = None;
    for value in crate::headers::decode_split(header) {
        let Some(mut parsed) = parse(&value).filter(|m| m.essence != "*/*") else { continue };
        let own = parsed.parameters.iter().find(|(n, _)| n == "charset").map(|(_, v)| v.clone());
        if essence.as_deref() != Some(parsed.essence.as_str()) {
            charset = own;
            essence = Some(parsed.essence.clone());
        } else if let (None, Some(carried)) = (own, &charset) {
            parsed.parameters.push(("charset".to_owned(), carried.clone()));
        }
        mime = Some(parsed);
    }
    mime
}
// …for the host: the essence of the MIME type a `Content-Type` header's value gives, or nil.
pub(crate) fn content_type_essence_for_ruby(header: String) -> Option<String> {
    extract(&header).map(|m| m.essence)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "mimeParse", mime_parse, context_id);
    crate::dom::register(scope, ns, "mimeSerialize", mime_serialize, context_id);
    crate::dom::register(scope, ns, "mimeExtract", mime_extract, context_id);
    crate::dom::register(scope, ns, "mimeIsXml", mime_is_xml, context_id);
    crate::dom::register(scope, ns, "documentKind", document_kind_op, context_id);
    crate::dom::register(scope, ns, "mimeCharsetUtf8", mime_charset_utf8, context_id);
}

// An XML MIME type (MIME Sniffing §4.6): `text/xml`, `application/xml`, or any `+xml` subtype — of a type or its
// essence, parameters and all.
pub(crate) fn is_xml(content_type: &str) -> bool {
    let essence = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    essence.ends_with("+xml") || essence == "text/xml" || essence == "application/xml"
}
// A JSON MIME type's essence (MIME Sniffing §4.6): `application/json`, `text/json`, or any `+json` subtype.
pub(crate) fn is_json(essence: &str) -> bool {
    essence == "application/json" || essence == "text/json" || essence.split_once('/').is_some_and(|(_, s)| s.ends_with("+json"))
}

// What document a navigation response of the MIME type `essence` loads as (HTML "loading a document"): an XML one for an
// XML MIME type; a text one — the text in a `<pre>`, "convert to a preformatted document" — for `text/css`, `text/plain`,
// `text/vtt`, a JavaScript or a JSON MIME type; an HTML one for any other. (OPEN: a media document for an image, video or
// audio type and a download for a type no document is made of are not modelled; such a response is HTML-parsed.)
pub(crate) const DOCUMENT_HTML: u32 = 0;
pub(crate) const DOCUMENT_XML: u32 = 1;
pub(crate) const DOCUMENT_TEXT: u32 = 2;
pub(crate) fn document_kind(essence: &str) -> u32 {
    if is_xml(essence) {
        DOCUMENT_XML
    } else if matches!(essence, "text/css" | "text/plain" | "text/vtt") || crate::script::is_javascript_mime(essence) || is_json(essence) {
        DOCUMENT_TEXT
    } else {
        DOCUMENT_HTML
    }
}
// __dom.documentKind(essence) -> `document_kind`.
fn document_kind_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let essence = args.get(0).to_rust_string_lossy(scope);
    rv.set_uint32(document_kind(&essence));
}

// __dom.mimeIsXml(contentType) -> whether it is an XML MIME type (`is_xml`).
fn mime_is_xml(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let ct = args.get(0).to_rust_string_lossy(scope);
    rv.set_bool(is_xml(&ct));
}

// __dom.mimeCharsetUtf8(value) -> a request's `Content-Type` re-serialized with its `charset` UTF-8 (XHR's send(): a
// body encoded as UTF-8 says so) — null where it stays as it is: no MIME type, no `charset`, a UTF-8 one already.
fn mime_charset_utf8(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let text = args.get(0).to_rust_string_lossy(scope);
    let Some(mut mime) = parse(&text) else { return };
    let Some(charset) = mime.parameters.iter_mut().find(|(n, _)| n == "charset") else { return };
    if charset.1.eq_ignore_ascii_case("utf-8") {
        return;
    }
    charset.1 = "UTF-8".to_owned();
    if let Some(s) = v8::String::new(scope, &serialize(&mime)) {
        rv.set(s.into());
    }
}

// __dom.mimeExtract(headerValue) -> the MIME type a `Content-Type` value gives (`extract`), serialized — or null.
fn mime_extract(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let header = args.get(0).to_rust_string_lossy(scope);
    match extract(&header).and_then(|m| v8::String::new(scope, &serialize(&m))) {
        Some(s) => rv.set(s.into()),
        None => rv.set_null(),
    }
}

// __dom.mimeParse(text) -> `[essence, name, value, …]` (`parse`), or null where it is no MIME type.
fn mime_parse(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    let Some(mime) = parse(&text) else { return rv.set_null() };
    let strings = std::iter::once(&mime.essence).chain(mime.parameters.iter().flat_map(|(n, v)| [n, v]));
    let items: Vec<v8::Local<v8::Value>> = strings.filter_map(|s| v8::String::new(scope, s)).map(Into::into).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.mimeSerialize(essence, [name, value, …]) -> the MIME type serialized (`serialize`).
fn mime_serialize(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let essence = args.get(0).to_rust_string_lossy(scope);
    let mut parameters = Vec::new();
    if let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(1)) {
        for k in (0..list.length()).step_by(2) {
            let name = list.get_index(scope, k).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default();
            let value = list.get_index(scope, k + 1).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default();
            parameters.push((name, value));
        }
    }
    let text = serialize(&MimeType { essence, parameters });
    if let Some(s) = v8::String::new(scope, &text) {
        rv.set(s.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_navigation_response_loads_by_its_type() {
        assert_eq!(document_kind("text/html"), DOCUMENT_HTML);
        assert_eq!(document_kind("image/svg+xml"), DOCUMENT_XML);
        assert_eq!(document_kind("text/xml"), DOCUMENT_XML);
        for text in ["text/plain", "text/css", "text/vtt", "text/javascript", "application/json", "application/ld+json"] {
            assert_eq!(document_kind(text), DOCUMENT_TEXT, "{text}");
        }
        assert_eq!(document_kind("application/jsonx"), DOCUMENT_HTML);
        assert_eq!(document_kind(""), DOCUMENT_HTML);
    }

    fn round_trip(input: &str) -> Option<String> {
        parse(input).map(|m| serialize(&m))
    }

    #[test]
    fn parses_and_serializes() {
        assert_eq!(round_trip("Text/HTML;Charset=\"utf-8\""), Some("text/html;charset=utf-8".to_owned()));
        assert_eq!(round_trip(" text/plain ; a=1;a=2;b=\"x y\""), Some("text/plain;a=1;b=\"x y\"".to_owned()));
        assert_eq!(round_trip("text/plain;a=\"\\\"q\\\\\""), Some("text/plain;a=\"\\\"q\\\\\"".to_owned()));
        assert_eq!(round_trip("text/plain;a=\"x\" junk;b=2"), Some("text/plain;a=x;b=2".to_owned()));
        assert_eq!(round_trip("text/plain;a="), Some("text/plain".to_owned()));
        assert_eq!(round_trip("text/plain;=x;c"), Some("text/plain".to_owned()));
        assert_eq!(round_trip("text/"), None);
        assert_eq!(round_trip("/html"), None);
        assert_eq!(round_trip("te xt/html"), None);
    }

    #[test]
    fn extracts_from_a_header() {
        let extracted = |v: &str| extract(v).map(|m| serialize(&m));
        assert_eq!(extracted("TEXT/HTML;CHARSET=GBK"), Some("text/html;charset=GBK".to_owned()));
        assert_eq!(extracted("text/html;charset=gbk;charset=windows-1255"), Some("text/html;charset=gbk".to_owned()));
        assert_eq!(extracted("text/plain;charset=gbk, text/plain"), Some("text/plain;charset=gbk".to_owned()));
        assert_eq!(extracted("text/plain;charset=gbk, text/html"), Some("text/html".to_owned()));
        assert_eq!(extracted("text/html;charset=\"a,b\", */*"), Some("text/html;charset=\"a,b\"".to_owned()));
        assert_eq!(extracted("bogus, */*"), None);
    }
}
