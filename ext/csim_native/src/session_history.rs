// A top-level traversable's session history (HTML §7.4.1): ONE joint history of the page and every frame of it. Each
// navigable's entries are a list — the page's the traversable's own, a frame's a NESTED HISTORY in the document state of
// its parent's entry — and each entry has a STEP, the traversable's current one which the navigables' active entries are
// the entries of: a navigable's active entry is its entry of the greatest step not past it. A navigation of any of them
// adds the step after the current one (and clears every navigable's forward entries), a replacement keeps its entry's
// step, and `history.length` is the number of steps used; `history.back()` in the page or in any frame traverses the
// traversable by one step, which moves whichever navigable's entry the step is (Chrome: a frame navigated, the page's
// `history.length` is one more and its `history.back()` takes the FRAME back).
//
// The entries here are what the joint history is made of — their steps, their document states, their URLs — and what a
// replay of one sends and restores (`Data`), which the host gives and reads by the entry's id (browser.rb). A frame's
// navigable is the id navigables.rs gives it, and that of the page document build it was made under (`rebuilt`): a
// document the page traverses back to is made again with navigables of its own, which the nested histories its document
// state kept from before are not (they still count their steps).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError, Weak};

use magnus::{value::ReprValue, RArray, RHash, RString, Symbol, TryConvert};

use crate::navigation_plan::Traversal;

#[derive(Clone)]
struct Entry {
    id: u64,
    step: i64,
    url: String,
    doc: u64,
    // (…shared with the copies a saved history keeps: a change to it makes a new one, theirs left as it was)
    data: Arc<Data>,
}

// The text fields of an entry's `Data`: the origin, Referer and referrer policy its request was sent with, and its
// document's referrer.
const TEXT_FIELDS: [&str; 6] = ["origin", "referer", "referrer_policy", "referrer", "opener_policy", "document_origin"];

// What a replay of an entry sends and restores: how it was reached — a POST's body and content type, the origin, Referer
// and referrer policy its request was sent with (HTML's document state), whether its cookies were cross-site (which a
// reload through a user interface element is judged by: RFC 6265bis §5.2), its document state's navigable target name (a
// top-level one's `window.name`: HTML keeps it there, so a traversal brings it back) — its document's referrer, a
// frame's, and its classic history API state and its document's persisted form state, serialized
// (StructuredSerializeForStorage).
// A POST's body and content type.
pub(crate) type Post = (Arc<[u8]>, Option<String>);

#[derive(Clone, Default)]
pub(crate) struct Data {
    post: Option<Post>,
    // (…by `TEXT_FIELDS`)
    texts: [Option<String>; 6],
    cross_site: Option<bool>,
    name: Option<Vec<u16>>,
    state: Option<Arc<[u8]>>,
    form_state: Option<Arc<[u8]>>,
    // A frame's about:srcdoc document's markup: its document state's resource, what a traversal makes it of again.
    srcdoc: Option<Arc<str>>,
    // A `blob:` URL's document's blob and its type: the one its URL record's blob URL entry resolved as it was parsed
    // (URL parser), which a traversal or a reload of it fetches again — not the document state's, a pushState's URL of
    // none.
    blob: Option<(Arc<[u8]>, String)>,
}

impl Data {
    pub(crate) fn of(ruby: &magnus::Ruby, fields: RHash) -> Result<Self, magnus::Error> {
        let mut data = Data::default();
        data.merge(ruby, fields)?;
        Ok(data)
    }

    // The fields `fields` names made what it gives them — nil none — `:body` and `:content_type` a POST's together.
    fn merge(&mut self, ruby: &magnus::Ruby, fields: RHash) -> Result<(), magnus::Error> {
        let text = |key: &str| -> Result<Option<Option<String>>, magnus::Error> {
            let Some(v) = fields.get(ruby.to_symbol(key)) else { return Ok(None) };
            Ok(Some(Option::<String>::try_convert(v)?))
        };
        let bytes = |key: &str| -> Result<Option<Option<Arc<[u8]>>>, magnus::Error> {
            let Some(v) = fields.get(ruby.to_symbol(key)) else { return Ok(None) };
            Ok(Some(Option::<RString>::try_convert(v)?.map(|s| crate::fetch_rules::ruby_bytes(s).into())))
        };
        if let Some(body) = bytes("body")? {
            let content_type = text("content_type")?.flatten();
            self.post = body.map(|body| (body, content_type));
        }
        for (key, field) in TEXT_FIELDS.iter().zip(&mut self.texts) {
            if let Some(v) = text(key)? {
                *field = v;
            }
        }
        if let Some(v) = fields.get(ruby.to_symbol("cross_site")) {
            self.cross_site = Option::<bool>::try_convert(v)?;
        }
        if let Some(v) = text("name")? {
            self.name = v.map(|n| n.encode_utf16().collect());
        }
        if let Some(v) = text("srcdoc")? {
            self.srcdoc = v.map(Into::into);
        }
        if let Some(v) = bytes("state")? {
            self.state = v;
        }
        if let Some(v) = bytes("form_state")? {
            self.form_state = v;
        }
        Ok(())
    }

    // …and, an entry of the same document as `leaving`'s (a pushState's, a fragment navigation's), what it was reached by
    // where `self` names none: the document state the two share (HTML "URL and history update steps", "navigate to a
    // fragment": the new entry's document state the active one's) — its request's referrer and policy, its document's
    // referrer, whether its cookies were cross-site, its navigable target name. (…a POST's body its own entry's alone: a
    // reload of the URL a page pushed is a GET of it)
    fn sharing_document_state(mut self, leaving: &Data) -> Self {
        for (field, theirs) in self.texts.iter_mut().zip(&leaving.texts) {
            if field.is_none() {
                field.clone_from(theirs);
            }
        }
        self.cross_site = self.cross_site.or(leaving.cross_site);
        if self.name.is_none() {
            self.name.clone_from(&leaving.name);
        }
        if self.srcdoc.is_none() {
            self.srcdoc.clone_from(&leaving.srcdoc);
        }
        self
    }

    // The text field `key` names, where it has one.
    fn text(&self, key: &str) -> Option<&str> {
        self.texts[TEXT_FIELDS.iter().position(|&k| k == key)?].as_deref()
    }
    pub(crate) fn set_text(&mut self, key: &str, value: String) {
        if let Some(at) = TEXT_FIELDS.iter().position(|&k| k == key) {
            self.texts[at] = Some(value);
        }
    }

    // …the blob it is of (`blob`).
    pub(crate) fn set_blob(&mut self, bytes: Arc<[u8]>, given: &str) {
        self.blob = Some((bytes, given.to_owned()));
    }
    // …whether the request it is reached by was cross-site (`cross_site`).
    pub(crate) fn set_cross_site(&mut self, cross: bool) {
        self.cross_site = Some(cross);
    }
    // …no POST of its to send again, its request a GET from a redirect on (Fetch "HTTP-redirect fetch": the body null,
    // the referrer as it was) — referred as it was, by the request referrer and policy and of the initiator origin its
    // document state keeps (HTML), which a traversal back to it sends: Chrome 157's frame and Firefox 159's page and frame,
    // measured 2026-11-08, refer a Post/Redirect/Get page's by the form's page.
    pub(crate) fn forget_resource(&mut self) {
        self.post = None;
    }
    // …and what `reached` names of how it was reached — its request, its referrer, whether its cookies were cross-site —
    // in place of what it had.
    fn reached_by(&mut self, reached: Data) {
        if reached.post.is_some() {
            self.post = reached.post;
        }
        for (field, given) in self.texts.iter_mut().zip(reached.texts) {
            if given.is_some() {
                *field = given;
            }
        }
        self.cross_site = reached.cross_site.or(self.cross_site);
    }

    // …and as a hash of the ones it has.
    fn to_hash(&self, ruby: &magnus::Ruby, url: &str) -> Result<RHash, magnus::Error> {
        let hash = ruby.hash_new();
        hash.aset(ruby.to_symbol("url"), url)?;
        if let Some((body, content_type)) = &self.post {
            hash.aset(ruby.to_symbol("body"), ruby.str_from_slice(body))?;
            hash.aset(ruby.to_symbol("content_type"), content_type.as_deref())?;
        }
        for key in TEXT_FIELDS {
            if let Some(v) = self.text(key) {
                hash.aset(ruby.to_symbol(key), v)?;
            }
        }
        if let Some(v) = self.cross_site {
            hash.aset(ruby.to_symbol("cross_site"), v)?;
        }
        if let Some(v) = &self.name {
            hash.aset(ruby.to_symbol("name"), String::from_utf16_lossy(v))?;
        }
        if let Some(v) = &self.srcdoc {
            hash.aset(ruby.to_symbol("srcdoc"), &**v)?;
        }
        for (key, field) in [("state", &self.state), ("form_state", &self.form_state)] {
            if let Some(v) = field {
                hash.aset(ruby.to_symbol(key), ruby.str_from_slice(v))?;
            }
        }
        Ok(hash)
    }
}

// A session history as it stood (`SessionHistory::keep`), and the same-document updates made by then.
pub(crate) struct Kept(State, u64);

#[derive(Clone)]
struct Nested {
    navigable: u32,
    build: u32,
    entries: Vec<Entry>,
}

#[derive(Clone, Default)]
struct State {
    entries: Vec<Entry>,
    // Each document state's nested histories, by its id: the session histories of the child navigables of its document.
    docs: HashMap<u64, Vec<Nested>>,
    current: i64,
    // The navigables a traversal left at an entry other than the one the current step gives them — one whose target
    // entry's document was not made (a 204, a download): HTML "apply the history step" updates no such navigable, its
    // current entry the one it was at — by navigable, until a step gives it that entry again or it is navigated.
    // …each with the step it was at as it was held, which the navigables of its document are at with it.
    held: HashMap<u32, (u64, i64)>,
    // The target name the top-level navigable was made with, before it has a document state of its own to hold it (a
    // window `window.open` named: HTML "create a new auxiliary browsing context"), which its first one takes.
    initial_name: Vec<u16>,
    // The document state of the document the top-level navigable shows (`show`) — its active one's until a navigation's
    // response commits, though the entry the navigation pushed is current from its start: the one `window.name` reads
    // and writes, a pagehide's the leaving document's own — its name held apart (`shown_name`) where a replace navigation
    // took its entry away, until the next document shows.
    shown: Option<u64>,
    shown_name: Option<Vec<u16>>,
}

// A step applied that keeps the top-level navigable's document (`Traversable::begin_step`): the history as it stood, each
// navigable whose document the step makes again with the entry it was at, the step it was at, and whether the step moves
// a navigable within its document — what the step comes to once the host has made those documents or none (`end_step`).
struct Stepping {
    state: State,
    at: HashMap<u32, u64>,
    before: i64,
    within: bool,
}

// A frame's navigation under way — HTML "navigate"'s history entry, which only the document it makes puts in the session
// history ("finalize a cross-document navigation"): the URL it is made at, its navigable's parent, whether it takes the
// place of the active entry (a `location.replace`, a navigation of a document not completely loaded yet, the first in
// place of the frame's initial about:blank), what a replay of it sends and restores, and its number
// (`Traversable::begin_frame_entry`), which the host's fetch of it holds (navigation_commit.rs `Commit`).
// …and the entries its ancestors are given as it commits where they have none — a frame's frame's, navigated before its
// parent ever was — none made before it makes a document: one made for a navigation that then made none would leave a
// frame still at its initial about:blank with an entry, which the next navigation of it would come after.
struct FrameNavigation {
    token: u64,
    parent: u32,
    url: String,
    replace: bool,
    data: Data,
    ancestors: Vec<EntrySeed>,
}

// The entry a frame's navigable is given where it has none (HTML "create a new child navigable", `seed_entry`): its
// navigable, its parent's, the URL of the document it is at, that document's referrer and an about:srcdoc one's markup
// (HTML's document state: what a reload or a traversal to the entry makes its document with).
#[derive(Clone)]
struct EntrySeed {
    nav: u32,
    parent: u32,
    url: String,
    referrer: String,
    srcdoc: Option<Arc<str>>,
}

#[derive(Default)]
struct Traversable {
    state: State,
    made: u64,
    build: u32,
    // A traversal's step applied that keeps its top-level navigable's document (`begin_step`), until the host has made
    // the documents of the frames it moves, or none (`end_step`).
    stepping: Option<Stepping>,
    // Each frame's navigation under way, by its navigable — one at a time, a navigation begun ending the one before it
    // (HTML "navigate") — and the number the next one is given.
    navigations: HashMap<u32, FrameNavigation>,
    navigation_tokens: u64,
    // The page's entry a navigation of its document leaves, noted as it commits another (navigation_commit.rs
    // `set_leaving`), which takes that document's controls' state as it unloads (`#take_leaving`).
    leaving: Option<u64>,
    // Each navigable's ongoing navigation (HTML "set the ongoing navigation"), by its number — the one record of it, every
    // way a navigation begins writing it: a location, hyperlink or form navigation planned, a `javascript:` URL's
    // (navigation_plan.rs), a frame's `src` (frame_navigation.rs), the host's own (browser.rb, `#begin_navigation`) —
    // one begun replacing the one before it, a traversal applied making it "traversal" (`go_to`). What a `javascript:`
    // URL's task (navigation_plan.rs `javascriptOngoing`) and a navigation waiting to be made again (one deferred on an
    // activating service worker: browser.rb `await_sw_activation`) are judged by.
    ongoing: HashMap<u32, u64>,
    next_ongoing: u64,
    // The session history traversal queue (HTML §7.4.1.2): the traversals a page's `history` asked for, each applied as
    // its task runs, in order (`applyTraversal`) — and the token the next one is given.
    queued: Vec<Queued>,
    tokens: u64,
    // …and, while the host runs the tasks of the page it is navigating away from (browser.rb `flush_outgoing_page_init`),
    // the token of the last one queued before that navigation began: one queued after it that moves the page within its
    // documents is let go, the navigation under way winning — its step would point at an entry that is not the document
    // about to commit. (One that makes a document again is planned as any, the flush keeping what it planned apart:
    // navigation_plan.rs `flushBegin`.)
    flush_mark: Option<u64>,
    // …whether its traversals wait, none applied: while the host commits a `javascript:` URL's document its script asked
    // them before (browser.rb `commit_javascript_document`), which goes first — its flush running their tasks too — and
    // whether one applied is planned for the host and not taken (`applyTraversal`, navigation_plan.rs `takeTraversal`),
    // its cheap gate.
    holding: bool,
    planned_for_host: bool,
    // …and whether a traversal of the page is under way, its document being made (navigation_commit.rs): those queued
    // meanwhile wait behind it, as HTML's session history traversal queue runs its steps one after another — each
    // judged from the step the one before it went to ("traverse the history by a delta": currentStepIndex as it runs).
    page_traversal: Option<u64>,
    // How many same-document updates — pushState, replaceState, a fragment's — its navigables made (`update`): what a
    // traversal judges the history it began with by (`Kept`).
    same_document: u64,
    // Whether it closed: its window's browsing context discarded, which no opener of another window is then
    // (navigables.rs `opener_now`).
    closed: bool,
    // Whether web content made it — a script's `window.open`, a link's or a form's target — which makes it
    // script-closable (HTML "is created by web content"), not the driver's own window.
    by_web_content: bool,
    // What was asked of it that its own event loop takes as tasks (`Asked`).
    asked: Asked,
    // Its session storage shed (storage_areas.rs, HTML "session storage map" of the top-level traversable): the page's
    // its Browser's, which it is told (`#session_storage=`); a window's `window.open` made in an isolate its own, a copy
    // of its opener's made with it (`SessionHistory::copying`), which goes with it (`owns_storage`).
    session_storage: u64,
    owns_storage: bool,
    // The sandboxing flags its top-level navigable was made with (HTML's popup sandboxing flag set: the flags of the
    // sandboxed document that opened it, where they propagate to the windows it opens), which every document of it is
    // sandboxed by (`popup_sandbox_of`).
    popup_sandbox: u32,
    // The URL of the document its top-level navigable is at, a traversable a Browser hosts (the page's): the host's to
    // say as a navigation commits a document, its document's own to change by its URL and history update steps
    // (`pushState`, `replaceState`, a fragment navigation: `history_update`) — none before the first, nor for a window
    // `window.open` made in an isolate, whose realm's `location` is the one URL it has. And, while the host notes them
    // (`noting`: as its event loop runs a turn or a document loads), the URLs those steps moved it from, which the host
    // takes (`#note_url_changes`): the intermediates a polling `current_url` walks (browser.rb `note_url_changes`).
    url: Option<String>,
    noting: bool,
    passed: Vec<String>,
    // The opener policy of the document its top-level navigable is at (HTML Document's "opener policy", which only a
    // top-level one's is ever read): what its next navigation's responses are enforced against (navigation_fetch.rs
    // `CoopEnforcement`), and a document of no headers takes of it (coop.rs `inherited`). A traversal to such a document
    // or its reload finds the one it took in its entry (`TEXT_FIELDS`), as HTML's "history policy container" keeps a policy
    // container for a local scheme.
    opener_policy: crate::coop::Value,
    // The top-level creation URL of its initial about:blank where a creator made it, that creator's (HTML "create a new browsing
    // context and document"), let go of as its first document commits (`commit_opener_policy`), whose own URL it is from then on.
    creation_url: Option<String>,
    // Whether its session counts the driver's default host as the loopback origin it stands for (url_ops.rs).
    loopback_stand_in: bool,
}

impl Drop for Traversable {
    fn drop(&mut self) {
        if self.owns_storage {
            crate::storage_areas::clear(self.session_storage);
        }
    }
}

