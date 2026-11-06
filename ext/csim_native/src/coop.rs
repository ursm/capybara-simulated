// Cross-origin opener policies (HTML §7.1.3): a document's — its response's `Cross-Origin-Opener-Policy`, made
// "same-origin-plus-COEP" by an embedder policy compatible with cross-origin isolation — and whether a navigation of a
// top-level traversable to a response needs a browsing context group switch, judged against the document it leaves:
// what the host does with a navigation response (browser.rb `commit_coop`) — a pop-up's that needs one leaving its
// opener's browsing context group, the isolate it is a realm of, for a Browser of its own. The policy of the document a
// top-level traversable is at is the traversable's (session_history.rs `opener_policy`).

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Value {
    #[default]
    UnsafeNone,
    SameOriginAllowPopups,
    SameOrigin,
    SameOriginPlusCoep,
    NoopenerAllowPopups,
}

impl Value {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Value::UnsafeNone => "unsafe-none",
            Value::SameOriginAllowPopups => "same-origin-allow-popups",
            Value::SameOrigin => "same-origin",
            Value::SameOriginPlusCoep => "same-origin-plus-COEP",
            Value::NoopenerAllowPopups => "noopener-allow-popups",
        }
    }
    pub(crate) fn named(name: &str) -> Value {
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

// What a document committing at a top-level traversable makes of its browsing context group: whether it leaves it — `carried`,
// the switch its navigation's enforcement result needed, or else its own policy `response` against the document it replaces,
// the host asked that one's facts (its origin, whether it is its initial about:blank) only where a policy is in play — and,
// leaving, whether the group it is made for is cross-origin isolated: HTML's "cross-origin isolation mode" is a group's, set
// as one is made for a document "same-origin-plus-COEP". Every commit comes through here: a response's, whose judging again
// agrees with what its hops found (values matching hop to hop match end to end), and a document no hop enforced — an
// about:blank's, a `blob:` or `data:` URL's, an error document's.
pub(crate) fn commit_verdict<E>(document: Value, response: Value, response_origin: &str, carried: bool, facts: impl FnOnce() -> Result<(String, bool), E>) -> Result<(bool, bool), E> {
    let switch = carried
        || (document != Value::UnsafeNone || response != Value::UnsafeNone) && {
            let (document_origin, initial) = facts()?;
            switch_needed(initial, &document_origin, document, response_origin, response)
        };
    Ok((switch, response == Value::SameOriginPlusCoep))
}

// The opener policy a document of no headers takes of the document that made it: a new window's initial about:blank of its
// creator (HTML "create a new browsing context and document"), and an about:blank or `blob:` document of its navigation's
// initiator: that of its top-level document, where the origin of the one that made it (`facts`, with that document's) is
// that one's, an opaque one being no other's — none otherwise.
//
// HTML's text gives the second none ("create navigation params by fetching" enforces it as any response, "obtain an opener
// policy" finding no header), and that is a known gap, not a rule. The policy container's definition reads "Move other
// policies into the policy container", which these documents inherit; whatwg/html#5198 has been open since 2019 on just
// this, annevk: "`about:blank` and `blob:` remain for popups. I think we should inherit for them as we do normally",
// ParisMeuleman: "inherit from the source document top level document if they are both same-origin, unsafe-none otherwise",
// annevk: "Yeah that sounds reasonable", nobody against. The non-tentative WPTs html/cross-origin-opener-policy/
// blob-popup, coep-blob-popup, navigate-to-aboutblank and navigate-top-to-aboutblank hold it, and Chrome and Firefox agree
// (Firefox alone keeps the group under a cross-origin initiator, where #5198 and the WPT say none). A `data:` URL inherits
// nothing: annevk on #5198, "always ensure that it's a fresh browsing context group".
pub(crate) fn inherited<E>(top_level: Value, facts: impl FnOnce() -> Result<(String, String), E>) -> Result<Value, E> {
    if top_level == Value::UnsafeNone {
        return Ok(top_level);
    }
    let (creator_origin, top_level_origin) = facts()?;
    Ok(if creator_origin != "null" && creator_origin == top_level_origin { top_level } else { Value::UnsafeNone })
}

// Whether a window a document opens is opened without its opener (HTML "the rules for choosing a navigable"): its top-level
// document of a policy "same-origin" or "same-origin-plus-COEP", and its own origin (`facts`, with that document's) not
// that one's.
pub(crate) fn isolates_opener<E>(top_level: Value, facts: impl FnOnce() -> Result<(String, String), E>) -> Result<bool, E> {
    if !matches!(top_level, Value::SameOrigin | Value::SameOriginPlusCoep) {
        return Ok(false);
    }
    let (origin, top_level_origin) = facts()?;
    Ok(origin != top_level_origin)
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

    #[test]
    fn a_commit_leaves_its_group_where_its_hops_said_or_its_own_policy_does_not_match() {
        use Value::*;
        let (a, b) = ("http://a.test", "http://b.test");
        let facts = |initial| move || Ok::<_, ()>((a.to_owned(), initial));
        // (…no policy on either side: nothing asked)
        assert_eq!(commit_verdict(UnsafeNone, UnsafeNone, a, false, || Err(())), Ok((false, false)));
        // (…a document of no headers, its policy none: an error document's, a `data:` URL's)
        assert_eq!(commit_verdict(SameOrigin, UnsafeNone, "null", false, facts(false)), Ok((true, false)));
        assert_eq!(commit_verdict(SameOriginAllowPopups, UnsafeNone, "null", false, facts(true)), Ok((false, false)));
        // (…about:blank's or a blob's, inheriting)
        assert_eq!(commit_verdict(SameOriginPlusCoep, SameOriginPlusCoep, a, false, facts(false)), Ok((false, true)));
        assert_eq!(commit_verdict(SameOrigin, SameOrigin, b, false, facts(false)), Ok((true, false)));
        // (…what the hops needed stands, nothing asked)
        assert_eq!(commit_verdict(UnsafeNone, UnsafeNone, a, true, || Err(())), Ok((true, false)));
        assert_eq!(commit_verdict(UnsafeNone, SameOriginPlusCoep, a, true, || Err(())), Ok((true, true)));
    }

    fn origins(a: &str, b: &str) -> impl FnOnce() -> Result<(String, String), ()> {
        let pair = (a.to_owned(), b.to_owned());
        move || Ok(pair)
    }

    #[test]
    fn a_new_window_takes_its_creator_s_top_level_policy_only_of_that_one_s_origin() {
        use Value::*;
        assert_eq!(inherited(UnsafeNone, || Err(())), Ok(UnsafeNone));
        assert_eq!(inherited(SameOrigin, origins("http://a.test", "http://a.test")), Ok(SameOrigin));
        assert_eq!(inherited(SameOrigin, origins("http://b.test", "http://a.test")), Ok(UnsafeNone));
        assert_eq!(inherited(SameOrigin, origins("null", "null")), Ok(UnsafeNone));
    }

    #[test]
    fn only_a_same_origin_top_level_document_isolates_a_frame_of_another_origin_s_openings() {
        use Value::*;
        assert_eq!(isolates_opener(SameOrigin, origins("http://b.test", "http://a.test")), Ok(true));
        assert_eq!(isolates_opener(SameOriginPlusCoep, origins("http://b.test", "http://a.test")), Ok(true));
        assert_eq!(isolates_opener(SameOrigin, origins("http://a.test", "http://a.test")), Ok(false));
        assert_eq!(isolates_opener(SameOriginAllowPopups, || Err(())), Ok(false));
        assert_eq!(isolates_opener(UnsafeNone, || Err(())), Ok(false));
    }
}
