// HTML "create and initialize a Document object" — what the document a navigation commits is made of, decided once for
// every navigable the host makes one in: the page (its top-level traversable), a window `window.open` made in an isolate,
// a frame. The host (browser.rb / v8_runtime.rb) keeps the realm it loads into — a new one, or the initial about:blank's
// whose Window it keeps (`keeps_window`) — and the parse; what the document is OF is this:
// - what its response says (response_headers.rs `ResponseFields`): its type, its Refresh, whether it asks for an
//   origin-keyed agent cluster, its opener policy — none of an inline content document's (a PDF's viewer's) nor an error
//   document's, which HTML makes of no response's policy;
// - its policy container (HTML "determine navigation params policy container"): its CSP list and referrer policy;
// - its referrer, the request's (HTML step 15);
// - its origin where its URL does not say it (an about:blank one's its initiator's, an error document's a new opaque
//   one), and the origin its response's opener policy is judged by (`response_origin`);
// - the service worker that controls it (Service Workers §2.5.1 "Window client").

use magnus::{prelude::*, Error, RHash, Ruby, TryConvert, Value};

use crate::response_headers::ResponseFields;

// A policy container as the host has one (HTML §7.1.7): its CSP list as script reads it (every Content-Security-Policy
// header's value, joined) and its referrer policy ("" the default one).
#[derive(Clone, Default, Debug, PartialEq)]
pub(crate) struct PolicyContainer {
    pub(crate) csp: Option<String>,
    pub(crate) referrer_policy: String,
}

// Whether `url` is local (Fetch: its scheme "about", "blob" or "data").
fn is_local(url: &str) -> bool {
    let scheme = url.split_once(':').map_or("", |(s, _)| s);
    ["about", "blob", "data"].iter().any(|l| scheme.eq_ignore_ascii_case(l))
}
fn is_srcdoc(url: &str) -> bool {
    ada_url::Url::parse(url, None).is_ok_and(|u| u.protocol() == "about:" && u.pathname() == "srcdoc")
}

// HTML "determine navigation params policy container" (§7.1.7): about:srcdoc its parent's, cloned; a local URL its
// initiator's, cloned, where it has one; else its response's — a new one where none is given (an error document's, an
// inline content document's: `response` None). (Not modelled: step 1's history policy container — a traversal back to a
// local URL's entry takes its initiator's as the navigation gives it, none stored with the entry.)
pub(crate) fn policy_container(url: &str, initiator: Option<&PolicyContainer>, parent: Option<&PolicyContainer>, response: Option<PolicyContainer>) -> PolicyContainer {
    if is_srcdoc(url) {
        if let Some(parent) = parent {
            return parent.clone();
        }
    }
    if is_local(url) {
        if let Some(initiator) = initiator {
            return initiator.clone();
        }
    }
    response.unwrap_or_default()
}

// The origin of `url` serialized — a `blob:` URL's its inner URL's — None where it is opaque.
pub(crate) fn url_origin(url: &str) -> Option<String> {
    let u = ada_url::Url::parse(url, None).ok()?;
    let origin = u.origin();
    (origin != "null").then_some(origin)
}

// Service Workers §2.5.1 "Window client", created on navigation: "If the fetch is routed through HTTP fetch" the
// registration matching's active worker (the reserved client's, Handle Fetch step 9.1.8: an activating one too) —
// "Otherwise, if the created document's origin is an opaque origin or not the same as its creator document's origin"
// none, else its creator document's client's. A sandboxed document's, of an opaque origin, none either ("Sandboxed
// iframes … result in having the active service worker value of null as their origin is an opaque origin"), whose
// navigation the worker answered all the same: its sandbox is its response's to say (WPT sandboxed-iframe-fetch-event).
// A worker still activating that handles fetches, the navigation having given up waiting for it and gone to the
// network (browser.rb `sw_activation_awaited`, CLAUDE.md's accepted cost), controls none: Create Fetch Event and Dispatch
// step 15 would have waited for it.
#[derive(Debug, PartialEq)]
pub(crate) enum Control<'a> {
    Fetched { site: &'a str },
    Created { creator: Option<(&'a str, &'a str)> },
}
pub(crate) type Controller = (u32, bool, String, String);
fn controller(partition: u64, url: &str, origin: Option<&str>, control: Control<'_>) -> Option<Controller> {
    let origin = origin?;
    match control {
        Control::Fetched { site } => {
            let found = crate::sw_registry::match_worker_for_ruby(partition, site.to_owned(), url.to_owned(), "client".to_owned())?;
            (!found.1 || crate::sw_registry::worker_activated_for_ruby(partition, found.0)).then_some(found)
        }
        Control::Created { creator: Some((client, creator_origin)) } if creator_origin == origin => crate::sw_registry::client_controller(partition, client),
        Control::Created { .. } => None,
    }
}

