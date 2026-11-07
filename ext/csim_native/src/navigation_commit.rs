// What a navigation of the page's document does to its top-level traversable's session history as it goes, and what it
// comes to (HTML "navigate", "finalize a cross-document navigation", "apply the history step"): the history kept as it
// begins, its entry made — pushed after the current one, or in its place — or none (a reload's, a traversal's, a window
// at its initial about:blank going to about:blank: that document is left the initial one); whether the request its
// entry's document is reached by was cross-site and the redirect it is made by (navigation_fetch.rs, hop by hop); and,
// as it ends, its navigable's target name cleared where its document is of another origin than the one it leaves — or,
// none made (a 204, a download, a hand-off, another navigation begun meanwhile), the history as it stood. Each answer
// a `Step` the host takes: what it makes — the document of a response, of about:blank, of a blob, an error document,
// a viewer's — or that it makes none. The host has the transport, the blobs and the documents; the decisions are here.

use crate::referrer::http_origin;
use crate::session_history::{Data, SessionHistory};

// How the navigation is of the session history (HTML's "history handling" and the navigation API's navigation type): a
// new entry after the current one, one in its place, a reload of the active one, a traversal to one — the step applied
// by the traversal itself as it began (`#begin_page_traversal`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Handling {
    Push,
    Replace,
    Reload,
    Traverse,
}

impl Handling {
    pub(crate) fn named(name: &str) -> Option<Self> {
        Some(match name {
            "push" => Self::Push,
            "replace" => Self::Replace,
            "reload" => Self::Reload,
            "traverse" => Self::Traverse,
            _ => return None,
        })
    }
    // A reload or a traversal: the entry it goes to an entry already made, which it makes the document of again.
    fn replays(self) -> bool {
        matches!(self, Self::Reload | Self::Traverse)
    }
}

// The document a navigation leaves, by what its target name is cleared by: a window's initial about:blank no creator
// made (a `noopener` window's: its origin, its creator's, not known here — Chrome and Firefox leave its name), one of an
// opaque origin (never the same as another), or one of a tuple origin, serialized.
#[derive(Debug, PartialEq, Eq)]
enum Leaving {
    Initial,
    Opaque,
    Origin(String),
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

pub(crate) struct Commit {
    history: SessionHistory,
    handling: Handling,
    // The entry it makes (HTML's document state: what a replay of it sends and restores), taken as it is made.
    data: Option<Data>,
    leaving_origin: Option<String>,
    leaving: Leaving,
    // The entry its document is of: its own (`own`), or the one a reload or a traversal goes to; none for a window's
    // initial about:blank left so.
    entry: Option<u64>,
    own: bool,
}

impl Commit {
    // The navigation `handling` of traversable `history`'s page, the entry it makes of `data`; `leaving_origin` the origin
    // of the document it leaves, serialized (`null` an opaque one's) — a window's initial about:blank's its creator's,
    // none where no creator made it.
    pub(crate) fn new(history: SessionHistory, handling: Handling, data: Option<Data>, leaving_origin: Option<String>) -> Self {
        Commit { history, handling, data, leaving_origin, leaving: Leaving::Initial, entry: None, own: false }
    }

    // …begun, its URL `url` making it `start` (navigation_fetch.rs `start`): the history kept, and the entry made — none
    // of about:blank's in a window of no entry yet (its initial about:blank, which such a navigation leaves the initial
    // one: HTML "navigate", "replace" history handling) — or the one it replays found.
    pub(crate) fn begin(&mut self, url: &str, start: &str) {
        let leaves = !self.handling.replays();
        // (…a traversal's history kept as it began: `#begin_page_traversal`)
        let active = if self.handling == Handling::Traverse { self.history.active(0) } else { self.history.begin_page_navigation(leaves) };
        if !leaves {
            self.entry = active;
            return;
        }
        // (…a window at its initial about:blank, of no entry, leaving the origin of its creator: none where none is known)
        self.leaving = match self.leaving_origin.take() {
            Some(origin) if origin != "null" => Leaving::Origin(origin),
            _ if active.is_none() => Leaving::Initial,
            _ => Leaving::Opaque,
        };
        if start == "about_blank" && active.is_none() {
            return;
        }
        let data = self.data.take().unwrap_or_default();
        self.entry = self.history.record_page_entry(url.to_owned(), self.handling == Handling::Replace, data);
        self.own = self.entry.is_some();
    }

    // A hop begun, its cookies `cross` site or not: the request its own entry's document is reached by, which a reload
    // of it through a user interface element is judged by (RFC 6265bis §5.2) — a replay's left as the navigation that
    // made the entry had it.
    pub(crate) fn crossed(&self, cross: bool) {
        if let Some(id) = self.entry.filter(|_| self.own) {
            self.history.set_cross_site_of(id, cross);
        }
    }

    // A redirect followed to `url`, the request now a GET or not (`get`): the entry the redirect's
    // (`SessionHistory::redirect_entry`).
    pub(crate) fn redirected(&self, url: &str, get: bool) {
        if let Some(id) = self.entry {
            self.history.redirect_entry(id, url, get);
        }
    }