// What was asked of a top-level traversable that a Browser hosts — a window of a browsing context group of its own: one
// opened without its opener, or the driver's — that its own event loop takes as tasks: the navigation it was opened
// for (HTML "window open steps": "navigate" the new navigable, whose steps after the source snapshot continue as a task
// of its agent: the URL resolved against the opener's document, its Referer, its transient activation, the resource it
// navigates to), and whether its page's `close()` asked it to close (HTML "is closing", set as it asks; the close itself
// a task: `close_due`). Every one of a process's counted in `ASKED`, which the host reads with no lock
// (`window_tasks_pending`) — a session of one window asks nothing.
#[derive(Default)]
struct Asked {
    planned: Option<Planned>,
    closing: bool,
    close_due: bool,
}
// A navigation planned — the traversable's ongoing navigation, one at a time: a second plan replaces the first, as a
// navigation begun aborts the ongoing one (HTML "set the ongoing navigation") — its URL, whether it replaces the active
// entry, whether the sender had transient activation, the Referer it sends and its policy, the document that began it
// (`Initiator`), and what it navigates to (`Resource`).
#[derive(Clone, Debug, PartialEq)]
struct Planned {
    url: String,
    replace: bool,
    activated: bool,
    referrer: Option<String>,
    policy: Option<String>,
    initiator: Initiator,
    resource: Resource,
}
// …the document that began it — the frame whose script did, not its window's page — as Browser#navigation_initiator
// describes it: its URL (an about:blank one's creator's), whose site `Sec-Fetch-Site` and its cookies measure from
// (none where not known), whether its origin is opaque (a sandboxed one's: its `Origin: null`, of no site, cross-site
// to every URL), and whether it has a cross-site ancestor (HTML's, Fetch's "determine the same-site mode" step 4 reads).
#[derive(Clone, Debug, Default, PartialEq)]
struct Initiator {
    url: Option<String>,
    opaque: bool,
    cross_site_ancestor: bool,
    client_id: Option<String>,
}
impl Initiator {
    // …of `{initiator:, origin_null:, initiator_cross_site_ancestor:, client_id:}`, none for nil.
    fn from_ruby(ruby: &magnus::Ruby, hash: Option<RHash>) -> Result<Self, magnus::Error> {
        let Some(hash) = hash else { return Ok(Initiator::default()) };
        let get = |key: &str| hash.aref::<_, magnus::Value>(ruby.to_symbol(key));
        Ok(Initiator {
            url: Option::<String>::try_convert(get("initiator")?)?,
            opaque: get("origin_null")?.to_bool(),
            cross_site_ancestor: get("initiator_cross_site_ancestor")?.to_bool(),
            client_id: Option::<String>::try_convert(get("client_id")?)?,
        })
    }
    // …into `hash` by those names.
    fn into_ruby(self, ruby: &magnus::Ruby, hash: RHash) -> Result<(), magnus::Error> {
        hash.aset(ruby.to_symbol("initiator"), self.url)?;
        hash.aset(ruby.to_symbol("origin_null"), self.opaque)?;
        hash.aset(ruby.to_symbol("initiator_cross_site_ancestor"), self.cross_site_ancestor)?;
        hash.aset(ruby.to_symbol("client_id"), self.client_id)
    }
}
// …a URL fetched with a GET; a `blob:` URL's blob — its bytes and type — as the sender's Location parsed it (HTML: the
// URL's blob URL entry, resolved as it is parsed, which a revoke after does not take back); a POST resource, a form's
// submission's — its encoded body and its content type; or a `javascript:` URL's source, run in the target's document
// where that is same origin with the initiator's as the task runs (HTML "navigate to a javascript: URL"), the
// initiator's origin by the key its traversable publishes (`published_key`).
#[derive(Clone, Debug, PartialEq)]
enum Resource {
    Get,
    Blob(Vec<u8>, String),
    Post { body: Vec<u8>, content_type: String },
}

static ASKED: AtomicUsize = AtomicUsize::new(0);
// The traversable's asks changed by `change`, the process's count kept with them.
fn asking<R>(t: &mut Traversable, change: impl FnOnce(&mut Traversable) -> R) -> R {
    let before = t.pending();
    let r = change(t);
    let after = t.pending();
    if after > before {
        ASKED.fetch_add(after - before, Ordering::Relaxed);
    } else if before > after {
        ASKED.fetch_sub(before - after, Ordering::Relaxed);
    }
    r
}
// Whether a traversable of the process has been asked something it has yet to take (the host's cheap gate).
pub(crate) fn window_tasks_pending() -> bool {
    ASKED.load(Ordering::Relaxed) > 0
}

// A traversal queued: its token, its delta, whether it makes a document again
// (one it moves within the documents waits a turn: its `popstate` after what is due as the script ends) — and the
// top-level document it was asked of (its document state, `Entry::doc`), and whether it replaces that one: the
// traversals asked of a document after one that replaces it are let go as that one is taken (`take_due`).
#[derive(Clone, Copy)]
struct Queued {
    token: u64,
    delta: i64,
    documents: bool,
    source: u64,
    replaces: bool,
    // Whether it was queued behind a traversal of the page whose document was being made (`page_traversal`), which it
    // is judged after, from the step that one goes to: what the document made anew keeps (`#clear_queued`) — the first
    // of a document's that makes the page's document again winning, as for any (`take_due`).
    behind: bool,
}
#[cfg(test)]
impl Queued {
    fn row(self) -> (u64, i64) {
        (self.token, self.delta)
    }
}

// The navigable a list belongs to: 0 the traversable's own.
pub(crate) const TOP: u32 = 0;
// The steps a session history keeps (`State::trim`).
const MAX_STEPS: usize = 50;
// The ongoing navigation "traversal" (`Traversable::begin_traversal`), which no navigation's number is.
const TRAVERSAL: u64 = u64::MAX;

// Whether a frame's entry at `url` can be made again by a traversal: one of an http(s) URL, a `blob:` one's — fetched anew
// from the window's blob URL store, a revoked one's a network error (HTML "apply the history step": its document made by
// fetching) — a data: one's, which holds its own bytes, about:blank's, or an about:srcdoc one's, whose markup its entry
// keeps (HTML's document state "about base URL" and resource: `Data::srcdoc`, a traversal's `traversable`).
pub(crate) fn recordable(url: &str) -> bool {
    let scheme = url.split_once(':').map_or("", |(s, _)| s);
    if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") {
        return url[scheme.len()..].starts_with("://");
    }
    if scheme.eq_ignore_ascii_case("blob") || scheme.eq_ignore_ascii_case("data") {
        return true;
    }
    let about = |name: &str| url.get(..name.len()).filter(|s| s.eq_ignore_ascii_case(name)).map(|_| &url[name.len()..]);
    about("about:blank").or_else(|| about("about:srcdoc")).is_some_and(|rest| rest.is_empty() || rest.starts_with(['?', '#']))
}
// …and an entry of it: an about:srcdoc one's where it has the markup (the entry of a frame left before it kept any has none).
fn traversable(url: &str, data: &Data) -> bool {
    recordable(url) && (data.srcdoc.is_some() || url.get(..12).is_none_or(|s| !s.eq_ignore_ascii_case("about:srcdoc")))
}

// One navigable's change of active entry a traversal makes: its navigable, the entry, and whether that is of the same
// document as the entry it leaves (a popstate, not a document made again).
pub(crate) type Change = (u32, u64, bool);

fn active(list: &[Entry], step: i64) -> Option<&Entry> {
    list.iter().filter(|e| e.step <= step).max_by_key(|e| e.step)
}

impl State {
    fn new() -> Self {
        State { current: -1, ..Default::default() }
    }

    // Navigable `nav`'s current entry of its list read at `step`: the one a traversal held it at, else that step's.
    fn current_of<'a>(&self, nav: u32, list: &'a [Entry], step: i64) -> Option<&'a Entry> {
        self.held.get(&nav).and_then(|&(id, _)| list.iter().find(|e| e.id == id)).or_else(|| active(list, step))
    }

    // The tree of current entries: each navigable in it — of page document build `build` — its entry list, the step
    // that list is read at (the current one, but under a navigable a traversal held, the step it was at as it was held)
    // and the document state whose nested histories hold it (none for the page's).
    fn tree(&self, build: u32) -> Vec<(u32, &Vec<Entry>, i64, Option<u64>)> {
        let mut out = Vec::new();
        let mut stack = vec![(TOP, &self.entries, self.current, None)];
        while let Some((nav, list, step, parent)) = stack.pop() {
            out.push((nav, list, step, parent));
            let Some(entry) = self.current_of(nav, list, step) else { continue };
            let below = self.held.get(&nav).map_or(step, |&(_, at)| at);
            for nested in self.docs.get(&entry.doc).into_iter().flatten().filter(|n| n.build == build) {
                stack.push((nested.navigable, &nested.entries, below, Some(entry.doc)));
            }
        }
        out
    }

    // …each navigable's current entry in it, by navigable.
    fn current_entries(&self, build: u32) -> HashMap<u32, u64> {
        self.tree(build).into_iter().filter_map(|(nav, list, step, _)| Some((nav, self.current_of(nav, list, step)?.id))).collect()
    }

    // Navigable `nav`'s entry list in the tree of current entries and the step it is read at, or None where it has
    // none there.
    fn find(&self, nav: u32, build: u32) -> Option<(&Vec<Entry>, i64)> {
        if nav == TOP {
            return Some((&self.entries, self.current));
        }
        self.tree(build).into_iter().find(|&(n, ..)| n == nav).map(|(_, list, step, _)| (list, step))
    }

    fn list(&self, nav: u32, build: u32) -> Option<&Vec<Entry>> {
        self.find(nav, build).map(|(list, _)| list)
    }

    // The navigable target name of the top-level navigable's active document state (`window.name`), and — `set_name` —
    // the one every entry of that document has made `name`: the state they share.
    // (…the shown document's, else the current entry's — none shown yet, or its entries replaced since)
    fn name(&self, build: u32) -> Vec<u16> {
        if let Some(name) = &self.shown_name {
            return name.clone();
        }
        let shown = self.shown.and_then(|doc| self.entries.iter().find(|e| e.doc == doc));
        match shown.or_else(|| self.current_entry(TOP, build)) {
            Some(e) => e.data.name.clone().unwrap_or_default(),
            None => self.initial_name.clone(),
        }
    }
    fn set_name(&mut self, build: u32, name: &[u16]) {
        if let Some(held) = &mut self.shown_name {
            *held = name.to_vec();
            return;
        }
        let shown = self.shown.filter(|&doc| self.entries.iter().any(|e| e.doc == doc));
        let Some(doc) = shown.or_else(|| self.current_entry(TOP, build).map(|e| e.doc)) else {
            self.initial_name = name.to_vec();
            return;
        };
        for entry in self.entries.iter_mut().filter(|e| e.doc == doc) {
            Arc::make_mut(&mut entry.data).name = Some(name.to_vec());
        }
    }
    // The top-level navigable's document committed: the one its current entry is of is the one it shows.
    fn show(&mut self, build: u32) {
        self.shown = self.current_entry(TOP, build).map(|e| e.doc);
        self.shown_name = None;
    }

    // …and its current entry.
    fn current_entry(&self, nav: u32, build: u32) -> Option<&Entry> {
        let (list, step) = self.find(nav, build)?;
        self.current_of(nav, list, step)
    }

    fn list_mut(&mut self, nav: u32, build: u32) -> Option<&mut Vec<Entry>> {
        if nav == TOP {
            return Some(&mut self.entries);
        }
        let doc = self.parent_doc_of(nav, build)?;
        self.docs.get_mut(&doc)?.iter_mut().find(|n| n.navigable == nav && n.build == build).map(|n| &mut n.entries)
    }

    // The document state whose nested histories hold navigable `nav`'s, in the tree of current entries.
    fn parent_doc_of(&self, nav: u32, build: u32) -> Option<u64> {
        self.tree(build).into_iter().find(|&(n, ..)| n == nav).and_then(|(.., parent)| parent)
    }

    fn entry(&self, id: u64) -> Option<&Entry> {
        self.all_lists().into_iter().flatten().find(|e| e.id == id)
    }

    fn entry_mut(&mut self, id: u64) -> Option<&mut Entry> {
        let State { entries, docs, .. } = self;
        std::iter::once(entries).chain(docs.values_mut().flatten().map(|n| &mut n.entries)).flatten().find(|e| e.id == id)
    }

    fn all_lists(&self) -> Vec<&Vec<Entry>> {
        let mut lists = vec![&self.entries];
        lists.extend(self.docs.values().flatten().map(|n| &n.entries));
        lists
    }

    // `history.length`: the number of steps used, at least 1.
    fn length(&self) -> usize {
        self.used_steps().len().max(1)
    }

    // The oldest steps let go of past `MAX_STEPS` (HTML sets no limit; Chrome 157 and Firefox 159 both keep 50 —
    // measured 2026-11-08, 60 navigations, 60 `blob:` navigations and 60 pushStates each giving `history.length` 50,
    // Firefox trimming its pushStates' a moment later): each navigable's entry of the oldest step dropped where its next
    // entry is of the next step, else made that step's — the one it is still at there.
    fn trim(&mut self) {
        loop {
            let steps = self.used_steps();
            let [oldest, next, ..] = steps[..] else { return };
            if steps.len() <= MAX_STEPS {
                return;
            }
            let lists = std::iter::once(&mut self.entries).chain(self.docs.values_mut().flatten().map(|n| &mut n.entries));
            for list in lists {
                let Some(at) = list.iter().position(|e| e.step == oldest) else { continue };
                if list.get(at + 1).is_some_and(|e| e.step == next) {
                    list.remove(at);
                } else {
                    list[at].step = next;
                }
            }
            self.collect_docs();
        }
    }

    // HTML "get all used history steps".
    fn used_steps(&self) -> Vec<i64> {
        self.all_lists().into_iter().flatten().map(|e| e.step).collect::<BTreeSet<_>>().into_iter().collect()
    }

    // HTML "clear the forward session history": every navigable's entries past the current step dropped — and the
    // document states only they had, with the nested histories in them. A navigable whose current entry is past it —
    // one a traversal held there, a navigable of that one's document — keeps that entry, now the current step's: the one
    // it is at, whose document it shows, in place of that step's own, which it never went to.
    fn clear_forward(&mut self, build: u32) {
        let current = self.current;
        let at: HashSet<u64> = self.tree(build).into_iter().filter_map(|(nav, list, step, _)| self.current_of(nav, list, step)).map(|e| e.id).collect();
        let keep = |list: &mut Vec<Entry>| {
            if let Some(i) = list.iter().position(|e| e.step > current && at.contains(&e.id)) {
                list[i].step = current;
                let id = list[i].id;
                list.retain(|e| e.id == id || e.step != current);
            }
            list.retain(|e| e.step <= current);
        };
        keep(&mut self.entries);
        for nested in self.docs.values_mut().flatten() {
            keep(&mut nested.entries);
        }
        self.collect_docs();
        self.drop_stale_holds(build);
    }

    // …a hold of an entry gone, of a navigable out of the tree, or of the entry the step gives its navigable anyway, let
    // go of.
    fn drop_stale_holds(&mut self, build: u32) {
        if self.held.is_empty() {
            return;
        }
        let stands: HashSet<u32> = self
            .tree(build)
            .into_iter()
            .filter(|&(nav, list, step, _)| {
                self.held.get(&nav).is_some_and(|&(id, _)| list.iter().any(|e| e.id == id) && active(list, step).is_some_and(|e| e.id != id))
            })
            .map(|(nav, ..)| nav)
            .collect();
        self.held.retain(|nav, _| stands.contains(nav));
    }

    // …and one of a navigable the step `to` moves to another entry than the current one's: it is navigated by the
    // traversal, held at none (the host holding it again where that one's document is not made: `hold`).
    fn release_moved(&mut self, to: i64, build: u32) {
        if self.held.is_empty() {
            return;
        }
        let moved: HashSet<u32> = self
            .tree(build)
            .into_iter()
            .filter(|&(nav, list, step, _)| {
                self.held.contains_key(&nav) && active(list, step).map(|e| e.id) != active(list, to).map(|e| e.id)
            })
            .map(|(nav, ..)| nav)
            .collect();
        self.held.retain(|nav, _| !moved.contains(nav));
    }

    fn collect_docs(&mut self) {
        let mut live = HashSet::new();
        let mut lists = vec![self.entries.clone()];
        while let Some(list) = lists.pop() {
            for e in list {
                if live.insert(e.doc) {
                    lists.extend(self.docs.get(&e.doc).into_iter().flatten().map(|n| n.entries.clone()));
                }
            }
        }
        self.docs.retain(|doc, _| live.contains(doc));
    }
}

impl Traversable {
    fn mint(&mut self) -> u64 {
        self.made += 1;
        self.made
    }

    // …made of `seed` (`EntrySeed`): its document's referrer and an about:srcdoc one's markup kept by it where it has none.
    fn seed_entry(&mut self, seed: &EntrySeed) -> Option<u64> {
        let id = self.ensure(seed.nav, seed.parent, &seed.url)?;
        let entry = self.state.entry_mut(id)?;
        if entry.data.text("referrer").is_none() {
            Arc::make_mut(&mut entry.data).set_text("referrer", seed.referrer.clone());
        }
        if entry.data.srcdoc.is_none() && seed.srcdoc.is_some() {
            Arc::make_mut(&mut entry.data).srcdoc.clone_from(&seed.srcdoc);
        }
        Some(id)
    }
    // Navigable `nav`'s entry list, made — HTML "create a new child navigable": a nested history in its parent's active
    // document state, its one entry `url`'s of the step of that document state's first entry — where it has none.
    fn ensure(&mut self, nav: u32, parent: u32, url: &str) -> Option<u64> {
        let build = self.build;
        if self.state.list(nav, build).is_some() {
            return self.state.current_entry(nav, build).map(|e| e.id);
        }
        let doc = self.state.current_entry(parent, build)?.doc;
        let parent_list = self.state.list(parent, build)?;
        let step = parent_list.iter().filter(|e| e.doc == doc).map(|e| e.step).min()?;
        let (id, entry_doc) = (self.mint(), self.mint());
        let entry = Entry { id, step, url: url.to_owned(), doc: entry_doc, data: Default::default() };
        self.state.docs.entry(doc).or_default().push(Nested { navigable: nav, build, entries: vec![entry] });
        Some(id)
    }

