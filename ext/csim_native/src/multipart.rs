// A `multipart/form-data` body parsed into its entries (Fetch "package data" for `formData()`, HTML's
// multipart/form-data parser): from the first delimiter — `--` and the boundary its `Content-Type` names — each part to
// the next: transport padding and a CRLF after the delimiter, header lines to a blank line, the body to the next CRLF
// and delimiter, until the close delimiter (`--` after it), which only padding and a CRLF (an epilogue) may follow. Every
// part names its field in its `Content-Disposition`; one with a `filename` is a file, of the type its `Content-Type`
// gives. Anything else is no such body.

// A part: its field's name, its filename (a file's), the type a file's part gives, and its body's bytes.
#[derive(Debug, PartialEq)]
pub(crate) struct Part {
    pub(crate) name: String,
    pub(crate) filename: Option<String>,
    pub(crate) content_type: String,
    pub(crate) value: Vec<u8>,
}

// The boundary a `Content-Type` of `multipart/form-data` names, as written (a boundary is case-sensitive).
pub(crate) fn boundary(content_type: &str) -> Option<String> {
    let mime = crate::mime::parse(content_type)?;
    if mime.essence != "multipart/form-data" {
        return None;
    }
    mime.parameters.into_iter().find(|(name, _)| name == "boundary").map(|(_, value)| value).filter(|b| !b.is_empty())
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from > haystack.len() {
        return None;
    }
    haystack[from..].windows(needle.len()).position(|w| w == needle).map(|i| i + from)
}

// The parts of `body` between delimiters of `boundary`, or none where it is no such body.
pub(crate) fn parse(body: &[u8], boundary: &str) -> Option<Vec<Part>> {
    let dash = [b"--", boundary.as_bytes()].concat();
    let padding = |at: &mut usize| {
        while matches!(body.get(*at), Some(b' ' | b'\t')) {
            *at += 1;
        }
    };
    let mut at = find(body, &dash, 0)? + dash.len();
    let mut parts = Vec::new();
    loop {
        if body[at..].starts_with(b"--") {
            // (…the close delimiter: nothing but padding, then a CRLF and an epilogue, may follow)
            at += 2;
            padding(&mut at);
            return (at >= body.len() || body[at..].starts_with(b"\r\n")).then_some(parts);
        }
        padding(&mut at);
        if !body[at..].starts_with(b"\r\n") {
            return None;
        }
        at += 2;
        let header_end = find(body, b"\r\n\r\n", at)?;
        let headers = &body[at..header_end];
        at = header_end + 4;
        let disposition = header(headers, "content-disposition")?;
        let name = parameter(&disposition, "name")?;
        let body_end = find(body, &[b"\r\n", dash.as_slice()].concat(), at)?;
        let value = body[at..body_end].to_vec();
        at = body_end + 2 + dash.len();
        let filename = parameter(&disposition, "filename");
        let content_type = if filename.is_some() { header(headers, "content-type").map(|t| t.trim().to_owned()).unwrap_or_default() } else { String::new() };
        parts.push(Part { name, filename, content_type, value });
    }
}

// The value of a part's header line `name` (ASCII case-insensitively), UTF-8 decoded.
fn header(headers: &[u8], name: &str) -> Option<String> {
    headers.split(|&b| b == b'\n').map(|line| line.strip_suffix(b"\r").unwrap_or(line)).find_map(|line| {
        let colon = line.iter().position(|&b| b == b':')?;
        line[..colon].eq_ignore_ascii_case(name.as_bytes()).then(|| String::from_utf8_lossy(&line[colon + 1..]).trim_start().to_owned())
    })
}
// …and a `Content-Disposition`'s `name="…"` parameter — one whose name begins a word (`filename` holds no `name`).
fn parameter(disposition: &str, name: &str) -> Option<String> {
    let lower = disposition.to_ascii_lowercase();
    let key = format!("{name}=\"");
    let mut from = 0;
    while let Some(i) = lower[from..].find(&key).map(|i| i + from) {
        let word_start = i == 0 || !lower.as_bytes()[i - 1].is_ascii_alphanumeric() && lower.as_bytes()[i - 1] != b'_';
        let start = i + key.len();
        if word_start {
            let end = disposition[start..].find('"')? + start;
            return Some(disposition[start..end].to_owned());
        }
        from = start;
    }
    None
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "multipartFormData", multipart_op, context_id);
}
// __dom.multipartFormData(bytes, contentType) -> [name, filename (null for a field), type, value, …] — a field's value
// UTF-8 decoded (a BOM kept), a file's a byte string — or null where the body is no `multipart/form-data` of the type's
// boundary. `bytes` a byte string.
fn multipart_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(text) = v8::Local::<v8::String>::try_from(args.get(0)) else { return rv.set_null() };
    let mut body = vec![0u8; text.length()];
    text.write_one_byte_v2(scope, 0, &mut body, v8::WriteFlags::empty());
    let content_type = args.get(1).to_rust_string_lossy(scope);
    let Some(parts) = boundary(&content_type).and_then(|b| parse(&body, &b)) else { return rv.set_null() };
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(parts.len() * 4);
    for p in parts {
        items.push(string(scope, &p.name));
        items.push(match &p.filename {
            Some(f) => string(scope, f),
            None => v8::null(scope).into(),
        });
        items.push(string(scope, &p.content_type));
        items.push(if p.filename.is_some() {
            v8::String::new_from_one_byte(scope, &p.value, v8::NewStringType::Normal).map_or_else(|| v8::undefined(scope).into(), Into::into)
        } else {
            string(scope, &String::from_utf8_lossy(&p.value))
        });
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

fn string<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_parse_and_bad_bodies_do_not() {
        let body = b"preamble\r\n--AaB\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\n1\r\n--AaB  \r\nContent-Disposition: form-data; name=\"f\"; filename=\"x.txt\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--AaB--\r\nepilogue";
        let parts = parse(body, "AaB").expect("a body");
        assert_eq!(parts.len(), 2);
        assert_eq!((parts[0].name.as_str(), parts[0].value.as_slice()), ("a", &b"1"[..]));
        assert_eq!((parts[1].filename.as_deref(), parts[1].content_type.as_str()), (Some("x.txt"), "text/plain"));
        assert!(parse(b"--AaB\r\nContent-Disposition: form-data\r\n\r\n1\r\n--AaB--", "AaB").is_none());
        assert!(parse(b"--AaB--trailing", "AaB").is_none());
        assert!(parse(b"--aab--", "AaB").is_none());
        assert_eq!(boundary("Multipart/Form-Data; boundary=\"AaB\""), Some("AaB".into()));
        assert_eq!(boundary("text/plain; boundary=x"), None);
    }
}
