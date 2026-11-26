// What a service worker's `fetch` event is made of (Service Workers "Create Fetch Event and Dispatch"): the request — as
// the client made it, with what Fetch gives it before Handle Fetch runs — the client's id, the reserved client's, the one
// a navigation replaces, and a navigation's preload response. Made once, here, for every request a worker answers: a
// fetch()'s and an XHR's (and each hop of their chain: `SwChain`), an EventSource's, a subresource's, and those the host
// makes — a navigation's, a worker's main script's, its `importScripts()`'s and its module scripts', a classic or module
// script's the parser waits on. It crosses to the worker's isolate as JSON (workers.js `swDispatchFetch`, which builds
// `event.request` of it: request_state.rs `requestAdopt`).
//
// Fetch's own steps before Handle Fetch, decided here rather than by each maker: the `Accept` its destination gives a
// request whose header list has none ("fetch" step 12), and its referrer — Referrer Policy "determine request's referrer"
// of its referrer source under the policy it is made under (main fetch steps 7-9): `event.request.referrer` is what the
// network would have been sent, not the document URL.

use magnus::{prelude::*, r_hash::ForEach, Error, RHash, Ruby, TryConvert, Value};
use serde_json::{Map, Value as Json};

#[derive(Clone, Default)]
pub(crate) struct SwRequest {
    pub(crate) method: String,
    pub(crate) url: String,
    // (…each name as first given, its value a byte string as the code points its bytes are)
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body_b64: String,
    pub(crate) mode: String,
    pub(crate) destination: String,
    pub(crate) credentials: String,
    pub(crate) redirect: String,
    pub(crate) cache: String,
    pub(crate) integrity: String,
    pub(crate) keepalive: bool,
    // (…a fetch()'s, whose promise an opaque response's head settles)
    pub(crate) head_first: bool,
    // (…the determined referrer: '' no referrer; none where the request keeps its client's, `about:client`)
    pub(crate) referrer: Option<String>,
    pub(crate) referrer_policy: String,
    pub(crate) client_id: String,
    pub(crate) resulting_client_id: String,
    pub(crate) replaces_client_id: String,
    // A navigation's: its reload and history flags; its initiator origin, the Sec-Fetch-Site its chain latched and its
    // redirect-taint; the cookie verdicts of its target and of the hop intercepted — what a passthrough
    // `fetch(event.request)` reports as the navigation would have; and its preload response (JSON).
    pub(crate) reload_navigation: bool,
    pub(crate) history_navigation: bool,
    pub(crate) initiator: Option<String>,
    pub(crate) site_seed: Option<String>,
    pub(crate) origin_null: bool,
    pub(crate) cookie_cross_site: bool,
    pub(crate) navigation_cross_site: bool,
    pub(crate) preload: Option<Json>,
}

