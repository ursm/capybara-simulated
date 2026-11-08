// What a navigation of a top-level traversable's document comes to — the page's, a window's `window.open` made in an
// isolate — and what it does to its session history (HTML "navigate", "finalize a cross-document navigation", "apply the
// history step") — and a frame's, the host's fetch of it, which commits the entry its navigation began
// (session_history.rs `begin_frame_entry`). Nothing until it makes a document: what its request is reached by — the
// redirects it is made by, whether its cookies were cross-site (navigation_fetch.rs, hop by hop) — is kept here, and only
// the document it makes changes the history: its entry pushed after the current one or put in its place — the first of a
// window at its initial about:blank, which has none here, the next one after it, whatever document it made, about:blank's
// too (HTML "navigate": a navigation of the initial about:blank replaces its entry; Chrome 157 and Firefox 159 measured
// 2026-11-08, `history.length` 2 after about:blank and then `/a`) — or, a reload's and a traversal's, the entry it goes to
// applied then; the entry the leaving document is at noted, which takes its controls' state as it unloads; and its
// navigable's target name cleared where its document is of another origin than the one before it. A navigation that
// makes none — a 204, a download, a hand-off, one another navigation ended meanwhile, one the host failed in — leaves the
// history as it is, `history.length` and the step the same all along (Chrome and Firefox: `history.length` read during a
// slow navigation's fetch is the one before it, measured 2026-11-08). Each answer a `Step` the host takes: what it makes
// — the document of a response, of about:blank, of a blob, an error document, a viewer's — or that it makes none. The
// host has the transport, the blobs and the documents; the decisions are here.

use crate::referrer::http_origin;
use crate::session_history::{Data, SessionHistory, TOP};

// How the navigation is of the session history (HTML's "history handling" and the navigation API's navigation type): a
// new entry after the current one, one in its place, a reload of the active one, a traversal to a step — and the entry
// at it whose document it makes again.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Handling {
    Push,
    Replace,
    Reload,
    Traverse(i64, u64),
}

impl Handling {
    // …by its name, a traversal's of `traversal`, its step and entry.
    pub(crate) fn named(name: &str, traversal: Option<(i64, u64)>) -> Option<Self> {
        Some(match (name, traversal) {
            ("push", _) => Self::Push,
            ("replace", _) => Self::Replace,
            ("reload", _) => Self::Reload,
            ("traverse", Some((step, id))) => Self::Traverse(step, id),
            _ => return None,
        })
    }
    // A reload or a traversal: the entry it goes to an entry already made, which it makes the document of again.
    fn replays(self) -> bool {
        matches!(self, Self::Reload | Self::Traverse(..))
    }
}

// What the host makes of the navigation, its history done with as it says (`Commit`).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Step {
    // Its hops to make (navigation_fetch.rs `begin_hop`) — or, a `blob:` URL's, its blob to give (`NavigationFetch#blob_commit`).
    Fetch,
    Blob,
    // No document: the navigable stays at the one it is at (HTML "navigate": a 204, a hand-off, a navigation ended).
    None,
    // …and a response that downloads saved — a local scheme's its type, and a `data:` URL's its bytes (none a blob's,
    // which the host has; none of each the host's response).
    Download(Option<String>, Option<Vec<u8>>),
    // An error document at its URL, of a new opaque origin (HTML "create navigation params by fetching": a network error).
    Error,
    // A viewer's document for inline content (a PDF's), its response a local scheme's type where it is one's, and the
    // opener policy a document of a local scheme takes (a `blob:` URL's: `Commit::local_policy`).
    Inline(Option<String>, Option<String>),
    // about:blank's: of its initiator's origin, serialized, where that is a tuple one (HTML "determine the origin"), and
    // of the opener policy it takes.
    AboutBlank(Option<String>, String),
    // A `blob:` URL's document, of its type, and of the opener policy it takes.
    BlobDocument(String, String),
    // The document of its response — a `data:` URL's its type and bytes, of a new opaque origin; none the host's response.
    Document(Option<(String, Vec<u8>)>),
}

impl Step {
    // Whether it makes a document.
    fn makes_document(&self) -> bool {
        !matches!(self, Step::Fetch | Step::Blob | Step::None | Step::Download(..))
    }
}

