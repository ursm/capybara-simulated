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
// `text/vtt`, a JavaScript or a JSON MIME type; an HTML one for any other a document is made of (`makes_document`).
// (OPEN: a media document for an image, video or audio type is not modelled; such a response is HTML-parsed.)
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
// How a navigation's response loads (HTML "load a document"): by its computed MIME type (MIME Sniffing §7.1, `computed`)
// — a document of an HTML, XML, JavaScript or JSON MIME type, `text/css`, `text/plain`, `text/vtt`,
// `multipart/x-mixed-replace`, or a supported image, audio or video type (a media document: the image types the decoder
// reads, image_decode.rs, and the media types `canPlayType` answers, media.rs); a PDF (`application/pdf`, `text/pdf`)
// a document for inline content that doesn't have a DOM, its PDF viewer's (`Load::Inline`: "PDF viewer supported" is
// implementation-defined, and Chrome and Firefox both view PDFs — `navigator.pdfViewerEnabled` true); any other handed
// off as a download (`Load::Download`). Chrome and Firefox download
// `application/octet-stream` and `application/zip` alike (measured 2026-11-01), and Chrome an unsupported `image/x-foo`
// and `text/csv` as HTML says; it renders an unknown `text/*` and downloads `application/atom+xml`, departures of its own
// from HTML's explicit rule.
// …whether the document a type `essence` (a computed one) makes is one.
pub(crate) fn makes_document(essence: &str) -> bool {
    essence == "text/html"
        || document_kind(essence) != DOCUMENT_HTML
        || essence == "multipart/x-mixed-replace"
        || SUPPORTED_IMAGES.contains(&essence)
        || ((matches!(essence.split_once('/').map(|(k, _)| k), Some("audio" | "video")) || essence == "application/ogg") && !crate::media::can_play_type(essence).is_empty())
}
const SUPPORTED_IMAGES: [&str; 9] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "image/avif",
    "image/svg+xml",
];