// HTML "create and initialize a Document object" step 7: the document a navigation makes keeps the Window of the one it
// replaces where that is its navigable's initial about:blank (`initial`) and its origin (`own`) "same origin-domain"
// with the new document's (`origin`) — a tuple origin of no domain set (`domain_set`: a `document.domain` write of its
// creator's, which it shares), the new one's a new record of none — none where the response's `csp` sandboxes it into a
// new opaque origin. (CLAUDE.md: the Document object is kept too, renewed — dom-nodes.js `renewDocument`.)
pub(crate) fn keeps_window(initial: bool, own: &str, domain_set: bool, origin: Option<&str>, csp: Option<&str>) -> bool {
    let sandboxed = crate::sandbox::sandboxing(csp, None) & crate::sandbox::ORIGIN != 0;
    initial && !sandboxed && !domain_set && own != "null" && origin == Some(own)
}

// Native.initialize_document(params) -> what the document a navigation commits is made of, keyed as the bindings read it
// (bridge.entry.js `initializeDocument`): 'url', 'contentType', 'csp', 'referrer', 'referrerPolicy', 'refresh',
// 'originAgentCluster', 'origin' (where its URL does not say it: 'null' a new opaque one), 'locationOrigin', 'aboutBase',
// 'controller', and, for the
// host's commit of its opener policy (session_history.rs `commit_opener_policy`), 'openerPolicy' and 'responseOrigin'.
// `params` (symbol keys): `url`; `headers` its response's (nil none: a document of no response, or whose response's
// policies it is made of none — `inline`); `content_type` the type its body said or it is made as, over its response's;
// `loopback` the host's stand-in for a secure context; `origin` its origin where its URL does not say it, with the
// origin its location reports (`location_origin`, an about:blank one's its initiator's) and its base URL (`about_base`);
// `fields` in place of `headers`, `[Referrer-Policy, Refresh, origin-keyed]`, a frame's response as its build read it;
// `referrer` the Referer its request sent; `initiator` / `parent` the policy containers `[referrer policy, csp]` of the
// document that initiated it and of its container's; `coop` the opener policy a local scheme's inherits;
// `sw` `[partition, site]` where a fetch made it, `[partition, nil, creator client id, creator origin]` where none did,
// nil where no worker may control it (a `javascript:` URL's document).
pub(crate) fn initialize_document(ruby: &Ruby, params: RHash) -> Result<RHash, Error> {
    let get = |key: &str| params.aref::<_, Value>(ruby.to_symbol(key));
    let text = |key: &str| -> Result<Option<String>, Error> { Option::<String>::try_convert(get(key)?) };
    let container = |key: &str| -> Result<Option<PolicyContainer>, Error> {
        Ok(Option::<(Option<String>, Option<String>)>::try_convert(get(key)?)?.map(|(p, csp)| PolicyContainer { csp: csp.filter(|c| !c.is_empty()), referrer_policy: p.unwrap_or_default() }))
    };
    let url = text("url")?.unwrap_or_default();
    let inline = get("inline")?.to_bool();
    let headers: Option<Value> = Option::try_convert(get("headers")?)?;
    let mut fields = ResponseFields::read(headers)?;
    // (…or, a frame's response as its build read it — frame_response.rs `frameResponse` — the fields it gave: its
    // Referrer-Policy, its Refresh, whether it asked for an origin-keyed agent cluster)
    let given = Option::<(Option<String>, Option<String>, bool)>::try_convert(get("fields")?)?;
    if let Some((policy, refresh, origin_agent_cluster)) = &given {
        fields.referrer_policy = policy.as_deref().and_then(crate::url_ops::policy_of_header);
        (fields.refresh, fields.origin_agent_cluster) = (refresh.clone(), *origin_agent_cluster);
    }
    let response = (!inline && (headers.is_some() || given.is_some())).then(|| PolicyContainer { csp: fields.csp.clone(), referrer_policy: fields.referrer_policy.unwrap_or_default().to_owned() });
    let policies = policy_container(&url, container("initiator")?.as_ref(), container("parent")?.as_ref(), response);
    let given_origin = text("origin")?;
    let coop = text("coop")?;
    // (…the origin its response's opener policy is judged by: its own, but an inline content document's of a `blob:` URL,
    // whose policy is its blob's, its URL's though its viewer's document is opaque)
    let response_origin = match (&given_origin, inline && coop.is_some()) {
        (Some(o), false) => Some(o.clone()),
        _ => url_origin(&url),
    };
    // (…the origin it is of, as a worker controlling it is judged by — none an opaque one, its policy container's
    // `sandbox` making it so too: realm_location.rs `seedTopLevelDocument`, frame_response.rs)
    let sandboxed = crate::sandbox::sandboxing(policies.csp.as_deref(), None) & crate::sandbox::ORIGIN != 0;
    let origin = given_origin.clone().or_else(|| url_origin(&url)).filter(|o| o != "null" && !sandboxed);
    let loopback = get("loopback")?.to_bool();
    let opener_policy = coop.unwrap_or_else(|| if inline { "unsafe-none".to_owned() } else { fields.opener_policy(&url, loopback).name().to_owned() });

    let out = ruby.hash_new();
    out.aset("url", url.as_str())?;
    let content_type = text("content_type")?.filter(|t| !t.is_empty()).or_else(|| if inline { Some("text/html".to_owned()) } else { fields.content_type.clone().filter(|t| !t.is_empty()) });
    out.aset("contentType", content_type)?;
    out.aset("csp", policies.csp)?;
    out.aset("referrerPolicy", policies.referrer_policy)?;
    out.aset("referrer", text("referrer")?.filter(|r| !r.is_empty()))?;
    out.aset("refresh", if inline { None } else { fields.refresh.clone() })?;
    out.aset("originAgentCluster", !inline && fields.origin_agent_cluster)?;
    out.aset("origin", given_origin)?;
    out.aset("locationOrigin", text("location_origin")?)?;
    out.aset("aboutBase", text("about_base")?.filter(|b| !b.is_empty()))?;
    let sw = match Option::<magnus::RArray>::try_convert(get("sw")?)? {
        Some(a) => Some((a.entry::<u64>(0)?, a.entry::<Option<String>>(1)?, a.entry::<Option<String>>(2)?, a.entry::<Option<String>>(3)?)),
        None => None,
    };
    let found = sw.as_ref().and_then(|(partition, site, client, creator_origin)| {
        let control = match site {
            Some(site) => Control::Fetched { site },
            None => Control::Created { creator: client.as_deref().zip(creator_origin.as_deref()) },
        };
        controller(*partition, &url, origin.as_deref(), control)
    });
    out.aset("controller", found)?;
    out.aset("openerPolicy", opener_policy)?;
    out.aset("responseOrigin", response_origin.unwrap_or_else(|| "null".to_owned()))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pc(policy: &str) -> PolicyContainer {
        PolicyContainer { csp: None, referrer_policy: policy.to_owned() }
    }

    #[test]
    fn a_local_url_takes_its_initiators_policy_container_and_srcdoc_its_parents() {
        let (initiator, parent, response) = (pc("no-referrer"), pc("origin"), pc("same-origin"));
        assert_eq!(policy_container("about:blank", Some(&initiator), Some(&parent), None), initiator);
        assert_eq!(policy_container("blob:https://a.test/x", Some(&initiator), None, Some(response.clone())), initiator);
        assert_eq!(policy_container("data:text/html,x", Some(&initiator), None, Some(response.clone())), initiator);
        assert_eq!(policy_container("about:srcdoc", Some(&initiator), Some(&parent), None), parent);
        assert_eq!(policy_container("https://a.test/", Some(&initiator), Some(&parent), Some(response.clone())), response);
        // (…a local URL no document initiated: its response's, else a new one)
        assert_eq!(policy_container("about:blank", None, None, None), PolicyContainer::default());
    }

    #[test]
    fn an_initial_about_blanks_window_is_kept_for_a_document_of_its_origin_only() {
        assert!(keeps_window(true, "https://a.test", false, Some("https://a.test"), None));
        assert!(!keeps_window(false, "https://a.test", false, Some("https://a.test"), None));
        assert!(!keeps_window(true, "https://a.test", false, Some("https://b.test"), None));
        assert!(!keeps_window(true, "https://a.test", true, Some("https://a.test"), None));
        assert!(!keeps_window(true, "null", false, Some("null"), None));
        // (…a sandbox that keeps its origin keeps it; one that makes it opaque, not)
        assert!(keeps_window(true, "https://a.test", false, Some("https://a.test"), Some("sandbox allow-same-origin allow-scripts")));
        assert!(!keeps_window(true, "https://a.test", false, Some("https://a.test"), Some("sandbox allow-scripts")));
    }

    #[test]
    fn origins_are_their_urls_a_blobs_its_inner_ones() {
        assert_eq!(url_origin("https://a.test:443/x").as_deref(), Some("https://a.test"));
        assert_eq!(url_origin("blob:https://a.test/uuid").as_deref(), Some("https://a.test"));
        assert_eq!(url_origin("about:blank"), None);
        assert_eq!(url_origin("data:text/html,x"), None);
    }

    #[test]
    fn a_document_of_another_origin_than_its_creator_or_of_an_opaque_one_is_controlled_by_none() {
        let creator = Control::Created { creator: Some(("c1", "https://a.test")) };
        assert_eq!(controller(u64::MAX, "about:blank", None, creator), None);
        let creator = Control::Created { creator: Some(("c1", "https://a.test")) };
        assert_eq!(controller(u64::MAX, "blob:https://b.test/x", Some("https://b.test"), creator), None);
    }
}
