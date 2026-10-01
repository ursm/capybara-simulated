// A document's bytes, decoded as HTML's "encoding sniffing algorithm" decides (HTML §13.2.3.2): a BOM, else the
// transport layer's charset (the Content-Type), else what the document declares — an HTML document a `<meta charset>`
// in its first 1024 bytes ("prescan a byte stream to determine its encoding"), an XML one its XML declaration's
// `encoding` — else, for an HTML document in a frame, its PARENT's encoding, else the default: windows-1252 for an HTML
// document, UTF-8 for an XML one. Decoded by encoding_rs, every encoding the Encoding Standard has, as the document's
// realm loads it (`__csimLoadDocument`), where its parent is at hand.

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1252, X_USER_DEFINED};

use crate::dom::register;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "decodeDocument", decode_document_op, context_id);
}

// __dom.decodeDocument(bytes, contentType, parentEncoding, xhr) -> [text, encoding name]; `parentEncoding` null where
// the document inherits none (no parent document, or one of another origin); `xhr` an XHR document response.
fn decode_document_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(args.get(0)) else { return };
    let mut bytes = vec![0u8; view.byte_length()];
    view.copy_contents(&mut bytes);
    let content_type = args.get(1).to_rust_string_lossy(scope);
    let parent = args.get(2);
    let parent = (!parent.is_null_or_undefined()).then(|| parent.to_rust_string_lossy(scope)).and_then(|label| Encoding::for_label(label.as_bytes()));
    let reading = if args.get(3).is_true() { Reading::Xhr } else { Reading::Navigation(parent) };
    let (text, used, _) = sniff(&bytes, &content_type, reading).decode(&bytes);
    let (Some(text), Some(name)) = (v8::String::new(scope, &text), v8::String::new(scope, used.name())) else { return };
    let pair: [v8::Local<v8::Value>; 2] = [text.into(), name.into()];
    let pair = v8::Array::new_with_elements(scope, &pair);
    rv.set(pair.into());
}

// An XML MIME type (MIME Sniffing §4.6): `text/xml`, `application/xml`, or any `+xml` subtype.
fn is_xml(content_type: &str) -> bool {
    let essence = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    essence.ends_with("+xml") || essence == "text/xml" || essence == "application/xml"
}

// Which document is being read: a navigation's — a frame's with its PARENT's encoding to inherit, if same-origin —
// or an XHR "document response", which prescans no further than the first 1024 bytes, inherits nothing, and is UTF-8
// where nothing says otherwise.
#[derive(Clone, Copy)]
enum Reading {
    Navigation(Option<&'static Encoding>),
    Xhr,
}

fn sniff(bytes: &[u8], content_type: &str, reading: Reading) -> &'static Encoding {
    // (…a BOM decides it, whatever else is declared — `decode` takes it off, and follows it)
    if let Some((encoding, _)) = Encoding::for_bom(bytes) {
        return encoding;
    }
    if let Some(encoding) = charset_of_content_type(content_type) {
        return encoding;
    }
    let head = &bytes[..bytes.len().min(1024)];
    if is_xml(content_type) {
        return xml_declaration(head).unwrap_or(UTF_8);
    }
    let Reading::Navigation(parent) = reading else { return prescan(head, false).unwrap_or(UTF_8) };
    // (…the first `<meta>` the PARSER meets, anywhere: its "change the encoding" while the confidence is tentative —
    // whatever the prescan of the first 1024 bytes found, which a `<meta>` in a script's text can fool — in `<head>` or
    // `<body>` alike (Chrome does both, Firefox only the head); met before the document is parsed rather than by
    // navigating again, its scripts not run twice. Text inside a raw-text element is no tag.)
    if let Some(encoding) = prescan(bytes, true).or_else(|| prescan(head, false)) {
        return encoding;
    }
    // (…a frame's parent's encoding, inherited — unless it is UTF-16, which only a BOM ever selects)
    parent.filter(|e| *e != UTF_16BE && *e != UTF_16LE).unwrap_or(WINDOWS_1252)
}

// The `charset` parameter of a Content-Type (MIME Sniffing's parameter syntax, case-insensitive name, an optional
// quoted value).
fn charset_of_content_type(content_type: &str) -> Option<&'static Encoding> {
    content_type.split(';').skip(1).find_map(|param| {
        let (name, value) = param.split_once('=')?;
        if !name.trim().eq_ignore_ascii_case("charset") {
            return None;
        }
        let value = value.trim();
        let value = value.strip_prefix('"').and_then(|v| v.split('"').next()).unwrap_or(value);
        Encoding::for_label(value.as_bytes())
    })
}

