// A worker's main script fetch, hop by hop (HTML "fetch a classic worker script" / "fetch a module worker script graph":
// a same-origin GET, its redirects followed — Fetch "HTTP-redirect fetch"): the request as it stands (fetch_chain.rs), the
// origin it must stay at (its mode `same-origin`: a hop to another is a network error), and whether a service worker may
// still answer its next hop — each through the one whose scope it is in until a hop has gone to the network, from which
// on none sees the chain (Service Workers "Handle Fetch": the request's service-workers mode `none`;
// worker-interception-redirect). The host keeps the transport, the service workers' round trips and the script it
// starts the worker with; it asks this twice a hop (`begin_hop`, `response`).

use std::cell::RefCell;

use magnus::{function, method, prelude::*, Error, RModule, RString, Ruby};

use crate::fetch_chain::{Followed, Judged, RequestChain};
use crate::referrer::http_origin;

struct Hops {
    chain: RequestChain,
    // Whether a service worker may answer the next hop: until one has gone to the network.
    workers_may_answer: bool,
}

#[magnus::wrap(class = "Capybara::Simulated::Native::WorkerScriptFetch", free_immediately)]
pub(crate) struct WorkerScriptFetch {
    origin: Option<String>,
    st: RefCell<Hops>,
}

// What a hop's response makes of the fetch (`response`).
#[derive(Debug, PartialEq)]
enum Step {
    Follow,
    // A network error: the worker fails to start, never falling back to another answer.
    Fail,
    // The script — an ok status — or a response that is none (an HTTP error, a redirect it cannot follow), which fails
    // the worker's load as a response does.
    Script,
    NotOk,
}

impl Step {
    fn name(&self) -> &'static str {
        match self {
            Step::Follow => "follow",
            Step::Fail => "fail",
            Step::Script => "script",
            Step::NotOk => "not_ok",
        }
    }
}

impl WorkerScriptFetch {
    // WorkerScriptFetch.new(url) -> the fetch of the script at `url` (resolved), of `url`'s origin.
    fn new(url: String) -> Self {
        WorkerScriptFetch {
            origin: http_origin(&url),
            st: RefCell::new(Hops {
                chain: RequestChain {
                    method: "GET".to_owned(),
                    target: url,
                    headers: Vec::new(),
                    body_empty: true,
                    effective_origin: None,
                    ref_policy: None,
                    ref_source: None,
                    redirected: false,
                    dispatches: 0,
                },
                workers_may_answer: true,
            }),
        }
    }

    // #begin_hop -> [URL, whether a service worker may answer it], or nil where it would be the 21st (a network error).
    fn begin_hop(&self) -> Option<(String, bool)> {
        let mut st = self.st.borrow_mut();
        st.chain.dispatch()?;
        Some((st.chain.target.clone(), st.workers_may_answer))
    }

    // #response(status, location, url, from_network) -> 'follow' / 'fail' / 'script' / 'not_ok': what the hop's response
    // of `status` makes of the fetch — its Location `location` (a redirect status's, nil for none), `url` the URL it is of
    // where that is not the hop's own (a service worker's `respondWith(fetch(elsewhere))`; nil or '' for none), whether it
    // came from the network (`from_network`, after which no service worker answers a hop).
    fn response(&self, status: u32, location: Option<RString>, url: Option<String>, from_network: bool) -> &'static str {
        let location = location.map(crate::fetch_rules::ruby_bytes);
        self.step(status, location, url, from_network).name()
    }

    fn step(&self, status: u32, location: Option<Vec<u8>>, url: Option<String>, from_network: bool) -> Step {
        let mut st = self.st.borrow_mut();
        if let Some(url) = url.filter(|u| !u.is_empty()) {
            st.chain.target = url;
        }
        let Some(location) = location.filter(|l| !l.is_empty() && crate::fetch_rules::redirect_status(status)) else {
            return if (200..=299).contains(&status) { Step::Script } else { Step::NotOk };
        };
        let origin = self.origin.clone().unwrap_or_default();
        let judged = Judged { cors: false, origin: &origin, tainting_cors: false };
        match st.chain.follow(status, &[location], &judged) {
            // (…its mode `same-origin`: a hop to another origin, or to no HTTP(S) URL, a network error)
            Followed::Follow(..) if http_origin(&st.chain.target).is_some() && http_origin(&st.chain.target) == self.origin => {
                st.workers_may_answer &= !from_network;
                Step::Follow
            }
            Followed::Follow(..) | Followed::Fail => Step::Fail,
            Followed::Answer => Step::NotOk,
        }
    }

    // #target / #redirected?: the URL the request is at — the script's, once it is answered, which becomes the worker's
    // `self.location` and the base its imports resolve against — and whether a redirect led it there.
    fn target(&self) -> String {
        self.st.borrow().chain.target.clone()
    }
    fn redirected(&self) -> bool {
        self.st.borrow().chain.redirected
    }
}

