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

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "mimeParse", mime_parse, context_id);
    crate::dom::register(scope, ns, "mimeSerialize", mime_serialize, context_id);
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
}