// HTML's "get an encoding" for what a `<meta>` declares: UTF-16 is UTF-8 there (the bytes were read as ASCII to find
// it), and x-user-defined is windows-1252.
fn meta_encoding(label: &[u8]) -> Option<&'static Encoding> {
    let encoding = Encoding::for_label(label)?;
    Some(if encoding == UTF_16BE || encoding == UTF_16LE {
        UTF_8
    } else if encoding == X_USER_DEFINED {
        WINDOWS_1252
    } else {
        encoding
    })
}

// The elements whose content the tokenizer reads as text up to their end tag (RAWTEXT, RCDATA, script data).
const RAW_TEXT: [&[u8]; 10] =
    [b"script", b"style", b"textarea", b"title", b"xmp", b"iframe", b"noembed", b"noframes", b"noscript", b"plaintext"];

fn is_space(b: u8) -> bool {
    matches!(b, b'\t' | b'\n' | b'\x0C' | b'\r' | b' ')
}

// HTML "prescan a byte stream to determine its encoding" — the steps' numbering kept in the comments. `raw_text`: skip
// the contents of a raw-text element (`<script>`, `<style>`, …) to its end tag, as the tokenizer does — what the
// prescan of the first 1024 bytes does not, as the spec writes it.
fn prescan(input: &[u8], raw_text: bool) -> Option<&'static Encoding> {
    let n = input.len();
    let mut pos = 0;
    let starts = |pos: usize, s: &[u8]| input.len() >= pos + s.len() && input[pos..pos + s.len()].eq_ignore_ascii_case(s);
    while pos < n {
        if input[pos..].starts_with(b"<!--") {
            // (a comment: to its `-->`, which may share the `<!--`'s dashes)
            match input[pos + 2..].windows(3).position(|w| w == b"-->") {
                Some(i) => pos += 2 + i + 3,
                None => return None,
            }
            continue;
        }
        if starts(pos, b"<meta") && pos + 5 < n && (is_space(input[pos + 5]) || input[pos + 5] == b'/') {
            pos += 5;
            let mut seen = std::collections::HashSet::new();
            let mut got_pragma = false;
            let mut need_pragma: Option<bool> = None;
            let mut charset: Option<&'static Encoding> = None;
            while let Some((name, value, next)) = attribute(input, pos) {
                pos = next;
                if !seen.insert(name.clone()) {
                    continue;
                }
                match name.as_slice() {
                    b"http-equiv" => got_pragma |= value.eq_ignore_ascii_case(b"content-type"),
                    b"content" => {
                        if charset.is_none() {
                            if let Some(e) = charset_of_content(&value) {
                                charset = Some(e);
                                need_pragma = Some(true);
                            }
                        }
                    }
                    b"charset" => {
                        charset = meta_encoding(&value);
                        need_pragma = Some(false);
                    }
                    _ => {}
                }
            }
            match (need_pragma, charset) {
                (Some(true), Some(e)) if got_pragma => return Some(e),
                (Some(false), Some(e)) => return Some(e),
                _ => {}
            }
            continue;
        }
        if input[pos] == b'<' && pos + 1 < n && (input[pos + 1].is_ascii_alphabetic() || (input[pos + 1] == b'/' && pos + 2 < n && input[pos + 2].is_ascii_alphabetic())) {
            // (a start or end tag: its name, then its attributes, each skipped)
            let end_tag = input[pos + 1] == b'/';
            pos += if end_tag { 2 } else { 1 };
            let name_at = pos;
            while pos < n && !is_space(input[pos]) && input[pos] != b'>' {
                pos += 1;
            }
            // (…`<title/>` is a `title` start tag all the same: HTML has no self-closing raw-text element)
            let name = input[name_at..pos].strip_suffix(b"/").unwrap_or(&input[name_at..pos]).to_ascii_lowercase();
            while let Some((_, _, next)) = attribute(input, pos) {
                pos = next;
            }
            if raw_text && !end_tag && RAW_TEXT.contains(&name.as_slice()) {
                let close = [b"</".as_slice(), &name].concat();
                match input[pos..].windows(close.len()).position(|w| w.eq_ignore_ascii_case(&close)) {
                    Some(i) => pos += i,
                    None => return None,
                }
            }
            continue;
        }
        if input[pos..].starts_with(b"<!") || input[pos..].starts_with(b"</") || input[pos..].starts_with(b"<?") {
            match input[pos..].iter().position(|&b| b == b'>') {
                Some(i) => pos += i + 1,
                None => return None,
            }
            continue;
        }
        pos += 1;
    }
    None
}

