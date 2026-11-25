// Permissions Policy (W3C Permissions Policy §9) as a frame's container declares it: whether a document "is allowed to
// use" a feature whose default allowlist is 'self' — the Web Authentication ceremonies' (webauthn.rs) and HTML's
// "focus-without-user-activation" (focus.rs `allow_focus_steps`).

use crate::dom::RealmArena;

// A container's declared origin (Permissions Policy "declared origin"): none, opaque, for a sandboxed document or
// `sandbox` attribute without `allow-same-origin`; its document's origin (`parent`) for `srcdoc`, no `src` or one that
// does not parse; else the origin of its `src`, relative to its document (`base`) — none for a `data:` URL's, as an
// opaque origin matches no other, though both serialize to "null".
fn declared_origin(parent: &str, sandbox: Option<&str>, srcdoc: bool, src: Option<&str>, base: &str) -> Option<String> {
    if parent == "null" || crate::sandbox::opaque_origin(None, sandbox) {
        return None;
    }
    let parsed = src.filter(|_| !srcdoc).and_then(|src| ada_url::Url::parse(src, Some(base)).ok());
    Some(parsed.map_or_else(|| parent.to_owned(), |url| url.origin().to_owned())).filter(|origin| origin != "null")
}
// What an iframe's `allow` attribute says of `feature` for a document of origin `own` in it: none where it does not name
// it. Its allowlist — `'src'` where it gives none — is `*`, `'self'` (the container document's origin, `parent`), `'src'`
// (its declared origin), `'none'` or origins.
fn allow_attribute_grants(allow: &str, feature: &str, own: &str, parent: &str, declared: Option<&str>) -> Option<bool> {
    let directive = allow.split(';').find(|directive| directive.split_ascii_whitespace().next() == Some(feature))?;
    let mut members = directive.split_ascii_whitespace().skip(1).peekable();
    if members.peek().is_none() {
        return Some(declared == Some(own));
    }
    Some(members.any(|member| match member {
        "*" => true,
        "'self'" => own == parent,
        "'src'" => declared == Some(own),
        "'none'" => false,
        origin => crate::referrer::http_origin(origin).as_deref() == Some(own),
    }))
}
// Whether realm `realm`'s document "is allowed to use" `feature`, whose default allowlist is 'self': at each frame up to
// the top-level document, the container's `allow` attribute where it names the feature, else the frame's being same
// origin with its parent. (A `Permissions-Policy` response header, which no document's policy here is read from, is a
// gap: only an attribute can narrow or delegate a feature.)
pub(crate) fn allowed_to_use(arena: &mut RealmArena, realm: i32, feature: &str) -> bool {
    let mut frame = realm;
    while let Some(parent) = arena.parent_realm(frame) {
        let keys = (crate::referrer::known_origin_key(arena, frame), crate::referrer::known_origin_key(arena, parent));
        let origins = (crate::referrer::known_document(arena, frame), crate::referrer::known_document(arena, parent));
        let (Some(own), Some(parent_origin)) = origins else { return false };
        let same_origin = keys.0.is_some() && keys.0 == keys.1;
        let container = arena.frame_container(parent, frame);
        let base = container.and_then(|c| arena.get(c)).and_then(|_| arena.realm_document(parent)).map(|doc| arena.document_base_url(doc)).unwrap_or_default();
        let node = container.and_then(|c| arena.get(c));
        let declared = node.and_then(|c| declared_origin(&parent_origin, c.plain_attr("sandbox"), c.plain_attr("srcdoc").is_some(), c.plain_attr("src"), &base));
        let named = node.and_then(|c| c.plain_attr("allow")).and_then(|allow| allow_attribute_grants(allow, feature, &own, &parent_origin, declared.as_deref()));
        if !named.unwrap_or(same_origin) {
            return false;
        }
        frame = parent;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_allow_attribute_says_who_may_use_a_feature() {
        const F: &str = "publickey-credentials-get";
        let (own, parent) = ("https://b.test", "https://a.test");
        let grants = |allow: &str, declared: Option<&str>| allow_attribute_grants(allow, F, own, parent, declared);
        assert_eq!(grants("fullscreen", Some(own)), None);
        assert_eq!(grants("publickey-credentials-getter", Some(own)), None);
        assert_eq!(grants("publickey-credentials-get", Some(own)), Some(true));
        assert_eq!(grants("publickey-credentials-get", Some("https://c.test")), Some(false));
        assert_eq!(grants("fullscreen *; publickey-credentials-get *", None), Some(true));
        assert_eq!(grants("publickey-credentials-get 'none'", Some(own)), Some(false));
        assert_eq!(grants("publickey-credentials-get 'self'", Some(own)), Some(false));
        assert_eq!(allow_attribute_grants("publickey-credentials-get 'self'", F, parent, parent, None), Some(true));
        assert_eq!(grants("publickey-credentials-get 'src'", Some(own)), Some(true));
        assert_eq!(grants("publickey-credentials-get https://c.test https://b.test", None), Some(true));
        assert_eq!(grants("publickey-credentials-get https://c.test", None), Some(false));
    }

    #[test]
    fn a_declared_origin_is_where_a_frame_says_it_loads_from() {
        let declared = |sandbox, srcdoc, src| declared_origin("https://a.test", sandbox, srcdoc, src, "https://base.test/dir/");
        assert_eq!(declared(None, false, None).as_deref(), Some("https://a.test"));
        assert_eq!(declared(None, true, Some("https://b.test/")).as_deref(), Some("https://a.test"));
        assert_eq!(declared(None, false, Some("https://b.test/x")).as_deref(), Some("https://b.test"));
        assert_eq!(declared(None, false, Some("/x")).as_deref(), Some("https://base.test"));
        assert_eq!(declared(None, false, Some("http://[")).as_deref(), Some("https://a.test"));
        assert_eq!(declared(Some("allow-scripts"), false, None), None);
        assert_eq!(declared(Some("allow-same-origin"), false, None).as_deref(), Some("https://a.test"));
        assert_eq!(declared_origin("null", None, false, None, ""), None);
        assert_eq!(declared(None, false, Some("data:text/html,x")), None);
    }
}