    // A navigation of `nav` to `url` committed: an entry of the step after the current one (its forward entries, and
    // every other navigable's, cleared first: HTML "finalize a cross-document navigation") — or, `replace`, in place of
    // its active entry, of that one's step — what a replay of it sends and restores `data`. `same_document` keeps the
    // entry's document state (a pushState / a fragment's / a replaceState).
    fn commit(&mut self, nav: u32, parent: u32, url: &str, same_document: bool, replace: bool, data: Data) -> Option<u64> {
        if nav != TOP && self.state.list(nav, self.build).is_none() {
            self.ensure(nav, parent, "about:blank")?;
        }
        let (id, fresh_doc) = (self.mint(), self.mint());
        let build = self.build;
        let current = self.state.current;
        let leaving = self.state.current_entry(nav, build).cloned();
        // (…navigated now: its entry the one it is given, held at none)
        self.state.held.remove(&nav);
        if !replace {
            self.state.clear_forward(build);
        }
        let initial_name = self.state.initial_name.clone();
        let list = self.state.list_mut(nav, build)?;
        let (doc, data) = match (&leaving, same_document) {
            (Some(e), true) => (e.doc, data.sharing_document_state(&e.data)),
            // (…a top-level navigable's new document state its navigable target name the active one's: HTML "navigate",
            // which a navigation to another origin that leaves no opener clears as it finishes — the host's to say)
            (Some(e), false) if nav == TOP && data.name.is_none() => (fresh_doc, Data { name: e.data.name.clone(), ..data }),
            (None, _) if nav == TOP && data.name.is_none() => (fresh_doc, Data { name: Some(initial_name), ..data }),
            _ => (fresh_doc, data),
        };
        if replace {
            if let Some(old) = leaving {
                // (…the document it replaces still shown, its name held apart until the next one shows)
                if nav == TOP && old.doc != doc && self.state.shown == Some(old.doc) {
                    self.state.shown_name = Some(old.data.name.clone().unwrap_or_default());
                }
                let list = self.state.list_mut(nav, build)?;
                let at = list.iter().position(|e| e.id == old.id)?;
                list[at] = Entry { id, step: old.step, url: url.to_owned(), doc, data: Arc::new(data) };
                self.state.collect_docs();
                return Some(id);
            }
        }
        let step = current + 1;
        list.push(Entry { id, step, url: url.to_owned(), doc, data: Arc::new(data) });
        self.state.current = step;
        self.state.drop_stale_holds(build);
        self.state.trim();
        Some(id)
    }
    // A navigation of frame `nav` (its parent `parent`) to `url` begun: the entry it makes as its document is — in place of
    // the active one where `replace` — what a replay of it sends and restores `data`; its number. The frame's navigation
    // under way before it ended by it, its entry never made.
    // (…`ancestors` the entries its ancestors are given as it commits, outermost first)
    fn begin_frame_entry(&mut self, nav: u32, parent: u32, url: String, replace: bool, data: Data, ancestors: Vec<EntrySeed>) -> u64 {
        self.navigation_tokens += 1;
        let token = self.navigation_tokens;
        self.navigations.insert(nav, FrameNavigation { token, parent, url, replace, data, ancestors });
        token
    }
    // …its document made: its entry committed (`commit`) — at the URL a redirect took it to, `redirect`, with no POST to
    // send again where that made its request a GET; of `reached` beside what it began with — where it is the frame's
    // navigation under way, of number `token`.
    fn commit_frame_navigation(&mut self, nav: u32, token: u64, redirect: Option<(&str, bool)>, reached: Data) -> Option<u64> {
        let FrameNavigation { parent, mut url, replace, mut data, ancestors, .. } = self.take_frame_navigation(nav, token)?;
        data.reached_by(reached);
        if let Some((to, get)) = redirect {
            to.clone_into(&mut url);
            if get {
                data.forget_resource();
            }
        }
        for seed in &ancestors {
            self.seed_entry(seed);
        }
        let made = self.commit(nav, parent, &url, false, replace, data);
        // (…its parent's entry there by now: one it has not is a bug of this file's, which would lose the entry silently)
        if made.is_none() {
            debug_assert!(false, "frame navigable {nav}'s entry at {url} not made");
            eprintln!("csim: frame navigable {nav}'s session history entry at {url} could not be made");
        }
        made
    }
    // …or none made (a 204, a download, a hand-off, another navigation ending it, a failure of the host's): the history as
    // it is, its entry let go.
    fn abandon_frame_navigation(&mut self, nav: u32, token: u64) {
        self.take_frame_navigation(nav, token);
    }
    fn take_frame_navigation(&mut self, nav: u32, token: u64) -> Option<FrameNavigation> {
        let ours = self.navigations.get(&nav).is_some_and(|n| n.token == token);
        if ours { self.navigations.remove(&nav) } else { None }
    }
    // The request entry `id`'s document is reached by now a redirect's (`SessionHistory::redirect_entry`).
    fn redirect_entry(&mut self, id: u64, url: &str, get: bool) {
        let Some(e) = self.state.entry_mut(id) else { return };
        url.clone_into(&mut e.url);
        if get {
            Arc::make_mut(&mut e.data).forget_resource();
        }
    }

    // HTML "traverse the history by a delta": the step `delta` used steps from the current one, and each navigable's
    // change of active entry applying it makes — the page's first, then its frames' (none of a navigable whose document
    // is made again, its frames made with it) — or None where there is no such step.
    fn plan(&self, delta: i64) -> Option<(i64, Vec<Change>)> {
        let steps = self.state.used_steps();
        let here = steps.iter().rposition(|&s| s <= self.state.current)? as i64;
        let target = *steps.get(usize::try_from(here + delta).ok()?)?;
        let mut changes = Vec::new();
        let mut lists = vec![(TOP, &self.state.entries, self.state.current)];
        while let Some((nav, list, step)) = lists.pop() {
            let (Some(from), Some(to)) = (self.state.current_of(nav, list, step), active(list, target)) else { continue };
            let same_document = from.doc == to.doc;
            if from.id != to.id {
                changes.push((nav, to.id, same_document));
            }
            if same_document {
                let below = self.state.held.get(&nav).map_or(step, |&(_, at)| at);
                for nested in self.state.docs.get(&to.doc).into_iter().flatten().filter(|n| n.build == self.build).rev() {
                    lists.push((nested.navigable, &nested.entries, below));
                }
            }
        }
        Some((target, changes))
    }

    // …the plan of a traversal by `delta` as the host applies it: past a step whose frame's entry it cannot make again
    // (`traversable`), on to the next step that way.
    fn traversal(&self, mut delta: i64) -> Option<(i64, Vec<Change>)> {
        let way = if delta > 0 { 1 } else { -1 };
        loop {
            let plan = self.plan(delta)?;
            let stuck = plan.1.iter().any(|&(nav, id, same_document)| {
                nav != TOP && !same_document && !self.state.entry(id).is_some_and(|e| traversable(&e.url, &e.data))
            });
            if !stuck {
                return Some(plan);
            }
            delta += way;
        }
    }

    // A traversal by `delta` appended to the session history traversal queue (HTML "traverse the history by a delta"):
    // [its token, the delay of its task] — none for one making a document again,
    // whose task goes ahead of a navigation the script plans after it (a frame's `src` set, Chrome and Firefox: never
    // requested), a turn for one within the documents. Judged from the step those queued before it reach.
    fn queue(&mut self, delta: i64) -> (u64, u32) {
        self.tokens += 1;
        let token = self.tokens;
        let ahead: i64 = self.queued.iter().map(|q| q.delta).sum();
        let changes = self.traversal(ahead + delta).map(|(_, changes)| changes).unwrap_or_default();
        let documents = changes.iter().any(|&(_, _, same)| !same);
        let replaces = changes.iter().any(|&(nav, _, same)| nav == TOP && !same);
        let source = self.state.current_entry(TOP, self.build).map_or(0, |e| e.doc);
        self.queued.push(Queued { token, delta, documents, source, replaces, behind: self.page_traversal.is_some() });
        (token, if documents { 0 } else { 1 })
    }
    // …those queued up to and with the one of `token`, taken off the queue to be applied in order: none where it is not
    // queued (the host applied it already).
    fn take_queued(&mut self, token: u64) -> Vec<Queued> {
        let Some(at) = self.queued.iter().position(|q| q.token == token) else { return Vec::new() };
        self.take_due(at + 1)
    }
    // …those up to and with the last that makes a document again — what the host applies as the task that asked ends:
    // the ones after it, moves within a document, left to their own tasks, a turn later.
    fn take_documents_queued(&mut self) -> Vec<Queued> {
        let Some(at) = self.queued.iter().rposition(|q| q.documents) else { return Vec::new() };
        self.take_due(at + 1)
    }
    // …and every one.
    fn take_all_queued(&mut self) -> Vec<Queued> {
        self.take_due(self.queued.len())
    }
    // The first `n` queued, taken to be applied in order — the page's, a window's of this isolate alike: but those asked
    // of a document after a traversal that replaces it, which are let go with it, those still queued too. The first
    // wins — a recorded divergence from HTML's text: "traverse the history by a delta" computes each queued step as it
    // runs ("Let currentStepIndex be … Let targetStepIndex be currentStepIndex plus delta"), its only early exits a
    // step that does not exist, an initiator not allowed, and a `beforeunload` or `navigate` cancellation, so it would
    // run both. The non-tentative WPT traverse_the_history_1 (`go(-2); go(-1)`: pages `[4, 2]`, page 2 alone) and
    // Chrome and Firefox (measured 2026-10-31, the page's own and another window's alike) drop the later ones. (HTML
    // navigate's "a navigable that is currently traversing … ignored" is about navigations, not queued traversals.)
    fn take_due(&mut self, n: usize) -> Vec<Queued> {
        let mut ended = HashSet::new();
        let taken: Vec<Queued> = self.queued.drain(..n).filter(|q| !ended.contains(&q.source) && (!q.replaces || ended.insert(q.source))).collect();
        self.queued.retain(|q| !ended.contains(&q.source));
        taken
    }
    // Whether a traversal queued — one that makes a document again — has a task of its page's still to apply it.
    fn queued_documents(&self) -> bool {
        self.queued.iter().any(|q| q.documents)
    }
    // A navigation of navigable `nav` begun, its ongoing one now (HTML "set the ongoing navigation"): its number — and
    // whether the one numbered `id` still is.
    // (…a frame's navigation under way before it ended with it, its entry never made: HTML "navigate", "this will abort
    // other ongoing navigations")
    fn begin_navigation(&mut self, nav: u32) -> u64 {
        self.navigations.remove(&nav);
        self.next_ongoing += 1;
        self.ongoing.insert(nav, self.next_ongoing);
        self.next_ongoing
    }
    fn navigation_ongoing(&self, nav: u32, id: u64) -> bool {
        self.ongoing.get(&nav) == Some(&id)
    }
    // …and a traversal planned that changes navigable `nav`'s document — its ongoing navigation "traversal" (HTML "apply
    // the history step"), any navigation of it ignored (HTML "navigate": "If navigable's ongoing navigation is
    // "traversal" … return") until the host applies it (`go_to`) or lets it go (`end_traversal`) — and whether it is.
    fn begin_traversal(&mut self, nav: u32) {
        self.ongoing.insert(nav, TRAVERSAL);
    }
    fn traversing(&self, nav: u32) -> bool {
        self.ongoing.get(&nav) == Some(&TRAVERSAL)
    }
    fn end_traversal(&mut self) {
        self.ongoing.retain(|_, &mut id| id != TRAVERSAL);
    }
    // The traversal to `step` applied — the step a plan gave — which ends the navigations of the navigables whose current
    // entry it changes, and theirs alone (HTML "apply the history step": "For each navigable of changingNavigables … Set
    // navigable's ongoing navigation to "traversal"", changingNavigables the navigables "whose current session history
    // entry will change"): a frame's navigation under way goes on past a traversal that moves the page within its
    // document (Chrome 157 and Firefox 159). Its own "traversal" marks let go, the traversal done.
    fn go_to(&mut self, step: i64) {
        let build = self.build;
        let before = self.state.current_entries(build);
        self.state.release_moved(step, build);
        self.state.current = step;
        self.state.drop_stale_holds(build);
        let after = self.state.current_entries(build);
        for (nav, id) in before {
            if after.get(&nav) != Some(&id) {
                self.ongoing.remove(&nav);
                self.navigations.remove(&nav);
            }
        }
        self.end_traversal();
    }
    // A traversal's step `step` applied that keeps its top-level navigable's document — `changes`, the navigables it
    // moves (`plan`), each moved within its document or made the document of its entry again (HTML "apply the history
    // step"): the history as it stood kept for `end_step`; the moves within a document returned, each navigable's with
    // its entry's URL and classic history API state and whether its fragment changed (HTML "update document for history
    // step application": the location the URL, `popstate` with the state, then a `hashchange`, the host's).
    fn begin_step(&mut self, step: i64, changes: &[Change]) -> Vec<(u32, String, Option<Arc<[u8]>>, bool)> {
        let build = self.build;
        let at = changes.iter().filter(|c| !c.2).filter_map(|&(nav, ..)| self.state.current_entry(nav, build).map(|e| (nav, e.id))).collect();
        let from: HashMap<u32, String> = changes.iter().filter(|c| c.2).filter_map(|&(nav, ..)| self.state.current_entry(nav, build).map(|e| (nav, e.url.clone()))).collect();
        let within = changes.iter().any(|c| c.2);
        self.stepping = Some(Stepping { state: self.state.clone(), at, before: self.state.current, within });
        self.go_to(step);
        let entry = |id| self.state.entry(id);
        changes
            .iter()
            .filter(|c| c.2)
            .filter_map(|&(nav, id, _)| entry(id).map(|e| (nav, e.url.clone(), e.data.state.clone(), from.get(&nav).is_none_or(|f| fragment(f) != fragment(&e.url)))))
            .collect()
    }
    // …and its frames' documents made but those of `none` — of the navigables `attempted` it was to make them of: the step
    // stands, a navigable whose document was not made held at the entry it was at (HTML "apply the history step": its
    // update-only, the navigable not updated) — but one none of whose documents was made, moving nothing within a
    // document, leaves the history as it stood (Chrome and Firefox stay where they were).
    fn end_step(&mut self, attempted: usize, none: &[u32]) {
        let Some(Stepping { state, at, before, within }) = self.stepping.take() else { return };
        if !within && none.len() == attempted {
            self.state = state;
            return;
        }
        for nav in none {
            if let Some(&id) = at.get(nav) {
                self.hold(*nav, id, before);
            }
        }
    }
    // Navigable `nav` left at `entry` — the one it was at at `step` — by the step just applied, its target entry's
    // document not made.
    fn hold(&mut self, nav: u32, id: u64, step: i64) {
        let build = self.build;
        self.state.held.insert(nav, (id, step));
        self.state.drop_stale_holds(build);
    }
    // How many tasks asked of it wait (`Asked`).
    fn pending(&self) -> usize {
        usize::from(self.asked.planned.is_some()) + usize::from(self.asked.close_due)
    }
    // …all of them let go: its page gone, or it closed.
    fn forget_asked(&mut self) {
        asking(self, |t| t.asked = Asked { closing: t.asked.closing, ..Asked::default() });
    }

    // Its top-level navigable's document made anew — the page's, a window's — whose frames are new navigables: the nested
    // histories the document state kept from before none of them, though they still count their steps.
    // (…and a traversal its document planned gone with that document's plan — a flush's let go as the navigation it ran
    // before commits: none of its navigables traversing)
    fn rebuilt(&mut self) {
        self.build += 1;
        self.navigations.clear();
        self.state.held.clear();
        self.end_traversal();
    }

    // HTML "destroy a child navigable": navigable `nav`'s nested history removed from its parent's document state — its
    // steps, and its own frames' with it, counted no more.
    fn destroy(&mut self, nav: u32) {
        // (…its navigation under way, whose entry no document of it makes now, nor one of it ongoing)
        self.navigations.remove(&nav);
        self.ongoing.remove(&nav);
        let build = self.build;
        let Some(doc) = self.state.parent_doc_of(nav, build) else { return };
        if let Some(nested) = self.state.docs.get_mut(&doc) {
            nested.retain(|n| !(n.navigable == nav && n.build == build));
        }
        self.state.held.remove(&nav);
        self.state.collect_docs();
        self.state.drop_stale_holds(build);
    }

    // HTML "URL and history update steps" of navigable `nav`'s active document (its parent `parent`): an entry of the
    // document's after the current one (`push`: `pushState`, a fragment navigation), or its active entry's URL and
    // classic history API state made `url` and `state` (`replaceState`, a fragment navigation to the URL it is at) —
    // none for a navigable of no entry yet (a top-level one at its initial about:blank, whose document has none).
    fn update(&mut self, nav: u32, parent: u32, url: &str, state: Option<Arc<[u8]>>, push: bool) {
        let Some(id) = self.state.current_entry(nav, self.build).map(|e| e.id) else { return };
        self.same_document += 1;
        if push {
            self.commit(nav, parent, url, true, false, Data { state, ..Data::default() });
        } else if let Some(entry) = self.state.entry_mut(id) {
            entry.url = url.to_owned();
            Arc::make_mut(&mut entry.data).state = state;
        }
    }
    // Its top-level navigable's document's URL made `url` by those steps — the one it was at noted, while the host notes
    // them, where it changed.
    fn move_url(&mut self, url: &str) {
        let from = self.url.replace(url.to_owned());
        if let Some(from) = from.filter(|from| self.noting && !from.is_empty() && from != url) {
            self.passed.push(from);
        }
    }
}

