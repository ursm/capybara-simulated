// A `multipart/form-data` body parsed into its entries (Fetch "package data" for `formData()`, HTML's
// multipart/form-data parser): from the first delimiter — `--` and the boundary its `Content-Type` names — each part to
// the next: transport padding and a CRLF after the delimiter, header lines to a blank line, the body to the next CRLF
// and delimiter, until the close delimiter (`--` after it), which only padding and a CRLF (an epilogue) may follow. Every
// part is a `Content-Disposition: form-data` naming its field (`name`, quoted or a token); one with a `filename` is a
// file, of the type its `Content-Type` gives (RFC 7578: `text/plain` where it gives none). Anything else is no such body
// (where Chrome and Firefox agree).

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
        // (…a part with no header lines none of a field's)
        let header_end = if body[at..].starts_with(b"\r\n") { at } else { find(body, b"\r\n\r\n", at)? };
        let headers = &body[at..header_end];
        at = header_end + if header_end == at { 2 } else { 4 };
        let disposition = disposition(&header(headers, "content-disposition")?)?;
        // (…a parameter given twice, its last value — as Chrome and Firefox both take)
        let name = disposition.iter().rfind(|(k, _)| k == "name")?.1.clone();
        let body_end = find(body, &[b"\r\n", dash.as_slice()].concat(), at)?;
        let value = body[at..body_end].to_vec();
        at = body_end + 2 + dash.len();
        let filename = disposition.iter().rfind(|(k, _)| k == "filename").map(|(_, v)| v.clone());
        let content_type = match filename {
            Some(_) => header(headers, "content-type").map(|t| t.trim().to_owned()).unwrap_or_else(|| "text/plain".to_owned()),
            None => String::new(),
        };
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
// …and a `Content-Disposition` of type `form-data`: its parameters, each name lowercased, each value a token or a quoted
// string's — a `\` taking the character after it as it is (Chrome, and RFC 2183's quoted-string) — and none where it is
// of another type, or a parameter is no `name=value` (anything but `;` after a quoted string, as Chrome refuses).
fn disposition(value: &str) -> Option<Vec<(String, String)>> {
    let mut chars = value.chars().peekable();
    let kind: String = chars.by_ref().take_while(|&c| c != ';').collect();
    if !kind.trim().eq_ignore_ascii_case("form-data") {
        return None;
    }
    let mut params = Vec::new();
    loop {
        while chars.next_if(|c| matches!(c, ' ' | '\t' | ';')).is_some() {}
        if chars.peek().is_none() {
            return Some(params);
        }
        let key: String = chars.by_ref().take_while(|&c| c != '=').collect();
        let key = key.trim();
        if key.is_empty() || key.contains(';') {
            return None;
        }
        while chars.next_if(|c| matches!(c, ' ' | '\t')).is_some() {}
        let mut value = String::new();
        if chars.next_if_eq(&'"').is_some() {
            loop {
                match chars.next()? {
                    '"' => break,
                    '\\' => value.push(chars.next()?),
                    c => value.push(c),
                }
            }
            while chars.next_if(|c| matches!(c, ' ' | '\t')).is_some() {}
            if chars.peek().is_some_and(|&c| c != ';') {
                return None;
            }
        } else {
            value = chars.by_ref().take_while(|&c| c != ';').collect::<String>().trim_end().to_owned();
        }
        params.push((key.to_ascii_lowercase(), value));
    }
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
        // (…as Chrome and Firefox both read them: a token name, a file part's default type, no header lines, no
        // `form-data`)
        let parts = parse(b"--B\r\nContent-Disposition: form-data; name=a; filename=\"f\"\r\n\r\nx\r\n--B--", "B").expect("a body");
        assert_eq!((parts[0].name.as_str(), parts[0].content_type.as_str()), ("a", "text/plain"));
        assert!(parse(b"--B\r\n\r\nv\r\n--B\r\nContent-Disposition: form-data; name=\"b\"\r\n\r\n2\r\n--B--", "B").is_none());
        assert!(parse(b"--B\r\nContent-Disposition: attachment; name=\"a\"\r\n\r\n1\r\n--B--", "B").is_none());
        // (…a quoted value's escapes taken, the last of a parameter given twice, nothing but `;` after a quoted value)
        assert_eq!(disposition(r#"form-data; name="a\"b"; filename="c;d""#), Some(vec![("name".into(), "a\"b".into()), ("filename".into(), "c;d".into())]));
        assert_eq!(disposition(r#"form-data; name="a"; NAME=b"#).map(|d| d.into_iter().rfind(|(k, _)| k == "name").map(|(_, v)| v)), Some(Some("b".into())));
        assert_eq!(disposition(r#"form-data; name="a"x; filename="f""#), None);
        assert_eq!(disposition(r#"form-data; foo; name="a""#), None);
        assert_eq!(boundary("text/plain; boundary=x"), None);
    }
}