pub(crate) struct Commit {
    history: SessionHistory,
    // The navigable it is of — a top-level traversable's, `TOP`, or a frame's — and, a frame's that makes an entry, the
    // number of the navigation that began it (session_history.rs `begin_frame_entry`): what its document commits, and
    // what it lets go of where it makes none.
    nav: u32,
    token: Option<u64>,
    handling: Handling,
    // The URL its document is at, a redirect's (`redirected`); the entry it makes (HTML's document state: what a replay
    // of it sends and restores) — none of a replay's — what its redirects and its hops made it; whether a redirect made its
    // request a GET, which a replay's entry then sends no POST of again.
    url: String,
    data: Data,
    redirected: bool,
    to_get: bool,
    // The origin of the document it leaves, serialized (`null` an opaque one's, never the same as another's) — a
    // window's initial about:blank's its creator's, none where no creator made it: a `noopener` window's, whose origin
    // is not known here, its target name left as it is (Chrome and Firefox).
    leaving_origin: Option<String>,
    // Whether its navigable is an auxiliary browsing context's whose opener browsing context is non-null — a window
    // `window.open` made, not disowned, its opener still there — whose target name no origin it goes to clears (HTML
    // "finalize a cross-document navigation", "apply the history step"; WPT clear-window-name.https.html).
    opened: bool,
    // A traversal's history as it began: what it is applied to where the document it leaves updated it since — a
    // pushState, a replaceState, a fragment navigation. HTML queues those updates' "finalize a same-document navigation"
    // on the traversal queue behind it, where each returns: "If targetNavigable's active session history entry is not
    // targetEntry, then return".
    began: Option<crate::session_history::Kept>,
    // The token of its hold of the page's traversals behind it (`SessionHistory::begin_page_traversal`), let go as it
    // ends — or as the host is done with it (`NavigationFetch#close`).
    holds: Option<u64>,
    // Whether it ended: once, whatever asks again.
    ended: bool,
}

impl Commit {
    // The navigation `handling` of top-level traversable `history` — the page's, a window's `window.open` made in an
    // isolate — the entry it makes of `data`; `leaving_origin` the origin of the document it leaves, serialized (`null` an
    // opaque one's) — a window's initial about:blank's its creator's, none where no creator made it; `opened` whether it
    // is an auxiliary browsing context's of an opener (`opened`).
    pub(crate) fn new(history: SessionHistory, handling: Handling, data: Option<Data>, leaving_origin: Option<String>, opened: bool) -> Self {
        Commit {
            history,
            nav: TOP,
            token: None,
            handling,
            url: String::new(),
            data: data.unwrap_or_default(),
            redirected: false,
            to_get: false,
            leaving_origin,
            opened,
            began: None,
            holds: None,
            ended: false,
        }
    }

    // A frame's: navigable `nav`'s, of history `history`, making the entry its navigation of number `token` began, of
    // `data` beside what that one holds — a replay of the active one, of none.
    pub(crate) fn of_frame(history: SessionHistory, nav: u32, token: Option<u64>, data: Option<Data>) -> Self {
        let handling = if token.is_some() { Handling::Push } else { Handling::Reload };
        let mut commit = Commit::new(history, handling, data, None, false);
        (commit.nav, commit.token) = (nav, token);
        commit
    }

    // …begun at `url`.
    pub(crate) fn begin(&mut self, url: &str) {
        url.clone_into(&mut self.url);
        if let Handling::Traverse(..) = self.handling {
            self.began = Some(self.history.keep());
            self.holds = self.history.begin_page_traversal();
        }
    }

    // A hop begun, its cookies `cross` site or not: the request its own entry's document is reached by, which a reload
    // of it through a user interface element is judged by (RFC 6265bis §5.2) — a replay's left as the navigation that
    // made the entry had it.
    pub(crate) fn crossed(&mut self, cross: bool) {
        self.data.set_cross_site(cross);
    }

    // A redirect followed to `url`, the request now a GET or not (`get`): its entry's URL the redirect's, and — `get` —
    // no POST of its to send again: so a reload gets the page it was redirected to, not the chain run again, a
    // Post/Redirect/Get page's not the form submitted again (Chrome) — referred all the same (`Data::forget_resource`).
    pub(crate) fn redirected(&mut self, url: &str, get: bool) {
        url.clone_into(&mut self.url);
        self.redirected = true;
        self.to_get |= get;
    }