// A window's session history: the host's handle on it, and the realms' (`__dom.historyLength`), by its number — the
// process's, as the isolates that read it and the host thread that writes it are. The one its window was made with
// owns it: the window gone with it (`Drop`). Another, `SessionHistory.of` its number, is a handle the host borrows of a
// window `window.open` made in an isolate — whose session history the isolate's arena owns — to record its frames'
// navigations in it and apply its traversals (browser.rb `traversable_history`).
#[magnus::wrap(class = "Capybara::Simulated::Native::SessionHistory", free_immediately)]
pub(crate) struct SessionHistory {
    id: u64,
    traversable: Arc<Mutex<Traversable>>,
    owned: std::cell::Cell<bool>,
}

static HISTORIES: LazyLock<Mutex<(u64, HashMap<u64, Weak<Mutex<Traversable>>>)>> = LazyLock::new(Default::default);
fn histories() -> MutexGuard<'static, (u64, HashMap<u64, Weak<Mutex<Traversable>>>)> {
    HISTORIES.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Drop for SessionHistory {
    fn drop(&mut self) {
        if !self.owned.get() {
            return;
        }
        histories().1.remove(&self.id);
        asking(&mut self.lock(), |t| {
            t.asked = Asked::default();
            t.queued.clear();
        });
    }
}

impl SessionHistory {
    pub(crate) fn new() -> Self {
        let mut made = Traversable::default();
        made.state = State::new();
        let traversable = Arc::new(Mutex::new(made));
        let mut registry = histories();
        registry.0 += 1;
        let id = registry.0;
        registry.1.insert(id, Arc::downgrade(&traversable));
        SessionHistory { id, traversable, owned: std::cell::Cell::new(true) }
    }
    // SessionHistory.of(id) -> a handle on the session history numbered `id`, nil where it is gone.
    pub(crate) fn of(id: u64) -> Option<Self> {
        let traversable = histories().1.get(&id)?.upgrade()?;
        Some(SessionHistory { id, traversable, owned: std::cell::Cell::new(false) })
    }
    // A handle's ownership of the session history handed over: let go of by the one that had it (`release`, an isolate's
    // window that leaves for a Browser of its own as its browsing context group switches — the traversable kept, its
    // history and its session storage with it), taken by the one that is to keep it (#own!).
    pub(crate) fn release(&self) {
        self.owned.set(false);
    }
    fn own(&self) {
        self.owned.set(true);
    }
    // #session_storage -> its session storage shed (`session_storage`).
    fn session_storage(&self) -> u64 {
        self.lock().session_storage
    }
    fn lock(&self) -> MutexGuard<'_, Traversable> {
        self.traversable.lock().unwrap_or_else(PoisonError::into_inner)
    }
    // #id -> its number, which its window's realms are told (`setSessionHistory`).
    pub(crate) fn id(&self) -> u64 {
        self.id
    }

    // The id of the navigable's active entry, its session history made with `url`'s entry where it has none; none where
    // its parent has none (`Traversable::ensure`; the bindings' `frame_entry`), which the tests seed with.
    #[cfg(test)]
    fn seed(&self, nav: u32, parent: u32, url: String) -> Option<u64> {
        self.lock().ensure(nav, parent, &url)
    }
    // The id of the entry a navigation of the navigable adds, what a replay of it sends and restores `data` — and of the
    // one it makes in place of its active entry (a top-level one's first, where it has none).
    fn push(&self, nav: u32, parent: u32, url: String, same_document: bool, data: Data) -> Option<u64> {
        self.lock().commit(nav, parent, &url, same_document, false, data)
    }
    fn replace(&self, nav: u32, parent: u32, url: String, same_document: bool, data: Data) -> Option<u64> {
        let mut t = self.lock();
        let replace = nav != TOP || !t.state.entries.is_empty();
        t.commit(nav, parent, &url, same_document, replace, data)
    }
    // #commit_javascript_document(url): the document a `javascript:` URL's string result makes of its top-level
    // navigable committed (HTML "navigate to a javascript: URL", its history handling "replace"): an entry at `url` in
    // place of the active one — a first where there is none: the initial about:blank's, whose entry HTML replaces with
    // one of a document that is no initial about:blank, which the next navigation comes after (Chrome 157 and Firefox 159
    // leave the window as if at its initial about:blank still, `history.length` 1 after `/a`, measured 2026-11-08: the
    // text over both) — of a new document state of what the active one's was
    // reached by (its request's origin, Referer and policy, whether its cookies were cross-site, its document's referrer,
    // the opener policy and the origin it holds; its target name, `commit`'s), of no resource (a reload of it a GET: Chrome
    // re-POSTs) nor classic history API state (Chrome keeps it, Firefox none); no entry left (`leaving`) whose controls'
    // state it would take — the one it replaces gone.
    fn commit_javascript_document(&self, url: String) {
        let mut t = self.lock();
        let reached = t.state.current_entry(TOP, t.build).map(|e| Data { texts: e.data.texts.clone(), cross_site: e.data.cross_site, ..Data::default() });
        t.leaving = None;
        t.commit(TOP, TOP, &url, false, reached.is_some(), reached.unwrap_or_default());
    }
    // #active(navigable) -> the id of its active entry, or nil.
    pub(crate) fn active(&self, nav: u32) -> Option<u64> {
        let t = self.lock();
        t.state.current_entry(nav, t.build).map(|e| e.id)
    }
    // #url(entry) -> its URL, or nil for no such entry.
    pub(crate) fn url(&self, id: u64) -> Option<String> {
        self.lock().state.entry(id).map(|e| e.url.clone())
    }
    // #set_url(entry, url): its URL made `url` (a redirect's, a replaceState's).
    fn set_url(&self, id: u64, url: String) {
        let mut guard = self.lock();
        let t = &mut *guard;
        if let Some(e) = t.state.entry_mut(id) {
            e.url = url;
        }
    }
    // #entry(entry) -> {url:, body:, content_type:, origin:, referer:, referrer_policy:, referrer:, cross_site:, name:,
    // state:, form_state:} of those it has (`Data`; a POST's body and content type, the classic history API state and the form state binary
    // strings) — {} for no such entry, or none (nil).
    fn entry(ruby: &magnus::Ruby, rb_self: &Self, id: Option<u64>) -> Result<RHash, magnus::Error> {
        match id.and_then(|id| rb_self.lock().state.entry(id).cloned()) {
            Some(e) => e.data.to_hash(ruby, &e.url),
            None => Ok(ruby.hash_new()),
        }
    }
    // #blob(entry) -> [bytes, type] of the blob its document was made of (`Data::blob`), nil for none.
    fn blob(ruby: &magnus::Ruby, rb_self: &Self, id: Option<u64>) -> Option<(RString, String)> {
        let blob = id.and_then(|id| rb_self.lock().state.entry(id).and_then(|e| e.data.blob.clone()))?;
        Some((ruby.str_from_slice(&blob.0), blob.1))
    }
    // #text(entry, name) -> its text field `name` (`TEXT_FIELDS`: :origin, :referer, :referrer_policy, :referrer), nil
    // for none — what `#entry` gives without copying its bytes out.
    fn text(ruby: &magnus::Ruby, rb_self: &Self, id: Option<u64>, name: Symbol) -> Result<Option<String>, magnus::Error> {
        let name = name.name()?;
        if !TEXT_FIELDS.contains(&&*name) {
            return Err(magnus::Error::new(ruby.exception_arg_error(), format!("no text field {name}")));
        }
        Ok(id.and_then(|id| rb_self.lock().state.entry(id).and_then(|e| e.data.text(&name).map(str::to_owned))))
    }
    // #name / #name=(name): the top-level navigable's target name (`State::name`), which a new window is opened with and
    // a navigation to another origin that leaves it no opener clears.
    pub(crate) fn name(&self) -> String {
        let t = self.lock();
        String::from_utf16_lossy(&t.state.name(t.build))
    }
    pub(crate) fn set_name(&self, name: String) {
        let mut t = self.lock();
        let build = t.build;
        t.state.set_name(build, &name.encode_utf16().collect::<Vec<_>>());
    }
    // #show: the top-level navigable's document committed (`State::show`), its current entry's.
    fn show(&self) {
        let mut t = self.lock();
        let build = t.build;
        t.state.show(build);
    }
    // #clear_name: the navigable target name of the document state the navigation in flight made (its current entry's)
    // the empty string — HTML "finalize a cross-document navigation", the shown document's left as it is.
    pub(crate) fn clear_name(&self) {
        let mut guard = self.lock();
        let t = &mut *guard;
        let build = t.build;
        let Some(doc) = t.state.current_entry(TOP, build).map(|e| e.doc) else { return };
        for entry in t.state.entries.iter_mut().filter(|e| e.doc == doc) {
            Arc::make_mut(&mut entry.data).name = Some(Vec::new());
        }
    }
    // #update(entry, fields): the fields of what a replay of it sends and restores `fields` names made what it gives
    // them (`Data::merge`) — a history saved before keeping the ones it had.
    // (…`fields` read with the history unlocked: a Ruby conversion may run code that reads it)
    fn update(ruby: &magnus::Ruby, rb_self: &Self, id: u64, fields: RHash) -> Result<(), magnus::Error> {
        let Some(mut data) = rb_self.lock().state.entry(id).map(|e| Data::clone(&e.data)) else { return Ok(()) };
        data.merge(ruby, fields)?;
        let mut guard = rb_self.lock();
        let t = &mut *guard;
        if let Some(e) = t.state.entry_mut(id) {
            e.data = Arc::new(data);
        }
        Ok(())
    }
    // #length -> `history.length`: the number of steps used, at least 1.
    pub(crate) fn length(&self) -> usize {
        self.lock().state.length()
    }
    // #document_url / #document_url=(url): the URL of the document its top-level navigable is at (`Traversable::url`),
    // nil before the first — a navigation's to set as it commits one.
    fn document_url(&self) -> Option<String> {
        self.lock().url.clone()
    }
    fn set_document_url(&self, url: Option<String>) {
        self.lock().url = url;
    }
    // #note_url_changes(on) -> the URLs its document's own URL and history update steps moved it from since the host
    // last took them, while it noted them — noting them from now on where `on`.
    fn note_url_changes(&self, on: bool) -> Vec<String> {
        let mut t = self.lock();
        t.noting = on;
        std::mem::take(&mut t.passed)
    }
    // #traversal(delta) -> [step, [[navigable, entry, same_document], …]] of a traversal by `delta` as the host applies
    // it (`Traversable::traversal`), or nil for none.
    fn traversal(&self, delta: i64) -> Option<(i64, Vec<Change>)> {
        self.lock().traversal(delta)
    }
    // …those queued up to and with the one of `token`, and every one (`Traversable::take_queued`), which the tests read.
    #[cfg(test)]
    fn take_queued(&self, token: u64) -> Vec<(u64, i64)> {
        self.lock().take_queued(token).into_iter().map(Queued::row).collect()
    }
    #[cfg(test)]
    fn take_all_queued(&self) -> Vec<(u64, i64)> {
        self.lock().take_all_queued().into_iter().map(Queued::row).collect()
    }
    // #queued? -> whether a traversal is queued; #queued_documents? -> whether one queued makes a document again.
    fn is_queued(&self) -> bool {
        !self.lock().queued.is_empty()
    }
    pub(crate) fn queued_documents(&self) -> bool {
        self.lock().queued_documents()
    }
    // …and whether one makes its top-level navigable's document again (`Queued::replaces`), its page's task still to
    // apply it: what a window's own navigation planned before it gives way to (navigation_plan.rs
    // `takeWindowNavigations`), which one moving a frame of it alone is not.
    pub(crate) fn queued_replacing(&self) -> bool {
        self.lock().queued.iter().any(|q| q.replaces)
    }
    // #flush_begin / #flush_end: the host running the tasks of the page it navigates away from, and done (`flush_mark`).
    fn flush_begin(&self) {
        let mut t = self.lock();
        t.flush_mark = Some(t.tokens);
    }
    fn flush_end(&self) {
        self.lock().flush_mark = None;
    }
    // #hold_traversals(on): its traversals wait (`holding`), or go on.
    fn hold_traversals(&self, on: bool) {
        self.lock().holding = on;
    }
    // #traversal_planned? -> whether one is planned for the host (`planned_for_host`), its cheap gate.
    fn is_traversal_planned(&self) -> bool {
        self.lock().planned_for_host
    }
    // #end_traversal: the traversals the host took applied, or let go — their navigables traversing no more, whatever
    // became of them (`Traversable::end_traversal`).
    fn end_traversal(&self) {
        self.lock().end_traversal();
    }
    // #clear_queued: the page's traversals let go — its document gone, whose traversals go with it.
    fn clear_queued(&self) {
        let mut t = self.lock();
        t.queued.retain_mut(|q| std::mem::take(&mut q.behind));
    }
    // A traversal of the page under way (`page_traversal`): the token of its hold — none where another holds them — and
    // over, by the holder of that token alone.
    pub(crate) fn begin_page_traversal(&self) -> Option<u64> {
        let mut t = self.lock();
        if t.page_traversal.is_some() {
            return None;
        }
        t.tokens += 1;
        t.page_traversal = Some(t.tokens);
        t.page_traversal
    }
    pub(crate) fn end_page_traversal(&self, token: u64) {
        let mut t = self.lock();
        if t.page_traversal == Some(token) {
            t.page_traversal = None;
        }
    }
    // A replaceState of the page's document (`Traversable::update`), which the tests make.
    #[cfg(test)]
    pub(crate) fn replace_state_for_test(&self, url: &str) {
        self.lock().update(TOP, TOP, url, None, false);
    }
    // …and frame `nav` of the page, at `url` (`seed`), and a navigation of it begun to `url` (`begin_frame_entry`).
    #[cfg(test)]
    pub(crate) fn seed_frame(&self, nav: u32, url: &str) -> u64 {
        self.lock().ensure(nav, TOP, url).unwrap_or_default()
    }
    #[cfg(test)]
    pub(crate) fn begin_frame_entry_for_test(&self, nav: u32, url: &str) -> u64 {
        self.lock().begin_frame_entry(nav, TOP, url.to_owned(), false, Data::default(), Vec::new())
    }
    // …the plan with no step passed over (`Traversable::plan`), which the tests read.
    #[cfg(test)]
    fn plan(&self, delta: i64) -> Option<(i64, Vec<Change>)> {
        self.lock().plan(delta)
    }
    // #go_to(step): the traversal to `step` applied — the step a plan gave.
    pub(crate) fn go_to(&self, step: i64) {
        self.lock().go_to(step);
    }
    // #begin_step(step, changes) -> [[navigable, url, state, hashchange], …] / #end_step(attempted, none): a traversal's
    // step that keeps the top-level navigable's document applied, and its frames' documents made but those of navigables
    // `none` of the `attempted` ones (`Traversable::begin_step`, `end_step`; browser.rb `traverse_navigables`).
    fn begin_step(ruby: &magnus::Ruby, rb_self: &Self, step: i64, changes: Vec<Change>) -> Result<RArray, magnus::Error> {
        let moves = rb_self.lock().begin_step(step, &changes);
        let out = ruby.ary_new();
        for (nav, url, state, hashchange) in moves {
            let state = state.map(|s| ruby.str_from_slice(&s));
            out.push((nav, url, state, hashchange))?;
        }
        Ok(out)
    }
    fn end_step(&self, attempted: usize, none: Vec<u32>) {
        self.lock().end_step(attempted, &none);
    }
    #[cfg(test)]
    fn hold(&self, nav: u32, id: u64, step: i64) {
        self.lock().hold(nav, id, step);
    }
    #[cfg(test)]
    fn step(&self) -> i64 {
        self.lock().state.current
    }
    // #rebuilt: the page's document made anew — its frames' navigables new ones (`Traversable::rebuilt`).
    fn rebuilt(&self) {
        self.lock().rebuilt();
    }
    // The history as it stands, kept (`Kept`) — and put back (navigation_commit.rs: a traversal's, as it began).
    pub(crate) fn keep(&self) -> Kept {
        let t = self.lock();
        Kept(t.state.clone(), t.same_document)
    }
    // …put back where a same-document update — a pushState, a replaceState, a fragment's — was made since, or `lost`.
    pub(crate) fn put_back(&self, kept: Kept, lost: bool) {
        let mut t = self.lock();
        if lost || t.same_document != kept.1 {
            t.state = kept.0;
        }
    }
    // The entry the page's document leaves as a navigation of it commits another (navigation_commit.rs), none where it
    // leaves none — a reload's, of the same entry (`leaving`).
    pub(crate) fn set_leaving(&self, id: Option<u64>) {
        self.lock().leaving = id;
    }
    // …its entry, of the step after the current one or, `replace`, in place of the active one (`#push`, `#replace`).
    pub(crate) fn record_page_entry(&self, url: String, replace: bool, data: Data) -> Option<u64> {
        if replace { self.replace(TOP, TOP, url, false, data) } else { self.push(TOP, TOP, url, false, data) }
    }
    // …the request entry `id`'s document is reached by now a redirect's (Fetch "HTTP-redirect fetch"): its URL the
    // redirect's, and — `get`, a redirect that makes the request a GET, or one that was — none of what a re-post sends
    // again: so a reload gets the page it was redirected to, not the chain run again, a Post/Redirect/Get page's not the
    // form submitted again (Chrome).
    pub(crate) fn redirect_entry(&self, id: u64, url: &str, get: bool) {
        self.lock().redirect_entry(id, url, get);
    }
    // …entry `id`'s text field `key` (`TEXT_FIELDS`), and that one made `value`.
    pub(crate) fn text_of(&self, id: u64, key: &str) -> Option<String> {
        self.lock().state.entry(id).and_then(|e| e.data.text(key).map(str::to_owned))
    }
    pub(crate) fn set_text_of(&self, id: u64, key: &str, value: String) {
        let mut guard = self.lock();
        let t = &mut *guard;
        if let Some(e) = t.state.entry_mut(id) {
            Arc::make_mut(&mut e.data).set_text(key, value);
        }
    }
    // …and its classic history API state none (HTML "apply the history step": StructuredSerializeForStorage(null)).
    pub(crate) fn forget_state_of(&self, id: u64) {
        let mut guard = self.lock();
        let t = &mut *guard;
        if let Some(e) = t.state.entry_mut(id) {
            Arc::make_mut(&mut e.data).state = None;
        }
    }
    // #take_leaving -> the entry the page's document leaves (`leaving`), taken as it unloads.
    fn take_leaving(&self) -> Option<u64> {
        self.lock().leaving.take()
    }
    // The navigation of frame `nav` of number `token` its document made, or none (`Traversable::commit_frame_navigation`,
    // `abandon_frame_navigation`): navigation_commit.rs `Commit`'s, as the host's fetch of it ends — and
    // #commit_frame_navigation(navigable, number) -> its entry, nil none / #abandon_frame_navigation(navigable, number):
    // the host's, of a document it made of no fetch of its own (a `data:` URL's, about:blank's, a blob's, an error
    // document) or none.
    pub(crate) fn commit_frame_navigation(&self, nav: u32, token: u64, redirect: Option<(&str, bool)>, reached: Data) -> Option<u64> {
        self.lock().commit_frame_navigation(nav, token, redirect, reached)
    }
    pub(crate) fn abandon_frame_navigation(&self, nav: u32, token: u64) {
        self.lock().abandon_frame_navigation(nav, token);
    }
    fn commit_frame_navigation_for_ruby(&self, nav: u32, token: u64) -> Option<u64> {
        self.commit_frame_navigation(nav, token, None, Data::default())
    }
    // #begin_navigation(navigable) -> the number of the navigation of `navigable` begun now, its ongoing one — and
    // #navigation_ongoing?(navigable, number): whether it still is, no navigation begun nor traversal applied since.
    fn begin_navigation(&self, nav: u32) -> u64 {
        self.lock().begin_navigation(nav)
    }
    fn navigation_ongoing(&self, nav: u32, id: u64) -> bool {
        self.lock().navigation_ongoing(nav, id)
    }
    // #ongoing_navigation(navigable) -> the number of its ongoing navigation as it stands, what a fetch under way goes by: another
    // once it has its response, one begun meanwhile ended it (browser.rb `navigate_top_level`).
    fn ongoing_navigation(&self, nav: u32) -> Option<u64> {
        self.lock().ongoing.get(&nav).copied()
    }
    // #clear: no entries at all, nor traversals queued, nor a document's URL.
    // (…a reset's: a fresh window's, what it knew of its opener and its documents gone with them)
    fn clear(&self) {
        let mut t = self.lock();
        t.state = State::new();
        t.url = None;
        t.passed.clear();
        t.stepping = None;
        t.leaving = None;
        t.navigations.clear();
        t.ongoing.clear();
        (t.closed, t.by_web_content, t.popup_sandbox) = (false, false, 0);
        t.opener_policy = crate::coop::Value::UnsafeNone;
        t.queued.clear();
        t.flush_mark = None;
        (t.holding, t.planned_for_host, t.page_traversal) = (false, false, None);
        asking(&mut t, |t| t.asked = Asked::default());
    }
    // #session_storage = shed: its session storage's (`session_storage`), its Browser's.
    fn set_session_storage(&self, shed: u64) {
        self.lock().session_storage = shed;
    }
    // A new one whose session storage is a shed of its own, a copy of shed `from` (none for 0): a window's `window.open`
    // made, its opener's.
    pub(crate) fn copying(from: u64) -> Self {
        let history = Self::new();
        let shed = crate::storage_areas::partition_new();
        if from != 0 {
            crate::storage_areas::copy(from, shed);
        }
        {
            let mut t = history.lock();
            t.session_storage = shed;
            t.owns_storage = true;
        }
        history
    }
    // #by_web_content = whether web content made it (`by_web_content`).
    fn set_by_web_content(&self, by: bool) {
        self.lock().by_web_content = by;
    }
    // #popup_sandbox = flags: the sandboxing flags it was made with (`popup_sandbox`).
    pub(crate) fn set_popup_sandbox(&self, flags: u32) {
        self.lock().popup_sandbox = flags;
    }
    // #loopback_stand_in = on (`loopback_stand_in`).
    fn set_loopback_stand_in(&self, on: bool) {
        self.lock().loopback_stand_in = on;
    }
    // A window's as its opener makes it: the creation URL its initial about:blank takes, and its session's stand-in.
    pub(crate) fn set_made_by(&self, creation_url: Option<String>, stand_in: bool) {
        let mut t = self.lock();
        t.creation_url = creation_url;
        t.loopback_stand_in = stand_in;
    }
    // #opener_policy = name: the opener policy of the document it now shows, by its name (coop.rs), as that one commits.
    fn set_opener_policy(&self, name: String) {
        self.lock().opener_policy = crate::coop::Value::named(&name);
    }
    // #opener_policy -> the name of its document's: what a `javascript:` URL's document keeps (browser.rb
    // `commit_javascript_document`).
    fn opener_policy(&self) -> &'static str {
        self.lock().opener_policy.name()
    }
    // #commit_opener_policy(name, response origin, carried) { [origin, initial about:blank] } -> [switch, isolated]: the
    // document a navigation of it makes, of that policy, is its document's from here on, and what that does to its browsing
    // context group (coop.rs `commit_verdict`), the block giving the facts of the document it leaves.
    fn commit_opener_policy(ruby: &magnus::Ruby, rb_self: &Self, name: String, response_origin: String, carried: bool) -> Result<(bool, bool), magnus::Error> {
        let (document, response) = (rb_self.lock().opener_policy, crate::coop::Value::named(&name));
        let verdict = crate::coop::commit_verdict(document, response, &response_origin, carried, || ruby.yield_value(ruby.qnil()))?;
        let mut t = rb_self.lock();
        t.opener_policy = response;
        t.creation_url = None;
        Ok(verdict)
    }
    // #inherited_opener_policy { [origin, top-level origin] } -> the name of the policy a document of no headers that a document
    // of it makes takes (coop.rs `inherited`), the block giving that document's facts.
    fn inherited_opener_policy(ruby: &magnus::Ruby, rb_self: &Self) -> Result<&'static str, magnus::Error> {
        let top_level = rb_self.lock().opener_policy;
        Ok(crate::coop::inherited(top_level, || ruby.yield_value(ruby.qnil()))?.name())
    }
    // #entry_at_step(step) -> the id of the top-level entry current at `step` (a frame's entries have steps of their own), what a
    // traversal to it reads before it is applied.
    pub(crate) fn entry_at_step(&self, step: i64) -> Option<u64> {
        self.lock().state.entries.iter().filter(|e| e.step <= step).max_by_key(|e| e.step).map(|e| e.id)
    }
    // #opener_policy_isolates? { [origin, top-level origin] } -> whether a window a document of it opens is opened without
    // its opener (coop.rs `isolates_opener`), the block giving that document's facts.
    fn opener_policy_isolates(ruby: &magnus::Ruby, rb_self: &Self) -> Result<bool, magnus::Error> {
        let top_level = rb_self.lock().opener_policy;
        crate::coop::isolates_opener(top_level, || ruby.yield_value(ruby.qnil()))
    }
    // #close!: it closed (HTML "close a top-level traversable") — or was parked, its page gone: nothing asked of it is
    // taken any more.
    fn close(&self) {
        let mut t = self.lock();
        t.closed = true;
        t.forget_asked();
    }
    // #ask_close -> whether the `close()` its page's script called set it closing now (HTML's Window `close()`): one
    // script-closable — web content made it, or its session history has one entry: HTML "is closing", the close itself
    // due as a task of its own (`#take_close`) — false for one closing or closed already, or that close() leaves. The
    // navigation planned of it goes: the close's task destroys the traversable before any navigation of it could finish
    // (HTML "destroy a top-level traversable"). (…"allowed by sandboxing to navigate" the host's to ask, which knows the
    // calling realm)
    fn ask_close(&self) -> bool {
        let mut t = self.lock();
        if !(t.by_web_content || t.state.length() == 1) || t.closed || t.asked.closing {
            return false;
        }
        asking(&mut t, |t| {
            t.asked.closing = true;
            t.asked.close_due = true;
            t.asked.planned = None;
        });
        true
    }
    // #closing? -> whether it is closing or closed: its `closed` getter's, from any window.
    fn is_closing(&self) -> bool {
        let t = self.lock();
        t.closed || t.asked.closing
    }
    // #take_close -> whether its close is due, taken.
    fn take_close(&self) -> bool {
        asking(&mut self.lock(), |t| std::mem::take(&mut t.asked.close_due))
    }
    // The navigation it was opened for, planned — in place of one planned before; none of one closing or closed, which
    // no navigation of finishes.
    fn plan_navigation(&self, planned: Planned) {
        plan_on(&mut self.lock(), planned);
    }
    // #plan_navigation(url, replace, activated, referrer, policy, initiator, blob_bytes, blob_type): …a GET's, a `blob:`
    // URL's of the blob given; `initiator` the document that began it (`Initiator`: nil none).
    #[allow(clippy::too_many_arguments)]
    fn plan_navigation_for_ruby(
        ruby: &magnus::Ruby,
        rb_self: &Self,
        url: String,
        replace: bool,
        activated: bool,
        referrer: Option<String>,
        policy: Option<String>,
        initiator: Option<RHash>,
        blob_bytes: Option<RString>,
        blob_type: Option<String>,
    ) -> Result<(), magnus::Error> {
        let resource = match blob_bytes {
            Some(b) => Resource::Blob(crate::fetch_rules::ruby_bytes(b), blob_type.unwrap_or_default()),
            None => Resource::Get,
        };
        let initiator = Initiator::from_ruby(ruby, initiator)?;
        rb_self.plan_navigation(Planned { url, replace, activated, referrer, policy, initiator, resource });
        Ok(())
    }
    // #plan_post(url, body, content_type, activated, referrer, policy, initiator): …a POST's, a form's submission that
    // opened it (HTML "navigate" with a POST resource; its history handling "push").
    #[allow(clippy::too_many_arguments)]
    fn plan_post_for_ruby(
        ruby: &magnus::Ruby,
        rb_self: &Self,
        url: String,
        body: RString,
        content_type: String,
        activated: bool,
        referrer: Option<String>,
        policy: Option<String>,
        initiator: Option<RHash>,
    ) -> Result<(), magnus::Error> {
        let resource = Resource::Post { body: crate::fetch_rules::ruby_bytes(body), content_type };
        let initiator = Initiator::from_ruby(ruby, initiator)?;
        rb_self.plan_navigation(Planned { url, replace: false, activated, referrer, policy, initiator, resource });
        Ok(())
    }
    // The navigation planned of it, taken (HTML: its task run).
    fn take_planned(&self) -> Option<Planned> {
        asking(&mut self.lock(), |t| t.asked.planned.take())
    }
    // #take_planned -> {url:, replace:, activated:, referrer:, policy:, initiator:, origin_null:,
    // initiator_cross_site_ancestor:, client_id:} and one of blob: [bytes, type], post: [body, content_type] — or nil for none
    // (`take_planned`).
    fn take_planned_for_ruby(ruby: &magnus::Ruby, rb_self: &Self) -> Result<Option<RHash>, magnus::Error> {
        let Some(p) = rb_self.take_planned() else { return Ok(None) };
        let hash = ruby.hash_new();
        hash.aset(ruby.to_symbol("url"), p.url)?;
        hash.aset(ruby.to_symbol("replace"), p.replace)?;
        hash.aset(ruby.to_symbol("activated"), p.activated)?;
        hash.aset(ruby.to_symbol("referrer"), p.referrer)?;
        hash.aset(ruby.to_symbol("policy"), p.policy)?;
        p.initiator.into_ruby(ruby, hash)?;
        match p.resource {
            Resource::Get => {}
            Resource::Blob(bytes, kind) => hash.aset(ruby.to_symbol("blob"), (ruby.str_from_slice(&bytes), kind))?,
            Resource::Post { body, content_type } => hash.aset(ruby.to_symbol("post"), (ruby.str_from_slice(&body), content_type))?,
        }
        Ok(Some(hash))
    }
    // #asked? -> whether something asked of it waits to be taken.
    fn is_asked(&self) -> bool {
        self.lock().pending() > 0
    }
}

