// What a resource timing entry reads off its response (Resource Timing, Server Timing): the metrics its `Server-Timing`
// header lists, its `contentType` (the response's MIME type minimized), its `contentEncoding`, and whether its
// `Timing-Allow-Origin` lets the document see its timing. The bindings (performance.js) make the entries.

// A `Server-Timing` metric: its name, its `dur` (0 for none) and its `desc` ('' for none).
#[derive(Debug, PartialEq)]
pub(crate) struct Metric {
    pub(crate) name: String,
    pub(crate) duration: f64,
    pub(crate) description: String,
}

// Server Timing §3 "parse a server-timing header": its comma-separated metrics, each `name *( OWS ";" OWS param )`, a
// param `key [ OWS "=" OWS value ]` — a value a token or an HTTP quoted-string (a `\` taking the character after it, a
// comma inside it no metric's end; one never closed `""`) — the first `dur` and the first `desc` of a metric taken, any
// other param ignored, and what the grammar cannot take after a name or a param skipped to the next `;` or `,` ("user
// agents MUST ignore extraneous characters"). A metric with no name is none.
pub(crate) fn server_timing(value: &str) -> Vec<Metric> {
    type Chars<'a> = std::iter::Peekable<std::str::Chars<'a>>;
    fn ows(chars: &mut Chars) {
        while chars.next_if(|c| matches!(c, ' ' | '\t')).is_some() {}
    }
    fn token(chars: &mut Chars) -> String {
        let mut t = String::new();
        while let Some(c) = chars.next_if(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(*c)) {
            t.push(c);
        }
        t
    }
    // (…up to the next `;` or `,`, a quoted string skipped whole)
    fn extraneous(chars: &mut Chars) {
        let mut quoted = false;
        while let Some(c) = chars.next_if(|&c| quoted || (c != ';' && c != ',')) {
            match c {
                '"' => quoted = !quoted,
                '\\' if quoted => {
                    chars.next();
                }
                _ => {}
            }
        }
    }
    fn quoted_string(chars: &mut Chars) -> String {
        let mut s = String::new();
        loop {
            match chars.next() {
                None => return String::new(),
                Some('"') => return s,
                Some('\\') => match chars.next() {
                    Some(c) => s.push(c),
                    None => return String::new(),
                },
                Some(c) => s.push(c),
            }
        }
    }
    let mut metrics = Vec::new();
    let mut chars = value.chars().peekable();
    loop {
        ows(&mut chars);
        if chars.peek().is_none() {
            return metrics;
        }
        let name = token(&mut chars);
        extraneous(&mut chars);
        let (mut duration, mut description) = (None, None);
        while chars.next_if_eq(&';').is_some() {
            ows(&mut chars);
            let key = token(&mut chars).to_ascii_lowercase();
            ows(&mut chars);
            let mut param = String::new();
            if chars.next_if_eq(&'=').is_some() {
                ows(&mut chars);
                param = if chars.next_if_eq(&'"').is_some() { quoted_string(&mut chars) } else { token(&mut chars) };
            }
            extraneous(&mut chars);
            match key.as_str() {
                // (…a number past leading whitespace, as Chrome reads one; anything else, or none finite, 0)
                "dur" if duration.is_none() => {
                    let number = param.trim_start_matches([' ', '\t', '\n', '\r', '\x0c']).parse::<f64>().ok();
                    duration = Some(number.filter(|d| d.is_finite()).unwrap_or(0.0));
                }
                "desc" if description.is_none() => description = Some(param),
                _ => {}
            }
        }
        chars.next_if_eq(&',');
        if !name.is_empty() {
            metrics.push(Metric { name, duration: duration.unwrap_or(0.0), description: description.unwrap_or_default() });
        }
    }
}

// Resource Timing "minimize a supported MIME type" of the response's MIME type (Fetch "extract a MIME type" from its
// `Content-Type`, the last of a combined list that parses): a JavaScript type `text/javascript`, a JSON one
// `application/json`, SVG `image/svg+xml`, any other XML type `application/xml`, any other its essence — '' where none
// parses. (OPEN: mimesniff's "supported by the user agent" gate, '' for a type it does not support, is not modelled.)
pub(crate) fn minimize_mime(content_type: &str) -> String {
    let Some(mime) = crate::mime::extract(content_type) else { return String::new() };
    let essence = mime.essence.as_str();
    let subtype = essence.split_once('/').map_or("", |(_, s)| s);
    if crate::script::is_javascript_mime(essence) {
        "text/javascript".to_owned()
    } else if essence == "application/json" || essence == "text/json" || subtype.ends_with("+json") {
        "application/json".to_owned()
    } else if essence == "image/svg+xml" {
        essence.to_owned()
    } else if essence == "application/xml" || essence == "text/xml" || subtype.ends_with("+xml") {
        "application/xml".to_owned()
    } else {
        essence.to_owned()
    }
}