// HTML "get an attribute" over the prescan's input from `pos`: (lowercased name, value, the position after it), or None
// at a `>` or the input's end.
fn attribute(input: &[u8], mut pos: usize) -> Option<(Vec<u8>, Vec<u8>, usize)> {
    let n = input.len();
    while pos < n && (is_space(input[pos]) || input[pos] == b'/') {
        pos += 1;
    }
    if pos >= n || input[pos] == b'>' {
        return None;
    }
    let mut name = Vec::new();
    let mut value = Vec::new();
    // (the name)
    loop {
        if pos >= n {
            return None;
        }
        let b = input[pos];
        if b == b'=' && !name.is_empty() {
            pos += 1;
            break;
        }
        if is_space(b) {
            // (…spaces, then `=` or the attribute is name-only)
            while pos < n && is_space(input[pos]) {
                pos += 1;
            }
            if pos < n && input[pos] == b'=' {
                pos += 1;
                break;
            }
            return Some((name, value, pos));
        }
        if b == b'/' || b == b'>' {
            return Some((name, value, pos));
        }
        name.push(b.to_ascii_lowercase());
        pos += 1;
    }
    while pos < n && is_space(input[pos]) {
        pos += 1;
    }
    if pos >= n {
        return None;
    }
    // (the value: quoted, to its quote; unquoted, to a space or `>`)
    let quote = input[pos];
    if quote == b'"' || quote == b'\'' {
        pos += 1;
        loop {
            if pos >= n {
                return None;
            }
            if input[pos] == quote {
                return Some((name, value, pos + 1));
            }
            value.push(input[pos].to_ascii_lowercase());
            pos += 1;
        }
    }
    if quote == b'>' {
        return Some((name, value, pos));
    }
    while pos < n && !is_space(input[pos]) && input[pos] != b'>' {
        value.push(input[pos].to_ascii_lowercase());
        pos += 1;
    }
    if pos >= n {
        return None;
    }
    Some((name, value, pos))
}

// The `encoding` an XML declaration (`<?xml version="1.0" encoding="…"?>`) names, read as `<meta charset>` is (a UTF-16
// label without a BOM is UTF-8: the declaration was just read as ASCII).
fn xml_declaration(head: &[u8]) -> Option<&'static Encoding> {
    let decl = &head[..head.iter().position(|&b| b == b'>')?];
    if !decl.starts_with(b"<?xml") || !decl.ends_with(b"?") {
        return None;
    }
    let at = decl.windows(8).position(|w| w == b"encoding")? + 8;
    let rest = decl[at..].trim_ascii_start().strip_prefix(b"=")?.trim_ascii_start();
    let (&quote, rest) = rest.split_first()?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    meta_encoding(&rest[..rest.iter().position(|&b| b == quote)?])
}