pub(crate) fn recordable_for_ruby(url: Option<String>) -> bool {
    url.as_deref().is_some_and(recordable)
}

pub(crate) fn define(native: magnus::RModule, ruby: &magnus::Ruby) -> Result<(), magnus::Error> {
    use magnus::{function, method, Module, Object};
    native.define_module_function("history_recordable_url", function!(recordable_for_ruby, 1))?;
    native.define_module_function("window_tasks_pending", function!(window_tasks_pending, 0))?;
    let class = native.define_class("SessionHistory", ruby.class_object())?;
    class.define_singleton_method("new", function!(SessionHistory::new, 0))?;
    class.define_singleton_method("of", function!(SessionHistory::of, 1))?;
    class.define_method("id", method!(SessionHistory::id, 0))?;
    class.define_method("commit_javascript_document", method!(SessionHistory::commit_javascript_document, 1))?;
    class.define_method("active", method!(SessionHistory::active, 1))?;
    class.define_method("url", method!(SessionHistory::url, 1))?;
    class.define_method("set_url", method!(SessionHistory::set_url, 2))?;
    class.define_method("entry", method!(SessionHistory::entry, 1))?;
    class.define_method("text", method!(SessionHistory::text, 2))?;
    class.define_method("blob", method!(SessionHistory::blob, 1))?;
    class.define_method("update", method!(SessionHistory::update, 2))?;
    class.define_method("name", method!(SessionHistory::name, 0))?;
    class.define_method("name=", method!(SessionHistory::set_name, 1))?;
    class.define_method("show", method!(SessionHistory::show, 0))?;
    class.define_method("close!", method!(SessionHistory::close, 0))?;
    class.define_method("ask_close", method!(SessionHistory::ask_close, 0))?;
    class.define_method("by_web_content=", method!(SessionHistory::set_by_web_content, 1))?;
    class.define_method("popup_sandbox=", method!(SessionHistory::set_popup_sandbox, 1))?;
    class.define_method("opener_policy=", method!(SessionHistory::set_opener_policy, 1))?;
    class.define_method("opener_policy", method!(SessionHistory::opener_policy, 0))?;
    class.define_method("loopback_stand_in=", method!(SessionHistory::set_loopback_stand_in, 1))?;
    class.define_method("commit_opener_policy", method!(SessionHistory::commit_opener_policy, 3))?;
    class.define_method("inherited_opener_policy", method!(SessionHistory::inherited_opener_policy, 0))?;
    class.define_method("entry_at_step", method!(SessionHistory::entry_at_step, 1))?;
    class.define_method("opener_policy_isolates?", method!(SessionHistory::opener_policy_isolates, 0))?;
    class.define_method("session_storage=", method!(SessionHistory::set_session_storage, 1))?;
    class.define_method("session_storage", method!(SessionHistory::session_storage, 0))?;
    class.define_method("own!", method!(SessionHistory::own, 0))?;
    class.define_method("closing?", method!(SessionHistory::is_closing, 0))?;
    class.define_method("take_close", method!(SessionHistory::take_close, 0))?;
    class.define_method("plan_navigation", method!(SessionHistory::plan_navigation_for_ruby, 8))?;
    class.define_method("plan_post", method!(SessionHistory::plan_post_for_ruby, 7))?;
    class.define_method("take_planned", method!(SessionHistory::take_planned_for_ruby, 0))?;
    class.define_method("asked?", method!(SessionHistory::is_asked, 0))?;
    class.define_method("clear_name", method!(SessionHistory::clear_name, 0))?;
    class.define_method("length", method!(SessionHistory::length, 0))?;
    class.define_method("document_url", method!(SessionHistory::document_url, 0))?;
    class.define_method("document_url=", method!(SessionHistory::set_document_url, 1))?;
    class.define_method("note_url_changes", method!(SessionHistory::note_url_changes, 1))?;
    class.define_method("traversal", method!(SessionHistory::traversal, 1))?;
    class.define_method("flush_begin", method!(SessionHistory::flush_begin, 0))?;
    class.define_method("flush_end", method!(SessionHistory::flush_end, 0))?;
    class.define_method("hold_traversals", method!(SessionHistory::hold_traversals, 1))?;
    class.define_method("traversal_planned?", method!(SessionHistory::is_traversal_planned, 0))?;
    class.define_method("end_traversal", method!(SessionHistory::end_traversal, 0))?;
    class.define_method("queued?", method!(SessionHistory::is_queued, 0))?;
    class.define_method("queued_documents?", method!(SessionHistory::queued_documents, 0))?;
    class.define_method("clear_queued", method!(SessionHistory::clear_queued, 0))?;
    class.define_method("go_to", method!(SessionHistory::go_to, 1))?;
    class.define_method("begin_step", method!(SessionHistory::begin_step, 2))?;
    class.define_method("end_step", method!(SessionHistory::end_step, 2))?;
    class.define_method("rebuilt", method!(SessionHistory::rebuilt, 0))?;
    class.define_method("take_leaving", method!(SessionHistory::take_leaving, 0))?;
    class.define_method("commit_frame_navigation", method!(SessionHistory::commit_frame_navigation_for_ruby, 2))?;
    class.define_method("abandon_frame_navigation", method!(SessionHistory::abandon_frame_navigation, 2))?;
    class.define_method("begin_navigation", method!(SessionHistory::begin_navigation, 1))?;
    class.define_method("navigation_ongoing?", method!(SessionHistory::navigation_ongoing, 2))?;
    class.define_method("ongoing_navigation", method!(SessionHistory::ongoing_navigation, 1))?;
    class.define_method("clear", method!(SessionHistory::clear, 0))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history() -> SessionHistory {
        SessionHistory::new()
    }

    // The opener policy of its document, read by number as a navigation begins, and none once it is cleared or gone.
    #[test]
    fn it_holds_its_document_s_opener_policy() {
        use crate::coop::Value;
        let h = history();
        assert_eq!(opener_policy_of(h.id), Value::UnsafeNone);
        h.set_opener_policy("same-origin".to_owned());
        assert_eq!(opener_policy_of(h.id), Value::SameOrigin);
        h.clear();
        assert_eq!(opener_policy_of(h.id), Value::UnsafeNone);
        h.set_opener_policy("same-origin".to_owned());
        let id = h.id;
        drop(h);
        assert_eq!(opener_policy_of(id), Value::UnsafeNone);
    }

    // A traversal planned of a document made anew since — its plan gone with it — leaves no navigable traversing: a
    // navigation of the page asked after is planned.
    #[test]
    fn a_document_made_anew_ends_the_traversals_it_planned() {
        let h = history();
        h.push(TOP, TOP, "/a".into(), false, Data::default());
        h.lock().begin_traversal(TOP);
        h.lock().begin_traversal(1);
        assert!(h.lock().traversing(TOP));
        h.rebuilt();
        assert!(!h.lock().traversing(TOP) && !h.lock().traversing(1));
        assert_ne!(h.ongoing_navigation(TOP), Some(TRAVERSAL));
    }

    // A page's flush marks the traversals queued before it — those after it that move the page within its documents let
    // go as the navigation under way commits — and marks none once it is over.
    #[test]
    fn a_flush_marks_the_traversals_queued_before_it() {
        let h = history();
        h.push(TOP, TOP, "/a".into(), false, Data::default());
        let (before, _) = h.lock().queue(-1);
        h.flush_begin();
        let (after, _) = h.lock().queue(-1);
        assert_eq!(h.lock().flush_mark, Some(before));
        assert!(after > before);
        h.flush_end();
        assert_eq!(h.lock().flush_mark, None);
    }

    // Chrome, measured 2026-10-24: a frame navigated adds the page a step; the page's back takes the frame back, its
    // forward forth; a frame's pushState after a back clears the forward step; a page's pushState after it, two backs:
    // the page's popstate, then the frame's.
    #[test]
    fn a_frame_navigation_is_a_step_of_the_page() {
        let h = history();
        let a = h.push(TOP, TOP, "/top".into(), false, Data::default()).unwrap();
        h.seed(1, TOP, "/f1".into()).unwrap();
        assert_eq!(h.length(), 1);
        let f2 = h.push(1, TOP, "/f2".into(), false, Data::default()).unwrap();
        assert_eq!(h.length(), 2);
        let (step, changes) = h.plan(-1).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!((changes[0].0, changes[0].2), (1, false));
        h.go_to(step);
        assert_eq!(h.url(h.active(1).unwrap()).as_deref(), Some("/f1"));
        assert_eq!(h.active(TOP), Some(a));
        assert_eq!(h.plan(1).unwrap().1, vec![(1, f2, false)]);
        h.push(1, TOP, "/f1x".into(), true, Data::default()).unwrap();
        assert_eq!(h.length(), 2);
        assert_eq!(h.url(f2), None);
        h.push(TOP, TOP, "/topx".into(), true, Data::default()).unwrap();
        assert_eq!(h.length(), 3);
        let (step, changes) = h.plan(-1).unwrap();
        assert_eq!(changes, vec![(TOP, a, true)]);
        h.go_to(step);
        let (step, changes) = h.plan(-1).unwrap();
        assert_eq!((changes[0].0, changes[0].2), (1, true));
        h.go_to(step);
        assert!(h.plan(-1).is_none());
    }

    // A traversal skips a step whose frame's entry no traversal can make again alone (a srcdoc one left), on to the
    // next that way; the queue is applied up to a token, in order, and judges a traversal by where those before it go.
    #[test]
    fn a_traversal_skips_an_entry_it_cannot_make_and_queues_in_order() {
        let h = history();
        h.push(TOP, TOP, "http://a.test/".into(), false, Data::default()).unwrap();
        h.seed(1, TOP, "http://a.test/f".into()).unwrap();
        h.push(1, TOP, "about:srcdoc".into(), false, Data::default()).unwrap();
        h.push(1, TOP, "http://a.test/g".into(), false, Data::default()).unwrap();
        assert_eq!(h.length(), 3);
        // (…back from /g: past the srcdoc entry, to /f)
        let (_, changes) = h.traversal(-1).unwrap();
        assert_eq!(h.url(changes[0].1).as_deref(), Some("http://a.test/f"));
        assert!(h.plan(-1).is_some_and(|(_, c)| h.url(c[0].1).as_deref() == Some("about:srcdoc")));
        let (t1, delay1) = h.lock().queue(-1);
        let (t2, _) = h.lock().queue(-1);
        // (…a document made again goes at once; one past the history's start is none, judged from where the first goes)
        assert_eq!(delay1, 0);
        assert!(h.queued_documents());
        assert_eq!(h.take_queued(t1), vec![(t1, -1)]);
        assert!(h.take_queued(t1).is_empty());
        assert_eq!(h.take_all_queued(), vec![(t2, -1)]);
        assert!(!h.is_queued());
        assert_eq!(h.lock().tokens, t2);
        assert!(recordable("about:blank#x") && recordable("HTTPS://a.test/") && !recordable("about:blanky") && recordable("data:,x"));
        assert!(recordable("about:srcdoc") && !recordable("about:srcdocs") && !recordable("about:other"));
        assert!(recordable("blob:http://a.test/0d3c") && recordable("BLOB:null/x"));
    }

    // The page navigated to a new document: its frames' entries stay steps of the one it left; traversing back to that
    // makes it again, the frames with it (no change of theirs); a page document built again has new navigables.
    #[test]
    fn a_page_navigation_keeps_the_frames_steps() {
        let h = history();
        let a = h.push(TOP, TOP, "/a".into(), false, Data::default()).unwrap();
        h.seed(1, TOP, "/f1".into());
        h.push(1, TOP, "/f2".into(), false, Data::default());
        h.rebuilt();
        h.push(TOP, TOP, "/b".into(), false, Data::default());
        assert_eq!(h.length(), 3);
        let (step, changes) = h.plan(-1).unwrap();
        assert_eq!(changes, vec![(TOP, a, false)]);
        h.go_to(step);
        h.rebuilt();
        assert_eq!(h.active(1), None);
        assert_eq!(h.plan(-1).unwrap().1, vec![]);
    }

    // A replacement keeps its entry's step; a frame's first navigation from its initial about:blank adds none.
    #[test]
    fn a_javascript_document_replaces_the_active_entry_keeping_how_it_was_reached() {
        let h = history();
        h.commit_javascript_document("about:blank".into());
        assert_eq!(h.length(), 1);
        let mut data = Data::default();
        data.set_text("referer", "http://a.test/r".into());
        data.post = Some((Arc::from(&b"q=1"[..]), None));
        data.state = Some(Arc::from(&b"s"[..]));
        h.record_page_entry("http://a.test/p".into(), false, data);
        h.set_leaving(h.active(0));
        h.commit_javascript_document("http://a.test/p".into());
        let t = h.lock();
        let e = t.state.current_entry(TOP, t.build).unwrap();
        assert_eq!((t.state.length(), e.data.text("referer"), e.data.post.is_none(), e.data.state.is_none(), t.leaving), (2, Some("http://a.test/r"), true, true, None));
    }

    #[test]
    fn a_replacement_adds_no_step() {
        let h = history();
        h.replace(TOP, TOP, "/a".into(), false, Data::default());
        h.replace(TOP, TOP, "/b".into(), false, Data::default());
        assert_eq!(h.length(), 1);
        h.replace(2, TOP, "/f".into(), false, Data::default()).unwrap();
        assert_eq!(h.length(), 1);
        assert_eq!(h.url(h.active(2).unwrap()).as_deref(), Some("/f"));
        h.push(TOP, TOP, "/c".into(), false, Data::default());
        assert_eq!(h.length(), 2);
    }

    // Past 50 steps the oldest go, a page entry a frame's later steps are still of kept at the first of them.
    #[test]
    fn it_keeps_the_last_fifty_steps() {
        let h = history();
        h.push(TOP, TOP, "/0".into(), false, Data::default());
        h.push(2, TOP, "/f".into(), false, Data::default()).unwrap();
        for i in 1..60 {
            h.push(TOP, TOP, format!("/{i}"), false, Data::default());
        }
        assert_eq!(h.length(), 50);
        assert_eq!(h.url(h.active(TOP).unwrap()).as_deref(), Some("/59"));
        let oldest = h.lock().state.used_steps()[0];
        assert_eq!(h.url(h.entry_at_step(oldest).unwrap()).as_deref(), Some("/10"));
        let h = history();
        h.push(TOP, TOP, "/0".into(), false, Data::default());
        for _ in 0..55 {
            h.push(2, TOP, "/f".into(), false, Data::default()).unwrap();
        }
        assert_eq!(h.length(), 50);
        assert_eq!(h.lock().state.entries.len(), 1);
    }

    // A nested frame's history is in its parent frame's entry's document state; the parent navigated, the child's steps
    // stay, the child itself is gone from the tree of active entries.
    #[test]
    fn a_nested_frame_is_its_parents() {
        let h = history();
        h.push(TOP, TOP, "/a".into(), false, Data::default());
        h.seed(1, TOP, "/mid".into());
        h.seed(2, 1, "/in1".into()).unwrap();
        h.push(2, 1, "/in2".into(), false, Data::default()).unwrap();
        assert_eq!(h.length(), 2);
        h.push(1, TOP, "/mid2".into(), false, Data::default());
        assert_eq!(h.length(), 3);
        assert_eq!(h.active(2), None);
        let (step, changes) = h.plan(-1).unwrap();
        assert_eq!(changes.iter().map(|c| c.0).collect::<Vec<_>>(), vec![1]);
        h.go_to(step);
        assert_eq!(h.url(h.active(2).unwrap()).as_deref(), Some("/in2"));
    }

    // A frame's container removed: its steps are none of the page's (HTML "destroy a child navigable"; Chrome keeps them).
    #[test]
    fn a_destroyed_navigable_takes_its_steps() {
        let h = history();
        h.push(TOP, TOP, "/a".into(), false, Data::default());
        h.seed(1, TOP, "/f1".into());
        h.push(1, TOP, "/f2".into(), false, Data::default());
        h.seed(2, 1, "/in".into());
        assert_eq!(h.length(), 2);
        h.lock().destroy(1);
        assert_eq!(h.length(), 1);
        assert_eq!(h.active(1), None);
        assert_eq!(h.plan(-1).map(|p| p.1), None);
    }

    // A frame a step moves whose target entry's document is not made stays at its own (HTML "apply the history step"):
    // a later step that gives it that entry again is no change of it.
    #[test]
    fn a_held_navigable_stays_at_its_entry() {
        let h = history();
        h.push(TOP, TOP, "/top".into(), false, Data::default());
        h.seed(1, TOP, "/blank".into());
        let fa = h.push(1, TOP, "/fa".into(), false, Data::default()).unwrap();
        h.seed(2, TOP, "/blank2".into());
        h.push(2, TOP, "/fb".into(), false, Data::default());
        let (step, _) = h.plan(-2).unwrap();
        h.go_to(step);
        h.hold(1, fa, 2);
        assert_eq!(h.active(1), Some(fa));
        let changes = h.plan(1).unwrap().1;
        assert!(changes.iter().all(|c| c.0 != 1));
        let (step, _) = h.plan(2).unwrap();
        h.go_to(step);
        assert_eq!(h.active(1), Some(fa));
        assert!(h.lock().state.held.is_empty());
    }

    // …and a navigation clearing the forward steps keeps it at that entry, now the current step's.
    #[test]
    fn a_held_navigable_keeps_its_entry_past_a_navigation() {
        let h = history();
        h.push(TOP, TOP, "/top".into(), false, Data::default());
        h.seed(1, TOP, "/blank".into());
        let fa = h.push(1, TOP, "/fa".into(), false, Data::default()).unwrap();
        h.seed(2, TOP, "/blank2".into());
        h.push(2, TOP, "/fb".into(), false, Data::default());
        let (step, _) = h.plan(-2).unwrap();
        h.go_to(step);
        h.hold(1, fa, 2);
        h.push(2, TOP, "/mz".into(), false, Data::default());
        assert_eq!(h.active(1), Some(fa));
        assert_eq!(h.length(), 2);
        assert!(h.lock().state.held.is_empty());
    }

    // …released where a later step moves it to another entry (its document made), and the frames of its document read
    // at the step it was held at.
    #[test]
    fn a_hold_goes_where_a_step_moves_the_navigable() {
        let h = history();
        h.push(TOP, TOP, "/top".into(), false, Data::default());
        h.seed(1, TOP, "/blank".into());
        let fa = h.push(1, TOP, "/fa".into(), false, Data::default()).unwrap();
        h.seed(3, 1, "/c0".into());
        let cz = h.push(3, 1, "/cz".into(), false, Data::default()).unwrap();
        let fc = h.push(1, TOP, "/fc".into(), false, Data::default()).unwrap();
        h.seed(2, TOP, "/blank2".into());
        h.push(2, TOP, "/fb".into(), false, Data::default());
        let before = h.step();
        let (step, _) = h.plan(-4).unwrap();
        h.go_to(step);
        h.hold(1, fc, before);
        assert_eq!(h.active(1), Some(fc));
        let (step, changes) = h.plan(2).unwrap();
        assert!(changes.contains(&(1, fa, false)));
        h.go_to(step);
        assert_eq!(h.active(1), Some(fa));
        assert_eq!(h.active(3), Some(cz));
    }

    // A step none of whose documents is made, moving nothing within a document, leaves the history as it stood; one that
    // makes some holds the navigables of the others at their entries.
    #[test]
    fn a_step_none_of_whose_documents_is_made_is_no_step() {
        let h = history();
        h.push(TOP, TOP, "/top".into(), false, Data::default());
        let f1 = h.seed(1, TOP, "/f1".into()).unwrap();
        let g1 = h.seed(2, TOP, "/g1".into()).unwrap();
        let f2 = h.push(1, TOP, "/f2".into(), false, Data::default()).unwrap();
        let g2 = h.push(2, TOP, "/g2".into(), false, Data::default()).unwrap();
        let before = h.step();
        let (step, changes) = h.plan(-1).unwrap();
        assert!(h.lock().begin_step(step, &changes).is_empty());
        h.lock().end_step(1, &[2]);
        assert_eq!((h.step(), h.active(1), h.active(2)), (before, Some(f2), Some(g2)));
        let (step, changes) = h.plan(-2).unwrap();
        h.lock().begin_step(step, &changes);
        h.lock().end_step(2, &[1]);
        assert_eq!((h.active(1), h.active(2)), (Some(f2), Some(g1)));
        assert_ne!(h.step(), before);
        assert_ne!(f1, g1);
    }

    // …and the moves within a document it makes are returned, with their entries' URLs and states and whether the
    // fragment changed.
    #[test]
    fn a_step_returns_its_moves_within_a_document() {
        let h = history();
        h.push(TOP, TOP, "/a".into(), false, Data::default());
        h.push(TOP, TOP, "/a#x".into(), true, Data { state: Some(Arc::from(&b"s"[..])), ..Data::default() });
        h.push(TOP, TOP, "/a?q#x".into(), true, Data::default());
        let (step, changes) = h.plan(-1).unwrap();
        let moves = h.lock().begin_step(step, &changes);
        assert_eq!(moves, vec![(TOP, "/a#x".to_owned(), Some(Arc::from(&b"s"[..])), false)]);
        let (step, changes) = h.plan(-1).unwrap();
        assert!(h.lock().begin_step(step, &changes)[0].3);
        h.lock().end_step(0, &[]);
    }

    // A frame's navigation makes its entry as its document is made, and none where it makes none — the one it ended, its
    // number's, none either; nor once the frame is destroyed.
    #[test]
    fn a_frame_navigation_makes_its_entry_only_with_its_document() {
        let h = history();
        h.push(TOP, TOP, "/top".into(), false, Data::default());
        let f1 = h.seed(1, TOP, "/f1".into()).unwrap();
        let begin = |url: &str, replace: bool| h.lock().begin_frame_entry(1, TOP, url.into(), replace, Data::default(), Vec::new());
        let made = begin("/f204", false);
        assert_eq!(h.length(), 1);
        h.abandon_frame_navigation(1, made);
        assert_eq!(h.commit_frame_navigation(1, made, None, Data::default()), None);
        assert_eq!((h.active(1), h.length()), (Some(f1), 1));

        let first = begin("/slow", false);
        let second = begin("/f2", false);
        h.abandon_frame_navigation(1, first);
        let f2 = h.commit_frame_navigation(1, second, Some(("/f2-redirected", true)), Data::default());
        assert_eq!((h.active(1), h.length()), (f2, 2));
        assert_eq!(h.url(f2.unwrap()).as_deref(), Some("/f2-redirected"));

        let replacing = begin("/f3", true);
        let f3 = h.commit_frame_navigation(1, replacing, None, Data::default());
        assert_eq!((h.active(1), h.length()), (f3, 2));

        // (…none of another navigation's number; a replay's redirect its active entry's)
        let f4 = begin("/f4", false);
        assert_eq!(h.commit_frame_navigation(1, f4 + 1, None, Data::default()), None);
        h.abandon_frame_navigation(1, f4);
        h.redirect_entry(h.active(1).unwrap(), "/f3-moved", false);
        assert_eq!(h.url(f3.unwrap()).as_deref(), Some("/f3-moved"));

        let gone = begin("/gone", false);
        h.lock().destroy(1);
        assert_eq!(h.commit_frame_navigation(1, gone, None, Data::default()), None);
    }

    // A navigation begun is the navigable's ongoing one until another is begun or a traversal applied.
    #[test]
    fn a_navigation_is_ongoing_until_another_or_a_traversal() {
        let h = history();
        h.push(TOP, TOP, "/a".into(), false, Data::default());
        let first = h.begin_navigation(TOP);
        let frame = h.begin_navigation(1);
        assert!(h.navigation_ongoing(TOP, first) && h.navigation_ongoing(1, frame));
        let second = h.begin_navigation(TOP);
        assert!(!h.navigation_ongoing(TOP, first) && h.navigation_ongoing(TOP, second));
        // (…a traversal ending those of the navigables whose current entry it changes alone)
        h.push(TOP, TOP, "/b".into(), false, Data::default());
        h.go_to(0);
        assert!(!h.navigation_ongoing(TOP, second) && h.navigation_ongoing(1, frame));
        let third = h.begin_navigation(TOP);
        h.go_to(0);
        assert!(h.navigation_ongoing(TOP, third));
    }

    #[test]
    fn an_entry_of_the_same_document_shares_what_it_was_reached_by() {
        let h = history();
        let reached = Data { texts: [None, Some("/r".into()), None, None, None, None], cross_site: Some(true), post: Some((Arc::from(&b"q=1"[..]), None)), ..Default::default() };
        h.push(TOP, TOP, "/a".into(), false, reached);
        let pushed = h.push(TOP, TOP, "/b".into(), true, Data::default()).unwrap();
        let other = h.push(TOP, TOP, "/c".into(), false, Data::default()).unwrap();
        let t = h.lock();
        let data = &t.state.entry(pushed).unwrap().data;
        assert_eq!((data.text("referer"), data.cross_site, data.post.is_none()), (Some("/r"), Some(true), true));
        assert_eq!(t.state.entry(other).unwrap().data.cross_site, None);
    }

    #[test]
    fn a_top_level_name_is_its_document_state_s() {
        let h = history();
        let name = |h: &SessionHistory| String::from_utf16_lossy(&h.lock().state.name(0));
        // (…the one a window was made with its first document's; set, every entry of its document's; carried to the next
        // document; and back with its entry on a traversal)
        h.set_name("pop".into());
        h.push(TOP, TOP, "/a".into(), false, Data::default());
        h.push(TOP, TOP, "/a#x".into(), true, Data::default());
        h.set_name("set".into());
        assert_eq!(name(&h), "set");
        let step = h.lock().state.current;
        h.push(TOP, TOP, "/b".into(), false, Data::default());
        assert_eq!(name(&h), "set");
        h.set_name("later".into());
        h.go_to(step);
        assert_eq!(name(&h), "set");
        h.go_to(step - 1);
        assert_eq!(name(&h), "set");
    }

    #[test]
    fn the_shown_document_keeps_its_name_through_a_replace() {
        let h = history();
        let name = |h: &SessionHistory| String::from_utf16_lossy(&h.lock().state.name(0));
        h.push(TOP, TOP, "/a".into(), false, Data::default());
        h.show();
        h.set_name("orig".into());
        // (…a replace navigation in flight: the leaving document's pagehide names its own state, not the next one's)
        h.replace(TOP, TOP, "/b".into(), false, Data::default());
        h.clear_name();
        h.set_name("fromhide".into());
        assert_eq!(name(&h), "fromhide");
        h.show();
        assert_eq!(name(&h), "");
    }

    #[test]
    fn what_is_asked_of_a_window_waits_to_be_taken_and_a_close_is_seen_at_once() {
        let plan = |url: &str, resource: Resource| Planned {
            url: url.into(),
            replace: false,
            activated: false,
            referrer: None,
            policy: None,
            initiator: Initiator::default(),
            resource,
        };
        let popup = SessionHistory::new();
        popup.lock().by_web_content = true;
        assert!(!popup.is_asked());
        popup.plan_navigation(plan("http://a.test/1", Resource::Get));
        let post = Resource::Post { body: b"k=v".to_vec(), content_type: "application/x-www-form-urlencoded".into() };
        popup.plan_navigation(plan("http://a.test/posted", post.clone()));
        assert!(popup.is_asked() && window_tasks_pending());
        // (…the later plan in place of the first, its resource with it)
        assert_eq!(popup.take_planned().map(|p| (p.url, p.resource)), Some(("http://a.test/posted".into(), post)));
        assert!(!popup.is_asked());
        // (…closing as it is asked, the close a task of its own, asked once — the navigation planned before it gone, none
        // planned after it)
        popup.plan_navigation(plan("http://a.test/3", Resource::Get));
        assert!(popup.ask_close() && popup.is_closing() && !popup.ask_close());
        popup.plan_navigation(plan("http://a.test/4", Resource::Get));
        assert!(popup.take_planned().is_none());
        assert!(popup.take_close() && !popup.take_close());
        assert!(!popup.is_asked());
    }

    #[test]
    fn a_traversal_replacing_the_document_wins_over_those_queued_after_it() {
        let h = history();
        h.push(TOP, 0, "http://a.test/1".into(), false, Data::default());
        for url in ["http://a.test/2", "http://a.test/3"] {
            h.push(TOP, 0, url.into(), true, Data::default());
        }
        h.push(TOP, 0, "http://a.test/4".into(), false, Data::default());
        // (…the first that replaces its document taken, those asked of that document after it let go with it)
        let (first, delay) = h.lock().queue(-1);
        assert_eq!(delay, 0);
        h.lock().queue(-1);
        assert_eq!(h.take_queued(first), vec![(first, -1)]);
        assert!(!h.is_queued());
        // (…those within its document taken in order)
        let (a, delay) = h.lock().queue(-1);
        assert_eq!(delay, 0);
        h.go_to(h.plan(-1).unwrap().0);
        let (b, delay) = h.lock().queue(-1);
        assert_eq!(delay, 1);
        let (c, _) = h.lock().queue(1);
        assert_eq!(h.take_all_queued(), vec![(a, -1), (b, -1), (c, 1)]);
    }

    #[test]
    fn a_window_web_content_did_not_make_closes_only_at_its_first_entry() {
        let page = SessionHistory::new();
        page.push(TOP, TOP, "http://a.test/".into(), false, Data::default());
        page.push(TOP, TOP, "http://a.test/2".into(), false, Data::default());
        assert!(!page.ask_close());
        let fresh = SessionHistory::new();
        fresh.push(TOP, TOP, "http://a.test/".into(), false, Data::default());
        assert!(fresh.ask_close());
    }

    #[test]
    fn a_step_left_keeps_the_data_it_had() {
        let h = history();
        h.push(TOP, TOP, "/top".into(), false, Data::default());
        h.seed(1, TOP, "/f1".into());
        let a = h.push(1, TOP, "/f2".into(), false, Data { texts: [None, Some("/r".into()), None, None, None, None], ..Default::default() }).unwrap();
        let (step, changes) = h.plan(-1).unwrap();
        h.lock().begin_step(step, &changes);
        Arc::make_mut(&mut h.lock().state.entry_mut(a).unwrap().data).texts[1] = Some("/changed".into());
        h.lock().end_step(1, &[1]);
        assert_eq!(h.lock().state.entry(a).unwrap().data.text("referer"), Some("/r"));
    }
}

