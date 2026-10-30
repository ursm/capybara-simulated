// A request as a chain of hops carries it (Fetch "main fetch" → "HTTP-redirect fetch"): its method, its URL, its header
// list, whether its body is gone, the origin its hops send (`null` once a redirect tainted it), its referrer source and
// policy, whether it has been redirected and how many times it has been dispatched — and the two steps every chain takes
// whatever fetches it: the Referer a hop sends (its policy over the source the previous hop left), and a redirect
// followed (the request moved on to the Location: its method and body, its `Authorization`, its origin). A subresource
// fetch's plan (fetch_plan.rs) and a navigation's both carry one.

use crate::fetch_rules::{follow_redirect, request_body_header, Redirected, Redirecting};

pub(crate) type Headers = Vec<(Vec<u8>, Vec<u8>)>;

// Fetch caps a chain at 20 redirects: the 21st is a network error (its 22nd dispatch never made).
pub(crate) const MAX_REDIRECTS: u32 = 20;

pub(crate) struct RequestChain {
    pub(crate) method: String,
    pub(crate) target: String,
    pub(crate) headers: Headers,
    pub(crate) body_empty: bool,
    pub(crate) effective_origin: Option<String>,
    pub(crate) ref_policy: Option<String>,
    pub(crate) ref_source: Option<String>,
    pub(crate) redirected: bool,
    pub(crate) dispatches: u32,
}

// What a redirect makes of the chain: no redirect after all (its Location none — the response is the answer), a
// network error, or the next hop (the URL it was followed from, and whether its body went).
pub(crate) enum Followed {
    Answer,
    Fail,
    Follow(String, bool),
}

// How the request is judged as it is redirected: whether it is a CORS request, its origin, whether its response is
// tainted "cors" by now (a cross-origin hop's).
pub(crate) struct Judged<'a> {
    pub(crate) cors: bool,
    pub(crate) origin: &'a str,
    pub(crate) tainting_cors: bool,
}

// (…a header's bytes as URL text: as they are where they are UTF-8, else each byte past ASCII percent-encoded — what
// Chrome sends for a Location of bytes no UTF-8, redirect-location-escape)
fn url_text(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_owned(),
        Err(_) => bytes.iter().map(|&b| if b < 0x80 { (b as char).to_string() } else { format!("%{b:02X}") }).collect(),
    }
}

impl RequestChain {
    // Another dispatch, None where it would be the 22nd — past the 20 redirects a chain follows (a network error).
    pub(crate) fn dispatch(&mut self) -> Option<()> {
        self.dispatches += 1;
        (self.dispatches <= MAX_REDIRECTS + 1).then_some(())
    }

    // The Referer this hop sends: its policy over the source the previous hop left (redirect-referrer-override).
    pub(crate) fn referer(&self) -> Option<String> {
        let source = self.ref_source.as_deref()?;
        crate::referrer::request_referrer(self.ref_policy.as_deref().unwrap_or(""), source, &self.target)
    }