    // The entry a replay goes to: a reload's the active one of its navigable — a frame's replay is one, whose
    // traversal the host applied the step of before it made the frame's document again — a traversal's the one its step
    // gives.
    fn replayed(&self) -> Option<u64> {
        match self.handling {
            Handling::Reload => self.history.active(self.nav),
            Handling::Traverse(_, id) => Some(id),
            Handling::Push | Handling::Replace => None,
        }
    }

    // The opener policy a document of a local scheme it makes takes (about:blank's, a blob's): a replay's the one its
    // entry kept (HTML's history policy container) — none of another's, which takes the one the document that made the
    // navigation has (coop.rs `inherited`), kept by the entry it makes (`keep_policy`).
    pub(crate) fn replayed_policy(&self) -> Option<String> {
        self.handling.replays().then(|| self.replayed().and_then(|id| self.history.text_of(id, "opener_policy")).unwrap_or_else(|| "unsafe-none".to_owned()))
    }
    pub(crate) fn keep_policy(&mut self, policy: &str) {
        self.data.set_text("opener_policy", policy.to_owned());
    }
    // …and the blob of a `blob:` URL's document, of type `given`, which the entry it makes keeps (`Data::blob`).
    pub(crate) fn keep_blob(&mut self, bytes: std::sync::Arc<[u8]>, given: &str) {
        self.data.set_blob(bytes, given);
    }
    // …and the Referer its request sent, its last hop's: the referrer of the document it makes, which the entry it makes
    // keeps (a frame's reload makes its document with it again: browser.rb `reload_frame_to_entry`).
    pub(crate) fn sent(&mut self, referrer: Option<String>) {
        if let Some(referrer) = referrer {
            self.data.set_text("referrer", referrer);
        }
    }

    // …ended, at `url`, in `step`, its document's origin a new opaque one where `sandboxed` (its response's
    // Content-Security-Policy `sandbox`): a document's committed to the session history (`commit`), no document's
    // changing none of it.
    pub(crate) fn end(&mut self, step: &Step, sandboxed: bool) {
        if self.ended || !step.makes_document() {
            self.ended |= !matches!(step, Step::Fetch | Step::Blob);
            if self.ended {
                self.let_go();
            }
            return;
        }
        self.ended = true;
        let origin = match step {
            _ if sandboxed => None,
            Step::AboutBlank(origin, _) => origin.clone(),
            Step::BlobDocument(..) => blob_origin(&self.url),
            Step::Document(None) => http_origin(&self.url),
            _ => None,
        };
        if self.nav != TOP {
            return self.commit_frame(origin.as_deref());
        }
        self.let_go();
        self.commit(origin.as_deref());
    }

    // The document it made, of origin `origin` (none an opaque one): its entry pushed or put in place of the active one
    // — the first of a window of none — or the one a replay goes to the step's (HTML "apply the history step":
    // `made_again`); the entry the leaving document is at noted (a reload's none: its document is the entry's own); the
    // origin its document state is of kept; and the navigable's target name, but an opened window's, cleared where that
    // origin is not the one of the document it leaves (HTML "finalize a cross-document navigation").
    fn commit(&mut self, origin: Option<&str>) {
        let active = self.history.active(0);
        if self.handling.replays() {
            let Some(id) = self.replayed() else { return };
            if let Handling::Traverse(step, _) = self.handling {
                // (…or where anything else since — a frame's navigation clearing the forward steps — took its entry away)
                if let Some(began) = self.began.take() {
                    self.history.put_back(began, self.history.url(id).is_none());
                }
                self.history.set_leaving(active);
                self.history.go_to(step);
            } else {
                self.history.set_leaving(None);
            }
            return self.made_again(id, origin);
        }
        self.history.set_leaving(active);
        let initial = active.is_none();
        let kept = match self.leaving_origin.as_deref() {
            None if initial => true,
            before => same_origin(before, origin),
        };
        let mut data = std::mem::take(&mut self.data);
        if self.to_get {
            data.forget_resource();
        }
        data.set_text("document_origin", serialized(origin));
        self.history.record_page_entry(self.url.clone(), self.handling == Handling::Replace, data);
        if !kept && !self.opened {
            self.history.clear_name();
        }
    }

