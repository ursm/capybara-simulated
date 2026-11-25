// HTML "navigate" — one algorithm for the navigation of every navigable that makes a request: the page's (its
// top-level traversable), a window's `window.open` made in an isolate (a top-level traversable of its own), a frame's
// (its document's own, a link's or a form's targeting it, a reload, a traversal), and a frame container's own attribute
// navigation (the build of its `src`, which the bindings make: `Kind::Container`). The engine's steps, one at a time —
// as session_history.rs `Applying` runs a traversal — each a command the host carries out and answers (`Navigation#next`,
// browser.rb `run_navigation`): the host keeps its I/O alone — the Rack app's hop, a service worker's round-trip, the
// documents it makes — and the realms it asks.
//
// The steps, as HTML "navigate" orders them:
// 1. none at all of a document's navigation of a top-level traversable to a `data:` URL that is no download, before it
//    begins (navigation_fetch.rs `start`, `refuses_data`);
// 2. its navigable's ongoing navigation begun — or, one its plan began, that one's number (navigation_plan.rs
//    `Location::ongoing`) — a reload's a fresh one, standing in for HTML's "traversal": what reads it only asks whether
//    the number it holds is still the ongoing one, which a fresh number answers no for every one begun before;
// 3. the page's tasks due run first (`flush`: browser.rb `flush_outgoing_page_init`), its document asked whether it may
//    be unloaded ("check if unloading is canceled", `prompt` — none of a traversal's, asked as its step applied), a frame's
//    going no further where a navigation begun meanwhile ended it ("navigable's ongoing navigation is no longer
//    navigationId");
// 4. a request into the scope of a service worker still activating waiting for it (Service Workers Handle Fetch: "If
//    activeWorker's state is 'activating', wait for activeWorker's state to become 'activated'") — the host's event loop
//    stepped meanwhile (`wait_sw`) — or, where it can't finish so, the navigation parked (`defer`) and taken again once
//    the worker activates, only where it is still its navigable's ongoing one;
// 5. a frame's entry begun (session_history.rs `begin_frame_entry`), made only as its document is;
// 6. its request (`request`): HTML's source snapshot params and its document state;
// 7. what its URL makes of it before any request (navigation_commit.rs `Step`): about:blank's document, a `blob:` URL's
//    blob, a `data:` URL's response — or its hops, each to a service worker that controls it (`sw_fetch`) or the network
//    (`network`), its redirects followed (navigation_fetch.rs), its reserved client one per chain (`event.resultingClientId`,
//    made anew where a hop crosses origins);
// 8. none of it where a navigation begun as its response was awaited ended it ("this will abort other ongoing
//    navigations": `superseded`);
// 9. the step the host takes (`commit`): the document it makes, a download, none.

use std::cell::RefCell;

use magnus::{function, method, prelude::*, Error, IntoValue, RArray, RHash, RModule, RString, Ruby, TryConvert, Value};

use crate::navigation_commit::{Commit, Handling, Step};
use crate::navigation_fetch::{blob_load, start, step_for_ruby, FetchRequest, Hop, NavigationFetch, Outcome};
use crate::referrer::http_origin;
use crate::response_headers::ResponseFields;
use crate::session_history::{Data, SessionHistory};

// The navigable a navigation is of.
#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum Kind {
    #[default]
    Page,
    Window,
    Frame,
    Container,
}

impl Kind {
    fn top_level(self) -> bool {
        matches!(self, Kind::Page | Kind::Window)
    }
    // …its service worker client's frame type (Service Workers `Client.frameType`).
    fn frame_type(self) -> &'static str {
        match self {
            Kind::Page => "top-level",
            Kind::Window => "auxiliary",
            Kind::Frame | Kind::Container => "nested",
        }
    }
}

// The document that initiates a navigation — or is its client, the navigable's own of a traversal no document began — as
// the host reads it (browser.rb `navigation_source`): the URL its site and origin are of (an about:blank one's creator's),
// whether its origin is opaque, whether it has a cross-site ancestor, and its service worker client's id.
#[derive(Default)]
struct Initiator {
    url: String,
    opaque: bool,
    cross_site_ancestor: bool,
    client_id: Option<String>,
}

// Where a navigation stands (`Machine::advance`).
#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum Phase {
    #[default]
    Start,
    Flushed,
    Prompted,
    Waited,
    Entry,
    Begun,
    Local,
    Blob,
    BlobPolicy,
    Hop,
    Answered,
    Facts,
    Sniffed,
    Discarded,
    Ended,
    Done,
}

// One hop's response as the host answered it, awaiting what the engine makes of it.
#[derive(Default)]
struct Response {
    status: u32,
    fields: Option<ResponseFields>,
    from_worker: bool,
}

#[derive(Default)]
struct Machine {
    kind: Kind,
    url: String,
    post: Option<(Vec<u8>, Option<String>)>,
    handling: Option<Handling>,
    replayed: Option<u64>,
    by_user: bool,
    history: Option<SessionHistory>,
    nav: u32,
    number: Option<u64>,
    begun: Option<u64>,
    initiator: Option<Initiator>,
    referrer: Option<(String, String)>,
    activated: bool,
    reload: bool,
    // (…a service worker's: the partition its registrations are in, whether the navigable may be controlled at an HTTPS
    // URL, and the top-level site a frame's registration is matched in — none a top-level navigable's, each URL's own)
    sw: Option<(u64, bool, Option<String>)>,
    defers: bool,
    client_space: String,
    client: Option<Initiator>,
    client_id: Option<String>,
    replaces: Option<(String, String)>,
    leaving_origin: Option<String>,
    opened: bool,
    ancestors: Option<Vec<Option<String>>>,
    dest: String,
    jar: u64,
    blob: Option<(String, Vec<u8>)>,
    flushes: bool,
    // (…a frame's navigation a form's submission superseded after its fetch began: its request made, nothing made of
    // its response — frame_navigation.rs `superseded`)
    discards: bool,
    phase: Phase,
    fetch: Option<NavigationFetch>,
    entry: Option<u64>,
    policy: Option<String>,
    // (…the hops: the request's body as it stands, its content type, the reserved client, the mark a top-level
    // navigation's supersession is judged by, the response in hand, and what the last made of it)
    body: Vec<u8>,
    content_type: Option<String>,
    rid: Option<String>,
    mark: Option<(Option<u64>, Option<bool>)>,
    hop_waits: bool,
    pending: Option<Hop>,
    response: Response,
    outcome: Option<Outcome>,
    document_type: Option<String>,
    deferred: bool,
    parked: bool,
    superseded: bool,
}