    // Fetch "HTTP-redirect fetch" over a redirect of `status` whose Location fields are `locations`, the request moved on
    // where it is followed: its URL, its method and body, its `Authorization` and request-body headers, its origin.
    pub(crate) fn follow(&mut self, status: u32, locations: &[Vec<u8>], judged: &Judged<'_>) -> Followed {
        let mut distinct: Vec<&Vec<u8>> = Vec::new();
        for l in locations {
            if !distinct.contains(&l) {
                distinct.push(l);
            }
        }
        // (…a Location given more than once, differently, a network error: "extract header list values")
        if distinct.len() > 1 {
            return Followed::Fail;
        }
        let location = distinct.first().map(|b| url_text(b));
        let request = Redirecting {
            method: self.method.as_bytes(),
            current: &self.target,
            cors_mode: judged.cors,
            origin: judged.origin,
            tainting_cors: judged.tainting_cors,
            tainted_origin: self.effective_origin.as_deref() == Some("null"),
        };
        let step = match follow_redirect(&request, status, &self.target, location.as_deref()) {
            Redirected::Answer => return Followed::Answer,
            Redirected::Fail(_) => return Followed::Fail,
            Redirected::Follow(step) => step,
        };
        let from = std::mem::replace(&mut self.target, step.url);
        self.redirected = true;
        if step.tainted_origin {
            self.effective_origin = Some("null".to_owned());
        }
        if step.drop_authorization {
            self.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(b"authorization"));
        }
        if step.to_get {
            self.method = "GET".to_owned();
            self.body_empty = true;
            self.headers.retain(|(k, _)| !request_body_header(k) && !k.eq_ignore_ascii_case(b"content-length"));
        }
        Followed::Follow(from, step.to_get)
    }

    // …and the next hop's referrer: its source the Referer this hop sent (Fetch "main fetch": the request's referrer the
    // one determined), its policy a redirect's `Referrer-Policy` where it set one.
    pub(crate) fn refer_on(&mut self, sent: Option<String>, policy: Option<String>) {
        self.ref_source = sent;
        if policy.is_some() {
            self.ref_policy = policy;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain(method: &str, target: &str) -> RequestChain {
        RequestChain {
            method: method.to_owned(),
            target: target.to_owned(),
            headers: vec![(b"Content-Type".to_vec(), b"text/plain".to_vec()), (b"Authorization".to_vec(), b"Basic x".to_vec())],
            body_empty: false,
            effective_origin: Some("http://a.test".to_owned()),
            ref_policy: None,
            ref_source: Some("http://a.test/page".to_owned()),
            redirected: false,
            dispatches: 0,
        }
    }
    const SAME: Judged<'static> = Judged { cors: false, origin: "http://a.test", tainting_cors: false };

    #[test]
    fn a_303_makes_a_post_a_get_and_drops_its_body() {
        let mut c = chain("POST", "http://a.test/form");
        assert!(matches!(c.follow(303, &[b"/done".to_vec()], &SAME), Followed::Follow(_, true)));
        assert_eq!((c.method.as_str(), c.target.as_str(), c.body_empty, c.redirected), ("GET", "http://a.test/done", true, true));
        assert!(!c.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(b"content-type")));
    }

    #[test]
    fn a_307_keeps_the_post_and_a_cross_origin_one_taints_the_origin_and_drops_authorization() {
        let mut c = chain("POST", "http://a.test/form");
        assert!(matches!(c.follow(307, &[b"http://b.test/x".to_vec()], &SAME), Followed::Follow(_, false)));
        assert_eq!(c.method, "POST");
        assert!(!c.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(b"authorization")));
        assert!(matches!(c.follow(307, &[b"http://a.test/y".to_vec()], &SAME), Followed::Follow(..)));
        assert_eq!(c.effective_origin.as_deref(), Some("null"));
    }

    #[test]
    fn a_redirect_policy_narrows_the_next_hops_referer() {
        let mut c = chain("GET", "http://a.test/one");
        assert_eq!(c.referer().as_deref(), Some("http://a.test/page"));
        let sent = c.referer();
        assert!(matches!(c.follow(302, &[b"http://b.test/two".to_vec()], &SAME), Followed::Follow(..)));
        c.refer_on(sent, Some("origin".to_owned()));
        assert_eq!(c.referer().as_deref(), Some("http://a.test/"));
    }

    #[test]
    fn locations_that_differ_fail_and_none_is_the_answer() {
        let mut c = chain("GET", "http://a.test/one");
        assert!(matches!(c.follow(302, &[b"/a".to_vec(), b"/b".to_vec()], &SAME), Followed::Fail));
        assert!(matches!(c.follow(302, &[], &SAME), Followed::Answer));
        assert!((0..21).all(|_| c.dispatch().is_some()));
        assert!(c.dispatch().is_none());
    }
}