// Whether the computed MIME type of a response whose `Content-Type` is `content_type` (None: it has none) needs its
// body: one of no MIME type — none supplied, an empty or an invalid one — or `unknown/unknown`, `application/unknown`,
// `*/*` (MIME Sniffing §7.1 step 1), or one the check-for-apache-bug flag is set for: a `text/plain` an old Apache sent
// for anything, its bytes exactly one of four (§5.1) — whose body tells text from binary (`computed`).
pub(crate) fn needs_body(content_type: Option<&str>) -> bool {
    // (…the common `text/html`, with its parameters or none, answered before a parse)
    if content_type.is_some_and(|t| t.get(..9).is_some_and(|s| s.eq_ignore_ascii_case("text/html")) && matches!(t.as_bytes().get(9), None | Some(b';' | b' ' | b'\t'))) {
        return false;
    }
    apache_bug(content_type) || supplied(content_type).is_none()
}
fn apache_bug(content_type: Option<&str>) -> bool {
    matches!(content_type, Some("text/plain" | "text/plain; charset=ISO-8859-1" | "text/plain; charset=iso-8859-1" | "text/plain; charset=UTF-8"))
}
// …the supplied MIME type's essence, None where it is none to go by: none given, none that parses, an unknown one.
fn supplied(content_type: Option<&str>) -> Option<String> {
    content_type.and_then(extract).map(|m| m.essence).filter(|e| !matches!(e.as_str(), "unknown/unknown" | "application/unknown" | "*/*"))
}
// MIME Sniffing §7.1 "determine the computed MIME type" of a navigation's response, its essence — `head` its resource
// header (its first 1445 bytes; the sniff-scriptable flag set, the no-sniff flag not modelled): a supplied type that is
// none to go by sniffed by "the rules for identifying an unknown MIME type" (§7.1), one the Apache bug is suspected of by
// "the rules for distinguishing if a resource is text or binary" (§7.2), any other as it is.
pub(crate) fn computed(content_type: Option<&str>, head: &[u8]) -> String {
    let head = &head[..head.len().min(1445)];
    match supplied(content_type) {
        Some(essence) if !apache_bug(content_type) => essence,
        Some(essence) => text_or_binary(head).unwrap_or(essence),
        None => unknown(head),
    }
}
// …what a navigation's response loads as, by its computed type: a document of that type (`makes_document`), a PDF
// viewer's inline content, or a download.
#[derive(Debug, PartialEq)]
pub(crate) enum Load {
    Document(String),
    Inline,
    Download,
}
pub(crate) fn load(content_type: Option<&str>, head: &[u8]) -> Load {
    let essence = if needs_body(content_type) { computed(content_type, head) } else { supplied(content_type).unwrap_or_else(|| "text/html".to_owned()) };
    if matches!(essence.as_str(), "application/pdf" | "text/pdf") {
        Load::Inline
    } else if makes_document(&essence) {
        Load::Document(essence)
    } else {
        Load::Download
    }
}
// A binary data byte (§3).
fn binary(b: u8) -> bool {
    matches!(b, 0x00..=0x08 | 0x0B | 0x0E..=0x1A | 0x1C..=0x1F)
}
fn bom(head: &[u8]) -> bool {
    head.starts_with(&[0xFE, 0xFF]) || head.starts_with(&[0xFF, 0xFE]) || head.starts_with(&[0xEF, 0xBB, 0xBF])
}
// §7.2: text where it has a BOM or no binary data byte — the supplied `text/plain` then (None) — else
// `application/octet-stream`, never a type its signature would be: the rules are not to yield a scriptable type from a
// resource its server called text (Chrome sniffs an image of one; the spec's text is explicit).
fn text_or_binary(head: &[u8]) -> Option<String> {
    if bom(head) || !head.iter().any(|&b| binary(b)) {
        return None;
    }
    Some("application/octet-stream".to_owned())
}
// §7.1 the rules for identifying an unknown MIME type, the sniff-scriptable flag set: an HTML or XML signature after
// leading white space, PDF, PostScript, a BOM's text, an image, media or archive signature — else `text/plain` where it
// has no binary data byte, `application/octet-stream` where it has.
fn unknown(head: &[u8]) -> String {
    let at = head.iter().position(|b| !matches!(b, 0x09 | 0x0A | 0x0C | 0x0D | 0x20)).unwrap_or(head.len());
    let rest = &head[at..];
    let tag_ends = |n: usize| matches!(rest.get(n), Some(b' ' | b'>'));
    const HTML: [&[u8]; 17] = [
        b"<!DOCTYPE HTML", b"<HTML", b"<HEAD", b"<SCRIPT", b"<IFRAME", b"<H1", b"<DIV", b"<FONT", b"<TABLE", b"<A", b"<STYLE",
        b"<TITLE", b"<B", b"<BODY", b"<BR", b"<P", b"<!--",
    ];
    if HTML.iter().any(|p| rest.len() > p.len() && rest[..p.len()].eq_ignore_ascii_case(p) && tag_ends(p.len())) {
        return "text/html".to_owned();
    }
    let found = if rest.starts_with(b"<?xml") {
        Some("text/xml")
    } else if head.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else if head.starts_with(b"%!PS-Adobe-") {
        Some("application/postscript")
    } else if bom(head) {
        Some("text/plain")
    } else {
        signature(head)
    };
    found.map_or_else(|| if head.iter().any(|&b| binary(b)) { "application/octet-stream" } else { "text/plain" }.to_owned(), str::to_owned)
}
// The image (§6.1), media (§6.2) and archive (§6.3) type a resource header's signature is. The media ones by their plain
// signatures alone, simplified on purpose: MP4 by an `ftyp` box whose major brand begins `mp4` (§6.2.1 walks every
// compatible brand), WebM by its EBML magic (§6.2.2 parses the DocType element), MP3 by an ID3 tag (§6.2.3 also matches a
// bare frame header) — none of them a type a navigation here makes a document of the bytes of.
fn signature(head: &[u8]) -> Option<&'static str> {
    let riff = |kind: &[u8]| head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == kind;
    Some(match head {
        [0, 0, 1, 0, ..] => "image/x-icon",
        [0, 0, 2, 0, ..] => "image/x-icon",
        [b'B', b'M', ..] => "image/bmp",
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => "image/gif",
        _ if riff(b"WEBP") && head.get(12..14) == Some(b"VP") => "image/webp",
        [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, ..] => "image/png",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [0x1A, 0x45, 0xDF, 0xA3, ..] => "video/webm",
        [b'.', b's', b'n', b'd', ..] => "audio/basic",
        [b'F', b'O', b'R', b'M', _, _, _, _, b'A', b'I', b'F', b'F', ..] => "audio/aiff",
        [b'I', b'D', b'3', ..] => "audio/mpeg",
        [b'O', b'g', b'g', b'S', 0, ..] => "application/ogg",
        [b'M', b'T', b'h', b'd', 0, 0, 0, 6, ..] => "audio/midi",
        _ if riff(b"AVI ") => "video/avi",
        _ if riff(b"WAVE") => "audio/wave",
        [_, _, _, _, b'f', b't', b'y', b'p', ..] if head.len() >= 12 && head.get(8..11) == Some(b"mp4") => "video/mp4",
        [0x1F, 0x8B, 0x08, ..] => "application/x-gzip",
        [b'P', b'K', 0x03, 0x04, ..] => "application/zip",
        [b'R', b'a', b'r', b' ', 0x1A, 0x07, 0x00, ..] => "application/x-rar-compressed",
        _ => return None,
    })
}
// Native.navigation_load(content type, head) -> `load`: what a response of `Content-Type` `content_type` (nil none)
// whose body begins with `head` loads as — ['document', its type], ['inline'] or ['download'].
pub(crate) fn load_for_ruby(content_type: Option<String>, head: magnus::RString) -> (&'static str, Option<String>) {
    // SAFETY: read at once, before anything could run Ruby code that moves or frees it.
    let head = unsafe { head.as_slice() };
    match load(content_type.as_deref(), head) {
        Load::Document(essence) => ("document", Some(essence)),
        Load::Inline => ("inline", None),
        Load::Download => ("download", None),
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

    #[test]
    fn a_navigation_response_of_no_document_type_downloads() {
        let doc = |t: Option<&str>, head: &[u8]| match load(t, head) {
            Load::Document(essence) => Some(essence),
            _ => None,
        };
        assert_eq!(load(Some("application/pdf"), b""), Load::Inline);
        assert_eq!(load(None, b"%PDF-1.4"), Load::Inline);
        assert_eq!(load(Some("text/plain"), b"\x89PNG\r\n\x1a\n\x00"), Load::Download);
        for t in ["text/html; charset=utf-8", "TEXT/HTML", "text/plain;charset=utf-8", "application/xhtml+xml", "image/png", "video/mp4", "application/json"] {
            assert!(doc(Some(t), b"").is_some(), "{t}");
        }
        for t in ["application/octet-stream", "application/zip", "text/csv", "image/x-foo", "audio/x-nothing"] {
            assert_eq!(doc(Some(t), b""), None, "{t}");
        }
        // (…none supplied, an invalid one, an unknown one: sniffed — HTML, text, binary)
        assert_eq!(doc(None, b"  <!doctype html><p>").as_deref(), Some("text/html"));
        assert_eq!(doc(Some("garbage"), b"<P>x").as_deref(), Some("text/html"));
        assert_eq!(doc(Some(""), b"plain words").as_deref(), Some("text/plain"));
        assert_eq!(doc(Some("unknown/unknown"), b"\x89PNG\r\n\x1a\n").as_deref(), Some("image/png"));
        assert_eq!(doc(Some("*/*"), b"PK\x03\x04"), None);
        assert_eq!(doc(None, b"\x00\x01binary"), None);
        // (…an Apache-bug `text/plain` binary — a download — or text; another spelling as it is)
        assert_eq!(doc(Some("text/plain"), b"\x00\x01binary"), None);
        assert_eq!(doc(Some("text/plain; charset=UTF-8"), b"text").as_deref(), Some("text/plain"));
        assert_eq!(doc(Some("text/plain; charset=utf-8"), b"\x00\x01binary").as_deref(), Some("text/plain"));
        assert!(!needs_body(Some("text/html; charset=utf-8")) && needs_body(None) && needs_body(Some("text/plain")));
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
