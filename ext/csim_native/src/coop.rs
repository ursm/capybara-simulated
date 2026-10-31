// Cross-origin opener policies (HTML §7.1.3): a document's — its response's `Cross-Origin-Opener-Policy`, made
// "same-origin-plus-COEP" by an embedder policy compatible with cross-origin isolation — and whether a navigation of a
// top-level traversable to a response needs a browsing context group switch, judged against the document it leaves:
// what the host does with a navigation response (browser.rb `coop_switch?`) — a pop-up's that needs one leaving its
// opener's browsing context group, the isolate it is a realm of, for a Browser of its own.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Value {
    UnsafeNone,
    SameOriginAllowPopups,
    SameOrigin,
    SameOriginPlusCoep,
    NoopenerAllowPopups,
}

impl Value {
    fn name(self) -> &'static str {
        match self {
            Value::UnsafeNone => "unsafe-none",
            Value::SameOriginAllowPopups => "same-origin-allow-popups",
            Value::SameOrigin => "same-origin",
            Value::SameOriginPlusCoep => "same-origin-plus-COEP",
            Value::NoopenerAllowPopups => "noopener-allow-popups",
        }
    }
    fn named(name: &str) -> Value {
        match name {
            "same-origin-allow-popups" => Value::SameOriginAllowPopups,
            "same-origin" => Value::SameOrigin,
            "same-origin-plus-COEP" => Value::SameOriginPlusCoep,
            "noopener-allow-popups" => Value::NoopenerAllowPopups,
            _ => Value::UnsafeNone,
        }
    }
}

// The token a structured header item's value is (RFC 9651), its parameters let go — none for anything else.
fn token(header: &str) -> Option<&str> {
    let item = header.split(';').next()?.trim_matches([' ', '\t']);
    let mut chars = item.chars();
    let first = chars.next()?;
    ((first.is_ascii_alphabetic() || first == '*') && chars.all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~:/".contains(c))).then_some(item)
}

// HTML "obtain an opener policy" given a response's `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`
// (every document here in a secure context): "same-origin" with an embedder policy compatible with cross-origin
// isolation (`require-corp`, `credentialless`) "same-origin-plus-COEP", an unknown value "unsafe-none".
pub(crate) fn obtain(coop: Option<&str>, coep: Option<&str>) -> Value {
    let compatible = matches!(coep.and_then(token), Some("require-corp" | "credentialless"));
    match coop.and_then(token) {
        Some("same-origin") if compatible => Value::SameOriginPlusCoep,
        Some("same-origin") => Value::SameOrigin,
        Some("same-origin-allow-popups") => Value::SameOriginAllowPopups,
        Some("noopener-allow-popups") => Value::NoopenerAllowPopups,
        _ => Value::UnsafeNone,
    }
}

// HTML "match opener policy values": both "unsafe-none", or the same value of the same origin (an opaque one, "null",
// the same as none).
fn matching(document: Value, document_origin: &str, response: Value, response_origin: &str) -> bool {
    if document == Value::UnsafeNone && response == Value::UnsafeNone {
        return true;
    }
    document == response && document_origin != "null" && document_origin == response_origin
}

// HTML "check if COOP values require a browsing context group switch" — and, the document an initial about:blank, "check
// if popup COOP values require a browsing context group switch".
pub(crate) fn switch_needed(initial_about_blank: bool, document_origin: &str, document: Value, response_origin: &str, response: Value) -> bool {
    if initial_about_blank {
        if response == Value::NoopenerAllowPopups {
            return true;
        }
        if matches!(document, Value::SameOriginAllowPopups | Value::NoopenerAllowPopups) && response == Value::UnsafeNone {
            return false;
        }
    }
    !matching(document, document_origin, response, response_origin)
}

// Native.coop_value(coop, coep) -> the value `obtain` gives, by its name.
pub(crate) fn value_for_ruby(coop: Option<String>, coep: Option<String>) -> String {
    obtain(coop.as_deref(), coep.as_deref()).name().to_owned()
}
// Native.coop_switch(initial_about_blank, document_origin, document_value, response_origin, response_value) ->
// `switch_needed`, the values by their names.
pub(crate) fn switch_for_ruby(initial_about_blank: bool, document_origin: String, document: String, response_origin: String, response: String) -> bool {
    switch_needed(initial_about_blank, &document_origin, Value::named(&document), &response_origin, Value::named(&response))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_response_s_policy_is_its_header_s_token_made_plus_coep_by_a_compatible_embedder_policy() {
        assert_eq!(obtain(Some("same-origin"), Some("require-corp")), Value::SameOriginPlusCoep);
        assert_eq!(obtain(Some("same-origin; report-to=\"x\""), Some("credentialless")), Value::SameOriginPlusCoep);
        assert_eq!(obtain(Some("same-origin"), Some("unsafe-none")), Value::SameOrigin);
        assert_eq!(obtain(Some("same-origin-allow-popups"), None), Value::SameOriginAllowPopups);
        assert_eq!(obtain(Some("\"same-origin\""), None), Value::UnsafeNone);
        assert_eq!(obtain(None, Some("require-corp")), Value::UnsafeNone);
    }

    #[test]
    fn a_switch_is_needed_where_the_policies_do_not_match() {
        let (a, b) = ("http://a.test", "http://b.test");
        use Value::*;
        assert!(!switch_needed(false, a, UnsafeNone, b, UnsafeNone));
        assert!(switch_needed(false, a, SameOriginPlusCoep, b, UnsafeNone));
        assert!(switch_needed(false, a, UnsafeNone, b, SameOriginPlusCoep));
        assert!(!switch_needed(false, a, SameOrigin, a, SameOrigin));
        assert!(switch_needed(false, a, SameOrigin, b, SameOrigin));
        assert!(switch_needed(false, "null", SameOrigin, "null", SameOrigin));
        // (…a pop-up's initial about:blank: an opener's same-origin-allow-popups keeps one going to unsafe-none, and
        // noopener-allow-popups always switches)
        assert!(!switch_needed(true, a, SameOriginAllowPopups, b, UnsafeNone));
        assert!(switch_needed(false, a, SameOriginAllowPopups, b, UnsafeNone));
        assert!(switch_needed(true, a, UnsafeNone, a, NoopenerAllowPopups));
    }
}