// The navigable target name of the session history numbered `id`'s top-level navigable (`State::name`), and — `set_name_of`
// — that one made `name`; none where it is gone.
pub(crate) fn name_of(id: u64) -> Option<Vec<u16>> {
    let traversable = histories().1.get(&id)?.upgrade()?;
    let t = traversable.lock().unwrap_or_else(PoisonError::into_inner);
    Some(t.state.name(t.build))
}
pub(crate) fn set_name_of(id: u64, name: &[u16]) {
    let Some(traversable) = histories().1.get(&id).and_then(Weak::upgrade) else { return };
    let mut t = traversable.lock().unwrap_or_else(PoisonError::into_inner);
    let build = t.build;
    t.state.set_name(build, name);
}

// The opener policy of the document top-level traversable `id` is at (`opener_policy`), none for one gone.
pub(crate) fn opener_policy_of(id: u64) -> crate::coop::Value {
    histories().1.get(&id).and_then(Weak::upgrade).map_or(crate::coop::Value::UnsafeNone, |t| lock(&t).opener_policy)
}

// …and whether its session has the loopback stand-in (`loopback_stand_in`), and its creation URL where a creator gave it one.
pub(crate) fn loopback_stand_in_of(id: u64) -> bool {
    histories().1.get(&id).and_then(Weak::upgrade).is_some_and(|t| lock(&t).loopback_stand_in)
}
pub(crate) fn creation_url_of(id: u64) -> Option<String> {
    histories().1.get(&id).and_then(Weak::upgrade).and_then(|t| lock(&t).creation_url.clone())
}