    // …a replay's: the entry it goes to, `id`, made the document of again — its URL a redirect's, and its classic history
    // API state none (HTML "create navigation params by fetching": a redirect sets it to null); its classic history API
    // state — and a top-level navigable's target name, but an opened window's — cleared where the document's origin is
    // not the one the entry's document was of (HTML "apply the history step", afterDocumentPopulated, `oldOrigin`); the
    // origin its document state is of kept.
    fn made_again(&self, id: u64, origin: Option<&str>) {
        if self.redirected {
            self.history.redirect_entry(id, &self.url, self.to_get);
            self.history.forget_state_of(id);
        }
        let before = self.history.text_of(id, "document_origin");
        if before.is_some() && !same_origin(before.as_deref(), origin) {
            if self.nav == TOP && !self.opened {
                self.history.clear_name();
            }
            self.history.forget_state_of(id);
        }
        self.history.set_text_of(id, "document_origin", serialized(origin));
    }
}

impl Commit {
    // A frame's document made, of origin `origin`: the entry its navigation began committed — at the URL a redirect took
    // it to, of what the host gave it (`data`) beside what the navigation began it with, the origin its document state is
    // of kept — or a replay's active one made again (`made_again`).
    fn commit_frame(&mut self, origin: Option<&str>) {
        let redirect = self.redirected.then_some((self.url.as_str(), self.to_get));
        match self.token.take() {
            Some(token) => {
                let mut data = std::mem::take(&mut self.data);
                data.set_text("document_origin", serialized(origin));
                self.history.commit_frame_navigation(self.nav, token, redirect, data);
            }
            None => {
                if let Some(id) = self.replayed() {
                    self.made_again(id, origin);
                }
            }
        }
    }

    // …the page's traversals it held let go (`holds`), and a frame's entry its navigation began, which it made no document
    // of: as it ends, as the host is done with it (another navigation ended it, a failure of the host's), or as it is
    // dropped — its own alone, never a hold a later traversal took nor an entry a later navigation began.
    pub(crate) fn let_go(&mut self) {
        if let Some(token) = self.holds.take() {
            self.history.end_page_traversal(token);
        }
        if let Some(token) = self.token.take() {
            self.history.abandon_frame_navigation(self.nav, token);
        }
    }
}

impl Drop for Commit {
    fn drop(&mut self) {
        self.let_go();
    }
}

// Whether a document of origin `origin` (none an opaque one) is of the origin one before it was of, `before`, serialized —
// `null` an opaque one's, never the same as another's.
fn same_origin(before: Option<&str>, origin: Option<&str>) -> bool {
    before.is_some_and(|b| b != "null" && origin == Some(b))
}
// …and an origin as its document state keeps it, serialized.
fn serialized(origin: Option<&str>) -> String {
    origin.unwrap_or("null").to_owned()
}