// A command for the host, `[name, *payload]` — made at once, so no value of its payload is out of the garbage collector's
// sight (a Rust heap `Vec` of them would be) while the next one is made.
struct Cmd(RArray);

fn cmd(ruby: &Ruby, name: &str, payload: &[Value]) -> Cmd {
    Cmd(crate::navigation_fetch::command(ruby, name, payload))
}

// What the host answered of the last command.
enum Answer {
    Nothing,
    Bool(bool),
    Value(Value),
}

impl Answer {
    fn truthy(&self) -> bool {
        match self {
            Answer::Nothing => false,
            Answer::Bool(b) => *b,
            Answer::Value(v) => v.to_bool(),
        }
    }
    fn value(&self) -> Option<Value> {
        match self {
            Answer::Value(v) => Some(*v),
            _ => None,
        }
    }
}

impl Machine {
    // A navigation the host describes — by name: `kind` ('page', 'window', 'frame', 'container'), `url`, `body` and
    // `content_type` (a POST's), `handling` ('push', 'replace', 'reload', 'traverse'; none a container's), `traversal` (a
    // top-level traversal's [step, entry]), `replayed` (a reload's or a traversal's entry, which it makes the document of
    // again), `by_user` (the user's: the driver's own, which no document initiates), `traversable` and `navigable` (the
    // session history it is of and its navigable — 0 a top-level one), `begun` (its ongoing navigation's number, where a
    // plan began it), `initiator` (the initiating document as it is now: browser.rb `navigation_source` — none where it is
    // gone, or none began it), `referrer` ([referrer source, policy] as its source snapshot params took them: a link's
    // policy, else its document's — none a user's), `activated` (its source snapshot's transient activation), `reload` (a
    // container's reload), `sw` (none where no registration could answer it, else [partition, whether its navigable may be
    // controlled at an HTTPS URL, the top-level site a frame's registration is matched in]), `defers` (whether it may be
    // parked where a worker it waits on can't finish activating — a container's build none: the bindings park it),
    // `client_space` (the session's prefix of reserved client ids), `client` (the navigable's own document, as
    // `initiator`: a replay's of no initiator's client), `replaces` ([client id, origin] of the document it replaces),
    // `leaving_origin` / `opened` (a top-level one's: navigation_commit.rs `Commit::new`), `ancestors` / `dest` (a
    // frame's), `jar` (the cookie jar), `blob` ([type,
    // bytes] of a `blob:` URL's blob as its navigation began) and `flushes` (whether the page's tasks run first) and `superseded` (a frame's a form superseded after its fetch began:
    // its request made, its response discarded).
    fn new(ruby: &Ruby, params: RHash) -> Result<Self, Error> {
        let get = |key: &str| params.aref::<_, Value>(ruby.to_symbol(key));
        let text = |key: &str| -> Result<Option<String>, Error> { Option::<String>::try_convert(get(key)?) };
        let kind = match text("kind")?.as_deref() {
            Some("page") => Kind::Page,
            Some("window") => Kind::Window,
            Some("frame") => Kind::Frame,
            Some("container") => Kind::Container,
            other => return Err(Error::new(ruby.exception_arg_error(), format!("no navigable kind {other:?}"))),
        };
        // (…a frame's traversal planned at no step of its own: its traversable's step applies it — `Commit::of_frame`)
        let replayed = Option::<u64>::try_convert(get("replayed")?)?;
        let traversal = Option::<(i64, u64)>::try_convert(get("traversal")?)?.or_else(|| (kind == Kind::Frame).then(|| (0, replayed.unwrap_or(0))));
        let handling = match text("handling")? {
            Some(name) => Some(Handling::named(&name, traversal).ok_or_else(|| Error::new(ruby.exception_arg_error(), format!("no history handling {name}")))?),
            None => None,
        };
        let body = Option::<RString>::try_convert(get("body")?)?.map(crate::fetch_rules::ruby_bytes);
        let document = |key: &str| -> Result<Option<Initiator>, Error> {
            let Some(h) = Option::<RHash>::try_convert(get(key)?)? else { return Ok(None) };
            let field = |key: &str| h.aref::<_, Value>(ruby.to_symbol(key));
            Ok(Some(Initiator {
                url: Option::<String>::try_convert(field("url")?)?.unwrap_or_default(),
                opaque: field("opaque")?.to_bool(),
                cross_site_ancestor: field("cross_site_ancestor")?.to_bool(),
                client_id: Option::<String>::try_convert(field("client_id")?)?,
            }))
        };
        let content_type = text("content_type")?;
        let initiator = document("initiator")?;
        let client = document("client")?;
        let ancestors: Option<RArray> = Option::try_convert(get("ancestors")?)?;
        let ancestors = ancestors.map(|a| a.into_iter().map(Option::<String>::try_convert).collect::<Result<Vec<_>, _>>()).transpose()?;
        let blob = Option::<(Option<String>, RString)>::try_convert(get("blob")?)?.map(|(t, b)| (t.unwrap_or_default(), crate::fetch_rules::ruby_bytes(b)));
        Ok(Machine {
            kind,
            url: text("url")?.unwrap_or_default(),
            content_type: content_type.clone(),
            post: body.map(|b| (b, content_type.clone())),
            handling,
            replayed,
            by_user: get("by_user")?.to_bool(),
            history: Option::<u64>::try_convert(get("traversable")?)?.and_then(SessionHistory::of),
            nav: Option::<u32>::try_convert(get("navigable")?)?.unwrap_or(0),
            number: None,
            begun: Option::<u64>::try_convert(get("begun")?)?.filter(|n| *n != 0),
            initiator,
            referrer: Option::<(Option<String>, Option<String>)>::try_convert(get("referrer")?)?.map(|(s, p)| (s.unwrap_or_default(), p.unwrap_or_default())),
            activated: get("activated")?.to_bool(),
            reload: get("reload")?.to_bool(),
            sw: Option::<(u64, bool, Option<String>)>::try_convert(get("sw")?)?,
            defers: get("defers")?.to_bool(),
            client_space: text("client_space")?.unwrap_or_default(),
            client,
            client_id: None,
            replaces: Option::<(Option<String>, Option<String>)>::try_convert(get("replaces")?)?.map(|(c, o)| (c.unwrap_or_default(), o.unwrap_or_default())),
            leaving_origin: text("leaving_origin")?,
            opened: get("opened")?.to_bool(),
            ancestors,
            dest: text("dest")?.unwrap_or_else(|| if kind.top_level() { "document".to_owned() } else { "iframe".to_owned() }),
            jar: Option::<u64>::try_convert(get("jar")?)?.unwrap_or(0),
            blob,
            flushes: get("flushes")?.to_bool(),
            discards: get("superseded")?.to_bool(),
            phase: Phase::Start,
            fetch: None,
            entry: None,
            policy: None,
            body: Vec::new(),
            rid: None,
            mark: None,
            hop_waits: false,
            pending: None,
            response: Response::default(),
            outcome: None,
            document_type: None,
            deferred: false,
            parked: false,
            superseded: false,
        })
    }

