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

// What a fetch tells its entry (Resource Timing §4.6 "mark resource timing" — the response's facts as the host has them):
// its URL and the one it ended at, the document's origin, the response's `Timing-Allow-Origin`, whether it is opaque, a
// frame's document or a no-cors element load, when it started and ended, whether it came from the cache ("cache") or
// was revalidated ("validated"), its body's encoded and decoded sizes, whether it was redirected, its status, its
// `Content-Type`, `Content-Encoding` and `Server-Timing` headers, whether it blocked rendering; and whether it failed
// (a network error: nothing but its times).
pub(crate) struct Facts {
    pub(crate) name: String,
    pub(crate) final_url: String,
    pub(crate) document_origin: String,
    pub(crate) tao: Option<String>,
    pub(crate) opaque: bool,
    pub(crate) document: bool,
    pub(crate) no_cors: bool,
    pub(crate) start: f64,
    pub(crate) end: f64,
    pub(crate) cached: Option<String>,
    pub(crate) encoded: f64,
    pub(crate) decoded: f64,
    pub(crate) redirected: bool,
    pub(crate) status: f64,
    pub(crate) content_type: Option<String>,
    pub(crate) content_encoding: Option<String>,
    pub(crate) server_timing: Option<String>,
    pub(crate) render_blocking: bool,
    pub(crate) failed: bool,
}
// …and what the entry's attributes are made of them: a timing not allowed reads 0 (or ""), as its sizes and its
// `Server-Timing`; a status and a content type not exposed too. Its times are the fetch's start, but `responseEnd` (the
// network the driver models is instantaneous), a TLS handshake only for an https: URL, a redirect's only where one was;
// its `transferSize` the body's encoded size and 300 octets of headers — nothing from the cache, the headers alone for a
// revalidation.
pub(crate) enum Field {
    Number(f64),
    Text(String),
    Metrics(Vec<Metric>),
}
pub(crate) fn entry_fields(f: &Facts) -> Vec<(&'static str, Field)> {
    use Field::{Metrics, Number, Text};
    let Exposure { allowed, exposed } =
        if f.failed { Exposure { allowed: false, exposed: false } } else { exposure(&f.name, &f.final_url, &f.document_origin, f.tao.as_deref(), f.opaque, f.document, f.no_cors) };
    let at = |yes: bool| Number(if yes { f.start } else { 0.0 });
    let cached = f.cached.as_deref();
    let transfer = match (allowed, cached) {
        (false, _) | (true, Some("cache")) => 0.0,
        (true, Some("validated")) => 300.0,
        (true, _) => f.encoded + 300.0,
    };
    let text = |yes: bool, s: String| Text(if yes { s } else { String::new() });
    vec![
        ("deliveryType", text(allowed && cached == Some("cache"), "cache".to_owned())),
        ("nextHopProtocol", text(allowed, "http/1.1".to_owned())),
        ("workerStart", Number(0.0)),
        ("redirectStart", at(allowed && f.redirected)),
        ("redirectEnd", at(allowed && f.redirected)),
        ("fetchStart", Number(f.start)),
        ("domainLookupStart", at(allowed)),
        ("domainLookupEnd", at(allowed)),
        ("connectStart", at(allowed)),
        ("connectEnd", at(allowed)),
        ("secureConnectionStart", at(allowed && f.name.get(..6).is_some_and(|s| s.eq_ignore_ascii_case("https:")))),
        ("requestStart", at(allowed)),
        ("finalResponseHeadersStart", at(allowed)),
        ("firstInterimResponseStart", Number(0.0)),
        ("responseStart", at(allowed)),
        ("responseEnd", Number(f.end)),
        ("workerRouterEvaluationStart", Number(0.0)),
        ("workerCacheLookupStart", Number(0.0)),
        ("workerMatchedRouterSource", Text(String::new())),
        ("workerFinalRouterSource", Text(String::new())),
        ("transferSize", Number(transfer)),
        ("encodedBodySize", Number(if allowed { f.encoded } else { 0.0 })),
        ("decodedBodySize", Number(if allowed { f.decoded } else { 0.0 })),
        ("responseStatus", Number(if exposed { f.status } else { 0.0 })),
        ("renderBlockingStatus", Text(if f.render_blocking { "blocking" } else { "non-blocking" }.to_owned())),
        ("contentType", text(exposed, f.content_type.as_deref().map(minimize_mime).unwrap_or_default())),
        ("contentEncoding", text(allowed, f.content_encoding.as_deref().map(content_encoding).unwrap_or_default())),
        ("serverTiming", Metrics(if allowed { f.server_timing.as_deref().map(server_timing).unwrap_or_default() } else { Vec::new() })),
    ]
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "resourceTimingEntry", entry_op, context_id);
}
fn text<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
}
// The member `key` of `obj`, None where it is null or undefined.
fn member<'s>(scope: &mut v8::PinScope<'s, '_>, obj: v8::Local<'_, v8::Object>, key: &str) -> Option<v8::Local<'s, v8::Value>> {
    let k = v8::String::new(scope, key)?;
    obj.get(scope, k.into()).filter(|v| !v.is_null_or_undefined())
}
// __dom.resourceTimingEntry(facts) -> the entry's fields (`entry_fields`) as an object, `serverTiming` a flat
// [name, duration, description, …] list — `facts` an object of `Facts`' members by their camel-cased names, a header
// null for none.
fn entry_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(obj) = v8::Local::<v8::Object>::try_from(args.get(0)) else { return };
    let string = |scope: &mut v8::PinScope<'_, '_>, key: &str| member(scope, obj, key).map(|v| v.to_rust_string_lossy(scope));
    let flag = |scope: &mut v8::PinScope<'_, '_>, key: &str| member(scope, obj, key).is_some_and(|v| v.boolean_value(scope));
    let number = |scope: &mut v8::PinScope<'_, '_>, key: &str| member(scope, obj, key).and_then(|v| v.number_value(scope)).unwrap_or(0.0);
    let facts = Facts {
        name: string(scope, "name").unwrap_or_default(),
        final_url: string(scope, "finalUrl").unwrap_or_default(),
        document_origin: string(scope, "documentOrigin").unwrap_or_default(),
        tao: string(scope, "tao"),
        opaque: flag(scope, "opaque"),
        document: flag(scope, "document"),
        no_cors: flag(scope, "noCors"),
        start: number(scope, "start"),
        end: number(scope, "end"),
        cached: string(scope, "cached"),
        encoded: number(scope, "encoded"),
        decoded: number(scope, "decoded"),
        redirected: flag(scope, "redirected"),
        status: number(scope, "status"),
        content_type: string(scope, "contentType"),
        content_encoding: string(scope, "contentEncoding"),
        server_timing: string(scope, "serverTiming"),
        render_blocking: flag(scope, "renderBlocking"),
        failed: flag(scope, "failed"),
    };
    let out = v8::Object::new(scope);
    for (key, field) in entry_fields(&facts) {
        let value: v8::Local<v8::Value> = match field {
            Field::Number(n) => v8::Number::new(scope, n).into(),
            Field::Text(t) => text(scope, &t),
            Field::Metrics(metrics) => {
                let mut items: Vec<v8::Local<v8::Value>> = Vec::new();
                for m in metrics {
                    items.push(text(scope, &m.name));
                    items.push(v8::Number::new(scope, m.duration).into());
                    items.push(text(scope, &m.description));
                }
                v8::Array::new_with_elements(scope, &items).into()
            }
        };
        if let Some(k) = v8::String::new(scope, key) {
            out.set(scope, k.into(), value);
        }
    }
    rv.set(out.into());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> Facts {
        Facts {
            name: "https://a.test/x.js".into(),
            final_url: "https://a.test/x.js".into(),
            document_origin: "https://a.test".into(),
            tao: None,
            opaque: false,
            document: false,
            no_cors: false,
            start: 10.0,
            end: 12.0,
            cached: None,
            encoded: 100.0,
            decoded: 400.0,
            redirected: false,
            status: 200.0,
            content_type: Some("text/javascript; charset=utf-8".into()),
            content_encoding: Some("gzip".into()),
            server_timing: Some("db;dur=5".into()),
            render_blocking: true,
            failed: false,
        }
    }
    fn number(fields: &[(&str, Field)], key: &str) -> f64 {
        match fields.iter().find(|(k, _)| *k == key) {
            Some((_, Field::Number(n))) => *n,
            _ => f64::NAN,
        }
    }
    fn string(fields: &[(&str, Field)], key: &str) -> String {
        match fields.iter().find(|(k, _)| *k == key) {
            Some((_, Field::Text(t))) => t.clone(),
            _ => "?".into(),
        }
    }

    #[test]
    fn an_entry_shows_what_its_fetch_lets_it() {
        let own = entry_fields(&facts());
        assert_eq!((number(&own, "transferSize"), number(&own, "secureConnectionStart"), number(&own, "responseStatus")), (400.0, 10.0, 200.0));
        assert_eq!((string(&own, "contentType"), string(&own, "contentEncoding"), string(&own, "renderBlockingStatus")), ("text/javascript".into(), "gzip".into(), "blocking".into()));
        let cross = entry_fields(&Facts { name: "https://b.test/x.js".into(), final_url: "https://b.test/x.js".into(), ..facts() });
        assert_eq!((number(&cross, "transferSize"), number(&cross, "connectStart"), number(&cross, "responseStatus")), (0.0, 0.0, 200.0));
        assert_eq!((string(&cross, "contentEncoding"), string(&cross, "nextHopProtocol")), ("".into(), "".into()));
        let cached = entry_fields(&Facts { cached: Some("cache".into()), ..facts() });
        assert_eq!((number(&cached, "transferSize"), string(&cached, "deliveryType")), (0.0, "cache".into()));
        let failed = entry_fields(&Facts { failed: true, ..facts() });
        assert_eq!((number(&failed, "fetchStart"), number(&failed, "responseEnd"), number(&failed, "requestStart")), (10.0, 12.0, 0.0));
    }

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