// HTML "extract a character encoding from a meta element": the `charset=` a `content` value holds.
fn charset_of_content(content: &[u8]) -> Option<&'static Encoding> {
    let mut pos = 0;
    let n = content.len();
    loop {
        let i = content[pos..].windows(7).position(|w| w.eq_ignore_ascii_case(b"charset"))?;
        pos += i + 7;
        while pos < n && is_space(content[pos]) {
            pos += 1;
        }
        if pos < n && content[pos] == b'=' {
            pos += 1;
            break;
        }
    }
    while pos < n && is_space(content[pos]) {
        pos += 1;
    }
    if pos >= n {
        return None;
    }
    let value = match content[pos] {
        q @ (b'"' | b'\'') => {
            let rest = &content[pos + 1..];
            &rest[..rest.iter().position(|&b| b == q)?]
        }
        _ => {
            let rest = &content[pos..];
            &rest[..rest.iter().position(|&b| is_space(b) || b == b';').unwrap_or(rest.len())]
        }
    };
    meta_encoding(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prescans_a_meta_charset() {
        assert_eq!(prescan(b"<!DOCTYPE html><meta charset=shift_jis>", false).map(Encoding::name), Some("Shift_JIS"));
        assert_eq!(prescan(b"<meta http-equiv=Content-Type content='text/html; charset=euc-kr'>", false).map(Encoding::name), Some("EUC-KR"));
        // (…a content charset without the pragma declares nothing)
        assert_eq!(prescan(b"<meta content='text/html; charset=euc-kr'>", false), None);
        // (…nor one inside a comment, or a `data-charset`)
        assert_eq!(prescan(b"<!-- <meta charset=big5> --><p data-charset=gbk>", false), None);
        assert_eq!(prescan(b"<meta charset=utf-16le>", false).map(Encoding::name), Some("UTF-8"));
    }

    #[test]
    fn sniffs_bom_transport_meta_default() {
        assert_eq!(sniff(b"\xEF\xBB\xBF<meta charset=big5>", "text/html; charset=euc-jp", Reading::Navigation(None)).name(), "UTF-8");
        assert_eq!(sniff(b"<meta charset=big5>", "text/html; charset=\"EUC-JP\"", Reading::Navigation(None)).name(), "EUC-JP");
        assert_eq!(sniff(b"<meta charset=big5>", "text/html", Reading::Navigation(None)).name(), "Big5");
        assert_eq!(sniff(b"<p>x", "", Reading::Navigation(None)).name(), "windows-1252");
        assert_eq!(sniff(b"<p>x", "text/html", Reading::Navigation(Some(encoding_rs::SHIFT_JIS))).name(), "Shift_JIS");
        assert_eq!(sniff(b"<p>x", "text/html", Reading::Navigation(Some(UTF_16LE))).name(), "windows-1252");
        // (…an XHR document response is UTF-8 by default and reads only the first 1024 bytes)
        assert_eq!(sniff(b"<p>x", "text/html", Reading::Xhr).name(), "UTF-8");
        assert_eq!(sniff(b"<meta charset=euc-jp>", "text/html", Reading::Xhr).name(), "EUC-JP");
        // (…a `<meta>` past the first 1024 bytes changes the encoding still, but not one inside a raw-text element)
        let late = [b"<style>".as_slice(), &[b' '; 1100], b"</style><meta charset=shift_jis>"].concat();
        assert_eq!(sniff(&late, "text/html", Reading::Navigation(None)).name(), "Shift_JIS");
        let scripted = [b"<p>".as_slice(), &[b' '; 1100], b"<script>'<meta charset=big5>'</script>"].concat();
        assert_eq!(sniff(&scripted, "text/html", Reading::Navigation(None)).name(), "windows-1252");
        // (…and the parser's meet beats the prescan's: a script's `<meta>` text read first, a real one past it)
        let fooled = [b"<script>'<meta charset=big5>'</script>".as_slice(), &[b' '; 1100], b"<meta charset=shift_jis>"].concat();
        assert_eq!(sniff(&fooled, "text/html", Reading::Navigation(None)).name(), "Shift_JIS");
        // (…a parent's encoding comes below the document's own)
        assert_eq!(sniff(b"<meta charset=big5>", "text/html", Reading::Navigation(Some(encoding_rs::SHIFT_JIS))).name(), "Big5");
    }

    #[test]
    fn reads_an_xml_declaration() {
        assert_eq!(sniff(b"<x/>", "application/xml", Reading::Navigation(None)).name(), "UTF-8");
        assert_eq!(sniff(b"<?xml version='1.0' encoding='Shift_JIS'?><x/>", "image/svg+xml", Reading::Navigation(None)).name(), "Shift_JIS");
        assert_eq!(sniff(b"<?xml version=\"1.0\" encoding = \"euc-jp\" ?><x/>", "text/xml", Reading::Navigation(None)).name(), "EUC-JP");
        // (…an XML document inherits nothing, and an HTML one reads no XML declaration)
        assert_eq!(sniff(b"<x/>", "text/xml", Reading::Navigation(Some(encoding_rs::SHIFT_JIS))).name(), "UTF-8");
        assert_eq!(sniff(b"<?xml version='1.0' encoding='Shift_JIS'?>", "text/html", Reading::Navigation(None)).name(), "windows-1252");
    }
}