// Whether top-level traversable `id` closed: its page's browsing context discarded, which no opener of another window
// is then.
pub(crate) fn closed(id: u64) -> bool {
    histories().1.get(&id).and_then(Weak::upgrade).is_some_and(|t| lock(&t).closed)
}

// A navigation planned of a traversable, in place of the one planned before (`Asked::planned`) — none of one closing or
// closed, which no navigation of finishes.
// (…nor of one traversing: HTML "navigate" ignores it)
fn plan_on(t: &mut Traversable, planned: Planned) {
    if !t.closed && !t.asked.closing && !t.traversing(TOP) {
        asking(t, |t| t.asked.planned = Some(planned));
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "traversableClosing", traversable_closing_op, context_id);
    crate::dom::register(scope, ns, "setSessionHistory", set_session_history, context_id);
    crate::dom::register(scope, ns, "sessionStorageShed", session_storage_shed_op, context_id);
    crate::dom::register(scope, ns, "historyLength", history_length_op, context_id);
    crate::dom::register(scope, ns, "historyTraverse", history_traverse_op, context_id);
    crate::dom::register(scope, ns, "navigableTraversing", navigable_traversing_op, context_id);
    crate::dom::register(scope, ns, "applyTraversal", apply_traversal_op, context_id);
    crate::dom::register(scope, ns, "windowsTraversing", windows_traversing_op, context_id);
    crate::dom::register(scope, ns, "destroyNavigableHistory", destroy_navigable_history_op, context_id);
    crate::dom::register(scope, ns, "historyUpdate", history_update_op, context_id);
    crate::dom::register(scope, ns, "frameNavigable", frame_navigable_op, context_id);
    crate::dom::register(scope, ns, "frameEntry", frame_entry_op, context_id);
    crate::dom::register(scope, ns, "beginFrameEntry", begin_frame_entry_op, context_id);
}

// __dom.traversableClosing() -> whether the top-level traversable of the isolate's page is closing or closed (HTML's
// `closed` getter: its "is closing", which a `close()` set as it was asked), or gone.
fn traversable_closing_op(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = crate::dom::realm(scope, 0).navigables.history;
    let traversable = histories().1.get(&id).and_then(Weak::upgrade);
    let closing = traversable.is_none_or(|t| {
        let t = t.lock().unwrap_or_else(PoisonError::into_inner);
        t.closed || t.asked.closing
    });
    rv.set_bool(closing);
}

// __dom.setSessionHistory(id) — the session history of the isolate's window (`SessionHistory#id`), the host's to say.
fn set_session_history(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).number_value(scope).map_or(0, |n| n as u64);
    crate::dom::dom(scope).arena.navigables.history = id;
}

// Whether realm `realm`'s `history` is its window's session history: a realm of the page's, or of a frame of it — every
// container up to the page's in a live document (navigables.rs `realm_in_tree`) — not one of another traversable (a
// window `window.open` made in this isolate, or a frame of one).
fn of_page(arena: &crate::dom::RealmArena, realm: i32) -> bool {
    arena.realm_in_tree(realm) && arena.top_level_realm(realm) == 0
}

// The top-level traversable whose session history realm `realm`'s `history` is: the page's — of a realm of its tree
// (`of_page`) — or a window's `window.open` made in this isolate (navigables.rs `window_history`), with the realm of that
// window's document; none for a realm of neither (a frame removed, a window navigated away from).
fn traversable_of(arena: &crate::dom::RealmArena, realm: i32) -> Option<(Arc<Mutex<Traversable>>, Option<i32>)> {
    if of_page(arena, realm) {
        return histories().1.get(&arena.navigables.history)?.upgrade().map(|t| (t, None));
    }
    arena.window_history(realm).map(|(h, window)| (h.traversable.clone(), Some(window)))
}
// The navigation of the navigable realm `realm`'s document is the active document of begun, its ongoing one now (HTML
// "set the ongoing navigation", of its traversable: `Traversable::begin_navigation`) — or, `container` given, of that
// container's child navigable in realm `realm`'s document (a frame's `src`): its number, 0 for a realm of no traversable
// (a frame removed, a window navigated away from) — and whether the one numbered `id` still is.
pub(crate) fn begin_navigation_of(arena: &crate::dom::RealmArena, realm: i32, container: Option<crate::dom::NodeId>) -> u64 {
    let nav = match container {
        Some(c) => arena.child_navigable(c),
        None => Some(arena.realm_tree(realm).2),
    };
    match (traversable_of(arena, realm), nav) {
        (Some((t, _)), Some(nav)) => lock(&t).begin_navigation(nav),
        _ => 0,
    }
}
// …and whether realm `realm`'s navigable is traversing (`Traversable::traversing`): a navigation of it ignored.
pub(crate) fn traversing_of(arena: &crate::dom::RealmArena, realm: i32) -> bool {
    traversable_of(arena, realm).is_some_and(|(t, _)| lock(&t).traversing(arena.realm_tree(realm).2))
}
// …and one of realm `realm`'s traversable planned again — a flush's plan put back (navigation_plan.rs `flushRestore`) — its
// navigables (`TOP` for one that makes the top-level document again) traversing again, the host's to take.
pub(crate) fn replan_of(arena: &crate::dom::RealmArena, realm: i32, navs: impl Iterator<Item = u32>) {
    if let Some((t, _)) = traversable_of(arena, realm) {
        let mut t = lock(&t);
        for nav in navs {
            t.begin_traversal(nav);
        }
        t.planned_for_host = true;
    }
}
// …and whether one of realm `realm`'s traversable is still planned for the host, which its take tells it (navigation_plan.rs
// `takeTraversal`).
pub(crate) fn note_planned_of(arena: &crate::dom::RealmArena, realm: i32, planned: bool) {
    if let Some((t, _)) = traversable_of(arena, realm) {
        lock(&t).planned_for_host = planned;
    }
}
// …and the traversals of realm `realm`'s traversable let go of (`Traversable::end_traversal`).
pub(crate) fn end_traversal_of(arena: &crate::dom::RealmArena, realm: i32) {
    if let Some((t, _)) = traversable_of(arena, realm) {
        lock(&t).end_traversal();
    }
}
pub(crate) fn navigation_ongoing_of(arena: &crate::dom::RealmArena, realm: i32, id: u64) -> bool {
    traversable_of(arena, realm).map_or(id == 0, |(t, _)| lock(&t).navigation_ongoing(arena.realm_tree(realm).2, id))
}
// The session storage shed of the top-level traversable realm `realm`'s document is of (`session_storage`) — 0 for none (a
// removed frame's document, a window's gone): no shed's, whose areas hold nothing (storage_areas.rs `area_key` takes
// none below 1), never one another traversable shares.
pub(crate) fn session_storage_of(arena: &crate::dom::RealmArena, realm: i32) -> u64 {
    traversable_of(arena, realm).map_or(0, |(t, _)| lock(&t).session_storage)
}
// …and its popup sandboxing flag set (`Traversable::popup_sandbox`), none for a realm of none.
pub(crate) fn popup_sandbox_of(arena: &crate::dom::RealmArena, realm: i32) -> u32 {
    traversable_of(arena, realm).map_or(0, |(t, _)| lock(&t).popup_sandbox)
}
// __dom.sessionStorageShed(realm) -> realm `realm`'s (storage.js: the realm whose global's area it is, whichever realm's
// method runs).
fn session_storage_shed_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = args.get(0).int32_value(scope).unwrap_or_else(|| crate::dom::realm_id(scope, &args));
    let shed = session_storage_of(&crate::dom::dom(scope).arena, cid);
    rv.set_double(shed as f64);
}
fn lock(t: &Mutex<Traversable>) -> MutexGuard<'_, Traversable> {
    t.lock().unwrap_or_else(PoisonError::into_inner)
}
// An entry's classic history API state for the bindings: its bytes, null for none.
fn state_value<'s>(scope: &mut v8::PinScope<'s, '_>, state: Option<&Arc<[u8]>>) -> v8::Local<'s, v8::Value> {
    match state {
        Some(s) => crate::dom::u8_array(scope, s.to_vec()),
        None => v8::null(scope).into(),
    }
}
// …and the bytes the bindings gave for one (`serializeForStorage`'s), none for null.
fn state_arg(value: v8::Local<'_, v8::Value>) -> Option<Arc<[u8]>> {
    let view = v8::Local::<v8::ArrayBufferView>::try_from(value).ok()?;
    let mut bytes = vec![0; view.byte_length()];
    let copied = view.copy_contents(&mut bytes);
    bytes.truncate(copied);
    Some(bytes.into())
}

