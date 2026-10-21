// A document's sandboxing flag set (HTML §7.6.5): what its container's `sandbox` attribute and every `sandbox` directive
// of its response's Content-Security-Policy restrict — each source a flag set of its own ("parse a sandboxing
// directive"), the document's their union, with the flags its parent's document has (HTML "determine the creation
// sandboxing flags") — one bit each.

const ASCII_WS: [char; 5] = ['\t', '\n', '\x0c', '\r', ' '];

pub(crate) const NAVIGATION: u32 = 1 << 0;
pub(crate) const AUXILIARY_NAVIGATION: u32 = 1 << 1;
pub(crate) const TOP_LEVEL_NAVIGATION: u32 = 1 << 2;
pub(crate) const TOP_LEVEL_NAVIGATION_BY_USER_ACTIVATION: u32 = 1 << 3;
pub(crate) const PLUGINS: u32 = 1 << 4;
pub(crate) const ORIGIN: u32 = 1 << 5;
pub(crate) const FORMS: u32 = 1 << 6;
pub(crate) const POINTER_LOCK: u32 = 1 << 7;
pub(crate) const SCRIPTS: u32 = 1 << 8;
pub(crate) const AUTOMATIC_FEATURES: u32 = 1 << 9;
pub(crate) const DOCUMENT_DOMAIN: u32 = 1 << 10;
pub(crate) const PROPAGATES_TO_AUXILIARY: u32 = 1 << 11;
pub(crate) const MODALS: u32 = 1 << 12;
pub(crate) const ORIENTATION_LOCK: u32 = 1 << 13;
pub(crate) const PRESENTATION: u32 = 1 << 14;
pub(crate) const DOWNLOADS: u32 = 1 << 15;
pub(crate) const CUSTOM_PROTOCOLS_NAVIGATION: u32 = 1 << 16;
pub(crate) const STORAGE_ACCESS_BY_USER_ACTIVATION: u32 = 1 << 17;

// HTML "parse a sandboxing directive": the flags a token list (an attribute's value, a directive's value) sets — every
// one, but those its tokens lift, split on ASCII whitespace and compared ASCII case-insensitively.
fn flags(tokens: &str) -> u32 {
    let has = |name: &str| tokens.split(ASCII_WS).any(|t| t.eq_ignore_ascii_case(name));
    let mut set = NAVIGATION | PLUGINS | DOCUMENT_DOMAIN;
    let mut unless = |token: bool, flag: u32| {
        if !token {
            set |= flag;
        }
    };
    unless(has("allow-popups"), AUXILIARY_NAVIGATION);
    unless(has("allow-top-navigation"), TOP_LEVEL_NAVIGATION);
    unless(has("allow-top-navigation-by-user-activation") || has("allow-top-navigation"), TOP_LEVEL_NAVIGATION_BY_USER_ACTIVATION);
    unless(has("allow-same-origin"), ORIGIN);
    unless(has("allow-forms"), FORMS);
    unless(has("allow-pointer-lock"), POINTER_LOCK);
    unless(has("allow-scripts"), SCRIPTS | AUTOMATIC_FEATURES);
    unless(has("allow-popups-to-escape-sandbox"), PROPAGATES_TO_AUXILIARY);
    unless(has("allow-modals"), MODALS);
    unless(has("allow-orientation-lock"), ORIENTATION_LOCK);
    unless(has("allow-presentation"), PRESENTATION);
    unless(has("allow-downloads"), DOWNLOADS);
    unless(
        has("allow-top-navigation-to-custom-protocols") || has("allow-popups") || has("allow-top-navigation"),
        CUSTOM_PROTOCOLS_NAVIGATION,
    );
    unless(has("allow-storage-access-by-user-activation"), STORAGE_ACCESS_BY_USER_ACTIVATION);
    set
}

// The `sandbox` directives a Content-Security-Policy header value declares: one per policy — its comma-separated
// policies all apply — the first `sandbox` of its `;`-separated directives, its value ('' for a bare one: every
// restriction, nothing granted).
fn csp_sandbox_directives(header: &str) -> Vec<&str> {
    header
        .split(',')
        .filter_map(|policy| {
            policy.split(';').find_map(|directive| {
                let directive = directive.trim_matches(ASCII_WS);
                let (name, value) = directive.split_once(ASCII_WS).unwrap_or((directive, ""));
                name.eq_ignore_ascii_case("sandbox").then(|| value.trim_matches(ASCII_WS))
            })
        })
        .collect()
}

// The flags a document its container's `sandbox` attribute (None for none) and its response's CSP (None for none)
// sandbox has of them — none where neither sandboxes it.
pub(crate) fn sandboxing(csp: Option<&str>, attribute: Option<&str>) -> u32 {
    csp.map(csp_sandbox_directives).unwrap_or_default().into_iter().chain(attribute).fold(0, |set, s| set | flags(s))
}

// …and whether its origin is an opaque one of them.
pub(crate) fn opaque_origin(csp: Option<&str>, attribute: Option<&str>) -> bool {
    sandboxing(csp, attribute) & ORIGIN != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sandbox_restricts_unless_every_source_grants_the_origin() {
        assert!(!opaque_origin(None, None));
        assert!(opaque_origin(None, Some("")));
        assert!(!opaque_origin(None, Some("allow-scripts ALLOW-SAME-ORIGIN")));
        assert!(opaque_origin(Some("default-src 'self'; SANDBOX allow-scripts"), None));
        assert!(!opaque_origin(Some("sandbox allow-same-origin; sandbox"), None));
        assert!(opaque_origin(Some("sandbox allow-same-origin, sandbox"), Some("allow-same-origin")));
        assert!(!opaque_origin(Some("script-src 'none'"), None));
    }

    #[test]
    fn a_token_lifts_its_flags_and_no_source_none() {
        assert_eq!(sandboxing(None, None), 0);
        let all = sandboxing(None, Some(""));
        assert!(all & SCRIPTS != 0 && all & AUXILIARY_NAVIGATION != 0 && all & PROPAGATES_TO_AUXILIARY != 0);
        let scripts = sandboxing(None, Some("ALLOW-SCRIPTS\tallow-popups"));
        assert_eq!(scripts & (SCRIPTS | AUTOMATIC_FEATURES | AUXILIARY_NAVIGATION | CUSTOM_PROTOCOLS_NAVIGATION), 0);
        assert!(scripts & FORMS != 0 && scripts & ORIGIN != 0 && scripts & NAVIGATION != 0);
        assert_eq!(sandboxing(None, Some("allow-top-navigation")) & (TOP_LEVEL_NAVIGATION | TOP_LEVEL_NAVIGATION_BY_USER_ACTIVATION), 0);
        // (…two sources, their union: what either restricts)
        assert!(sandboxing(Some("sandbox allow-scripts"), Some("allow-forms")) & (SCRIPTS | FORMS) == SCRIPTS | FORMS);
    }
}