impl SwRequest {
    // Its referrer determined of `source` under `policy` (its own, its container's, else the default), for its URL.
    pub(crate) fn refer(&mut self, policy: &str, source: &str) {
        self.referrer = Some(crate::referrer::request_referrer(policy, source, &self.url).unwrap_or_default());
    }
    // Fetch "fetch" step 12: its destination's `Accept`, where it has none.
    pub(crate) fn accept_default(&mut self) {
        if !self.headers.iter().any(|(n, _)| n.eq_ignore_ascii_case("accept")) {
            self.headers.push(("Accept".to_owned(), crate::fetch_rules::default_accept(&self.destination).to_owned()));
        }
    }
    // As the wire carries it: what is given of it — a member absent, an empty text and a false flag alike, leave the
    // worker's request as a Request makes it (`requestAdopt`) — but its referrer, whose empty text is no referrer.
    pub(crate) fn wire(&self) -> String {
        let mut o = Map::new();
        o.insert("method".into(), Json::from(self.method.as_str()));
        o.insert("url".into(), Json::from(self.url.as_str()));
        let headers: Map<String, Json> = self.headers.iter().map(|(n, v)| (n.clone(), Json::from(v.as_str()))).collect();
        o.insert("headers".into(), Json::Object(headers));
        o.insert("body_b64".into(), Json::from(self.body_b64.as_str()));
        let texts = [
            ("mode", &self.mode),
            ("destination", &self.destination),
            ("credentials", &self.credentials),
            ("redirect", &self.redirect),
            ("cache", &self.cache),
            ("integrity", &self.integrity),
            ("referrerPolicy", &self.referrer_policy),
            ("clientId", &self.client_id),
            ("resultingClientId", &self.resulting_client_id),
            ("replacesClientId", &self.replaces_client_id),
        ];
        for (key, value) in texts {
            if !value.is_empty() {
                o.insert(key.into(), Json::from(value.as_str()));
            }
        }
        if let Some(referrer) = &self.referrer {
            o.insert("referrer".into(), Json::from(referrer.as_str()));
        }
        for (key, value) in [("initiator", &self.initiator), ("siteSeed", &self.site_seed)] {
            if let Some(value) = value {
                o.insert(key.into(), Json::from(value.as_str()));
            }
        }
        let flags = [
            ("keepalive", self.keepalive),
            ("headFirst", self.head_first),
            ("isReloadNavigation", self.reload_navigation),
            ("isHistoryNavigation", self.history_navigation),
            ("originNull", self.origin_null),
            ("cookieCrossSite", self.cookie_cross_site),
            ("navigationCrossSite", self.navigation_cross_site),
        ];
        for (key, on) in flags {
            if on {
                o.insert(key.into(), Json::Bool(true));
            }
        }
        if let Some(preload) = &self.preload {
            o.insert("preloadResponse".into(), preload.clone());
        }
        Json::Object(o).to_string()
    }
}