// The origin a `blob:` URL's document is judged by: its URL's, the one inside (an HTTP(S) one's).
fn blob_origin(url: &str) -> Option<String> {
    url.get(..5).filter(|s| s.eq_ignore_ascii_case("blob:")).and_then(|_| http_origin(&url[5..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page() -> SessionHistory {
        let history = SessionHistory::new();
        let mut data = Data::default();
        data.set_text("document_origin", "http://a.test".into());
        history.record_page_entry("http://a.test/".into(), false, data);
        history.set_name("kept".into());
        history
    }

    fn commit(history: &SessionHistory, handling: Handling, url: &str) -> Commit {
        let mut commit = Commit::new(SessionHistory::of(history.id()).unwrap(), handling, Some(Data::default()), Some("http://a.test".into()), false);
        commit.begin(url);
        commit
    }

    #[test]
    fn its_entry_is_made_as_its_document_is_and_none_without_one() {
        let history = page();
        let mut c = commit(&history, Handling::Push, "http://a.test/b");
        assert_eq!(history.length(), 1);
        c.end(&Step::Document(None), false);
        assert_eq!(history.length(), 2);
        let history = page();
        commit(&history, Handling::Push, "http://a.test/b").end(&Step::None, false);
        assert_eq!(history.length(), 1);
        assert_eq!(history.url(history.active(0).unwrap()).as_deref(), Some("http://a.test/"));
    }

    #[test]
    fn it_ends_once() {
        let history = page();
        let mut c = commit(&history, Handling::Push, "http://a.test/b");
        c.end(&Step::None, false);
        c.end(&Step::Document(None), false);
        assert_eq!(history.length(), 1);
    }

    #[test]
    fn a_document_of_another_origin_clears_the_target_name() {
        for (url, step, sandboxed, name) in [
            ("http://a.test/b", Step::Document(None), false, "kept"),
            ("http://a.test/b", Step::Document(None), true, ""),
            ("http://b.test/", Step::Document(None), false, ""),
            ("http://a.test/e", Step::Error, false, ""),
            ("about:blank", Step::AboutBlank(None, "unsafe-none".into()), false, ""),
            ("blob:http://a.test/x", Step::BlobDocument("text/html".into(), "unsafe-none".into()), false, "kept"),
        ] {
            let history = page();
            commit(&history, Handling::Push, url).end(&step, sandboxed);
            assert_eq!(history.name(), name, "{url}");
        }
    }

    #[test]
    fn an_opened_windows_name_stays_but_a_replays_state_goes() {
        let history = page();
        let mut c = Commit::new(SessionHistory::of(history.id()).unwrap(), Handling::Push, Some(Data::default()), Some("http://a.test".into()), true);
        c.begin("http://b.test/");
        c.end(&Step::Document(None), false);
        assert_eq!(history.name(), "kept");
        let id = history.active(0).unwrap();
        history.set_text_of(id, "document_origin", "http://c.test".into());
        let mut c = Commit::new(SessionHistory::of(history.id()).unwrap(), Handling::Reload, None, None, true);
        c.begin("http://b.test/");
        c.end(&Step::Document(None), false);
        assert_eq!(history.name(), "kept");
        assert_eq!(history.text_of(id, "document_origin").as_deref(), Some("http://b.test"));
    }

    #[test]
    fn a_replay_of_another_origin_clears_the_name_and_the_state() {
        let history = page();
        let id = history.active(0).unwrap();
        let mut c = commit(&history, Handling::Reload, "http://a.test/");
        c.redirected("http://b.test/", true);
        c.end(&Step::Document(None), false);
        assert_eq!(history.name(), "");
        assert_eq!(history.url(id).as_deref(), Some("http://b.test/"));
        assert_eq!(history.text_of(id, "document_origin").as_deref(), Some("http://b.test"));
        let history = page();
        commit(&history, Handling::Reload, "http://a.test/").end(&Step::Document(None), false);
        assert_eq!(history.name(), "kept");
    }

    #[test]
    fn a_redirect_makes_the_entry_its_own() {
        let history = SessionHistory::new();
        let mut c = Commit::new(SessionHistory::of(history.id()).unwrap(), Handling::Push, Some(Data::default()), None, false);
        c.begin("http://a.test/form");
        c.redirected("http://a.test/done", true);
        c.end(&Step::Document(None), false);
        assert_eq!(history.url(history.active(0).unwrap()).as_deref(), Some("http://a.test/done"));
    }

    #[test]
    fn about_blank_made_of_the_initial_about_blank_is_an_entry_the_next_comes_after() {
        let history = SessionHistory::new();
        let mut c = Commit::new(SessionHistory::of(history.id()).unwrap(), Handling::Push, Some(Data::default()), None, false);
        c.begin("about:blank");
        c.end(&Step::AboutBlank(None, "unsafe-none".into()), false);
        assert_eq!(history.length(), 1);
        commit(&history, Handling::Push, "http://a.test/").end(&Step::Document(None), false);
        assert_eq!(history.length(), 2);
    }

    #[test]
    fn a_traversal_goes_to_its_step_only_as_it_makes_a_document() {
        let history = page();
        history.record_page_entry("http://a.test/b".into(), false, Data::default());
        let first = history.entry_at_step(0).unwrap();
        commit(&history, Handling::Traverse(0, first), "http://a.test/").end(&Step::None, false);
        assert_eq!(history.url(history.active(0).unwrap()).as_deref(), Some("http://a.test/b"));
        commit(&history, Handling::Traverse(0, first), "http://a.test/").end(&Step::Document(None), false);
        assert_eq!(history.url(history.active(0).unwrap()).as_deref(), Some("http://a.test/"));
    }

    #[test]
    fn a_traversal_holds_the_pages_traversals_until_it_ends() {
        let history = page();
        let b = history.record_page_entry("http://a.test/b".into(), false, Data::default()).unwrap();
        history.go_to(0);
        let mut c = commit(&history, Handling::Traverse(1, b), "http://a.test/b");
        assert_eq!(history.begin_page_traversal(), None);
        c.end(&Step::None, false);
        let token = history.begin_page_traversal().unwrap();
        history.end_page_traversal(token);
        drop(commit(&history, Handling::Traverse(1, b), "http://a.test/b"));
        assert!(history.begin_page_traversal().is_some());
    }

    #[test]
    fn a_frames_entry_is_made_as_its_document_is_and_let_go_without_one() {
        let history = page();
        let f1 = history.seed_frame(1, "http://a.test/f1");
        let begin = |url: &str| history.begin_frame_entry_for_test(1, url);
        let mut c = Commit::of_frame(SessionHistory::of(history.id()).unwrap(), 1, Some(begin("http://a.test/f2")), None);
        c.redirected("http://a.test/f3", true);
        assert_eq!(history.length(), 1);
        c.end(&Step::Document(None), false);
        let f3 = history.active(1).unwrap();
        assert_eq!((history.length(), history.url(f3).as_deref()), (2, Some("http://a.test/f3")));
        Commit::of_frame(SessionHistory::of(history.id()).unwrap(), 1, Some(begin("http://a.test/nc")), None).end(&Step::None, false);
        let dropped = begin("http://a.test/dropped");
        drop(Commit::of_frame(SessionHistory::of(history.id()).unwrap(), 1, Some(dropped), None));
        assert_eq!((history.length(), history.active(1)), (2, Some(f3)));
        assert_eq!(history.commit_frame_navigation(1, dropped, None, Data::default()), None);
        let mut replay = Commit::of_frame(SessionHistory::of(history.id()).unwrap(), 1, None, None);
        replay.redirected("http://a.test/f4", false);
        replay.end(&Step::Document(None), false);
        assert_eq!((history.length(), history.url(f3).as_deref()), (2, Some("http://a.test/f4")));
        assert_ne!(f1, f3);
    }

    #[test]
    fn a_stale_commit_lets_go_of_no_hold_but_its_own() {
        let history = page();
        let b = history.record_page_entry("http://a.test/b".into(), false, Data::default()).unwrap();
        let mut stale = commit(&history, Handling::Traverse(1, b), "http://a.test/b");
        stale.let_go();
        let later = commit(&history, Handling::Traverse(1, b), "http://a.test/b");
        drop(stale);
        assert_eq!(history.begin_page_traversal(), None);
        drop(later);
        assert!(history.begin_page_traversal().is_some());
    }

    #[test]
    fn a_same_document_update_the_left_document_made_is_let_go() {
        let history = page();
        let b = history.record_page_entry("http://a.test/b".into(), false, Data::default()).unwrap();
        let mut c = commit(&history, Handling::Traverse(0, history.entry_at_step(0).unwrap()), "http://a.test/");
        history.replace_state_for_test("http://a.test/r");
        c.end(&Step::Document(None), false);
        assert_eq!(history.url(b).as_deref(), Some("http://a.test/b"));
    }

    #[test]
    fn a_traversal_is_applied_to_the_history_it_began_with_where_a_push_took_its_entry_away() {
        let history = page();
        let b = history.record_page_entry("http://a.test/b".into(), false, Data::default()).unwrap();
        history.go_to(0);
        let mut c = commit(&history, Handling::Traverse(1, b), "http://a.test/b");
        history.record_page_entry("http://a.test/p".into(), false, Data::default());
        assert_eq!(history.url(b), None);
        c.end(&Step::Document(None), false);
        assert_eq!(history.active(0), Some(b));
        assert_eq!(history.length(), 2);
    }
}