pub(crate) fn define(native: RModule, ruby: &Ruby) -> Result<(), Error> {
    let class = native.define_class("WorkerScriptFetch", ruby.class_object())?;
    class.define_singleton_method("new", function!(WorkerScriptFetch::new, 1))?;
    class.define_method("begin_hop", method!(WorkerScriptFetch::begin_hop, 0))?;
    class.define_method("response", method!(WorkerScriptFetch::response, 4))?;
    class.define_method("target", method!(WorkerScriptFetch::target, 0))?;
    class.define_method("redirected?", method!(WorkerScriptFetch::redirected, 0))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hop(f: &WorkerScriptFetch, status: u32, location: &str, url: &str, from_network: bool) -> Step {
        let location = (!location.is_empty()).then(|| location.as_bytes().to_vec());
        f.step(status, location, Some(url.to_owned()), from_network)
    }

    #[test]
    fn a_script_follows_same_origin_redirects_and_no_worker_answers_after_the_network() {
        let f = WorkerScriptFetch::new("http://a.test/w.js".to_owned());
        assert_eq!(f.begin_hop(), Some(("http://a.test/w.js".to_owned(), true)));
        // (…a service worker's redirect, relative to the URL its response is of: workers may still answer)
        assert_eq!(hop(&f, 302, "next.js", "http://a.test/sub/r.js", false), Step::Follow);
        assert_eq!(f.begin_hop(), Some(("http://a.test/sub/next.js".to_owned(), true)));
        // (…the network's: none answers after it)
        assert_eq!(hop(&f, 301, "/last.js", "", true), Step::Follow);
        assert_eq!(f.begin_hop(), Some(("http://a.test/last.js".to_owned(), false)));
        assert_eq!(hop(&f, 200, "", "", true), Step::Script);
        assert_eq!(f.target(), "http://a.test/last.js");
        assert!(f.redirected());
    }

    #[test]
    fn another_origin_another_scheme_a_status_and_the_21st_hop_fail() {
        let f = WorkerScriptFetch::new("http://a.test/w.js".to_owned());
        f.begin_hop();
        assert_eq!(hop(&f, 302, "http://b.test/w.js", "", true), Step::Fail);
        let f = WorkerScriptFetch::new("http://a.test/w.js".to_owned());
        f.begin_hop();
        assert_eq!(hop(&f, 302, "data:text/javascript,", "", false), Step::Fail);
        let f = WorkerScriptFetch::new("http://a.test/w.js".to_owned());
        f.begin_hop();
        // (…an HTTP error, and a redirect status with no Location, no script)
        assert_eq!(hop(&f, 404, "", "", true), Step::NotOk);
        assert_eq!(hop(&f, 302, "", "", true), Step::NotOk);
        let f = WorkerScriptFetch::new("http://a.test/w.js".to_owned());
        for _ in 0..21 {
            assert!(f.begin_hop().is_some());
            assert_eq!(hop(&f, 302, "/w.js", "", true), Step::Follow);
        }
        assert_eq!(f.begin_hop(), None);
    }
}