// Native.sw_request(params) -> the wire of the request the host hands a service worker, its `kind` the algorithm that
// makes it, which says what the request is where `params` does not:
// - "navigate": HTML "create navigation params by fetching" — mode navigate, redirect manual (a passthrough
//   `fetch(event.request)` of a redirect yields an opaque redirect, which the navigation follows), its cache mode a
//   reload's `no-cache`, its referrer policy the default where its initiator gave none;
// - "worker" / "sharedworker": "fetch a classic worker script" — a same-origin request of that destination;
// - "import": "fetch a classic worker-imported script" — no-cors, a script;
// - "module": "fetch a single module script" — cors;
// - "script": a script, a style sheet or an image the parser or a module graph waits on, as its plan made it.
// Credentials `same-origin` but where given (a navigation's none: `requestAdopt` gives it `include`).
// `params` (symbol keys): `kind`, `url`, `method` (GET), `headers` (a Hash), `body` (its bytes), `destination`, `mode`,
// `credentials`, `integrity`, `referrer_source` (nil for none; the key absent, the request's referrer its client,
// `about:client`) and the `referrer_policy` it is made under, `reload`, `history`, `initiator`, `site_seed`, `origin_null`, `cookie_cross_site`,
// `navigation_cross_site`, `client_id`, `resulting_client_id`, `replaces_client_id`, `preload` (its JSON).
pub(crate) fn sw_request_for_ruby(ruby: &Ruby, params: RHash) -> Result<String, Error> {
    let get = |key: &str| params.aref::<_, Value>(ruby.to_symbol(key));
    let text = |key: &str| -> Result<String, Error> { Ok(Option::<String>::try_convert(get(key)?)?.unwrap_or_default()) };
    let option = |key: &str| -> Result<Option<String>, Error> { Option::<String>::try_convert(get(key)?) };
    let flag = |key: &str| -> Result<bool, Error> { Ok(get(key)?.to_bool()) };
    let kind = text("kind")?;
    let mut r = SwRequest {
        method: option("method")?.filter(|m| !m.is_empty()).map_or_else(|| "GET".to_owned(), |m| m.to_ascii_uppercase()),
        url: text("url")?,
        destination: text("destination")?,
        mode: text("mode")?,
        credentials: text("credentials")?,
        integrity: text("integrity")?,
        reload_navigation: flag("reload")?,
        history_navigation: flag("history")?,
        initiator: option("initiator")?,
        site_seed: option("site_seed")?,
        origin_null: flag("origin_null")?,
        cookie_cross_site: flag("cookie_cross_site")?,
        navigation_cross_site: flag("navigation_cross_site")?,
        client_id: text("client_id")?,
        resulting_client_id: text("resulting_client_id")?,
        replaces_client_id: text("replaces_client_id")?,
        ..SwRequest::default()
    };
    if let Some(headers) = Option::<RHash>::try_convert(get("headers")?)? {
        headers.foreach(|name: String, value: String| {
            r.headers.push((name, value));
            Ok(ForEach::Continue)
        })?;
    }
    if let Some(body) = Option::<magnus::RString>::try_convert(get("body")?)? {
        // SAFETY: the bytes are copied out before any Ruby code runs.
        r.body_b64 = crate::data_url::base64_encode(unsafe { body.as_slice() });
    }
    if let Some(preload) = option("preload")? {
        r.preload = serde_json::from_str(&preload).ok();
    }
    let given = |slot: &mut String, value: &str| {
        if slot.is_empty() {
            value.clone_into(slot);
        }
    };
    match kind.as_str() {
        "navigate" => {
            given(&mut r.mode, "navigate");
            given(&mut r.redirect, "manual");
            given(&mut r.cache, if r.reload_navigation { "no-cache" } else { "default" });
        }
        "worker" | "sharedworker" => {
            given(&mut r.mode, "same-origin");
            given(&mut r.destination, &kind);
        }
        "import" => {
            given(&mut r.mode, "no-cors");
            given(&mut r.destination, "script");
        }
        "module" => given(&mut r.mode, "cors"),
        _ => {}
    }
    if kind != "navigate" {
        given(&mut r.credentials, "same-origin");
    }
    // (…a referrer source given as none — a navigation the user began — no referrer at all)
    if let Some(source) = params.get(ruby.to_symbol("referrer_source")) {
        let own = text("referrer_policy")?;
        let policy = crate::fetch_request::request_policy(&own, "");
        match Option::<String>::try_convert(source)? {
            Some(source) => r.refer(policy, &source),
            None => r.referrer = Some(String::new()),
        }
        policy.clone_into(&mut r.referrer_policy);
    }
    r.accept_default();
    if r.method == "GET" || r.method == "HEAD" {
        r.body_b64.clear();
    }
    Ok(r.wire())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wire_carries_what_is_given_and_a_referrer_even_none() {
        let mut r = SwRequest { method: "GET".into(), url: "https://a.test/x".into(), destination: "image".into(), ..SwRequest::default() };
        r.accept_default();
        r.refer("no-referrer", "https://a.test/page");
        let wire: Json = serde_json::from_str(&r.wire()).unwrap();
        assert_eq!(wire["headers"]["Accept"], crate::fetch_rules::default_accept("image"));
        assert_eq!(wire["referrer"], "");
        assert!(wire.get("mode").is_none());
        assert!(wire.get("keepalive").is_none());
    }

    #[test]
    fn an_accept_given_is_kept() {
        let mut r = SwRequest { headers: vec![("accept".into(), "text/x".into())], ..SwRequest::default() };
        r.accept_default();
        assert_eq!(r.headers, [("accept".to_owned(), "text/x".to_owned())]);
    }

    #[test]
    fn a_referrer_is_the_one_its_policy_sends() {
        let mut r = SwRequest { url: "https://b.test/".into(), ..SwRequest::default() };
        r.refer("strict-origin-when-cross-origin", "https://a.test/p?q");
        assert_eq!(r.referrer.as_deref(), Some("https://a.test/"));
    }
}
