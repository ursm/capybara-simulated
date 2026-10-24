// HTML's shared declarative refresh steps — a `<meta http-equiv=refresh>` inserted, a `Refresh` response header — the
// engine's: what the value says (a delay in seconds and, optionally, a URL), whether the document refreshes at all (once,
// the first that says it; its sandboxing may block a `<meta>`'s), and where to. The bindings wait out the delay from the
// later of the document's load and the element's insertion, and navigate (location.js `__csimDeclarativeRefresh`).

use crate::dom::{nid_arg, realm, realm_id, register, NodeId, RealmArena};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "declarativeRefresh", declarative_refresh_op, context_id);
    register(scope, ns, "forgetDeclarativeRefresh", forget_declarative_refresh_op, context_id);
}

// The value's parts: its delay in seconds and the URL string it names, none for the document's own — None where it is
// no refresh (HTML's steps 2-10: no digits and no ".", a delay followed by anything but a separator).
fn parse(input: &str) -> Option<(f64, Option<&str>)> {
    let ws = |c: char| matches!(c, '\t' | '\n' | '\x0C' | '\r' | ' ');
    let mut rest = input.trim_start_matches(ws);
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    let (time, after) = rest.split_at(digits);
    if time.is_empty() && !after.starts_with('.') {
        return None;
    }
    let time = if time.is_empty() { 0.0 } else { time.parse::<f64>().unwrap_or(f64::MAX) };
    rest = after.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.');
    if !rest.is_empty() {
        if !rest.starts_with(|c: char| c == ';' || c == ',' || ws(c)) {
            return None;
        }
        rest = rest.trim_start_matches(ws);
        if rest.starts_with([';', ',']) {
            rest = &rest[1..];
        }
        rest = rest.trim_start_matches(ws);
    }
    if rest.is_empty() {
        return Some((time, None));
    }
    // (…an optional `url=` before it, each letter of either case, white space around its "=": a "u" that begins no whole
    // `url=` leaves the URL what the value has from it, quotes and all — HTML's "parse" — and otherwise a quoted one is
    // taken up to its closing quote, where it has one: "skip quotes")
    let bytes = rest.as_bytes();
    let url = if bytes[0].eq_ignore_ascii_case(&b'u') {
        let tail = (bytes.len() >= 3 && bytes[1..3].eq_ignore_ascii_case(b"rl")).then(|| rest[3..].trim_start_matches(ws));
        match tail.and_then(|t| t.strip_prefix('=')) {
            Some(value) => unquoted(value.trim_start_matches(ws)),
            None => rest,
        }
    } else {
        unquoted(rest)
    };
    Some((time, Some(url)))
}

// …a URL string from its opening quote, if any, up to its closing one, where it has one.
fn unquoted(url: &str) -> &str {
    match url.chars().next().filter(|&c| c == '"' || c == '\'') {
        Some(quote) => url[1..].split(quote).next().unwrap_or(""),
        None => url,
    }
}

impl RealmArena {
    // HTML's shared declarative refresh steps for document `doc` of realm `cid` and the value `input` — a `<meta>`'s
    // (`meta`) or a `Refresh` header's: the delay in milliseconds and the URL to navigate to once it is up, or None for
    // none: a document with no browsing context, one that refreshes already, a value that is none, a URL that fails to
    // parse or is a `javascript:` one — and for a `<meta>` whose document's sandboxing blocks automatic features, none
    // either, though it then refreshes no more.
    fn declarative_refresh(&mut self, cid: i32, doc: NodeId, input: &str, meta: bool) -> Option<(f64, String)> {
        if !self.document_states.has_browsing_context(doc) || self.document_states.will_refresh(doc) {
            return None;
        }
        let (seconds, url) = parse(input)?;
        // (…none named its document's URL, as it is — its fragment kept, a navigation to it a fragment one — where a named
        // one, an empty one too, is parsed against its base URL)
        let url = match url {
            Some(url) => self.parse_document_url(doc, url)?,
            None => ada_url::Url::parse(&self.document_url(doc, false), None).ok()?,
        };
        if url.protocol().eq_ignore_ascii_case("javascript:") {
            return None;
        }
        self.document_states.set_will_refresh(doc, true);
        if meta && self.sandboxed(cid, crate::sandbox::AUTOMATIC_FEATURES) {
            return None;
        }
        Some(((seconds * 1000.0).min(f64::from(i32::MAX)), url.href().to_owned()))
    }
}

// __dom.forgetDeclarativeRefresh(docNid) — the document begins anew (a reused one's next load): it refreshes no more as
// its last did, and may again.
fn forget_declarative_refresh_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    realm(scope, cid).document_states.set_will_refresh(doc, false);
}

// __dom.declarativeRefresh(docNid, input, meta) -> `[delayMs, url]` (`declarative_refresh`), or null.
fn declarative_refresh_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let input = args.get(1).to_rust_string_lossy(scope);
    let meta = args.get(2).is_true();
    let cid = realm_id(scope, &args);
    let Some((delay, url)) = realm(scope, cid).declarative_refresh(cid, doc, &input, meta) else { return };
    let delay = v8::Number::new(scope, delay).into();
    let Some(url) = v8::String::new(scope, &url) else { return };
    rv.set(v8::Array::new_with_elements(scope, &[delay, url.into()]).into());
}

#[cfg(test)]
mod tests {
    use super::parse;

    // HTML's steps: a delay of digits or one starting at ".", a separator, an optional `url=`, a quoted URL cut at its
    // closing quote — and none for a value with neither digits nor ".", or a delay run into anything else.
    #[test]
    fn parses_as_html_does() {
        assert_eq!(parse("0; url=/x"), Some((0.0, Some("/x"))));
        assert_eq!(parse("  5 ,URL = '/y' tail"), Some((5.0, Some("/y"))));
        assert_eq!(parse("1.5;\"/z\""), Some((1.0, Some("/z"))));
        assert_eq!(parse(".5"), Some((0.0, None)));
        assert_eq!(parse("3"), Some((3.0, None)));
        assert_eq!(parse("3 /w"), Some((3.0, Some("/w"))));
        assert_eq!(parse("3; u '/v'"), Some((3.0, Some("u '/v'"))));
        assert_eq!(parse("urlx; /a"), None);
        assert_eq!(parse("3x"), None);
        assert_eq!(parse("2; ur=/q"), Some((2.0, Some("ur=/q"))));
    }
}