// Resource Timing's `contentEncoding`: one coding the user agent knows, as written (case-folded); a list "multiple"; a
// coding it does not know — `identity` is none on the wire — "@unknown"; no header, or an empty one, ''.
pub(crate) fn content_encoding(header: &str) -> String {
    let raw = header.trim_matches([' ', '\t', '\n', '\r']);
    if raw.is_empty() {
        return String::new();
    }
    if raw.contains(',') {
        return "multiple".to_owned();
    }
    let coding = raw.to_ascii_lowercase();
    if matches!(coding.as_str(), "br" | "dcb" | "dcz" | "deflate" | "gzip" | "zstd") { coding } else { "@unknown".to_owned() }
}

// Fetch's "TAO check" for a cross-origin response: its `Timing-Allow-Origin` values, comma-separated, one `*` or the
// requesting document's origin serialized.
fn timing_allowed(tao: &str, origin: &str) -> bool {
    tao.split(',').map(|v| v.trim_matches([' ', '\t'])).any(|v| v == "*" || (!v.is_empty() && v == origin))
}

// What a resource's entry lets the document see (Resource Timing §4.7, Fetch): whether its timing is allowed — a
// response that is not opaque, of the document's own origin (or a URL with none) or admitted by its
// `Timing-Allow-Origin`, and, where a redirect crossed origins, its final URL so too (the hops between are not kept) —
// and whether its response's status and type are exposed: not an opaque response, not a cross-origin document's (a
// frame's), not a no-cors element load's of a cross-origin URL.
pub(crate) struct Exposure {
    pub(crate) allowed: bool,
    pub(crate) exposed: bool,
}
pub(crate) fn exposure(name: &str, final_url: &str, document_origin: &str, tao: Option<&str>, opaque: bool, document: bool, no_cors: bool) -> Exposure {
    let origin_of = |url: &str| ada_url::Url::parse(url, None).ok().map(|u| u.origin());
    let here = (!document_origin.is_empty()).then_some(document_origin);
    let allowed_for = |url: &str| {
        !opaque
            && match origin_of(url) {
                None => true,
                Some(there) => Some(there.as_str()) == here || tao.is_some_and(|t| timing_allowed(t, here.unwrap_or_default())),
            }
    };
    let cross_origin_chain = final_url != name && origin_of(final_url) != origin_of(name);
    let cross_origin = origin_of(name).as_deref() != here;
    Exposure {
        allowed: allowed_for(name) && (!cross_origin_chain || allowed_for(final_url)),
        exposed: !opaque && !(cross_origin && (document || no_cors)),
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "serverTiming", server_timing_op, context_id);
    crate::dom::register(scope, ns, "minimizeMime", minimize_mime_op, context_id);
    crate::dom::register(scope, ns, "contentEncoding", content_encoding_op, context_id);
    crate::dom::register(scope, ns, "resourceExposure", exposure_op, context_id);
}
fn text<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
}
// __dom.serverTiming(value) -> [name, duration, description, …] (`server_timing`).
fn server_timing_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let value = args.get(0).to_rust_string_lossy(scope);
    let mut items: Vec<v8::Local<v8::Value>> = Vec::new();
    for m in server_timing(&value) {
        items.push(text(scope, &m.name));
        items.push(v8::Number::new(scope, m.duration).into());
        items.push(text(scope, &m.description));
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.minimizeMime(contentType) -> `minimize_mime`.
fn minimize_mime_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let value = args.get(0).to_rust_string_lossy(scope);
    let answer = minimize_mime(&value);
    rv.set(text(scope, &answer));
}
// __dom.contentEncoding(header) -> `content_encoding`.
fn content_encoding_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let value = args.get(0).to_rust_string_lossy(scope);
    let answer = content_encoding(&value);
    rv.set(text(scope, &answer));
}
// __dom.resourceExposure(name, finalUrl, documentOrigin, tao, opaque, document, noCors) -> `exposure`, its bits: 1
// allowed, 2 exposed. `tao` null for no header.
fn exposure_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (name, final_url, origin) = (args.get(0).to_rust_string_lossy(scope), args.get(1).to_rust_string_lossy(scope), args.get(2).to_rust_string_lossy(scope));
    let tao = (!args.get(3).is_null_or_undefined()).then(|| args.get(3).to_rust_string_lossy(scope));
    let e = exposure(&name, &final_url, &origin, tao.as_deref(), args.get(4).is_true(), args.get(5).is_true(), args.get(6).is_true());
    rv.set_int32(e.allowed as i32 | (e.exposed as i32) << 1);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(value: &str) -> Vec<(String, f64, String)> {
        server_timing(value).into_iter().map(|m| (m.name, m.duration, m.description)).collect()
    }

    #[test]
    fn server_timing_parses_as_its_spec_says() {
        assert_eq!(st(r#"db;dur=53, app;dur=47.2;desc="a, b""#), vec![("db".into(), 53.0, "".into()), ("app".into(), 47.2, "a, b".into())]);
        assert_eq!(st("cache;desc=hit;desc=miss;dur=1;dur=2"), vec![("cache".into(), 1.0, "hit".into())]);
        assert_eq!(st(r#"x;desc="q\"q""#), vec![("x".into(), 0.0, "q\"q".into())]);
        // (…what the grammar cannot take ignored, not the metric — WPT server_timing_header-parsing 63, 65, 67, 69, 70)
        assert_eq!(st("bad junk, ok"), vec![("bad".into(), 0.0, "".into()), ("ok".into(), 0.0, "".into())]);
        assert_eq!(st("metric;desc=d1 d2;dur=123.4"), vec![("metric".into(), 123.4, "d1".into())]);
        assert_eq!(st(r#"metric==   ""foo;dur=123.4"#), vec![("metric".into(), 123.4, "".into())]);
        assert_eq!(st("metric;dur foo=12"), vec![("metric".into(), 0.0, "".into())]);
        assert_eq!(st(r#"metric;desc="\\"#), vec![("metric".into(), 0.0, "".into())]);
        assert_eq!(st("m;dur= 7"), vec![("m".into(), 7.0, "".into())]);
        assert_eq!(st(r#"m;dur=" 7""#), vec![("m".into(), 7.0, "".into())]);
        assert_eq!(st(";dur=1, ,y"), vec![("y".into(), 0.0, "".into())]);
    }

    #[test]
    fn mime_types_and_codings_minimize() {
        assert_eq!(minimize_mime("application/x-javascript; charset=utf-8"), "text/javascript");
        assert_eq!(minimize_mime("application/ld+json"), "application/json");
        assert_eq!(minimize_mime("image/svg+xml"), "image/svg+xml");
        assert_eq!(minimize_mime("application/atom+xml"), "application/xml");
        assert_eq!(minimize_mime("TEXT/HTML"), "text/html");
        assert_eq!(minimize_mime("nonsense"), "");
        assert_eq!(minimize_mime("text/plain, application/json"), "application/json");
        assert_eq!(content_encoding(" GZIP "), "gzip");
        assert_eq!(content_encoding("gzip, br"), "multiple");
        assert_eq!(content_encoding("identity"), "@unknown");
        assert!(timing_allowed(" https://a.test , *", "https://b.test"));
        let seen = |name, final_url, tao, opaque, document, no_cors| {
            let e = exposure(name, final_url, "https://a.test", tao, opaque, document, no_cors);
            (e.allowed, e.exposed)
        };
        assert_eq!(seen("https://a.test/x", "https://a.test/x", None, false, false, false), (true, true));
        assert_eq!(seen("https://b.test/x", "https://b.test/x", None, false, false, false), (false, true));
        assert_eq!(seen("https://b.test/x", "https://b.test/x", Some("https://a.test"), false, false, true), (true, false));
        assert_eq!(seen("https://a.test/x", "https://b.test/y", None, false, false, false), (false, true));
        assert_eq!(seen("https://a.test/x", "https://a.test/x", None, true, false, false), (false, false));
        assert_eq!(seen("https://b.test/f", "https://b.test/f", Some("*"), false, true, false), (true, false));
        assert!(!timing_allowed("https://a.test", "https://b.test"));
    }
}