    fn replays(&self) -> bool {
        matches!(self.handling, Some(Handling::Reload | Handling::Traverse(..)))
    }
    fn traverses(&self) -> bool {
        matches!(self.handling, Some(Handling::Traverse(..)))
    }
    fn method(&self) -> &'static str {
        if self.post.is_some() { "POST" } else { "GET" }
    }
    // Whether its navigable's ongoing navigation still is it (`number`): one of no history always.
    fn ongoing(&self) -> bool {
        match (&self.history, self.number) {
            (Some(history), Some(number)) => history.navigation_ongoing(self.nav, number),
            _ => true,
        }
    }
    // The still-activating worker a request to `url` waits for, matched in `site` (sw_registry.rs `match_worker`,
    // "activating") — none for none.
    fn activating(&self, url: &str, site: &str) -> bool {
        let Some((partition, ..)) = &self.sw else { return false };
        if !url.get(..7).is_some_and(|s| s.eq_ignore_ascii_case("http://")) && !url.get(..8).is_some_and(|s| s.eq_ignore_ascii_case("https://")) {
            return false;
        }
        crate::sw_registry::match_worker_for_ruby(*partition, site.to_owned(), url.to_owned(), "activating".to_owned()).is_some()
    }
    // …the top-level site a request to `url` is matched in: a frame's container's top-level traversable's, else its own.
    fn sw_site(&self, url: &str) -> String {
        match &self.sw {
            Some((_, _, Some(site))) => site.clone(),
            _ => crate::realm_location::site(url).unwrap_or_default(),
        }
    }

    // Its request (HTML "navigate" step 6 — the source snapshot params of the document that began it — and "create
    // navigation params by fetching" — a replay's of its entry's document state):
    // - its referrer and policy: a reload's or a traversal's those its entry's request was sent with ("referrer entry's
    //   document state's request referrer, referrer policy entry's document state's request referrer policy"), else those
    //   its source snapshot took — a link's policy over its document's; none of the user's;
    // - its initiator, whose site Sec-Fetch-Site compares and whose origin its request is of: the initiating document as
    //   it is now (an about:blank one's its creator's), else — that one gone — the URL it referred by; none of a replay no
    //   document began (the user's, "as if navigable navigated itself": its client the navigable's own document,
    //   `client`, whose origin its redirect-taint is walked with and whose cross-site ancestor makes its cookies
    //   cross-site);
    // - its origin, where it is not its initiator's: the user's replay's — of no client: HTML "If request's client is null"
    //   — the one its entry was first sent with (HTML's document state's initiator origin), `null` an opaque one's; a
    //   script's re-post's its client's, the document that asked for it (`reload_request_spec`);
    // - a top-level replay's of no initiator — the user's — cookies judged by the initiator origin its entry keeps; a
    //   script's by its document's site, as any navigation it begins. HTML "create navigation params by fetching" sets
    //   "request's top-level navigation initiator origin to entry's document state's initiator origin" for both, but
    //   what that origin decides is Fetch's "determine the same-site mode" step 2, which is not applied as written to a
    //   top-level GET (navigation_fetch.rs `Nav::cookies`), and RFC 6265bis §5.2 with WPT cookies/samesite
    //   window-open-reload and form-get-blank-reload ("this is a site-initiated reload, as opposed to a reload
    //   triggered by a user interface element": strictly same-site) judge a script's by the reloading document — Chrome
    //   157 alike; Firefox 159 judges it, and a script's history.back(), by the entry (measured 2026-11-19);
    // - a reload through a user interface element's cross-site where the request it reloads was (RFC 6265bis §5.2) — a
    //   traversal's never: it is no reload.
    // …with what the entry it makes keeps of it: that referrer and policy, its origin (a replay's its entry's), a POST's
    // body.
    fn request(&mut self) -> FetchRequest {
        let replay = self.replays();
        let entry = self.replayed.zip(self.history.as_ref()).filter(|_| replay).and_then(|(id, history)| history.replayed(id)).map(|e| e.1);
        let (source, policy) = match entry.as_deref().and_then(|e| e.text("referer").map(|r| (r.to_owned(), e.text("referrer_policy").unwrap_or("").to_owned()))) {
            Some(referred) => (Some(referred.0), referred.1),
            None => self.referrer.clone().map_or((None, String::new()), |(s, p)| (Some(s), p)),
        };
        let initiator = match &self.initiator {
            Some(i) => Some(i.url.clone()),
            None if !replay && !self.by_user => source.clone(),
            None => None,
        };
        let opaque = self.initiator.as_ref().is_some_and(|i| i.opaque);
        let traversed = replay && initiator.is_none();
        // (…its client the initiating document — a traversal's of none, the navigable's own document: "as if navigable
        // navigated itself" — whose cross-site ancestor makes its cookies cross-site, Fetch's step 4)
        let client = if traversed { self.client.as_ref() } else { self.initiator.as_ref() };
        self.client_id = client.and_then(|c| c.client_id.clone());
        let cross_site_ancestor = client.is_some_and(|c| c.cross_site_ancestor);
        let client_origin = client.filter(|_| traversed).map(|c| if c.opaque { "null".to_owned() } else { http_origin(&c.url).unwrap_or_else(|| "null".to_owned()) });
        let entry_origin = entry.as_deref().and_then(|e| e.text("origin")).map(str::to_owned);
        let origin = if traversed { entry_origin.clone() } else { None };
        // (…the entry's own a replay's, whose document state it makes the document of again)
        let initiator_origin = || initiator.as_deref().map(|u| if opaque { "null".to_owned() } else { http_origin(u).unwrap_or_else(|| "null".to_owned()) });
        let kept_origin = if replay { entry_origin.clone().or_else(initiator_origin) } else { initiator_origin() };
        let post = self.post.as_ref().map(|(b, ct)| (std::sync::Arc::<[u8]>::from(b.as_slice()), ct.clone()));
        let data = Data::sent(source.clone(), Some(policy.clone()).filter(|p| !p.is_empty() || source.is_some()), kept_origin, post);
        let commit = match (self.kind, &self.history, self.handling) {
            (Kind::Page | Kind::Window, Some(history), Some(handling)) => {
                SessionHistory::of(history.id()).map(|history| Commit::new(history, handling, Some(data), self.leaving_origin.clone(), self.opened))
            }
            (Kind::Frame, Some(history), Some(_)) => SessionHistory::of(history.id()).map(|history| Commit::of_frame(history, self.nav, self.entry, Some(data), self.traverses())),
            _ => None,
        };
        let top_level = self.kind.top_level();
        FetchRequest {
            method: self.method().to_owned(),
            url: self.url.clone(),
            body_empty: self.post.as_ref().is_none_or(|p| p.0.is_empty()),
            referrer: source,
            referrer_policy: policy,
            initiator,
            origin,
            origin_null: opaque,
            initiator_cross_site_ancestor: cross_site_ancestor,
            ancestors: self.ancestors.take(),
            dest: self.dest.clone(),
            user_activated: self.activated,
            jar: self.jar,
            sw: self.sw.as_ref().map(|(_, may, site)| (*may, site.clone())),
            reloaded_cross_site: (matches!(self.handling, Some(Handling::Reload)) && self.by_user).then(|| entry.as_deref().and_then(Data::cross_site)).flatten(),
            client_origin,
            traversed_initiator: if top_level && traversed { entry_origin } else { None },
            traversable: if top_level { self.history.as_ref().map(SessionHistory::id) } else { None },
            commit,
        }
    }

    // The reserved client id of a navigation's chain made anew (Service Workers: one per chain, origin-bound).
    fn mint(&self) -> String {
        crate::worker_host::reserved_client_id(&self.client_space)
    }
    // Its next step for the host, which answered the last with `answer` at `now` (the app's clock, a cookie's expiry is
    // judged by) — none once it is done.
    fn advance(&mut self, ruby: &Ruby, answer: Answer, now: f64) -> Result<Option<Cmd>, Error> {
        // (…the hops ended in an outcome: its reserved client let go, then on to what it comes to)
        macro_rules! end_hops {
            ($outcome:expr) => {
                match self.end_hops(ruby, $outcome) {
                    Some(cmd) => return Ok(Some(cmd)),
                    None => continue,
                }
            };
        }
        let mut answer = answer;
        loop {
            let given = std::mem::replace(&mut answer, Answer::Nothing);
            match self.phase {
                Phase::Start => {
                    let replay = self.replays();
                    if self.kind.top_level() && !replay && !self.by_user && start(&self.url, self.method(), true) == "refused" {
                        self.phase = Phase::Done;
                        return Ok(None);
                    }
                    self.number = match (&self.history, self.kind) {
                        (Some(history), Kind::Page | Kind::Window | Kind::Frame) => Some(self.begun.unwrap_or_else(|| history.begin_navigation(self.nav))),
                        _ => None,
                    };
                    self.phase = Phase::Flushed;
                    if self.kind == Kind::Page && self.flushes && !replay {
                        return Ok(Some(cmd(ruby, "flush", &[])));
                    }
                }
                Phase::Flushed => {
                    self.phase = Phase::Prompted;
                    if self.kind != Kind::Container && !self.traverses() {
                        return Ok(Some(cmd(ruby, "prompt", &[])));
                    }
                    answer = Answer::Bool(true);
                }
                // (…none where the user declined to unload its document, or a handler removed its frame; a frame's none
                // where a navigation its handlers began ended it)
                Phase::Prompted => {
                    if !given.truthy() || (self.kind == Kind::Frame && !self.ongoing()) {
                        self.phase = Phase::Done;
                        return Ok(None);
                    }
                    self.phase = Phase::Waited;
                }
                Phase::Waited => {
                    // (…none while it is parked; taken again — `resume` — only where it is still its navigable's ongoing
                    // navigation: one begun since, a `javascript:` URL's among them, a traversal or a reload applied,
                    // replaced it)
                    if self.deferred {
                        return Ok(None);
                    }
                    if std::mem::take(&mut self.parked) && !self.ongoing() {
                        self.phase = Phase::Done;
                        return Ok(None);
                    }
                    let url = self.url.clone();
                    let fetches = start(&url, self.method(), false) == "fetch";
                    let site = self.sw_site(&url);
                    if fetches && self.activating(&url, &site) {
                        // (…a container's build, in a script, can't wait: parked by the bindings, made again once the worker
                        // activates — `deferred`)
                        if self.kind == Kind::Container && self.defers {
                            self.phase = Phase::Done;
                            return Ok(Some(cmd(ruby, "deferred", &[])));
                        }
                        match given {
                            Answer::Nothing => return Ok(Some(cmd(ruby, "wait_sw", &[url.into_value_with(ruby), site.into_value_with(ruby)]))),
                            Answer::Bool(false) if self.defers => {
                                self.deferred = true;
                                self.parked = true;
                                return Ok(Some(cmd(ruby, "defer", &[])));
                            }
                            _ => {}
                        }
                    }
                    // (…a frame's none where a navigation begun in the wait ended it: a top-level one's number moves with
                    // what plans a navigation, which the wait's tasks may do without beginning one — a click superseding
                    // what was planned — and goes on)
                    if self.kind == Kind::Frame && !self.ongoing() {
                        self.phase = Phase::Done;
                        return Ok(None);
                    }
                    self.phase = Phase::Entry;
                    if let (Kind::Frame, Some(Handling::Push | Handling::Replace), false) = (self.kind, self.handling, self.discards) {
                        let replace = matches!(self.handling, Some(Handling::Replace));
                        return Ok(Some(cmd(ruby, "begin_entry", &[self.url.clone().into_value_with(ruby), replace.into_value_with(ruby)])));
                    }
                }
                Phase::Entry => {
                    if let (Kind::Frame, Some(Handling::Push | Handling::Replace)) = (self.kind, self.handling) {
                        self.entry = Option::<u64>::try_convert(given.value().unwrap_or_else(|| ruby.qnil().as_value()))?;
                    }
                    let request = self.request();
                    self.fetch = Some(NavigationFetch::of(request));
                    self.phase = Phase::Begun;
                    return Ok(Some(cmd(ruby, "begin", &[])));
                }
                Phase::Begun => {
                    self.phase = Phase::Local;
                    let fetch = self.fetch.as_ref().expect("made");
                    if fetch.start() == "about_blank" && fetch.asks_policy() && self.kind != Kind::Container {
                        return Ok(Some(cmd(ruby, "policy", &[])));
                    }
                }
                Phase::Local => {
                    if let Answer::Value(v) = given {
                        self.policy = Option::<String>::try_convert(v)?;
                    }
                    if self.kind == Kind::Container {
                        if let Some(cmd) = self.begin_hops(ruby) {
                            return Ok(Some(cmd));
                        }
                        continue;
                    }
                    let fetch = self.fetch.as_ref().expect("made");
                    match fetch.begin_commit(self.policy.take()) {
                        Step::Fetch => {
                            // (…of a scheme a window loads no document of here, none)
                            if self.kind == Kind::Window && !self.url.get(..4).is_some_and(|s| s.eq_ignore_ascii_case("http")) {
                                self.phase = Phase::Done;
                                return Ok(Some(cmd(ruby, "unmodeled", &[])));
                            }
                            if let Some(cmd) = self.begin_hops(ruby) {
                                return Ok(Some(cmd));
                            }
                        }
                        Step::Blob => {
                            self.phase = Phase::Blob;
                            if self.blob.is_none() {
                                self.blob = self.replayed.zip(self.history.as_ref()).and_then(|(id, h)| h.replayed(id)).and_then(|e| e.1.blob().map(|(b, t)| (t.clone(), b.to_vec())));
                            }
                            if self.blob.is_none() {
                                return Ok(Some(cmd(ruby, "blob", &[self.url.clone().into_value_with(ruby)])));
                            }
                        }
                        step => return Ok(Some(self.commit(ruby, step))),
                    }
                }
                Phase::Blob => {
                    if let Some(v) = given.value() {
                        self.blob = Option::<(Option<String>, RString)>::try_convert(v)?.map(|(t, b)| (t.unwrap_or_default(), crate::fetch_rules::ruby_bytes(b)));
                    }
                    self.phase = Phase::BlobPolicy;
                    let fetch = self.fetch.as_ref().expect("made");
                    if let Some((given_type, bytes)) = &self.blob {
                        if !matches!(blob_load(given_type, bytes), crate::mime::Load::Download) && fetch.asks_policy() {
                            return Ok(Some(cmd(ruby, "policy", &[])));
                        }
                    }
                }
                Phase::BlobPolicy => {
                    if let Answer::Value(v) = given {
                        self.policy = Option::<String>::try_convert(v)?;
                    }
                    let fetch = self.fetch.as_ref().expect("made");
                    let blob = self.blob.take();
                    let step = fetch.blob_commit(blob.as_ref().map(|b| b.0.clone()), blob.as_ref().map(|b| b.1.as_slice()), self.policy.take());
                    self.blob = blob;
                    return Ok(Some(self.commit(ruby, step)));
                }
                Phase::Hop => {
                    if self.mark.is_some_and(|m| m.1.is_none()) {
                        self.mark = self.mark.map(|(n, _)| (n, Some(given.truthy())));
                    } else if self.hop_waits {
                        // (…a top-level hop into the scope of a worker still activating waiting what it can, each hop's: no
                        // deferral makes a chain's hop again)
                        self.hop_waits = false;
                        let target = self.fetch.as_ref().expect("made").target();
                        let site = self.sw_site(&target);
                        if self.kind.top_level() && self.activating(&target, &site) {
                            return Ok(Some(cmd(ruby, "wait_sw", &[target.into_value_with(ruby), site.into_value_with(ruby)])));
                        }
                    }
                    return self.hop(ruby, now);
                }
                Phase::Answered => {
                    // (…a worker's: nil its leg falling through to the network, false a network error, else its response;
                    // the network's: nil a network error of no response)
                    let value = given.value().filter(|v| !v.is_nil());
                    if self.pending.is_some() {
                        match (&given, value) {
                            (Answer::Bool(false), _) => end_hops!(Outcome::Fail),
                            (_, None) => return self.network(ruby),
                            _ => {}
                        }
                    }
                    self.pending = None;
                    let Some(v) = value.and_then(RArray::from_value) else { end_hops!(Outcome::Fail) };
                    let status: u32 = v.entry(0)?;
                    let headers: Value = v.entry(1)?;
                    self.response.status = status;
                    self.response.fields = Some(ResponseFields::read(if headers.is_nil() { None } else { Some(headers) })?);
                    self.phase = Phase::Facts;
                    let fetch = self.fetch.as_ref().expect("made");
                    if fetch.wants_facts(self.response.fields.as_ref().expect("read")) {
                        return Ok(Some(cmd(ruby, "coop_facts", &[])));
                    }
                }
                Phase::Facts => {
                    let facts = given.value().filter(|v| !v.is_nil()).map(<(String, bool, u32)>::try_convert).transpose()?;
                    let fetch = self.fetch.as_ref().expect("made");
                    let fields = self.response.fields.take().unwrap_or_default();
                    let outcome = fetch.respond(self.response.status, &fields, (!self.response.from_worker).then_some(now), facts);
                    match outcome {
                        Outcome::Redirect { to_get, new_client } => {
                            if to_get {
                                self.body.clear();
                                self.content_type = None;
                            }
                            self.phase = Phase::Hop;
                            self.hop_waits = true;
                            if new_client {
                                let rid = self.rid.replace(self.mint());
                                return Ok(Some(cmd(ruby, "discard_client", &[rid.into_value_with(ruby)])));
                            }
                        }
                        // (…one whose body says whether it is a document, and its type: MIME Sniffing's computed MIME type
                        // of its first bytes, mime.rs `load` — the type the document is made as, its headers as they came)
                        Outcome::Sniff => {
                            self.response.fields = Some(fields);
                            self.phase = Phase::Sniffed;
                            return Ok(Some(cmd(ruby, "read_body", &[])));
                        }
                        outcome => end_hops!(outcome),
                    }
                }
                Phase::Sniffed => {
                    let supplied = self.response.fields.take().and_then(|f| f.content_type);
                    let head = given.value().filter(|v| !v.is_nil()).map(RString::try_convert).transpose()?.map(crate::fetch_rules::ruby_bytes).unwrap_or_default();
                    let outcome = match crate::mime::load(supplied.as_deref(), &head[..head.len().min(1445)]) {
                        crate::mime::Load::Document(essence) => {
                            self.document_type = Some(essence);
                            Outcome::Document
                        }
                        crate::mime::Load::Inline => Outcome::Inline,
                        crate::mime::Load::Download => Outcome::Download,
                    };
                    end_hops!(outcome)
                }
                Phase::Discarded => {
                    self.phase = Phase::Ended;
                    if self.kind.top_level() {
                        // (…its document's body read first, which an app may take its time over)
                        let reads = self.outcome == Some(Outcome::Document);
                        return Ok(Some(cmd(ruby, "awaited", &[reads.into_value_with(ruby)])));
                    }
                }
                Phase::Ended => {
                    // (…none where a navigation begun as its response was awaited ended it, whose own plan then goes on:
                    // its reserved client discarded, as one of no document is — a top-level one's by what is planned too,
                    // which no number records yet: a reload, a form's — navigation_plan.rs `navigationAwaited`)
                    let superseded = match self.kind {
                        Kind::Page | Kind::Window => self.mark.is_some_and(|(number, awaited)| {
                            self.history.as_ref().and_then(|h| h.ongoing_navigation(self.nav)) != number || Some(given.truthy()) != awaited
                        }),
                        Kind::Frame => self.discards || !self.ongoing(),
                        Kind::Container => false,
                    };
                    if superseded {
                        self.superseded = true;
                        self.phase = Phase::Done;
                        let rid = if matches!(self.outcome, Some(Outcome::Document | Outcome::Inline)) { self.rid.take() } else { None };
                        return Ok(Some(cmd(ruby, "superseded", &[rid.into_value_with(ruby)])));
                    }
                    let fetch = self.fetch.as_ref().expect("made");
                    let step = fetch.response_commit(self.outcome);
                    return Ok(Some(self.commit(ruby, step)));
                }
                Phase::Done => return Ok(None),
            }
        }
    }

    // The hops begun: its body, its reserved client, and — a top-level one's — the mark its supersession is judged by
    // (`awaited`, then the number ongoing).
    fn begin_hops(&mut self, ruby: &Ruby) -> Option<Cmd> {
        if let Some((body, content_type)) = &self.post {
            self.body.clone_from(body);
            // (…a POST's Content-Type the urlencoded default where the form gave none, on the wire and in the SW's
            // `event.request.headers` alike)
            self.content_type = Some(content_type.clone().filter(|c| !c.is_empty()).unwrap_or_else(|| "application/x-www-form-urlencoded".to_owned()));
        }
        self.rid = Some(self.mint());
        self.phase = Phase::Hop;
        self.hop_waits = true;
        if !self.kind.top_level() {
            return None;
        }
        self.mark = Some((self.history.as_ref().and_then(|h| h.ongoing_navigation(self.nav)), None));
        Some(cmd(ruby, "awaited", &[]))
    }

    // A hop made: to the service worker that controls it where one may (`sw_fetch`, its client reserved in the registry
    // from the moment the request reaches one, which `clients.get(event.resultingClientId)` waits on), else the network.
    fn hop(&mut self, ruby: &Ruby, now: f64) -> Result<Option<Cmd>, Error> {
        let fetch = self.fetch.as_ref().expect("made");
        let hop = fetch.hop(now);
        self.phase = Phase::Answered;
        self.response = Response::default();
        let Some(worker_site) = hop.worker_site.clone() else {
            return self.network_of(ruby, hop, None);
        };
        let rid = self.rid.clone().unwrap_or_default();
        if let Some((partition, ..)) = &self.sw {
            crate::sw_registry::reserve_client_for_ruby(*partition, rid.clone(), worker_site.clone(), hop.target.clone(), http_origin(&hop.target), self.kind.frame_type().to_owned());
        }
        let request = ruby.hash_new();
        let set = |key: &str, value: Value| request.aset(ruby.to_symbol(key), value);
        set("site", worker_site.into_value_with(ruby))?;
        set("method", hop.method.clone().into_value_with(ruby))?;
        set("body", if self.body.is_empty() { ruby.qnil().as_value() } else { ruby.str_from_slice(&self.body).as_value() })?;
        set("content_type", self.content_type.clone().into_value_with(ruby))?;
        set("is_reload", (matches!(self.handling, Some(Handling::Reload)) || self.reload).into_value_with(ruby))?;
        set("is_history", self.traverses().into_value_with(ruby))?;
        set("dest", self.dest.clone().into_value_with(ruby))?;
        set("referrer_source", hop.ref_source.clone().into_value_with(ruby))?;
        set("origin_url", self.origin_url().into_value_with(ruby))?;
        set("referrer_policy", hop.ref_policy.clone().into_value_with(ruby))?;
        set("site_seed", hop.site.into_value_with(ruby))?;
        set("origin_null", hop.tainted.into_value_with(ruby))?;
        set("client_id", self.client_id.clone().into_value_with(ruby))?;
        let target_origin = http_origin(&hop.target);
        let replaces = self.replaces.as_ref().filter(|(_, origin)| Some(origin.as_str()) == target_origin.as_deref()).map(|r| r.0.clone());
        set("replaces_client_id", replaces.into_value_with(ruby))?;
        set("resulting_client_id", rid.into_value_with(ruby))?;
        set("cookie_cross_site", hop.frame_cross.into_value_with(ruby))?;
        set("navigation_cross_site", fetch.cross_site().into_value_with(ruby))?;
        set("cookie_context", hop.cookies.into_value_with(ruby))?;
        set("network_headers", headers_for_ruby(ruby, &hop.headers).as_value())?;
        let target = hop.target.clone();
        self.response.from_worker = true;
        self.pending = Some(hop);
        Ok(Some(cmd(ruby, "sw_fetch", &[target.into_value_with(ruby), request.as_value()])))
    }
    // …or the network's, a worker's leg falling through to it (its cookies attached then: `cookie_context`).
    fn network(&mut self, ruby: &Ruby) -> Result<Option<Cmd>, Error> {
        let hop = self.pending.take().expect("a hop");
        let cookies = hop.cookies;
        self.response = Response::default();
        self.network_of(ruby, hop, Some(cookies))
    }
    fn network_of(&mut self, ruby: &Ruby, hop: Hop, cookie_context: Option<u32>) -> Result<Option<Cmd>, Error> {
        let body = if self.body.is_empty() { ruby.qnil().as_value() } else { ruby.str_from_slice(&self.body).as_value() };
        Ok(Some(cmd(ruby, "network", &[
                hop.target.into_value_with(ruby),
                hop.method.into_value_with(ruby),
                headers_for_ruby(ruby, &hop.headers).as_value(),
                body,
                self.content_type.clone().into_value_with(ruby),
                cookie_context.into_value_with(ruby),
            ],
        )))
    }
    // The initiating document's URL — an about:blank one's creator's — whose origin is a worker's request's initiator and
    // whose site its preload's Sec-Fetch-Site compares: the referrer source's, that one gone.
    fn origin_url(&self) -> Option<String> {
        match &self.initiator {
            Some(i) => Some(i.url.clone()),
            None if !self.replays() && !self.by_user => self.referrer.as_ref().map(|r| r.0.clone()),
            None => None,
        }
    }
    // The hops ended in `outcome`: its reserved client let go but of a document it makes.
    fn end_hops(&mut self, ruby: &Ruby, outcome: Outcome) -> Option<Cmd> {
        self.outcome = Some(outcome);
        self.phase = Phase::Discarded;
        if matches!(outcome, Outcome::Document | Outcome::Inline) {
            return None;
        }
        let rid = self.rid.take();
        Some(cmd(ruby, "discard_client", &[rid.into_value_with(ruby)]))
    }
    // The step the host takes: ['commit', step, its reserved client id (a document's), the type its body said, a `blob:`
    // URL's blob [type, bytes]].
    fn commit(&mut self, ruby: &Ruby, step: Step) -> Cmd {
        self.phase = Phase::Done;
        let keeps = matches!(step, Step::Document(None) | Step::Inline(None, None));
        let rid = if keeps { self.rid.take() } else { None };
        let blob = self.blob.take().map(|(t, b)| ruby.ary_from_iter([t.into_value_with(ruby), ruby.str_from_slice(&b).as_value()]).as_value());
        cmd(ruby, "commit", &[step_for_ruby(ruby, step).as_value(), rid.into_value_with(ruby), self.document_type.clone().into_value_with(ruby), blob.into_value_with(ruby)])
    }
}