    // The opener policy a document of a local scheme it makes takes (about:blank's, a blob's): a replay's the one its
    // entry kept (HTML's history policy container), else the one `inherited` gives (coop.rs `inherited`), kept by its
    // entry for one.
    pub(crate) fn local_policy<E>(&self, inherited: impl FnOnce() -> Result<String, E>) -> Result<String, E> {
        if self.handling.replays() {
            let kept = self.entry.and_then(|id| self.history.text_of(id, "opener_policy"));
            return Ok(kept.unwrap_or_else(|| "unsafe-none".to_owned()));
        }
        let policy = inherited()?;
        if let Some(id) = self.entry.filter(|_| self.own) {
            self.history.set_text_of(id, "opener_policy", policy.clone());
        }
        Ok(policy)
    }

    // …ended, at `url`, in `step`: no document's the history given back as it stood; a document's its navigable's target
    // name cleared where that document's origin (`step`'s, at `url`) is another than the one it leaves (HTML "finalize a
    // cross-document navigation" — a replay's left as its entry has it).
    pub(crate) fn end(&self, url: &str, step: &Step) {
        let origin = match step {
            Step::Fetch | Step::Blob => return,
            Step::None | Step::Download(..) => return self.history.end_page_navigation(false),
            Step::Error | Step::Inline(..) | Step::Document(Some(_)) => None,
            Step::AboutBlank(origin, _) => origin.clone(),
            Step::BlobDocument(..) => blob_origin(url),
            Step::Document(None) => http_origin(url),
        };
        self.history.end_page_navigation(true);
        if self.handling.replays() {
            return;
        }
        let same = match &self.leaving {
            Leaving::Initial => true,
            Leaving::Opaque => false,
            Leaving::Origin(leaving) => origin.as_ref() == Some(leaving),
        };
        if !same {
            self.history.clear_name();
        }
    }
}

// The origin a `blob:` URL's document is judged by: its URL's, the one inside (an HTTP(S) one's).
fn blob_origin(url: &str) -> Option<String> {
    url.get(..5).filter(|s| s.eq_ignore_ascii_case("blob:")).and_then(|_| http_origin(&url[5..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn committed(handling: Handling, leaving: Option<&str>, url: &str, step: Step) -> (SessionHistory, Commit) {
        let history = SessionHistory::new();
        history.record_page_entry("http://a.test/".into(), false, Data::default());
        history.set_name("kept".into());
        let mut commit = Commit::new(SessionHistory::of(history.id()).unwrap(), handling, Some(Data::default()), leaving.map(str::to_owned));
        commit.begin(url, "fetch");
        commit.end(url, &step);
        (history, commit)
    }

    #[test]
    fn a_push_adds_an_entry_and_no_document_gives_the_history_back() {
        let (history, _) = committed(Handling::Push, Some("http://a.test"), "http://a.test/b", Step::Document(None));
        assert_eq!(history.length(), 2);
        let (history, _) = committed(Handling::Push, Some("http://a.test"), "http://a.test/b", Step::None);
        assert_eq!(history.length(), 1);
        assert_eq!(history.url(history.active(0).unwrap()).as_deref(), Some("http://a.test/"));
    }

    #[test]
    fn a_document_of_another_origin_clears_the_target_name() {
        let (history, _) = committed(Handling::Push, Some("http://a.test"), "http://a.test/b", Step::Document(None));
        assert_eq!(history.name(), "kept");
        let (history, _) = committed(Handling::Push, Some("http://a.test"), "http://b.test/", Step::Document(None));
        assert_eq!(history.name(), "");
        let (history, _) = committed(Handling::Push, Some("http://a.test"), "http://a.test/e", Step::Error);
        assert_eq!(history.name(), "");
        // (…an about:blank of an opaque initiator's of no tuple origin: another than any)
        let (history, _) = committed(Handling::Push, Some("http://a.test"), "about:blank", Step::AboutBlank(None, "unsafe-none".into()));
        assert_eq!(history.name(), "");
        let (history, _) = committed(Handling::Push, Some("http://a.test"), "blob:http://a.test/x", Step::BlobDocument("text/html".into(), "unsafe-none".into()));
        assert_eq!(history.name(), "kept");
        // (…a replay's left as its entry has it)
        let (history, _) = committed(Handling::Reload, Some("http://a.test"), "http://b.test/", Step::Document(None));
        assert_eq!(history.name(), "kept");
    }

    #[test]
    fn a_redirect_makes_the_entry_its_own() {
        let history = SessionHistory::new();
        let mut commit = Commit::new(SessionHistory::of(history.id()).unwrap(), Handling::Push, Some(Data::default()), None);
        commit.begin("http://a.test/form", "fetch");
        commit.redirected("http://a.test/done", true);
        assert_eq!(history.url(history.active(0).unwrap()).as_deref(), Some("http://a.test/done"));
    }

    #[test]
    fn about_blank_in_a_window_of_no_entry_makes_none() {
        let history = SessionHistory::new();
        let mut commit = Commit::new(SessionHistory::of(history.id()).unwrap(), Handling::Push, Some(Data::default()), None);
        commit.begin("about:blank", "about_blank");
        assert_eq!(history.active(0), None);
    }
}