// __dom.historyLength() -> `history.length` of the calling realm's document: its traversable's session history's
// (`traversable_of`) — the page's, its frames' with it; a window's of this isolate — or 1, the one entry of its initial
// document, for a realm of none; a SecurityError for a document that is not fully active (HTML's History `length`
// getter).
fn history_length_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    if !arena.navigables.fully_active(cid) {
        let Some(message) = v8::String::new(
            scope,
            "Failed to read the 'length' property from 'History': May not use a History object associated with a Document that is not fully active",
        ) else {
            return;
        };
        return crate::clone::throw_dom_exception(scope, message, "SecurityError");
    }
    let length = traversable_of(arena, cid).map_or(1, |(t, _)| lock(&t).state.length());
    rv.set_uint32(length as u32);
}

// __dom.navigableTraversing(realm) -> whether realm `realm`'s navigable is traversing (`traversing_of`).
fn navigable_traversing_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = args.get(0).int32_value(scope).unwrap_or(-1);
    rv.set_bool(realm >= 0 && traversing_of(&crate::dom::dom(scope).arena, realm));
}
// __dom.historyTraverse(delta) -> [token, delay, top]: a traversal by `delta` the calling realm's `history` asked for,
// appended to its traversable's session history traversal queue (`traversable_of`, `Traversable::queue`) — [0, 0, -1] for
// a realm of none, which traverses nothing. Its task, which the bindings queue with that delay on the event loop of the
// traversable's top-level document, realm `top` — the traversable's, not the asking frame's, which may be gone by then
// (HTML "append the following session history traversal steps to traversable") — applies it (`applyTraversal`).
fn history_traverse_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let delta = args.get(0).integer_value(scope).unwrap_or(0);
    let cid = crate::dom::realm_id(scope, &args);
    let queued = traversable_of(crate::dom::realm(scope, cid), cid).filter(|_| delta != 0).map(|(t, window)| (lock(&t).queue(delta), window.unwrap_or(0)));
    let ((token, delay), top) = queued.unwrap_or(((0, 0), -1));
    let items = [v8::Number::new(scope, token as f64).into(), v8::Integer::new_from_unsigned(scope, delay).into(), v8::Integer::new(scope, top).into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// The number of the top-level traversable the document of realm `realm` is of — its page's, or a window's
// `window.open` made in this isolate — 0 for none: the one whose navigable's entries it keeps (`traversable_of`), which
// the host records a frame's navigations in and applies its traversals to (navigables.rs `realmTree`).
pub(crate) fn traversable_id_of(arena: &crate::dom::RealmArena, realm: i32) -> u64 {
    if of_page(arena, realm) { arena.navigables.history } else { arena.window_history(realm).map_or(0, |(h, _)| h.id) }
}
// __dom.destroyNavigableHistory(realm) — the navigable realm `realm`'s document is the active document of destroyed, its
// container removed (HTML "destroy a child navigable"): its nested history taken out of its traversable's session
// history (`Traversable::destroy`), its own frames' with it.
fn destroy_navigable_history_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = args.get(0).int32_value(scope).unwrap_or(0);
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let nav = arena.realm_tree(realm).2;
    if nav == TOP {
        return;
    }
    if let Some((traversable, _)) = traversable_of(arena, realm) {
        lock(&traversable).destroy(nav);
    }
}
// __dom.windowsTraversing() -> the realms of the windows `window.open` made in this isolate a traversal queued of which
// makes a document again, its task still to apply it: what the host applies as the task that asked ends, as it does the
// page's (history.js `__csimApplyWindowTraversals`).
fn windows_traversing_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let windows: Vec<i32> = arena.stepped_windows().into_iter().filter(|&w| arena.window_history(w).is_some_and(|(h, _)| h.queued_documents())).collect();
    let items: Vec<v8::Local<v8::Value>> = windows.into_iter().map(|w| v8::Integer::new(scope, w).into()).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.applyTraversal(token, all, byHost) -> the traversal of `token`, and those queued before it (`Traversable::take_due`),
// applied to the session history of the calling realm's traversable (`traversable_of`) — the page's, or a window's
// `window.open` made in this isolate; a frame's `history` traverses its top-level one's — in order: [top, planned,
// settled, url, state, hashchange, …] — the realm of the top-level document, which is moved; whether one was planned for
// the host (below), which its navigation turn hands it (timers.js `queueNavigationTurn`); the realms whose load a frame's
// navigation let go of delays no more (`traversal_cancels_frame`); then of each traversal that moves it within its
// document its entry's URL and state and whether its fragment changed (HTML "update document for history step
// application": its location the URL, then `popstate` with the state, then a `hashchange`, which the bindings do). One
// that makes its document again is planned in that document's navigation plan (navigation_plan.rs `Traversal`), which
// the host takes as the task ends — its navigable's ongoing navigation "traversal" from then on, which lets go of the
// navigations planned of it, another window's too (HTML "apply the history step") — those asked of it after it let go;
// one that moves a frame of it planned there too (`FrameTraversal`), the navigations of each frame whose document it
// makes again let go of at once, as that frame's ongoing navigation is "traversal" from then on, and those taken with it
// queued again for the host to apply after it. Null for a realm of no traversable (a frame removed, a window navigated
// away from).
// (…token 0: those up to the last that makes a document again, `take_documents_queued`; `all`, every one queued — the
// host's, ahead of a navigation planned with them, and once it applied one that waited)
fn apply_traversal_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let token = args.get(0).number_value(scope).map_or(0, |n| n as u64);
    let all = args.get(1).is_true();
    let by_host = args.get(2).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    let Some((traversable, window)) = traversable_of(crate::dom::realm(scope, cid), cid) else { return rv.set_null() };
    let top = window.unwrap_or(0);
    // (…none while one taken before waits for the host to apply it: those queued after it judged from the step it goes
    // to, the host applying them after it — `all` — or letting them go with the document it replaces; nor behind a
    // `javascript:` URL's document its script asked them before, which goes first — both browsers make the document,
    // then traverse: browser.rb `commit_javascript_document`)
    let plan = &crate::dom::realm(scope, top).navigation_plan;
    if plan.traversal_waiting() || plan.javascript_document_planned() || lock(&traversable).holding || lock(&traversable).page_traversal.is_some() {
        let items = [v8::Integer::new(scope, top).into(), v8::Boolean::new(scope, false).into(), v8::Array::new(scope, 0).into()];
        return rv.set(v8::Array::new_with_elements(scope, &items).into());
    }
    let mut moves = Vec::new();
    let mut planned = None;
    let mut frames_planned = None;
    {
        let mut t = lock(&traversable);
        let due = if all {
            t.take_all_queued()
        } else if token == 0 {
            t.take_documents_queued()
        } else {
            t.take_queued(token)
        };
        let mut due = due.into_iter();
        while let Some(q) = due.next() {
            let Some((step, changes)) = t.traversal(q.delta) else { continue };
            let from = t.state.current_entry(TOP, t.build).map(|e| e.url.clone()).unwrap_or_default();
            let top_change = changes.iter().find(|c| c.0 == TOP).and_then(|c| t.state.entry(c.1).map(|e| (e.clone(), c.2)));
            if let Some((entry, false)) = top_change {
                planned = Some(Traversal { step, delta: q.delta, entry: entry.id });
                t.begin_traversal(TOP);
                asking(&mut t, |t| t.asked.planned = None);
                t.planned_for_host = true;
                break;
            }
            // (…one that moves a frame of it — its document made again, or moved within — the host's, the top-level
            // document's own move within its document with them: those taken with it put back ahead of the rest, for the
            // host to apply after it, from the step it goes to)
            if changes.iter().any(|c| c.0 != TOP) {
                let rest: Vec<Queued> = due.collect();
                asking(&mut t, |t| {
                    t.queued.splice(0..0, rest);
                });
                for &(nav, _, same) in &changes {
                    if !same {
                        t.begin_traversal(nav);
                    }
                }
                frames_planned = Some(crate::navigation_plan::FrameTraversal { step, changes, planned: 0 });
                t.planned_for_host = true;
                break;
            }
            if t.flush_mark.is_some_and(|mark| q.token > mark) {
                continue;
            }
            t.go_to(step);
            if let Some((entry, _)) = top_change {
                // (…the page's URL its traversable's, the host's to read: `move_url`'s, of no step noted)
                if window.is_none() {
                    t.url = Some(entry.url.clone());
                }
                let hashchange = fragment(&from) != fragment(&entry.url);
                moves.push((entry.url, entry.data.state.clone(), hashchange));
            }
        }
    }
    let mut settled = Vec::new();
    let host_planned = planned.is_some() || frames_planned.is_some();
    if let Some(traversal) = frames_planned {
        let arena = crate::dom::realm(scope, top);
        settled.extend(traversal.changes.iter().filter(|&&(nav, _, same)| nav != TOP && !same).filter_map(|&(nav, ..)| arena.traversal_cancels_frame(nav)));
        arena.navigation_plan.plan_frame_traversal(traversal, by_host);
    }
    if let Some(traversal) = planned {
        crate::dom::realm(scope, top).navigation_plan.plan_traversal(traversal);
    }
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(moves.len() * 3 + 3);
    items.push(v8::Integer::new(scope, top).into());
    items.push(v8::Boolean::new(scope, host_planned).into());
    items.push(crate::navigables::realm_array(scope, &settled));
    for (url, state, hashchange) in moves {
        let Some(url) = v8::String::new(scope, &url) else { return rv.set_null() };
        items.push(url.into());
        items.push(state_value(scope, state.as_ref()));
        items.push(v8::Boolean::new(scope, hashchange).into());
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// A URL's fragment — none where it has none, which an empty one is not.
fn fragment(url: &str) -> Option<&str> {
    url.split_once('#').map(|(_, f)| f)
}

// The navigable of frame realm `realm` in its traversable's session history: its number, its parent's (`TOP` for the
// top-level one), the realm of its container's document, and the traversable with its number — none for a realm that is
// no frame (the page's, a window's), one whose container left its document, or one of no traversable (browser.rb
// `frame_navigable`).
pub(crate) struct FrameNavigable {
    nav: u32,
    parent_nav: u32,
    parent: i32,
    traversable: Arc<Mutex<Traversable>>,
    traversable_id: u64,
}
pub(crate) fn frame_navigable(arena: &crate::dom::RealmArena, realm: i32) -> Option<FrameNavigable> {
    let (parent, _, nav, _) = arena.realm_tree(realm);
    if realm == 0 || nav == TOP || arena.frame_container(parent, realm).is_none() {
        return None;
    }
    let (traversable, _) = traversable_of(arena, realm)?;
    let (_, depth, parent_nav, _) = if parent == 0 { (0, 0, TOP, false) } else { arena.realm_tree(parent) };
    if parent_nav == TOP && depth != 0 {
        return None;
    }
    Some(FrameNavigable { nav, parent_nav, parent, traversable, traversable_id: traversable_id_of(arena, realm) })
}
// …and its active entry — `create`, made where it has none (its parent's first, HTML "create a new child navigable":
// `entry_seeds`) — with its navigable; none for no entry.
fn frame_entry(arena: &crate::dom::RealmArena, realm: i32, create: bool) -> Option<(FrameNavigable, u64)> {
    if create {
        let (frame, seeds) = entry_seeds(arena, realm)?;
        let mut t = lock(&frame.traversable);
        let id = seeds.iter().fold(None, |_, seed| t.seed_entry(seed))?;
        drop(t);
        return Some((frame, id));
    }
    let frame = frame_navigable(arena, realm)?;
    let t = lock(&frame.traversable);
    let id = t.state.current_entry(frame.nav, t.build)?.id;
    drop(t);
    Some((frame, id))
}
// The entries frame realm `realm`'s navigable and its ancestors' are given where they have none (`EntrySeed`), outermost
// first, the frame's own last: of the URL of the document each is at, keeping that document's referrer and the markup
// of an about:srcdoc one (as its realm's: `frame_document_srcdoc`) — with its navigable.
fn entry_seeds(arena: &crate::dom::RealmArena, realm: i32) -> Option<(FrameNavigable, Vec<EntrySeed>)> {
    let mut seeds = Vec::new();
    let mut at = realm;
    while let Some(frame) = frame_navigable(arena, at) {
        seeds.push(EntrySeed {
            nav: frame.nav,
            parent: frame.parent_nav,
            url: arena.realm_state(at).map_or_else(String::new, |s| s.location.href().to_owned()),
            referrer: arena.realm_document(at).and_then(|doc| arena.document_states.referrer(doc)).unwrap_or_default().to_owned(),
            srcdoc: arena.live_container(at).and_then(|c| arena.frame_document_srcdoc(c)).map(Into::into),
        });
        if frame.parent_nav == TOP {
            break;
        }
        at = frame.parent;
    }
    seeds.reverse();
    Some((frame_navigable(arena, realm)?, seeds))
}
// …made where frame realm `realm` has none: what a document its document's URL moves away from keeps (the document open
// steps: document_lifecycle.rs `take_entry_url`).
pub(crate) fn ensure_frame_entry(arena: &crate::dom::RealmArena, realm: i32) {
    frame_entry(arena, realm, true);
}

// __dom.frameNavigable(realm) -> [navigable, parent navigable, parent realm, traversable] of frame realm `realm`
// (`frame_navigable`), the host's — null for none.
fn frame_navigable_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = args.get(0).int32_value(scope).unwrap_or(0);
    let cid = crate::dom::realm_id(scope, &args);
    let Some(frame) = frame_navigable(crate::dom::realm(scope, cid), realm) else { return rv.set_null() };
    let items = [
        v8::Integer::new_from_unsigned(scope, frame.nav).into(),
        v8::Integer::new_from_unsigned(scope, frame.parent_nav).into(),
        v8::Integer::new(scope, frame.parent).into(),
        v8::Number::new(scope, frame.traversable_id as f64).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.frameEntry(realm, create) -> [traversable, entry] of frame realm `realm`'s active entry (`frame_entry`), the
// host's — null for none.
fn frame_entry_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = args.get(0).int32_value(scope).unwrap_or(0);
    let create = args.get(1).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    let Some((frame, id)) = frame_entry(crate::dom::realm(scope, cid), realm, create) else { return rv.set_null() };
    let items = [v8::Number::new(scope, frame.traversable_id as f64).into(), v8::Number::new(scope, id as f64).into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.beginFrameEntry(realm, url, replace, srcdoc) -> [handling, navigable, token]: a navigation of frame realm `realm`'s
// navigable to `url` begun (`Traversable::begin_frame_entry`), the entry it makes as its document is — "replace" in place
// of the active one where `replace`, and where the frame is at its initial about:blank, which no traversal goes back to
// (HTML "navigate": a navigable whose active document is its initial about:blank replaces it — its first document's,
// about:blank, of no entry yet, which a navigation that made none since, a 204's or one another ended, leaves it); "push"
// else, the active one made first where the frame has none (`frame_entry`) — of the
// markup `srcdoc` an about:srcdoc document is made of. Null for no frame, and for a `javascript:` URL, which runs in the
// document the frame is at (HTML "navigate", its result at most replacing it): no entry is its.
fn begin_frame_entry_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = args.get(0).int32_value(scope).unwrap_or(0);
    let url = args.get(1).to_rust_string_lossy(scope);
    let replace = args.get(2).is_true();
    let srcdoc = (!args.get(3).is_null_or_undefined()).then(|| args.get(3).to_rust_string_lossy(scope));
    if url.get(..11).is_some_and(|scheme| scheme.eq_ignore_ascii_case("javascript:")) {
        return rv.set_null();
    }
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let initial = frame_entry(arena, realm, false).is_none()
        && arena.realm_tree(realm).3
        && arena.realm_state(realm).and_then(|s| ada_url::Url::parse(s.location.href(), None).ok()).is_some_and(|u| crate::url_ops::matches_about_blank(&u));
    let replace = replace || initial;
    let Some((frame, mut seeds)) = entry_seeds(arena, realm) else { return rv.set_null() };
    // (…the active entry made now only where the next comes after it, which the document it leaves is snapshotted into
    // (browser.rb `leave_frame_entry`); else its ancestors' as it commits: `FrameNavigation`)
    let mut t = lock(&frame.traversable);
    if !replace {
        for seed in &seeds {
            t.seed_entry(seed);
        }
        seeds.clear();
    } else {
        seeds.pop();
    }
    let data = Data { srcdoc: srcdoc.map(Into::into), ..Data::default() };
    let token = t.begin_frame_entry(frame.nav, frame.parent_nav, url, replace, data, seeds);
    drop(t);
    let Some(handling) = v8::String::new(scope, if replace { "replace" } else { "push" }) else { return };
    let items = [handling.into(), v8::Integer::new_from_unsigned(scope, frame.nav).into(), v8::Number::new(scope, token as f64).into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.historyUpdate(url, state, push) — HTML "URL and history update steps" of the calling realm's document, its
// `history.pushState` (`push`) or `replaceState`, or a fragment navigation (`Traversable::update`), recorded in the
// session history of its traversable (`traversable_of`): the page's, a window's `window.open` made in this isolate,
// a frame's of either — and, the page's document's, its URL its traversable's (`move_url`). None while its document is
// being unloaded (navigables.rs `session_history_takes`), nor for a realm of no traversable (a frame removed, a window
// navigated away from): its URL and state its own all the same.
fn history_update_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let url = args.get(0).to_rust_string_lossy(scope);
    let state = state_arg(args.get(1));
    let push = args.get(2).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    if !arena.session_history_takes(cid) {
        return;
    }
    let Some((traversable, window)) = traversable_of(arena, cid) else { return };
    if window.map_or(cid == 0, |window| window == cid) {
        let mut t = lock(&traversable);
        if window.is_none() {
            t.move_url(&url);
        }
        t.update(TOP, TOP, &url, state, push);
    } else if let Some((frame, _)) = frame_entry(arena, cid, true) {
        lock(&frame.traversable).update(frame.nav, frame.parent_nav, &url, state, push);
    }
}