// A hop's network headers as the host reads them: [[name, value], …].
fn headers_for_ruby(ruby: &Ruby, headers: &[(&'static str, Vec<u8>)]) -> RArray {
    let out = ruby.ary_new_capa(headers.len());
    for (name, value) in headers {
        let _ = out.push((*name, ruby.str_from_slice(value)));
    }
    out
}

// Native::Navigation — the navigation, for the host (`Machine`).
#[magnus::wrap(class = "Capybara::Simulated::Native::Navigation", free_immediately)]
pub(crate) struct Navigation(RefCell<Machine>);

impl Navigation {
    // Navigation.new(params) -> a navigation (`Machine::new`).
    fn new(ruby: &Ruby, params: RHash) -> Result<Self, Error> {
        Ok(Navigation(RefCell::new(Machine::new(ruby, params)?)))
    }
    // #next(answer, now) -> its next step for the host, `[name, *payload]`, which answered the last with `answer` — nil
    // once it is done (`Machine::advance`):
    // - ['flush'] -> whether the page's tasks ran; ['prompt'] -> whether its document may be unloaded;
    // - ['wait_sw', url, site] -> whether the worker it waits on activated ("stalled": false); ['defer']: parked — #next
    //   again, once the worker activated or died, goes on with it where it is still its navigable's ongoing navigation;
    //   ['deferred'] (a container's): none — its build parks it;
    // - ['begin_entry', url, replace] -> the number of the frame entry it begins; ['begin']: it goes on to its request;
    // - ['policy'] -> the opener policy a document of a local scheme inherits; ['blob', url] -> [type, bytes] of a `blob:`
    //   URL's blob, nil none;
    // - ['awaited'] -> what is planned that no number records yet (navigation_plan.rs `navigationAwaited`);
    // - ['sw_fetch', url, request] -> a worker's response [status, headers] (its body the host's), nil none (the network
    //   next), false a network error; ['network', url, method, headers, body, content type, cookie context] -> [status, headers], nil a
    //   network error; ['read_body'] -> the response's body; ['coop_facts'] -> [origin, initial about:blank, popup
    //   sandboxing flags] of the document it leaves; ['discard_client', id]: a reserved client let go;
    // - ['superseded', client id], ['unmodeled'], ['commit', step, client id, document type, blob] (the step:
    //   navigation_fetch.rs `step_for_ruby`; a `blob:` URL's blob [type, bytes]): its end.
    fn next(ruby: &Ruby, rb_self: &Self, answer: Value, now: f64) -> Result<Option<RArray>, Error> {
        let answer = if answer.is_nil() {
            Answer::Nothing
        } else if answer.is_kind_of(ruby.class_true_class()) || answer.is_kind_of(ruby.class_false_class()) {
            Answer::Bool(answer.to_bool())
        } else {
            Answer::Value(answer)
        };
        Ok(rb_self.0.borrow_mut().advance(ruby, answer, now)?.map(|Cmd(out)| out))
    }
    // #close: the host done with it, whatever became of it — another navigation ended it, the host failed in it — what it
    // holds let go (`NavigationFetch::close`); none of one parked (`deferred?`).
    fn close(&self) {
        if let Some(fetch) = self.0.borrow().fetch.as_ref() {
            fetch.close();
        }
    }
    // #target / #request_method / #redirected? / #referrer / #coop_switch? / #deferred? / #superseded?: what the host's
    // steps read of it — its URL as it stands, the method its last request was made with, whether a redirect made it, the
    // Referer it sent, whether its responses need a browsing context group switch; whether it is parked or superseded.
    fn target(&self) -> String {
        let m = self.0.borrow();
        m.fetch.as_ref().map_or_else(|| m.url.clone(), NavigationFetch::target)
    }
    fn request_method(&self) -> String {
        let m = self.0.borrow();
        m.fetch.as_ref().map_or_else(|| m.method().to_owned(), NavigationFetch::request_method)
    }
    fn redirected(&self) -> bool {
        self.0.borrow().fetch.as_ref().is_some_and(NavigationFetch::redirected)
    }
    fn referrer(&self) -> Option<String> {
        self.0.borrow().fetch.as_ref().and_then(NavigationFetch::referrer)
    }
    fn coop_switch(&self) -> bool {
        self.0.borrow().fetch.as_ref().is_some_and(NavigationFetch::coop_switch)
    }
    fn deferred(&self) -> bool {
        self.0.borrow().deferred
    }
    fn superseded(&self) -> bool {
        self.0.borrow().superseded
    }
    // #source_policy -> the referrer policy of the document that initiated it as it began (HTML's source snapshot params'
    // source policy container): the one a document of a local URL it makes clones (document_init.rs
    // `policy_container`) — none for one no document initiated, the user's.
    fn source_policy(&self) -> Option<String> {
        let m = self.0.borrow();
        m.referrer.as_ref().filter(|_| !m.by_user).map(|r| r.1.clone())
    }
    // #resume: a parked navigation (`defer`) taken again — #next goes on with it, its wait asked anew.
    fn resume(&self) {
        self.0.borrow_mut().deferred = false;
    }
}

pub(crate) fn define(native: RModule, ruby: &Ruby) -> Result<(), Error> {
    let class = native.define_class("Navigation", ruby.class_object())?;
    class.define_singleton_method("new", function!(Navigation::new, 1))?;
    class.define_method("next", method!(Navigation::next, 2))?;
    class.define_method("close", method!(Navigation::close, 0))?;
    class.define_method("target", method!(Navigation::target, 0))?;
    class.define_method("request_method", method!(Navigation::request_method, 0))?;
    class.define_method("redirected?", method!(Navigation::redirected, 0))?;
    class.define_method("referrer", method!(Navigation::referrer, 0))?;
    class.define_method("coop_switch?", method!(Navigation::coop_switch, 0))?;
    class.define_method("deferred?", method!(Navigation::deferred, 0))?;
    class.define_method("superseded?", method!(Navigation::superseded, 0))?;
    class.define_method("source_policy", method!(Navigation::source_policy, 0))?;
    class.define_method("resume", method!(Navigation::resume, 0))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // A page whose session history has one entry, reached by a POST from `origin`'s document referred by `referer`.
    fn page_with_entry(origin: &str, referer: &str) -> (SessionHistory, u64) {
        let history = SessionHistory::new();
        let post = Some((std::sync::Arc::<[u8]>::from(&b"q=1"[..]), None));
        let mut data = Data::sent(Some(referer.to_owned()), Some("unsafe-url".to_owned()), Some(origin.to_owned()), post);
        data.set_cross_site(true);
        let id = history.record_page_entry("https://a.test/r".to_owned(), false, data).expect("an entry");
        (history, id)
    }
    fn document(url: &str, cross_site_ancestor: bool) -> Initiator {
        Initiator { url: url.to_owned(), cross_site_ancestor, client_id: Some(format!("c {url}")), ..Initiator::default() }
    }

    #[test]
    fn a_replay_is_referred_as_its_entry_was_and_a_scripts_is_its_documents_own() {
        let (history, id) = page_with_entry("https://b.test", "https://b.test/form");
        let mut script = Machine {
            handling: Some(Handling::Reload),
            replayed: Some(id),
            history: SessionHistory::of(history.id()),
            initiator: Some(document("https://a.test/r", false)),
            referrer: Some(("https://a.test/r".to_owned(), String::new())),
            post: Some((b"q=1".to_vec(), None)),
            ..Machine::default()
        };
        let request = script.request();
        assert_eq!((request.referrer.as_deref(), request.referrer_policy.as_str()), (Some("https://b.test/form"), "unsafe-url"));
        // (…its origin and its client its document's, the one that asked; its cookies judged by that one's site)
        assert_eq!((request.origin, request.initiator.as_deref(), request.traversed_initiator), (None, Some("https://a.test/r"), None));
        assert_eq!(script.client_id.as_deref(), Some("c https://a.test/r"));
        assert_eq!(request.reloaded_cross_site, None);
    }

    #[test]
    fn a_users_replay_is_of_the_origin_its_entry_was_first_sent_with() {
        let (history, id) = page_with_entry("https://b.test", "https://b.test/form");
        let mut users = Machine {
            handling: Some(Handling::Reload),
            replayed: Some(id),
            by_user: true,
            history: SessionHistory::of(history.id()),
            client: Some(document("https://a.test/r", false)),
            post: Some((b"q=1".to_vec(), None)),
            ..Machine::default()
        };
        let request = users.request();
        assert_eq!((request.origin.as_deref(), request.initiator), (Some("https://b.test"), None));
        assert_eq!((request.traversed_initiator.as_deref(), request.client_origin.as_deref()), (Some("https://b.test"), Some("https://a.test")));
        // (…a reload through a user interface element cross-site where the request it reloads was: RFC 6265bis §5.2)
        assert_eq!(request.reloaded_cross_site, Some(true));
        assert_eq!(users.client_id.as_deref(), Some("c https://a.test/r"));
    }

    #[test]
    fn a_users_frame_traversal_has_its_documents_cross_site_ancestor() {
        let mut frame = Machine {
            kind: Kind::Frame,
            handling: Some(Handling::Traverse(0, 0)),
            by_user: true,
            client: Some(document("https://a.test/f2", true)),
            referrer: Some(("https://a.test/top".to_owned(), String::new())),
            ..Machine::default()
        };
        let request = frame.request();
        assert!(request.initiator_cross_site_ancestor);
        assert_eq!((request.initiator, request.traversed_initiator, request.traversable), (None, None, None));
    }

    #[test]
    fn a_navigation_of_a_document_gone_since_is_of_the_url_it_referred_by() {
        let mut gone = Machine { kind: Kind::Window, handling: Some(Handling::Push), referrer: Some(("https://a.test/x".to_owned(), "no-referrer".to_owned())), ..Machine::default() };
        let request = gone.request();
        assert_eq!((request.initiator.as_deref(), request.referrer_policy.as_str()), (Some("https://a.test/x"), "no-referrer"));
        assert_eq!(gone.client_id, None);
    }
}
